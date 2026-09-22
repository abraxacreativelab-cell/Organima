/**
 * Pruebas del pilar memoria (src/memory.ts).
 *
 * Cubren el contrato observable del PLAN: reinicio, duplicación concurrente, orden,
 * mutation leakage, aislamiento de contextos, JSON/evento inválido y mezcla de modos.
 * Todo ocurre en directorios temporales propios (fs.mkdtemp) y sin red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_EVENT_LIMIT,
  EVENTS_FILE_NAME,
  MAX_FUTURE_SKEW_MS,
  SNAPSHOT_EVENT_LIMIT,
  createMemory,
} from '../src/memory.js';
import type { MemoryPort, OrganimaEvent, Relation } from '../src/contracts.js';

/* ────────────────────────────── utilidades de prueba ────────────────────────────── */

async function withTempDir<T>(run: (base: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), 'organima-memory-'));
  try {
    return await run(base);
  } finally {
    // Sólo se borra el directorio que esta prueba creó.
    await rm(base, { recursive: true, force: true });
  }
}

let sequence = 0;

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeRelation(overrides: Partial<Relation> = {}): Relation {
  return {
    subject: 'red_ball',
    predicate: 'ON',
    object: 'cup',
    observedAt: iso(-2000),
    source: 'vision_global',
    confidence: 0.9,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<OrganimaEvent> = {}): OrganimaEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    type: 'observation',
    cellId: 'cell-core',
    occurredAt: iso(-1000),
    mode: 'simulation',
    payload: { relations: [makeRelation()] },
    ...overrides,
  };
}

function observation(id: string, relations: Relation[], cellId = 'cell-core'): OrganimaEvent {
  return {
    id,
    type: 'observation',
    cellId,
    occurredAt: iso(-1000),
    mode: 'simulation',
    payload: { relations },
  };
}

async function journalLines(dir: string): Promise<OrganimaEvent[]> {
  const raw = await readFile(join(dir, EVENTS_FILE_NAME), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OrganimaEvent);
}

function relationFor(memory: MemoryPort, subject: string, predicate: string): Relation | undefined {
  return memory.snapshot().relations.find(
    (relation) => relation.subject === subject && relation.predicate === predicate,
  );
}

/* ──────────────────────────────────── pruebas ──────────────────────────────────── */

test('rechaza rutas vacías y crea el directorio cuando falta', async () => {
  await assert.rejects(() => createMemory(''), /non-empty directory path/);
  await assert.rejects(() => createMemory('   '), /non-empty directory path/);
  await assert.rejects(
    () => createMemory(undefined as unknown as string),
    /non-empty directory path/,
  );

  await withTempDir(async (base) => {
    const dir = join(base, 'data', 'nested');
    const memory = await createMemory(dir);
    assert.deepEqual(await readdir(base), ['data']);
    assert.equal((await memory.snapshot()).version, 0);
    assert.deepEqual(await memory.snapshot().events, []);
    assert.deepEqual(await memory.snapshot().relations, []);
  });
});

test('append hace durable el evento antes de proyectarlo y sólo escribe dentro de directory', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    assert.equal(await memory.append(makeEvent({ id: 'durable-1', payload: { relations: [] } })), true);

    // Ya resuelto el append, el byte está en disco (durable antes de la proyección).
    const lines = await journalLines(dir);
    assert.deepEqual(
      lines.map((event) => event.id),
      ['durable-1'],
    );
    // Nada fuera de directory.
    assert.deepEqual(await readdir(base), ['store']);
    assert.deepEqual(await readdir(dir), [EVENTS_FILE_NAME]);
  });
});

