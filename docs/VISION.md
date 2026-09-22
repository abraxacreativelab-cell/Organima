# Pilar vision — detección local de cambios

Módulo: `public/vision.js` (módulo ES, sin dependencias, sin efectos al importar).
Pruebas: `test/vision.test.ts` (30 casos, todo sintético, sin cámara real ni red).

## Para qué existe

La cámara no debe mandar cuadros a la nube todo el tiempo. Este pilar mira el video en
memoria, decide **localmente** si la escena cambió y sólo entonces produce una captura JPEG
lista para entregar. Así el costo y la latencia de razonar sobre imágenes se pagan únicamente
cuando hay algo nuevo que mirar.

Este pilar no habla con Nebius, NVIDIA ni ninguna API: entrega una cadena `data:` a quien la
llame. Conectar esa cadena con la cognición (por ejemplo `CognitionPort.observe(imageDataUrl)`
de `src/contracts.ts`) y con el panel es trabajo del arquitecto al integrar; aquí no se toca
`public/app.js` ni `index.html`.

## API

### `frameDifference(previous, current): number`

Promedio absoluto de las diferencias **R, G y B** de todos los píxeles, dividido entre 255.
Devuelve `0` si los cuadros son iguales en RGB y `1` si todos los canales RGB difieren al
máximo. **El canal alfa se ignora**: cambiar la transparencia no es un cambio visible.

- Valida que ambas entradas sean `Uint8ClampedArray` (o `Uint8Array`/`Buffer`), con largo
  mayor que cero y múltiplo de 4 (píxeles RGBA), y del mismo largo entre sí.
- Es una función pura: no muta ni retiene ninguna de las dos entradas.

### `new ChangeGate({ threshold, cooldownMs, settleMs, now })`

| Parámetro | Default | Qué significa |
|---|---|---|
| `threshold` | `0.035` | Cambio mínimo (0..1) respecto al último cuadro **entregado** para considerar que la escena cambió. |
| `cooldownMs` | `2500` | Intervalo mínimo entre dos entregas. |
| `settleMs` | `800` | Quietud mínima que debe acumular la escena antes de dar por bueno un cambio. |
| `now` | `() => Date.now()` | Reloj inyectable (se usa tal cual; el default es el reloj del sistema). |

- `update(frame): boolean` — `true` sólo si **este cuadro debe capturarse y entregarse**.
- `reset(): void` — vuelve al estado inicial; la próxima imagen se entrega como primera.

Reglas, en orden:

1. **Primera imagen siempre se entrega** (es la base de comparación). También cuando cambia el
   tamaño del buffer: la base vieja ya no sirve, así que el cuadro nuevo se entrega una vez y
   pasa a ser la nueva referencia.
2. Después sólo se entrega si el cambio contra el último cuadro **entregado** alcanza
   `threshold`, **y** el movimiento entre cuadros consecutivos lleva `settleMs` sin superar el
   umbral (la escena se estabilizó), **y** pasaron al menos `cooldownMs` desde la última
   entrega.
3. Movimiento continuo (alternar colores, alguien caminando) nunca se estabiliza → **no hay
   spam de capturas**. Un cambio significativo que se queda quieto se entrega **una sola vez**.
4. Todo lo que la puerta guarda son **copias** del buffer: mutar el arreglo original después de
   `update()` no altera la base ni dispara falsos cambios.
5. El movimiento se mide con el mismo `threshold`: un temblor menor al umbral cuenta como
   quietud. Es deliberado — un cambio lento y acumulativo debe poder entregarse al cruzar el
   umbral, no quedarse esperando a que la escena quede perfectamente inmóvil.

### `startCameraMonitor({ video, onFrame, onStatus, deviceId }): Promise<{ stop }>`

Sólo al llamarla se pide la cámara:

```
getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, deviceId: { exact } (si se pidió) }, audio: false })
```

- `video` se marca `muted = true` y `playsInline = true` antes de `play()`.
- Muestreo cada **250 ms**, reducción a un canvas local de **320x240**, y decisión con
  `ChangeGate` en sus valores por omisión (3.5 %, 800 ms, 2500 ms).
- El cuadro aprobado se codifica con `canvas.toDataURL('image/jpeg', 0.75)` y se entrega con
  `await onFrame(dataUrl)`: **nunca** hay dos entregas simultáneas ni capturas acumuladas
  (mientras una entrega está en vuelo, el muestreo se salta el turno).
- `stop()` es **idempotente**: detiene las pistas del stream, cancela el temporizador, suelta
  `video.srcObject` y olvida cualquier reintento pendiente. Tras `stop()` no se vuelve a
  muestrear ni a entregar, aunque una entrega haya quedado en vuelo.
- Si `onFrame` rechaza, la cámara **sigue viva**: el cuadro queda pendiente y se reintenta como
  mucho una vez por `cooldownMs`, sin bucle apretado y sin carrera con `stop()`.

### Errores: qué se lanza y qué se reporta

Se **lanza** (es error de integración, mensajes en inglés como en `src/`):

- `video` ausente o `onFrame`/`onStatus` no son funciones, `deviceId` que no es string.
- No hay `document`/canvas utilizable o el canvas no da contexto `2d` — se falla antes de
  pedir la cámara, para no dejar una cámara encendida sin poder leerla.

Se **reporta por `onStatus`** (en español, es lo que ve la persona):

- El navegador no expone `getUserMedia`; permiso denegado; cámara ausente, ocupada o
  restringida; `play()` que falla. En estos casos el monitor queda apagado y `stop()` es inerte.
- `onFrame` rechazó el cuadro (incluye la causa) — la cámara sigue.
- Falló la lectura del canvas: se reporta **una sola vez**. Si el error es `SecurityError`
  (canvas contaminado) el monitor se apaga, porque eso no se arregla solo; un fallo pasajero de
  lectura no apaga nada.
- Un `onStatus` que a su vez lance una excepción no detiene la captura.

## Límites y lo que sigue pendiente

- **Calibración real pendiente.** `threshold`, `cooldownMs` y `settleMs` son valores de partida
  razonables, no medidos contra la cámara definitiva, su lente, su iluminación ni el lugar
  donde vivirá el robot. Se ajustan con el ensayo humano y se anotan aquí cuando existan.
- **Cámaras RTSP fuera de alcance.** Este módulo cubre la webcam del navegador para la demo.
  Una cámara IP/RTSP necesita otro camino (proceso servidor, no `getUserMedia`) y no se
  simula aquí.
- **Nada de esto demuestra hardware.** Que las pruebas pasen no dice nada de la cámara real: no
  hay prueba de cámara hasta el ensayo humano.
- **Sin red y sin secretos.** El módulo no usa `fetch`, no contiene URLs externas, no lee
  `.env` ni escribe archivos; todo ocurre en memoria y en un canvas local.
- **Nada de video continuo.** Sólo se entregan cuadros individuales cuando hay un cambio
  estable; no hay grabación ni stream hacia afuera.

## Cómo se prueba

```bash
node --import tsx --test test/vision.test.ts    # 30 casos: frameDifference, ChangeGate y monitor
node --check public/vision.js                   # sintaxis del módulo
```

Las pruebas cubren secuencia sintética, copias, variación de alfa, buffer inválido, primera
imagen, cambio estabilizado, cooldown, reset, cambio de tamaño, y el navegador falso para los
errores del monitor. Todo el tiempo es un reloj inyectado: ninguna prueba duerme ni toca una
cámara.
