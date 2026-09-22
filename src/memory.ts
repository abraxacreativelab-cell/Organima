/**
 * Memoria de Organima (pilar `memoria`).
 *
 * Tres niveles descritos en docs/ARCHITECTURE.md: contextos privados por célula, grafo
 * compartido derivado de eventos persistidos y conocimiento estable versionado (fuera de este
 * módulo). `snapshot()` es la proyección rápida del grafo ("World State"), no una cuarta memoria.
 *
 * Garantías de este módulo:
 * - Un único escritor serializado; el evento queda durable en `directory/events.jsonl` ANTES de
 *   actualizar la proyección en memoria.
 * - `createMemory` reconstruye grafo, versión, ids y modo desde el journal al reiniciar.
 * - Un journal corrupto falla explícitamente: nunca se trunca ni se pierde en silencio.
 * - Las salidas (`snapshot`, `context`, `query`) son clones profundos.
 * - El modo (`live` / `simulation`) se fija con la primera escritura y no se mezcla en el store.
 * - Este módulo no escribe nada más que `directory/events.jsonl` y nunca toca `knowledge/`.
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { GraphSnapshot, MemoryPort, Mode, OrganimaEvent, Relation } from './contracts.js';

/** Nombre del journal dentro de `directory`. Es el único archivo que este módulo escribe. */
export const EVENTS_FILE_NAME = 'events.jsonl';
/** `snapshot()` devuelve como máximo los últimos 100 eventos aceptados. */
export const SNAPSHOT_EVENT_LIMIT = 100;
/** `context(cellId)` conserva como máximo los últimos 20 eventos privados de esa célula. */
export const CONTEXT_EVENT_LIMIT = 20;
/** Tolerancia de reloj para `occurredAt`: más de 5 minutos en el futuro se rechaza. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Tipos de evento que aportan relaciones al grafo. Un evento `hidden` puede usar `object: 'unknown'`. */
export const RELATION_EVENT_TYPES: readonly string[] = ['observation', 'hidden'];
const RELATION_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(RELATION_EVENT_TYPES);

/* ─────────────────────────── validadores estrictos ─────────────────────────── */

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Valida una fecha ISO-8601 con calendario real (rechaza `2026-02-30`, `2026-13-01`, `:60`, etc.).
 * Se acepta desplazamiento horario explícito (`Z` o `±hh:mm`).
 */
export function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8] ?? '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return false;
  }
  if (offset !== 'Z') {
    const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (offsetMatch === null) return false;
    if (Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty' });

const isoDateTimeString = z
  .string()
  .refine(isIsoDateTime, { message: 'must be a valid ISO-8601 date-time' });

const relationSchema = z
  .object({
    subject: nonEmptyString,
    predicate: nonEmptyString,
    object: nonEmptyString,
    observedAt: isoDateTimeString,
    source: nonEmptyString,
    confidence: z.number().min(0).max(1),
  })
  .strict();

// El payload se valida con un validador propio (abajo) para no perder claves legítimas como
// `__proto__`, que `z.record` descartaría en silencio.
const eventSchema = z.object({
  id: nonEmptyString,
  type: nonEmptyString,
  cellId: nonEmptyString,
  occurredAt: isoDateTimeString,
  mode: z.enum(['live', 'simulation']),
  payload: z.unknown(),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/** Un payload/evento sólo es persistible si es representable en JSON sin pérdida silenciosa. */
function assertJsonSerializable(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${path} contains a circular reference`);
    seen.add(value);
    value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      // Date, Map, Set, Buffer, instancias de clase: JSON los deforma o los pierde.
      throw new Error(`${path} is not a plain JSON object`);
    }
    if (seen.has(value)) throw new Error(`${path} contains a circular reference`);
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      assertJsonSerializable(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new Error(`${path} is not JSON-serializable (${typeof value})`);
}

function deepCloneJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepCloneJson(item)) as unknown as T;
  // `defineProperty` conserva claves propias como `__proto__` sin tocar el prototipo del clon.
  const clone = Object.create(Object.getPrototypeOf(value) as object | null) as Record<
    string,
    unknown
  >;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(clone, key, {
      value: deepCloneJson(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return clone as unknown as T;
}

interface PreparedEvent {
  event: OrganimaEvent;
  relations: Relation[];
}

/**
 * Valida un `OrganimaEvent` completo y extrae sus relaciones cuando el tipo las aporta.
 * Lanza `Error` con mensaje sin secretos si el evento no es válido.
 */
function prepareOrganimaEvent(input: unknown, now: number): PreparedEvent {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid OrganimaEvent: ${describeIssues(parsed.error)}`);
  }
  const { id, type, cellId, occurredAt, mode, payload } = parsed.data;
  // El evento emitido es siempre el del contrato: seis campos, con el payload tal cual llegó.
  const event: OrganimaEvent = {
    id,
    type,
    cellId,
    occurredAt,
    mode,
    payload: payload as Record<string, unknown>,
  };
  const occurredAtMs = Date.parse(event.occurredAt);
  if (occurredAtMs - now > MAX_FUTURE_SKEW_MS) {
    throw new Error(
      `invalid OrganimaEvent: occurredAt is more than ${MAX_FUTURE_SKEW_MS} ms in the future`,
    );
  }
  // El payload debe ser un objeto plano antes de leer sus campos.
  if (
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error('invalid OrganimaEvent: payload must be a plain JSON object');
  }
  relationsFromPayload(event); // valida antes de clonar (una entrada circular no se clona)
  assertJsonSerializable(event, 'event', new Set<object>());
  // El store nunca comparte referencias con quien llamó: se apropia de una copia profunda.
  const owned = deepCloneJson(event);
  return { event: owned, relations: relationsFromPayload(owned) };
}

/**
 * Sólo `observation` y `hidden` aportan relaciones. `observation` exige `payload.relations`
 * (validado estrictamente); `hidden` puede declarar `object: 'unknown'` y puede omitir relaciones.
 * Cualquier otro campo del payload no altera el grafo.
 */
function relationsFromPayload(event: OrganimaEvent): Relation[] {
  if (!RELATION_EVENT_TYPE_SET.has(event.type)) return [];
  const raw = event.payload['relations'];
  if (raw === undefined) {
    if (event.type === 'observation') {
      throw new Error("invalid OrganimaEvent: observation payload requires a 'relations' array");
    }
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error('invalid OrganimaEvent: payload.relations must be an array of Relation');
  }
  return raw.map((candidate, index) => {
    const parsed = relationSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `invalid OrganimaEvent: payload.relations[${index}] ${describeIssues(parsed.error)}`,
      );
    }
    return parsed.data as Relation;
  });
}

