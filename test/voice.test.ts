/**
 * Pruebas del pilar voz (src/voice.ts).
 *
 * Cubren el contrato observable del PLAN: petición exacta, validación del id de voz en la URL,
 * falta de configuración, cancelación (barge-in), timeout compartido, errores HTTP, contenido
 * no-audio, tope de 5 MB, audio vacío y éxito.
 *
 * Nunca hay red: `fetch` siempre se inyecta. La key y el id usados son ficticios de prueba.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVENLABS_API_BASE,
  ELEVENLABS_MODEL_ID,
  MAX_AUDIO_BYTES,
  MAX_TEXT_LENGTH,
  VOICE_TIMEOUT_MS,
  createVoice,
} from '../src/voice.js';

/* ────────────────────────────── utilidades de prueba ────────────────────────────── */

/** Key ficticia: nunca es un secreto real y sirve para probar que no se filtra. */
const API_KEY = 'sk_test_fake_key_000';
/** Id de voz ficticio pero con la forma alfanumérica real de ElevenLabs. */
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
/** Audio MP3 mínimo ficticio (cabecera + carga). */
const AUDIO_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);

type FetchInit = Parameters<typeof fetch>[1];
type CapturedRequest = { url: string; init: FetchInit };

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ELEVENLABS_API_KEY: API_KEY, ELEVENLABS_VOICE_ID: VOICE_ID, ...overrides };
}

