/**
 * Célula robot — máquina de estados de objetivos, sólo simulación.
 *
 * Este módulo no habla con hardware. En modo `live` la célula se declara `offline` y todo
 * objetivo se rechaza de forma explícita: nunca se simula un resultado cuando no hay enlace
 * real. El robot jamás produce relaciones ni se auto-verifica; la evidencia viene de una
 * fuente externa (`vision_global`).
 *
 * Protocolo futuro de MCU, heartbeat, watchdog y orden de pruebas humanas:
 * `docs/ROBOT-CONTRACT.md`. Límites acotados en `ROBOT_LIMITS`.
 */
import type { CellDescriptor, Goal, GoalStatus, Mode, Relation, RobotPort } from './contracts.js';

/** Límites documentados de la célula. Todos los historiales están acotados a propósito. */
export const ROBOT_LIMITS = {
  /** Máximo de goals recordados para replay/conflicto de id (FIFO, el más viejo se olvida). */
  maxTrackedGoals: 100,
  /** Mínimo de ms acumulados desde la aceptación antes de pedir verificación. */
  minAwaitingDelayMs: 3_000,
  /** Máximo de ms entre el envío y el deadline del goal. */
  maxGoalDurationMs: 120_000,
  /** Longitud máxima del id de un goal. */
  maxGoalIdLength: 200,
  /** Confianza mínima aceptada como evidencia de verificación. */
  minEvidenceConfidence: 0.85,
  /** Única fuente de evidencia aceptada para verificar. */
  evidenceSource: 'vision_global',
} as const;

const ROBOT_CELL_ID = 'robot';

type GoalState = GoalStatus['state'];

const TERMINAL_STATES: readonly GoalState[] = ['verified', 'failed', 'cancelled'];

interface GoalRecord {
  /** Firma canónica de los parámetros aceptados, para detectar replay y conflicto. */
  readonly signature: string;
  status: GoalStatus;
  readonly acceptedAtMs: number;
  readonly deadlineMs: number;
  /** Momento de entrada a `awaiting_verification`; `null` mientras no ocurra. */
  awaitingAtMs: number | null;
}

type Validation = { ok: true; goal: Goal; deadlineMs: number } | { ok: false; reason: string };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Copia profunda. El estado interno siempre es clonable; el respaldo por JSON existe para
 * echar de vuelta entradas exóticas (funciones, símbolos) sin lanzar en medio de un rechazo.
 */
function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value ?? null)) as T;
  }
}

function isTerminal(state: GoalState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Firma canónica de un goal completo (los siete campos del contrato). */
function signatureOf(goal: Goal): string {
  return JSON.stringify([goal.id, goal.cellId, goal.object, goal.target, goal.relation, goal.deadline, goal.mode]);
}

/** Firma del payload crudo; permite detectar conflicto de id antes de validar el resto. */
function rawSignature(raw: Record<string, unknown>): string {
  return JSON.stringify([raw['id'], raw['cellId'], raw['object'], raw['target'], raw['relation'], raw['deadline'], raw['mode']]);
}

function asRawRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

/**
 * Valida un Goal de entrada de forma estricta. El mensaje de rechazo nunca incluye secretos.
 * `cellId` debe ser la célula robot, el objeto `red_ball`, el objetivo `paper`, la relación `ON`,
 * el modo `simulation` y el deadline un instante futuro a no más de 120 s.
 */
function validateGoal(input: unknown, nowMs: number): Validation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'goal inválido: se esperaba un objeto' };
  }
  const raw = input as Record<string, unknown>;

  const id = raw['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, reason: 'goal inválido: id debe ser una cadena no vacía' };
  }
  if (id.length > ROBOT_LIMITS.maxGoalIdLength) {
    return { ok: false, reason: `goal inválido: id excede ${ROBOT_LIMITS.maxGoalIdLength} caracteres` };
  }
  if (raw['cellId'] !== ROBOT_CELL_ID) {
    return { ok: false, reason: `goal inválido: cellId debe ser "${ROBOT_CELL_ID}"` };
  }
  if (raw['object'] !== 'red_ball') {
    return { ok: false, reason: 'goal inválido: object debe ser "red_ball"' };
  }
  if (raw['target'] !== 'paper') {
    return { ok: false, reason: 'goal inválido: target debe ser "paper"' };
  }
  if (raw['relation'] !== 'ON') {
    return { ok: false, reason: 'goal inválido: relation debe ser "ON"' };
  }
  if (raw['mode'] !== 'simulation') {
    return { ok: false, reason: 'goal inválido: mode debe ser "simulation" en la célula simulada' };
  }

  const deadline = raw['deadline'];
  if (typeof deadline !== 'string' || deadline.length === 0) {
    return { ok: false, reason: 'goal inválido: deadline debe ser una cadena ISO' };
  }
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    return { ok: false, reason: 'goal inválido: deadline no es una fecha válida' };
  }
  if (deadlineMs <= nowMs) {
    return { ok: false, reason: 'goal inválido: deadline debe estar en el futuro' };
  }
  if (deadlineMs - nowMs > ROBOT_LIMITS.maxGoalDurationMs) {
    return { ok: false, reason: `goal inválido: deadline excede ${ROBOT_LIMITS.maxGoalDurationMs} ms` };
  }

  return {
    ok: true,
    goal: {
      id,
      cellId: ROBOT_CELL_ID,
      object: 'red_ball',
      target: 'paper',
      relation: 'ON',
      deadline,
      mode: 'simulation',
    },
    deadlineMs,
  };
}

