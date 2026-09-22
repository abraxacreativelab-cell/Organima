/** Local full-agent sessions. Long-lived keys never enter the browser. */
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";

export function createVoiceAgents(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  const router = express.Router();
  const agentId =
    env.ELEVENLABS_AGENT_ID || "agent_5401m355308bfa4sbdm9m7xb2w5g";
  const python =
    env.NVIDIA_ASR_PYTHON || resolve("runtime/nvidia-py/bin/python");
  const bridge = resolve("scripts/nvidia-asr-bridge.py");
  router.get("/agents/status", (_req, res) =>
    res.json({
      attentionProvider: env.ORGANIMA_ATTENTION_PROVIDER || "nvidia",
      elevenlabs: !!env.ELEVENLABS_API_KEY,
      nvidia:
        !!env.NVIDIA_API_KEY &&
        !!env.NVIDIA_TTS_VOICE &&
        existsSync(python) &&
        existsSync(bridge),
      nvidiaReason: !env.NVIDIA_API_KEY
        ? "Falta acceso NVIDIA."
        : !existsSync(python) || !existsSync(bridge)
          ? "Falta instalar el puente de reconocimiento."
          : !env.NVIDIA_TTS_VOICE
            ? "Falta configurar voz NVIDIA."
            : null,
    }),
  );
  router.post("/agents/elevenlabs-session", async (_req, res) => {
    if (!env.ELEVENLABS_API_KEY) {
      res.status(503).json({ error: "ElevenLabs sin configurar." });
      return;
    }
    try {
      const upstream = await fetcher(
        "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=" +
          encodeURIComponent(agentId),
        {
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!upstream.ok) {
        res
          .status(502)
          .json({
            error:
              "No se pudo abrir ElevenLabs (HTTP " + upstream.status + ").",
          });
        return;
      }
      const data = (await upstream.json()) as { token?: string };
      if (typeof data.token !== "string") throw Error("token");
      res.setHeader("Cache-Control", "no-store");
      res.json({ token: data.token });
    } catch {
      res.status(502).json({ error: "ElevenLabs no pudo iniciar la sesión." });
    }
  });
  const sockets = new Set<WebSocket>();
  let wss: WebSocketServer | undefined;
  function attach(server: Server) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/api/lab/agents/nvidia-asr") {
        socket.destroy();
        return;
      }
      if (
        req.headers.origin !== `http://${req.headers.host}` ||
        !["127.0.0.1", "localhost"].includes(
          (req.headers.host || "").split(":")[0],
        ) ||
        !env.NVIDIA_API_KEY ||
        !existsSync(python) ||
        !existsSync(bridge) ||
        sockets.size >= 2
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(req, socket, head, (ws) =>
        wss!.emit("connection", ws),
      );
    });
    wss.on("connection", (ws) => {
      sockets.add(ws);
      const child = spawn(python, ["-u", bridge], {
        env: {
          PATH: process.env.PATH,
          NVIDIA_API_KEY: env.NVIDIA_API_KEY,
          NVIDIA_ASR_FUNCTION_ID:
            env.NVIDIA_ASR_FUNCTION_ID ||
            "71203149-d3b7-4460-8231-1be2543a1fca",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stopped = false,
        buffer = "",
        total = 0;
      const send = (value: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        sockets.delete(ws);
        child.stdin.destroy();
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
        kill.unref();
        child.once("exit", () => clearTimeout(kill));
      };
      const timer = setTimeout(() => {
        send({
          type: "error",
          code: "SESSION_LIMIT",
          message:
            "La prueba dura cinco minutos. Vuelve a iniciar para continuar.",
        });
        ws.close(1000);
        stop();
      }, 300000);
      ws.on("message", (data, binary) => {
        if (!binary || stopped) return;
        const chunk = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        total += chunk.length;
        if (
          chunk.length % 2 ||
          total > 12_000_000 ||
          child.stdin.writableLength > 256000
        ) {
          send({ type: "error", code: "AUDIO_LIMIT" });
          ws.close(1009);
          stop();
          return;
        }
        child.stdin.write(chunk);
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) {
          ws.close(1011);
          stop();
          return;
        }
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "transcript" && typeof event.text === "string")
              send({
                type: "transcript",
                text: event.text.slice(0, 1600),
                final: event.final === true,
              });
            else if (event.type === "error")
              send({
                type: "error",
                code:
                  typeof event.code === "string"
                    ? event.code.replace(/[^A-Z_]/g, "").slice(0, 60)
                    : "ASR_ERROR",
              });
          } catch {
            send({ type: "error", code: "BRIDGE_PROTOCOL" });
          }
        }
      });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", () => {
        send({ type: "error", code: "BRIDGE_START" });
        ws.close(1011);
        stop();
      });
      child.on("exit", () => {
        if (!stopped) {
          send({ type: "error", code: "ASR_SESSION_ENDED" });
          ws.close(1000);
          stop();
        }
      });
      ws.on("close", stop);
      ws.on("error", stop);
    });
  }
  return {
    router,
    attach,
    close() {
      for (const ws of sockets) ws.close(1001);
      wss?.close();
    },
  };
}
