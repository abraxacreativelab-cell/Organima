/**
 * Pilar voz — síntesis de habla con ElevenLabs.
 *
 * Este módulo convierte en audio un texto que YA fue decidido por otra capa. No genera texto,
 * no investiga y no decide qué decir: la conversación y el razonamiento son de NVIDIA en Nebius
 * (`docs/provider-contracts.md`), y Tavily es el único canal web del runtime. ElevenLabs es
 * únicamente transporte de texto→audio.
 *
 * Garantías de este módulo:
 * - Usa la API oficial de streaming `POST /v1/text-to-speech/{voiceId}/stream` con header
 *   `xi-api-key`; el id de voz sale de `ELEVENLABS_VOICE_ID` (nunca está hardcodeado).
 * - El tiempo de espera de 15 s se combina con la señal del llamador mediante `AbortSignal.any`:
 *   el barge-in del navegador aborta la petición en curso (ver `docs/VOICE.md`).
 * - Rechaza texto vacío (después de `trim`) y texto de más de 1600 caracteres.
 * - Exige `content-type: audio/*` y un tope duro de 5 MB: un cuerpo JSON o un error del
 *   proveedor nunca se devuelven como si fuera audio.
 * - `status()` sólo pasa a `ready` después de haber recibido audio válido y no vacío.
 * - Nunca registra la key ni el cuerpo de error del proveedor, y no persiste audio: el buffer
 *   se devuelve a quien llama y se olvida.
 * - Sin red propia: `fetcher` es inyectable para pruebas offline.
 */
/** Cuerpo de la petición, tomado del `fetch` nativo: sin importar dependencias nuevas. */
type RequestInit = NonNullable<Parameters<typeof fetch>[1]>;
/** Respuesta del `fetch` nativo. */
type Response = Awaited<ReturnType<typeof fetch>>;

/** Base del endpoint oficial de síntesis en streaming. */
export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
/** Modelo rápido de ElevenLabs: menor latencia, adecuado para conversación en vivo. */
export const ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';
/** Idioma fijo del MVP: español. */
export const ELEVENLABS_LANGUAGE = 'es';
/** Ajustes de voz acordados por el arquitecto: estabilidad media y similitud alta. */
export const ELEVENLABS_VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.75 } as const;
/** Tope de espera de una síntesis completa; se combina con la señal del llamador. */
export const VOICE_TIMEOUT_MS = 15_000;
/** Longitud máxima del texto aceptado, medida después de `trim`. */
export const MAX_TEXT_LENGTH = 1600;
/** Tope duro de audio aceptado en una respuesta (5 MB). */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/**
 * Los ids de voz de ElevenLabs son alfanuméricos. Se valida esa forma antes de armar la URL:
 * el id no puede alterar la ruta ni el host, y así `encodeURIComponent` es una identidad segura.
 */
const VOICE_ID_PATTERN = /^[A-Za-z0-9]+$/;
/** Un content-type inesperado se recorta y se limpia antes de aparecer en un mensaje de error. */
const CONTENT_TYPE_MAX_LENGTH = 100;

/** Estado honesto del proveedor de voz, alineado con `ProviderStatus` de `src/contracts.ts`. */
export type VoiceState = 'unconfigured' | 'untested' | 'ready' | 'error';

/** Foto del estado del pilar. La `voiceId` sólo aparece si hay un id válido configurado. */
export interface VoiceStatus {
  configured: boolean;
  provider: 'elevenlabs';
  voiceId?: string;
  language: 'es';
  state: VoiceState;
}

/** Opciones de construcción: entorno y `fetch` son inyectables (pruebas offline). */
export interface VoiceOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
}

/** Contrato público del pilar voz. */
export interface Voice {
  status(): VoiceStatus;
  synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array>;
}

interface VoiceConfig {
  apiKey: string;
  voiceId: string;
}

type ConfigResolution =
  | { ok: true; config: VoiceConfig }
  | { ok: false; state: 'unconfigured' | 'error'; reason: string; voiceId?: string };

/**
 * Lee la configuración de ElevenLabs una sola vez, al construir el pilar.
 * Ausente o en blanco ⇒ `unconfigured`; presente pero mal formado ⇒ `error`.
 */
function resolveConfig(env: Record<string, string | undefined>): ConfigResolution {
  const rawKey = env['ELEVENLABS_API_KEY'];
  const rawVoice = env['ELEVENLABS_VOICE_ID'];
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  const voiceId = typeof rawVoice === 'string' ? rawVoice.trim() : '';

  if (voiceId !== '' && !VOICE_ID_PATTERN.test(voiceId)) {
    return {
      ok: false,
      state: 'error',
      reason: `ELEVENLABS_VOICE_ID debe ser alfanumérico (recibido: ${describeVoiceIdShape(voiceId)})`,
    };
  }
  if (apiKey === '') {
    return {
      ok: false,
      state: 'unconfigured',
      reason: 'falta ELEVENLABS_API_KEY',
      ...(voiceId === '' ? {} : { voiceId }),
    };
  }
  if (voiceId === '') {
    return { ok: false, state: 'unconfigured', reason: 'falta ELEVENLABS_VOICE_ID' };
  }
  return { ok: true, config: { apiKey, voiceId } };
}

