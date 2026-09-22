/**
 * Pruebas del laboratorio conversacional A/B (`src/voice-lab.ts`).
 *
 * Todo corre sin red externa: el `fetch` del laboratorio y el cerebro (`reply`) se inyectan, y el
 * servidor sólo escucha en `127.0.0.1` en un puerto efímero. Los valores con forma de clave son
 * ficticios y sirven, entre otras cosas, para comprobar que nunca salen del servidor.
 *
 * Cubre: streaming real (primer chunk antes de que el productor cierre), contratos exactos de
 * ElevenLabs y NVIDIA, errores sin cuerpos ni claves, Origin distinto del Host, cancelación por
 * desconexión, timeout de cabeceras y de cuerpo, tope de 4 MiB, límites de entrada, historia
 * acotada, configuración de proveedores y `close()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  ELEVENLABS_TTS_BASE,
  ELEVENLABS_TTS_MODEL,
  NVIDIA_TTS_DEFAULT_BASE_URL,
  VOICE_LAB_MAX_TTS_BYTES,
  VOICE_LAB_SAMPLE_RATE,
  VOICE_LAB_TTS_TIMEOUT_MS,
  createVoiceLab,
  type VoiceLab,
  type VoiceLabOptions,
} from '../src/voice-lab.js';
import type { ChatReply, GraphSnapshot, OrganimaEvent } from '../src/contracts.js';

/* ────────────────────────────── utilidades de prueba ────────────────────────────── */

/** Clave ficticia de ElevenLabs; su forma permite verificar que no se filtra. */
const API_KEY = 'sk_test_fake_lab_key_000';
/** Clave ficticia de NVIDIA. */
const NVIDIA_KEY = 'nvapi_test_fake_lab_key_000';
/** Voz ficticia con la forma alfanumérica real de ElevenLabs. */
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type CapturedCall = { url: string; init: FetchInit | undefined };

function labEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ELEVENLABS_API_KEY: API_KEY, ELEVENLABS_VOICE_ID: VOICE_ID, ...overrides };
}

function fakeReply(overrides: Partial<ChatReply> = {}): ChatReply {
  return {
    text: 'Hola desde el cerebro de prueba.',
    mode: 'live',
    sources: [],
    decision: { notify: false, research: false, escalate: false, probability: 0, provider: 'rules', mode: 'live' },
    model: 'modelo-de-prueba',
    ...overrides,
  };
}

