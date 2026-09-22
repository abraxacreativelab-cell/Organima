# Organima — arquitectura C4

Fecha: 22 de septiembre de 2026. Base C4: `33699e2`; revisión Jev Gateway sobre `8cce478`, rama `feat/voice-latency-lab`. Este documento describe la implementación inspeccionada, no promete que todos los componentes estén desplegados juntos. La robótica que se construye en otra conversación queda fuera de esta verificación.

## Cómo leer el mapa

El mapa de sistemas distingue núcleo y laboratorio. Cada zoom mantiene su alcance y los cuatro niveles se leen como: **contexto → contenedores → componentes → código**. “Contenedor” significa aplicación ejecutable o almacén de datos; no implica Docker. Las vistas C1/C2 usan flechas de dependencia: el origen solicita una capacidad al destino. Los flujos de datos y secuencias se identifican aparte. En C1 se omiten protocolos; en C2 se especifican. Una flecha discontinua marcada **pendiente** es una integración propuesta. Las implementaciones en modo simulación no son evidencia de funcionamiento físico.

| Área | Estado en esta revisión |
|---|---|
| Núcleo Organima | TypeScript/Express; memoria, conversación, observación y objetivos implementados. Puede arrancar en `simulation` o `live`. |
| Demo pública | Despliegue separado del laboratorio; última verificación anterior en simulación. No se volvió a verificar su versión durante esta documentación. |
| Laboratorio conversacional | Aplicación local independiente; NVIDIA y ElevenLabs Agents completos probados con servicios reales en el trabajo previo. Rama de PR, no integrado en la demo pública. |
| Robot | Máquina de estados y simulador implementados. El adaptador de esta rama rechaza objetivos en modo real porque no tiene conexión física. |
| Visión | MiniCPM en Nebius. **No es actualmente un modelo NVIDIA.** |
| Jev / Prime Agent | Adaptador Jev vía Vercel integrado; primera llamada real bloqueada por facturación (403). Prime Agent sigue sin integración. |

## Mapa de sistemas · Organima y su laboratorio

**Tipo:** paisaje de sistemas (*system landscape*), vista complementaria. **Alcance:** proyecto Organima, no todo ABRAXA. **Audiencia:** equipo y presentación del proyecto. Separamos el núcleo —operación con memoria y objetivos— del laboratorio —comparación de agentes de voz— como dos sistemas de interés por su función y sus sesiones independientes. Compartir código o repositorio no implica compartir estado.

```mermaid
---
title: Paisaje de sistemas — Proyecto Organima
config:
  layout: elk
---
flowchart LR
  U["Operador\n[Persona]\nUsa el organismo y compara conversaciones"]
  subgraph OWN["Responsabilidad del equipo Organima"]
    O["Organima — núcleo\n[Sistema software]\nObservación, memoria y objetivos"]
    L["Laboratorio de voz\n[Sistema software experimental]\nComparación NVIDIA y ElevenLabs"]
  end
  N["Nebius Token Factory\n[Sistema externo]\nRazonamiento, conversación y visión"]
  V["Vercel AI Gateway / Jev\n[Sistema externo · bloqueado por cuenta]\nEvaluación de atención"]
  E["ElevenLabs\n[Sistema externo]\nSíntesis y agentes conversacionales"]
  S["NVIDIA Speech\n[Sistema externo]\nReconocimiento y síntesis"]
  T["Tavily\n[Sistema externo]\nInvestigación con fuentes web"]
  U -->|"Consulta recuerdos y asigna objetivos"| O
  U -->|"Compara conversaciones y latencia"| L
  O -->|"Solicita razonamiento y percepción"| N
  L -->|"Genera respuestas del agente NVIDIA"| N
  O -->|"Solicita evaluación de atención"| V
  L -->|"Evalúa turnos del agente NVIDIA"| V
  O -->|"Solicita voz sintetizada"| E
  L -->|"Abre conversación con agente completo"| E
  L -->|"Reconoce y sintetiza voz NVIDIA"| S
  O -->|"Busca evidencia externa"| T
  L -->|"Investiga si el turno lo necesita"| T
  KEY["LEYENDA\nAzul: sistema propio · gris: externo · ámbar: bloqueo operativo\nFlecha: dependencia descrita; no prueba disponibilidad\nBorde agrupado: responsabilidad del equipo"]
  classDef own fill:#dcecff,stroke:#175a9e,color:#122b48
  classDef external fill:#edf0f3,stroke:#65758a,color:#172435
  classDef blocked fill:#fff0d5,stroke:#956115,color:#573909
  classDef legend fill:#fff,stroke:#b8c5d3,color:#394a5f
  class O,L own
  class N,E,S,T external
  class V blocked
  class KEY legend
```

