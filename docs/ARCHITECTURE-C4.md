# Organima — arquitectura C4

Fecha: 22 de septiembre de 2026. Base de código: `33699e2`, rama `feat/voice-latency-lab`. Este documento describe la implementación inspeccionada, no promete que todos los componentes estén desplegados juntos. La robótica que se construye en otra conversación queda fuera de esta verificación.

## Cómo leer el mapa

Los cuatro niveles amplían el mismo sistema: **contexto → contenedores → componentes → código**. “Contenedor” significa aplicación ejecutable o almacén de datos; no implica Docker. Las flechas indican quién inicia la interacción y llevan su propósito o protocolo. Una flecha discontinua marcada **pendiente** es una integración propuesta. Las implementaciones en modo simulación no son evidencia de funcionamiento físico.

| Área | Estado en esta revisión |
|---|---|
| Núcleo Organima | TypeScript/Express; memoria, conversación, observación y objetivos implementados. Puede arrancar en `simulation` o `live`. |
| Demo pública | Despliegue separado del laboratorio; última verificación anterior en simulación. No se volvió a verificar su versión durante esta documentación. |
| Laboratorio conversacional | Aplicación local independiente; NVIDIA y ElevenLabs Agents completos probados con servicios reales en el trabajo previo. Rama de PR, no integrado en la demo pública. |
| Robot | Máquina de estados y simulador implementados. El adaptador de esta rama rechaza objetivos en modo real porque no tiene conexión física. |
| Visión | MiniCPM en Nebius. **No es actualmente un modelo NVIDIA.** |
| Jev / Prime Agent | Jev excluido; Prime Agent evaluado como propuesta, sin integración en el código. |

## Nivel 1 · Contexto del sistema

Organima permite que un operador converse, observe un entorno, consulte recuerdos y asigne un objetivo acotado. El laboratorio forma parte del proyecto, pero tiene sesiones y datos separados del núcleo.

```mermaid
flowchart TB
  U["Santiago / operador
Persona: conversa, observa, ordena y detiene"]
  O["ORGANIMA
Sistema software
Núcleo con memoria + laboratorio de voz aislado"]
  N["Nebius Token Factory
Sistema externo
Inferencia NVIDIA y MiniCPM"]
  S["NVIDIA Speech / NVCF
Sistema externo
Reconocimiento Riva + síntesis Magpie"]
  E["ElevenLabs
Sistema externo
Agents completo y API de síntesis"]
  T["Tavily
Sistema externo
Investigación web con fuentes"]
  G["GitHub · Organima
Sistema externo
Código y conocimiento estable revisado"]
  R["Robot físico / Jetson / Arduino
Sistema externo pendiente de conexión
Movimiento y seguridad local"]
  U -->|"Interfaz web, micrófono, imágenes y objetivos"| O
  O -->|"HTTPS: razonamiento, conversación y visión"| N
  O -->|"Laboratorio: audio por gRPC TLS / HTTPS"| S
  O -->|"Laboratorio: WebRTC; núcleo: TTS por HTTPS"| E
  O -->|"HTTPS: consultas y recuperación de fuentes"| T
  U -->|"Revisión y publicación del proyecto"| G
  G -->|"Git: código y knowledge al preparar el despliegue"| O
  O <-.->|"PENDIENTE: objetivos, parada y telemetría"| R
```

**Frontera de responsabilidad.** Tavily es el puente de investigación sobre el mundo exterior; no sustituye los servicios de inferencia, audio ni Git. NVIDIA Speech usa credenciales y endpoints distintos de Nebius. Los modelos de ElevenLabs Agents se ejecutan dentro de la plataforma de ElevenLabs. GitHub no recibe consultas por cada turno de conversación.

## Nivel 2 · Contenedores y ubicación

### 2A · Núcleo

El núcleo es un monolito modular: sus células lógicas no son microservicios independientes. El grafo y los contextos viven dentro del proceso del servidor; el journal y los archivos de conocimiento sí tienen almacenamiento propio.