/** Describe la forma de un id inválido sin reproducir valores potencialmente raros. */
function describeVoiceIdShape(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
  return `longitud ${value.length}, "${printable}"`;
}

/** Valida el texto y devuelve la versión recortada que se envía al proveedor. */
function validateText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new Error('synthesize requiere un texto (string)');
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new Error('synthesize rechaza texto vacío o en blanco');
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`synthesize rechaza texto de más de ${MAX_TEXT_LENGTH} caracteres`);
  }
  return trimmed;
}

/** Limpia el content-type antes de mencionarlo en un mensaje: sin controles ni longitud libre. */
function sanitizeContentType(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CONTENT_TYPE_MAX_LENGTH);
  return clean === '' ? null : clean;
}

/** Sólo `audio/*` es audio. `application/json` u otro tipo se rechazan sin leer como MP3. */
function isAudioContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mediaType.startsWith('audio/');
}

/** Error de cancelación del llamador (barge-in): se propaga la razón original si existe. */
function callerAbortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('síntesis cancelada por el llamador', 'AbortError');
}

/** Error de vencimiento del tope de 15 s (sin cuerpo del proveedor). */
function timeoutError(): Error {
  return new Error(`ElevenLabs no respondió en ${VOICE_TIMEOUT_MS} ms`);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Lee el audio de la respuesta con tope duro: si el cuerpo excede `MAX_AUDIO_BYTES` se cancela
 * la descarga y se falla. Al terminar (o fallar) se cancela el lector para no bajar bytes de más.
 */
async function readAudio(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(`audio de ElevenLabs excede el límite de ${MAX_AUDIO_BYTES} bytes`);
    }
    return new Uint8Array(buffer);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        throw new Error(`audio de ElevenLabs excede el límite de ${MAX_AUDIO_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    // No se guarda ni se sigue bajando audio: el resto de la respuesta se descarta.
    await reader.cancel().catch((): undefined => undefined);
  }
  return concatChunks(chunks, total);
}

/**
 * Crea el pilar voz. `env` y `fetcher` son inyectables para pruebas sin red; en producción se
 * usan `process.env` y el `fetch` nativo de Node.
 */
export function createVoice(options: VoiceOptions = {}): Voice {
  const env = options.env ?? process.env;
  const fetcher: typeof fetch = options.fetcher ?? globalThis.fetch;
  const resolved = resolveConfig(env);
  let state: VoiceState = resolved.ok ? 'untested' : resolved.state;

  function status(): VoiceStatus {
    const voiceId = resolved.ok ? resolved.config.voiceId : resolved.voiceId;
    const snapshot: VoiceStatus = {
      configured: resolved.ok,
      provider: 'elevenlabs',
      language: 'es',
      state,
    };
    return voiceId === undefined ? snapshot : { ...snapshot, voiceId };
  }

  async function synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    // Errores del llamador (texto o cancelación) nunca se reportan como error del proveedor.
    const trimmed = validateText(text);
    if (signal !== undefined && signal.aborted) {
      throw callerAbortReason(signal);
    }
    if (!resolved.ok) {
      throw new Error(`voz no disponible: ${resolved.reason}`);
    }

    const { apiKey, voiceId } = resolved.config;
    const controller = new AbortController();
    let timedOut = false;
    // Timer manual (no `AbortSignal.timeout`) para poder liberarlo siempre en el `finally`.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DOMException(`ElevenLabs no respondió en ${VOICE_TIMEOUT_MS} ms`, 'TimeoutError'),
      );
    }, VOICE_TIMEOUT_MS);
    const deadline =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);

    try {
      const url = `${ELEVENLABS_API_BASE}/${encodeURIComponent(voiceId)}/stream`;
      const payload = {
        text: trimmed,
        model_id: ELEVENLABS_MODEL_ID,
        language_code: ELEVENLABS_LANGUAGE,
        voice_settings: ELEVENLABS_VOICE_SETTINGS,
      };

      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: deadline,
      });

      if (!response.ok) {
        // Nunca se lee ni se registra el cuerpo del error del proveedor.
        throw new Error(`ElevenLabs respondió HTTP ${response.status}`);
      }

      const contentType = sanitizeContentType(response.headers.get('content-type'));
      if (!isAudioContentType(contentType)) {
        throw new Error(
          `ElevenLabs devolvió content-type no-audio: ${contentType ?? '(ausente)'}`,
        );
      }

      const audio = await readAudio(response);
      if (audio.byteLength === 0) {
        throw new Error('ElevenLabs devolvió audio vacío');
      }

      state = 'ready';
      return audio;
    } catch (error) {
      if (signal !== undefined && signal.aborted) {
        throw callerAbortReason(signal);
      }
      state = 'error';
      if (timedOut) throw timeoutError();
      throw error instanceof Error ? error : new Error('fallo al llamar a ElevenLabs');
    } finally {
      clearTimeout(timer);
    }
  }

  return { status, synthesize };
}