function audioResponse(bytes: Uint8Array = AUDIO_BYTES, contentType = 'audio/mpeg'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

/** `fetch` inyectado que registra cada llamada y responde lo que diga el manejador. */
function captureFetcher(
  handler: (url: string, init: FetchInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetcher = (async (input: unknown, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** `fetch` que nunca responde y rechaza en cuanto la señal (combinada) se aborta. */
function hangingFetcher(record: { signal?: AbortSignal }): typeof fetch {
  return (async (_input: unknown, init?: FetchInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    record.signal = signal;
    return await new Promise<Response>((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error('la petición no llevaba señal de cancelación'));
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
function forbiddenFetcher(calls: CapturedRequest[]): typeof fetch {
  return (async (input: unknown, init?: FetchInit): Promise<Response> => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init });
    throw new Error('fetch no debía llamarse');
  }) as unknown as typeof fetch;
}

/**
 * Exige un rechazo con `Error` cuyo mensaje cumpla el patrón y devuelve el error para seguir
 * inspeccionándolo (p. ej. comprobar que no filtra secretos).
 */
async function expectRejection(run: () => Promise<unknown>, expected: RegExp): Promise<Error> {
  let captured: unknown;
  let rejected = false;
  try {
    await run();
  } catch (error) {
    rejected = true;
    captured = error;
  }
  assert.equal(rejected, true, 'se esperaba un rechazo');
  assert.ok(captured instanceof Error, 'el rechazo debe ser un Error');
  assert.match(captured.message, expected);
  return captured;
}

/* ──────────────────────────────────── pruebas ──────────────────────────────────── */

test('status inicial: sin key o sin voz el pilar queda unconfigured', () => {
  const noCalls: CapturedRequest[] = [];

  const empty = createVoice({ env: {}, fetcher: forbiddenFetcher(noCalls) });
  assert.deepEqual(empty.status(), {
    configured: false,
    provider: 'elevenlabs',
    language: 'es',
    state: 'unconfigured',
  });
  assert.equal(empty.status().voiceId, undefined);

  const onlyKey = createVoice({
    env: { ELEVENLABS_API_KEY: API_KEY },
    fetcher: forbiddenFetcher(noCalls),
  });
  assert.equal(onlyKey.status().state, 'unconfigured');
  assert.equal(onlyKey.status().configured, false);
  assert.equal(onlyKey.status().voiceId, undefined);

  const onlyVoice = createVoice({
    env: { ELEVENLABS_VOICE_ID: VOICE_ID },
    fetcher: forbiddenFetcher(noCalls),
  });
  assert.equal(onlyVoice.status().state, 'unconfigured');
  assert.equal(onlyVoice.status().configured, false);
  // La voz sí se conoce aunque falte la key: el estado no esconde datos ya presentes.
  assert.equal(onlyVoice.status().voiceId, VOICE_ID);

  const blank = createVoice({
    env: { ELEVENLABS_API_KEY: '   ', ELEVENLABS_VOICE_ID: '  ' },
    fetcher: forbiddenFetcher(noCalls),
  });
  assert.equal(blank.status().state, 'unconfigured');
  assert.equal(blank.status().voiceId, undefined);

  assert.deepEqual(noCalls, []);
});

test('synthesize sin configuración se rechaza sin tocar la red y sin filtrar la key', async () => {
  const noCalls: CapturedRequest[] = [];
  const fetcher = forbiddenFetcher(noCalls);

  const noKey = createVoice({ env: { ELEVENLABS_VOICE_ID: VOICE_ID }, fetcher });
  await assert.rejects(() => noKey.synthesize('hola'), /ELEVENLABS_API_KEY/);

  const noVoice = createVoice({ env: { ELEVENLABS_API_KEY: API_KEY }, fetcher });
  await assert.rejects(() => noVoice.synthesize('hola'), /ELEVENLABS_VOICE_ID/);

  const neither = createVoice({ env: {}, fetcher });
  const error = await expectRejection(() => neither.synthesize('hola'), /no disponible/);
  const message = error.message;
  assert.equal(message.includes(API_KEY), false);

  assert.deepEqual(noCalls, []);
});

test('un id de voz no alfanumérico es error de configuración y no altera la URL', async () => {
  const invalidIds = ['../../evil', 'abc/def', 'abc def', 'abc-def', 'Voz_Mexicana'];

  for (const badVoice of invalidIds) {
    const noCalls: CapturedRequest[] = [];
    const voice = createVoice({
      env: validEnv({ ELEVENLABS_VOICE_ID: badVoice }),
      fetcher: forbiddenFetcher(noCalls),
    });
    const status = voice.status();
    assert.equal(status.state, 'error', badVoice);
    assert.equal(status.configured, false, badVoice);
    assert.equal(status.voiceId, undefined, badVoice);
    await assert.rejects(() => voice.synthesize('hola'), /alfanumérico/, badVoice);
    assert.deepEqual(noCalls, [], `fetch se llamó con el id inválido ${badVoice}`);
  }
});

test('petición exacta: URL, POST, headers y body; status untested → ready sólo con audio válido', async () => {
  const { fetcher, calls } = captureFetcher(() => audioResponse());
  const voice = createVoice({ env: validEnv(), fetcher });

  assert.equal(voice.status().state, 'untested');
  assert.equal(voice.status().configured, true);
  assert.equal(voice.status().voiceId, VOICE_ID);
  assert.equal(voice.status().provider, 'elevenlabs');
  assert.equal(voice.status().language, 'es');

  const audio = await voice.synthesize('  Hola, Organima.  ');

  assert.deepEqual(audio, AUDIO_BYTES);
  assert.equal(voice.status().state, 'ready');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  // El id alfanumérico se conserva tal cual en la ruta y el endpoint es el oficial.
  assert.equal(call.url, `${ELEVENLABS_API_BASE}/${VOICE_ID}/stream`);
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    text: 'Hola, Organima.',
    model_id: ELEVENLABS_MODEL_ID,
    language_code: 'es',
    voice_settings: { stability: 0.45, similarity_boost: 0.75 },
  });

  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('xi-api-key'), API_KEY);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual([...headers.keys()].sort(), ['content-type', 'xi-api-key']);
});

test('el texto se recorta y los límites se aplican antes de tocar la red', async () => {
  const { fetcher, calls } = captureFetcher(() => audioResponse());
  const voice = createVoice({ env: validEnv(), fetcher });

  await assert.rejects(() => voice.synthesize(''), /vacío/);
  await assert.rejects(() => voice.synthesize('   \n\t '), /vacío/);
  await assert.rejects(
    () => voice.synthesize(42 as unknown as string),
    /texto \(string\)/,
  );
  await assert.rejects(
    () => voice.synthesize('a'.repeat(MAX_TEXT_LENGTH + 1)),
    /1600/,
  );
  assert.deepEqual(calls, []);

  // Exactamente el máximo sí se acepta.
  await voice.synthesize('a'.repeat(MAX_TEXT_LENGTH));
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]!.init?.body)) as { text: string };
  assert.equal(body.text.length, MAX_TEXT_LENGTH);
});

