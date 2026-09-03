import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_PATH = resolve(import.meta.dirname, "../dist");
const PORT = 9400 + Math.floor(Math.random() * 400);

interface CdpTarget {
  targetId: string;
  type: string;
  url: string;
}

const profile = mkdtempSync(join(tmpdir(), "stale-smoke-"));
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
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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

  const loaded = (await send("Extensions.loadUnpacked", { path: EXT_PATH })) as { id: string };
  console.log(`extension loaded: ${loaded.id}`);

  let sw: CdpTarget | undefined;
  for (let i = 0; i < 40 && !sw; i++) {
    await sleep(500);
    const { targetInfos } = (await send("Target.getTargets")) as { targetInfos: CdpTarget[] };
    sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/sw.js"));
  }
  if (!sw) throw new Error("service worker never started");
  console.log(`service worker up: ${sw.url}`);

  const attached = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })) as {
    sessionId: string;
  };

  const result = (await send(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        await chrome.storage.sync.set({ settings: { cadenceMinutes: 0, paused: false } });
        await chrome.tabs.create({ url: 'about:blank#stale-1' });
        await chrome.tabs.create({ url: 'about:blank#stale-2' });
        await chrome.tabs.create({ url: 'about:blank#active' });
        chrome.alarms.create('sweep', { delayInMinutes: 0.5 });
        await new Promise((resolve) => {
          const listener = (changes, area) => {
            if (area === 'local' && changes.corral) {
              chrome.storage.onChanged.removeListener(listener);
              resolve();
            }
          };
          chrome.storage.onChanged.addListener(listener);
        });
        await new Promise((r) => setTimeout(r, 1000));
        const corral = (await chrome.storage.local.get('corral')).corral ?? [];
        const badgeRaw = JSON.stringify(await chrome.action.getBadgeText({}));
        const closedToday = JSON.stringify((await chrome.storage.local.get('closedToday')).closedToday);
        const tabs = await chrome.tabs.query({});
        const activeTabs = tabs.filter((t) => t.active);
        return { corralSize: corral.length, badgeRaw, closedToday, tabs: tabs.length, activeTabs: activeTabs.length };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    attached.sessionId,
  )) as { result: { value: Record<string, number | string> } };

  const r = result.result.value;
  console.log("result:", JSON.stringify(r));

  const checks = [
    ["closed 3 stale tabs, 1 survives", r.tabs === 1],
    ["one active tab remains", r.activeTabs === 1],
    ["corral captured 3 entries", r.corralSize === 3],
    ["badge shows count", r.badgeRaw === '"3"'],
    ["closed-today counter = 3", r.closedToday === '{"count":3,"date":"' + new Date().toISOString().slice(0, 10) + '"}'],
  ];

  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
    if (!ok) pass = false;
  }
  console.log(pass ? "SMOKE: PASS" : "SMOKE: FAIL");
  if (!pass) process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  await main();
} catch (err) {
  console.error("SMOKE: ERROR", err);
  process.exitCode = 1;
} finally {
  cleanup();
}