```mermaid
flowchart TB
  U["Operador"]
  subgraph B["Dispositivo del operador"]
    UI["Web Organima
Contenedor: HTML / JavaScript
Panel, chat, cámara y objetivos"]
  end
  subgraph H["Host del núcleo · VPS de la demo / host local"]
    P["Entrada HTTPS
Nginx / TLS en VPS"]
    A["API Organima
Contenedor: Node.js + Express
src/server.ts · puerto 3210 por defecto
PM2 en VPS"]
    J[("Journal de eventos
Contenedor: archivos JSONL
runtime / modo / events.jsonl")]
    K[("Conocimiento estable
Contenedor: archivos versionados
knowledge/identity.md + objects.json")]
  end
  N["Nebius
NVIDIA: maestro, atención, conversación
MiniCPM: visión"]
  T["Tavily
Investigación web"]
  E["ElevenLabs TTS
Voz del núcleo en modo live configurado"]
  G["GitHub
Repositorio Organima"]
  U -->|"Navegador"| UI
  UI -->|"HTTPS: REST JSON y SSE"| P
  P -->|"HTTP: proxy hacia Express"| A
  A -->|"append + fsync; lectura al arrancar"| J
  A -->|"Lee al arrancar; inyecta conocimiento"| K
  G -->|"Checkout / despliegue revisado"| K
  A -->|"HTTPS: chat/completions"| N
  A -->|"HTTPS: búsqueda"| T
  A -->|"HTTPS: texto a MP3; respuesta almacenada en buffer"| E
```

El servidor separa los eventos por modo (`runtime/simulation` y `runtime/live`). En simulación utiliza respuestas/escenarios simulados y desactiva la voz externa del núcleo. El mismo diagrama muestra las dependencias disponibles para el modo real, no llamadas que necesariamente hace la demo simulada.

### 2B · Laboratorio local de voz

```mermaid
flowchart TB
  subgraph PC["Computadora del operador · laboratorio local"]
    W["Web A/B
Contenedor: navegador
Micrófono, SDK ElevenLabs, AudioWorklet y Web Audio"]
    L["Servidor del laboratorio
Contenedor: Node.js + Express + WebSocket
127.0.0.1:3212 · voice-lab-server.ts"]
    PY["Puente ASR
Contenedor: subproceso Python por sesión
nvidia-riva-client / gRPC"]
  end
  EA["ElevenLabs Agents
Scribe + Gemini 2.5 Flash + Eleven Flash v2.5
Configuración del agente de prueba"]
  NS["NVIDIA Riva ASR
grpc.nvcf.nvidia.com:443"]
  NT["NVIDIA Magpie Multilingual
HTTPS · síntesis de audio"]
  NB["Nebius Token Factory
NVIDIA: atención y conversación"]
  TV["Tavily
Sólo si cognition decide investigar"]
  CORE["Núcleo Organima
Memoria persistente y objetivos"]
  W -->|"HTTP: token efímero de ElevenLabs"| L
  L -->|"HTTPS: solicita token con clave privada"| EA
  W <-->|"WebRTC: conversación completa"| EA
  W -->|"WebSocket: PCM16 mono 16 kHz"| L
  L -->|"stdin: audio PCM"| PY
  PY <-->|"gRPC TLS: audio / transcripciones parciales y finales"| NS
  PY -->|"stdout: JSONL de transcripción"| L
  L -->|"WebSocket: transcripción"| W
  W -->|"POST /turn: texto e historial de sesión"| L
  L -->|"HTTPS: decide y reply"| NB
  L -->|"HTTPS opcional: búsqueda"| TV
  W -->|"POST /tts: respuesta textual"| L
  L -->|"HTTPS: synthesize_online"| NT
  NT -->|"PCM16 mono 22.05 kHz en streaming"| L
  L -->|"HTTP streaming de PCM"| W
  L -.->|"PENDIENTE: compartir conversación, memoria y acciones"| CORE
```