test('cancelación (barge-in): la señal del llamador aborta la petición y no marca error del proveedor', async () => {
  const record: { signal?: AbortSignal } = {};
  const voice = createVoice({ env: validEnv(), fetcher: hangingFetcher(record) });
  const controller = new AbortController();

  const pending = voice.synthesize('hola', controller.signal);
  // `synthesize` ya invocó al fetcher: la señal que recibe es una combinada, no la del llamador.
  assert.ok(record.signal instanceof AbortSignal);
  assert.notEqual(record.signal, controller.signal);
  assert.equal(record.signal?.aborted, false);

  controller.abort();

  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  // Un barge-in es una operación normal: el estado no se degrada a `error`.
  assert.equal(voice.status().state, 'untested');
});

test('una señal ya abortada se rechaza sin llamar al proveedor', async () => {
  const noCalls: CapturedRequest[] = [];
  const voice = createVoice({ env: validEnv(), fetcher: forbiddenFetcher(noCalls) });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => voice.synthesize('hola', controller.signal),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
  assert.deepEqual(noCalls, []);
});

test(`el timeout de ${VOICE_TIMEOUT_MS} ms aborta una respuesta que nunca llega`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const record: { signal?: AbortSignal } = {};
    const voice = createVoice({ env: validEnv(), fetcher: hangingFetcher(record) });

    const settled = voice.synthesize('hola').catch((error: unknown) => error);
    t.mock.timers.tick(VOICE_TIMEOUT_MS);

    const error = await settled;
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(String(VOICE_TIMEOUT_MS)));
    assert.equal(voice.status().state, 'error');
    assert.ok(record.signal instanceof AbortSignal);
    assert.equal(record.signal.aborted, true);
  } finally {
    t.mock.timers.reset();
  }
});

