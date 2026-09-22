/**
 * Pruebas del adaptador Jev (`src/attention.ts`) con `fetch` simulado: sin red real y sin
 * credenciales. Cubren contrato, umbral, probabilidades, validación de entrada, clasificación de
 * errores, timeout y ausencia de secretos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createJevAttention, JEV_THRESHOLD } from '../src/attention.js';

type Probabilities = { notify: number; research: number; escalate: number };
type RecordedCall = { url: string; headers: Record<string, string>; body: any };

const KEY = 'vck_test-key-1234567890';

function answersPayload(probabilities: Probabilities) {
  return {
    answers: {
      notify: { type: 'boolean', probability: probabilities.notify },
      research: { type: 'boolean', probability: probabilities.research },
      escalate: { type: 'boolean', probability: probabilities.escalate },
    },
  };
}

/** `fetch` simulado que registra la petición y responde un JSON fijo. */
function recordingFetch(payload: unknown, status = 200): { calls: RecordedCall[]; fetcher: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return Response.json(payload, { status });
  };
  return { calls, fetcher };
}

function making(env: Record<string, string | undefined>, fetcher: typeof fetch, timeoutMs?: number) {
  return createJevAttention({ env, fetcher, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'sin-code';
  }
  return 'sin-error';
}

test('decide envía el payload real de Jev y conserva las probabilidades por pregunta', async () => {
  const probabilities: Probabilities = { notify: 0.9, research: 0.2, escalate: 0.1 };
  const { calls, fetcher } = recordingFetch(answersPayload(probabilities));
  const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher);

  const before = jev.status();
  assert.equal(before.state, 'untested');
  assert.equal(before.configured, true);
  assert.equal(before.model, 'typesafe-ai/jev');
  assert.equal(before.name, 'Jev · Vercel AI Gateway');

  const decision = await jev.decide('Cambió la temperatura del salón');

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/evaluation-model'), calls[0].url);
  assert.equal(calls[0].headers['ai-model-id'], 'typesafe-ai/jev');
  assert.equal(calls[0].body.state, 'Cambió la temperatura del salón');
  assert.deepEqual(Object.keys(calls[0].body.questions).sort(), ['escalate', 'notify', 'research']);
  for (const question of Object.values<any>(calls[0].body.questions)) {
    assert.equal(question.type, 'boolean');
    assert.equal(typeof question.instructions, 'string');
    assert.ok(question.instructions.length > 0);
  }

  assert.deepEqual(decision.probabilities, probabilities);
  assert.equal(decision.threshold, JEV_THRESHOLD);
  assert.equal(decision.provider, 'jev');
  assert.equal(decision.mode, 'live');
  assert.equal(decision.notify, true);
  assert.equal(decision.research, false);
  assert.equal(decision.escalate, false);
  assert.equal(decision.probability, 0.9);
  assert.equal(jev.status().state, 'ready');
});

test('el umbral es inclusivo en 0.7 y exclusivo en 0.69', async () => {
  for (const [probability, expected] of [[0.7, true], [0.69, false]] as const) {
    const { fetcher } = recordingFetch(answersPayload({ notify: probability, research: probability, escalate: probability }));
    const decision = await making({ AI_GATEWAY_API_KEY: KEY }, fetcher).decide('estado');
    assert.equal(decision.threshold, 0.7);
    assert.equal(decision.notify, expected, `notify con p=${probability}`);
    assert.equal(decision.research, expected, `research con p=${probability}`);
    assert.equal(decision.escalate, expected, `escalate con p=${probability}`);
  }
});

test('probability es el máximo de las tres, no una confianza conjunta', async () => {
  const { fetcher } = recordingFetch(answersPayload({ notify: 0.2, research: 0.5, escalate: 0.9 }));
  const decision = await making({ AI_GATEWAY_API_KEY: KEY }, fetcher).decide('estado');
  assert.equal(decision.probability, 0.9);
});

test('sin clave no hay red y el estado es unconfigured', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json(answersPayload({ notify: 0.1, research: 0.1, escalate: 0.1 }));
  };
  for (const env of [{}, { AI_GATEWAY_API_KEY: '' }, { AI_GATEWAY_API_KEY: '   ' }]) {
    const jev = making(env, fetcher);
    const status = jev.status();
    assert.equal(status.state, 'unconfigured');
    assert.equal(status.configured, false);
    assert.equal(status.model, 'typesafe-ai/jev');
    assert.equal(await codeOf(jev.decide('hola')), 'unconfigured');
  }
  assert.equal(calls, 0);
});

test('entrada inválida se rechaza sin tocar la red', async () => {
  const { calls, fetcher } = recordingFetch(answersPayload({ notify: 0.1, research: 0.1, escalate: 0.1 }));
  const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher);

  assert.equal(await codeOf(jev.decide('')), 'invalid_input');
  assert.equal(await codeOf(jev.decide('   ')), 'invalid_input');
  assert.equal(await codeOf(jev.decide('x'.repeat(12001))), 'invalid_input');
  assert.equal(await codeOf(jev.decide(123 as unknown as string)), 'invalid_input');
  assert.equal(calls.length, 0);
  assert.equal(jev.status().state, 'untested');

  for (const timeoutMs of [0, 15001, 1.5, Number.NaN]) {
    const bad = making({ AI_GATEWAY_API_KEY: KEY }, fetcher, timeoutMs);
    assert.equal(await codeOf(bad.decide('hola')), 'invalid_input', `timeoutMs=${timeoutMs}`);
  }
  assert.equal(calls.length, 0);

  const ok = await jev.decide('x'.repeat(12000));
  assert.equal(ok.provider, 'jev');
  assert.equal(calls.length, 1);
});

