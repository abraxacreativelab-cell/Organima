/**
 * Laboratorio conversacional A/B — backend HTTP.
 *
 * Compara el mismo cerebro (NVIDIA en Nebius, vía `src/cognition.ts`) cambiando únicamente el
 * proveedor de texto→audio: ElevenLabs o NVIDIA TTS. Este módulo no conversa por su cuenta ni
 * guarda memoria de producción: arma un cerebro `live` (o uno inyectado en pruebas), pide una
 * respuesta breve, mide lo que tardó el cerebro y transmite el audio en PCM crudo en cuanto el
 * proveedor entrega el primer byte.
 *
 * Reglas de este módulo (ver `docs/VOICE-LAB.md`):
 * - Escucha restringida: el archivo servidor sólo abre `127.0.0.1`. Aquí se rechaza cualquier
 *   `Origin` distinto del `Host` (mismo origen) y nunca se emiten cabeceras CORS.
 * - El cuerpo JSON se limita a 32 KiB y cada texto a 1600 caracteres; nada se trunca en silencio.
 * - El audio se retransmite mientras llega: jamás se acumula completo. Tope duro de 4 MiB y un
 *   único plazo de 30 s que cubre cabeceras y cuerpo.
 * - Los errores del proveedor nunca se devuelven como audio ni como texto crudo, y ninguna clave
 *   sale del servidor.
 * - `close()` cancela todo lo pendiente (cerebro, síntesis y streams abiertos).
 * - Sin red propia: `fetcher` y `reply` son inyectables para pruebas offline.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createCognition } from './cognition.js';
import type { ChatReply, CognitionPort, GraphSnapshot, OrganimaEvent } from './contracts.js';

// ── Constantes públicas (medibles por pruebas y por el juez) ──────────────────

/** Frecuencia de muestreo del PCM del laboratorio: 22050 Hz, mono, entero con signo de 16 bits. */
export const VOICE_LAB_SAMPLE_RATE = 22_050;
/** Máximo de caracteres por mensaje o por texto a sintetizar (medido tras `trim`). */
export const VOICE_LAB_MAX_TEXT_CHARS = 1_600;
/** Turnos de historia que se envían al cerebro (los últimos, ya validados). */
export const VOICE_LAB_HISTORY_LIMIT = 12;
/** Máximo de turnos aceptados en la petición; sólo se usan los últimos `VOICE_LAB_HISTORY_LIMIT`. */
export const VOICE_LAB_HISTORY_MAX_ITEMS = 24;
/** Tope del cuerpo JSON aceptado en cualquier ruta del laboratorio. */
export const VOICE_LAB_MAX_BODY_BYTES = 32 * 1024;
/** Plazo único que cubre cabeceras y cuerpo de la síntesis. */
export const VOICE_LAB_TTS_TIMEOUT_MS = 30_000;
/** Tope duro de audio aceptado por síntesis. */
export const VOICE_LAB_MAX_TTS_BYTES = 4 * 1024 * 1024;
/** Petición de brevedad que acompaña a cada turno (el cerebro ya responde breve, aquí se insiste). */
export const VOICE_LAB_BREVITY_INSTRUCTION =
  'Laboratorio de conversación sin cámaras, robot ni memoria persistente conectados. Sólo conoces lo dicho en esta llamada; no afirmes que ves objetos o que guardaste algo en el sistema. Responde breve, en una o dos frases, sin emojis ni listas.';

/** Base oficial del endpoint de síntesis en streaming de ElevenLabs. */
export const ELEVENLABS_TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
/** Modelo rápido acordado para conversación en vivo. */
export const ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
/** Idioma fijo del MVP. */
export const ELEVENLABS_LANGUAGE = 'es';
/** Formato de salida PCM 22050 Hz pedido por query string. */
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_22050';
/** Ajustes de voz acordados por el arquitecto. */
export const ELEVENLABS_VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.75 } as const;

/** Base hospedada de NVIDIA TTS (NVCF) usada por defecto. */
export const NVIDIA_TTS_DEFAULT_BASE_URL =
  'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com';