test('HTTP de error: se reporta el status, nunca el cuerpo del proveedor', async () => {
  const upstreamBody = 'CUERPO-UPSTREAM-SECRETO {"detail":"boom"}';
  const { fetcher } = captureFetcher(
    () =>
      new Response(upstreamBody, {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const voice = createVoice({ env: validEnv(), fetcher });

  const error = await expectRejection(() => voice.synthesize('hola'), /HTTP 503/);
  const message = error.message;
  assert.equal(message.includes(upstreamBody), false);
  assert.equal(message.includes(API_KEY), false);
  // La configuración sigue en pie: el fallo fue del proveedor, no del entorno.
  assert.equal(voice.status().configured, true);
  assert.equal(voice.status().voiceId, VOICE_ID);
  assert.equal(voice.status().state, 'error');
});

test('content-type no-audio se rechaza: un JSON nunca se devuelve como MP3', async () => {
  const { fetcher } = captureFetcher(
    () =>
      new Response(JSON.stringify({ audio_base64: 'no-soy-mp3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const voice = createVoice({ env: validEnv(), fetcher });

  await assert.rejects(() => voice.synthesize('hola'), /no-audio: application\/json/);
  assert.equal(voice.status().state, 'error');
});

test('content-type ausente se rechaza y un audio/* con parámetros se acepta', async () => {
  const missing = captureFetcher(() => new Response(AUDIO_BYTES, { status: 200 }));
  const missingVoice = createVoice({ env: validEnv(), fetcher: missing.fetcher });
  await assert.rejects(() => missingVoice.synthesize('hola'), /no-audio: \(ausente\)/);
  assert.equal(missingVoice.status().state, 'error');

  const withParams = captureFetcher(() => audioResponse(AUDIO_BYTES, 'audio/mpeg; charset=binary'));
  const paramVoice = createVoice({ env: validEnv(), fetcher: withParams.fetcher });
  assert.deepEqual(await paramVoice.synthesize('hola'), AUDIO_BYTES);
  assert.equal(paramVoice.status().state, 'ready');
});

test('tope de audio: exactamente 5 MB pasa y un byte más se rechaza', async () => {
  const exact = new Uint8Array(MAX_AUDIO_BYTES).fill(0x41);
  const exactFetcher = captureFetcher(() => audioResponse(exact));
  const exactVoice = createVoice({ env: validEnv(), fetcher: exactFetcher.fetcher });
  const audio = await exactVoice.synthesize('hola');
  assert.equal(audio.byteLength, MAX_AUDIO_BYTES);
  assert.equal(audio[0], 0x41);
  assert.equal(audio[MAX_AUDIO_BYTES - 1], 0x41);
  assert.equal(exactVoice.status().state, 'ready');

  const tooBig = new Uint8Array(MAX_AUDIO_BYTES + 1).fill(0x42);
  const bigFetcher = captureFetcher(() => audioResponse(tooBig));
  const bigVoice = createVoice({ env: validEnv(), fetcher: bigFetcher.fetcher });
  await assert.rejects(
    () => bigVoice.synthesize('hola'),
    new RegExp(`excede el límite de ${MAX_AUDIO_BYTES} bytes`),
  );
  assert.equal(bigVoice.status().state, 'error');
});

test('audio vacío: nunca marca ready', async () => {
  const emptyBody = captureFetcher(() => audioResponse(new Uint8Array(0)));
  const emptyVoice = createVoice({ env: validEnv(), fetcher: emptyBody.fetcher });
  await assert.rejects(() => emptyVoice.synthesize('hola'), /audio vacío/);
  assert.equal(emptyVoice.status().state, 'error');

  const nullBody = captureFetcher(
    () => new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
  );
  const nullVoice = createVoice({ env: validEnv(), fetcher: nullBody.fetcher });
  await assert.rejects(() => nullVoice.synthesize('hola'), /audio vacío/);
  assert.equal(nullVoice.status().state, 'error');
});

test('un fallo previo no impide que un audio válido posterior deje el status en ready', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const { fetcher } = captureFetcher(() => {
    if (mode === 'fail') {
      return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    return audioResponse();
  });
  const voice = createVoice({ env: validEnv(), fetcher });

  await assert.rejects(() => voice.synthesize('hola'), /HTTP 500/);
  assert.equal(voice.status().state, 'error');

  mode = 'ok';
  assert.deepEqual(await voice.synthesize('hola'), AUDIO_BYTES);
  assert.equal(voice.status().state, 'ready');
});

test('nunca registra la key ni el cuerpo del proveedor', async () => {
  const upstreamBody = 'CUERPO-UPSTREAM-SECRETO';
  const { fetcher } = captureFetcher(
    () => new Response(upstreamBody, { status: 500, headers: { 'content-type': 'text/plain' } }),
  );
  const voice = createVoice({ env: validEnv(), fetcher });

  const logged: string[] = [];
  const spy = (...args: unknown[]): void => {
    logged.push(args.map((value) => String(value)).join(' '));
  };
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  let statusJson = '';
  let message = '';
  console.log = spy;
  console.warn = spy;
  console.error = spy;
  console.info = spy;
  console.debug = spy;
  try {
    const error = await expectRejection(() => voice.synthesize('hola'), /HTTP 500/);
    message = error.message;
    statusJson = JSON.stringify(voice.status());
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.debug = original.debug;
  }

  const everything = `${logged.join('\n')}\n${statusJson}\n${message}`;
  assert.equal(everything.includes(API_KEY), false);
  assert.equal(everything.includes(upstreamBody), false);
});
