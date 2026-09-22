/**
 * Pruebas del pilar vision (public/vision.js).
 *
 * Todo es sintético y local: buffers construidos a mano, reloj inyectado (ninguna prueba
 * duerme) y un navegador falso con canvas/video/getUserMedia para el monitoreo de webcam.
 * No hay cámara real, ni DOM real, ni red.
 *
 * Cubre el contrato observable del PLAN: secuencia sintética, copias, variación de alfa,
 * buffer inválido, primera imagen, cambio estabilizado, cooldown, reset y los errores del
 * monitor (permisos, cámara, onFrame, lectura de canvas, stop idempotente sin carreras).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeGate, frameDifference, startCameraMonitor } from '../public/vision.js';

/* ────────────────────────────── utilidades de prueba ────────────────────────────── */

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const STUB_DATA_URL = 'data:image/jpeg;base64,VISION-STUB';

interface Clock {
  now(): number;
  advance(ms: number): number;
}

/** Reloj falso: sólo las pruebas lo hacen avanzar. */
function makeClock(start = 1000): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number): number => {
      current += ms;
      return current;
    },
  };
}

/** Cuadro RGBA uniforme con el color indicado. */
function solidFrame(r: number, g: number, b: number, pixels = 1, alpha = 255): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    buffer[index * 4] = r;
    buffer[index * 4 + 1] = g;
    buffer[index * 4 + 2] = b;
    buffer[index * 4 + 3] = alpha;
  }
  return buffer;
}

/** Sustituye una global y devuelve cómo restaurarla. */
function installGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  };
}

/* ────────────────────────────── frameDifference ────────────────────────────── */

describe('frameDifference', () => {
  it('mide el promedio absoluto RGB normalizado 0..1', () => {
    const black = solidFrame(0, 0, 0);
    assert.equal(frameDifference(black, solidFrame(0, 0, 0)), 0);
    assert.equal(frameDifference(black, solidFrame(255, 255, 255)), 1);
    assert.equal(frameDifference(solidFrame(255, 255, 255), black), 1);

    // Un solo canal distinto en 51: 51 / (3 canales * 255) = 1/15 = 0.0666…
    assert.equal(frameDifference(black, solidFrame(51, 0, 0)), 51 / 3 / 255);

    // Promedio entre píxeles: uno igual y otro al máximo dan 0.5.
    const twoBlack = solidFrame(0, 0, 0, 2);
    const halfChanged = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    assert.equal(frameDifference(twoBlack, halfChanged), 0.5);
  });

  it('ignora el canal alfa', () => {
    assert.equal(frameDifference(new Uint8ClampedArray([10, 20, 30, 255]), new Uint8ClampedArray([10, 20, 30, 0])), 0);
    // Varios píxeles con el mismo RGB y todo el alfa distinto siguen dando 0.
    const a = new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 10]);
    const b = new Uint8ClampedArray([1, 2, 3, 250, 4, 5, 6, 1]);
    assert.equal(frameDifference(a, b), 0);
  });

  it('no muta ninguna entrada', () => {
    const previous = solidFrame(0, 0, 0, 3);
    const current = solidFrame(255, 128, 64, 3);
    const previousCopy = Uint8ClampedArray.from(previous);
    const currentCopy = Uint8ClampedArray.from(current);

    frameDifference(previous, current);

    assert.deepEqual(previous, previousCopy);
    assert.deepEqual(current, currentCopy);
  });

  it('rechaza buffers inválidos', () => {
    const valid = solidFrame(0, 0, 0);
    assert.throws(() => frameDifference(null as never, valid), TypeError);
    assert.throws(() => frameDifference(valid, undefined as never), TypeError);
    assert.throws(() => frameDifference([0, 0, 0, 255] as never, valid), TypeError);
    assert.throws(() => frameDifference(new Float32Array(4) as never, valid), TypeError);
    assert.throws(() => frameDifference(new DataView(new ArrayBuffer(4)) as never, valid), TypeError);

    // Largos inválidos: vacío o no múltiplo de 4.
    assert.throws(() => frameDifference(new Uint8ClampedArray(0), new Uint8ClampedArray(0)), RangeError);
    assert.throws(() => frameDifference(new Uint8ClampedArray(6), new Uint8ClampedArray(6)), RangeError);

    // Largos válidos pero distintos entre sí.
    assert.throws(() => frameDifference(new Uint8ClampedArray(4), new Uint8ClampedArray(8)), RangeError);
  });
});