test('append devuelve true para id nuevo y false para duplicado sin alterar nada', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    const original = makeEvent({
      id: 'dup-1',
      payload: { relations: [makeRelation({ subject: 'red_ball', object: 'cup' })] },
    });
    assert.equal(await memory.append(original), true);
    const afterFirst = memory.snapshot();

    const duplicate = makeEvent({
      id: 'dup-1',
      payload: { relations: [makeRelation({ subject: 'red_ball', object: 'paper' })] },
    });
    assert.equal(await memory.append(duplicate), false);
    assert.deepEqual(memory.snapshot(), afterFirst);
    assert.deepEqual(
      (await journalLines(dir)).map((event) => event.id),
      ['dup-1'],
    );
  });
});

test('duplicación concurrente: exactamente una escritura gana', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    const event = makeEvent({ id: 'race-1', payload: { relations: [] } });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => memory.append(structuredClone(event))),
    );
    assert.equal(results.filter((value) => value === true).length, 1);
    assert.equal((await memory.snapshot()).version, 1);
    assert.deepEqual(
      (await journalLines(dir)).map((item) => item.id),
      ['race-1'],
    );
  });
});

test('escritor serializado: eventos concurrentes conservan el orden de encolado', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    const ids = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'];
    const results = await Promise.all(
      ids.map((id) => memory.append(makeEvent({ id, payload: { relations: [] } }))),
    );
    assert.deepEqual(results, [true, true, true, true, true]);
    assert.deepEqual(
      memory.snapshot().events.map((event) => event.id),
      ids,
    );
    assert.deepEqual(
      (await journalLines(dir)).map((event) => event.id),
      ids,
    );
  });
});

test('mutation leakage: el store no comparte referencias con entradas ni salidas', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    const originalRelation = makeRelation({ subject: 'red_ball', predicate: 'ON', object: 'cup' });
    const originalObservedAt = originalRelation.observedAt;
    const event = makeEvent({
      id: 'leak-1',
      payload: { relations: [originalRelation], note: { text: 'hola' } },
    });
    assert.equal(await memory.append(event), true);

    // Mutar la entrada original después del append no debe tocar el store.
    (event.payload['relations'] as Relation[])[0]!.object = 'mutated-by-caller';
    (event.payload['note'] as { text: string }).text = 'mutated-by-caller';

    const relationsOf = (snapshot: ReturnType<MemoryPort['snapshot']>): Relation[] =>
      snapshot.events[0]!.payload['relations'] as Relation[];

    let snapshot = memory.snapshot();
    assert.equal(snapshot.relations[0]!.object, 'cup');
    assert.equal(relationsOf(snapshot)[0]!.object, 'cup');
    assert.equal((snapshot.events[0]!.payload['note'] as { text: string }).text, 'hola');

    // Mutar la salida no debe tocar el store.
    snapshot.relations[0]!.object = 'mutated-by-reader';
    snapshot.relations[0]!.confidence = 0;
    relationsOf(snapshot)[0]!.observedAt = '1999-01-01T00:00:00.000Z';
    (snapshot.events[0]!.payload['note'] as { text: string }).text = 'mutated-by-reader';
    snapshot.events[0]!.id = 'mutated-by-reader';

    snapshot = memory.snapshot();
    assert.equal(snapshot.relations[0]!.object, 'cup');
    assert.equal(snapshot.relations[0]!.confidence, 0.9);
    assert.equal(snapshot.relations[0]!.observedAt, originalObservedAt);
    assert.equal(relationsOf(snapshot)[0]!.observedAt, originalObservedAt);
    assert.equal(snapshot.events[0]!.id, 'leak-1');
    assert.equal((snapshot.events[0]!.payload['note'] as { text: string }).text, 'hola');

    // La búsqueda también clona.
    const found = memory.query('vision_global');
    assert.equal(found.relations.length, 1);
    found.relations[0]!.object = 'mutated-by-reader';
    assert.equal(memory.query('vision_global').relations[0]!.object, 'cup');
  });
});