/** Ruta de síntesis en línea documentada en NIM. */
export const NVIDIA_TTS_PATH = '/v1/audio/synthesize_online';
/** Idioma pedido a NVIDIA para el MVP. */
export const NVIDIA_TTS_LANGUAGE = 'es-US';
/** Codificación pedida a NVIDIA. */
export const NVIDIA_TTS_ENCODING = 'LINEAR_PCM';

/** Identificadores de proveedor que acepta el laboratorio. */
export type VoiceLabProviderId = 'elevenlabs' | 'nvidia';

const PROVIDER_LABELS: Record<VoiceLabProviderId, string> = {
  elevenlabs: 'ElevenLabs',
  nvidia: 'NVIDIA TTS',
};

/** Orden fijo de proveedores en el estado. */
const PROVIDER_ORDER: readonly VoiceLabProviderId[] = ['elevenlabs', 'nvidia'];

/** Forma real de los ids de voz de ElevenLabs: alfanuméricos, sin tocar la ruta ni el host. */
const VOICE_ID_PATTERN = /^[A-Za-z0-9]+$/;
/** Un content-type inesperado se recorta antes de aparecer en un mensaje. */
const HEADER_VALUE_MAX_CHARS = 120;
/** Detalle máximo publicado de un error (nunca cuerpos crudos del proveedor). */
const ERROR_DETAIL_MAX_CHARS = 300;

const BODY_LIMIT = `${Math.floor(VOICE_LAB_MAX_BODY_BYTES / 1024)}kb`;

/** Estado público de un proveedor: nunca incluye la clave ni el id de voz. */
export interface VoiceLabProviderStatus {
  id: VoiceLabProviderId;
  label: string;
  configured: boolean;
  reason?: string;
}

/** Foto que consume la página para saber qué puede ofrecer. */
export interface VoiceLabStatus {
  sampleRate: number;
  maxTextChars: number;
  historyLimit: number;
  providers: VoiceLabProviderStatus[];
}

/** Respuesta del cerebro: texto, modelo y duración medida en el servidor. */
export interface VoiceLabTurnResult {
  text: string;
  model: string;
  mode: ChatReply['mode'];
  brainMs: number;
  sources: ChatReply['sources'];
}

/** Opciones de construcción: todo lo externo es inyectable (pruebas offline). */
export interface VoiceLabOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  reply?: (message: string, snapshot: GraphSnapshot, history: OrganimaEvent[]) => Promise<ChatReply>;
}

/** Contrato público del laboratorio. */
export interface VoiceLab {
  app: express.Express;
  close(): void;
}

interface ResolvedProvider {
  id: VoiceLabProviderId;
  configured: boolean;
  reason?: string;
  apiKey?: string;
  voice?: string;
  baseUrl?: string;
}

type ProviderMap = Record<VoiceLabProviderId, ResolvedProvider>;

interface UpstreamRequest {
  url: string;
  init: NonNullable<Parameters<typeof fetch>[1]>;
}

/** Error propio con código y estado HTTP explícitos; su mensaje nunca contiene secretos. */
class VoiceLabError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'VoiceLabError';
    this.status = status;
    this.code = code;
  }
}

// ── Utilidades puras ─────────────────────────────────────────────────────────

/** Lee una variable de entorno tratando cadena vacía como ausente. */
function readEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Acepta sólo URLs absolutas http(s): una base rara no puede cambiar de esquema. */
function sanitizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.hostname === '') return undefined;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** Limpia un valor de cabecera antes de mencionarlo: sin controles ni longitud libre. */
function sanitizeHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, HEADER_VALUE_MAX_CHARS);
  return clean === '' ? null : clean;
}

function isAudioContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return ['audio/pcm', 'audio/lpcm', 'audio/raw', 'application/octet-stream'].includes(mediaType);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Recorta y redacta el detalle público de un error; nunca deja pasar una clave conocida. */
function redactDetail(detail: string, secrets: readonly string[]): string {
  let out = detail.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redactado]');
  }
  return out.slice(0, ERROR_DETAIL_MAX_CHARS);
}

/** El plazo es configurable por entorno para poder probarlo sin esperar 30 s; por defecto es el del plan. */
function readTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = readEnvValue(env, 'VOICE_LAB_TTS_TIMEOUT_MS');
  if (raw === undefined) return VOICE_LAB_TTS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return VOICE_LAB_TTS_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), 120_000);
}