/** `fetch` inyectado que registra cada llamada y responde lo que diga el manejador. */
function captureFetcher(
  handler: (url: string, init: FetchInit | undefined) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetcher = (async (input: unknown, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** `fetch` que nunca responde y rechaza en cuanto la señal (del servidor) se aborta. */
function hangingFetcher(record: { signal?: AbortSignal; calls: number }): typeof fetch {
  return (async (_input: unknown, init?: FetchInit): Promise<Response> => {
    record.calls += 1;
    const signal = init?.signal ?? undefined;
    record.signal = signal;
    return await new Promise<Response>((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error('la petición al proveedor no llevaba señal de cancelación'));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

/** `fetch` que jamás debe llamarse: falla la prueba si alguien lo invoca. */
function forbiddenFetcher(calls: unknown[] = []): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    calls.push(input);
    throw new Error('fetch no debía llamarse');
  }) as unknown as typeof fetch;
}

interface LabContext {
  base: string;
  lab: VoiceLab;
}

/** Levanta el laboratorio en un puerto efímero de loopback y siempre lo cierra al terminar. */
async function withLab<T>(options: VoiceLabOptions, run: (context: LabContext) => Promise<T>): Promise<T> {
  const lab = createVoiceLab(options);
  const server = lab.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ base, lab });
  } finally {
    lab.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor agotó el tiempo de espera');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ──────────────────────────────────── pruebas ──────────────────────────────────── */

test('status: proveedores disponibles y razones, sin claves ni ids de voz', async () => {
  await withLab({ env: labEnv(), fetcher: forbiddenFetcher() }, async ({ base }) => {
    const response = await fetch(base + '/api/lab/status');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sampleRate, VOICE_LAB_SAMPLE_RATE);
    assert.equal(body.maxTextChars, 1600);
    assert.equal(body.historyLimit, 12);
    assert.deepEqual(
      body.providers.map((provider: { id: string }) => provider.id),
      ['elevenlabs', 'nvidia'],
    );
    assert.equal(body.providers[0].configured, true);
    assert.equal(body.providers[1].configured, false);
    assert.match(body.providers[1].reason, /NVIDIA_API_KEY/);
    const raw = JSON.stringify(body);
    assert.equal(raw.includes(API_KEY), false);
    assert.equal(raw.includes(VOICE_ID), false);
  });

  // NVIDIA exige voz explícita: con clave pero sin voz sigue sin estar disponible.
  await withLab({ env: { NVIDIA_API_KEY: NVIDIA_KEY }, fetcher: forbiddenFetcher() }, async ({ base }) => {
    const body = await (await fetch(base + '/api/lab/status')).json();
    const nvidia = body.providers.find((provider: { id: string }) => provider.id === 'nvidia');
    assert.equal(nvidia.configured, false);
    assert.match(nvidia.reason, /NVIDIA_TTS_VOICE/);
    assert.equal(JSON.stringify(body).includes(NVIDIA_KEY), false);
  });

  // Una base de NVIDIA que no sea http(s) es configuración inválida, no una URL cualquiera.
  await withLab(
    { env: { NVIDIA_API_KEY: NVIDIA_KEY, NVIDIA_TTS_VOICE: 'voz', NVIDIA_TTS_BASE_URL: 'file:///tmp/x' }, fetcher: forbiddenFetcher() },
    async ({ base }) => {
      const body = await (await fetch(base + '/api/lab/status')).json();
      const nvidia = body.providers.find((provider: { id: string }) => provider.id === 'nvidia');
      assert.equal(nvidia.configured, false);
      assert.match(nvidia.reason, /NVIDIA_TTS_BASE_URL/);
    },
  );
});

test('turn: texto, modelo, duración del cerebro e historia convertida a eventos', async () => {
  const captured: { message: string; snapshot: GraphSnapshot; history: OrganimaEvent[] }[] = [];
  const reply = async (message: string, snapshot: GraphSnapshot, history: OrganimaEvent[]): Promise<ChatReply> => {
    captured.push({ message, snapshot, history });
    return fakeReply();
  };

  await withLab({ env: labEnv(), fetcher: forbiddenFetcher(), reply }, async ({ base }) => {
    const history = [
      { role: 'user', text: 'hola' },
      { role: 'assistant', text: '¿qué tal?' },
      { role: 'user', text: '¿me oyes?' },
    ];
    const response = await postJson(base, '/api/lab/turn', { message: 'cuéntame algo', history });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, fakeReply().text);
    assert.equal(body.model, 'modelo-de-prueba');
    assert.equal(body.mode, 'live');
    assert.equal(typeof body.brainMs, 'number');
    assert.ok(body.brainMs >= 0, 'la duración del cerebro debe ser un número no negativo');

    assert.equal(captured.length, 1);
    const call = captured[0]!;
    assert.match(call.message, /cuéntame algo/);
    assert.match(call.message, /breve/i);
    assert.deepEqual(call.snapshot, { version: 0, relations: [], events: [] });
    assert.equal(call.history.length, 3);
    assert.deepEqual(
      call.history.map((event) => event.type),
      ['conversation.user', 'conversation.reply', 'conversation.user'],
    );
    assert.deepEqual(
      call.history.map((event) => event.payload.text),
      ['hola', '¿qué tal?', '¿me oyes?'],
    );
    assert.ok(call.history.every((event) => event.cellId === 'voice-lab' && event.mode === 'live'));
  });
});

test('turn: sólo los últimos 12 turnos llegan al cerebro', async () => {
  const seen: OrganimaEvent[][] = [];
  const reply = async (_message: string, _snapshot: GraphSnapshot, history: OrganimaEvent[]): Promise<ChatReply> => {
    seen.push(history);
    return fakeReply();
  };

  await withLab({ env: labEnv(), fetcher: forbiddenFetcher(), reply }, async ({ base }) => {
    const history = Array.from({ length: 16 }, (_value, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: 'turno-' + index,
    }));
    const response = await postJson(base, '/api/lab/turn', { message: 'sigue', history });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.length, 12);
    assert.equal(seen[0]![0]!.payload.text, 'turno-4');
    assert.equal(seen[0]![11]!.payload.text, 'turno-15');
  });
});