/**
 * Regla de evidencia independiente: fuente `vision_global`, relación con la misma fuente,
 * confianza suficiente, sujeto/predicado/objeto coincidentes y `observedAt` dentro de la
 * ventana [entrada a awaiting_verification, ahora], nunca futuro.
 */
function isValidEvidence(
  relation: Relation,
  goal: Goal,
  source: string,
  awaitingAtMs: number,
  nowMs: number,
): boolean {
  if (typeof relation !== 'object' || relation === null) return false;
  const candidate = relation;
  if (candidate.source !== source) return false;
  if (
    typeof candidate.confidence !== 'number' ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < ROBOT_LIMITS.minEvidenceConfidence
  ) {
    return false;
  }
  if (candidate.subject !== goal.object) return false;
  if (candidate.predicate !== goal.relation) return false;
  if (candidate.object !== goal.target) return false;
  if (typeof candidate.observedAt !== 'string') return false;
  const observedMs = Date.parse(candidate.observedAt);
  if (!Number.isFinite(observedMs)) return false;
  if (observedMs < awaitingAtMs) return false;
  if (observedMs > nowMs) return false;
  return true;
}

/**
 * Crea la célula robot. `now` inyecta el reloj (ms epoch) para pruebas deterministas;
 * por defecto usa `Date.now`.
 */