/** Resuelve qué proveedores están listos y por qué no lo están; jamás expone valores secretos. */
function resolveProviders(env: Record<string, string | undefined>): ProviderMap {
  const elevenKey = readEnvValue(env, 'ELEVENLABS_API_KEY');
  const elevenVoice = readEnvValue(env, 'ELEVENLABS_VOICE_ID');
  let eleven: ResolvedProvider;
  if (elevenKey === undefined) {
    eleven = { id: 'elevenlabs', configured: false, reason: 'falta ELEVENLABS_API_KEY' };
  } else if (elevenVoice === undefined) {
    eleven = { id: 'elevenlabs', configured: false, reason: 'falta ELEVENLABS_VOICE_ID' };
  } else if (!VOICE_ID_PATTERN.test(elevenVoice)) {
    eleven = {
      id: 'elevenlabs',
      configured: false,
      reason: 'ELEVENLABS_VOICE_ID debe ser alfanumérico',
    };
  } else {
    eleven = { id: 'elevenlabs', configured: true, apiKey: elevenKey, voice: elevenVoice };
  }

  const nvidiaKey = readEnvValue(env, 'NVIDIA_API_KEY');
  const nvidiaVoice = readEnvValue(env, 'NVIDIA_TTS_VOICE');
  const rawBase = readEnvValue(env, 'NVIDIA_TTS_BASE_URL');
  const baseUrl = rawBase === undefined ? NVIDIA_TTS_DEFAULT_BASE_URL : sanitizeHttpUrl(rawBase);
  let nvidia: ResolvedProvider;
  if (nvidiaKey === undefined) {
    nvidia = { id: 'nvidia', configured: false, reason: 'falta NVIDIA_API_KEY' };
  } else if (nvidiaVoice === undefined) {
    nvidia = {
      id: 'nvidia',
      configured: false,
      reason: 'falta NVIDIA_TTS_VOICE: la voz debe declararse explícitamente',
    };
  } else if (baseUrl === undefined) {
    nvidia = { id: 'nvidia', configured: false, reason: 'NVIDIA_TTS_BASE_URL debe ser una URL http(s)' };
  } else {
    nvidia = { id: 'nvidia', configured: true, apiKey: nvidiaKey, voice: nvidiaVoice, baseUrl };
  }

  return { elevenlabs: eleven, nvidia };
}

/** Convierte la historia validada del cliente en eventos de Organima (sólo en RAM, jamás persistidos). */
function historyToEvents(history: readonly { role: 'user' | 'assistant'; text: string }[]): OrganimaEvent[] {
  const occurredAt = new Date().toISOString();
  return history.map((turn) => ({
    id: randomUUID(),
    type: turn.role === 'user' ? 'conversation.user' : 'conversation.reply',
    cellId: 'voice-lab',
    occurredAt,
    mode: 'live',
    payload: { text: turn.text, source: 'voice-lab-client' },
  }));
}

/** Snapshot vacío acordado: el laboratorio no usa robot ni memoria de producción. */
function emptySnapshot(): GraphSnapshot {
  return { version: 0, relations: [], events: [] };
}

/** El turno lleva la petición de brevedad; la historia conserva el texto tal como lo dijo el usuario. */
function buildTurnPrompt(message: string): string {
  return `${message}\n\n[${VOICE_LAB_BREVITY_INSTRUCTION}]`;
}

function buildElevenLabsRequest(config: ResolvedProvider, text: string): UpstreamRequest {
  const voice = config.voice ?? '';
  const url = `${ELEVENLABS_TTS_BASE}/${encodeURIComponent(voice)}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey ?? '',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_TTS_MODEL,
        language_code: ELEVENLABS_LANGUAGE,
        voice_settings: ELEVENLABS_VOICE_SETTINGS,
      }),
    },
  };
}

function buildNvidiaRequest(config: ResolvedProvider, text: string): UpstreamRequest {
  const form = new FormData();
  form.append('text', text);
  form.append('language', NVIDIA_TTS_LANGUAGE);
  form.append('voice', config.voice ?? '');
  form.append('sample_rate_hz', String(VOICE_LAB_SAMPLE_RATE));
  form.append('encoding', NVIDIA_TTS_ENCODING);
  return {
    url: `${config.baseUrl ?? NVIDIA_TTS_DEFAULT_BASE_URL}${NVIDIA_TTS_PATH}`,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey ?? ''}` },
      body: form,
    },
  };
}