test('turn: límites estrictos sin truncar en silencio y errores sin claves', async () => {
  let calls = 0;
  const reply = async (): Promise<ChatReply> => {
    calls += 1;
    return fakeReply();
  };

  await withLab({ env: labEnv(), reply, fetcher: forbiddenFetcher() }, async ({ base }) => {
    const tooLong = await postJson(base, '/api/lab/turn', { message: 'a'.repeat(1601) });
    assert.equal(tooLong.status, 400);
    assert.deepEqual((await tooLong.json()).fields, ['message']);

    assert.equal((await postJson(base, '/api/lab/turn', { message: '   ' })).status, 400);
    assert.equal((await postJson(base, '/api/lab/turn', { message: 'hola', extra: true })).status, 400);
    assert.equal(
      (await postJson(base, '/api/lab/turn', { message: 'hola', history: [{ role: 'system', text: 'x' }] })).status,
      400,
    );
    assert.equal(
      (
        await postJson(base, '/api/lab/turn', {
          message: 'hola',
          history: Array.from({ length: 25 }, (_value, index) => ({ role: 'user', text: 't' + index })),
        })
      ).status,
      400,
    );
    assert.equal(calls, 0);

    const notJson = await fetch(base + '/api/lab/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hola',
    });
    assert.equal(notJson.status, 415);

    // 40 000 caracteres no caben en el tope de 32 KiB del cuerpo JSON.
    const huge = await postJson(base, '/api/lab/turn', {
      message: 'hola',
      history: [{ role: 'user', text: 'b'.repeat(40000) }],
    });
    assert.equal(huge.status, 413);

    // Exactamente el máximo sí pasa y llega completo al cerebro.
    const exact = await postJson(base, '/api/lab/turn', { message: 'c'.repeat(1600) });
    assert.equal(exact.status, 200);
    assert.equal(calls, 1);
  });

  // Un fallo del cerebro con una clave dentro se devuelve redactado.
  const leaky = async (): Promise<ChatReply> => {
    throw new Error('fallo interno con ' + API_KEY + ' dentro');
  };
  await withLab({ env: labEnv(), reply: leaky, fetcher: forbiddenFetcher() }, async ({ base }) => {
    const response = await postJson(base, '/api/lab/turn', { message: 'hola' });
    assert.equal(response.status, 502);
    const raw = await response.text();
    assert.equal(raw.includes(API_KEY), false);
    assert.match(raw, /redactado/);
  });
});

