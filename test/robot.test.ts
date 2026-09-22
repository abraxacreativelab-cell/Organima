/**
 * Pruebas de la célula robot. Todo el tiempo es un reloj falso inyectado: ninguna prueba
 * duerme ni usa el reloj real. Ninguna prueba toca hardware ni red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Goal, Relation, RobotPort } from '../src/contracts.js';
import { ROBOT_LIMITS, createRobot } from '../src/robot.js';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Reloj falso mutable: sólo las pruebas lo hacen avanzar. */
function fakeClock(start = T0) {
  let current = start;
  return {
    now: (): number => current,
    at: (ms: number): number => {
      current = ms;
      return current;
    },
    advance: (ms: number): number => {
      current += ms;
      return current;
    },
  };
}

const GOAL_DEFAULTS: Record<string, unknown> = {
  id: 'goal-1',
  cellId: 'robot',
  object: 'red_ball',
  target: 'paper',
  relation: 'ON',
  deadline: iso(T0 + 60_000),
  mode: 'simulation',
};

/** Construye un goal crudo (permite valores inválidos deliberados en las pruebas). */
function rawGoal(overrides: Record<string, unknown> = {}): Goal {
  return { ...GOAL_DEFAULTS, ...overrides } as unknown as Goal;
}

/** Igual que `rawGoal` pero sin la clave indicada, para probar campos faltantes. */
function goalWithout(key: string): Goal {
  const raw: Record<string, unknown> = { ...GOAL_DEFAULTS };
  delete raw[key];
  return raw as unknown as Goal;
}

function evidence(overrides: Record<string, unknown> = {}): Relation {
  return {
    subject: 'red_ball',
    predicate: 'ON',
    object: 'paper',
    observedAt: iso(T0 + 3_500),
    source: ROBOT_LIMITS.evidenceSource,
    confidence: 0.9,
    ...overrides,
  } as Relation;
}

function simulationRobot() {
  const clock = fakeClock();
  const robot = createRobot({ mode: 'simulation', now: clock.now });
  return { clock, robot };
}

/** Lleva al robot hasta `awaiting_verification` y deja el reloj en T0 + 4000. */
function robotAwaiting(): { clock: ReturnType<typeof fakeClock>; robot: RobotPort; goal: Goal } {
  const { clock, robot } = simulationRobot();
  const goal = rawGoal();
  assert.equal(robot.submit(goal).state, 'accepted');
  clock.advance(ROBOT_LIMITS.minAwaitingDelayMs);
  assert.equal(robot.tick()?.state, 'running');
  assert.equal(robot.tick()?.state, 'awaiting_verification');
  clock.advance(1_000);
  return { clock, robot, goal };
}

describe('identidad de la célula', () => {
  it('describe una célula de simulación lista, con la capacidad push_object', () => {
    const { robot } = simulationRobot();
    const descriptor = robot.describe();
    assert.equal(descriptor.id, 'robot');
    assert.equal(descriptor.parentId, 'organism');
    assert.equal(descriptor.name, 'Robot Cell');
    assert.deepEqual(descriptor.capabilities, ['push_object']);
    assert.equal(descriptor.status, 'ready');
    assert.equal(descriptor.mode, 'simulation');
  });

  it('describe una célula live como offline, sin fingir hardware', () => {
    const robot = createRobot({ mode: 'live', now: fakeClock().now });
    const descriptor = robot.describe();
    assert.equal(descriptor.status, 'offline');
    assert.equal(descriptor.mode, 'live');
  });

  it('devuelve descriptores independientes entre llamadas', () => {
    const { robot } = simulationRobot();
    const first = robot.describe();
    first.capabilities.push('push_object');
    first.id = 'mutado';
    const second = robot.describe();
    assert.equal(second.id, 'robot');
    assert.deepEqual(second.capabilities, ['push_object']);
    assert.notEqual(first, second);
  });
});