La opción ElevenLabs **no pasa su conversación por Nebius**. La opción NVIDIA utiliza una cadena propia: Riva → atención/conversación en Nebius → Magpie. No son dos voces sobre un mismo cerebro; es la comparación de agentes completos solicitada. El historial NVIDIA vive en la sesión del navegador, el grafo que recibe esta prueba está vacío y no se escribe al journal del núcleo.

## Nivel 3 · Componentes

### 3A · Dentro del núcleo Express

```mermaid
flowchart TB
  WEB["Web Organima"]
  subgraph API["Contenedor API Organima"]
    BOOT["Composición · server.ts
Carga entorno, modo, knowledge y puertos; reloj 250 ms"]
    ROUTE["Orquestación · app.ts
REST, validación Zod, token de escritura, errores
Exclusión de conversación y observación"]
    STOP["Parada local · app.ts
Cancela objetivo y avanza motionEpoch"]
    MASTER["Maestro · master.ts
plan: chat / move / stop / research
Reglas y salida JSON validada"]
    COG["Cognición · cognition.ts
decide / reply / research / observe
Fuentes, límites y estados de proveedores"]
    MEM["Memoria · memory.ts
JsonlMemory: escritor único, replay, grafo y contextos"]
    ROB["Célula robot · robot.ts
Máquina de estados; simulación
Modo live: offline"]
    VO["Voz · voice.ts
Síntesis ElevenLabs a MP3"]
    SSE["Publicación · app.ts
Estado y eventos SSE hacia clientes"]
  end
  JOURNAL[("events.jsonl")]
  EXT["Nebius / Tavily"]
  EL["ElevenLabs TTS"]
  WEB -->|"REST JSON"| ROUTE
  BOOT -->|"Inyecta dependencias"| ROUTE
  BOOT -->|"tick periódico"| ROB
  ROUTE -->|"Parada explícita antes de esperar al LLM"| STOP
  STOP -->|"cancel"| ROB
  ROUTE -->|"plan con snapshot"| MASTER
  MASTER -->|"Inferencia de intención en live"| EXT
  ROUTE -->|"Conversar, investigar u observar"| COG
  COG -->|"Adaptadores HTTPS"| EXT
  ROUTE -->|"append / snapshot / context / query"| MEM
  MEM -->|"Escribe durable antes de proyectar"| JOURNAL
  ROUTE -->|"submit / verify / cancel"| ROB
  ROUTE -->|"Texto a audio"| VO
  VO -->|"HTTPS"| EL
  ROUTE -->|"Después de registrar cambios"| SSE
  SSE -->|"state: grafo, células, proveedores y objetivo"| WEB
```

- **Maestro:** selecciona intención; no escribe recuerdos ni ejecuta motores. El servidor valida y despacha. Las consultas simples sobre la última posición y la presentación tienen respuesta local.
- **Cognición:** atención decide si investigar/notificar; conversación construye la respuesta; visión transforma una imagen en relaciones con fuente, fecha y confianza. La atención no es un agente autónomo permanentemente corriendo.
- **Proactividad:** `/api/observe` persiste relaciones, intenta verificar el objetivo, evalúa cambios y puede devolver un anuncio. Requiere que lleguen observaciones; no hay aquí una red automática de cámaras de vigilancia.
- **Parada:** `/api/stop` y expresiones explícitas de parada no esperan al razonamiento. `motionEpoch` impide que una orden de movimiento pendiente de inferencia sobreviva a una parada posterior.
- **Salida:** SSE actualiza el panel; no es un bus distribuido ni una cola de mensajes externa.

### 3B · Dentro del laboratorio de voz

