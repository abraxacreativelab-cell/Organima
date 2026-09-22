# ROBOT-CONTRACT — célula robot

Contrato de la célula robot de Organima tal como está implementado en `src/robot.ts` y probado en
`test/robot.test.ts`. Describe también el protocolo futuro con la MCU, que **todavía no existe**:
hoy no hay GPIO, motores ni cableado conectado, y este documento no inventa pines, voltajes ni
corrientes.

## 1. Alcance y honestidad

- Hoy sólo existe el **simulador**. `createRobot({ mode })` no abre puertos, no habla con la MCU y
  no produce movimiento físico.
- En `simulation` la célula se declara `ready` y sus estados son datos de simulación etiquetados:
  nunca son evidencia de hardware.
- En `live` la célula se declara `offline` y **todo** `submit` falla de forma explícita con el
  motivo `hardware no conectado: el modo live no tiene enlace con la MCU`. No se simula un
  resultado silencioso cuando no hay enlace real.
- La célula **no produce relaciones** ni se autoconcede éxito: `verify` sólo acepta evidencia de
  una fuente externa (`vision_global`), posterior a la ejecución.
- La parada física y el override local, cuando exista hardware, mandan sobre cualquier orden de
  software. El control local de la MCU es el último recurso, no el servidor.

## 2. Frontera implementada

`RobotPort` (de `src/contracts.ts`):

| Método | Firma | Semántica |
|---|---|---|
| `describe` | `() => CellDescriptor` | Identidad de la célula. Copia profunda por llamada. |
| `submit` | `(goal: Goal) => GoalStatus` | Acepta, reproduce o rechaza. Siempre devuelve un estado; el rechazo es `failed` con `reason`. |
| `tick` | `(now?: number) => GoalStatus \| null` | Avanza la máquina. `null` sólo si no hay goal. |
| `cancel` | `(reason?: string) => GoalStatus \| null` | Terminaliza lo no terminal. Idempotente. |
| `verify` | `(relations: Relation[], source: string) => GoalStatus \| null` | Verifica con evidencia externa válida. |
| `status` | `() => GoalStatus \| null` | Copia profunda del estado actual. |

Reloj: `createRobot` acepta `now?: () => number` (ms epoch). Las pruebas inyectan un reloj falso y
nunca duermen. `tick(now?)` permite pasar un instante explícito, que gana sobre el reloj inyectado.

## 3. Identidad de la célula

| Campo | Valor |
|---|---|
| `id` | `robot` |
| `parentId` | `organism` |
| `name` | `Robot Cell` |
| `capabilities` | `['push_object']` |
| `status` | `ready` en `simulation`, `offline` en `live` |
| `mode` | el modo de la instancia |

## 4. Validación de `Goal`

En `simulation`, un `Goal` se acepta sólo si cumple todo lo siguiente. Cualquier falla devuelve
`state: 'failed'` con `reason` descriptivo (sin secretos) y **no** altera el goal activo.

| Regla | Detalle |
|---|---|
| Forma | Debe ser un objeto con los siete campos del contrato. |
| `id` | Cadena no vacía, máximo `ROBOT_LIMITS.maxGoalIdLength` (200) caracteres. |
| `cellId` | Exactamente `robot`. |
| `object` | Exactamente `red_ball`. |
| `target` | Exactamente `paper`. |
| `relation` | Exactamente `ON`. |
| `mode` | Exactamente `simulation`. Un goal `live` contra la célula simulada se rechaza. |
| `deadline` | Cadena ISO parseable, estrictamente futura al momento del envío y a no más de `maxGoalDurationMs` (120 000 ms) de distancia. |

Los campos extra se ignoran y no se propagan: el estado guarda una copia normalizada de los siete
campos del contrato.

## 5. Máquina de estados

```
submit
  │
  ▼
accepted ──tick──► running ──tick con ≥3000 ms desde la aceptación──► awaiting_verification
   │                  │                                                        │
   │                  │            verify válido ──────────────────────────────► verified
   │                  │            cancel ─────────────────────────────────────► cancelled
   │                  │            now > deadline ─────────────────────────────► failed
   ├── cancel ────► cancelled
   └── now > deadline ────► failed
```