describe('aceptación de goals en simulación', () => {
  it('acepta un goal completo y devuelve accepted', () => {
    const { robot } = simulationRobot();
    const status = robot.submit(rawGoal());
    assert.equal(status.state, 'accepted');
    assert.equal(status.reason, undefined);
    assert.equal(status.updatedAt, iso(T0));
    assert.deepEqual(status.goal, rawGoal());
    assert.deepEqual(robot.status(), status);
  });

  it('no existe goal activo antes del primer envío', () => {
    const { robot } = simulationRobot();
    assert.equal(robot.status(), null);
    assert.equal(robot.tick(), null);
    assert.equal(robot.cancel('nada que cancelar'), null);
    assert.equal(robot.verify([evidence()], 'vision_global'), null);
  });

  it('rechaza goals malformados sin tocar el goal activo', () => {
    const cases: Array<{ name: string; goal: Goal }> = [
      { name: 'entrada no objeto', goal: null as unknown as Goal },
      { name: 'id faltante', goal: goalWithout('id') },
      { name: 'id vacío', goal: rawGoal({ id: '   ' }) },
      { name: 'id demasiado largo', goal: rawGoal({ id: 'x'.repeat(ROBOT_LIMITS.maxGoalIdLength + 1) }) },
      { name: 'cellId ajeno', goal: rawGoal({ cellId: 'otra-celula' }) },
      { name: 'object distinto', goal: rawGoal({ object: 'cup' }) },
      { name: 'target distinto', goal: rawGoal({ target: 'cup' }) },
      { name: 'relation distinta', goal: rawGoal({ relation: 'IN' }) },
      { name: 'mode distinto', goal: rawGoal({ mode: 'live' }) },
      { name: 'deadline faltante', goal: goalWithout('deadline') },
      { name: 'deadline inválido', goal: rawGoal({ deadline: 'mañana' }) },
      { name: 'deadline pasado', goal: rawGoal({ deadline: iso(T0 - 1) }) },
      { name: 'deadline justo ahora', goal: rawGoal({ deadline: iso(T0) }) },
      { name: 'deadline mayor a 120 s', goal: rawGoal({ deadline: iso(T0 + ROBOT_LIMITS.maxGoalDurationMs + 1) }) },
    ];

    for (const testCase of cases) {
      const { robot } = simulationRobot();
      const status = robot.submit(testCase.goal);
      assert.equal(status.state, 'failed', `${testCase.name}: debe fallar`);
      assert.equal(typeof status.reason, 'string', `${testCase.name}: debe explicar el rechazo`);
      assert.ok((status.reason ?? '').length > 0, `${testCase.name}: razón no vacía`);
      assert.equal(robot.status(), null, `${testCase.name}: no debe quedar goal activo`);
    }
  });

  it('acepta un deadline a exactamente 120 s y uno justo en el futuro', () => {
    const { robot } = simulationRobot();
    assert.equal(robot.submit(rawGoal({ deadline: iso(T0 + ROBOT_LIMITS.maxGoalDurationMs) })).state, 'accepted');
    robot.cancel('cierre');
    const { robot: second } = simulationRobot();
    assert.equal(second.submit(rawGoal({ deadline: iso(T0 + 1) })).state, 'accepted');
  });

  it('rechaza valores no clonables sin lanzar excepción', () => {
    const { robot } = simulationRobot();
    const status = robot.submit(rawGoal({ object: (): string => 'cup' }));
    assert.equal(status.state, 'failed');
    assert.ok((status.reason ?? '').length > 0);
    assert.equal(robot.status(), null);
  });

  it('ignora campos extra aunque no sean clonables', () => {
    const { robot } = simulationRobot();
    const status = robot.submit(rawGoal({ nota: (): string => 'extra' }));
    assert.equal(status.state, 'accepted');
    assert.equal((status.goal as unknown as Record<string, unknown>)['nota'], undefined);
  });
});

describe('modo live', () => {
  it('falla explícitamente por hardware no conectado y no registra estado', () => {
    const robot = createRobot({ mode: 'live', now: fakeClock().now });
    const status = robot.submit(rawGoal({ mode: 'live' }));
    assert.equal(status.state, 'failed');
    assert.match(status.reason ?? '', /hardware/i);
    assert.equal(robot.status(), null);
    assert.equal(robot.tick(), null);
  });
});