test('snapshot conserva los últimos 100 eventos en orden y todas las relaciones', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    const total = SNAPSHOT_EVENT_LIMIT + 5;
    for (let index = 1; index <= total; index += 1) {
      await memory.append(
        observation(
          `e-${index}`,
          [makeRelation({ subject: `subject-${index}`, observedAt: iso(-total * 1000 + index * 1000) })],
        ),
      );
    }
    const snapshot = memory.snapshot();
    assert.equal(snapshot.version, total);
    assert.equal(snapshot.events.length, SNAPSHOT_EVENT_LIMIT);
    assert.equal(snapshot.events[0]!.id, `e-${total - SNAPSHOT_EVENT_LIMIT + 1}`);
    assert.equal(snapshot.events.at(-1)!.id, `e-${total}`);
    // El grafo no se recorta: una entrada por subject+predicate.
    assert.equal(snapshot.relations.length, total);
  });
});

test('el grafo mantiene la última relación por subject+predicate y una observación vieja no pisa la actual', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);

    await memory.append(
      observation('o-1', [
        makeRelation({
          subject: 'red_ball',
          predicate: 'ON',
          object: 'cup',
          observedAt: '2026-09-20T12:00:00.000Z',
        }),
        makeRelation({
          subject: 'red_ball',
          predicate: 'NEAR',
          object: 'table',
          observedAt: '2026-09-20T12:00:00.000Z',
        }),
      ]),
    );
    assert.equal(relationFor(memory, 'red_ball', 'ON')!.object, 'cup');
    assert.equal(relationFor(memory, 'red_ball', 'NEAR')!.object, 'table');

    // Observación vieja: no pisa.
    await memory.append(
      observation('o-2', [
        makeRelation({
          subject: 'red_ball',
          predicate: 'ON',
          object: 'paper',
          observedAt: '2026-09-20T11:00:00.000Z',
        }),
      ]),
    );
    assert.equal(relationFor(memory, 'red_ball', 'ON')!.object, 'cup');

    // Observación nueva: reemplaza y conserva una sola entrada por clave.
    await memory.append(
      observation('o-3', [
        makeRelation({
          subject: 'red_ball',
          predicate: 'ON',
          object: 'paper',
          observedAt: '2026-09-20T13:00:00.000Z',
        }),
      ]),
    );
    const snapshot = memory.snapshot();
    assert.equal(relationFor(memory, 'red_ball', 'ON')!.object, 'paper');
    assert.equal(snapshot.relations.filter((relation) => relation.subject === 'red_ball').length, 2);
  });
});

test('reinicio: createMemory reconstruye grafo, versión, ids y candado de modo', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const first = await createMemory(dir);
    await first.append(
      observation('r-1', [
        makeRelation({ subject: 'red_ball', object: 'cup', observedAt: '2026-09-20T10:00:00.000Z' }),
      ]),
    );
    await first.append(
      observation('r-2', [
        makeRelation({ subject: 'red_ball', object: 'paper', observedAt: '2026-09-20T11:00:00.000Z' }),
      ], 'cell-b'),
    );
    const before = first.snapshot();

    const second = await createMemory(dir);
    assert.deepEqual(second.snapshot(), before);
    assert.equal(second.snapshot().version, 2);
    assert.equal(relationFor(second, 'red_ball', 'ON')!.object, 'paper');
    // Los ids siguen siendo únicos tras reiniciar.
    assert.equal(await second.append(makeEvent({ id: 'r-1', payload: { relations: [] } })), false);
    // La búsqueda funciona sobre lo reconstruido, sin distinguir mayúsculas.
    assert.equal(second.query('PAPER').relations.length, 1);
    // Los contextos privados no se persisten.
    assert.deepEqual(second.context('cell-b'), []);
    assert.equal((await journalLines(dir)).length, 2);
  });
});

