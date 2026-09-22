/**
 * Pilar vision — detección local de cambios visuales y monitoreo de webcam.
 *
 * Qué hace: compara cuadros RGBA en memoria y decide, sin salir a la nube, si vale la
 * pena capturar y entregar un cuadro. El cambio se mide con `frameDifference`; la decisión
 * de "esto ya se estabilizó, captúralo una sola vez" la lleva `ChangeGate`; el pegamento
 * con una cámara de navegador lo pone `startCameraMonitor`.
 *
 * Reglas que este archivo respeta:
 * - Módulo ES sin efectos al importar: nada toca document, navigator, timers ni red hasta
 *   que alguien llama a startCameraMonitor.
 * - Sin dependencias, sin URLs externas y sin llamadas de red: el único muestreo es local
 *   (`canvas.toDataURL`); entregar el cuadro hacia afuera es responsabilidad de `onFrame`.
 * - El alfa se ignora: un cambio de transparencia no es un cambio visible.
 * - Los buffers que entran nunca se retienen ni se mutan: todo lo guardado es copia.
 * - Los errores que el usuario debe ver salen por `onStatus` en español; lo que es un bug
 *   de integración se lanza como excepción con mensaje en inglés (convención de src/).
 */

/** Cambio mínimo, en promedio por canal (0..1), para considerar que la escena cambió. */
const DEFAULT_THRESHOLD = 0.035;
/** Intervalo mínimo, en ms, entre dos cuadros entregados. */
const DEFAULT_COOLDOWN_MS = 2500;
/** Quietud mínima, en ms, de la escena antes de dar por bueno un cambio. */
const DEFAULT_SETTLE_MS = 800;

/** Parámetros del muestreo de webcam para la demo. */
const SAMPLE_INTERVAL_MS = 250;
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const JPEG_QUALITY = 0.75;
const VIDEO_IDEAL_WIDTH = 640;
const VIDEO_IDEAL_HEIGHT = 480;
/** HTMLMediaElement.HAVE_CURRENT_DATA: por debajo de esto no hay cuadro que dibujar. */
const HAVE_CURRENT_DATA = 2;

const BYTES_PER_PIXEL = 4;
const RGB_CHANNELS = 3;
const MAX_CHANNEL = 255;

/** Traducciones de los errores de cámara que más aparecen en la práctica. */
const CAMERA_ERROR_HINTS = {
  NotAllowedError: 'permiso de cámara denegado',
  PermissionDeniedError: 'permiso de cámara denegado',
  NotFoundError: 'no encontré ninguna cámara disponible',
  DevicesNotFoundError: 'no encontré ninguna cámara disponible',
  NotReadableError: 'la cámara está ocupada o el sistema no la entrega',
  OverconstrainedError: 'la cámara solicitada no cumple las restricciones pedidas',
  AbortError: 'el navegador abortó el acceso a la cámara',
};

/** Nombre legible de un valor cualquiera, para mensajes de error útiles. */
function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'Array';
  if (Object.prototype.toString.call(value) === '[object DataView]') return 'DataView';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return typeof value;
}

/** Un buffer RGBA utilizable: los bytes por canal son 1 tanto en canvas como en Buffer. */
function isByteBuffer(value) {
  return value instanceof Uint8ClampedArray || value instanceof Uint8Array;
}

/** Valida forma y tamaño de un cuadro RGBA antes de tocarlo. */
function assertFrame(buffer, name) {
  if (!isByteBuffer(buffer)) {
    throw new TypeError(
      `${name} must be a Uint8ClampedArray (or Uint8Array/Buffer); got ${describeValue(buffer)}`,
    );
  }
  if (buffer.length === 0 || buffer.length % BYTES_PER_PIXEL !== 0) {
    throw new RangeError(
      `${name} must be a non-empty multiple of ${BYTES_PER_PIXEL} bytes (RGBA pixels); got length ${buffer.length}`,
    );
  }
}

