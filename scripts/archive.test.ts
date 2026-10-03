import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getCorral, removeFromCorral, localDateKey } from "../src/shared.ts";

type Tab = Pick<chrome.tabs.Tab, "id" | "windowId" | "url" | "pendingUrl" | "title" | "active" | "pinned" | "incognito" | "audible" | "lastAccessed">;
type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void) => unknown;
const messages: MessageListener[] = [];
let local: Record<string, unknown> = {};
let tabs: Tab[] = [];
let removed: number[] = [];
let writeFailure: "before-close" | "after-close" | undefined;
let failedTab: number | undefined;
let afterQuery: (() => void) | undefined;

const chromeMock = {
  runtime: {
    id: "stale-test",
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener: MessageListener) { messages.push(listener); } },
    async sendMessage(message: unknown) {
      return new Promise((resolve) => {
        for (const listener of messages) listener(message, { id: "stale-test" }, resolve);
      });
    },
  },
  storage: {
    local: {
      async get(key: string) { return structuredClone({ [key]: local[key] }); },
      async set(update: Record<string, unknown>) {
        if ("corral" in update && (writeFailure === "before-close" || (writeFailure === "after-close" && removed.length > 0))) {
          throw new Error("Storage unavailable");
        }
        Object.assign(local, structuredClone(update));
      },
    },
    sync: { async get() { return { settings: { cadenceMinutes: 480, paused: false } }; } },
  },
  tabs: {
    TAB_ID_NONE: -1,
    async query() { const snapshot = structuredClone(tabs); afterQuery?.(); return snapshot; },
    async get(id: number) { const tab = tabs.find((tab) => tab.id === id); if (!tab) throw new Error("Tab missing"); return structuredClone(tab); },
    async remove(id: number) {
      if (id === failedTab) throw new Error("Cannot close tab");
      removed.push(id);
      tabs = tabs.filter((tab) => tab.id !== id);
    },
  },
  alarms: { onAlarm: { addListener() {} }, async get() { return {}; } },
  action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
};
Object.assign(globalThis, { chrome: chromeMock });
const { sweep } = await import("../src/sw.ts");

function entry(id: string) { return { id, url: `https://example.com/${id}`, title: id, closedAt: Date.now() }; }
function staleTab(id: number): Tab {
  return { id, windowId: 1, url: `https://example.com/${id}`, title: String(id), active: false, pinned: false, incognito: false, audible: false, lastAccessed: Date.now() - 86_400_000 };
}

beforeEach(async () => {
  // Let the worker's initial badge reconciliation finish before resetting fixtures.
  await new Promise((resolve) => setImmediate(resolve));
  local = { corral: [] };
  tabs = [staleTab(1), { ...staleTab(9), active: true }];
  removed = [];
  writeFailure = undefined;
  failedTab = undefined;
  afterQuery = undefined;
});

test("storage failure before archiving leaves the tab open", async () => {
  writeFailure = "before-close";
  await assert.rejects(sweep(), /Storage unavailable/);
  assert.deepEqual(removed, []);
  assert.ok(tabs.some((tab) => tab.id === 1));
});

test("storage failure after closure keeps a durable recovery entry", async () => {
  writeFailure = "after-close";
  await assert.rejects(sweep(), /Storage unavailable/);
  assert.deepEqual(removed, [1]);
  assert.deepEqual((await getCorral()).map((entry) => entry.url), ["https://example.com/1"]);
});

test("concurrent archive deletions cannot resurrect an entry", async () => {
  local.corral = [entry("a"), entry("b")];
  await Promise.all([removeFromCorral("a"), removeFromCorral("b")]);
  assert.deepEqual(await getCorral(), []);
});

test("only successful removals enter the archive and daily count", async () => {
  tabs.unshift(staleTab(2));
  failedTab = 2;
  await sweep();
  assert.deepEqual((await getCorral()).map((entry) => entry.url), ["https://example.com/1"]);
  assert.deepEqual(local.closedToday, { date: localDateKey(), count: 1 });
});

for (const change of ["active", "pinned", "audible", "lastAccessed", "url", "pendingUrl"] as const) {
  test(`a tab whose ${change} changes after discovery stays open`, async () => {
    afterQuery = () => {
      const tab = tabs.find((tab) => tab.id === 1)!;
      if (change === "lastAccessed") tab.lastAccessed = Date.now();
      else if (change === "url" || change === "pendingUrl") tab[change] = "https://example.com/new-page";
      else tab[change] = true;
    };
    await sweep();
    assert.deepEqual(removed, []);
    assert.deepEqual(await getCorral(), []);
  });
}

test("audible stale tabs remain open", async () => {
  tabs[0]!.audible = true;
  await sweep();
  assert.deepEqual(removed, []);
  assert.deepEqual(await getCorral(), []);
});