No hay una conexión operativa entre laboratorio y núcleo. GitHub pertenece al ciclo de construcción y distribución, no a una consulta de memoria remota por turno. La robótica física pendiente se muestra en su sección de integración futura, no como un sistema ya conectado.

## Nivel 1 · Contextos de sistema

### 1A · Contexto de Organima — núcleo

**Alcance:** un sistema, Organima núcleo. **Audiencia:** técnica y no técnica. Esta vista responde quién lo utiliza y qué obtiene de otros sistemas. No representa procesos, librerías, protocolos ni servidores.

```mermaid
---
title: C1 — Contexto del sistema Organima núcleo
config:
  layout: elk
---
flowchart LR
  U["Operador\n[Persona]\nSupervisa el entorno y asigna objetivos"]
  O["Organima — núcleo\n[Sistema software en foco]\nConecta observaciones, recuerdos y objetivos\nDistingue simulación y operación real"]
  N["Nebius Token Factory\n[Sistema externo]\nProporciona razonamiento, conversación y visión"]
  V["Vercel AI Gateway / Jev\n[Sistema externo · cuenta bloqueada]\nEvalúa cuándo avisar, investigar o escalar"]
  T["Tavily\n[Sistema externo]\nAporta fuentes del mundo exterior"]
  E["ElevenLabs\n[Sistema externo]\nConvierte respuestas en voz"]
  U -->|"Conversa, aporta imágenes, consulta memoria y asigna objetivos"| O
  O -->|"Solicita interpretación y generación de respuestas"| N
  O -->|"Solicita evaluación del estado observado"| V
  O -->|"Busca evidencia para responder preguntas"| T
  O -->|"Solicita lectura de respuestas"| E
  KEY["LEYENDA\nAzul: sistema en foco · gris: dependencias externas\nÁmbar: integrado en código, sin servicio habilitado\nFlecha: solicita una capacidad al destino; no es secuencia temporal"]
  classDef own fill:#dcecff,stroke:#175a9e,color:#122b48
  classDef external fill:#edf0f3,stroke:#65758a,color:#172435
  classDef blocked fill:#fff0d5,stroke:#956115,color:#573909
  classDef legend fill:#fff,stroke:#b8c5d3,color:#394a5f
  class O own
  class N,T,E external
  class V blocked
  class KEY legend
```

Tavily es el proveedor de investigación web. Nebius y los servicios de voz son dependencias de inferencia; no constituyen fuentes de investigación sustitutivas. La simulación no llama a esas dependencias reales.

### 1B · Contexto del laboratorio de voz

**Alcance:** un sistema experimental independiente. **Audiencia:** equipo que compara agentes. La conversación de ElevenLabs ocurre en su plataforma; la cadena NVIDIA utiliza Nebius para generar respuestas y Jev para evaluar atención cuando está seleccionado.