/* ────────────────────────────── ChangeGate ────────────────────────────── */

describe('ChangeGate', () => {
  it('aplica los valores por omisión del PLAN', () => {
    const gate = new ChangeGate();
    assert.equal(gate.threshold, 0.035);
    assert.equal(gate.cooldownMs, 2500);
    assert.equal(gate.settleMs, 800);
    assert.equal(typeof gate.now(), 'number');
  });

  it('valida su configuración', () => {
    assert.throws(() => new ChangeGate({ threshold: -0.1 }), RangeError);
    assert.throws(() => new ChangeGate({ threshold: 1.5 }), RangeError);
    assert.throws(() => new ChangeGate({ threshold: Number.NaN }), RangeError);
    assert.throws(() => new ChangeGate({ cooldownMs: -1 }), RangeError);
    assert.throws(() => new ChangeGate({ settleMs: Number.POSITIVE_INFINITY }), RangeError);
    assert.throws(() => new ChangeGate({ now: 'ahora' as never }), TypeError);
  });

  it('entrega la primera imagen y no repite sin cambio', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ now: clock.now });

    assert.equal(gate.update(solidFrame(30, 30, 30)), true);
    clock.advance(250);
    assert.equal(gate.update(solidFrame(30, 30, 30)), false);
    clock.advance(250);
    assert.equal(gate.update(solidFrame(30, 30, 30)), false);
  });

  it('rechaza cuadros inválidos sin corromper su estado', () => {
    const gate = new ChangeGate();

    assert.throws(() => gate.update(null as never), TypeError);
    assert.throws(() => gate.update(new Uint8ClampedArray(0)), RangeError);
    assert.throws(() => gate.update(new Uint8ClampedArray(7)), RangeError);
    assert.throws(() => gate.update(new Float32Array(4) as never), TypeError);

    // Los cuadros inválidos no dejaron base: el siguiente válido es la primera imagen.
    assert.equal(gate.update(solidFrame(0, 0, 0)), true);
    assert.equal(gate.update(solidFrame(0, 0, 0)), false);
  });

  it('usa copias: mutar el buffer entregado no cambia la base guardada', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ cooldownMs: 0, settleMs: 0, now: clock.now });

    const first = solidFrame(0, 0, 0);
    assert.equal(gate.update(first), true);

    // Si la puerta hubiera retenido la referencia, su base sería blanca y este negro
    // contaría como un cambio máximo listo para entregar.
    first.fill(255);

    clock.advance(250);
    assert.equal(gate.update(solidFrame(0, 0, 0)), false);
  });

  it('reinicia la base cuando cambia el tamaño del buffer', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ now: clock.now });

    assert.equal(gate.update(solidFrame(0, 0, 0, 1)), true);
    clock.advance(250);
    assert.equal(gate.update(solidFrame(0, 0, 0, 1)), false);

    // Tamaño nuevo: base nueva y una entrega; comparar largos distintos no tiene sentido.
    clock.advance(250);
    assert.equal(gate.update(solidFrame(255, 255, 255, 2)), true);
    clock.advance(250);
    assert.equal(gate.update(solidFrame(255, 255, 255, 2)), false);
  });

  it('ignora cambios por debajo del umbral', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ cooldownMs: 0, settleMs: 0, now: clock.now });
    const black = solidFrame(0, 0, 0);

    assert.equal(gate.update(black), true);
    // 8 / 255 = 0.0314 < 0.035: aunque pase el tiempo, no hay entrega.
    for (let step = 0; step < 10; step += 1) {
      clock.advance(1000);
      assert.equal(gate.update(solidFrame(8, 8, 8)), false, `paso ${step}`);
    }
  });

  it('espera la quietud de settleMs antes de entregar un cambio', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ cooldownMs: 0, settleMs: 800, now: clock.now });
    const black = solidFrame(0, 0, 0);
    const white = solidFrame(255, 255, 255);

    assert.equal(gate.update(black), true); // t = 1000: primera imagen
    clock.advance(250);
    assert.equal(gate.update(white), false); // t = 1250: el salto, todavía se mueve
    clock.advance(250);
    assert.equal(gate.update(white), false); // t = 1500: 250 ms de quietud
    clock.advance(250);
    assert.equal(gate.update(white), false); // t = 1750: 500 ms
    clock.advance(250);
    assert.equal(gate.update(white), false); // t = 2000: 750 ms
    clock.advance(250);
    assert.equal(gate.update(white), true); // t = 2250: 1000 ms de quietud
    clock.advance(250);
    assert.equal(gate.update(white), false); // ya entregado: no repite
  });

  it('respeta cooldownMs entre dos entregas', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ cooldownMs: 1000, settleMs: 0, now: clock.now });
    const black = solidFrame(0, 0, 0);
    const white = solidFrame(255, 255, 255);

    assert.equal(gate.update(black), true); // t = 1000
    clock.advance(250);
    assert.equal(gate.update(white), false); // t = 1250: cambio estable, sólo 250 ms
    clock.advance(250);
    assert.equal(gate.update(white), false); // t = 1500: 500 ms
    clock.advance(500);
    assert.equal(gate.update(white), true); // t = 2000: 1000 ms desde la última entrega
    clock.advance(250);
    assert.equal(gate.update(white), false);
  });

  it('no dispara spam con movimiento continuo', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ now: clock.now });
    const black = solidFrame(0, 0, 0);
    const white = solidFrame(255, 255, 255);

    assert.equal(gate.update(black), true);
    // 40 cuadros alternando (10 s de movimiento): la escena nunca se estabiliza.
    for (let step = 0; step < 40; step += 1) {
      clock.advance(250);
      assert.equal(gate.update(step % 2 === 0 ? white : black), false, `paso ${step}`);
    }
  });

  it('entrega un cambio estable significativo una sola vez', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ now: clock.now }); // 0.035 / 2500 / 800
    const dark = solidFrame(24, 24, 24); // 24 / 255 = 0.094 > umbral

    assert.equal(gate.update(solidFrame(0, 0, 0)), true); // t = 1000

    let emissions = 0;
    for (let step = 0; step < 12; step += 1) {
      clock.advance(250);
      if (gate.update(dark)) emissions += 1;
    }
    assert.equal(emissions, 1, 'un cambio estable se entrega una sola vez');

    for (let step = 0; step < 4; step += 1) {
      clock.advance(250);
      if (gate.update(dark)) emissions += 1;
    }
    assert.equal(emissions, 1, 'sin cambio nuevo no hay más entregas');
  });

  it('reconoce un cambio estable después de movimiento continuo', () => {
    const clock = makeClock(0);
    const gate = new ChangeGate({ now: clock.now });
    const black = solidFrame(0, 0, 0);
    const white = solidFrame(255, 255, 255);
    const deliveries: number[] = [];

    // 3 s de movimiento continuo: sólo la primera imagen se entrega.
    for (let step = 0; step < 12; step += 1) {
      if (gate.update(step % 2 === 0 ? black : white)) deliveries.push(clock.now());
      clock.advance(250);
    }
    assert.deepEqual(deliveries, [0]);

    // La escena se queda quieta: una sola entrega, después de quietud y cooldown.
    for (let step = 0; step < 40; step += 1) {
      if (gate.update(white)) deliveries.push(clock.now());
      clock.advance(250);
    }
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries[1] >= 2500, `la segunda entrega debe respetar el cooldown, fue ${deliveries[1]}`);
  });

  it('reset vuelve a tratar el próximo cuadro como primera imagen', () => {
    const clock = makeClock();
    const gate = new ChangeGate({ now: clock.now });
    const black = solidFrame(0, 0, 0);
    const white = solidFrame(255, 255, 255);

    assert.equal(gate.update(black), true);
    clock.advance(250);
    assert.equal(gate.update(white), false);

    gate.reset();
    clock.advance(10);
    assert.equal(gate.update(white), true);
    clock.advance(250);
    assert.equal(gate.update(white), false);
  });
});