/* ─────────────────────────────── estado interno ─────────────────────────────── */

interface MemoryState {
  mode: Mode | null;
  ids: Set<string>;
  events: OrganimaEvent[];
  relations: Map<string, Relation>;
  contexts: Map<string, OrganimaEvent[]>;
  version: number;
}

function emptyState(): MemoryState {
  return {
    mode: null,
    ids: new Set<string>(),
    events: [],
    relations: new Map<string, Relation>(),
    contexts: new Map<string, OrganimaEvent[]>(),
    version: 0,
  };
}

function relationKey(relation: Relation): string {
  return `${relation.subject}\u0000${relation.predicate}`;
}

function applyPrepared(state: MemoryState, prepared: PreparedEvent): void {
  state.mode = prepared.event.mode;
  state.ids.add(prepared.event.id);
  state.events.push(prepared.event);
  state.version += 1;
  for (const relation of prepared.relations) {
    const key = relationKey(relation);
    const current = state.relations.get(key);
    // Una observación vieja nunca pisa a la actual; el empate lo gana la llegada más reciente.
    if (current !== undefined && Date.parse(current.observedAt) > Date.parse(relation.observedAt)) {
      continue;
    }
    state.relations.set(key, relation);
  }
}

function requireDirectory(directory: unknown): string {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new Error('createMemory requires a non-empty directory path');
  }
  return resolve(directory);
}

function requireCellId(cellId: unknown): string {
  if (typeof cellId !== 'string' || cellId.trim().length === 0) {
    throw new Error('cellId must be a non-empty string');
  }
  return cellId;
}

function relationText(relation: Relation): string {
  return [
    relation.subject,
    relation.predicate,
    relation.object,
    relation.observedAt,
    relation.source,
    String(relation.confidence),
  ]
    .join('\n')
    .toLowerCase();
}

function eventText(event: OrganimaEvent): string {
  return [
    event.id,
    event.type,
    event.cellId,
    event.occurredAt,
    event.mode,
    JSON.stringify(event.payload),
  ]
    .join('\n')
    .toLowerCase();
}

/* ─────────────────────────── carga y escritura durable ─────────────────────────── */

/**
 * Reconstruye el estado desde el journal. Un journal ausente es un store vacío; un journal
 * corrupto (JSON inválido, evento inválido, línea vacía, id repetido o modo mezclado) lanza y
 * deja el archivo intacto: no se trunca ni se descarta nada en silencio.
 */