test('el modo se fija en la primera escritura y se rechaza el otro modo', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    const live = makeEvent({ id: 'live-1', mode: 'live', payload: { relations: [] } });
    assert.equal(await memory.append(live), true);

    await assert.rejects(
      memory.append(makeEvent({ id: 'sim-1', mode: 'simulation', payload: { relations: [] } })),
      /locked to mode "live"/,
    );
    assert.equal((await memory.snapshot()).version, 1);
    assert.deepEqual(
      (await journalLines(dir)).map((event) => event.id),
      ['live-1'],
    );

    // El candado persiste tras reiniciar.
    const reloaded = await createMemory(dir);
    const conflict = makeEvent({ id: 'sim-2', mode: 'simulation', payload: { relations: [] } });
    await assert.rejects(reloaded.append(conflict), /locked to mode "live"/);
    assert.equal(
      await reloaded.append(makeEvent({ id: 'live-2', mode: 'live', payload: { relations: [] } })),
      true,
    );

    // El candado también vale cuando el primero fue simulation.
    const otherDir = join(base, 'other');
    const simulated = await createMemory(otherDir);
    assert.equal(
      await simulated.append(makeEvent({ id: 'sim-3', mode: 'simulation', payload: { relations: [] } })),
      true,
    );
    await assert.rejects(
      simulated.append(makeEvent({ id: 'live-3', mode: 'live', payload: { relations: [] } })),
      /locked to mode "simulation"/,
    );
  });
});

test('rechaza eventos inválidos sin escribir ni proyectar', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    assert.equal(await memory.append(makeEvent({ id: 'valid-1', payload: { relations: [] } })), true);
    const before = memory.snapshot();

    const farFuture = new Date(Date.now() + MAX_FUTURE_SKEW_MS * 4).toISOString();
    const circular: Record<string, unknown> = { relations: [] };
    circular['self'] = circular;

    const invalid: Array<[string, OrganimaEvent, RegExp]> = [
      ['id vacío', makeEvent({ id: '' }), /id: must not be empty/],
      ['id en blanco', makeEvent({ id: '   ' }), /id: must not be empty/],
      ['type vacío', makeEvent({ type: '' }), /type: must not be empty/],
      ['cellId vacío', makeEvent({ cellId: '' }), /cellId: must not be empty/],
      ['fecha no ISO', makeEvent({ occurredAt: 'ayer' }), /occurredAt: must be a valid ISO-8601/],
      ['mes imposible', makeEvent({ occurredAt: '2026-13-01T00:00:00.000Z' }), /occurredAt/],
      ['calendario imposible', makeEvent({ occurredAt: '2026-02-30T00:00:00.000Z' }), /occurredAt/],
      ['segundo 60', makeEvent({ occurredAt: '2026-09-22T00:00:60.000Z' }), /occurredAt/],
      ['futuro excesivo', makeEvent({ occurredAt: farFuture }), /in the future/],
      ['mode ausente', makeEvent({ mode: undefined }), /mode/],
      ['mode ajeno', makeEvent({ mode: 'demo' as OrganimaEvent['mode'] }), /mode/],
      [
        'payload arreglo',
        makeEvent({ payload: [] as unknown as Record<string, unknown> }),
        /payload/,
      ],
      [
        'payload escalar',
        makeEvent({ payload: 'texto' as unknown as Record<string, unknown> }),
        /payload/,
      ],
      ['observation sin relations', makeEvent({ payload: {} }), /requires a 'relations' array/],
      ['relations no es arreglo', makeEvent({ payload: { relations: 'x' } }), /must be an array/],
      [
        'relation source vacío',
        observation('bad-1', [makeRelation({ source: '' })]),
        /source: must not be empty/,
      ],
      [
        'relation observedAt vacío',
        observation('bad-2', [makeRelation({ observedAt: '' })]),
        /observedAt: must be a valid ISO-8601/,
      ],
      [
        'relation confidence alta',
        observation('bad-3', [makeRelation({ confidence: 1.5 })]),
        /confidence/,
      ],
      [
        'relation confidence negativa',
        observation('bad-4', [makeRelation({ confidence: -0.01 })]),
        /confidence/,
      ],
      [
        'relation confidence NaN',
        observation('bad-5', [makeRelation({ confidence: Number.NaN })]),
        /confidence/,
      ],
      [
        'relation incompleta',
        observation('bad-6', [
          { subject: 'red_ball', predicate: 'ON', object: 'cup', observedAt: iso(-1), source: 's' } as unknown as Relation,
        ]),
        /confidence/,
      ],
      [
        'relation con campo extra',
        observation('bad-7', [
          { ...makeRelation(), extra: true } as unknown as Relation,
        ]),
        /Unrecognized key/,
      ],
      [
        'payload con undefined',
        makeEvent({ payload: { relations: [], note: undefined } }),
        /not JSON-serializable/,
      ],
      ['payload con BigInt', makeEvent({ payload: { relations: [], big: 1n } }), /not JSON-serializable/],
      [
        'payload con función',
        makeEvent({ payload: { relations: [], fn: () => 1 } }),
        /not JSON-serializable/,
      ],
      ['payload con Infinity', makeEvent({ payload: { relations: [], n: Infinity } }), /non-finite/],
      ['payload circular', makeEvent({ payload: circular }), /circular reference/],
      [
        'payload con Date',
        makeEvent({ payload: { relations: [], when: new Date() } }),
        /not a plain JSON object/,
      ],
      [
        'payload con Map',
        makeEvent({ payload: { relations: [], index: new Map() } }),
        /not a plain JSON object/,
      ],
      [
        'payload con Buffer',
        makeEvent({ payload: { relations: [], raw: Buffer.from('x') } }),
        /not a plain JSON object/,
      ],
    ];

    for (const [label, event, expected] of invalid) {
      await assert.rejects(() => memory.append(event), expected, label);
    }

    // Un evento válido con fecha cercana al futuro se acepta (dentro de la tolerancia).
    const soon = new Date(Date.now() + 60_000).toISOString();
    assert.equal(
      await memory.append(makeEvent({ id: 'soon-1', occurredAt: soon, payload: { relations: [] } })),
      true,
    );

    const snapshot = memory.snapshot();
    assert.equal(snapshot.version, before.version + 1);
    assert.equal(snapshot.events.length, before.events.length + 1);
    assert.deepEqual(
      (await journalLines(dir)).map((event) => event.id),
      ['valid-1', 'soon-1'],
    );
  });
});