| Transición | Disparador | Condición |
|---|---|---|
| `accepted → running` | `tick` | Primer tick, siempre (una transición por tick). |
| `running → awaiting_verification` | `tick` | `now - acceptedAt ≥ 3000 ms` acumulados desde la aceptación. |
| cualquiera no terminal `→ failed` | `tick` | `now > deadline`. Se revisa **antes** de cualquier otra transición del tick. |
| `awaiting_verification → verified` | `verify` | Evidencia externa válida (sección 7). |
| cualquier no terminal `→ cancelled` | `cancel` | Siempre, con la razón indicada. |
| estados terminales | `tick` / `cancel` | No cambian: `verified`, `failed` y `cancelled` son definitivos. |

Notas:
- El deadline se considera **vencido sólo al superarlo** (`now > deadline`); justo en el instante
  del deadline todavía no vence.
- La ventana hacia `awaiting_verification` se mide desde la **aceptación**, no desde el primer
  tick: un `accepted` que se quedó sin ticks acumula tiempo igual.
- La célula no se autoaprueba: `verified` sólo puede llegar por `verify` con evidencia externa.
- Un tick no provoca transición devuelve el mismo estado sin tocar `updatedAt`.

## 6. Replay, conflictos y límites acotados

| Caso de `submit` | Resultado |
|---|---|
| Mismo `id` y mismos parámetros que un goal recordado | Devuelve **el estado guardado** (copia profunda), sin reiniciar cronómetro ni deadline. |
| Mismo `id`, parámetros distintos | `failed` con `reason` de conflicto de id; el goal activo no cambia. |
| `id` nuevo mientras hay un goal no terminal | `failed` con `reason` de goal activo; el activo no cambia. |
| `id` nuevo sin goal activo (o con uno terminal) | `accepted`; reemplaza al anterior como goal activo. |
| Entrada inválida | `failed` con `reason` de validación; el activo no cambia. |

La firma de replay cubre los siete campos (incluidos `deadline` y `mode`).

Límites acotados — todos en `ROBOT_LIMITS`, exportados para documentación y pruebas:

| Límite | Valor | Efecto |
|---|---|---|
| `maxTrackedGoals` | 100 | Historial FIFO de ids para replay/conflicto. Al excederse se olvida el más viejo: un id olvidado puede volver a ejecutarse (compromiso explícito de memoria acotada). El goal activo nunca se descarta. |
| `maxGoalIdLength` | 200 | Ids más largos se rechazan. |
| `minAwaitingDelayMs` | 3 000 | Mínimo acumulado antes de pedir verificación. |
| `maxGoalDurationMs` | 120 000 | Horizonte máximo del deadline. |
| `minEvidenceConfidence` | 0.85 | Confianza mínima de la evidencia. |
| `evidenceSource` | `vision_global` | Única fuente de evidencia aceptada. |

Sólo se guarda un goal activo a la vez; el historial de estados terminales también vive acotado por
`maxTrackedGoals`.

## 7. Verificación independiente

`verify(relations, source)` sólo actúa desde `awaiting_verification`. En cualquier otro estado
devuelve el estado actual sin cambios (`null` sólo si no hay goal).

Una relación se acepta como evidencia si cumple **todas** estas condiciones:

| Condición | Regla |
|---|---|
| Fuente declarada | `source` debe ser exactamente `vision_global`. |
| Fuente de la relación | `relation.source` debe ser igual a `source`. |
| Confianza | `relation.confidence ≥ 0.85` y finita. |
| Sujeto | `relation.subject === goal.object` (`red_ball`). |
| Predicado | `relation.predicate === goal.relation` (`ON`). |
| Objeto | `relation.object === goal.target` (`paper`). |
| Ventana temporal | `observedAt ≥` instante de entrada en `awaiting_verification` y `observedAt ≤ ahora`. `observedAt` futuro o inválido se rechaza. |

Si al menos una relación de la lista es válida, el goal pasa a `verified`. Evidencia mala no cambia
el estado y no es "pegajosa": una verificación posterior con evidencia válida sí verifica. El robot
nunca genera la relación que lo verifica.

