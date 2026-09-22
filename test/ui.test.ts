/**
 * Pruebas de la interfaz de Organima.
 *
 * Verifican dos cosas separables:
 *  1. La estructura y la seguridad de los archivos entregados (HTML, CSS, JS).
 *  2. El contrato de las funciones puras exportadas por `public/app.js`, que se
 *     importan en Node sin tocar el DOM ni la red.
 *
 * Ejecutar: node --import tsx --test test/ui.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  API_ROUTES,
  DEMO_STEPS,
  MAX_IMAGE_BYTES,
  TOKEN_STORAGE_KEY,
  buildAuthHeaders,
  demoStepAllowed,
  eventTime,
  formatModeClass,
  formatModeLabel,
  formatTimestamp,
  hashToUnit,
  humanBytes,
  isSafeHttpUrl,
  layoutPositions,
  memorySummary,
  nextReconnectDelay,
  normalizeChatReply,
  normalizeMode,
  normalizeProvider,
  normalizeRelationList,
  normalizeResearchResult,
  normalizeState,
  pickVoice,
  providerHealth,
  redactSecrets,
  relationLabel,
  safeLinkTarget,
  speakWithVoice,
  summarizePayload,
  truncate,
  validateImageFile,
  voiceProfile
} from '../public/app.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const ux = readFileSync(new URL('../docs/UX.md', import.meta.url), 'utf8');

/** Identificadores que el panel usa y que el JavaScript debe cablear. */
const WIRED_IDS = [
  'mode-badge',
  'connection-status',
  'stop-button',
  'token-form',
  'token-input',
  'token-clear',
  'memories',
  'cells',
  'providers',
  'scene',
  'scene-meta',
  'scene-caption',
  'chat-log',
  'chat-empty',
  'chat-form',
  'chat-input',
  'chat-send',
  'chat-status',
  'chat-evidence',
  'chat-hint',
  'research-form',
  'research-input',
  'research-submit',
  'research-status',
  'research-results',
  'observe-form',
  'observe-input',
  'observe-submit',
  'observe-status',
  'observe-preview',
  'observe-preview-wrap',
  'goal-form',
  'goal-object',
  'goal-target',
  'goal-submit',
  'goal-status',
  'timeline-list',
  'timeline-empty',
  'refresh-button',
  'toggle-demo',
  'demo-panel',
  'demo-note',
  'demo-reset',
  'demo-move',
  'demo-verify',
  'voice-toggle',
  'voice-silence',
  'voice-name',
  'voice-warn',
  'mic-button',
  'mic-status',
  'status-region',
  'alert-region',
  'app-status'
];

/** Textos estáticos que la estructura debe exhibir en español. */
const STATIC_TEXT_IDS = ['token-note', 'providers-note', 'observe-hint', 'voice-note'];