test('un evento hidden puede declarar object unknown y otros tipos no alteran relaciones', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);

    const hidden = makeEvent({
      id: 'h-1',
      type: 'hidden',
      payload: {
        object: 'unknown',
        relations: [makeRelation({ object: 'unknown', confidence: 0.3 })],
      },
    });
    assert.equal(await memory.append(hidden), true);
    assert.equal(relationFor(memory, 'red_ball', 'ON')!.object, 'unknown');

    // Un hidden sin relaciones sigue siendo un evento válido.
    assert.equal(
      await memory.append(makeEvent({ id: 'h-2', type: 'hidden', payload: { object: 'unknown' } })),
      true,
    );

    // Un tipo que no es observation/hidden no toca el grafo aunque su payload tenga `relations`.
    const chat = makeEvent({
      id: 'chat-1',
      type: 'chat',
      payload: {
        text: 'hola',
        relations: [makeRelation({ subject: 'ghost', object: 'nowhere' })],
      },
    });
    assert.equal(await memory.append(chat), true);
    const snapshot = memory.snapshot();
    assert.equal(snapshot.relations.length, 1);
    assert.equal(
      snapshot.relations.some((relation) => relation.subject === 'ghost'),
      false,
    );

    // Una observación también puede reportar un objeto unknown (ocultamiento).
    assert.equal(
      await memory.append(
        observation('o-unknown', [
          makeRelation({ subject: 'cup', predicate: 'ON', object: 'unknown' }),
        ]),
      ),
      true,
    );
    assert.equal(relationFor(memory, 'cup', 'ON')!.object, 'unknown');
  });
});