/* ────────────────────────────── startCameraMonitor ────────────────────────────── */

interface FakeBrowserState {
  ticks: Array<() => Promise<void>>;
  cleared: unknown[];
  drawn: number;
  constraints: unknown[];
  dataUrls: Array<{ type: unknown; quality: unknown }>;
  stoppedTracks: number;
}

interface FakeBrowser {
  video: Record<string, unknown>;
  canvas: Record<string, unknown>;
  state: FakeBrowserState;
  stream: { getTracks: () => Array<{ stop: () => void }> };
  setFrame: (frame: Uint8ClampedArray) => void;
  install: () => () => void;
}

/** Navegador falso: canvas, video, navigator y timers bajo control de la prueba. */
function createFakeBrowser(options: {
  noMediaDevices?: boolean;
  noContext2d?: boolean;
  getUserMedia?: (constraints: unknown) => Promise<unknown>;
  drawImage?: () => void;
  getImageData?: () => { data: Uint8ClampedArray };
  readyState?: number;
  play?: () => Promise<void>;
} = {}): FakeBrowser {
  const state: FakeBrowserState = {
    ticks: [],
    cleared: [],
    drawn: 0,
    constraints: [],
    dataUrls: [],
    stoppedTracks: 0,
  };

  let frame = solidFrame(0, 0, 0);
  const tracks = [
    {
      stop: () => {
        state.stoppedTracks += 1;
      },
    },
  ];
  const stream = { getTracks: () => tracks };

  const context = {
    drawImage: (): void => {
      state.drawn += 1;
      options.drawImage?.();
    },
    getImageData: (): { data: Uint8ClampedArray } =>
      options.getImageData?.() ?? { data: frame },
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: (id: string) => (options.noContext2d ? null : id === '2d' ? context : null),
    toDataURL: (type?: string, quality?: number) => {
      state.dataUrls.push({ type, quality });
      return STUB_DATA_URL;
    },
  };

  const video: Record<string, unknown> = {
    srcObject: null,
    muted: false,
    playsInline: false,
    readyState: options.readyState ?? 2,
    play: options.play ?? (async () => {}),
  };

  const mediaDevices = options.noMediaDevices
    ? undefined
    : {
        getUserMedia: async (constraints: unknown) => {
          state.constraints.push(constraints);
          return options.getUserMedia ? options.getUserMedia(constraints) : stream;
        },
      };

  const documentStub = { createElement: (tag: string) => (tag === 'canvas' ? canvas : null) };

  return {
    video,
    canvas,
    state,
    stream,
    setFrame: (next: Uint8ClampedArray) => {
      frame = next;
    },
    install: () => {
      const restores = [
        installGlobal('document', documentStub),
        installGlobal('navigator', { mediaDevices }),
        installGlobal('setInterval', (callback: () => Promise<void>) => {
          state.ticks.push(callback);
          return state.ticks.length; // id ficticio, suficiente para comprobar clearInterval
        }),
        installGlobal('clearInterval', (id: unknown) => {
          state.cleared.push(id);
        }),
      ];
      return () => {
        for (const restore of restores.reverse()) restore();
      };
    },
  };
}