describe('estructura de index.html', () => {
  it('declara documento en español con codificación y viewport', () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /name="viewport"[^>]*width=device-width/);
    assert.match(html, /<title>[^<]*Organima[^<]*<\/title>/);
  });

  it('carga sólo recursos locales como módulo', () => {
    assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
    assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  });

  it('no usa CDN ni recursos externos', () => {
    const externalAttributes = html.match(/(?:src|href)="(?:https?:)?\/\//g) || [];
    assert.deepEqual(externalAttributes, []);
    assert.ok(!/cdn\./i.test(html), 'no debe citar CDNs');
    assert.ok(!/<script[^>]*src="http/i.test(html), 'el script debe ser local');
  });

  it('incluye todos los identificadores cableados y los textos estáticos', () => {
    for (const id of [...WIRED_IDS, ...STATIC_TEXT_IDS]) {
      assert.ok(html.includes(`id="${id}"`), `falta id="${id}" en index.html`);
    }
  });

  it('muestra el modo de forma visible y honesta al arrancar', () => {
    assert.match(html, /id="mode-badge"[^>]*>\s*ESTADO DESCONOCIDO/);
    assert.ok(!/id="mode-badge"[^>]*>\s*LIVE/.test(html), 'no debe declarar LIVE sin evidencia');
  });

  it('mantiene la parada accesible y la demo oculta por defecto', () => {
    assert.match(html, /<button id="stop-button"[^>]*>[\s\S]*Detener/);
    assert.match(
      html,
      /id="stop-button"[^>]*title="Solicitar parada"/,
      'el título aclara que envía una orden, no que sea la parada física del robot'
    );
    assert.ok(!/<button id="stop-button"[^>]*disabled/.test(html), 'Detener nunca arranca deshabilitado');
    assert.ok(
      !/stopButton\.disabled\s*=\s*true/.test(app),
      'Detener no se deshabilita en tiempo de ejecución: la parada siempre está disponible'
    );
    assert.match(app, /requestStop/);
    assert.match(html, /<div id="demo-panel"[^>]*hidden/);
    assert.match(html, /Escenario simulado/);
    assert.ok(app.includes("state === 'simulation'") || app.includes('demoStepAllowed'), 'la demo se filtra por modo');
  });

  it('el objetivo sólo ofrece lo soportado: pelota roja → hoja', () => {
    const values = [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(values)].sort(), ['paper', 'red_ball']);
    assert.ok(!/value="(?:cup|shelf)"/.test(html), 'sin taza ni estante: el MVP no los soporta');
    assert.ok(!/\bTaza\b|\bEstante\b/.test(html), 'sin opciones que prometan objetivos inexistentes');
    assert.match(html, /id="goal-hint"[\s\S]*pelota roja sobre hoja/i);
  });

  it('respeta accesibilidad básica: salto, regiones vivas y etiquetas', () => {
    assert.match(html, /class="skip-link"/);
    assert.match(html, /id="status-region"[^>]*aria-live="polite"/);
    assert.match(html, /id="alert-region"[^>]*role="alert"/);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /<img id="observe-preview" alt="[^"]+">/, 'la vista previa lleva alt descriptivo');
  });

  it('explica en la interfaz las reglas de honestidad sin jerga técnica', () => {
    assert.match(html, /Acceso para controlar esta demostración\. Se conserva sólo en esta pestaña\./);
    assert.match(html, /NVIDIA genera texto/);
    assert.match(html, /nunca significa conectado/i);
    assert.match(html, /2 MB/);
    assert.ok(!html.includes('sessionStorage'), 'el recorrido no menciona el almacenamiento interno');
    assert.ok(!html.includes('X-Organima-Token'), 'el recorrido no menciona la cabecera interna');
  });
});