async function loadState(file: string): Promise<MemoryState> {
  const state = emptyState();
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return state;
    throw error;
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const now = Date.now();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new Error(`corrupt journal ${file}: empty line at ${lineNumber}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `corrupt journal ${file}: line ${lineNumber} is not valid JSON (${errorMessage(error)})`,
      );
    }
    let prepared: PreparedEvent;
    try {
      prepared = prepareOrganimaEvent(raw, now);
    } catch (error) {
      throw new Error(
        `corrupt journal ${file}: line ${lineNumber} is not a valid OrganimaEvent (${errorMessage(error)})`,
      );
    }
    if (state.ids.has(prepared.event.id)) {
      throw new Error(`corrupt journal ${file}: line ${lineNumber} repeats event id`);
    }
    if (state.mode !== null && state.mode !== prepared.event.mode) {
      throw new Error(
        `corrupt journal ${file}: line ${lineNumber} mixes mode ${prepared.event.mode} into a ${state.mode} store`,
      );
    }
    applyPrepared(state, prepared);
  }
  return state;
}

/** `append` + `fsync`: el evento está en disco antes de tocar la proyección en memoria. */
async function appendLineDurably(file: string, line: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'a');
    await handle.writeFile(line, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/* ──────────────────────────────── implementación ──────────────────────────────── */

class JsonlMemory implements MemoryPort {
  readonly #file: string;
  readonly #state: MemoryState;
  #queue: Promise<void> = Promise.resolve();

  constructor(file: string, state: MemoryState) {
    this.#file = file;
    this.#state = state;
  }

  /** Escritor serializado: valida, comprueba duplicado y modo, hace durable y sólo entonces proyecta. */
  append(event: OrganimaEvent): Promise<boolean> {
    const run = this.#queue.then(() => this.#commit(event as unknown, Date.now()));
    // La cola nunca queda rota por un rechazo; el error sí se propaga a quien llamó `append`.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #commit(input: unknown, now: number): Promise<boolean> {
    const prepared = prepareOrganimaEvent(input, now);
    if (this.#state.ids.has(prepared.event.id)) return false;
    const currentMode = this.#state.mode;
    if (currentMode !== null && currentMode !== prepared.event.mode) {
      throw new Error(
        `memory store is locked to mode "${currentMode}"; rejected event with mode "${prepared.event.mode}"`,
      );
    }
    await appendLineDurably(this.#file, `${JSON.stringify(prepared.event)}\n`);
    applyPrepared(this.#state, prepared);
    return true;
  }

  /** Proyección rápida y clonada: últimos 100 eventos, una relación por subject+predicate. */
  snapshot(): GraphSnapshot {
    return {
      version: this.#state.version,
      relations: [...this.#state.relations.values()].map((relation) =>
        deepCloneJson<Relation>(relation),
      ),
      events: this.#state.events
        .slice(-SNAPSHOT_EVENT_LIMIT)
        .map((event) => deepCloneJson<OrganimaEvent>(event)),
    };
  }

  /** Contexto privado de la célula: últimos 20 eventos, clonados, nunca canónicos. */
  context(cellId: string): OrganimaEvent[] {
    const key = requireCellId(cellId);
    const stored = this.#state.contexts.get(key);
    if (stored === undefined) return [];
    return stored.map((event) => deepCloneJson<OrganimaEvent>(event));
  }

  /** Reemplaza el contexto privado de la célula. No se persiste ni altera el grafo compartido. */
  setContext(cellId: string, events: OrganimaEvent[]): void {
    const key = requireCellId(cellId);
    if (!Array.isArray(events)) {
      throw new Error('setContext requires an array of OrganimaEvent');
    }
    const now = Date.now();
    const prepared = events.map((candidate) => prepareOrganimaEvent(candidate, now));
    // Se valida todo antes de tocar el estado: una entrada inválida no deja el contexto a medias.
    const deduped = new Map<string, OrganimaEvent>();
    for (const item of prepared) {
      deduped.delete(item.event.id);
      deduped.set(item.event.id, item.event);
    }
    this.#state.contexts.set(key, [...deduped.values()].slice(-CONTEXT_EVENT_LIMIT));
  }

  /** Búsqueda sin distinguir mayúsculas sobre relaciones y eventos; retorno clonado. */
  query(term: string): { relations: Relation[]; events: OrganimaEvent[] } {
    if (typeof term !== 'string') throw new Error('query requires a string term');
    const needle = term.trim().toLowerCase();
    if (needle === '') return { relations: [], events: [] };
    return {
      relations: [...this.#state.relations.values()]
        .filter((relation) => relationText(relation).includes(needle))
        .map((relation) => deepCloneJson<Relation>(relation)),
      events: this.#state.events
        .filter((event) => eventText(event).includes(needle))
        .map((event) => deepCloneJson<OrganimaEvent>(event)),
    };
  }
}

/**
 * Abre (o crea) el store durable en `directory/events.jsonl` y reconstruye la proyección.
 * Rechaza rutas vacías y nunca escribe fuera de `directory`.
 */
export async function createMemory(directory: string): Promise<MemoryPort> {
  const root = requireDirectory(directory);
  await mkdir(root, { recursive: true });
  const file = join(root, EVENTS_FILE_NAME);
  const state = await loadState(file);
  return new JsonlMemory(file, state);
}
