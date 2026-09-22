/** Explicit opt-in: uses real provider APIs with a synthetic microphone, never a human recording. */
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import assert from "node:assert/strict";
if (process.env.RUN_LIVE_VOICE_CHECK !== "1")
  throw Error("Set RUN_LIVE_VOICE_CHECK=1 to authorize real provider calls.");
const provider = process.env.VOICE_CHECK_PROVIDER || "nvidia";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${resolve("runtime/fake-microphone.wav")}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage({
  permissions: ["microphone"],
  viewport: { width: 1400, height: 1100 },
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(45000);
try {
  await page.goto("http://127.0.0.1:3212/");
  await page.waitForTimeout(300);
  await page.selectOption("#provider", provider);
  await page.click("#start");
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("#transcript li")).some(
      (li, i, list) =>
        li.querySelector("strong")?.textContent === "Tú" &&
        list
          .slice(i + 1)
          .some((x) => x.querySelector("strong")?.textContent === "Organima"),
    ),
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#metrics tr").length >= 1,
  );
  console.log(
    JSON.stringify({
      provider,
      state: await page.locator("#state").innerText(),
      error: await page.locator("#error").innerText(),
      transcript: await page.locator("#transcript").innerText(),
      metrics: await page.locator("#metrics").innerText(),
      browserErrors: errors,
    }),
  );
  await page.screenshot({
    path: `runtime/full-agent-${provider}.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await page.click("#stop");
  assert.match(await page.locator("#state").innerText(), /terminada/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  console.log("FULL_AGENT_LIVE_OK_SYNTHETIC_MIC");
} catch (e) {
  console.log(
    JSON.stringify({
      state: await page.locator("#state").innerText(),
      error: await page.locator("#error").innerText(),
      interim: await page.locator("#interim").innerText(),
      transcript: await page.locator("#transcript").innerText(),
      browserErrors: errors,
    }),
  );
  throw e;
} finally {
  await browser.close();
}
