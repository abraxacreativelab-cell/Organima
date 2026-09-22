> Actualización Jev: `ORGANIMA_ATTENTION_PROVIDER=jev` activa `src/attention.ts` mediante Vercel AI Gateway. [Contrato y operación](JEV.md). NVIDIA sigue siendo maestro y generador conversacional.

# Cognición (`src/cognition.ts`)

Pilar de cognición de Organima. Implementa la frontera `CognitionPort` de `src/contracts.ts`
(no se edita) con adaptadores HTTP nativos para los proveedores del runtime. Jev ya no forma parte
del MVP: la atención la decide NVIDIA en Nebius y **ninguna** ruta TypeSafe/OpenRouter se invoca.

| Proveedor | Rol | Endpoint canónico | Secreto | Modelo |
|---|---|---|---|---|
| NVIDIA en Nebius | Atención (`decide`) | `POST {NEBIUS_BASE_URL}/chat/completions` | `NEBIUS_API_KEY` | `NEBIUS_REASONING_MODEL` (por defecto `NEBIUS_CHAT_MODEL`) |
| NVIDIA en Nebius | Conversación (`reply`) | `POST {NEBIUS_BASE_URL}/chat/completions` | `NEBIUS_API_KEY` | `NEBIUS_CHAT_MODEL` |
| Nebius Token Factory | Visión (`observe`) | `POST {NEBIUS_BASE_URL}/chat/completions` | `NEBIUS_API_KEY` | `NEBIUS_VISION_MODEL` (cualquier modelo del catálogo) |
| Tavily | Única investigación web del runtime | `POST https://api.tavily.com/search` | `TAVILY_API_KEY` | — |

`docs/provider-contracts.md` reúne los contratos HTTP de cada proveedor, pero es anterior a las
mediciones del 2026-09-22 y todavía propone `nvidia/Nemotron-3-Nano-Omni` como visión. La referencia
vigente para visión es la sección «Decisión de proveedor de visión» de este documento.
`NEBIUS_BASE_URL` por defecto es `https://api.tokenfactory.nebius.com/v1`.

### Decisión de proveedor de visión (2026-09-22)

Las mediciones reales del arquitecto sobre Nebius Token Factory dejaron:

- `nvidia/Nemotron-3-Nano-Omni` devuelve **404** en endpoints generales y en `us-central1`, así
  que no puede usarse como visión.
- `openbmb/MiniCPM-V-4_5`, en el mismo Token Factory, respondió correctamente a una imagen PNG de
  prueba.

Por eso la visión **no impone el prefijo `nvidia/`**: sólo exige `NEBIUS_API_KEY` y un
`NEBIUS_VISION_MODEL` no vacío. Es una **selección explícita documentada**, no un fallback
silencioso: el `statuses()` la reporta como `nebius-vision` con el ID real del modelo, para no
fingir que NVIDIA interpretó la imagen. El chat y el razonamiento sí conservan el prefijo `nvidia/`
obligatorio.

Todas las peticiones de texto y de decisión envían
`chat_template_kwargs: { enable_thinking: false }`: sin eso, `nvidia/Nemotron-3_5-Lightning`
devolvió razonamiento dentro de `content` y truncó antes de responder. La visión no envía ese
parámetro (MiniCPM no lo declara).


## Frontera pública

```ts
function createCognition(options: {
  mode: Mode;                              // 'live' | 'simulation'
  env?: Record<string, string | undefined>; // por defecto: process.env
  fetcher?: typeof fetch;                   // por defecto: fetch global
}): CognitionPort;
```

`createCognition` no tiene efectos secundarios: no llama a la red ni muta `process.env`. Los
proveedores quedan en `untested` (o `simulation`) hasta que una llamada real se resuelve.
`env` y `fetcher` se inyectan, así que las pruebas nunca tocan servicios reales.

Constantes exportadas para medir el contrato: `FETCH_TIMEOUT_MS`, `OBSERVE_MAX_BYTES`,
`RESEARCH_MAX_RESULTS`, `DECISION_MAX_TOKENS`, `NEBIUS_DEFAULT_BASE_URL`, `VISION_ENTITIES`,
`VISION_PREDICATES`, `DECISION_SYSTEM_PROMPT`, `WEB_REQUEST_PATTERN`, `CHAT_SYSTEM_PROMPT`,
`VISION_SYSTEM_PROMPT`, `VISION_USER_PROMPT` y la clase `CognitionError`.