test('query busca sin distinguir mayúsculas en relaciones y eventos y devuelve clones', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    await memory.append(
      makeEvent({
        id: 'q-1',
        cellId: 'cell-core',
        payload: {
          relations: [makeRelation({ subject: 'red_ball', predicate: 'ON', object: 'cup' })],
          note: 'Pelota Roja',
        },
      }),
    );

    const byRelation = memory.query('RED_BALL');
    assert.equal(byRelation.relations.length, 1);
    assert.equal(byRelation.relations[0]!.predicate, 'ON');

    const byEventPayload = memory.query('PELOTA');
    assert.equal(byEventPayload.relations.length, 0);
    assert.equal(byEventPayload.events.length, 1);
    assert.equal(byEventPayload.events[0]!.id, 'q-1');

    const byEventField = memory.query('CELL-CORE');
    assert.equal(byEventField.events.length, 1);

    const byConfidence = memory.query('0.9');
    assert.equal(byConfidence.relations.length, 1);

    const missing = memory.query('inexistente');
    assert.deepEqual(missing, { relations: [], events: [] });

    // Término vacío: nada, sin explotar.
    assert.deepEqual(memory.query('   '), { relations: [], events: [] });

    // Clones: mutar el retorno no cambia el store.
    byRelation.relations[0]!.object = 'mutated';
    byEventPayload.events[0]!.payload['note'] = 'mutated';
    assert.equal(memory.query('RED_BALL').relations[0]!.object, 'cup');
    assert.equal(memory.query('PELOTA').events[0]!.payload['note'], 'Pelota Roja');
  });
});

test('contextos privados: aislados por célula, últimos 20, clonados y fuera del journal', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);

    const cellA = Array.from({ length: CONTEXT_EVENT_LIMIT + 5 }, (_, index) =>
      makeEvent({ id: `a-${index + 1}`, cellId: 'cell-a', payload: { relations: [] } }),
    );
    memory.setContext('cell-a', cellA);
    memory.setContext('cell-b', [
      makeEvent({ id: 'b-1', cellId: 'cell-b', payload: { relations: [] } }),
    ]);

    const contextA = memory.context('cell-a');
    assert.equal(contextA.length, CONTEXT_EVENT_LIMIT);
    assert.equal(contextA[0]!.id, 'a-6');
    assert.equal(contextA.at(-1)!.id, 'a-25');
    assert.deepEqual(
      memory.context('cell-b').map((event) => event.id),
      ['b-1'],
    );
    assert.deepEqual(memory.context('cell-b-unknown'), []);

    // Los contextos privados no son el grafo compartido ni la proyección.
    assert.deepEqual(memory.snapshot().events, []);
    assert.deepEqual(memory.snapshot().relations, []);
    assert.equal(memory.snapshot().version, 0);

    // Clonado.
    contextA[0]!.payload['touched'] = true;
    assert.equal(memory.context('cell-a')[0]!.payload['touched'], undefined);

    // El contexto tampoco comparte referencias con el arreglo del llamador.
    const callerOwned = [
      makeEvent({
        id: 'owned-1',
        cellId: 'cell-own',
        payload: { relations: [makeRelation({ subject: 'red_ball', object: 'cup' })] },
      }),
    ];
    memory.setContext('cell-own', callerOwned);
    (callerOwned[0]!.payload['relations'] as Relation[])[0]!.object = 'mutated-by-caller';
    assert.equal(
      ((memory.context('cell-own')[0]!.payload['relations'] as Relation[])[0]!).object,
      'cup',
    );

    // No persistido: no se crea siquiera el journal.
    assert.deepEqual(await readdir(dir), []);
    const reloaded = await createMemory(dir);
    assert.deepEqual(reloaded.context('cell-a'), []);

    // setContext reemplaza, no acumula.
    memory.setContext('cell-a', [
      makeEvent({ id: 'a-new', cellId: 'cell-a', payload: { relations: [] } }),
    ]);
    assert.deepEqual(
      memory.context('cell-a').map((event) => event.id),
      ['a-new'],
    );

    // cellId inválido se rechaza.
    assert.throws(() => memory.context(''), /cellId/);
    assert.throws(() => memory.setContext('', []), /cellId/);
    assert.throws(() => memory.setContext('cell-a', null as unknown as OrganimaEvent[]), /array/);
  });
});