```mermaid
---
title: C1 — Contexto del laboratorio de voz Organima
config:
  layout: elk
---
flowchart LR
  U["Operador de pruebas\n[Persona]\nConversa y compara respuesta percibida"]
  L["Laboratorio de voz\n[Sistema software en foco]\nCompara agentes completos\nSin memoria persistente del núcleo"]
  E["ElevenLabs Agents\n[Sistema externo]\nConversación completa administrada"]
  S["NVIDIA Speech\n[Sistema externo]\nTranscribe y sintetiza voz"]
  N["Nebius Token Factory\n[Sistema externo]\nGenera respuestas del agente NVIDIA"]
  V["Vercel AI Gateway / Jev\n[Sistema externo · cuenta bloqueada]\nEvalúa atención del agente NVIDIA"]
  T["Tavily\n[Sistema externo]\nAporta fuentes si el turno lo requiere"]
  U -->|"Habla, interrumpe y compara latencia"| L
  L -->|"Abre conversación con el agente ElevenLabs"| E
  L -->|"Solicita reconocimiento y síntesis"| S
  L -->|"Solicita respuesta normal o razonamiento escalado"| N
  L -->|"Solicita evaluación del turno"| V
  L -->|"Investiga información externa necesaria"| T
  KEY["LEYENDA\nAzul: sistema en foco · gris: externo · ámbar: bloqueo de cuenta\nFlecha: dependencia funcional; no certifica disponibilidad\nSin conexión actual con memoria o acciones del núcleo"]
  classDef own fill:#dcecff,stroke:#175a9e,color:#122b48
  classDef external fill:#edf0f3,stroke:#65758a,color:#172435
  classDef blocked fill:#fff0d5,stroke:#956115,color:#573909
  classDef legend fill:#fff,stroke:#b8c5d3,color:#394a5f
  class L own
  class E,S,N,T external
  class V blocked
  class KEY legend
```

## Nivel 2 · Contenedores lógicos

Estas vistas amplían cada sistema anterior. Las fronteras agrupan software bajo responsabilidad de Organima; no indican máquinas físicas. Los entornos, puertos y procesos supervisores se describen por separado en [RUNBOOK.md](RUNBOOK.md).

### 2A · Contenedores de Organima — núcleo

**Alcance:** sistema Organima núcleo. **Audiencia:** desarrollo y operación. El núcleo es un monolito modular: las células no son microservicios. Los contextos y la proyección del grafo viven en la aplicación servidor, no en un servicio aparte.

```mermaid
---
title: C2 — Contenedores del sistema Organima núcleo
config:
  layout: elk
---
flowchart LR
  U["Operador\n[Persona]\nSupervisa el organismo"]
  subgraph O["Sistema software: Organima — núcleo"]
    UI["Web Organima\n[Contenedor · HTML / JavaScript]\nPanel, chat, imágenes y objetivos"]
    A["API Organima\n[Contenedor · Node.js / Express]\nOrquesta cognición, memoria y objetivos"]
    J[("Journal\n[Contenedor de datos · JSONL]\nConserva eventos por modo")]
    K[("Conocimiento estable\n[Contenedor de datos · Markdown / JSON]\nIdentidad y conceptos revisados")]
    UI -->|"Envía solicitudes y se suscribe al estado [HTTP JSON / SSE]"| A
    A -->|"Lee y agrega eventos durables [filesystem + fsync]"| J
    A -->|"Carga conocimiento al arrancar [filesystem]"| K
  end
  N["Nebius Token Factory\n[Sistema externo]\nNVIDIA: texto · MiniCPM: visión"]
  V["Vercel AI Gateway / Jev\n[Sistema externo · cuenta bloqueada]\nAtención tipada"]
  T["Tavily\n[Sistema externo]\nInvestigación web"]
  E["ElevenLabs\n[Sistema externo]\nSíntesis de voz"]
  U -->|"Opera la interfaz"| UI
  A -->|"Solicita inferencia [HTTPS JSON]"| N
  A -->|"Evalúa atención seleccionada [HTTPS / AI SDK]"| V
  A -->|"Busca fuentes [HTTPS JSON]"| T
  A -->|"Solicita audio [HTTPS; MP3]"| E
  KEY["LEYENDA\nAzul: aplicación propia · cilindro: almacén · gris: sistema externo\nÁmbar: bloqueo operativo · marco: límite de sistema, no servidor\nFlecha: dependencia con protocolo; SSE: eventos enviados por servidor"]
  classDef own fill:#dcecff,stroke:#175a9e,color:#122b48
  classDef external fill:#edf0f3,stroke:#65758a,color:#172435
  classDef blocked fill:#fff0d5,stroke:#956115,color:#573909
  classDef legend fill:#fff,stroke:#b8c5d3,color:#394a5f
  class UI,A,J,K own
  class N,T,E external
  class V blocked
  class KEY legend
```