function buildUpstreamRequest(id: VoiceLabProviderId, config: ResolvedProvider, text: string): UpstreamRequest {
  return id === 'elevenlabs' ? buildElevenLabsRequest(config, text) : buildNvidiaRequest(config, text);
}

/** Mensaje de error legible para un fallo del cerebro, sin claves ni cuerpos del proveedor. */
function brainErrorOf(error: unknown): { status: number; code: string; message: string } {
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'brain_error';
  const message = error instanceof Error && error.message !== '' ? error.message : 'El cerebro no respondió.';
  if (code === 'invalid_input') return { status: 400, code, message };
  if (code === 'unconfigured') return { status: 503, code, message };
  return { status: 502, code, message };
}

// ── Aplicación ───────────────────────────────────────────────────────────────

const turnSchema = z
  .object({
    message: z.string().trim().min(1).max(VOICE_LAB_MAX_TEXT_CHARS),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            text: z.string().trim().min(1).max(VOICE_LAB_MAX_TEXT_CHARS),
          })
          .strict(),
      )
      .max(VOICE_LAB_HISTORY_MAX_ITEMS)
      .optional(),
  })
  .strict();

const ttsSchema = z
  .object({
    provider: z.enum(['elevenlabs', 'nvidia']),
    text: z.string().trim().min(1).max(VOICE_LAB_MAX_TEXT_CHARS),
  })
  .strict();

/**
 * Crea el laboratorio aislado. No toca la red al construirse; cada llamada externa lleva su
 * propio `AbortController` registrado para que `close()` pueda cancelarla.
 */