describe('seguridad de los archivos del panel', () => {
  it('app.js no usa superficies de inyección de HTML ni evaluación dinámica', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.ok(!app.includes(forbidden), `app.js no debe usar ${forbidden}`);
    }
    assert.ok(app.includes('textContent'), 'app.js debe escribir texto externo con textContent');
  });

  it('app.js no importa módulos externos ni frameworks', () => {
    const imports = [...app.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map(m=>m[1]);
    assert.deepEqual(imports, ['./vision.js'], 'sólo importa el módulo local de cámara');
    assert.ok(!app.includes('require('), 'no debe usar require');
    assert.ok(!/from ['"]https?:/.test(app), 'no debe importar URLs');
  });

  it('guarda el token sólo en sessionStorage y nunca claves de API', () => {
    assert.ok(app.includes('sessionStorage'), 'el token vive en sessionStorage');
    assert.ok(!app.includes('localStorage'), 'nunca se persiste en localStorage');
    assert.ok(app.includes(TOKEN_STORAGE_KEY), 'la clave de sesión debe ser explícita');
    assert.ok(!/API_KEY/.test(app), 'el navegador no debe manejar claves de API');
  });

  it('sólo presenta enlaces http(s) con noopener', () => {
    assert.match(app, /link\.rel = target\.rel;/, 'el enlace copia el rel que devuelve el validador');
    assert.ok(app.includes("'noopener noreferrer'"), 'la firma segura declara noopener noreferrer');
    assert.ok(app.includes('safeLinkTarget'), 'los enlaces pasan por el validador');
  });

  it('styles.css evita recursos remotos y contempla móvil y movimiento reducido', () => {
    assert.ok(!/@import\s+url\(/.test(css), 'sin @import remoto');
    assert.ok(!/https?:\/\//.test(css), 'sin URLs en CSS');
    assert.match(css, /@media \(max-width: 560px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /:root\s*\{/);
    assert.match(css, /overflow-x: hidden/);
    assert.match(css, /min-width: 0/);
  });
});

describe('helpers puros: modo y honestidad', () => {
  it('etiqueta el modo y nunca disfraza lo desconocido de LIVE', () => {
    assert.equal(normalizeMode('live'), 'live');
    assert.equal(normalizeMode('simulation'), 'simulation');
    assert.equal(normalizeMode('LIVE'), null);
    assert.equal(normalizeMode(undefined), null);
    assert.equal(formatModeLabel('live'), 'LIVE');
    assert.equal(formatModeLabel('simulation'), 'SIMULACIÓN');
    assert.equal(formatModeLabel(null), 'ESTADO DESCONOCIDO');
    assert.equal(formatModeClass('live'), 'badge--live');
    assert.equal(formatModeClass('simulation'), 'badge--simulation');
    assert.equal(formatModeClass(null), 'badge--unknown');
  });

  it('describe la salud de proveedores: «untested» nunca está conectado', () => {
    for (const state of ['untested', 'unconfigured', 'error', 'simulation', undefined, 'inventado']) {
      const health = providerHealth(state);
      assert.equal(health.connected, false, `${state} no puede considerarse conectado`);
      assert.ok(health.hint.length > 10, 'cada salud explica su significado');
    }
    assert.equal(providerHealth('ready').connected, true);
    assert.match(providerHealth('untested').hint, /nunca se ha conectado/i);
    assert.equal(providerHealth('simulation').tone, 'sim');
  });

  it('las acciones de demo sólo existen en modo simulación', () => {
    for (const step of DEMO_STEPS) {
      assert.equal(demoStepAllowed('simulation', step), true);
      assert.equal(demoStepAllowed('live', step), false);
      assert.equal(demoStepAllowed(null, step), false);
    }
    assert.equal(demoStepAllowed('simulation', 'otro'), false);
  });
});

describe('helpers puros: seguridad', () => {
  it('acepta sólo URLs http(s)', () => {
    assert.equal(isSafeHttpUrl('https://example.org/a'), true);
    assert.equal(isSafeHttpUrl('http://localhost:3210/x'), true);
    assert.equal(isSafeHttpUrl('  https://example.org/b  '), true);
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('data:text/html;base64,PHNjcmlwdD4='), false);
    assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
    assert.equal(isSafeHttpUrl('no es una url'), false);
    assert.equal(isSafeHttpUrl(''), false);
    assert.equal(isSafeHttpUrl(null), false);
  });

  it('construye enlaces externos con noopener y target _blank', () => {
    assert.deepEqual(safeLinkTarget('https://example.org/a'), {
      href: 'https://example.org/a',
      target: '_blank',
      rel: 'noopener noreferrer'
    });
    assert.equal(safeLinkTarget('javascript:alert(1)'), null);
  });

  it('redacta credenciales antes de mostrar un error', () => {
    assert.equal(redactSecrets('sin secretos'), 'sin secretos');
    const bearer = redactSecrets('Fallo con Bearer tvly-abcdef123456 al consultar');
    assert.ok(!bearer.includes('tvly-abcdef123456'), 'el token no debe sobrevivir');
    assert.ok(bearer.includes('[oculto]'));
    const apiKey = redactSecrets('clave sk-viva-1234567890 rechazada');
    assert.ok(!apiKey.includes('sk-viva-1234567890'));
    const jwt = redactSecrets('cabecera eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij');
    assert.ok(!jwt.includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.equal(redactSecrets(null), '');
  });

  it('envía X-Organima-Token sólo cuando hay token', () => {
    assert.deepEqual(buildAuthHeaders(''), {});
    assert.deepEqual(buildAuthHeaders('   '), {});
    assert.deepEqual(buildAuthHeaders(null), {});
    assert.deepEqual(buildAuthHeaders('  s3creto  '), { 'X-Organima-Token': 's3creto' });
  });

  it('valida la foto: máximo 2 MB y nada de SVG', () => {
    assert.equal(MAX_IMAGE_BYTES, 2 * 1024 * 1024);
    assert.equal(validateImageFile({ type: 'image/jpeg', size: 1024 }).ok, true);
    assert.equal(validateImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES }).ok, true);
    assert.equal(validateImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }).ok, false);
    assert.equal(validateImageFile({ type: 'image/svg+xml', size: 100 }).ok, false);
    assert.equal(validateImageFile({ type: 'application/pdf', size: 100 }).ok, false);
    assert.equal(validateImageFile({ type: 'image/png', size: 0 }).ok, false);
    assert.equal(validateImageFile(null).ok, false);
    assert.match(validateImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }).message, /2\.00 MB/);
    assert.equal(humanBytes(512), '512 B');
    assert.equal(humanBytes(2048), '2.0 KB');
    assert.match(humanBytes(MAX_IMAGE_BYTES), /MB$/);
  });
});