El código separa `runtime/simulation` de `runtime/live`. Los archivos de conocimiento llegan con el checkout revisado del repositorio. La implementación de esta rama conserva el robot simulado; en modo real el puerto robot se declara desconectado.

### 2B · Contenedores del laboratorio

**Alcance:** sistema laboratorio de voz. **Audiencia:** desarrollo y operación. Se representan dependencias entre procesos; los intercambios de audio y su secuencia se amplían en componentes y en la vista de flujo de código.

```mermaid
---
title: C2 — Contenedores del laboratorio de voz Organima
config:
  layout: elk
---
flowchart LR
  U["Operador de pruebas\n[Persona]\nHabla y compara agentes"]
  subgraph LAB["Sistema software: laboratorio de voz"]
    W["Web A/B\n[Contenedor · JavaScript / Web Audio]\nCaptura, conversación y medición"]
    L["Gateway local de voz\n[Contenedor · Node.js / Express / ws]\nSesiones, turnos y síntesis"]
    P["Puente ASR\n[Contenedor · Python / cliente Riva]\nReconocimiento de voz en streaming"]
    W -->|"Solicita token, respuesta y audio [HTTP JSON / PCM]"| L
    W -->|"Envía audio y recibe transcripciones [WebSocket]"| L
    L -->|"Inicia puente y usa audio / transcripciones [stdin / stdout]"| P
  end
  E["ElevenLabs Agents\n[Sistema externo]\nAgente completo: Scribe, Gemini, Eleven Flash"]
  S["NVIDIA Speech\n[Sistema externo]\nRiva ASR y Magpie TTS"]
  N["Nebius Token Factory\n[Sistema externo]\nRespuesta NVIDIA normal o escalada"]
  V["Vercel AI Gateway / Jev\n[Sistema externo · cuenta bloqueada]\nAtención de cada turno"]
  T["Tavily\n[Sistema externo]\nFuentes web bajo demanda"]
  U -->|"Opera la comparación"| W
  W -->|"Mantiene conversación [WebRTC / SDK ElevenLabs]"| E
  L -->|"Obtiene token efímero [HTTPS]"| E
  P -->|"Solicita transcripción [gRPC TLS; PCM 16 kHz]"| S
  L -->|"Solicita síntesis [HTTPS; PCM 22.05 kHz]"| S
  L -->|"Genera respuesta textual [HTTPS JSON]"| N
  L -->|"Evalúa estado [HTTPS / AI SDK]"| V
  L -->|"Investiga si es necesario [HTTPS JSON]"| T
  KEY["LEYENDA\nAzul: contenedor propio · gris: sistema externo · ámbar: bloqueo\nMarco: límite del sistema · flecha: dependencia dirigida, no secuencia\nASR: reconocimiento · TTS: síntesis · PCM: muestras de audio"]
  classDef own fill:#dcecff,stroke:#175a9e,color:#122b48
  classDef external fill:#edf0f3,stroke:#65758a,color:#172435
  classDef blocked fill:#fff0d5,stroke:#956115,color:#573909
  classDef legend fill:#fff,stroke:#b8c5d3,color:#394a5f
  class W,L,P own
  class E,S,N,T external
  class V blocked
  class KEY legend
```