test('setContext valida todo antes de reemplazar: una entrada inválida no deja estado a medias', async () => {
  await withTempDir(async (base) => {
    const memory = await createMemory(join(base, 'store'));
    const good = makeEvent({ id: 'ctx-good', cellId: 'cell-a', payload: { relations: [] } });
    memory.setContext('cell-a', [good]);
    assert.throws(
      () => memory.setContext('cell-a', [makeEvent(), makeEvent({ id: '' })]),
      /id: must not be empty/,
    );
    assert.deepEqual(
      memory.context('cell-a').map((event) => event.id),
      ['ctx-good'],
    );
  });
});

test('journal corrupto falla explícitamente y nunca se trunca ni se descarta', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    await mkdir(dir, { recursive: true });
    const good = JSON.stringify(makeEvent({ id: 'ok-1', payload: { relations: [] } }));

    const cases: Array<[string, string, RegExp]> = [
      ['json incompleto', `${good}\n{"id":`, /not valid JSON/],
      ['json basura', `${good}\nnope\n`, /not valid JSON/],
      ['línea vacía en medio', `${good}\n\n${good}\n`, /empty line/],
      ['id repetido', `${good}\n${good}\n`, /repeats event id/],
      [
        'modo mezclado',
        `${good}\n${JSON.stringify(
          makeEvent({ id: 'ok-2', mode: 'live', payload: { relations: [] } }),
        )}\n`,
        /mixes mode/,
      ],
      [
        'evento inválido',
        `${good}\n${JSON.stringify({ ...makeEvent(), mode: 'bogus' })}\n`,
        /not a valid OrganimaEvent/,
      ],
      [
        'observación sin relations',
        `${good}\n${JSON.stringify({
          id: 'ok-3',
          type: 'observation',
          cellId: 'cell-core',
          occurredAt: iso(-1),
          mode: 'simulation',
          payload: {},
        })}\n`,
        /not a valid OrganimaEvent/,
      ],
    ];

    for (const [label, content, expected] of cases) {
      await writeFile(join(dir, EVENTS_FILE_NAME), content, 'utf8');
      await assert.rejects(() => createMemory(dir), expected, label);
      // El archivo corrupto queda intacto: ni truncado ni reescrito.
      assert.equal(await readFile(join(dir, EVENTS_FILE_NAME), 'utf8'), content, label);
    }

    // Un journal válido sí carga.
    await writeFile(join(dir, EVENTS_FILE_NAME), `${good}\n`, 'utf8');
    const memory = await createMemory(dir);
    assert.equal(memory.snapshot().version, 1);
  });
});

test('una clave propia __proto__ en el payload se conserva sin tocar el prototipo del clon', async () => {
  await withTempDir(async (base) => {
    const dir = join(base, 'store');
    const memory = await createMemory(dir);
    // Se construye vía JSON.parse para obtener una propiedad propia `__proto__` real.
    const raw = JSON.parse(
      `{"id":"proto-1","type":"observation","cellId":"cell-core","occurredAt":"${iso(-1000)}",` +
        '"mode":"simulation","payload":{"relations":[],"__proto__":{"polluted":true}}}',
    ) as OrganimaEvent;

    assert.equal(await memory.append(raw), true);
    const payload = memory.snapshot().events[0]!.payload;
    assert.deepEqual(payload['__proto__'], { polluted: true });
    assert.equal(Object.getPrototypeOf(payload), Object.prototype);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);

    // Sobrevive al reinicio, porque el journal guarda la clave como dato.
    const reloaded = await createMemory(dir);
    assert.deepEqual(reloaded.snapshot().events[0]!.payload['__proto__'], { polluted: true });
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});