describe('helpers puros: normalización de datos del servidor', () => {
  it('convierte basura en un estado seguro sin lanzar', () => {
    const state = normalizeState(null);
    assert.deepEqual(state.mode, null);
    assert.equal(state.graph.version, 0);
    assert.deepEqual(state.graph.relations, []);
    assert.deepEqual(state.graph.events, []);
    assert.deepEqual(state.cells, []);
    assert.deepEqual(state.providers, []);
    assert.equal(state.robot, null);
    assert.doesNotThrow(() => normalizeState('texto'));
    assert.doesNotThrow(() => normalizeState({ graph: 42, cells: 'no', providers: {} }));
  });

  it('normaliza el estado completo y descarta registros inválidos', () => {
    const state = normalizeState({
      mode: 'simulation',
      graph: {
        version: 7,
        relations: [
          { subject: 'red_ball', predicate: 'ON', object: 'paper', observedAt: '2026-09-22T01:00:00Z', source: 'camara', confidence: 1.4 },
          { subject: 3, predicate: 'ON', object: 'x' }
        ],
        events: [
          { id: 'e1', type: 'observation', cellId: 'vision', occurredAt: '2026-09-22T01:00:00Z', mode: 'simulation', payload: { object: 'red_ball' } },
          { type: 'sin-id' }
        ]
      },
      cells: [{ id: 'vision', parentId: null, name: 'Visión', capabilities: ['observe'], status: 'ready', mode: 'simulation' }, {}],
      providers: [{ name: 'tavily', configured: true, state: 'ready' }, { name: '' }],
      robot: { goal:{id:'g1',cellId:'robot',object:'red_ball',target:'paper',relation:'ON',deadline:'2026-09-22T01:01:00Z',mode:'simulation'},state:'running',updatedAt:'2026-09-22T01:00:00Z' }
    });
    assert.equal(state.mode, 'simulation');
    assert.equal(state.graph.version, 7);
    assert.equal(state.graph.relations.length, 1);
    assert.equal(state.graph.relations[0].confidence, 1);
    assert.equal(state.graph.events.length, 1);
    assert.equal(state.cells.length, 1);
    assert.equal(state.providers.length, 1);
    assert.equal(state.robot.goal.id, 'g1');
    assert.equal(state.robot.state, 'running');
  });

  it('exige el modo del proveedor del catálogo y jamás marca ready por accidente', () => {
    const provider = normalizeProvider({ name: 'nebius', state: 'ready' });
    assert.equal(provider.state, 'ready');
    assert.equal(normalizeProvider({ name: 'x', state: 'telepático' }).state, 'untested');
    assert.equal(normalizeProvider({ name: 'x' }).configured, false);
    assert.equal(normalizeProvider(null), null);
  });

  it('rechaza respuestas de chat sin texto y etiqueta la simulación', () => {
    assert.equal(normalizeChatReply({ text: '   ' }), null);
    assert.equal(normalizeChatReply(null), null);
    assert.equal(normalizeChatReply('hola'), null);
    const reply = normalizeChatReply({
      text: 'Hola, aquí estoy.',
      mode: 'simulation',
      model: 'nemotron',
      sources: [{ title: 'Fuente', url: 'javascript:alert(1)', content: 'texto', score: 0.5 }],
      decision: { notify: true, research: false, escalate: false, probability: 2, provider: 'jev' }
    });
    assert.equal(reply.text, 'Hola, aquí estoy.');
    assert.equal(reply.mode, 'simulation');
    assert.equal(reply.decision.probability, 1);
    assert.equal(reply.decision.notify, true);
    assert.equal(reply.sources[0].safeUrl, '');
  });

  it('normaliza resultados de investigación y conserva sólo el enlace seguro', () => {
    assert.equal(normalizeResearchResult(null), null);
    const result = normalizeResearchResult({
      query: 'taza',
      retrievedAt: '2026-09-22T01:00:00Z',
      mode: 'live',
      sources: [
        { title: 'Buena', url: 'https://example.org/a', content: 'c', score: 0.9 },
        { title: 'Mala', url: 'data:text/html,x', content: 'c', score: 0.1 }
      ]
    });
    assert.equal(result.query, 'taza');
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].safeUrl, 'https://example.org/a');
    assert.equal(result.sources[1].safeUrl, '');
  });

  it('normaliza listas de relaciones de la observación', () => {
    const relations = normalizeRelationList({
      relations: [{ subject: 'cup', predicate: 'ON', object: 'table', confidence: 0.8, source: 'foto', observedAt: '' }]
    });
    assert.equal(relations.length, 1);
    assert.equal(relationLabel(relations[0]), 'cup ON table');
    assert.deepEqual(normalizeRelationList('nada'), []);
    assert.deepEqual(normalizeRelationList(null), []);
  });
});