```mermaid
flowchart LR
  subgraph WEB["Contenedor navegador del laboratorio"]
    UI["Sesión y selector
voice-agents-client.js"]
    MIC["Captura
voice-capture-worklet.js
Downsample y PCM"]
    VAD["Detección local de voz
Cierre de turno e interrupción"]
    SDK["SDK oficial ElevenLabs
Conversation.startSession"]
    PLAY["Reproductor PCM
Web Audio; audio por fragmentos"]
    MET["Medición visible
Fin estimado de voz a inicio de salida"]
  end
  subgraph SERVER["Contenedor servidor del laboratorio"]
    GUARD["Guardia local
Host / Origin de loopback"]
    TOK["voice-agents.ts
Token efímero ElevenLabs"]
    WS["voice-agents.ts
WebSocket ASR y ciclo de subproceso"]
    TURN["voice-lab.ts · /turn
Historial acotado; grafo vacío
createCognition en live"]
    TTS["voice-lab.ts · /tts
Proxy PCM con streaming y cancelación"]
  end
  PY["Puente Python
StreamingRecognize de NVIDIA"]
  EL["ElevenLabs Agents"]
  NE["Nebius + Tavily opcional"]
  MA["Magpie TTS"]
  UI -->|"Inicia y cierra recursos"| MIC
  MIC -->|"Energía de audio"| VAD
  UI -->|"REST local"| GUARD
  GUARD --> TOK
  GUARD --> TURN
  GUARD --> TTS
  MIC -->|"PCM por WebSocket con comprobación de origen"| WS
  WS <--> PY
  TOK -->|"Token efímero"| UI
  UI -->|"Token y callbacks"| SDK
  SDK <-->|"WebRTC"| EL
  VAD -->|"Turno final; aborta respuesta al interrumpir"| UI
  UI -->|"Texto e historial"| TURN
  TURN --> NE
  UI -->|"Respuesta completa del LLM"| TTS
  TTS --> MA
  TTS -->|"PCM"| PLAY
  PLAY --> MET
  SDK -->|"Transcripciones y volumen de salida"| MET
  VAD -->|"Última actividad de voz"| MET
```

En NVIDIA se espera la respuesta textual completa del cerebro antes de solicitar TTS; la síntesis sí se reproduce por fragmentos. Esto introduce latencia acumulada. ElevenLabs administra su propia detección de turnos e interrupciones. Las métricas del panel son estimaciones de software y usan mecanismos distintos: planificación de audio en NVIDIA y detección del volumen de salida en ElevenLabs; no son mediciones acústicas comparables con precisión de laboratorio.

## Nivel 4 · Código y contratos

### 4A · Dominio y puertos del núcleo

Este diagrama usa nombres reales. `JsonlMemory` es una clase; los puertos son interfaces. `createApp`, `createMaster`, `createRobot` y `createCognition` son funciones de fábrica, no clases ni servicios desplegados por separado.