describe('replay e idempotencia de submit', () => {
  it('repetir el mismo id y parámetros devuelve el estado sin reiniciar el cronómetro', () => {
    const { clock, robot } = simulationRobot();
    const goal = rawGoal();
    assert.equal(robot.submit(goal).state, 'accepted');
    clock.advance(1_000);
    assert.equal(robot.tick()?.state, 'running');

    const replayed = robot.submit(goal);
    assert.equal(replayed.state, 'running');
    assert.equal(replayed.updatedAt, iso(T0 + 1_000));

    clock.advance(2_000); // 3000 ms acumulados desde la aceptación original
    assert.equal(robot.tick()?.state, 'awaiting_verification');
  });

  it('replay de un goal terminal devuelve el estado terminal, no reinicia', () => {
    const { robot } = simulationRobot();
    const goal = rawGoal();
    robot.submit(goal);
    assert.equal(robot.cancel('fin')?.state, 'cancelled');
    const replayed = robot.submit(goal);
    assert.equal(replayed.state, 'cancelled');
    assert.equal(replayed.reason, 'fin');
  });

  it('rechaza el mismo id con parámetros distintos', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1_000);
    assert.equal(robot.tick()?.state, 'running');

    const conflict = robot.submit(rawGoal({ deadline: iso(T0 + 90_000) }));
    assert.equal(conflict.state, 'failed');
    assert.match(conflict.reason ?? '', /ya existe/);
    assert.equal(robot.status()?.state, 'running');
  });

  it('rechaza un segundo goal mientras hay uno activo', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1_000);
    robot.tick();

    const second = robot.submit(rawGoal({ id: 'goal-2' }));
    assert.equal(second.state, 'failed');
    assert.match(second.reason ?? '', /sigue activo/);
    assert.equal(robot.status()?.goal.id, 'goal-1');

    robot.cancel('cierre');
    assert.equal(robot.submit(rawGoal({ id: 'goal-2' })).state, 'accepted');
  });

  it('copia en profundidad tanto la entrada como la salida', () => {
    const { robot } = simulationRobot();
    const input = rawGoal();
    const submitted = robot.submit(input);
    (input as unknown as { id: string }).id = 'mutado';
    submitted.goal.id = 'mutado-2';
    submitted.state = 'failed';

    const current = robot.status();
    assert.ok(current !== null);
    assert.equal(current.goal.id, 'goal-1');
    assert.equal(current.state, 'accepted');

    const a = robot.status();
    const b = robot.status();
    assert.ok(a !== null && b !== null);
    assert.notEqual(a, b);
    assert.notEqual(a.goal, b.goal);
  });
});

describe('máquina de estados y reloj', () => {
  it('accepted pasa a running en el primer tick', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1);
    assert.equal(robot.tick()?.state, 'running');
  });

  it('permanece running hasta acumular 3 segundos desde la aceptación', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1_000);
    assert.equal(robot.tick()?.state, 'running');
    clock.at(T0 + ROBOT_LIMITS.minAwaitingDelayMs - 1);
    assert.equal(robot.tick()?.state, 'running');
    clock.at(T0 + ROBOT_LIMITS.minAwaitingDelayMs);
    assert.equal(robot.tick()?.state, 'awaiting_verification');
  });

  it('respeta el parámetro now de tick aunque el reloj inyectado no avance', () => {
    const robot = createRobot({ mode: 'simulation', now: () => T0 });
    robot.submit(rawGoal());
    assert.equal(robot.tick(T0)?.state, 'running');
    assert.equal(robot.tick(T0 + ROBOT_LIMITS.minAwaitingDelayMs)?.state, 'awaiting_verification');
    assert.equal(robot.tick(T0 + ROBOT_LIMITS.minAwaitingDelayMs)?.state, 'awaiting_verification');
  });

  it('repite el estado sin cambios cuando el tick no provoca transición', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1_000);
    const first = robot.tick();
    const second = robot.tick();
    assert.deepEqual(first, second);
    assert.equal(first?.updatedAt, iso(T0 + 1_000));
  });

  it('vence el deadline en running y en awaiting_verification', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal()); // deadline T0 + 60 s
    clock.advance(1_000);
    assert.equal(robot.tick()?.state, 'running');
    clock.at(T0 + 60_001);
    const failed = robot.tick();
    assert.equal(failed?.state, 'failed');
    assert.match(failed?.reason ?? '', /deadline vencido/);

    const { clock: clock2, robot: robot2 } = simulationRobot();
    robot2.submit(rawGoal());
    clock2.advance(ROBOT_LIMITS.minAwaitingDelayMs);
    robot2.tick();
    robot2.tick();
    assert.equal(robot2.status()?.state, 'awaiting_verification');
    clock2.at(T0 + 60_001);
    assert.equal(robot2.tick()?.state, 'failed');
  });

  it('no vence justo en el deadline: se considera vencido sólo al superarlo', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal({ deadline: iso(T0 + 1_000) }));
    clock.at(T0 + 1_000);
    assert.equal(robot.tick()?.state, 'running');
  });

  it('no cambia un estado terminal aunque el deadline ya pasó', () => {
    const { clock, robot } = robotAwaiting();
    assert.equal(robot.verify([evidence()], 'vision_global')?.state, 'verified');
    clock.at(T0 + 120_000);
    assert.equal(robot.tick()?.state, 'verified');
    assert.equal(robot.status()?.state, 'verified');
  });

  it('acepta un goal nuevo después de que el anterior terminó', () => {
    const { clock, robot } = robotAwaiting();
    robot.verify([evidence()], 'vision_global');
    clock.advance(1_000);
    assert.equal(robot.submit(rawGoal({ id: 'goal-2' })).state, 'accepted');
  });
});

