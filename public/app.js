import { startCameraMonitor } from './vision.js';
/**
 * Organima — interfaz del panel.
 *
 * Diseño sin frameworks y sin CDN. Todo texto que viene de fuera se escribe con
 * `textContent`; nunca se interpreta HTML. Las funciones puras (normalización,
 * seguridad de enlaces, voz, validación de archivos) se exportan para que las
 * pruebas de `node:test` puedan verificarlas sin navegador.
 *
 * Cargar este módulo en Node no toca el DOM: la inicialización sólo ocurre
 * cuando existe `window` y `document`.
 */

/* ─────────────────────────── Constantes ─────────────────────────── */

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const TOKEN_STORAGE_KEY = 'organima.operator.token';
export const REQUEST_TIMEOUT_MS = 15000;
export const POLL_INTERVAL_MS = 5000;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;

export const DEMO_STEPS = Object.freeze(['reset', 'move', 'verify']);
export const PROVIDER_STATES = Object.freeze(['unconfigured', 'untested', 'ready', 'error', 'simulation']);
export const MODES = Object.freeze(['live', 'simulation']);
export const CHAT_ROLES = Object.freeze(['user', 'agent', 'error']);

/** Rutas de la API acordadas en docs/ARCHITECTURE.md. */
export const API_ROUTES = Object.freeze({
  state: '/api/state',
  events: '/api/events',
  chat: '/api/chat',
  research: '/api/research',
  observe: '/api/observe',
  goals: '/api/goals',
  stop: '/api/stop',
  demoStep: '/api/demo/step'
});

const SVG_NS = 'http://www.w3.org/2000/svg';

const FEMALE_VOICE_HINTS =
  /(female|mujer|femenin|sof[ií]a|paulina|m[oó]nica|marisol|dalia|ang[eé]lica|luc[ií]a|valentina|sabina|helena|elena|camila|isabela|ximena|esperanza|soledad|carmit|montserrat|pen[eé]lope|zira|mia|teresa|catalina|renata)/i;
const MALE_VOICE_HINTS =
  /(male|hombre|masculin|jorge|diego|juan|carlos|enrique|pablo|ra[uú]l|[aá]lvaro|andres|andrés|miguel|ricardo|fred|daniel|thomas|javier|sergio)/i;

const SECRET_PATTERNS = [
  /(bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:sk|pk|tvly|nvapi|xoxb|ghp|gho|ghu|glpat)[-_][A-Za-z0-9._-]{6,}\b/gi,
  /\beyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{6,}\.[A-Za-z0-9._-]{6,}\b/g
];

/* ─────────────────────── Funciones puras ─────────────────────── */