describe('helpers puros: presentación', () => {
  it('resume las tres memorias y admite lo que la API no expone', () => {
    const memories = memorySummary({
      mode: 'simulation',
      graph: {
        version: 3,
        relations: [{ subject: 'a', predicate: 'ON', object: 'b', confidence: 1, source: 's', observedAt: '' }],
        events: [{ id: 'e1', type: 'observation', cellId: 'vision', occurredAt: '', mode: 'simulation', payload: {} }]
      },
      cells: [{ id: 'vision', name: 'Visión', capabilities: [], status: 'ready', mode: 'simulation' }]
    });
    assert.equal(memories.length, 3);
    assert.deepEqual(memories.map((memory) => memory.id), ['context', 'graph', 'knowledge']);
    assert.match(memories[0].metric, /1 fuente con eventos/);
    assert.match(memories[1].metric, /v3/);
    assert.match(memories[2].note, /conservados en Git/);
  });

  it('trata fechas inválidas sin romper la cronología', () => {
    assert.equal(formatTimestamp('no es fecha'), 'fecha desconocida');
    assert.equal(formatTimestamp(null), 'fecha desconocida');
    assert.equal(formatTimestamp(''), 'fecha desconocida');
    assert.ok(formatTimestamp('2026-09-22T01:00:00Z').length > 4);
    assert.equal(eventTime({ occurredAt: '' }), 0);
    assert.equal(eventTime(null), 0);
    assert.equal(eventTime({ occurredAt: 'ayer' }), 0);
    assert.ok(eventTime({ occurredAt: '2026-09-22T01:00:00Z' }) > 0);
    const ordered = [
      { occurredAt: '' },
      { occurredAt: '2026-09-22T02:00:00Z' },
      { occurredAt: '2026-09-22T01:00:00Z' }
    ].sort((a, b) => eventTime(b) - eventTime(a));
    assert.equal(ordered[2].occurredAt, '');
  });

  it('resume el payload de un evento con límite', () => {
    assert.equal(summarizePayload(null), 'sin datos');
    assert.equal(summarizePayload({}), 'sin datos');
    const summary = summarizePayload({ object: 'red_ball', confidence: 0.9 });
    assert.match(summary, /object: red_ball/);
    assert.ok(summarizePayload({ texto: 'x'.repeat(400) }).length <= 140);
    assert.equal(truncate('abc', 2), 'a…');
    assert.equal(truncate('abc', 10), 'abc');
  });

  it('ofrece posiciones deterministas y dentro del lienzo', () => {
    const first = layoutPositions(['a', 'b', 'c']);
    const second = layoutPositions(['a', 'b', 'c']);
    assert.deepEqual(first, second);
    assert.equal(Object.keys(first).length, 3);
    for (const point of Object.values(first)) {
      assert.ok(point.x >= 0 && point.x <= 640, 'x dentro del viewBox');
      assert.ok(point.y >= 0 && point.y <= 400, 'y dentro del viewBox');
    }
    assert.deepEqual(layoutPositions(['a', 'a']).a, layoutPositions(['a']).a);
    const unit = hashToUnit('vision');
    assert.ok(unit >= 0 && unit < 1);
    assert.equal(hashToUnit('vision'), unit);
  });

  it('prefiere voz es-MX femenina y advierte cuando no existe', () => {
    const voices = [
      { name: 'Jorge', lang: 'es-ES' },
      { name: 'Alex', lang: 'en-US' },
      { name: 'Paulina', lang: 'es-MX' }
    ];
    assert.equal(pickVoice(voices).name, 'Paulina');
    const good = voiceProfile(voices);
    assert.equal(good.available, true);
    assert.equal(good.isMexican, true);
    assert.match(good.message, /Paulina/);
    assert.match(good.message, /es-MX/);

    const onlySpanish = voiceProfile([{ name: 'Mónica', lang: 'es-ES' }, { name: 'Alex', lang: 'en-US' }]);
    assert.equal(onlySpanish.available, true);
    assert.equal(onlySpanish.isMexican, false);
    assert.match(onlySpanish.message, /No hay voz es-MX/);

    const noSpanish = voiceProfile([{ name: 'Alex', lang: 'en-US' }]);
    assert.equal(noSpanish.available, false);
    assert.equal(noSpanish.voice, null);
    assert.match(noSpanish.message, /español/);

    assert.equal(pickVoice([]), null);
    assert.equal(voiceProfile([]).available, false);
    assert.equal(pickVoice(null), null);
  });

  it('sin voz utilizable no se llama a speak: nunca habla con la voz por defecto', () => {
    const calls = [];
    const result = speakWithVoice(
      {
        enabled: true,
        voice: null,
        createUtterance: (text) => {
          calls.push(['crear', text]);
          return {};
        },
        speak: (utterance) => calls.push(['hablar', utterance])
      },
      'No debería sonar'
    );
    assert.deepEqual(result, { spoken: false, reason: 'no-voice' });
    assert.deepEqual(calls, [], 'ni se crea la locución ni se entrega al sintetizador');
  });

  it('con voz disponible crea la locución con esa voz y la entrega al sintetizador', () => {
    const spokenUtterances = [];
    const voice = { name: 'Paulina', lang: 'es-MX' };
    const result = speakWithVoice(
      {
        enabled: true,
        voice,
        createUtterance: (text) => ({ text }),
        speak: (utterance) => spokenUtterances.push(utterance)
      },
      'Hola'
    );
    assert.deepEqual(result, { spoken: true, reason: 'spoken' });
    assert.equal(spokenUtterances.length, 1);
    assert.equal(spokenUtterances[0].text, 'Hola');
    assert.equal(spokenUtterances[0].voice, voice);
    assert.equal(spokenUtterances[0].lang, 'es-MX');
  });

  it('con la lectura apagada o sin síntesis tampoco se habla', () => {
    const calls = [];
    const voice = { name: 'Paulina', lang: 'es-MX' };
    assert.deepEqual(
      speakWithVoice({ enabled: false, voice, createUtterance: () => ({}), speak: () => calls.push(1) }, 'x'),
      { spoken: false, reason: 'disabled' }
    );
    assert.deepEqual(
      speakWithVoice({ enabled: true, voice, createUtterance: null, speak: null }, 'x'),
      { spoken: false, reason: 'synthesis-unavailable' }
    );
    assert.deepEqual(calls, [], 'nunca se entrega nada al sintetizador');
  });

  it('cablea el guardián probado y apaga el interruptor cuando no hay voz', () => {
    assert.match(app, /speakWithVoice\(/, 'speak() delega en la función probada');
    assert.match(app, /ui\.voiceEnabled = false/, 'sin voz, la lectura queda apagada');
    assert.match(app, /dom\.voiceToggle\.checked = false/, 'sin voz, el interruptor se desmarca');
    assert.match(app, /dom\.voiceToggle\.disabled = true/, 'sin voz, el interruptor se deshabilita');
  });

  it('acota el reintento de la conexión', () => {
    assert.equal(nextReconnectDelay(0), 1000);
    assert.equal(nextReconnectDelay(1), 2000);
    assert.equal(nextReconnectDelay(2), 4000);
    assert.equal(nextReconnectDelay(99), 30000);
    assert.equal(nextReconnectDelay(-5), 1000);
  });
});

describe('contrato de integración', () => {
  it('declara todas las rutas de la API acordada', () => {
    assert.deepEqual(API_ROUTES, {
      state: '/api/state',
      events: '/api/events',
      chat: '/api/chat',
      research: '/api/research',
      observe: '/api/observe',
      goals: '/api/goals',
      stop: '/api/stop',
      demoStep: '/api/demo/step'
    });
  });

  it('cablea en app.js todos los identificadores de la estructura', () => {
    for (const id of WIRED_IDS) {
      assert.ok(app.includes(`'${id}'`), `app.js debe referirse al elemento #${id} como cadena exacta`);
    }
  });

  it('importa en Node sin efectos sobre el DOM', () => {
    assert.equal(typeof globalThis.document, 'undefined', 'document no debe existir en Node');
    assert.equal(typeof globalThis.window, 'undefined', 'window no debe existir en Node');
    assert.equal(typeof pickVoice, 'function');
    assert.equal(typeof validateImageFile, 'function');
    assert.equal(typeof normalizeState, 'function');
  });

  it('documenta la experiencia en docs/UX.md', () => {
    assert.ok(ux.length > 800, 'el documento debe explicar la interfaz con detalle');
    for (const topic of ['LIVE', 'SIMULACIÓN', 'móvil', 'accesibilidad', 'memoria', 'evidencia', 'Tavily', 'voz', 'X-Organima-Token', 'sessionStorage']) {
      assert.ok(ux.includes(topic), `docs/UX.md debe tratar «${topic}»`);
    }
  });
});