/** Valida un parámetro numérico que no puede ser negativo. */
function assertNonNegative(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0; got ${describeValue(value)}`);
  }
}

/** Copia defensiva: el módulo nunca conserva el buffer de quien llama. */
function copyBuffer(buffer) {
  return new Uint8ClampedArray(buffer);
}

/** Mensaje humano para un error de cámara, sin inventar datos que no vengan del error. */
function describeError(error) {
  if (!error) return 'error desconocido';
  const name = typeof error.name === 'string' ? error.name : '';
  const detail = typeof error.message === 'string' ? error.message : String(error);
  const hint = CAMERA_ERROR_HINTS[name];
  if (hint) return detail ? `${hint} (${name}: ${detail})` : `${hint} (${name})`;
  return name ? `${name}: ${detail}` : detail;
}

/** Detiene las pistas de un stream sin dejar que un fallo de cierre tape el error original. */
function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track?.stop?.();
    } catch {
      // Una pista que no se puede detener no debe tumbar el cierre del monitor.
    }
  }
}

/**
 * Diferencia media absoluta por canal RGB, normalizada a 0..1.
 *
 * Promedia |ΔR|, |ΔG| y |ΔB| de todos los píxeles sobre 255; el canal alfa se ignora.
 * Devuelve 0 cuando los cuadros son iguales en RGB y 1 cuando todos los canales RGB
 * difieren al máximo. No muta ninguna de las dos entradas.
 *
 * @param {Uint8ClampedArray} previous cuadro RGBA previo
 * @param {Uint8ClampedArray} current cuadro RGBA actual
 * @returns {number} promedio en 0..1
 * @throws {TypeError} si alguna entrada no es un buffer de bytes
 * @throws {RangeError} si algún largo es 0, no es múltiplo de 4, o los largos no coinciden
 */
export function frameDifference(previous, current) {
  assertFrame(previous, 'previous');
  assertFrame(current, 'current');
  if (previous.length !== current.length) {
    throw new RangeError(
      `previous and current must have the same length; got ${previous.length} and ${current.length}`,
    );
  }

  let total = 0;
  for (let index = 0; index < previous.length; index += BYTES_PER_PIXEL) {
    total += Math.abs(previous[index] - current[index]);
    total += Math.abs(previous[index + 1] - current[index + 1]);
    total += Math.abs(previous[index + 2] - current[index + 2]);
  }

  const compared = (previous.length / BYTES_PER_PIXEL) * RGB_CHANNELS;
  return total / compared / MAX_CHANNEL;
}

/**
 * Puerta de cambio: decide cuándo un cuadro merece capturarse y entregarse.
 *
 * Reglas:
 * 1. La primera imagen de un tamaño nuevo siempre se entrega (es la base de comparación).
 * 2. Después sólo se entrega si hay un cambio respecto al último cuadro ENTREGADO que
 *    supere `threshold`, y además:
 *    - el movimiento entre cuadros recientes lleva `settleMs` sin superar `threshold`
 *      (la escena se estabilizó: un cambio ya no sigue ocurriendo), y
 *    - pasaron al menos `cooldownMs` desde la última entrega.
 * 3. El movimiento continuo nunca se estabiliza, así que no genera spam; un cambio
 *    significativo que se queda quieto se entrega exactamente una vez.
 * 4. Un cambio de tamaño reinicia la base: el cuadro nuevo se entrega una vez y vuelve a
 *    ser el punto de comparación (comparar largos distintos no tiene sentido).
 * 5. Todos los buffers se guardan por copia; el reloj se inyecta para poder probar sin dormir.
 *
 * @example
 * const gate = new ChangeGate({ threshold: 0.035, cooldownMs: 2500, settleMs: 800 });
 * if (gate.update(imageData.data)) deliver(canvas.toDataURL('image/jpeg', 0.75));
 */
export class ChangeGate {
  /**
   * @param {{threshold?: number, cooldownMs?: number, settleMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    const {
      threshold = DEFAULT_THRESHOLD,
      cooldownMs = DEFAULT_COOLDOWN_MS,
      settleMs = DEFAULT_SETTLE_MS,
      now = () => Date.now(),
    } = options ?? {};

    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError(`threshold must be a finite number in 0..1; got ${describeValue(threshold)}`);
    }
    assertNonNegative('cooldownMs', cooldownMs);
    assertNonNegative('settleMs', settleMs);
    if (typeof now !== 'function') {
      throw new TypeError(`now must be a function returning a timestamp; got ${describeValue(now)}`);
    }

    /** @type {number} */
    this.threshold = threshold;
    /** @type {number} */
    this.cooldownMs = cooldownMs;
    /** @type {number} */
    this.settleMs = settleMs;
    /** @type {() => number} */
    this.now = now;

    /** @type {Uint8ClampedArray | null} copia del último cuadro entregado */
    this.baseline = null;
    /** @type {Uint8ClampedArray | null} copia del último cuadro observado */
    this.previous = null;
    /** @type {number} */
    this.lastSentAt = 0;
    /** @type {number} */
    this.stableSince = 0;
  }

  /** Vuelve al estado inicial: la próxima imagen se entrega como primera. */
  reset() {
    this.baseline = null;
    this.previous = null;
    this.lastSentAt = 0;
    this.stableSince = 0;
  }

  /**
   * Evalúa un cuadro nuevo.
   *
   * @param {Uint8ClampedArray} frame cuadro RGBA actual
   * @returns {boolean} true sólo si este cuadro debe capturarse y entregarse
   * @throws {TypeError | RangeError} si el buffer no es RGBA válido
   */
  update(frame) {
    assertFrame(frame, 'frame');

    const at = this.now();

    if (this.baseline === null || this.baseline.length !== frame.length) {
      this.#adopt(frame, at);
      return true;
    }

    const motion = frameDifference(this.previous, frame);
    if (motion > this.threshold) this.stableSince = at;
    this.previous = copyBuffer(frame);

    const change = frameDifference(this.baseline, frame);
    if (change < this.threshold) return false;

    const settled = at - this.stableSince >= this.settleMs;
    const cooled = at - this.lastSentAt >= this.cooldownMs;
    if (!settled || !cooled) return false;

    this.#adopt(frame, at);
    return true;
  }

  /** Toma este cuadro como nueva base entregada. */
  #adopt(frame, at) {
    this.baseline = copyBuffer(frame);
    this.previous = copyBuffer(frame);
    this.lastSentAt = at;
    this.stableSince = at;
  }
}

/**
 * Arranca el monitoreo de una cámara del navegador y entrega cuadros cuando cambian.
 *
 * Sólo al llamar a esta función se pide `getUserMedia({ video: { width: {ideal: 640},
 * height: {ideal: 480} }, audio: false })`; `video` se marca `muted` y `playsInline`, la
 * cámara se muestrea cada 250 ms, cada cuadro se reduce a un canvas local de 320x240 y se
 * usa `ChangeGate` (3.5 % de cambio, 800 ms de quietud, 2500 ms de intervalo mínimo). Los
 * cuadros que pasan la puerta se codifican a JPEG con calidad 0.75 y se entregan a
 * `onFrame` de a uno: nunca se solapan dos entregas ni se acumulan capturas.
 *
 * Errores:
 * - Sin navegador (document/canvas) lanza de inmediato: no hay nada que monitorear.
 * - Permisos, cámara ausente/ocupada, `play()` fallido o `onFrame` que rechaza se reportan
 *   por `onStatus`; los dos primeros dejan el monitor apagado, el rechazo de `onFrame` no
 *   mata la cámara (se reintenta el mismo cuadro, como mucho una vez por `cooldownMs`).
 * - Si la lectura del canvas falla, se reporta una sola vez: un fallo de seguridad
 *   (canvas contaminado) apaga el monitor; un fallo pasajero no.
 *
 * @param {{video: HTMLVideoElement, onFrame: (dataUrl: string) => Promise<void>, onStatus: (message: string) => void, deviceId?: string}} options
 * @returns {Promise<{stop: () => void}>} manejador con `stop()` idempotente
 */
export async function startCameraMonitor(options) {
  const { video, onFrame, onStatus, deviceId } = options ?? {};

  if (!video || typeof video !== 'object') {
    throw new TypeError(`startCameraMonitor needs a video element; got ${describeValue(video)}`);
  }
  if (typeof onFrame !== 'function') {
    throw new TypeError(`startCameraMonitor needs an onFrame function; got ${describeValue(onFrame)}`);
  }
  if (typeof onStatus !== 'function') {
    throw new TypeError(`startCameraMonitor needs an onStatus function; got ${describeValue(onStatus)}`);
  }
  if (deviceId !== undefined && typeof deviceId !== 'string') {
    throw new TypeError(`startCameraMonitor needs deviceId to be a string; got ${describeValue(deviceId)}`);
  }

  const documentRef = globalThis.document;
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw new Error(
      'startCameraMonitor needs a browser-like environment with document and canvas; none was found',
    );
  }

  const canvas = documentRef.createElement('canvas');
  if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') {
    throw new Error('startCameraMonitor could not create a usable canvas element');
  }
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('startCameraMonitor could not get a 2d canvas context');
  }

  /** Reporta sin dejar que un callback de estado defectuoso tumbe la captura. */
  const report = (message) => {
    try {
      onStatus(message);
    } catch {
      // El estado es informativo: un panel roto no debe detener la cámara.
    }
  };

  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    report('Este navegador no expone getUserMedia para video; no puedo abrir la cámara.');
    return { stop() {} };
  }

  const videoConstraints = {
    width: { ideal: VIDEO_IDEAL_WIDTH },
    height: { ideal: VIDEO_IDEAL_HEIGHT },
  };
  if (deviceId) videoConstraints.deviceId = { exact: deviceId };

  let stream;
  try {
    stream = await mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  } catch (error) {
    report(`No pude abrir la cámara: ${describeError(error)}`);
    return { stop() {} };
  }

  let stopped = false;
  let intervalId = null;
  let busy = false;
  let pendingDataUrl = null;
  let pendingAt = 0;
  let readErrorReported = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (intervalId !== null) {
      globalThis.clearInterval(intervalId);
      intervalId = null;
    }
    pendingDataUrl = null;
    const activeStream = stream;
    stream = null;
    stopStream(activeStream);
    try {
      video.srcObject = null;
    } catch {
      // Un video que no permite soltar el stream ya está apagado de todos modos.
    }
  };

  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
  } catch (error) {
    stop();
    report(`No pude iniciar el video de la cámara: ${describeError(error)}`);
    return { stop };
  }

  const gate = new ChangeGate();

  /** Entrega un cuadro; si onFrame rechaza, queda uno pendiente para el próximo reintento. */
  const deliver = async (dataUrl) => {
    busy = true;
    try {
      await onFrame(dataUrl);
      pendingDataUrl = null;
    } catch (error) {
      if (stopped) return;
      pendingDataUrl = dataUrl;
      pendingAt = Date.now();
      report(`No pude entregar el cuadro a onFrame: ${describeError(error)}`);
    } finally {
      busy = false;
    }
  };

  const sample = async () => {
    if (stopped || busy) return;

    try {
      if (typeof video.readyState === 'number' && video.readyState < HAVE_CURRENT_DATA) return;

      context.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      const frame = context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data;

      if (gate.update(frame)) {
        await deliver(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
        return;
      }

      if (pendingDataUrl !== null && Date.now() - pendingAt >= gate.cooldownMs) {
        await deliver(pendingDataUrl);
      }
    } catch (error) {
      if (!readErrorReported) {
        readErrorReported = true;
        report(`No pude leer el cuadro de la cámara: ${describeError(error)}`);
      }
      // Un canvas contaminado no se arregla solo: mejor apagar la cámara que dejarla encendida.
      if (error?.name === 'SecurityError') stop();
    }
  };

  // `sample` no rechaza, pero la captura jamás debe producir un unhandled rejection.
  intervalId = globalThis.setInterval(() => sample().catch(() => {}), SAMPLE_INTERVAL_MS);

  return { stop };
}