export function createVoiceLab(options: VoiceLabOptions = {}): VoiceLab {
  const env = options.env ?? process.env;
  const fetcher: typeof fetch = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new VoiceLabError(500, 'invalid_fetcher', 'createVoiceLab requiere un fetcher compatible con fetch');
  }

  const timeoutMs = readTimeoutMs(env);
  const providers = resolveProviders(env);
  const secrets = [
    readEnvValue(env, 'ELEVENLABS_API_KEY'),
    readEnvValue(env, 'NVIDIA_API_KEY'),
    readEnvValue(env, 'NEBIUS_API_KEY'),
    readEnvValue(env, 'TAVILY_API_KEY'),
  ].filter((value): value is string => value !== undefined);

  const pending = new Set<AbortController>();
  const openResponses = new Set<express.Response>();
  let closed = false;

  function providerStatuses(): VoiceLabProviderStatus[] {
    return PROVIDER_ORDER.map((id) => {
      const provider = providers[id];
      const status: VoiceLabProviderStatus = {
        id,
        label: PROVIDER_LABELS[id],
        configured: provider.configured,
      };
      if (!provider.configured && provider.reason !== undefined) status.reason = provider.reason;
      return status;
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const controller of pending) {
      controller.abort(new DOMException('el laboratorio se cerró', 'AbortError'));
    }
    pending.clear();
    for (const response of openResponses) {
      // Sólo se corta lo que ya está transmitiendo: lo pendiente de cabeceras recibe su 503.
      if (!response.headersSent) continue;
      try {
        response.destroy();
      } catch {
        // El stream ya estaba cerrado: nada que hacer.
      }
    }
    openResponses.clear();
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: BODY_LIMIT }));

  // Mismo origen obligatorio: sin CORS, sin excepciones. Un `Origin` ausente no es un cruce.
  app.use('/api/lab', (req, res, next) => {
    if (closed) { res.status(503).json({ error: 'Laboratorio cerrado.' }); return; }
    const hostName = req.hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostName)) { res.status(403).json({ error: 'Host no permitido.' }); return; }
    const origin = req.get('origin');
    if (origin !== undefined && origin !== '') {
      const host = req.get('host');
      let sameOrigin = false;
      if (host !== undefined && host !== '') {
        try {
          sameOrigin = new URL(origin).origin === `http://${host}`;
        } catch {
          sameOrigin = false;
        }
      }
      if (!sameOrigin) {
        res.status(403).json({
          error: 'Origen no permitido: el laboratorio sólo acepta peticiones del mismo origen.',
        });
        return;
      }
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'El laboratorio no atiende CORS ni preflight.' });
      return;
    }
    if (req.method === 'POST' && !req.is('application/json')) {
      res.status(415).json({ error: 'Usa application/json.' });
      return;
    }
    next();
  });

  app.get('/api/lab/status', (_req, res) => {
    const status: VoiceLabStatus = {
      sampleRate: VOICE_LAB_SAMPLE_RATE,
      maxTextChars: VOICE_LAB_MAX_TEXT_CHARS,
      historyLimit: VOICE_LAB_HISTORY_LIMIT,
      providers: providerStatuses(),
    };
    res.json(status);
  });

  app.post('/api/lab/turn', async (req, res) => {
    const { message, history } = turnSchema.parse(req.body);
    const boundedHistory = (history ?? []).slice(-VOICE_LAB_HISTORY_LIMIT);
    const startedAt = performance.now();
    let reply: ChatReply;
    const controller = new AbortController(); pending.add(controller); openResponses.add(res);
    const onClose = () => controller.abort(); res.once('close', onClose);
    const deadline = setTimeout(() => controller.abort(), 45_000);
    try {
      const turnFetch: typeof fetch = (input, init) => fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
      const replyFn = options.reply ?? createCognition({ mode: 'live', env, fetcher: turnFetch }).reply;
      reply = await replyFn(buildTurnPrompt(message), emptySnapshot(), historyToEvents(boundedHistory));
      if (controller.signal.aborted) return;
    } catch (error) {
      const failure = brainErrorOf(error);
      if (closed) {
        res.status(503).json({ error: 'El laboratorio se cerró durante el turno.', code: 'lab_closed' });
        return;
      }
      res.status(failure.status).json({
        error: redactDetail(failure.message, secrets),
        code: failure.code,
      });
      return;
    } finally { clearTimeout(deadline); res.off('close', onClose); pending.delete(controller); openResponses.delete(res); }
    if (closed) {
      res.status(503).json({ error: 'El laboratorio se cerró durante el turno.', code: 'lab_closed' });
      return;
    }
    const result: VoiceLabTurnResult = {
      text: reply.text,
      model: reply.model,
      mode: reply.mode,
      brainMs: Math.round(performance.now() - startedAt),
      sources: reply.sources,
    };
    res.json(result);
  });

  app.post('/api/lab/tts', async (req, res) => {
    const { provider, text } = ttsSchema.parse(req.body);
    const config = providers[provider];
    if (!config.configured) {
      res.status(503).json({
        error: `${PROVIDER_LABELS[provider]} no está disponible.`,
        code: 'unconfigured',
        provider,
        reason: config.reason ?? 'configuración incompleta',
      });
      return;
    }

    const controller = new AbortController();
    pending.add(controller);
    openResponses.add(res);
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(`la voz no respondió en ${timeoutMs} ms`, 'TimeoutError'));
    }, timeoutMs);
    const abortOnDisconnect = (): void => {
      if (!finished) controller.abort(new DOMException('el cliente cerró la conexión', 'AbortError'));
    };
    res.on('close', abortOnDisconnect);

    try {
      const request = buildUpstreamRequest(provider, config, text);
      let upstream: Response;
      try {
        upstream = await fetcher(request.url, { ...request.init, signal: controller.signal });
      } catch (error) {
        if (closed) throw new VoiceLabError(503, 'lab_closed', 'El laboratorio se cerró y la síntesis pendiente fue cancelada.');
        if (timedOut) throw new VoiceLabError(504, 'timeout', `El proveedor de voz no respondió en ${timeoutMs} ms.`);
        if (isAbortError(error)) throw new VoiceLabError(499, 'client_aborted', 'El cliente cerró la conexión.');
        throw new VoiceLabError(502, 'network_error', `No se pudo contactar a ${PROVIDER_LABELS[provider]}.`);
      }

      if (!upstream.ok) {
        if (provider === 'nvidia' && upstream.status === 404) {
          throw new VoiceLabError(
            502,
            'nvidia_endpoint_unavailable',
            'NVIDIA TTS respondió HTTP 404: el endpoint hospedado de síntesis en streaming no está disponible para esta credencial. No hay respaldo automático a ElevenLabs.',
          );
        }
        throw new VoiceLabError(502, 'upstream_http', `${PROVIDER_LABELS[provider]} respondió HTTP ${upstream.status}.`);
      }

      const contentType = sanitizeHeaderValue(upstream.headers.get('content-type'));
      // NVIDIA puede omitir el content-type; un JSON declarado nunca se trata como audio.
      if (contentType !== null && !isAudioContentType(contentType)) {
        throw new VoiceLabError(
          502,
          'upstream_content_type',
          `${PROVIDER_LABELS[provider]} devolvió un content-type que no es audio (${contentType}).`,
        );
      }
      if (provider === 'elevenlabs' && contentType === null) {
        throw new VoiceLabError(
          502,
          'upstream_content_type',
          'ElevenLabs devolvió un content-type de audio ausente.',
        );
      }

      const body = upstream.body;
      if (body === null) throw new VoiceLabError(502, 'empty_stream', 'El proveedor devolvió audio vacío.');

      const reader = body.getReader();
      let total = 0;
      let first: Uint8Array | null = null;
      while (first === null) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.byteLength > 0) first = value;
      }
      if (first === null) {
        throw new VoiceLabError(502, 'empty_stream', `${PROVIDER_LABELS[provider]} devolvió un stream de audio vacío.`);
      }
      // Las cabeceras se envían sólo cuando ya hay audio real que retransmitir.
      sendAudioHeaders(res);
      total += first.byteLength;
      if (total > VOICE_LAB_MAX_TTS_BYTES) {
        throw new VoiceLabError(
          502,
          'audio_too_large',
          `El audio superó el máximo de ${VOICE_LAB_MAX_TTS_BYTES} bytes; se canceló la transmisión.`,
        );
      }
      res.write(Buffer.from(first));

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > VOICE_LAB_MAX_TTS_BYTES) {
          throw new VoiceLabError(
            502,
            'audio_too_large',
            `El audio superó el máximo de ${VOICE_LAB_MAX_TTS_BYTES} bytes; se canceló la transmisión.`,
          );
        }
        if (!res.write(Buffer.from(value))) {
          // Contrapresión: se espera al drenado o al cierre del cliente, lo que ocurra primero.
          await new Promise<void>((resolve) => {
            const resume = (): void => {
              res.off('drain', resume);
              res.off('close', resume);
              resolve();
            };
            res.once('drain', resume);
            res.once('close', resume);
          });
        }
      }
      finished = true;
      res.end();
    } catch (error) {
      try {
        controller.abort(error instanceof Error ? error : undefined);
      } catch {
        // La señal ya estaba abortada.
      }
      if (res.headersSent) {
        // El stream ya había empezado: no hay estado HTTP que corregir, se corta la conexión.
        finished = true;
        res.destroy();
      }
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      res.off('close', abortOnDisconnect);
      pending.delete(controller);
      openResponses.delete(res);
    }
  });

  // Cualquier ruta del laboratorio que no exista responde JSON, nunca HTML de Express.

  app.use('/api/lab', (req,res,next) => { if(req.path.startsWith('/agents/')) {next();return;} res.status(404).json({error:'Ruta del laboratorio no encontrada.',code:'not_found'}); });

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    void next;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'La solicitud no cumple el contrato.',
        fields: err.issues.map((issue) => issue.path.join('.')),
      });
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: `El JSON supera el máximo de ${VOICE_LAB_MAX_BODY_BYTES} bytes.` });
      return;
    }
    if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({ error: 'JSON inválido.' });
      return;
    }
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      res.status(415).json({ error: 'Codificación no soportada: usa UTF-8.' });
      return;
    }
    if (err instanceof VoiceLabError) {
      if (err.code === 'client_aborted') {
        // El cliente ya no está: no se escribe nada.
        return;
      }
      res.status(err.status).json({ error: redactDetail(err.message, secrets), code: err.code });
      return;
    }
    const detail = 'Error interno del laboratorio.';
    res.status(500).json({ error: redactDetail(detail, secrets), code: 'internal_error' });
  });

  return { app, close };
}

/** Cabeceras del PCM crudo: sin tipo MIME adivinado y con la frecuencia declarada. */
function sendAudioHeaders(res: express.Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Audio-Sample-Rate', String(VOICE_LAB_SAMPLE_RATE));
}