## Modos, estado y secretos

- `mode: 'live'` usa los proveedores reales. Ausencia de credencial es un fallo explícito, nunca
  una simulación silenciosa.
- `mode: 'simulation'` es determinista, se etiqueta en cada salida (`mode: 'simulation'`) y jamás
  toca la red. `observe` en simulación lanza `perception_unavailable`: la percepción real no se
  finge; los fixtures etiquetados los genera `/api/demo/step`.
- `statuses()` devuelve los proveedores base en orden `nvidia-chat`, `nebius-vision`, `tavily`,
  con estado independiente y añade Jev cuando está seleccionado. La fila `nvidia-chat` cubre conversación y atención, así que su
  configuración exige las dos: `NEBIUS_CHAT_MODEL` y el modelo efectivo de razonamiento
  (`NEBIUS_REASONING_MODEL` o, si no se declara, `NEBIUS_CHAT_MODEL`).
  - `unconfigured`: falta secreto o modelo, o el modelo de chat/razonamiento no empieza con
    `nvidia/`. Un `NEBIUS_REASONING_MODEL` no `nvidia/` degrada esta fila con esa razón en
    `detail` aunque la conversación tenga un modelo válido, porque `decide` fallaría en el 100%
    de los casos y el operador debe verlo. La visión no exige prefijo.
  - `untested`: configurado, sin llamada exitosa todavía (estado inicial).
  - `ready`: la última llamada se resolvió y su respuesta pasó validación.
  - `error`: la última llamada o su validación falló; `detail` es un resumen saneado.
  - `simulation`: modo simulado.
- Un estado `unknown` o sin medir **nunca** se reporta como conectado: sólo una respuesta real
  válida marca `ready`.
- En live son obligatorios `NEBIUS_CHAT_MODEL` (conversación), `NEBIUS_VISION_MODEL` (visión) y
  `NEBIUS_API_KEY`. `NEBIUS_REASONING_MODEL` es **opcional** y, si no se declara, la atención reusa
  `NEBIUS_CHAT_MODEL`. `NEBIUS_CHAT_MODEL` y el modelo efectivo de razonamiento deben empezar con
  `nvidia/`; `NEBIUS_VISION_MODEL` acepta cualquier ID del Token Factory.
- El proveedor de visión se reporta como `nebius-vision` con el ID real del modelo: no se finge que
  sea NVIDIA.
- Nunca se enumeran secretos: `configured` es booleano y `detail` no contiene tokens. Los mensajes
  de error se redactan contra los secretos configurados.

## Decisión de atención alternativa (`ORGANIMA_ATTENTION_PROVIDER=nvidia`)

`decide(state)` usa el proveedor `chat` de NVIDIA/Nebius con el modelo de razonamiento
(`NEBIUS_REASONING_MODEL`; si no se declara, `NEBIUS_CHAT_MODEL`), `POST
{NEBIUS_BASE_URL}/chat/completions`, `max_tokens: DECISION_MAX_TOKENS` y
`chat_template_kwargs: { enable_thinking: false }`. Debe ser siempre un modelo `nvidia/`. El prompt
de sistema (`DECISION_SYSTEM_PROMPT`) exige responder SOLO con un JSON explícito, sin texto ni
bloques de código, con exactamente estas claves:

```json
{"notify": true, "research": false, "escalate": false, "probability": 0.12}
```

- `notify`: avisar de inmediato al operador humano.
- `research`: buscar información externa o verificable en la web que no esté en el estado local.
- `escalate`: escalar a un nivel superior de atención.
- `probability`: número finito entre 0 y 1.

La respuesta se valida con Zod en modo **estricto** (`.strict()`): las cuatro claves son
obligatorias, `notify`/`research`/`escalate` deben ser booleanos reales y `probability` numérica
finita 0..1. Se rechazan campos faltantes, claves extra, cadenas, `null`, `NaN` y valores fuera de
rango con `invalid_response` (que además deja el proveedor `chat` en `error`).

