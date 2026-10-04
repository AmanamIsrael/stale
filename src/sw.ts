import {
  CORRAL_CAP,
  getClosedToday,
  getCorral,
  getSettings,
  isMutation,
  isRestorableUrl,
  localDateKey,
  type CorralEntry,
  type Mutation,
  type Settings,
} from "./shared.ts";

const SWEEP_ALARM = "sweep";
const SWEEP_PERIOD_MINUTES = 15;
const CORRAL_LOCK = "stale-corral";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) void runSweep();
});
chrome.runtime.onInstalled.addListener(() => {
  void initialize(false);
});
chrome.runtime.onStartup.addListener(() => {
  void initialize(true);
});
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !isMutation(message)) return;
  void respondToMutation(message, respond);
  return true;
});
void initialize(false);

async function respondToMutation(
  message: Mutation,
  respond: (response: unknown) => void,
): Promise<void> {
  try {
    await handleMutation(message);
    respond({ ok: true });
  } catch (error) {
    respond({
      ok: false,
      error: error instanceof Error ? error.message : "The operation failed. Try again.",
    });
  }
}

async function handleMutation(message: Mutation): Promise<void> {
  if (message.kind === "set-cadence" || message.kind === "toggle-pause") {
    await navigator.locks.request("stale-settings", async () => {
      const settings = await getSettings();
      await chrome.storage.sync.set({
        settings:
          message.kind === "set-cadence"
            ? { ...settings, cadenceMinutes: message.minutes }
            : { ...settings, paused: !settings.paused },
      });
    });
    return;
  }

  // Every corral writer runs in the worker under the same browser-owned lock.
  // Persistent data stays in storage; a worker restart releases the lock.
  await navigator.locks.request(CORRAL_LOCK, async () => {
    if (message.kind === "clear") {
      await chrome.storage.local.set({ corral: [] });
      return;
    }
    const corral = await getCorral();
    const entry = corral.find((entry) => entry.id === message.id);
    if (!entry) return;
    if (message.kind === "restore") {
      if (!isRestorableUrl(entry.url)) throw new Error("This entry has no restorable URL.");
      try {
        await chrome.tabs.create({ url: entry.url });
      } catch {
        throw new Error("Chrome refused to open this URL.");
      }
    }
    try {
      await chrome.storage.local.set({ corral: corral.filter((entry) => entry.id !== message.id) });
    } catch {
      throw new Error(
        message.kind === "restore"
          ? "Tab reopened, but its archive entry could not be removed."
          : "Could not remove this entry. Try again.",
      );
    }
  });
}

async function initialize(sweepOnStartup: boolean): Promise<void> {
  try {
    if (!(await chrome.alarms.get(SWEEP_ALARM))) {
      await chrome.alarms.create(SWEEP_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: SWEEP_PERIOD_MINUTES,
        persistAcrossSessions: true,
      });
    }
    await chrome.action.setBadgeBackgroundColor({ color: "#666666" });
    await refreshBadge();
    if (sweepOnStartup) await sweep();
  } catch (error) {
    console.error("Stale initialization failed", error);
  }
}

async function refreshBadge(): Promise<void> {
  const count = await getClosedToday();
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

async function runSweep(): Promise<void> {
  try {
    await sweep();
  } catch (error) {
    console.error("Stale sweep failed", error);
  }
}

function isStale(tab: chrome.tabs.Tab, settings: Settings): boolean {
  return (
    !settings.paused &&
    tab.id != null &&
    tab.id !== chrome.tabs.TAB_ID_NONE &&
    !tab.pinned &&
    !tab.active &&
    !tab.incognito &&
    !tab.audible &&
    !tab.pendingUrl &&
    typeof tab.lastAccessed === "number" &&
    tab.lastAccessed > 0 &&
    tab.lastAccessed < Date.now() - settings.cadenceMinutes * 60_000 &&
    isRestorableUrl(tab.url ?? "")
  );
}

export async function sweep(): Promise<void> {
  await navigator.locks.request(CORRAL_LOCK, async () => {
    await refreshBadge();
    const settings = await getSettings();
    if (settings.paused) return;
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const candidates = tabs.filter((tab) => isStale(tab, settings));
    if (candidates.length === 0) return;

    const entries = candidates.map((tab): CorralEntry => ({
      id: crypto.randomUUID(),
      url: tab.url ?? "",
      title: tab.title ?? tab.url ?? "Untitled",
      favIconUrl: tab.favIconUrl,
      closedAt: Date.now(),
    }));
    const previous = await getCorral();
    // Save recovery copies before any destructive operation. If this write
    // fails, no tab closes. An interrupted sweep may leave a still-open backup.
    await chrome.storage.local.set({ corral: [...entries, ...previous] });
    const closed: CorralEntry[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const currentSettings = await getSettings();
      const liveTabs = await chrome.tabs.query({ windowType: "normal" });
      const live = liveTabs.find((tab) => tab.id === candidate.id);
      // Query again after saving: activation, pinning, navigation, audio, or
      // pausing can change eligibility while the archive write is in flight.
      if (
        !live ||
        !isStale(live, currentSettings) ||
        live.url !== candidate.url ||
        liveTabs.length <= 1
      ) continue;
      const entry = entries[index];
      if (live.id == null || !entry) continue;
      try {
        await chrome.tabs.remove(live.id);
        closed.push(entry);
      } catch {
        // A disappeared tab or rejected close is neither archived nor counted.
      }
    }
    // Commit successful closures and their count together. Failed/skipped
    // candidates leave the corral; failed writes retain the recovery copies.
    await chrome.storage.local.set({
      corral: [...closed, ...previous].slice(0, CORRAL_CAP),
      closedToday: {
        date: localDateKey(),
        count: (await getClosedToday()) + closed.length,
      },
    });
    await refreshBadge();
  });
}