## 8. Copias profundas

`describe`, `submit`, `tick`, `cancel`, `verify` y `status` devuelven copias profundas: mutar la
entrada o la salida no altera el estado interno. El goal guardado se normaliza al aceptarse, de
modo que mutarlo después tampoco afecta a la célula.

## 9. Protocolo futuro con la MCU (pendiente de inventario)

Diseño a nivel de protocolo, **sin decisiones de electrónica**. Todo lo siguiente se implementará
después del inventario del robot real y de elegir la Jetson/placa; nada de esto está activo hoy.

Pendiente de inventario y por eso **no se especifica aquí**: número de pines, niveles lógicos,
tensiones, corrientes, límites de alimentación, tipo de driver de motor, baudrate, y cualquier
valor eléctrico o mecánico. Este documento no los inventa; se fijarán con la placa a la vista y se
medirán antes de conectar carga.

### 9.1 Transporte y mensajes

- Enlace serie USB/UART entre el proceso del robot y la MCU, con el puerto y la velocidad tomados
  de configuración validada; si faltan, el arranque del modo live falla explícitamente.
- Mensajes como objetos JSON de una línea, con: `seq` monotónico, `id` de goal, `type`
  (`goal`/`cancel`/`stop`/`heartbeat`/`ack`/`state`), `issuedAt` y `expiresAt`.
- Toda orden de actuación **caduca**: la MCU descarta una orden cuyo `expiresAt` ya pasó aunque el
  mensaje llegue tarde o repetido. Los `seq` repetidos se reconocen y no se reejecutan.
- Reintentos con backoff acotado; toda espera tiene timeout y su fallo se propaga con mensaje
  claro, sin secretos.

### 9.2 Heartbeat y watchdog

- El proceso del robot envía `heartbeat` periódico; la MCU responde con su estado y su propio
  contador.
- **Watchdog local en la MCU**: si el heartbeat se pierde más allá del umbral configurado, la MCU
  detiene los actuadores por sí misma y queda en estado seguro, sin esperar al servidor.
- El umbral y la frecuencia exactos se fijan y miden durante las pruebas humanas; no se declaran
  hoy.
- El servidor marca la célula en `error`/`offline` cuando el enlace falla y no reintenta el
  movimiento por su cuenta.

### 9.3 Override y parada local

- Parada física y override humano en la MCU ganan siempre: ninguna orden de software reanuda el
  movimiento por encima de una parada local.
- `cancel` en el contrato es la vía de software; la parada local es una línea aparte que la MCU
  honra aunque el enlace esté caído.
- Tras una parada local, el servidor no reanuda: exige intervención humana explícita y un nuevo
  goal.

### 9.4 Orden de pruebas humanas

Se ejecutan en este orden, una por una, y sólo se avanza si la anterior es observada y registrada.
Los valores numéricos se anotan al medir; no se copian de este documento.

1. **Enlace sin actuadores**: abrir el puerto serie, intercambiar `heartbeat`/`ack` y confirmar
   reconexión tras desconectar y reconectar.
2. **Lectura de sensores**: leer el estado de la MCU (sensores presentes tras el inventario) sin
   energizar actuadores.
3. **Un actuador sin carga**, con la fuente al límite de corriente que se determine en el
   inventario; verificar sentido, parada de emergencia y respuesta a `stop`.
4. **Watchdog**: cortar el heartbeat y comprobar que la MCU detiene los actuadores por sí misma.
5. **Override local**: activar la parada física durante un movimiento y confirmar que el software
   no puede reanudar.
6. **Ciclo completo de goal**: ejecutar `push_object` con un solo objeto y verificar con
   `vision_global` real, registrando la evidencia y su ventana temporal.

Ningún paso se marca como logrado por inferencia: hace falta observación humana y evidencia
registrada.

## 10. Estado actual

- `simulation`: implementada y probada con reloj falso (sin hardware, sin red).
- `live`: sólo declara `offline` y rechaza objetivos con motivo explícito.
- MCU, motores y cableado: **pendientes del inventario**. Sin pines, voltajes ni movimiento real
  afirmado en ninguna parte.