describe('cancelación', () => {
  it('cancelar terminaliza accepted y es idempotente', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    const cancelled = robot.cancel('parada local');
    assert.equal(cancelled?.state, 'cancelled');
    assert.equal(cancelled?.reason, 'parada local');
    assert.equal(cancelled?.updatedAt, iso(T0));

    const again = robot.cancel('otra razón');
    assert.equal(again?.state, 'cancelled');
    assert.equal(again?.reason, 'parada local');
    assert.equal(again?.updatedAt, iso(T0));

    clock.at(T0 + 120_000);
    assert.equal(robot.tick()?.state, 'cancelled');
    assert.equal(robot.status()?.state, 'cancelled');
  });

  it('cancelar terminaliza running y awaiting_verification', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1_000);
    assert.equal(robot.tick()?.state, 'running');
    assert.equal(robot.cancel()?.state, 'cancelled');

    const { clock: clock2, robot: robot2 } = robotAwaiting();
    assert.equal(robot2.cancel('fin de ventana')?.state, 'cancelled');
    clock2.advance(1_000);
    assert.equal(robot2.tick()?.state, 'cancelled');
  });

  it('no revierte un resultado verificado', () => {
    const { robot } = robotAwaiting();
    robot.verify([evidence()], 'vision_global');
    assert.equal(robot.cancel('tarde')?.state, 'verified');
  });

  it('devuelve null sin goal', () => {
    const { robot } = simulationRobot();
    assert.equal(robot.cancel(), null);
  });
});