test('probabilidad ausente, no numérica o fuera de rango es invalid_response', async () => {
  const cases: Array<[string, unknown]> = [
    ['fuera de rango', 1.5],
    ['negativa', -0.1],
    ['cadena', '0.5'],
    ['nula', null],
    ['booleana', true],
  ];
  for (const [label, value] of cases) {
    const { fetcher } = recordingFetch(
      answersPayload({ notify: value as number, research: 0.1, escalate: 0.1 }),
    );
    const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher);
    assert.equal(await codeOf(jev.decide('estado')), 'invalid_response', label);
    assert.equal(jev.status().state, 'error', label);
  }
});

test('falta una respuesta o su tipo no es booleano y es invalid_response', async () => {
  const missing = {
    answers: {
      notify: { type: 'boolean', probability: 0.9 },
      research: { type: 'boolean', probability: 0.1 },
    },
  };
  const wrongType = {
    answers: {
      notify: { type: 'score', score: 1 },
      research: { type: 'boolean', probability: 0.1 },
      escalate: { type: 'boolean', probability: 0.2 },
    },
  };
  const withoutProbability = {
    answers: {
      notify: { type: 'boolean' },
      research: { type: 'boolean', probability: 0.1 },
      escalate: { type: 'boolean', probability: 0.2 },
    },
  };
  for (const payload of [missing, wrongType, withoutProbability]) {
    const { fetcher, calls } = recordingFetch(payload);
    assert.equal(await codeOf(making({ AI_GATEWAY_API_KEY: KEY }, fetcher).decide('estado')), 'invalid_response');
    assert.equal(calls.length, 1, 'un intento por llamada, sin reintentos');
  }
});

test('los errores HTTP se clasifican con código estable y sin reintentos', async () => {
  const cases: Array<[number, unknown, string]> = [
    [401, { error: { message: 'unauthorized', type: 'authentication_error' } }, 'gateway_auth'],
    [403, { error: { message: 'AI Gateway requires a valid credit card on file', type: 'forbidden' } }, 'gateway_billing'],
    [429, { error: { message: 'rate limit exceeded', type: 'rate_limit_exceeded' } }, 'gateway_rate_limit'],
    [500, { error: { message: 'boom', type: 'internal_server_error' } }, 'gateway_unavailable'],
  ];
  for (const [status, payload, expected] of cases) {
    const { fetcher, calls } = recordingFetch(payload, status);
    const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher);
    assert.equal(await codeOf(jev.decide('estado')), expected, `HTTP ${status}`);
    assert.equal(calls.length, 1, `HTTP ${status} debe hacer exactamente una petición`);
    assert.equal(jev.status().state, 'error');
  }
});

test('un 403 sin texto de facturación es gateway_auth, no un fallback silencioso', async () => {
  const { fetcher } = recordingFetch({ error: { message: 'forbidden', type: 'forbidden' } }, 403);
  assert.equal(await codeOf(making({ AI_GATEWAY_API_KEY: KEY }, fetcher).decide('estado')), 'gateway_auth');
});

test('el timeout aborta la petición y se reporta como timeout', async () => {
  let sawSignal = false;
  const fetcher: typeof fetch = async (_input, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (signal) sawSignal = true;
    return await new Promise<Response>((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('el mock nunca recibió el abort')), 5000);
      const abort = () => {
        clearTimeout(guard);
        reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      };
      if (!signal) {
        clearTimeout(guard);
        reject(new Error('la petición no llevaba señal de aborto'));
        return;
      }
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher, 30);
  assert.equal(await codeOf(jev.decide('estado')), 'timeout');
  assert.equal(sawSignal, true);
  assert.equal(jev.status().state, 'error');
});

test('el estado se recupera de error a ready en la siguiente llamada', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ error: { message: 'boom', type: 'internal_server_error' } }, { status: 500 });
    }
    return Response.json(answersPayload({ notify: 0.9, research: 0.1, escalate: 0.1 }));
  };
  const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher);
  assert.equal(jev.status().state, 'untested');
  assert.equal(await codeOf(jev.decide('estado')), 'gateway_unavailable');
  assert.equal(jev.status().state, 'error');
  const decision = await jev.decide('estado');
  assert.equal(jev.status().state, 'ready');
  assert.equal(decision.notify, true);
  assert.equal(calls, 2);
});

test('ni la clave ni la respuesta cruda aparecen en errores, stack ni estado', async () => {
  const raw = 'AI Gateway requires a valid credit card on file';
  const { fetcher } = recordingFetch({ error: { message: raw, type: 'forbidden' } }, 403);
  const jev = making({ AI_GATEWAY_API_KEY: KEY }, fetcher);

  let failure: JevAttentionError | undefined;
  try {
    await jev.decide('estado');
  } catch (error) {
    failure = error as JevAttentionError;
  }
  assert.ok(failure, 'debía fallar');
  assert.equal(failure.code, 'gateway_billing');
  assert.equal(failure.statusCode, 403);
  assert.equal(failure.cause, undefined);
  assert.equal((failure as unknown as Record<string, unknown>).response, undefined);
  for (const text of [JSON.stringify(failure), inspect(failure), String(failure.stack ?? ''), failure.message]) {
    assert.ok(!text.includes(KEY), 'la clave no debe filtrarse');
    assert.ok(!text.includes(raw), 'la respuesta cruda no debe filtrarse');
  }

  const status = jev.status();
  for (const text of [JSON.stringify(status), inspect(status), status.detail ?? '']) {
    assert.ok(!text.includes(KEY), 'la clave no debe filtrarse en el estado');
  }
});

type JevAttentionError = { code: string; statusCode?: number; message: string; stack?: string; cause?: unknown };