```mermaid
classDiagram
  class MemoryPort {
    <<interface>>
    append(event) Promise~boolean~
    snapshot() GraphSnapshot
    context(cellId) OrganimaEvent[]
    setContext(cellId, events) void
    query(term) QueryResult
  }
  class JsonlMemory {
    -file
    -state MemoryState
    -queue Promise
    +append(event) Promise~boolean~
    +snapshot() GraphSnapshot
    +context(cellId) OrganimaEvent[]
    +setContext(cellId, events) void
    +query(term) QueryResult
  }
  class OrganimaEvent {
    +id string
    +type string
    +cellId string
    +occurredAt string
    +mode live_or_simulation
    +payload Record
  }
  class Relation {
    +subject string
    +predicate string
    +object string
    +observedAt string
    +source string
    +confidence number
  }
  class GraphSnapshot {
    +version number
    +relations Relation[]
    +events OrganimaEvent[]
  }
  class MemoryState {
    +mode
    +ids Set
    +events OrganimaEvent[]
    +relations Map
    +contexts Map
    +version number
  }
  class CognitionPort {
    <<interface>>
    statuses() ProviderStatus[]
    decide(state) Promise~AttentionDecision~
    research(query) Promise~ResearchResult~
    reply(message, snapshot, history) Promise~ChatReply~
    observe(imageDataUrl) Promise~Relation[]~
  }
  class RobotPort {
    <<interface>>
    describe() CellDescriptor
    submit(goal) GoalStatus
    tick(now) GoalStatus
    cancel(reason) GoalStatus
    verify(relations, source) GoalStatus
    status() GoalStatus
  }
  class Goal {
    +id string
    +cellId string
    +object string
    +target string
    +relation ON
    +deadline string
    +mode
  }
  class GoalStatus {
    +goal Goal
    +state
    +reason string
    +updatedAt string
  }
  class AppOptions {
    +mode
    +memory MemoryPort
    +cognition CognitionPort
    +robot RobotPort
    +master optional_plan_port
    +voice optional_Voice
    +operatorToken optional_string
    +knowledge optional_string
  }
  MemoryPort <|.. JsonlMemory
  JsonlMemory *-- MemoryState
  MemoryState o-- OrganimaEvent
  MemoryState o-- Relation
  GraphSnapshot o-- OrganimaEvent
  GraphSnapshot o-- Relation
  CognitionPort ..> GraphSnapshot : consulta
  CognitionPort ..> Relation : produce observaciones
  RobotPort ..> Goal : recibe
  RobotPort ..> GoalStatus : devuelve
  RobotPort ..> Relation : verifica evidencia
  GoalStatus *-- Goal
  AppOptions o-- MemoryPort
  AppOptions o-- CognitionPort
  AppOptions o-- RobotPort
```

`QueryResult` en el dibujo abrevia el retorno estructural `{relations, events}`; `optional_plan_port` abrevia `{plan(message, snapshot): Promise<Intent>}`. No son clases adicionales existentes. Las firmas omiten algunos detalles de nulabilidad para legibilidad: `tick`, `cancel`, `verify` y `status` pueden devolver `null`.

### 4B · Funciones y llamadas de la conversación NVIDIA

```mermaid
flowchart TB
  START["voice-lab-server.ts
createVoiceLab + createVoiceAgents
agents.attach(server)"]
  CLIENT["voice-agents-client.js
Sesión, turnos, historial y AbortController"]
  BRIDGE["voice-agents.ts
attach: upgrade WebSocket
spawn del puente ASR"]
  PY["nvidia-asr-bridge.py
Riva StreamingRecognize
max_alternatives = 1"]
  TURN["voice-lab.ts
POST /api/lab/turn"]
  HIST["historyToEvents(history)
emptySnapshot()
buildTurnPrompt(message)"]
  COG["createCognition(...).reply(...)
Atención → investigación opcional → respuesta"]
  TTS["POST /api/lab/tts
buildNvidiaRequest(config, text)"]
  REQ["Multipart /v1/audio/synthesize_online
text, language, voice
sample_rate_hz, encoding"]
  AUDIO["Cliente Web Audio
PCM16LE → AudioBuffer → programación de fragmentos"]
  START -->|"Registra HTTP"| TURN
  START -->|"Registra WebSocket"| BRIDGE
  CLIENT -->|"Audio PCM"| BRIDGE
  BRIDGE -->|"stdin / stdout"| PY
  BRIDGE -->|"Transcripción final"| CLIENT
  CLIENT -->|"Texto al cerrar turno"| TURN
  TURN --> HIST
  HIST --> COG
  COG -->|"Texto completo"| CLIENT
  CLIENT -->|"Texto a sintetizar"| TTS
  TTS --> REQ
  REQ -->|"PCM progresivo"| AUDIO
```

La cancelación atraviesa navegador, solicitudes HTTP y reproducción; un identificador de generación descarta respuestas tardías. Cerrar una sesión ASR cierra el socket y termina el subproceso. El gateway limita sesiones, tamaño de mensajes y duración. Las claves de proveedores permanecen en el servidor; el navegador ElevenLabs recibe un token efímero.

