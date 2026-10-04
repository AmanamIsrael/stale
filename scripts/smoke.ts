import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_PATH = resolve(import.meta.dirname, "../dist");
const PORT = 9400 + Math.floor(Math.random() * 400);
const headed = process.argv.includes("--headed");
const keepOpen = process.argv.includes("--keep-open");
if (keepOpen && !headed) throw new Error("--keep-open requires --headed");

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
  if (keepOpen && process.exitCode !== 1) {
    chrome?.unref();
    console.log(`Chrome left open for testing. Profile: ${profile}`);
    return;
  }
  chrome?.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

async function main(): Promise<void> {
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      ...(headed ? [] : ["--headless=new"]),
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: keepOpen },
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
        const [initial] = await chrome.tabs.query({});
        await chrome.tabs.update(initial.id, { url: 'https://example.com/?stale-0' });
        await chrome.tabs.create({ url: 'https://example.com/?stale-1' });
        await chrome.tabs.create({ url: 'https://example.com/?stale-2' });
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
        const closedToday = (await chrome.storage.local.get('closedToday')).closedToday;
        const tabs = await chrome.tabs.query({});
        const activeTabs = tabs.filter((t) => t.active);
        return { corralSize: corral.length, badgeRaw, closedToday, tabs: tabs.length, activeTabs: activeTabs.length };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    attached.sessionId,
  )) as { result: { value: {
    corralSize: number;
    badgeRaw: string;
    closedToday: { date: string; count: number };
    tabs: number;
    activeTabs: number;
  } }; exceptionDetails?: unknown };

  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));

  const r = result.result.value;
  console.log("result:", JSON.stringify(r));

  const checks = [
    ["closed 3 stale tabs, 1 survives", r.tabs === 1],
    ["one active tab remains", r.activeTabs === 1],
    ["corral captured 3 entries", r.corralSize === 3],
    ["badge shows count", r.badgeRaw === '"3"'],
    ["closed-today counter = 3", r.closedToday.count === 3 && r.closedToday.date === localDateKey()],
  ];

  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
    if (!ok) pass = false;
  }
  console.log(pass ? "SMOKE: PASS" : "SMOKE: FAIL");
  if (!pass) process.exitCode = 1;

  const popup = (await send("Target.createTarget", {
    url: `chrome-extension://${loaded.id}/popup.html`,
  })) as { targetId: string };
  const popupSession = (await send("Target.attachToTarget", {
    targetId: popup.targetId,
    flatten: true,
  })) as { sessionId: string };
  // A new target initially has an about:blank execution context. Wait for the
  // extension document before starting an evaluation that spans async work.
  let popupReady = false;
  for (let i = 0; i < 40 && !popupReady; i++) {
    try {
      const ready = (await send("Runtime.evaluate", {
        expression: `location.href === 'chrome-extension://${loaded.id}/popup.html' && document.readyState === 'complete'`,
        returnByValue: true,
      }, popupSession.sessionId)) as { result: { value: boolean } };
      popupReady = ready.result.value;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Execution context was destroyed")) throw error;
    }
    if (!popupReady) await sleep(50);
  }
  if (!popupReady) throw new Error("Popup page did not finish loading");
  const interaction = (await send("Runtime.evaluate", {
    expression: `(async () => {
      for (let i = 0; i < 40 && !document.querySelector('.link'); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const more = document.querySelector('#more');
      const moreHidden = more.hidden && getComputedStyle(more).display === 'none';
      const settingsResults = await Promise.all([
        chrome.runtime.sendMessage({ kind: 'toggle-pause' }),
        chrome.runtime.sendMessage({ kind: 'set-cadence', minutes: 480 }),
      ]);
      const settings = (await chrome.storage.sync.get('settings')).settings;
      const [entry] = (await chrome.storage.local.get('corral')).corral;
      const response = await chrome.runtime.sendMessage({ kind: 'restore', id: entry.id });
      const corral = (await chrome.storage.local.get('corral')).corral;
      const tabs = await chrome.tabs.query({});
      return {
        moreHidden,
        settingsSaved: settingsResults.every(result => result.ok) && settings.paused && settings.cadenceMinutes === 480,
        restored: response.ok && tabs.some(tab => tab.url === entry.url || tab.pendingUrl === entry.url),
        archiveCleaned: !corral.some(item => item.id === entry.id),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, popupSession.sessionId)) as {
    result: { value: Record<string, boolean> };
    exceptionDetails?: unknown;
  };
  if (interaction.exceptionDetails) throw new Error(JSON.stringify(interaction.exceptionDetails));
  for (const [label, ok] of Object.entries(interaction.result.value)) {
    console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
    if (!ok) process.exitCode = 1;
  }

  // Give manual testing the ordinary cadence instead of the zero-minute fixture.
  await send("Runtime.evaluate", {
    expression: `(async () => {
      await chrome.storage.sync.set({ settings: { cadenceMinutes: 1440, paused: false } });
      await chrome.alarms.create('sweep', { delayInMinutes: 15, periodInMinutes: 15 });
      ${keepOpen ? "const [popup] = await chrome.tabs.query({ url: chrome.runtime.getURL('popup.html') }); await chrome.tabs.update(popup.id, { active: true });" : ""}
    })()`,
    awaitPromise: true,
  }, attached.sessionId);
}

function localDateKey(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