ElevenLabs no usa Nebius para su conversación. NVIDIA sigue la cadena Riva → Jev seleccionado → NVIDIA en Nebius → Magpie. El historial de esa prueba vive en el navegador; el grafo entregado al cerebro está vacío y no se escribe en el journal del núcleo. Puertos, TLS de entrada y supervisión de procesos son decisiones de despliegue, no contenedores adicionales de negocio.

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
    AT["Atención · attention.ts\nAI SDK evaluate + gateway.evaluation\nTres probabilidades y umbral 0.7"]
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
  JV["Vercel AI Gateway · Jev"]
  EL["ElevenLabs TTS"]
  WEB -->|"REST JSON"| ROUTE
  BOOT -->|"Inyecta dependencias"| ROUTE
  BOOT -->|"tick periódico"| ROB
  ROUTE -->|"Parada explícita antes de esperar al LLM"| STOP
  STOP -->|"cancel"| ROB
  ROUTE -->|"plan con snapshot"| MASTER
  MASTER -->|"Inferencia de intención en live"| EXT
  ROUTE -->|"Conversar, investigar u observar"| COG
  COG -->|"decide en selección jev"| AT
  AT -->|"HTTPS: evaluación tipada"| JV
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
  NE["Jev vía Vercel + NVIDIA en Nebius\nTavily opcional"]
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
  class AttentionDecision {
    +notify boolean
    +research boolean
    +escalate boolean
    +provider jev_or_nvidia_or_rules
    +probability number
    +probabilities optional_per_question
    +threshold optional_number
    +researchOverride optional_reason
    +mode
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
  CognitionPort ..> AttentionDecision : devuelve evaluación
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
  COG --> JEV
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
2. **Latencia NVIDIA:** actualmente hay detección de turno, ASR, evaluación Jev, posible Tavily, generación completa y TTS. Para optimizar habrá que medir cada tramo y evaluar salida incremental del cerebro; cambiar sólo la voz no elimina los demás pasos.
3. **Memoria estable:** falta el flujo de propuesta, revisión y publicación de consolidaciones. GitHub ya versiona archivos, pero no funciona como una memoria autónoma que se escribe sola.
4. **Percepción NVIDIA:** la visión sigue en MiniCPM. NVIDIA sí está presente en razonamiento y conversación; migrar visión requiere verificar un modelo disponible y su calidad.
5. **Hardware:** conectar y validar el adaptador físico con la otra conversación; conservar límites, caducidad y prioridad de seguridad local.
6. **Operación pública:** integrar y desplegar la rama después de revisión. El PR del laboratorio sigue separado; la revisión de Opus quedó bloqueada por autenticación en el trabajo previo.

Jev interpreta el estado acotado de la memoria, sin escribir directamente en ella. Sus decisiones se conservan en los eventos de atención y conversación. `probabilities` contiene las tres probabilidades; `probability` es su máximo por compatibilidad, no una confianza conjunta ni una medida calibrada. La selección `nvidia` conserva el modo anterior; no se activa automáticamente cuando falla Jev. En `simulation` sólo se usan reglas.

DeepSeek constructor y Opus juez pertenecen al **proceso de construcción**, no al runtime del producto. No hay un Prime Agent ejecutándose como maestro: el maestro actual es `createMaster` y sus contratos acotados.

## Trazabilidad a código

- [Composición del núcleo](../src/server.ts) y [orquestación HTTP/SSE](../src/app.ts).
- [Contratos](../src/contracts.ts), [maestro](../src/master.ts), [cognición y proveedores](../src/cognition.ts).
- [Evaluador Jev](../src/attention.ts) y [guía Jev](JEV.md).
- [Memoria y journal](../src/memory.ts), [robot](../src/robot.ts), [voz del núcleo](../src/voice.ts).
- [Arranque del laboratorio](../src/voice-lab-server.ts), [turnos y TTS](../src/voice-lab.ts), [sesiones y ASR](../src/voice-agents.ts).
- [Cliente conversacional](../scripts/voice-agents-client.js), [captura](../public/voice-capture-worklet.js), [puente Python](../scripts/nvidia-asr-bridge.py).
- [Guía de prueba conversacional](VOICE-AGENTS.md) y [contrato propuesto del robot](ROBOT-CONTRACT.md).

Las vistas C4 se expresan con Mermaid para poder revisarlas en GitHub. Los diagramas de secuencia y estados son vistas complementarias; no reemplazan el nivel de código.

## Auditoría C4

La revisión y las decisiones de notación están documentadas en [C4-AUDIT.md](C4-AUDIT.md). Referencias oficiales: [contexto](https://c4model.com/diagrams/system-context), [contenedores](https://c4model.com/diagrams/container), [paisaje de sistemas](https://c4model.com/diagrams/system-landscape), [notación](https://c4model.com/diagrams/notation) y [lista de revisión](https://c4model.com/diagrams/checklist).
