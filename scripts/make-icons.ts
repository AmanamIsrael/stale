import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Rasterizes assets/icon.svg to public/icons/icon{16,32,48,128}.png by
// screenshotting it in a throwaway headless Chrome at each viewport size.
// The SVG root uses width/height 100% so it fills whatever viewport is set.

const SVG_PATH = resolve(import.meta.dirname, "../assets/icon.svg");
const OUT_DIR = resolve(import.meta.dirname, "../public/icons");
const SIZES = [16, 32, 48, 128] as const;
const PORT = 9800 + Math.floor(Math.random() * 200);
const CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "stale-icons-"));
let chrome: ChildProcess | null = null;
let ws: WebSocket | null = null;

function cleanup(): void {
  ws?.close();
  chrome?.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

async function main(): Promise<void> {
  chrome = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const cdpHttp = `http://localhost:${PORT}`;
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    await sleep(500);
    try {
      version = await fetch(`${cdpHttp}/json/version`).then((r) => r.json());
    } catch {}
  }
  if (!version) throw new Error("chrome did not come up");

  ws = new WebSocket(version.webSocketDebuggerUrl);
  const sock: WebSocket = ws;
  await new Promise((res, rej) => {
    sock.onopen = res;
    sock.onerror = rej;
  });

  let msgId = 0;
  const pending = new Map();
  sock.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const send = (method: string, params: object = {}, sessionId?: string): Promise<unknown> => {
    const id = ++msgId;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };

  const target = (await send("Target.createTarget", { url: `file://${SVG_PATH}` })) as {
    targetId: string;
  };
  const attached = (await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string };
  const { sessionId } = attached;

  await send("Page.enable", {}, sessionId);
  // SVG documents paint on an opaque white page background; make it transparent
  // so the rounded corners of the icon survive the screenshot.
  await send(
    "Emulation.setDefaultBackgroundColorOverride",
    { color: { r: 0, g: 0, b: 0, a: 0 } },
    sessionId,
  );
  await sleep(500); // let the SVG document finish painting

  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: size, height: size, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await sleep(100); // relayout after the viewport change
    const shot = (await send(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
    )) as { data: string };
    const out = join(OUT_DIR, `icon${size}.png`);
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`wrote ${out}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  await main();
} catch (err) {
  console.error("ICONS: ERROR", err);
  process.exitCode = 1;
} finally {
  cleanup();
}
