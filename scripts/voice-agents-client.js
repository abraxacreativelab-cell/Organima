import { Conversation } from "@elevenlabs/client";
const $ = (id) => document.getElementById(id);
let epoch = 0,
  active = false,
  starting = false,
  provider = "elevenlabs",
  capture = null,
  audio = null,
  stream = null,
  worklet = null,
  ws = null,
  eleven = null,
  poll = null;
let generation = 0,
  controller = null,
  sources = new Set(),
  nextAudio = 0,
  odd = null,
  history = [],
  partial = "",
  finals = [],
  silenceTimer = null,
  spoken = false,
  lastVoice = 0,
  voiceSince = 0,
  quiet = true,
  measure = null,
  rows = [],
  awaitingResponse = false,
  responseReady = false;
const stacks = {
  elevenlabs: "Scribe Realtime → Gemini 2.5 Flash → Eleven Flash",
  nvidia: "Parakeet (NVIDIA) → Nemotron (Nebius) → Magpie Isabela (NVIDIA)",
};
const sayState = (text) => {
  $("state").textContent = text;
};
const error = (text) => {
  $("error").textContent = text;
};
function log(role, text) {
  const li = document.createElement("li"),
    strong = document.createElement("strong"),
    span = document.createElement("span");
  strong.textContent = role === "user" ? "Tú" : "Organima";
  span.textContent = text;
  li.append(strong, span);
  $("transcript").append(li);
  li.scrollIntoView({ block: "nearest" });
}
function renderRows() {
  $("metrics").replaceChildren();
  for (const row of rows.slice(-12)) {
    const tr = document.createElement("tr");
    for (const text of [
      row.provider,
      row.ms == null ? "n/d" : (row.ms / 1000).toFixed(2) + " s",
      row.status,
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    $("metrics").append(tr);
  }
}
function finishMeasure(status) {
  if (measure) {
    measure.status = status;
    renderRows();
    measure = null;
  }
}
function firstAudio(at) {
  if (!spoken || !lastVoice || measure || !responseReady) return;
  responseReady = false;
  awaitingResponse = false;
  measure = {
    provider: provider === "nvidia" ? "NVIDIA" : "ElevenLabs",
    ms: Math.max(0, at - lastVoice),
    status: "Respondiendo",
  };
  rows.push(measure);
  if (rows.length > 20) rows.shift();
  spoken = false;
  renderRows();
}
function interrupt() {
  generation++;
  controller?.abort();
  controller = null;
  for (const source of sources) {
    try {
      source.stop();
    } catch {}
    source.disconnect();
  }
  sources.clear();
  nextAudio = 0;
  odd = null;
  finishMeasure("Interrumpido");
}
function activity(rms) {
  if (!active) return;
  const now = performance.now();
  if (rms > 0.018) {
    lastVoice = now;
    voiceSince ||= now;
    if (now - voiceSince > 70 && quiet) {
      quiet = false;
      spoken = true;
      if (provider === "nvidia") interrupt();
      else finishMeasure("Interrumpido");
      sayState("Te escucho…");
    }
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      quiet = true;
      voiceSince = 0;
      if (provider === "nvidia") flushUtterance();
    }, 600);
  } else if (quiet) voiceSince = 0;
}
function flushUtterance() {
  if (!active || !quiet || !finals.length) return;
  const text = finals.join(" ").trim();
  finals = [];
  partial = "";
  $("interim").textContent = "";
  if (text) void turn(text);
}
async function checked(response) {
  if (response.ok) return response;
  let message = "Servicio no disponible (HTTP " + response.status + ").";
  try {
    message = (await response.json()).error || message;
  } catch {}
  throw Error(message);
}
function post(path, body, signal) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).then(checked);
}
function play(chunk) {
  let bytes = chunk;
  if (odd !== null) {
    const joined = new Uint8Array(bytes.length + 1);
    joined[0] = odd;
    joined.set(bytes, 1);
    bytes = joined;
    odd = null;
  }
  if (bytes.length % 2) {
    odd = bytes.at(-1);
    bytes = bytes.subarray(0, -1);
  }
  if (!bytes.length) return;
  const buffer = audio.createBuffer(1, bytes.length / 2, 22050),
    floats = buffer.getChannelData(0),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = 0; i < floats.length; i++)
    floats[i] = view.getInt16(i * 2, true) / 32768;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  const start = Math.max(audio.currentTime + 0.035, nextAudio);
  nextAudio = start + buffer.duration;
  sources.add(source);
  source.onended = () => {
    sources.delete(source);
    source.disconnect();
  };
  source.start(start);
  firstAudio(performance.now() + (start - audio.currentTime) * 1000);
}
async function turn(text) {
  interrupt();
  const g = generation;
  controller = new AbortController();
  const signal = controller.signal;
  log("user", text);
  sayState("Organima está pensando…");
  try {
    const response = await (
      await post("/api/lab/turn", { message: text, history }, signal)
    ).json();
    if (g !== generation || !active) return;
    if (response.text.length > 1600)
      throw Error("La respuesta fue demasiado larga. Pide una versión breve.");
    log("assistant", response.text);
    responseReady = true;
    history.push(
      { role: "user", text },
      { role: "assistant", text: response.text },
    );
    history = history.slice(-12);
    const tts = await post(
      "/api/lab/tts",
      { provider: "nvidia", text: response.text },
      signal,
    );
    const reader = tts.body.getReader();
    sayState("Organima responde…");
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (g !== generation || !active) {
          await reader.cancel();
          return;
        }
        if (done) break;
        play(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (odd !== null) throw Error("Audio incompleto.");
    while (sources.size && g === generation)
      await new Promise((r) => setTimeout(r, 30));
    if (g === generation) {
      finishMeasure("Completo");
      sayState("Te escucho…");
    }
  } catch (e) {
    if (g === generation && active) {
      interrupt();
      error(e.message);
      sayState("Puedes volver a hablar.");
    }
  }
}
async function startCapture(e) {
  if (e !== epoch) return;
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  if (e !== epoch) {
    media.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = media;
  const ctx = new AudioContext({ sampleRate: 16000 });
  capture = ctx;
  await ctx.audioWorklet.addModule("/voice-capture-worklet.js");
  if (e !== epoch) {
    media.getTracks().forEach((t) => t.stop());
    if (ctx.state !== "closed") await ctx.close();
    return;
  }
  await ctx.resume();
  if (e !== epoch) return;
  const node = new AudioWorkletNode(ctx, "voice-capture");
  worklet = node;
  const input = ctx.createMediaStreamSource(media),
    mute = ctx.createGain();
  mute.gain.value = 0;
  input.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  node.port.onmessage = (event) => {
    if (e !== epoch || !active) return;
    const data = event.data;
    if (typeof data.rms === "number") activity(data.rms);
    if (
      data.pcm &&
      provider === "nvidia" &&
      ws?.readyState === WebSocket.OPEN
    ) {
      if (ws.bufferedAmount > 256000) {
        error(
          "La conexión no recibe audio a tiempo. Reinicia la conversación.",
        );
        void stop();
        return;
      }
      ws.send(data.pcm);
    }
  };
}

async function stop() {
  epoch++;
  active = false;
  starting = false;
  clearTimeout(silenceTimer);
  clearInterval(poll);
  interrupt();
  ws?.close();
  ws = null;
  const old = eleven;
  eleven = null;
  worklet?.disconnect();
  worklet = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const oldCapture = capture;
  capture = null;
  const oldAudio = audio;
  audio = null;
  $("start").disabled = false;
  $("stop").disabled = true;
  $("provider").disabled = false;
  $("call").classList.remove("live");
  sayState("Conversación terminada.");
  await Promise.allSettled([
    old?.endSession(),
    oldCapture?.close(),
    oldAudio?.close(),
  ]);
}
async function start() {
  if (active || starting) return;
  starting = true;
  const e = ++epoch;
  $("start").disabled = true;
  $("stop").disabled = false;
  $("provider").disabled = true;
  error("");
  sayState("Conectando…");
  history = [];
  finals = [];
  spoken = false;
  awaitingResponse = false;
  responseReady = false;
  lastVoice = 0;
  voiceSince = 0;
  quiet = true;
  $("transcript").replaceChildren();
  try {
    audio = new AudioContext();
    await audio.resume();
    await startCapture(e);
    if (e !== epoch) return;
    if (provider === "nvidia") {
      ws = new WebSocket(
        "ws://" + location.host + "/api/lab/agents/nvidia-asr",
      );
      ws.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("NVIDIA no abrió la conexión.")),
          10000,
        );
        ws.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(Error("No se pudo conectar NVIDIA."));
        };
      });
      if (e !== epoch) return;
      ws.onmessage = (event) => {
        if (e !== epoch) return;
        const m = JSON.parse(event.data);
        if (m.type === "error") {
          error(
            "Reconocimiento NVIDIA: " +
              (m.code || "error") +
              ". Vuelve a iniciar.",
          );
          void stop();
          return;
        }
        if (m.type === "transcript") {
          partial = m.text;
          $("interim").textContent = partial;
          if (m.final) {
            finals.push(partial);
            flushUtterance();
          }
        }
      };
      ws.onclose = () => {
        if (e === epoch) {
          error("Se cerró la conexión de reconocimiento. Vuelve a iniciar.");
          void stop();
        }
      };
    } else {
      const session = await (
        await post("/api/lab/agents/elevenlabs-session", {})
      ).json();
      if (e !== epoch) return;
      const connection = await Conversation.startSession({
        conversationToken: session.token,
        connectionType: "webrtc",
        onMessage: (message) => {
          if (e === epoch) {
            const user = message.source === "user";
            if (user) {
              awaitingResponse = true;
              responseReady = false;
            } else if (awaitingResponse) responseReady = true;
            log(user ? "user" : "assistant", message.message);
          }
        },
        onModeChange: ({ mode }) => {
          if (e !== epoch) return;
          sayState(mode === "speaking" ? "Organima responde…" : "Te escucho…");
          if (mode === "listening") finishMeasure("Completo");
        },
        onInterruption: () => {
          if (e === epoch) finishMeasure("Interrumpido");
        },
        onError: () => {
          if (e === epoch) {
            error("ElevenLabs no pudo mantener la conversación.");
            void stop();
          }
        },
        onDisconnect: () => {
          if (e === epoch) void stop();
        },
      });
      if (e !== epoch) {
        await connection.endSession();
        return;
      }
      eleven = connection;
      poll = setInterval(() => {
        if (e !== epoch || !eleven) return;
        if (eleven.getOutputVolume() > 0.01) firstAudio(performance.now());
      }, 25);
    }
    if (e !== epoch) return;
    active = true;
    starting = false;
    $("call").classList.add("live");
    sayState("Te escucho…");
  } catch (err) {
    if (e === epoch) {
      error(err.message);
      await stop();
    }
  }
}
$("start").onclick = start;
$("stop").onclick = () => void stop();
$("provider").onchange = () => {
  provider = $("provider").value;
  $("stack").textContent = stacks[provider];
  error("");
};
$("stack").textContent = stacks[provider];
window.addEventListener("pagehide", () => void stop());
fetch("/api/lab/agents/status")
  .then(checked)
  .then((r) => r.json())
  .then((s) => {
    if (!s.nvidia) {
      $("provider").querySelector("[value=nvidia]").disabled = true;
      error(s.nvidiaReason);
    }
    if (!s.elevenlabs)
      $("provider").querySelector("[value=elevenlabs]").disabled = true;
  })
  .catch((e) => error(e.message));