describe('verificación independiente', () => {
  it('verifica con evidencia válida de vision_global', () => {
    const { robot } = robotAwaiting();
    const status = robot.verify([evidence()], 'vision_global');
    assert.equal(status?.state, 'verified');
    assert.equal(status?.reason, undefined);
    assert.equal(status?.updatedAt, iso(T0 + 4_000));
    assert.equal(robot.status()?.state, 'verified');
  });

  it('sólo verifica desde awaiting_verification', () => {
    const { clock, robot } = simulationRobot();
    robot.submit(rawGoal());
    clock.advance(1_000);
    assert.equal(robot.tick()?.state, 'running');
    const status = robot.verify([evidence()], 'vision_global');
    assert.equal(status?.state, 'running');
    assert.equal(robot.status()?.state, 'running');
  });

  it('exige que la fuente declarada sea vision_global', () => {
    const { robot } = robotAwaiting();
    assert.equal(robot.verify([evidence()], 'camera_local')?.state, 'awaiting_verification');
    assert.equal(robot.verify([], 'vision_global')?.state, 'awaiting_verification');
  });

  it('exige que la relación venga de vision_global', () => {
    const { robot } = robotAwaiting();
    assert.equal(
      robot.verify([evidence({ source: 'camera_local' })], 'vision_global')?.state,
      'awaiting_verification',
    );
  });

  it('exige confianza mayor o igual a 0.85', () => {
    const { robot } = robotAwaiting();
    assert.equal(robot.verify([evidence({ confidence: 0.84 })], 'vision_global')?.state, 'awaiting_verification');
    assert.equal(robot.verify([evidence({ confidence: 0.85 })], 'vision_global')?.state, 'verified');
  });

  it('exige sujeto, predicado y objeto coincidentes', () => {
    for (const bad of [{ subject: 'cup' }, { predicate: 'IN' }, { object: 'cup' }]) {
      const { robot } = robotAwaiting();
      assert.equal(
        robot.verify([evidence(bad)], 'vision_global')?.state,
        'awaiting_verification',
        `evidencia con ${JSON.stringify(bad)} no debe verificar`,
      );
    }
  });

  it('rechaza evidencia anterior a la entrada en awaiting_verification', () => {
    const { robot } = robotAwaiting();
    assert.equal(
      robot.verify([evidence({ observedAt: iso(T0 + 2_999) })], 'vision_global')?.state,
      'awaiting_verification',
    );
  });

  it('rechaza evidencia con observedAt futuro', () => {
    const { robot } = robotAwaiting();
    assert.equal(
      robot.verify([evidence({ observedAt: iso(T0 + 4_001) })], 'vision_global')?.state,
      'awaiting_verification',
    );
  });

  it('rechaza observedAt inválido o ausente', () => {
    const { robot } = robotAwaiting();
    assert.equal(robot.verify([evidence({ observedAt: 'ayer' })], 'vision_global')?.state, 'awaiting_verification');
    const { robot: second } = robotAwaiting();
    assert.equal(second.verify([evidence({ observedAt: 123 })], 'vision_global')?.state, 'awaiting_verification');
  });

  it('evidencia mala no cambia el estado y la buena posterior sí verifica', () => {
    const { robot } = robotAwaiting();
    assert.equal(robot.verify([evidence({ subject: 'cup' })], 'vision_global')?.state, 'awaiting_verification');
    assert.equal(robot.verify([evidence()], 'vision_global')?.state, 'verified');
  });

  it('acepta si al menos una relación de la lista es válida', () => {
    const { robot } = robotAwaiting();
    const status = robot.verify([evidence({ subject: 'cup' }), evidence()], 'vision_global');
    assert.equal(status?.state, 'verified');
  });

  it('no verifica dos veces: repetir verify devuelve verified sin cambios', () => {
    const { robot } = robotAwaiting();
    const verified = robot.verify([evidence()], 'vision_global');
    const repeated = robot.verify([evidence()], 'vision_global');
    assert.equal(repeated?.state, 'verified');
    assert.deepEqual(repeated, verified);
  });

  it('devuelve null sin goal', () => {
    const { robot } = simulationRobot();
    assert.equal(robot.verify([evidence()], 'vision_global'), null);
  });
});

describe('historial acotado', () => {
  it('olvida los ids más viejos cuando excede el límite documentado', () => {
    const { robot } = simulationRobot();
    const total = ROBOT_LIMITS.maxTrackedGoals + 1;
    for (let index = 0; index < total; index += 1) {
      assert.equal(robot.submit(rawGoal({ id: `g-${index}` })).state, 'accepted');
      assert.equal(robot.cancel('cierre')?.state, 'cancelled');
    }
    // `g-0` ya salió del historial: se trata como goal nuevo, no como replay.
    const recycled = robot.submit(rawGoal({ id: 'g-0' }));
    assert.equal(recycled.state, 'accepted');
    // El id más reciente sigue recordado como replay de su estado terminal.
    const replayed = robot.submit(rawGoal({ id: 'g-0' }));
    assert.equal(replayed.state, 'accepted');
    assert.equal(replayed.updatedAt, iso(T0));
  });

  it('declara límites documentados positivos', () => {
    assert.ok(ROBOT_LIMITS.maxTrackedGoals > 0);
    assert.ok(ROBOT_LIMITS.minAwaitingDelayMs > 0);
    assert.ok(ROBOT_LIMITS.maxGoalDurationMs > ROBOT_LIMITS.minAwaitingDelayMs);
    assert.ok(ROBOT_LIMITS.minEvidenceConfidence > 0 && ROBOT_LIMITS.minEvidenceConfidence <= 1);
    assert.equal(ROBOT_LIMITS.evidenceSource, 'vision_global');
  });
});