## Las tres memorias, sin confundirlas con los cuatro niveles C4

| Memoria | Implementación real | Escritura y lectura | Persistencia / límite |
|---|---|---|---|
| 1 · Contexto inmediato | `MemoryState.contexts`, `Map` por célula | `setContext` / `context`; el chat usa `voice` | RAM; últimos 20 eventos por contexto. No se reconstruye al reiniciar. |
| 2 · Grafo compartido | `Map` de relaciones derivado del journal | Sólo `observation` y `hidden` aportan relaciones; `snapshot` y `query` consultan | Journal durable y replay; una relación vigente por `subject + predicate`. |
| 3 · Conocimiento estable | `knowledge/identity.md`, `knowledge/objects.json` | Carga al arrancar; contenido inyectado al chat que usa cognición | Archivos versionados con Git/GitHub. Sin consolidación automática implementada. |

**World State** es `GraphSnapshot`, una vista del nivel 2; no una cuarta memoria. Devuelve todas las relaciones actuales y hasta 100 eventos recientes. El journal conserva también conversaciones, fuentes, atención y objetivos, pero estos tipos no se convierten automáticamente en aristas del grafo. `query` busca texto, no embeddings ni consultas semánticas de base de grafos.

```mermaid
sequenceDiagram
  participant A as Orquestación app.ts
  participant M as JsonlMemory
  participant D as events.jsonl
  participant P as Proyección RAM
  participant W as Panel SSE
  A->>M: append(OrganimaEvent)
  M->>M: Serializar escritura, validar, deduplicar y comprobar modo
  M->>D: append + fsync
  D-->>M: Escritura durable
  M->>P: Aplicar evento y relaciones si corresponde
  M-->>A: true
  A->>M: snapshot()
  M-->>A: Copia del grafo y últimos eventos
  A-->>W: event: state
  Note over M,D: Reinicio: leer journal y reconstruir proyección. Contexto privado empieza vacío
```

El límite por defecto del journal es 50 MiB: al alcanzarlo se rechaza la escritura sin descartar datos. El proceso mantiene los eventos cargados en RAM; no hay todavía compactación automática, índice semántico ni escalado a múltiples escritores. Una observación antigua no reemplaza otra más reciente del mismo sujeto y predicado.

## Objetivos del robot y frontera física

```mermaid
stateDiagram-v2
  [*] --> accepted: submit válido en simulación
  [*] --> failed: live sin hardware o contrato rechazado
  accepted --> running: tick
  running --> awaiting_verification: tiempo simulado transcurrido
  awaiting_verification --> verified: evidencia externa válida
  accepted --> cancelled: parada
  running --> cancelled: parada
  awaiting_verification --> cancelled: parada
  accepted --> failed: vencimiento
  running --> failed: vencimiento
  awaiting_verification --> failed: vencimiento
  verified --> [*]
  cancelled --> [*]
  failed --> [*]
```

El objetivo admitido por la API es `red_ball ON paper`. La verificación requiere fuente `vision_global`, confianza al menos 0.85 y evidencia posterior al comienzo de la espera de verificación, sin fecha futura. Esto verifica una observación; no demuestra por sí solo causalidad física. El robot no se autocertifica como exitoso.

**Diseño físico pendiente de integración:** adaptador de objetivos en Jetson; navegación usando cámara propia; controlador Arduino/MCU para motores y sensores; watchdog, caducidad de órdenes y parada local por borde/obstáculo. No se afirman pines, modelos de sensores ni firmware instalado. El botón web de parada no sustituye una parada local de hardware. El trabajo físico paralelo debe contrastarse antes de actualizar este límite.

## Contratos HTTP principales

