import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createVoiceLab } from "../src/voice-lab.js";
import { createVoiceAgents } from "../src/voice-agents.js";
async function setup(env: NodeJS.ProcessEnv, fetcher: typeof fetch) {
  const lab = createVoiceLab({ env: {} });
  const agents = createVoiceAgents(env, fetcher);
  lab.app.use("/api/lab", agents.router);
  const server = lab.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as any;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      agents.close();
      lab.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test("full agents: ephemeral token only, fixed upstream, no permanent key in response", async () => {
  let called = false;
  const service = await setup(
    { ELEVENLABS_API_KEY: "private-key", ELEVENLABS_AGENT_ID: "test-agent" },
    async (url, init) => {
      called = true;
      assert.equal(
        String(url),
        "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=test-agent",
      );
      assert.equal((init?.headers as any)["xi-api-key"], "private-key");
      return Response.json({ token: "short-lived" });
    },
  );
  try {
    const r = await fetch(service.base + "/api/lab/agents/elevenlabs-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { token: "short-lived" });
    assert.equal(called, true);
  } finally {
    await service.close();
  }
});
test("full agents: rejects cross origin before token minting", async () => {
  const service = await setup(
    { ELEVENLABS_API_KEY: "private-key" },
    async () => {
      throw Error("must not call");
    },
  );
  try {
    const r = await fetch(service.base + "/api/lab/agents/elevenlabs-session", {
      method: "POST",
      headers: {
        origin: "https://evil.invalid",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(r.status, 403);
  } finally {
    await service.close();
  }
});
test("full agents: upstream errors do not expose key or provider body", async () => {
  const service = await setup(
    { ELEVENLABS_API_KEY: "private-key" },
    async () => new Response("private-key", { status: 401 }),
  );
  try {
    const r = await fetch(service.base + "/api/lab/agents/elevenlabs-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /private-key/);
  } finally {
    await service.close();
  }
});