test('tts ElevenLabs: petición exacta y primer chunk antes de que el productor cierre', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const producer = { closed: false };
  const calls: CapturedCall[] = [];
  const fetcher = (async (input: unknown, init?: FetchInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2]));
        await gate; // el productor sigue abierto mientras el cliente ya tiene bytes
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
        producer.closed = true;
      },
      cancel() {
        producer.closed = true;
      },
    });
    return new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'audio/pcm' },
    });
  }) as unknown as typeof fetch;

  await withLab({ env: labEnv(), fetcher }, async ({ base }) => {
    const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: '  Hola, Organima.  ' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-audio-sample-rate'), String(VOICE_LAB_SAMPLE_RATE));
    assert.equal(response.headers.get('access-control-allow-origin'), null);

    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.deepEqual([...first.value!], [0, 1, 2]);
    // El productor todavía no cerró: el servidor retransmite en vivo, no acumula el cuerpo.
    assert.equal(producer.closed, false);

    release();
    const second = await reader.read();
    assert.deepEqual([...second.value!], [3, 4]);
    assert.equal((await reader.read()).done, true);
    assert.equal(producer.closed, true);
  });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${ELEVENLABS_TTS_BASE}/${VOICE_ID}/stream?output_format=pcm_22050`);
  assert.equal(call.init?.method, 'POST');
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('xi-api-key'), API_KEY);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    text: 'Hola, Organima.',
    model_id: ELEVENLABS_TTS_MODEL,
    language_code: 'es',
    voice_settings: { stability: 0.45, similarity_boost: 0.75 },
  });
});

test('tts NVIDIA: FormData documentada, base configurable y content-type ausente aceptado', async () => {
  const { fetcher, calls } = captureFetcher(
    () => new Response(new Uint8Array([7, 8, 9, 10]), { status: 200 }),
  );

  await withLab(
    {
      env: {
        NVIDIA_API_KEY: NVIDIA_KEY,
        NVIDIA_TTS_VOICE: 'Magpie-Multilingual',
        NVIDIA_TTS_BASE_URL: 'https://tts.example.test/',
      },
      fetcher,
    },
    async ({ base }) => {
      const response = await postJson(base, '/api/lab/tts', { provider: 'nvidia', text: 'Hola NVIDIA' });
      assert.equal(response.status, 200);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([7, 8, 9, 10]));
    },
  );

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://tts.example.test/v1/audio/synthesize_online');
  assert.equal(new Headers(call.init?.headers).get('authorization'), `Bearer ${NVIDIA_KEY}`);
  const form = call.init?.body;
  assert.ok(form instanceof FormData);
  const data = form as FormData;
  assert.equal(data.get('text'), 'Hola NVIDIA');
  assert.equal(data.get('language'), 'es-US');
  assert.equal(data.get('voice'), 'Magpie-Multilingual');
  assert.equal(data.get('sample_rate_hz'), String(VOICE_LAB_SAMPLE_RATE));
  assert.equal(data.get('encoding'), 'LINEAR_PCM');
  assert.deepEqual([...data.keys()].sort(), ['encoding', 'language', 'sample_rate_hz', 'text', 'voice']);

  // Sin override se usa la base hospedada por defecto.
  const fallback = captureFetcher(() => new Response(new Uint8Array([1, 2]), { status: 200 }));
  await withLab(
    { env: { NVIDIA_API_KEY: NVIDIA_KEY, NVIDIA_TTS_VOICE: 'voz' }, fetcher: fallback.fetcher },
    async ({ base }) => {
      assert.equal((await postJson(base, '/api/lab/tts', { provider: 'nvidia', text: 'hola' })).status, 200);
    },
  );
  assert.equal(fallback.calls[0]!.url, `${NVIDIA_TTS_DEFAULT_BASE_URL}/v1/audio/synthesize_online`);
});

test('tts NVIDIA 404: se informa claro y NUNCA hay respaldo a ElevenLabs', async () => {
  const { fetcher, calls } = captureFetcher(
    () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
  );

  await withLab(
    { env: { ...labEnv(), NVIDIA_API_KEY: NVIDIA_KEY, NVIDIA_TTS_VOICE: 'voz' }, fetcher },
    async ({ base }) => {
      const response = await postJson(base, '/api/lab/tts', { provider: 'nvidia', text: 'hola' });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.code, 'nvidia_endpoint_unavailable');
      assert.match(body.error, /404/);
      assert.match(body.error, /respaldo automático/i);
      // ElevenLabs estaba configurado y aun así jamás se llamó: no hay sustitución silenciosa.
      assert.equal(calls.length, 1);
    },
  );
});

test('tts errores: HTTP del proveedor y content-type no-audio, sin filtrar claves ni cuerpos', async () => {
  const upstreamBody = 'CUERPO-UPSTREAM-SECRETO ' + API_KEY;
  const failing = captureFetcher(
    () => new Response(upstreamBody, { status: 500, headers: { 'content-type': 'text/plain' } }),
  );
  await withLab({ env: labEnv(), fetcher: failing.fetcher }, async ({ base }) => {
    const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
    assert.equal(response.status, 502);
    const raw = await response.text();
    assert.match(raw, /HTTP 500/);
    assert.equal(raw.includes(API_KEY), false);
    assert.equal(raw.includes('CUERPO-UPSTREAM-SECRETO'), false);
  });

  // Un JSON declarado como audio jamás se devuelve como PCM.
  const jsonType = captureFetcher(
    () => new Response(JSON.stringify({ detail: 'boom' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  await withLab({ env: labEnv(), fetcher: jsonType.fetcher }, async ({ base }) => {
    const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /content-type/);
  });

  // Content-type ausente en ElevenLabs tampoco se acepta como audio.
  const noType = captureFetcher(() => new Response(new Uint8Array([1, 2]), { status: 200 }));
  await withLab({ env: labEnv(), fetcher: noType.fetcher }, async ({ base }) => {
    const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /content-type/);
  });

  await withLab({ env: labEnv(), fetcher: forbiddenFetcher() }, async ({ base }) => {
    const unavailable = await postJson(base, '/api/lab/tts', { provider: 'nvidia', text: 'hola' });
    assert.equal(unavailable.status, 503);
    const body = await unavailable.json();
    assert.equal(body.code, 'unconfigured');
    assert.match(body.reason, /NVIDIA_API_KEY/);

    assert.equal((await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'x'.repeat(1601) })).status, 400);
    assert.equal((await postJson(base, '/api/lab/tts', { provider: 'otro', text: 'hola' })).status, 400);
    assert.equal((await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: '   ' })).status, 400);
  });
});

test('mismo origen: Origin distinto del Host se rechaza y nunca hay cabeceras CORS', async () => {
  const { fetcher, calls } = captureFetcher(
    () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/pcm' } }),
  );

  await withLab({ env: labEnv(), fetcher }, async ({ base }) => {
    const same = await fetch(base + '/api/lab/status', { headers: { Origin: base } });
    assert.equal(same.status, 200);
    assert.equal(same.headers.get('access-control-allow-origin'), null);

    const cross = await fetch(base + '/api/lab/status', { headers: { Origin: 'http://evil.test' } });
    assert.equal(cross.status, 403);
    assert.match((await cross.json()).error, /Origen no permitido/);
    assert.equal(cross.headers.get('access-control-allow-origin'), null);

    const crossPost = await postJson(
      base,
      '/api/lab/tts',
      { provider: 'elevenlabs', text: 'hola' },
      { Origin: 'http://evil.test' },
    );
    assert.equal(crossPost.status, 403);
    assert.equal(calls.length, 0);

    const nullOrigin = await fetch(base + '/api/lab/status', { headers: { Origin: 'null' } });
    assert.equal(nullOrigin.status, 403);

    const preflight = await fetch(base + '/api/lab/tts', {
      method: 'OPTIONS',
      headers: { Origin: base, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);

    const unknown = await fetch(base + '/api/lab/no-existe');
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'not_found');
  });
});

test('cancelación: abortar el cliente corta la petición al proveedor', async () => {
  const record: { signal?: AbortSignal; calls: number } = { calls: 0 };
  await withLab({ env: labEnv(), fetcher: hangingFetcher(record) }, async ({ base }) => {
    const controller = new AbortController();
    const pending = postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' }, {}, controller.signal);
    await waitFor(() => record.calls === 1);
    assert.equal(record.signal?.aborted, false);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
    await waitFor(() => record.signal?.aborted === true);
    assert.equal(record.signal?.aborted, true);
  });
});

test('timeout: el plazo por defecto es 30 s y corta cabeceras y cuerpo', async () => {
  assert.equal(VOICE_LAB_TTS_TIMEOUT_MS, 30_000);

  // (a) Nunca llegan cabeceras del proveedor.
  const never: { signal?: AbortSignal; calls: number } = { calls: 0 };
  await withLab(
    { env: labEnv({ VOICE_LAB_TTS_TIMEOUT_MS: '120' }), fetcher: hangingFetcher(never) },
    async ({ base }) => {
      const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
      assert.equal(response.status, 504);
      const body = await response.json();
      assert.equal(body.code, 'timeout');
      assert.match(body.error, /120/);
      await waitFor(() => never.signal?.aborted === true);
    },
  );

  // (b) Llega el primer chunk y el productor se queda callado: el plazo corta el stream.
  const stalled: { signal?: AbortSignal; calls: number } = { calls: 0 };
  const stalledFetcher = (async (_input: unknown, init?: FetchInit): Promise<Response> => {
    stalled.calls += 1;
    stalled.signal = init?.signal ?? undefined;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        // Nunca cierra: debe cortarlo el plazo del servidor.
      },
    });
    init?.signal?.addEventListener('abort', () => {
      try {
        controllerRef?.close();
      } catch {
        // El stream ya estaba cerrado.
      }
    });
    return new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'audio/pcm' },
    });
  }) as unknown as typeof fetch;

  await withLab(
    { env: labEnv({ VOICE_LAB_TTS_TIMEOUT_MS: '150' }), fetcher: stalledFetcher },
    async ({ base }) => {
      const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.deepEqual([...first.value!], [1, 2, 3, 4]);
      // El stream se cierra o falla, pero nunca llega más audio.
      let ended = false;
      try {
        ended = (await reader.read()).done === true;
      } catch {
        ended = true;
      }
      assert.equal(ended, true);
      await waitFor(() => stalled.signal?.aborted === true);
    },
  );
});

test('límite de audio: el tope de 4 MiB corta la transmisión', { timeout: 30000 }, async () => {
  assert.equal(VOICE_LAB_MAX_TTS_BYTES, 4 * 1024 * 1024);
  const chunk = new Uint8Array(64 * 1024).fill(0x5a);
  const state = { aborted: false };
  const fetcher = (async (_input: unknown, init?: FetchInit): Promise<Response> => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(chunk);
      },
      pull(controller) {
        // Productor infinito: el servidor debe cortarlo por el tope, no el productor.
        controller.enqueue(chunk);
      },
    });
    init?.signal?.addEventListener('abort', () => {
      state.aborted = true;
      try {
        controllerRef?.error(new Error('abortado por el servidor'));
      } catch {
        // El stream ya estaba cerrado.
      }
    });
    return new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'audio/pcm' },
    });
  }) as unknown as typeof fetch;

  await withLab(
    { env: labEnv({ VOICE_LAB_TTS_TIMEOUT_MS: '20000' }), fetcher },
    async ({ base }) => {
      const response = await postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      let total = 0;
      let failed = false;
      for (;;) {
        try {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) total += value.byteLength;
        } catch {
          failed = true;
          break;
        }
      }
      assert.ok(total > 0, 'el cliente debía recibir algo de audio antes del corte');
      assert.ok(
        total <= VOICE_LAB_MAX_TTS_BYTES + chunk.byteLength,
        `el cliente recibió ${total} bytes, más que el tope más un fragmento`,
      );
      assert.ok(failed || total <= VOICE_LAB_MAX_TTS_BYTES + chunk.byteLength);
      await waitFor(() => state.aborted === true);
    },
  );
});

test('close(): cancela la síntesis pendiente y la petición no queda colgada', async () => {
  const record: { signal?: AbortSignal; calls: number } = { calls: 0 };
  await withLab({ env: labEnv(), fetcher: hangingFetcher(record) }, async ({ base, lab }) => {
    const pending = postJson(base, '/api/lab/tts', { provider: 'elevenlabs', text: 'hola' });
    await waitFor(() => record.calls === 1);
    lab.close();
    const response = await pending;
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'lab_closed');
    assert.equal(record.signal?.aborted, true);
  });
});