export function createRobot(options: { mode: Mode; now?: () => number }): RobotPort {
  const mode: Mode = options.mode;
  const clock = options.now ?? ((): number => Date.now());

  /** Historial acotado: id → registro (FIFO, `maxTrackedGoals`). */
  const records = new Map<string, GoalRecord>();
  let currentId: string | null = null;

  function readNow(explicit?: number): number {
    if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
    return clock();
  }

  /** Desplaza el estado del registro activo y devuelve un clon del nuevo estado. */
  function setState(record: GoalRecord, state: GoalState, atMs: number, reason?: string): GoalStatus {
    const next: GoalStatus = { goal: record.status.goal, state, updatedAt: iso(atMs) };
    if (reason !== undefined) next.reason = reason;
    record.status = next;
    return clone(next);
  }

  /** Estado fallido devuelto a una entrada rechazada; no toca el goal activo. */
  function rejected(raw: Record<string, unknown>, reason: string, atMs: number): GoalStatus {
    return {
      goal: clone(raw as unknown as Goal),
      state: 'failed',
      reason,
      updatedAt: iso(atMs),
    };
  }

  function activeRecord(): GoalRecord | null {
    if (currentId === null) return null;
    return records.get(currentId) ?? null;
  }

  /** Descarta los registros más viejos cuando el historial excede el límite (nunca el activo). */
  function evictOldest(): void {
    while (records.size > ROBOT_LIMITS.maxTrackedGoals) {
      let oldest: string | null = null;
      for (const key of records.keys()) {
        if (key !== currentId) {
          oldest = key;
          break;
        }
      }
      if (oldest === null) return;
      records.delete(oldest);
    }
  }

  function describe(): CellDescriptor {
    return {
      id: ROBOT_CELL_ID,
      parentId: 'organism',
      name: 'Robot Cell',
      capabilities: ['push_object'],
      status: mode === 'simulation' ? 'ready' : 'offline',
      mode,
    };
  }

  function submit(goal: Goal): GoalStatus {
    const atMs = clock();
    const raw = asRawRecord(goal);
    const rawId = typeof raw['id'] === 'string' ? (raw['id'] as string) : null;

    // 1. Modo live: sin enlace físico se falla explícitamente, nunca se simula en silencio.
    if (mode === 'live') {
      return rejected(raw, 'hardware no conectado: el modo live no tiene enlace con la MCU', atMs);
    }

    // 2. Replay del mismo id con los mismos parámetros: devuelve el estado sin reiniciar nada.
    if (rawId !== null) {
      const known = records.get(rawId);
      if (known !== undefined) {
        if (known.signature === rawSignature(raw)) return clone(known.status);
        return rejected(raw, `goal "${rawId}" ya existe con otros parámetros`, atMs);
      }
    }

    // 3. Validación estricta del goal.
    const validation = validateGoal(goal, atMs);
    if (!validation.ok) return rejected(raw, validation.reason, atMs);

    // 4. Un segundo goal mientras hay uno activo no se acepta.
    const active = activeRecord();
    if (active !== null && !isTerminal(active.status.state)) {
      return rejected(raw, `goal "${active.status.goal.id}" sigue activo`, atMs);
    }

    // 5. Aceptación.
    const status: GoalStatus = { goal: validation.goal, state: 'accepted', updatedAt: iso(atMs) };
    records.set(validation.goal.id, {
      signature: signatureOf(validation.goal),
      status,
      acceptedAtMs: atMs,
      deadlineMs: validation.deadlineMs,
      awaitingAtMs: null,
    });
    currentId = validation.goal.id;
    evictOldest();
    return clone(status);
  }

  function tick(now?: number): GoalStatus | null {
    const atMs = readNow(now);
    const record = activeRecord();
    if (record === null) return null;

    const state = record.status.state;
    if (isTerminal(state)) return clone(record.status);

    if (atMs > record.deadlineMs) {
      return setState(record, 'failed', atMs, 'deadline vencido antes de la verificación');
    }
    if (state === 'accepted') {
      return setState(record, 'running', atMs);
    }
    if (state === 'running' && atMs - record.acceptedAtMs >= ROBOT_LIMITS.minAwaitingDelayMs) {
      record.awaitingAtMs = atMs;
      return setState(record, 'awaiting_verification', atMs);
    }
    return clone(record.status);
  }

  function cancel(reason?: string): GoalStatus | null {
    const record = activeRecord();
    if (record === null) return null;
    const state = record.status.state;
    if (isTerminal(state)) return clone(record.status);
    return setState(record, 'cancelled', clock(), reason);
  }

  function verify(relations: Relation[], source: string): GoalStatus | null {
    const atMs = clock();
    const record = activeRecord();
    if (record === null) return null;
    if (record.status.state !== 'awaiting_verification' || record.awaitingAtMs === null) {
      return clone(record.status);
    }
    if (source !== ROBOT_LIMITS.evidenceSource) return clone(record.status);

    const goal = record.status.goal;
    const awaitingAtMs = record.awaitingAtMs;
    const candidates = Array.isArray(relations) ? relations : [];
    const proven = candidates.some((relation) =>
      isValidEvidence(relation, goal, source, awaitingAtMs, atMs),
    );
    if (!proven) return clone(record.status);
    return setState(record, 'verified', atMs);
  }

  function status(): GoalStatus | null {
    const record = activeRecord();
    if (record === null) return null;
    return clone(record.status);
  }

  return { describe, submit, tick, cancel, verify, status };
}