| Ruta | Uso y frontera |
|---|---|
| `GET /api/health`, `/api/state` | Salud, modo y estado agregado. `hardwareConnected` es falso en esta implementación. |
| `GET /api/events` | SSE de estado; heartbeat. |
| `GET /api/memory?q=...` | Búsqueda textual en relaciones y eventos. |
| `POST /api/chat` | Planificación, despacho, respuesta y registro de conversación. |
| `POST /api/observe` | Imagen → relaciones → persistencia → verificación → atención. |
| `POST /api/research` | Tavily y persistencia de fuentes. |
| `POST /api/goals`, `/api/stop` | Objetivo acotado y cancelación. |
| `POST /api/demo/step` | Escenario explícitamente simulado; rechazado en live. |
| `GET /api/voice`, `POST /api/voice` | Estado y síntesis del núcleo. |
| `GET /api/lab/agents/status` | Disponibilidad configurada de proveedores del laboratorio. |
| `POST /api/lab/agents/elevenlabs-session` | Token efímero para WebRTC. |
| `WS /api/lab/agents/nvidia-asr` | Audio de micrófono y transcripciones. |
| `POST /api/lab/turn`, `/api/lab/tts` | Cerebro NVIDIA e interfaz de audio en streaming. |

Las escrituras del núcleo requieren `X-Organima-Token` cuando se configura; los GET son públicos. Es un diseño de demo de operador único, no aislamiento multiusuario. El laboratorio sólo escucha en loopback y aplica comprobaciones de Host/Origin; no debe confundirse con un despliegue público autenticado.

## Decisiones abiertas que el mapa hace visibles

1. **Integración de voz:** elegir proveedor y conectar su conversación al maestro y a las tres memorias mediante contratos explícitos. Hoy el laboratorio no registra recuerdos del núcleo ni llama a sus acciones.
2. **Latencia NVIDIA:** actualmente hay detección de turno, ASR, atención, posible Tavily, generación completa y TTS. Para optimizar habrá que medir cada tramo y evaluar salida incremental del cerebro; cambiar sólo la voz no elimina los demás pasos.
3. **Memoria estable:** falta el flujo de propuesta, revisión y publicación de consolidaciones. GitHub ya versiona archivos, pero no funciona como una memoria autónoma que se escribe sola.
4. **Percepción NVIDIA:** la visión sigue en MiniCPM. NVIDIA sí está presente en razonamiento y conversación; migrar visión requiere verificar un modelo disponible y su calidad.
5. **Hardware:** conectar y validar el adaptador físico con la otra conversación; conservar límites, caducidad y prioridad de seguridad local.
6. **Operación pública:** integrar y desplegar la rama después de revisión. El PR del laboratorio sigue separado; la revisión de Opus quedó bloqueada por autenticación en el trabajo previo.

DeepSeek constructor y Opus juez pertenecen al **proceso de construcción**, no al runtime del producto. No hay un Prime Agent ejecutándose como maestro: el maestro actual es `createMaster` y sus contratos acotados.

## Trazabilidad a código

- [Composición del núcleo](../src/server.ts) y [orquestación HTTP/SSE](../src/app.ts).
- [Contratos](../src/contracts.ts), [maestro](../src/master.ts), [cognición y proveedores](../src/cognition.ts).
- [Memoria y journal](../src/memory.ts), [robot](../src/robot.ts), [voz del núcleo](../src/voice.ts).
- [Arranque del laboratorio](../src/voice-lab-server.ts), [turnos y TTS](../src/voice-lab.ts), [sesiones y ASR](../src/voice-agents.ts).
- [Cliente conversacional](../scripts/voice-agents-client.js), [captura](../public/voice-capture-worklet.js), [puente Python](../scripts/nvidia-asr-bridge.py).
- [Guía de prueba conversacional](VOICE-AGENTS.md) y [contrato propuesto del robot](ROBOT-CONTRACT.md).

Las vistas C4 se expresan con Mermaid para poder revisarlas en GitHub. Los diagramas de secuencia y estados son vistas complementarias; no reemplazan el nivel de código.