/** Recorta un valor a texto seguro y corto. */
export function truncate(value, max = 160) {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? max : 160;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Modo válido del contrato (`live` | `simulation`) o `null` si no se reconoce. */
export function normalizeMode(value) {
  return MODES.includes(value) ? value : null;
}

/** Etiqueta visible del modo. Lo desconocido nunca se disfraza de LIVE. */
export function formatModeLabel(mode) {
  if (mode === 'live') return 'LIVE';
  if (mode === 'simulation') return 'SIMULACIÓN';
  return 'ESTADO DESCONOCIDO';
}

export function formatModeClass(mode) {
  if (mode === 'live') return 'badge--live';
  if (mode === 'simulation') return 'badge--simulation';
  return 'badge--unknown';
}

/** Sólo http(s). Evita `javascript:`, `data:` y esquemas raros en enlaces. */
export function isSafeHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const candidate = value.trim();
  if (candidate === '') return false;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** Atributos listos para un enlace externo, o `null` si la URL no es segura. */
export function safeLinkTarget(value) {
  if (!isSafeHttpUrl(value)) return null;
  return { href: value.trim(), target: '_blank', rel: 'noopener noreferrer' };
}

/** Quita credenciales de un mensaje antes de mostrarlo o registrarlo. */
export function redactSecrets(value) {
  if (typeof value !== 'string' || value === '') return '';
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}[oculto]` : '[oculto]'));
  }
  return output;
}

/** Cabeceras de mutación: el token sólo viaja cuando existe. */
export function buildAuthHeaders(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  return value === '' ? {} : { 'X-Organima-Token': value };
}

/** Salud de proveedor. «Sin probar» jamás significa conectado. */
export function providerHealth(state) {
  switch (state) {
    case 'ready':
      return { label: 'Listo', hint: 'Última prueba del servidor fue exitosa.', tone: 'ok', connected: true };
    case 'error':
      return { label: 'Error', hint: 'La última prueba del servidor falló.', tone: 'bad', connected: false };
    case 'simulation':
      return { label: 'Simulación', hint: 'Datos simulados; no es hardware ni API real.', tone: 'sim', connected: false };
    case 'unconfigured':
      return { label: 'Sin configurar', hint: 'Falta la credencial en el servidor.', tone: 'off', connected: false };
    case 'untested':
    default:
      return {
        label: 'Sin probar',
        hint: 'Nunca se ha conectado; no hay evidencia de funcionamiento.',
        tone: 'warn',
        connected: false
      };
  }
}

/** Las acciones de demo sólo existen en modo simulación. */
export function demoStepAllowed(mode, step) {
  return mode === 'simulation' && DEMO_STEPS.includes(step);
}

/** Reintento con retroceso exponencial acotado. */
export function nextReconnectDelay(attempt, base = RECONNECT_BASE_MS, max = RECONNECT_MAX_MS) {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const delay = base * 2 ** Math.min(index, 20);
  return Math.min(Number.isFinite(max) && max > 0 ? max : RECONNECT_MAX_MS, delay);
}

/** Momento del evento en milisegundos. Un dato ausente o ilegible ordena al final, sin romper. */
export function eventTime(event) {
  if (!event || typeof event.occurredAt !== 'string' || event.occurredAt === '') return 0;
  const value = new Date(event.occurredAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function formatTimestamp(value) {
  // Un dato ausente no es una fecha: nunca se dibuja "1970" por accidente.
  if (value === null || value === undefined || value === '') return 'fecha desconocida';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'fecha desconocida';
  try {
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function humanBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'tamaño desconocido';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export function normalizeRelation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const subject = raw.subject;
  const predicate = raw.predicate;
  const object = raw.object;
  if (typeof subject !== 'string' || typeof predicate !== 'string' || typeof object !== 'string') return null;
  const confidence = Number(raw.confidence);
  return {
    subject,
    predicate,
    object,
    observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0
  };
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (id === '') return null;
  return {
    id,
    type: typeof raw.type === 'string' ? raw.type : 'evento',
    cellId: typeof raw.cellId === 'string' ? raw.cellId : 'sin-célula',
    occurredAt: typeof raw.occurredAt === 'string' ? raw.occurredAt : '',
    mode: normalizeMode(raw.mode) || 'simulation',
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {}
  };
}

export function normalizeCell(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') return null;
  const statuses = ['ready', 'offline', 'busy', 'error'];
  return {
    id: raw.id,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((c) => typeof c === 'string') : [],
    status: statuses.includes(raw.status) ? raw.status : 'offline',
    mode: normalizeMode(raw.mode) || 'simulation'
  };
}

export function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name === '') return null;
  return {
    name: raw.name,
    configured: raw.configured === true,
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : '',
    state: PROVIDER_STATES.includes(raw.state) ? raw.state : 'untested',
    detail: typeof raw.detail === 'string' ? raw.detail : ''
  };
}

export function normalizeGoalStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const goal = raw.goal;
  if (!goal || typeof goal !== 'object' || typeof goal.object !== 'string') return null;
  const states = ['accepted', 'running', 'awaiting_verification', 'verified', 'failed', 'cancelled'];
  return {
    goal: {
      id: typeof goal.id === 'string' ? goal.id : '',
      cellId: typeof goal.cellId === 'string' ? goal.cellId : '',
      object: goal.object,
      target: typeof goal.target === 'string' ? goal.target : '',
      relation: goal.relation === 'ON' ? 'ON' : 'ON',
      deadline: typeof goal.deadline === 'string' ? goal.deadline : '',
      mode: normalizeMode(goal.mode) || 'simulation'
    },
    state: states.includes(raw.state) ? raw.state : 'accepted',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  };
}

/** Estado del organismo con valores seguros: nunca lanza con datos rotos. */
export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const graph = source.graph && typeof source.graph === 'object' ? source.graph : {};
  const version = Number(graph.version);
  const relations = Array.isArray(graph.relations) ? graph.relations.map(normalizeRelation).filter(Boolean) : [];
  const events = Array.isArray(graph.events) ? graph.events.map(normalizeEvent).filter(Boolean) : [];
  return {
    mode: normalizeMode(source.mode),
    graph: {
      version: Number.isFinite(version) ? version : 0,
      relations,
      events
    },
    cells: Array.isArray(source.cells) ? source.cells.map(normalizeCell).filter(Boolean) : [],
    providers: Array.isArray(source.providers) ? source.providers.map(normalizeProvider).filter(Boolean) : [],
    robot: normalizeGoalStatus(source.robot)
  };
}

export function normalizeChatReply(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text === '') return null;
  const decision = raw.decision && typeof raw.decision === 'object' ? raw.decision : {};
  const probability = Number(decision.probability);
  return {
    text,
    mode: normalizeMode(raw.mode) || 'simulation',
    sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSource).filter(Boolean) : [],
    decision: {
      notify: decision.notify === true,
      research: decision.research === true,
      escalate: decision.escalate === true,
      probability: Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0,
      provider: typeof decision.provider === 'string' ? decision.provider : 'rules',
      mode: normalizeMode(decision.mode) || 'simulation'
    },
    model: typeof raw.model === 'string' ? raw.model : ''
  };
}

export function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : 'Fuente sin título';
  const url = typeof raw.url === 'string' ? raw.url : '';
  const score = Number(raw.score);
  return {
    title,
    url,
    safeUrl: isSafeHttpUrl(url) ? url.trim() : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    score: Number.isFinite(score) ? score : 0
  };
}

export function normalizeResearchResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    query: typeof raw.query === 'string' ? raw.query : '',
    sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeSource).filter(Boolean) : [],
    retrievedAt: typeof raw.retrievedAt === 'string' ? raw.retrievedAt : '',
    mode: normalizeMode(raw.mode) || 'simulation'
  };
}

export function normalizeRelationList(raw) {
  if (Array.isArray(raw)) return raw.map(normalizeRelation).filter(Boolean);
  if (raw && typeof raw === 'object' && Array.isArray(raw.relations)) {
    return raw.relations.map(normalizeRelation).filter(Boolean);
  }
  return [];
}

/**
 * Resumen de las tres memorias del organismo. El conocimiento estable vive en
 * `knowledge/` y la API de estado todavía no lo expone: el panel lo dice, no lo inventa.
 */
export function memorySummary(raw) {
  const state = normalizeState(raw);
  const perCell = new Map();
  const modesPerCell = new Map();
  for (const event of state.graph.events) {
    perCell.set(event.cellId, (perCell.get(event.cellId) || 0) + 1);
    if (!modesPerCell.has(event.cellId)) modesPerCell.set(event.cellId, event.mode);
  }
  const withContext = perCell.size;
  const simulated = state.graph.events.filter((event) => event.mode === 'simulation').length;
  return [
    {
      id: 'context',
      name: 'Contexto por célula',
      metric: `${withContext} ${withContext===1?'fuente':'fuentes'} con eventos`,
      note: withContext === 0 ? 'Aún sin eventos por célula.' : `Historial reciente por célula; no mide el tamaño del contexto.`
    },
    {
      id: 'graph',
      name: 'Grafo compartido',
      metric: `v${state.graph.version} · ${state.graph.relations.length} relaciones`,
      note:
        simulated > 0
          ? `${state.graph.events.length} eventos, ${simulated} marcados como simulación.`
          : `Derivado de ${state.graph.events.length} eventos persistidos.`
    },
    {
      id: 'knowledge',
      name: 'Conocimiento estable',
      metric: 'Versionado en knowledge/',
      note: 'Identidad y objetos del laboratorio, conservados en Git.'
    }
  ];
}

export function summarizePayload(payload, max = 140) {
  if (!payload || typeof payload !== 'object') return 'sin datos';
  const parts = [];
  for (const [key, value] of Object.entries(payload)) {
    if (parts.length >= 4) break;
    let rendered;
    try {
      rendered = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      rendered = 'valor no serializable';
    }
    parts.push(`${key}: ${truncate(rendered === undefined ? 'vacío' : rendered, 40)}`);
  }
  return truncate(parts.join(' · ') || 'sin datos', max);
}

/** Validación de la foto antes de enviarla. Límite duro de 2 MB. */
export function validateImageFile(file, maxBytes = MAX_IMAGE_BYTES) {
  if (!file || typeof file !== 'object') {
    return { ok: false, message: 'No se seleccionó ninguna imagen.' };
  }
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  const size = Number(file.size);
  if (type === 'image/svg+xml') {
    return { ok: false, message: 'No se aceptan SVG (pueden traer scripts). Usa JPG, PNG, WebP o GIF.' };
  }
  if (!type.startsWith('image/')) {
    return { ok: false, message: 'El archivo no parece una imagen (JPG, PNG, WebP o GIF).' };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, message: 'El archivo está vacío o no se pudo leer su tamaño.' };
  }
  if (size > maxBytes) {
    return { ok: false, message: `La imagen pesa ${humanBytes(size)}; el límite es ${humanBytes(maxBytes)}.` };
  }
  return { ok: true, message: `${humanBytes(size)} listos para enviar como observación.` };
}

function voiceScore(voice) {
  const lang = typeof voice?.lang === 'string' ? voice.lang.toLowerCase().replace('_', '-') : '';
  const name = typeof voice?.name === 'string' ? voice.name : '';
  let score = 0;
  if (lang === 'es-mx') score += 40;
  else if (lang.startsWith('es')) score += 20;
  if (FEMALE_VOICE_HINTS.test(name)) score += 10;
  if (MALE_VOICE_HINTS.test(name)) score -= 5;
  if (voice?.default === true) score += 1;
  return { score, isSpanish: lang.startsWith('es'), isMexican: lang === 'es-mx' };
}

/** Mejor voz disponible: es-MX femenina primero; `null` si no hay español. */
export function pickVoice(voices) {
  const list = Array.isArray(voices) ? voices.filter((voice) => voice && typeof voice.name === 'string') : [];
  const spanish = list.filter((voice) => voiceScore(voice).isSpanish);
  if (spanish.length === 0) return null;
  return spanish
    .slice()
    .sort((a, b) => voiceScore(b).score - voiceScore(a).score || String(a.name).localeCompare(String(b.name)))[0];
}

export function voiceProfile(voices) {
  const list = Array.isArray(voices) ? voices.filter((voice) => voice && typeof voice.name === 'string') : [];
  if (list.length === 0) {
    return {
      available: false,
      voice: null,
      isMexican: false,
      message: 'Este navegador todavía no reporta voces de síntesis.'
    };
  }
  const voice = pickVoice(list);
  if (!voice) {
    return {
      available: false,
      voice: null,
      isMexican: false,
      message: 'No hay voces en español instaladas: la lectura en voz alta queda desactivada.'
    };
  }
  const { isMexican } = voiceScore(voice);
  const label = `${voice.name} (${voice.lang || 'idioma desconocido'})`;
  return {
    available: true,
    voice,
    isMexican,
    message: isMexican ? `Voz: ${label}` : `No hay voz es-MX en este navegador; se usará ${label}.`
  };
}

/**
 * Lectura en voz alta con dependencias inyectadas, para poder probarla en Node.
 * Sin una voz utilizable no se crea ni se entrega ninguna locución: la promesa
 * «voz ausente, lectura desactivada» vive en el comportamiento, no sólo en el rótulo.
 * Devuelve `{ spoken, reason }` y nunca lanza con dependencias rotas.
 */
export function speakWithVoice(deps, text) {
  const options = deps && typeof deps === 'object' ? deps : {};
  const { enabled, voice, createUtterance, speak, onError } = options;
  if (enabled !== true) return { spoken: false, reason: 'disabled' };
  if (!voice || typeof voice !== 'object') return { spoken: false, reason: 'no-voice' };
  if (typeof createUtterance !== 'function' || typeof speak !== 'function') {
    return { spoken: false, reason: 'synthesis-unavailable' };
  }
  const value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  let utterance;
  try {
    utterance = createUtterance(value);
    if (!utterance || typeof utterance !== 'object') return { spoken: false, reason: 'utterance-failed' };
    utterance.voice = voice;
    if (voice.lang) utterance.lang = voice.lang;
    speak(utterance);
  } catch {
    if (typeof onError === 'function') onError();
    return { spoken: false, reason: 'utterance-failed' };
  }
  return { spoken: true, reason: 'spoken' };
}

/** Mezcla determinista de texto a [0, 1): posiciones estables entre recargas. */
export function hashToUnit(value) {
  const text = value === null || value === undefined ? '' : String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

/** Posiciones en anillo, deterministas por orden de aparición. */
export function layoutPositions(ids, options = {}) {
  const cx = Number.isFinite(options.cx) ? options.cx : 320;
  const cy = Number.isFinite(options.cy) ? options.cy : 200;
  const radius = Number.isFinite(options.radius) ? options.radius : 130;
  const startAngle = Number.isFinite(options.startAngle) ? options.startAngle : -Math.PI / 2;
  const unique = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const key = String(raw);
    if (!unique.includes(key)) unique.push(key);
  }
  const total = unique.length || 1;
  const positions = {};
  unique.forEach((id, index) => {
    const angle = startAngle + (index * 2 * Math.PI) / total;
    positions[id] = {
      x: Math.round((cx + radius * Math.cos(angle)) * 100) / 100,
      y: Math.round((cy + radius * Math.sin(angle)) * 100) / 100,
      angle
    };
  });
  return positions;
}

export function relationLabel(relation) {
  if (!relation) return '';
  return `${relation.subject} ${relation.predicate} ${relation.object}`;
}

/* ───────────────────────── Utilidades DOM ───────────────────────── */

function setText(node, value) {
  if (node) node.textContent = value === null || value === undefined ? '' : String(value);
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function makeSvg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  }
  return node;
}

function makeChip(text, tone) {
  return makeElement('span', `chip${tone ? ` chip--${tone}` : ''}`, text);
}

/** Enlace externo seguro. Si la URL no es http(s) se muestra el texto, sin enlace. */
function makeSourceLink(url, label) {
  const target = safeLinkTarget(url);
  if (!target) return makeElement('span', 'source__body', label);
  const link = document.createElement('a');
  link.href = target.href;
  link.target = target.target;
  link.rel = target.rel;
  link.textContent = label;
  return link;
}

/* ──────────────────────── Aplicación ──────────────────────── */

function initApp() {
  const byId = (id) => document.getElementById(id);

  const dom = {
    modeBadge: byId('mode-badge'),
    connection: byId('connection-status'),
    stopButton: byId('stop-button'),
    tokenForm: byId('token-form'),
    tokenInput: byId('token-input'),
    tokenClear: byId('token-clear'),
    memories: byId('memories'),
    cells: byId('cells'),
    providers: byId('providers'),
    scene: byId('scene'),
    sceneMeta: byId('scene-meta'),
    sceneCaption: byId('scene-caption'),
    chatLog: byId('chat-log'),
    chatEmpty: byId('chat-empty'),
    chatForm: byId('chat-form'),
    chatInput: byId('chat-input'),
    chatSend: byId('chat-send'),
    chatStatus: byId('chat-status'),
    chatEvidence: byId('chat-evidence'),
    chatHint: byId('chat-hint'),
    researchForm: byId('research-form'),
    researchInput: byId('research-input'),
    researchSubmit: byId('research-submit'),
    researchStatus: byId('research-status'),
    researchResults: byId('research-results'),
    observeForm: byId('observe-form'),
    observeInput: byId('observe-input'),
    observeSubmit: byId('observe-submit'),
    observeStatus: byId('observe-status'),
    observePreview: byId('observe-preview'),
    observePreviewWrap: byId('observe-preview-wrap'),
    goalForm: byId('goal-form'),
    goalObject: byId('goal-object'),
    goalTarget: byId('goal-target'),
    goalSubmit: byId('goal-submit'),
    goalStatus: byId('goal-status'),
    timelineList: byId('timeline-list'),
    timelineEmpty: byId('timeline-empty'),
    refreshButton: byId('refresh-button'),
    demoPanel: byId('demo-panel'),
    demoToggle: byId('toggle-demo'),
    demoNote: byId('demo-note'),
    demoButtons: ['demo-reset', 'demo-move', 'demo-verify'].map(byId).filter(Boolean),
    voiceToggle: byId('voice-toggle'),
    voiceSilence: byId('voice-silence'),
    voiceName: byId('voice-name'),
    voiceWarn: byId('voice-warn'),
    micButton: byId('mic-button'),
    micStatus: byId('mic-status'),
    statusRegion: byId('status-region'),
    alertRegion: byId('alert-region'),
    appStatus: byId('app-status')
  };

  const ui = {
    state: normalizeState(null),
    token: '',
    imageDataUrl: '',
    voiceEnabled: false,
    voice: null,
    voices: [],
    recognizer: null,
    stream: null,
    pollTimer: null,
    retryTimer: null,
    attempt: 0,
    busy: { chat: false, research: false, observe: false, goal: false, demo: false }
  };

  /* ── Mensajes y conexión ── */

  function announce(message) {
    setText(dom.statusRegion, message);
  }

  function alertUser(message) {
    const safe = redactSecrets(message);
    setText(dom.alertRegion, safe);
    setText(dom.appStatus, safe);
  }

  function setAppStatus(message) {
    setText(dom.appStatus, redactSecrets(message));
  }

  function setConnection(kind, text) {
    setText(dom.connection, text);
    dom.connection.className = `conn conn--${kind}`;
  }

  async function requestJson(path, options = {}) {
    const { method = 'GET', body, token, timeout = REQUEST_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      Object.assign(headers, buildAuthHeaders(token));
      const response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'same-origin'
      });
      const raw = await response.text();
      let payload = null;
      if (raw !== '') {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(redactSecrets(detail));
      }
      return payload;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(`El servidor tardó más de ${Math.round(timeout / 1000)} s en responder`);
      }
      throw new Error(redactSecrets(error && error.message ? error.message : 'Fallo de red'));
    } finally {
      window.clearTimeout(timer);
    }
  }

  /* ── Estado ── */

  function applyState(raw, origin) {
    ui.state = normalizeState(raw);
    renderAll();
    const stamp = new Date();
    setAppStatus(`Estado actualizado (${origin}) ${formatTimestamp(stamp)}`);
  }

  async function loadState(options = {}) {
    const { silent = false } = options;
    try {
      const payload = await requestJson(API_ROUTES.state, { timeout: 10000 });
      applyState(payload, 'GET /api/state');
      if (!ui.stream) setConnection('degraded', 'Sondeo de respaldo cada 5 s');
    } catch (error) {
      setConnection('down', 'Sin conexión con el núcleo local');
      if (!silent) alertUser(`No pude leer el estado: ${error.message}`);
    }
  }

  /* ── Escena espacial (SVG creado en código) ── */

  function renderScene() {
    const host = dom.scene;
    if (!host) return;
    clearNode(host);

    const state = ui.state;
    const svg = makeSvg('svg', {
      id: 'scene-svg',
      viewBox: '0 0 640 400',
      preserveAspectRatio: 'xMidYMid meet',
      focusable: 'false',
      'aria-hidden': 'true'
    });

    const grid = makeSvg('g', {});
    for (let column = 1; column < 8; column += 1) {
      const line = makeSvg('line', { x1: column * 80, y1: 0, x2: column * 80, y2: 400 });
      line.style.stroke = 'rgba(44, 57, 68, 0.5)';
      line.style.strokeWidth = '1';
      grid.appendChild(line);
    }
    for (let row = 1; row < 5; row += 1) {
      const line = makeSvg('line', { x1: 0, y1: row * 80, x2: 640, y2: row * 80 });
      line.style.stroke = 'rgba(44, 57, 68, 0.5)';
      line.style.strokeWidth = '1';
      grid.appendChild(line);
    }
    svg.appendChild(grid);

    const nodes = [];
    const seen = new Set();
    for (const cell of state.cells) {
      if (seen.has(cell.id)) continue;
      seen.add(cell.id);
      nodes.push({ id: cell.id, kind: 'cell', label: cell.name, mode: cell.mode, status: cell.status });
    }
    for (const relation of state.graph.relations) {
      for (const id of [relation.subject, relation.object]) {
        if (seen.has(id)) continue;
        seen.add(id);
        nodes.push({ id, kind: 'entity', label: id, mode: 'simulation', status: 'offline' });
      }
    }

    if (nodes.length === 0) {
      const empty = makeSvg('text', { x: 320, y: 196, 'text-anchor': 'middle', class: 'scene__empty-text' });
      empty.textContent = 'Sin células ni relaciones todavía.';
      svg.appendChild(empty);
      const emptyHint = makeSvg('text', { x: 320, y: 218, 'text-anchor': 'middle', class: 'scene__empty-text' });
      emptyHint.textContent = 'Ejecuta «Reiniciar escena» en las acciones de demostración para ver el escenario simulado.';
      svg.appendChild(emptyHint);
    } else {
      const cellIds = nodes.filter((node) => node.kind === 'cell').map((node) => node.id);
      const entityIds = nodes.filter((node) => node.kind === 'entity').map((node) => node.id);
      const cellPositions = layoutPositions(cellIds, { cx: 320, cy: 200, radius: 148 });
      const entityPositions = layoutPositions(entityIds, { cx: 320, cy: 200, radius: 74, startAngle: Math.PI / 6 });
      const positions = { ...entityPositions, ...cellPositions };

      const edges = makeSvg('g', {});
      const labels = makeSvg('g', {});
      for (const relation of state.graph.relations) {
        const from = positions[relation.subject];
        const to = positions[relation.object];
        if (!from || !to || relation.subject === relation.object) continue;
        const line = makeSvg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y });
        line.style.stroke = relation.confidence >= 0.6 ? 'var(--lima)' : 'var(--ambar)';
        line.style.strokeOpacity = String(Math.max(0.25, relation.confidence));
        line.style.strokeWidth = relation.confidence >= 0.6 ? '2' : '1.25';
        line.style.strokeDasharray = relation.confidence >= 0.6 ? '' : '5 4';
        edges.appendChild(line);

        const text = makeSvg('text', {
          x: (from.x + to.x) / 2,
          y: (from.y + to.y) / 2 - 4,
          'text-anchor': 'middle',
          class: 'scene__edge-label'
        });
        text.textContent = `${relation.predicate} · ${relation.confidence.toFixed(2)}`;
        labels.appendChild(text);
      }
      svg.appendChild(edges);

      const nodeLayer = makeSvg('g', {});
      const labelLayer = makeSvg('g', {});
      for (const node of nodes) {
        const position = positions[node.id];
        if (!position) continue;
        const radius = node.kind === 'cell' ? 20 : 12;
        const circle = makeSvg('circle', { cx: position.x, cy: position.y, r: radius });
        if (node.kind === 'cell') {
          circle.style.fill = node.status === 'ready' ? 'rgba(182, 243, 106, 0.22)' : 'rgba(111, 211, 255, 0.16)';
          circle.style.stroke = node.status === 'ready' ? 'var(--lima)' : node.status === 'error' ? 'var(--rojo)' : 'var(--cielo)';
        } else {
          circle.style.fill = 'rgba(255, 180, 84, 0.16)';
          circle.style.stroke = 'var(--ambar)';
        }
        circle.style.strokeWidth = '2';
        nodeLayer.appendChild(circle);

        const label = makeSvg('text', {
          x: position.x,
          y: position.y + radius + 14,
          'text-anchor': 'middle',
          class: 'scene__node-label'
        });
        label.textContent = truncate(node.label, 22);
        labelLayer.appendChild(label);
      }
      svg.appendChild(nodeLayer);
      svg.appendChild(labels);
      svg.appendChild(labelLayer);

      const legend = makeSvg('text', { x: 16, y: 388, class: 'scene__edge-label' });
      legend.textContent = '○ célula   ◇ objeto   ─ relación (opacidad = confianza)';
      svg.appendChild(legend);
    }

    if (state.mode === 'simulation') {
      const watermark = makeSvg('text', {
        x: 624,
        y: 30,
        'text-anchor': 'end',
        class: 'scene__edge-label'
      });
      watermark.style.fill = 'var(--ambar)';
      watermark.textContent = 'ESCENARIO SIMULADO';
      svg.appendChild(watermark);
    }

    host.appendChild(svg);
    setText(
      dom.sceneMeta,
      `grafo v${state.graph.version} · ${state.graph.relations.length} relaciones · ${state.graph.events.length} eventos`
    );
    setText(
      dom.sceneCaption,
      state.graph.relations.length === 0
        ? 'Sin relaciones todavía: el grafo está vacío y el panel no dibuja lo que no sabe. Ejecuta «Reiniciar escena» en las acciones de demostración para ver el escenario simulado.'
        : 'Dibujo derivado del grafo compartido. Las flechas son relaciones con su predicado y confianza.'
    );
  }

  /* ── Memorias, células y proveedores ── */

  function renderMemories() {
    const host = dom.memories;
    if (!host) return;
    clearNode(host);
    for (const memory of memorySummary(ui.state)) {
      const item = makeElement('li', `memory memory--${memory.id}`);
      item.appendChild(makeElement('p', 'memory__name', memory.name));
      item.appendChild(makeElement('p', 'memory__metric', memory.metric));
      item.appendChild(makeElement('p', 'memory__note', memory.note));
      host.appendChild(item);
    }
  }

  function renderCells() {
    const host = dom.cells;
    if (!host) return;
    clearNode(host);
    if (ui.state.cells.length === 0) {
      host.appendChild(
        makeElement(
          'li',
          'empty',
          'Sin células registradas todavía. Abre «Mostrar acciones de demostración» y pulsa «Reiniciar escena» para ver el escenario simulado.'
        )
      );
      return;
    }
    for (const cell of ui.state.cells) {
      const item = makeElement('li', 'cell');
      const top = makeElement('div', 'cell__top');
      top.appendChild(makeElement('span', 'cell__name', cell.name));
      top.appendChild(makeChip(formatModeLabel(cell.mode), cell.mode === 'live' ? 'ok' : 'sim'));
      item.appendChild(top);
      const details = `id ${cell.id} · ${cell.status}${
        cell.parentId ? ` · padre ${cell.parentId}` : ' · célula raíz'
      } · capacidades: ${cell.capabilities.length > 0 ? cell.capabilities.join(', ') : 'ninguna declarada'}`;
      item.appendChild(makeElement('p', 'cell__caps', details));
      host.appendChild(item);
    }
  }

  function renderProviders() {
    const host = dom.providers;
    if (!host) return;
    clearNode(host);
    if (ui.state.providers.length === 0) {
      host.appendChild(
        makeElement(
          'li',
          'empty',
          'El servidor no reporta proveedores todavía. «Sin probar» nunca significa conectado.'
        )
      );
      return;
    }
    for (const provider of ui.state.providers) {
      const health = providerHealth(provider.state);
      const item = makeElement('li', 'provider');
      const top = makeElement('div', 'provider__top');
      top.appendChild(makeElement('span', 'provider__name', provider.name));
      top.appendChild(makeChip(health.label, health.tone));
      item.appendChild(top);
      if(provider.model)item.appendChild(makeElement('p','provider__detail',provider.model));
      item.title = provider.detail || health.hint;
      host.appendChild(item);
    }
  }

  /* ── Cronología ── */

  function renderTimeline() {
    const host = dom.timelineList;
    if (!host) return;
    clearNode(host);
    const events = ui.state.graph.events
      .slice()
      .sort((a, b) => eventTime(b) - eventTime(a))
      .slice(0, 60);
    if (events.length === 0) {
      if (dom.timelineEmpty) dom.timelineEmpty.hidden = false;
      return;
    }
    if (dom.timelineEmpty) dom.timelineEmpty.hidden = true;
    for (const event of events) {
      const item = makeElement('li', `timeline__item${event.mode === 'simulation' ? ' timeline__item--sim' : ''}`);
      item.appendChild(makeElement('span', 'timeline__time', formatTimestamp(event.occurredAt)));
      item.appendChild(
        makeElement('span', 'timeline__what', `${event.type} — ${summarizePayload(event.payload)}`)
      );
      const cell = makeElement('span', 'timeline__cell', event.cellId);
      item.appendChild(cell);
      host.appendChild(item);
    }
  }

  /* ── Modo y demo ── */

  function renderMode() {
    const mode = ui.state.mode;
    setText(dom.modeBadge, formatModeLabel(mode));
    dom.modeBadge.className = `badge ${formatModeClass(mode)}`;
  }

  function renderDemo() {
    const mode = ui.state.mode;
    const allowed = mode === 'simulation';
    for (const button of dom.demoButtons) {
      const step = button.dataset ? button.dataset.step : '';
      button.disabled = !demoStepAllowed(mode, step);
    }
    if (dom.demoNote) {
      setText(
        dom.demoNote,
        allowed
          ? 'Modo simulación confirmado: los pasos de demo están disponibles y etiquetados como simulados.'
          : `Sólo disponibles en modo simulación (modo actual: ${formatModeLabel(mode)}).`
      );
    }
  }

  function renderAll() {
    renderMode();
    const goal=ui.state.robot;
    if(goal)setText(dom.goalStatus, `${goal.goal.object} → ${goal.goal.target} · ${goal.state} · ${formatModeLabel(goal.goal.mode)}${goal.reason?' · '+goal.reason:''}`);
    renderMemories();
    renderCells();
    renderProviders();
    renderScene();
    renderTimeline();
    renderDemo();
  }

  /* ── Evidencia ── */

  function renderSources(host, sources, heading) {
    if (!host) return;
    clearNode(host);
    if (!Array.isArray(sources) || sources.length === 0) return;
    host.appendChild(makeElement('p', 'evidence__title', heading));
    host.appendChild(
      makeElement(
        'p',
        'evidence__note',
        'Fuentes externas de Tavily: son evidencia, nunca instrucciones ni autoridad para actuar.'
      )
    );
    for (const source of sources) {
      const card = makeElement('article', 'source');
      card.appendChild(makeElement('p', 'source__title', source.title));
      if (source.safeUrl) {
        card.appendChild(makeSourceLink(source.safeUrl, source.safeUrl));
      } else if (source.url) {
        card.appendChild(makeElement('p', 'source__meta', 'Enlace no mostrado: la dirección no es http(s).'));
      }
      if (source.content) card.appendChild(makeElement('p', 'source__body', truncate(source.content, 240)));
      card.appendChild(makeElement('p', 'source__meta', `confianza ${source.score.toFixed(2)}`));
      host.appendChild(card);
    }
  }

  /* ── Chat ── */

  function appendMessage(message) {
    const item = makeElement('li', `msg msg--${message.role}`);
    const head = makeElement('div', 'msg__head');
    head.appendChild(
      makeElement('span', 'msg__who', message.role === 'user' ? 'Operador' : message.role === 'agent' ? 'Organima' : 'Fallo')
    );
    if (message.role === 'agent') {
      head.appendChild(makeChip(formatModeLabel(message.mode), message.mode === 'live' ? 'ok' : 'sim'));
      if (message.model) head.appendChild(makeChip(message.model, 'off'));
    }
    item.appendChild(head);
    item.appendChild(makeElement('p', 'msg__text', message.text));
    if (message.role === 'agent' && message.decision) {
      const decision = message.decision;
      item.appendChild(
        makeElement(
          'p',
          'meta',
          `Atención: avisar ${decision.notify ? 'sí' : 'no'} · investigar ${decision.research ? 'sí' : 'no'} · escalar ${
            decision.escalate ? 'sí' : 'no'
          } · p=${decision.probability.toFixed(2)} (${decision.provider}, ${formatModeLabel(decision.mode)})`
        )
      );
    }
    dom.chatLog.appendChild(item);
    if (dom.chatEmpty) dom.chatEmpty.hidden = true;
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
  }

  function updateChatBusy() {
    if (!dom.chatSend) return;
    dom.chatSend.disabled = ui.busy.chat;
    setText(dom.chatSend, ui.busy.chat ? 'Enviando…' : 'Enviar');
  }

  async function sendChat(message) {
    if (ui.busy.chat) return;
    ui.busy.chat = true;
    updateChatBusy();
    setText(dom.chatStatus, 'Enviando…');
    appendMessage({ role: 'user', text: message });
    try {
      const payload = await requestJson(API_ROUTES.chat, {
        method: 'POST',
        body: { message },
        token: ui.token,
        timeout: 45000
      });
      const reply = normalizeChatReply(payload);
      if (!reply) throw new Error('La respuesta del servidor no tiene el formato de ChatReply');
      appendMessage({
        role: 'agent',
        text: reply.text,
        mode: reply.mode,
        model: reply.model,
        decision: reply.decision
      });
      renderSources(dom.chatEvidence, reply.sources, 'Evidencia de la respuesta');
      if (ui.voiceEnabled) speak(reply.text);
      setText(dom.chatStatus, 'Listo');
    } catch (error) {
      appendMessage({
        role: 'error',
        text: `No pude completar la respuesta: ${error.message}. No inventé ninguna contestación.`
      });
      setText(dom.chatStatus, 'Fallo al conversar');
      alertUser(`Fallo al conversar: ${error.message}`);
    } finally {
      ui.busy.chat = false;
      updateChatBusy();
    }
  }

  /* ── Investigación ── */

  async function runResearch(query) {
    if (ui.busy.research) return;
    ui.busy.research = true;
    dom.researchSubmit.disabled = true;
    setText(dom.researchStatus, 'Consultando a Tavily…');
    try {
      const payload = await requestJson(API_ROUTES.research, {
        method: 'POST',
        body: { query },
        token: ui.token,
        timeout: 30000
      });
      const result = normalizeResearchResult(payload);
      if (!result) throw new Error('La respuesta del servidor no tiene el formato de ResearchResult');
      renderSources(dom.researchResults, result.sources, `Evidencia para «${result.query || query}»`);
      setText(
        dom.researchStatus,
        result.sources.length === 0
          ? `Sin fuentes · ${formatModeLabel(result.mode)} · ${formatTimestamp(result.retrievedAt)}`
          : `${result.sources.length} fuentes · ${formatModeLabel(result.mode)} · ${formatTimestamp(result.retrievedAt)}`
      );
      announce(`Investigación terminada con ${result.sources.length} fuentes.`);
    } catch (error) {
      setText(dom.researchStatus, `Fallo: ${error.message}`);
      alertUser(`Fallo al investigar: ${error.message}`);
    } finally {
      ui.busy.research = false;
      dom.researchSubmit.disabled = false;
    }
  }

  /* ── Observación ── */

  function resetObservation() {
    ui.imageDataUrl = '';
    if (dom.observePreviewWrap) dom.observePreviewWrap.hidden = true;
    if (dom.observePreview) dom.observePreview.removeAttribute('src');
  }

  function handlePhotoChange() {
    const file = dom.observeInput.files && dom.observeInput.files[0];
    resetObservation();
    if (!file) {
      setText(dom.observeStatus, 'Sin imagen');
      return;
    }
    const verdict = validateImageFile(file);
    if (!verdict.ok) {
      setText(dom.observeStatus, verdict.message);
      alertUser(verdict.message);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        setText(dom.observeStatus, 'No pude leer la imagen como datos locales.');
        resetObservation();
        return;
      }
      ui.imageDataUrl = dataUrl;
      if (dom.observePreview) dom.observePreview.src = dataUrl;
      if (dom.observePreviewWrap) dom.observePreviewWrap.hidden = false;
      setText(dom.observeStatus, verdict.message);
    };
    reader.onerror = () => {
      resetObservation();
      setText(dom.observeStatus, 'No pude leer el archivo seleccionado.');
    };
    reader.readAsDataURL(file);
  }

  async function submitObservation() {
    if (ui.busy.observe) return;
    if (!ui.imageDataUrl) {
      setText(dom.observeStatus, 'Selecciona una foto antes de enviar la observación.');
      return;
    }
    ui.busy.observe = true;
    dom.observeSubmit.disabled = true;
    setText(dom.observeStatus, 'Enviando observación…');
    try {
      const payload = await requestJson(API_ROUTES.observe, {
        method: 'POST',
        body: { imageDataUrl: ui.imageDataUrl },
        token: ui.token,
        timeout: 45000
      });
      const relations = normalizeRelationList(payload);
      setText(
        dom.observeStatus,
        relations.length === 0
          ? 'La observación se envió pero no produjo relaciones nuevas.'
          : `${relations.length} relaciones observadas: ${relations.map(relationLabel).join(' · ')}`
      );
      announce('Observación enviada.');
      await loadState({ silent: true });
    } catch (error) {
      setText(dom.observeStatus, `Fallo al observar: ${error.message}`);
      alertUser(`Fallo al observar: ${error.message}`);
    } finally {
      ui.busy.observe = false;
      dom.observeSubmit.disabled = false;
    }
  }

  /* ── Objetivos y parada ── */

  async function submitGoal(object, target) {
    if (ui.busy.goal) return;
    ui.busy.goal = true;
    dom.goalSubmit.disabled = true;
    setText(dom.goalStatus, 'Enviando objetivo…');
    try {
      const payload = await requestJson(API_ROUTES.goals, {
        method: 'POST',
        body: { object, target },
        token: ui.token
      });
      const status = normalizeGoalStatus(payload);
      if (!status) throw new Error('La respuesta del servidor no tiene el formato de GoalStatus');
      setText(
        dom.goalStatus,
        `${status.goal.object} → ${status.goal.target} · ${status.state} · ${formatModeLabel(status.goal.mode)}`
      );
      announce(`Objetivo ${status.state}.`);
      await loadState({ silent: true });
    } catch (error) {
      setText(dom.goalStatus, `Fallo al solicitar el objetivo: ${error.message}`);
      alertUser(`Fallo al solicitar el objetivo: ${error.message}`);
    } finally {
      ui.busy.goal = false;
      dom.goalSubmit.disabled = false;
    }
  }

  /**
   * Parada local. El control nunca se deshabilita: si alguien vuelve a pulsarlo,
   * la orden se reenvía. La seguridad no depende de un botón bloqueado.
   */
  async function requestStop() {
    stopSpeaking();
    setText(dom.chatStatus, 'Parada solicitada…');
    try {
      const payload = await requestJson(API_ROUTES.stop, { method: 'POST', body: {}, token: ui.token });
      const status = normalizeGoalStatus(payload);
      const detail = status ? `${status.state}${status.reason ? ` · ${status.reason}` : ''}` : 'sin objetivo activo';
      setText(dom.chatStatus, `Parada enviada: ${detail}`);
      announce(`Parada enviada: ${detail}`);
      await loadState({ silent: true });
    } catch (error) {
      setText(dom.chatStatus, `La parada no se pudo confirmar: ${error.message}`);
      alertUser(`La parada no se pudo confirmar: ${error.message}`);
    }
  }

  async function runDemoStep(step) {
    if (!demoStepAllowed(ui.state.mode, step)) {
      setText(dom.demoNote, 'Los pasos de demostración sólo se ejecutan en modo simulación.');
      return;
    }
    if (ui.busy.demo) return;
    ui.busy.demo = true;
    dom.demoButtons.forEach((button) => {
      button.disabled = true;
    });
    setText(dom.demoNote, `Aplicando paso simulado «${step}»…`);
    try {
      await requestJson(API_ROUTES.demoStep, { method: 'POST', body: { step }, token: ui.token });
      setText(dom.demoNote, `Paso simulado aplicado: ${step}. Escenario simulado, no hardware real.`);
      announce(`Paso simulado ${step} aplicado.`);
      await loadState({ silent: true });
    } catch (error) {
      setText(dom.demoNote, `El paso simulado falló: ${error.message}`);
      alertUser(`El paso simulado falló: ${error.message}`);
    } finally {
      ui.busy.demo = false;
      renderDemo();
    }
  }

  /* ── Voz ── */

  function synthesisAvailable() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  function disableVoiceControls(message) {
    ui.voiceEnabled = false;
    if (dom.voiceToggle) {
      dom.voiceToggle.checked = false;
      dom.voiceToggle.disabled = true;
    }
    setText(dom.voiceName, message);
    if (dom.voiceWarn) {
      dom.voiceWarn.hidden = false;
      setText(dom.voiceWarn, message);
    }
  }

  let remoteVoice = false;
  let voiceController = null;
  let audioPlayer = null;
  let audioUrl = null;

  function refreshVoices() {
    if (remoteVoice) {
      dom.voiceToggle.disabled = false;
      setText(dom.voiceName, "Ana Sofia · español mexicano · ElevenLabs");
      dom.voiceWarn.hidden = true;
      return;
    }
    if (!synthesisAvailable()) {
      disableVoiceControls('Este navegador no ofrece síntesis de voz.');
      return;
    }
    ui.voices = window.speechSynthesis.getVoices() || [];
    const profile = voiceProfile(ui.voices);
    ui.voice = profile.voice;
    if (!profile.available) {
      // Sin voz utilizable no se habla: el rótulo y la conducta dicen lo mismo.
      disableVoiceControls(profile.message);
      return;
    }
    if (dom.voiceToggle) dom.voiceToggle.disabled = false;
    setText(dom.voiceName, ui.voiceEnabled ? profile.message : 'Voz del navegador: sin activar');
    if (dom.voiceWarn) {
      const warn = ui.voiceEnabled && !profile.isMexican;
      dom.voiceWarn.hidden = !warn;
      setText(dom.voiceWarn, warn ? profile.message : '');
    }
  }

  async function speak(text) {
    if (remoteVoice && ui.voiceEnabled) {
      stopSpeaking();
      const controller = new AbortController(); voiceController = controller;
      try {
        const response = await fetch('/api/voice', { method:'POST', headers:{'Content-Type':'application/json','X-Organima-Token':ui.token}, body:JSON.stringify({text:String(text).slice(0,1600)}), signal:controller.signal });
        if (!response.ok) throw new Error('No se pudo generar la voz.');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        audioUrl = URL.createObjectURL(blob); audioPlayer = new Audio(audioUrl);
        audioPlayer.onended = () => { if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl=null; };
        await audioPlayer.play();
        setText(dom.voiceName, 'Ana Sofia · español mexicano · ElevenLabs');
      } catch(error) { if (!controller.signal.aborted) setText(dom.voiceName, error.message); }
      return;
    }
    if (!synthesisAvailable()) return { spoken: false, reason: 'synthesis-unavailable' };
    return speakWithVoice(
      {
        enabled: ui.voiceEnabled,
        voice: ui.voice,
        createUtterance: (value) => {
          const utterance = new window.SpeechSynthesisUtterance(value);
          utterance.onerror = () => setText(dom.voiceName, 'La síntesis de voz del navegador falló.');
          return utterance;
        },
        speak: (utterance) => window.speechSynthesis.speak(utterance),
        onError: () => setText(dom.voiceName, 'La síntesis de voz del navegador falló.')
      },
      text
    );
  }

  function stopSpeaking() {
    voiceController?.abort(); voiceController=null;
    if (audioPlayer) { audioPlayer.pause(); audioPlayer=null; }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl=null; }
    if (synthesisAvailable()) window.speechSynthesis.cancel();
    setText(dom.voiceName, ui.voiceEnabled ? 'Lectura interrumpida; lista para la siguiente.' : 'Voz del navegador: sin activar');
  }

  function toggleVoice(enabled) {
    if (!enabled) {
      stopSpeaking();
      ui.voiceEnabled = false;
      if (synthesisAvailable()) window.speechSynthesis.cancel();
      setText(dom.voiceName, 'Voz del navegador: sin activar');
      if (dom.voiceWarn) dom.voiceWarn.hidden = true;
      return;
    }
    ui.voiceEnabled = true;
    // refreshVoices() vuelve a apagar la lectura si no hay ninguna voz que usar.
    refreshVoices();
  }

  fetch('/api/voice').then(r=>r.json()).then(status=>{ remoteVoice=status.configured===true; refreshVoices(); }).catch(()=>{});
  let cameraMonitor = null;
  let cameraStarting = false;
  let cameraGeneration = 0;
  document.getElementById('camera-start')?.addEventListener('click', async()=>{
    if (ui.state.mode !== 'live') { setText(document.getElementById('camera-status'), 'La cámara requiere modo live. En esta demo usa los pasos simulados.'); return; }
    if (cameraStarting) return;
    cameraStarting=true;
    const generation=++cameraGeneration;
    const video=document.getElementById('camera-preview');
    try {
      cameraMonitor?.stop(); video.hidden=false;
      const monitor=await startCameraMonitor({video,onStatus:message=>setText(document.getElementById('camera-status'),message),onFrame:async imageDataUrl=>{
        const payload=await requestJson(API_ROUTES.observe,{method:'POST',body:{imageDataUrl},token:ui.token,timeout:60000});
        if(generation!==cameraGeneration)return;
        if(payload.announcement){appendMessage({role:'agent',text:payload.announcement.text,mode:ui.state.mode,model:payload.announcement.model});if(ui.voiceEnabled)speak(payload.announcement.text);}
        await loadState({silent:true});
      }});
      if(generation!==cameraGeneration)monitor.stop();else cameraMonitor=monitor;
    }catch(error){setText(document.getElementById('camera-status'),error.message);}
    finally{cameraStarting=false;}
  });
  document.getElementById('camera-stop')?.addEventListener('click',()=>{cameraGeneration++;cameraMonitor?.stop();cameraMonitor=null;setText(document.getElementById('camera-status'),'Cámara apagada');});
  window.addEventListener('pagehide',()=>{cameraMonitor?.stop();stopSpeaking();});

  /* ── Micrófono ── */

  function setupMicrophone() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      if (dom.micButton) dom.micButton.hidden = true;
      setText(
        dom.micStatus,
        'Servicio de reconocimiento del navegador: no disponible aquí. El texto sigue funcionando.'
      );
      return;
    }
    setText(dom.micStatus, 'Servicio de reconocimiento del navegador: disponible (dictado).');
    if (dom.micButton) dom.micButton.hidden = false;
    let listening = false;
    const recognition = new Recognition();
    recognition.lang = ui.voice && ui.voice.lang ? ui.voice.lang : 'es-MX';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let transcript = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
      }
      dom.chatInput.value = transcript.trim();
    };
    recognition.onerror = (event) => {
      listening = false;
      dom.micButton.textContent = 'Dictar';
      setText(dom.micStatus, `El dictado falló (${event.error || 'error'}). Puedes escribir el mensaje.`);
    };
    recognition.onend = () => {
      listening = false;
      dom.micButton.textContent = 'Dictar';
    };
    dom.micButton.addEventListener('click', () => {
      if (listening) {
        recognition.stop();
        return;
      }
      try {
        stopSpeaking();
        recognition.start();
        listening = true;
        dom.micButton.textContent = 'Detener dictado';
        setText(dom.micStatus, 'Servicio de reconocimiento del navegador: escuchando…');
      } catch (error) {
        setText(dom.micStatus, `No pude iniciar el dictado: ${error.message}`);
      }
    });
  }

  /* ── Token de operador ── */

  function readStoredToken() {
    try {
      return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function storeToken(value) {
    try {
      if (value === '') window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      else window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
      return true;
    } catch {
      return false;
    }
  }

  /* ── Flujo de eventos y sondeo de respaldo ── */

  function startPolling() {
    if (ui.pollTimer !== null) return;
    ui.pollTimer = window.setInterval(() => loadState({ silent: true }), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (ui.pollTimer !== null) {
      window.clearInterval(ui.pollTimer);
      ui.pollTimer = null;
    }
  }

  function closeStream() {
    if (ui.stream) {
      ui.stream.close();
      ui.stream = null;
    }
  }

  function scheduleReconnect() {
    if (ui.retryTimer !== null) return;
    const delay = nextReconnectDelay(ui.attempt);
    ui.attempt += 1;
    ui.retryTimer = window.setTimeout(() => {
      ui.retryTimer = null;
      connectStream();
    }, delay);
  }

  function connectStream() {
    if (typeof window.EventSource !== 'function') {
      setConnection('degraded', 'Sin SSE en este navegador; sondeo cada 5 s');
      startPolling();
      return;
    }
    closeStream();
    let source;
    try {
      source = new window.EventSource(API_ROUTES.events);
    } catch {
      setConnection('degraded', 'SSE no disponible; sondeo cada 5 s');
      startPolling();
      scheduleReconnect();
      return;
    }
    ui.stream = source;
    source.addEventListener('open', () => {
      ui.attempt = 0;
      if (ui.retryTimer !== null) {
        window.clearTimeout(ui.retryTimer);
        ui.retryTimer = null;
      }
      stopPolling();
      setConnection('stream', 'Flujo SSE activo');
    });
    source.addEventListener('state', (event) => {
      try {
        applyState(JSON.parse(event.data), 'SSE');
        setConnection('stream', 'Flujo SSE activo');
      } catch {
        setConnection('degraded', 'Evento SSE ilegible; se ignora');
      }
    });
    source.addEventListener('error', () => {
      setConnection('degraded', 'SSE interrumpido; sondeo de respaldo');
      startPolling();
      scheduleReconnect();
    });
  }

  /* ── Cableado de la interfaz ── */

  function wire() {
    dom.tokenInput.value = ui.token;
    updateChatBusy();

    dom.tokenForm.addEventListener('submit', (event) => {
      event.preventDefault();
      ui.token = dom.tokenInput.value.trim();
      const stored = storeToken(ui.token);
      announce(stored ? 'Token guardado sólo en esta pestaña.' : 'No pude guardar el token en esta pestaña.');
    });

    dom.tokenClear.addEventListener('click', () => {
      ui.token = '';
      dom.tokenInput.value = '';
      storeToken('');
      announce('Token de operador borrado de esta pestaña.');
    });

    dom.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const message = dom.chatInput.value.trim();
      if (message === '') return;
      dom.chatInput.value = '';
      sendChat(message);
    });

    dom.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        dom.chatForm.requestSubmit();
      }
    });

    dom.researchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = dom.researchInput.value.trim();
      if (query === '') return;
      runResearch(query);
    });

    dom.observeInput.addEventListener('change', handlePhotoChange);
    dom.observeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitObservation();
    });

    dom.goalForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitGoal(dom.goalObject.value, dom.goalTarget.value);
    });

    dom.stopButton.addEventListener('click', requestStop);
    dom.refreshButton.addEventListener('click', () => loadState());
    dom.demoToggle.addEventListener('change', () => {
      dom.demoPanel.hidden = !dom.demoToggle.checked;
    });
    for (const button of dom.demoButtons) {
      button.addEventListener('click', () => runDemoStep(button.dataset.step || ''));
    }

    dom.voiceToggle.addEventListener('change', () => toggleVoice(dom.voiceToggle.checked));
    dom.voiceSilence.addEventListener('click', stopSpeaking);
    if (synthesisAvailable()) {
      // Las voces llegan de forma asíncrona: al aparecer, el panel reconsidera el interruptor.
      window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    }
    setupMicrophone();

    window.addEventListener('online', () => loadState({ silent: true }));
    window.addEventListener('beforeunload', () => {
      closeStream();
      stopPolling();
    });
  }

  ui.token = readStoredToken();
  wire();
  renderAll();
  loadState({ silent: true });
  connectStream();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp, { once: true });
  } else {
    initApp();
  }
}