interface MonitorHandlers {
  onFrame: (dataUrl: string) => Promise<void> | void;
  onStatus: (message: string) => void;
  deviceId?: string;
}

interface MonitorEnv {
  monitor: { stop: () => void };
  tick: () => Promise<void>;
  restore: () => void;
}

/**
 * Arranca el monitor con el navegador falso. Las globales quedan sustituidas hasta
 * `restore()`, para que las pruebas puedan observar también `clearInterval` del stop.
 */
async function startMonitorEnv(browser: FakeBrowser, handlers: MonitorHandlers): Promise<MonitorEnv> {
  const restore = browser.install();
  try {
    const monitor = await startCameraMonitor({
      video: browser.video as never,
      onFrame: handlers.onFrame,
      onStatus: handlers.onStatus,
      ...(handlers.deviceId === undefined ? {} : { deviceId: handlers.deviceId }),
    } as never);
    // Un monitor inerte (sin cámara) no registra muestreo: quien espere `tick` falla aquí.
    const tick = browser.state.ticks[0] ?? (async () => assert.fail('el monitor no registró muestreo'));
    return { monitor, tick, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

describe('startCameraMonitor', () => {
  it('valida sus argumentos de integración', async () => {
    await assert.rejects(startCameraMonitor(undefined as never), TypeError);
    await assert.rejects(
      startCameraMonitor({ video: {}, onFrame: 'x', onStatus: () => {} } as never),
      TypeError,
    );
    await assert.rejects(
      startCameraMonitor({ video: {}, onFrame: async () => {}, onStatus: null } as never),
      TypeError,
    );
    await assert.rejects(
      startCameraMonitor({ video: {}, onFrame: async () => {}, onStatus: () => {}, deviceId: 7 } as never),
      TypeError,
    );
  });

  it('lanza claro cuando no hay document/canvas', async () => {
    const restore = installGlobal('document', undefined);
    const statuses: string[] = [];
    try {
      await assert.rejects(
        startCameraMonitor({
          video: {},
          onFrame: async () => {},
          onStatus: (message: string) => statuses.push(message),
        } as never),
        /document and canvas/,
      );
      assert.deepEqual(statuses, []);
    } finally {
      restore();
    }
  });

  it('lanza claro cuando el canvas no tiene contexto 2d y no pide la cámara antes', async () => {
    const browser = createFakeBrowser({ noContext2d: true });
    const restore = browser.install();
    try {
      await assert.rejects(
        startCameraMonitor({
          video: browser.video as never,
          onFrame: async () => {},
          onStatus: () => {},
        } as never),
        /2d canvas context/,
      );
      assert.deepEqual(browser.state.constraints, []);
    } finally {
      restore();
    }
  });

  it('reporta cuando el navegador no expone getUserMedia y deja un stop inerte', async () => {
    const browser = createFakeBrowser({ noMediaDevices: true });
    const statuses: string[] = [];
    const env = await startMonitorEnv(browser, {
      onFrame: async () => {},
      onStatus: (message) => statuses.push(message),
    });
    try {
      assert.equal(statuses.length, 1);
      assert.match(statuses[0], /getUserMedia/);
      assert.equal(browser.state.ticks.length, 0, 'un monitor inerte no deja temporizador');
      env.monitor.stop();
      env.monitor.stop();
      assert.equal(browser.state.stoppedTracks, 0);
      assert.deepEqual(browser.state.dataUrls, []);
    } finally {
      env.restore();
    }
  });

  it('reporta el permiso denegado sin dejar cámara encendida', async () => {
    const browser = createFakeBrowser({
      getUserMedia: async () => {
        const error = new Error('Permission denied');
        error.name = 'NotAllowedError';
        throw error;
      },
    });
    const statuses: string[] = [];
    const env = await startMonitorEnv(browser, {
      onFrame: async () => {},
      onStatus: (message) => statuses.push(message),
    });
    try {
      assert.equal(statuses.length, 1);
      assert.match(statuses[0], /permiso de cámara denegado/);
      assert.equal(browser.video.srcObject, null);
      assert.equal(browser.state.ticks.length, 0, 'sin cámara no queda muestreo corriendo');
      env.monitor.stop();
      assert.equal(browser.state.stoppedTracks, 0);
    } finally {
      env.restore();
    }
  });

  it('pide la cámara sólo al arrancar, con las restricciones del PLAN', async () => {
    const browser = createFakeBrowser();
    const statuses: string[] = [];
    const env = await startMonitorEnv(browser, {
      onFrame: async () => {},
      onStatus: (message) => statuses.push(message),
      deviceId: 'cam-2',
    });
    try {
      assert.deepEqual(browser.state.constraints, [
        {
          video: { width: { ideal: 640 }, height: { ideal: 480 }, deviceId: { exact: 'cam-2' } },
          audio: false,
        },
      ]);
      assert.equal(browser.video.muted, true);
      assert.equal(browser.video.playsInline, true);
      assert.equal(browser.video.srcObject, browser.stream);
      assert.equal(browser.canvas.width, FRAME_WIDTH);
      assert.equal(browser.canvas.height, FRAME_HEIGHT);
      assert.deepEqual(statuses, []);
    } finally {
      env.monitor.stop();
      env.restore();
    }
  });

  it('entrega el primer cuadro y luego nada mientras no cambie', async () => {
    const browser = createFakeBrowser();
    const frames: string[] = [];
    const statuses: string[] = [];
    const env = await startMonitorEnv(browser, {
      onFrame: (dataUrl) => {
        frames.push(dataUrl);
      },
      onStatus: (message) => statuses.push(message),
    });
    try {
      await env.tick();
      assert.deepEqual(frames, [STUB_DATA_URL]);
      assert.deepEqual(browser.state.dataUrls, [{ type: 'image/jpeg', quality: 0.75 }]);
      assert.equal(browser.video.srcObject, browser.stream);

      await env.tick();
      await env.tick();
      assert.deepEqual(frames, [STUB_DATA_URL]);
      assert.equal(browser.state.drawn, 3, 'sigue muestreando aunque no capture');
      assert.deepEqual(statuses, []);
    } finally {
      env.monitor.stop();
      env.restore();
    }
  });

  it('stop detiene pistas y temporizador, y es idempotente', async () => {
    const browser = createFakeBrowser();
    const frames: string[] = [];
    const env = await startMonitorEnv(browser, {
      onFrame: (dataUrl) => {
        frames.push(dataUrl);
      },
      onStatus: () => {},
    });
    try {
      await env.tick();
      assert.equal(frames.length, 1);

      env.monitor.stop();
      assert.equal(browser.state.stoppedTracks, 1);
      assert.deepEqual(browser.state.cleared, [1]);
      assert.equal(browser.video.srcObject, null);

      env.monitor.stop();
      assert.equal(browser.state.stoppedTracks, 1);
      assert.deepEqual(browser.state.cleared, [1]);

      await env.tick();
      assert.equal(frames.length, 1, 'tras stop no se entrega nada');
      assert.equal(browser.state.drawn, 1, 'tras stop no se muestrea');
    } finally {
      env.restore();
    }
  });

  it('entrega un cambio estable una sola vez y respeta el cooldown', async () => {
    const browser = createFakeBrowser();
    const frames: string[] = [];
    const statuses: string[] = [];
    const realNow = Date.now;
    let current = 1_000_000;
    Date.now = () => current;

    const env = await startMonitorEnv(browser, {
      onFrame: (dataUrl) => {
        frames.push(dataUrl);
      },
      onStatus: (message) => statuses.push(message),
    });
    try {
      await env.tick(); // primera imagen (negra)
      assert.equal(frames.length, 1);

      browser.setFrame(solidFrame(255, 255, 255));
      current += 250;
      await env.tick(); // el salto: todavía no hay quietud
      assert.equal(frames.length, 1);

      current += 1000;
      await env.tick(); // quietud suficiente, pero aún sin cooldown
      assert.equal(frames.length, 1);

      current += 1000;
      await env.tick(); // 2000 ms desde la primera entrega
      assert.equal(frames.length, 1);

      current += 500;
      await env.tick(); // 2500 ms: ya toca
      assert.equal(frames.length, 2);

      current += 250;
      await env.tick(); // sin cambio nuevo: no repite
      assert.equal(frames.length, 2);
      assert.deepEqual(statuses, []);
    } finally {
      Date.now = realNow;
      env.monitor.stop();
      env.restore();
    }
  });

  it('un onFrame rechazado no mata la cámara y se reintenta una vez por cooldown', async () => {
    const browser = createFakeBrowser();
    const statuses: string[] = [];
    const attempts: string[] = [];
    let failing = true;
    const realNow = Date.now;
    let current = 5_000_000;
    Date.now = () => current;

    const env = await startMonitorEnv(browser, {
      onFrame: (dataUrl) => {
        attempts.push(dataUrl);
        if (failing) {
          failing = false;
          return Promise.reject(new Error('panel caído'));
        }
        return Promise.resolve();
      },
      onStatus: (message) => statuses.push(message),
    });
    try {
      await env.tick(); // primera imagen: la entrega falla
      assert.equal(attempts.length, 1);
      assert.equal(statuses.length, 1);
      assert.match(statuses[0], /onFrame/);

      current += 1000;
      await env.tick(); // mismo cuadro: la puerta no lo marca como cambio, y no toca reintento
      assert.equal(attempts.length, 1);

      current += 1600;
      await env.tick(); // 2600 ms >= cooldown: reintento del pendiente
      assert.equal(attempts.length, 2);
      assert.equal(statuses.length, 1);

      current += 3000;
      await env.tick(); // ya no hay pendiente
      assert.equal(attempts.length, 2);

      assert.equal(browser.state.stoppedTracks, 0, 'la cámara sigue viva');
      assert.equal(browser.video.srcObject, browser.stream);
    } finally {
      Date.now = realNow;
      env.monitor.stop();
      env.restore();
    }
  });

  it('stop durante una entrega en vuelo no deja carrera ni reportes tardíos', async () => {
    const browser = createFakeBrowser();
    const statuses: string[] = [];
    let release: (error: Error) => void = () => {};
    const inFlight = new Promise<void>((_resolve, reject) => {
      release = reject;
    });

    const env = await startMonitorEnv(browser, {
      onFrame: () => inFlight,
      onStatus: (message) => statuses.push(message),
    });
    try {
      const tickPromise = env.tick();
      env.monitor.stop();
      assert.equal(browser.state.stoppedTracks, 1);
      assert.equal(browser.video.srcObject, null);

      release(new Error('respuesta tardía'));
      await tickPromise;
      assert.deepEqual(statuses, [], 'tras stop no se reporta el cuadro en vuelo');

      await env.tick();
      assert.equal(browser.state.drawn, 1, 'tras stop no se vuelve a muestrear');
    } finally {
      env.restore();
    }
  });

  it('reporta un error de lectura una sola vez y sólo apaga si es de seguridad', async () => {
    // Fallo pasajero: se reporta una vez y la cámara sigue viva.
    const transient = createFakeBrowser({
      drawImage: () => {
        throw new Error('cuadro todavía no listo');
      },
    });
    const transientStatuses: string[] = [];
    const transientEnv = await startMonitorEnv(transient, {
      onFrame: async () => {},
      onStatus: (message) => transientStatuses.push(message),
    });
    try {
      await transientEnv.tick();
      await transientEnv.tick();
      assert.equal(transientStatuses.length, 1);
      assert.match(transientStatuses[0], /No pude leer el cuadro/);
      assert.equal(transient.state.stoppedTracks, 0);
      assert.equal(transient.video.srcObject, transient.stream);
    } finally {
      transientEnv.monitor.stop();
      transientEnv.restore();
    }

    // Canvas contaminado (SecurityError): no se arregla solo, se apaga.
    const security = createFakeBrowser({
      drawImage: () => {
        const error = new Error('canvas contaminado');
        error.name = 'SecurityError';
        throw error;
      },
    });
    const securityStatuses: string[] = [];
    const securityEnv = await startMonitorEnv(security, {
      onFrame: async () => {},
      onStatus: (message) => securityStatuses.push(message),
    });
    try {
      await securityEnv.tick();
      assert.equal(securityStatuses.length, 1);
      assert.match(securityStatuses[0], /No pude leer el cuadro/);
      assert.equal(security.state.stoppedTracks, 1);
      assert.equal(security.video.srcObject, null);
    } finally {
      securityEnv.restore();
    }
  });

  it('no pide cuadros mientras el video no tenga datos', async () => {
    const browser = createFakeBrowser({ readyState: 0 });
    const frames: string[] = [];
    const env = await startMonitorEnv(browser, {
      onFrame: (dataUrl) => {
        frames.push(dataUrl);
      },
      onStatus: () => {},
    });
    try {
      await env.tick();
      assert.deepEqual(frames, []);
      assert.equal(browser.state.drawn, 0);
      assert.deepEqual(browser.state.dataUrls, []);
    } finally {
      env.monitor.stop();
      env.restore();
    }
  });
});