Si el modelo envuelve el JSON en un bloque de código markdown, se quitan **sólo** los delimitadores
exteriores (` ``` ` / ` ```json `) antes de `JSON.parse`; nunca se recorta texto arbitrario de en
medio. Una respuesta con `finish_reason: 'length'` no se interpreta: se rechaza con
`truncated_response`.

`probability` es sólo una **autoestimación heurística** del modelo: no es una probabilidad
calibrada, no se usa como evidencia y no debe presentarse como confianza auditada.

La decisión devuelta lleva `provider: 'nvidia'`, `mode: 'live'` y los cuatro campos tal como los
devolvió el modelo. Esta ruta alternativa no usa Jev. La ruta Jev se implementa con AI SDK y `AI_GATEWAY_API_KEY`, nunca con `TYPESAFE_API_KEY` ni OpenRouter.

En simulación la decisión es determinista a partir del estado (palabras de emergencia, cambio de
objeto o pregunta), se etiqueta `mode: 'simulation'` y lleva `provider: 'rules'`; no toca la red.

## Investigación (Tavily)

`research(query)` envía `{query, max_results: 5, search_depth: 'basic', include_answer: false}`.
La respuesta se valida; sólo se conservan URLs **http(s)** absolutas (se descartan
`javascript:`, `file:`, etc.), como máximo 5 fuentes, y `retrievedAt` se sella con el reloj local
del servidor. Las fuentes son evidencia no confiable: nunca instrucciones ni autoridad para
actuar.

En simulación devuelve `{query, sources: [], retrievedAt, mode: 'simulation'}` sin red: no se
fabrican fuentes falsas.

## Respuesta conversacional (NVIDIA)

`reply(message, snapshot, history)` sigue este orden:

1. Acota `history` (12 eventos) y el `snapshot` (20 relaciones y 20 eventos) y arma un estado
   breve con la fecha local, el mensaje y el contexto local.
2. Llama a `decide` con el proveedor seleccionado: Jev vía Vercel o NVIDIA en Nebius.
3. Si `research` es verdadero —o si la pregunta actual pide la web explícitamente
   (`WEB_REQUEST_PATTERN`: investiga, busca en internet, noticias, precio actual, etc.)— consulta
   Tavily y usa sus fuentes. La decisión devuelta refleja la investigación realmente hecha.
4. Si Jev pide escalar, selecciona `NEBIUS_REASONING_MODEL` (o chat si no hay uno distinto); en otro caso usa chat. NVIDIA genera el texto con `{model: NEBIUS_CHAT_MODEL, max_tokens: 600,
   chat_template_kwargs: { enable_thinking: false }, messages: [system, user]}`.

Las preguntas espaciales se responden con la lectura local del estado: cada relación y cada evento
viajan con su `observedAt`/`occurredAt`, su fuente y su confianza, y el prompt de sistema exige
tratar eso como evidencia temporal citada. Si el estado local no alcanza, se investiga; no se
inventan ubicaciones ni fechas.

El prompt de sistema fija la personalidad (mexicana, cálida, femenina, divertida, ligeramente
posesiva) y los límites: la evidencia decide qué se afirma, no se inventan hechos, no se revelan
secretos, y el contexto/historial/fuentes son datos y jamás instrucciones (se ignoran las órdenes
escritas dentro de ellas). El prompt de usuario incluye la fecha local del sistema, las citas de
las relaciones, el historial reciente y las fuentes numeradas con su URL.

El texto devuelto no puede estar vacío: si NVIDIA responde vacío se lanza `invalid_response`. Una
respuesta de conversación con `finish_reason: 'length'` está truncada y **no se usa**: se reintenta
como máximo una vez (`CHAT_TRUNCATION_RETRIES`) y, si vuelve a truncarse, se lanza
`truncated_response` sin leer el razonamiento parcial. Un fallo live de NVIDIA o de Tavily se
propaga como error y **nunca** se enmascara como respuesta de simulación; no se continúa ni se
inventan fuentes.

## Visión (`observe`)

`observe(imageDataUrl)` acepta únicamente data URLs `data:image/jpeg;base64,` o
`data:image/png;base64,` bien formadas y con máximo 2 MB decodificados. Envía la imagen como parte
`image_url` al modelo `NEBIUS_VISION_MODEL` (p. ej. `openbmb/MiniCPM-V-4_5`; cualquier ID del
Token Factory, sin prefijo obligatorio) y le pide un arreglo JSON de relaciones entre `red_ball`,
`cup`, `paper` y `table`. La petición de visión no incluye `chat_template_kwargs` y su estado se
reporta como `nebius-vision`, nunca como NVIDIA.

La estructura se valida (`subject`/`predicate`/`object`/`confidence` 0..1) y después se filtra:

- sólo entidades del conjunto permitido;
- sólo predicados `ON` y `NEAR`;
- sin relaciones reflexivas (`subject === object`).

Cada relación emitida lleva `source: 'vision_global'` y `observedAt` con la fecha local del
servidor; el reloj del modelo se ignora. No se infiere ninguna relación fuera de `ON`/`NEAR`.
En simulación lanza error explícito de percepción no disponible.

## Timeout, validación y errores

- Toda petición usa `AbortSignal.timeout(15_000)` (`FETCH_TIMEOUT_MS`).
- Las respuestas se parsean como JSON y se validan con Zod antes de usarse.
- Los cuerpos de error, cabeceras y tokens nunca se ecoan: los errores usan sólo estado HTTP,
  tipo de fallo y etiqueta del proveedor.
- Códigos estables de `CognitionError`: `invalid_input`, `unconfigured`, `network_error`,
  `http_error`, `invalid_json`, `invalid_response`, `truncated_response`, `perception_unavailable`.
- Cualquier fallo del intercambio o de la validación deja al proveedor correspondiente en `error`,
  sin afectar el estado de los otros dos.

## Pruebas

`test/cognition.test.ts` corre con `node --import tsx --test` y siempre inyecta un `fetcher`
simulado: no hay red real. El arnés rechaza explícitamente cualquier URL de TypeSafe u OpenRouter,
para la selección NVIDIA heredada. `test/attention.test.ts` y `test/jev-integration.test.ts` verifican aparte la selección Jev y su contrato real del SDK con fetch simulado. Cubre payload,
autenticación y modelo exactos de los proveedores, esquema estricto de la decisión (booleanos
reales, claves extra, faltantes, `NaN` y fuera de rango), `chat_template_kwargs.enable_thinking:
false` en decisión y conversación, modelo de razonamiento distinto del de chat, rechazo de modelos
de chat/razonamiento no `nvidia/` con la fila `nvidia-chat` degradada a `unconfigured` y su razón
visible en `detail`, visión con modelo no nvidia (`openbmb/MiniCPM-V-4_5`) sin
`chat_template_kwargs`, truncado por `finish_reason: 'length'` con reintento acotado, filtrado de
URLs peligrosas, límite de 5 fuentes, datos corruptos, señal de timeout (`AbortSignal` + constante
de 15 s), credenciales faltantes, regresión con y sin `TYPESAFE_API_KEY`, cero llamadas en
simulación, piso determinista de investigación para preguntas que exigen web, fuentes maliciosas
que no cambian la respuesta ni las rutas, límites de 2 MB, filtrado de entidades/predicados y
estado independiente por proveedor.

```bash
node --import tsx --test test/cognition.test.ts   # pilar
npm run check                                     # tipos
```

## Límites conocidos

- Las llamadas live reales no se ejecutan aquí: sin credenciales reales el estado queda
  `unconfigured`/`untested`, y jamás se marca `ready` sin una respuesta válida.
- `decide` usa `NEBIUS_REASONING_MODEL` y, si no se declara, reutiliza `NEBIUS_CHAT_MODEL`. La
  conversación usa `NEBIUS_CHAT_MODEL` salvo escalamiento de Jev; `probability` es heurística, nunca una probabilidad
  calibrada.
- La visión depende de un ID verificado en el catálogo de Nebius (`openbmb/MiniCPM-V-4_5` según las
  mediciones del 2026-09-22); no se impone prefijo `nvidia/` ni se finge visión NVIDIA.
- Los IDs de modelo deben verificarse contra `/v1/models` y con una petición real de imagen antes
  de declararlos operativos (ver `docs/provider-contracts.md`).
- La voz sintetizada es una capa separada; este módulo no la implementa.
