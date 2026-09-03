import {
  bumpClosedToday,
  getClosedToday,
  getSettings,
  prependCorral,
  type CorralEntry,
} from "./shared";

const SWEEP_ALARM = "sweep";
const SWEEP_PERIOD_MINUTES = 15;
const BADGE_COLOR = "#666666";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) void sweep();
});

chrome.runtime.onInstalled.addListener(() => {
  void reconcile();
});

chrome.runtime.onStartup.addListener(() => {
  void reconcile().then(() => sweep());
});

void reconcile();

async function reconcile(): Promise<void> {
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (!existing) {
    await chrome.alarms.create(SWEEP_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: SWEEP_PERIOD_MINUTES,
      persistAcrossSessions: true,
    });
  }
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  // A new day may have started since the last sweep; don't show yesterday's count.
  if ((await getClosedToday()) === 0) {
    await chrome.action.setBadgeText({ text: "" });
  }
}

interface StaleTab {
  id: number;
  entry: CorralEntry;
  windowId: number;
  lastAccessed: number;
}

export async function sweep(): Promise<void> {
  const { cadenceMinutes, paused } = await getSettings();
  if (paused) return;

  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const cutoff = Date.now() - cadenceMinutes * 60_000;

  const stale: StaleTab[] = [];
  for (const tab of tabs) {
    if (
      tab.id != null &&
      tab.id !== chrome.tabs.TAB_ID_NONE &&
      !tab.pinned &&
      !tab.active &&
      !tab.incognito &&
      typeof tab.lastAccessed === "number" &&
      tab.lastAccessed > 0 &&
      tab.lastAccessed < cutoff
    ) {
      stale.push({
        id: tab.id,
        windowId: tab.windowId,
        lastAccessed: tab.lastAccessed,
        entry: {
          id: crypto.randomUUID(),
          url: tab.url ?? "",
          title: tab.title ?? tab.url ?? "Untitled",
          favIconUrl: tab.favIconUrl,
          closedAt: Date.now(),
        },
      });
    }
  }
  if (stale.length === 0) return;

  const windowIds = new Set(tabs.map((t) => t.windowId));
  const survivorsByWindow = new Map<number, number>();
  for (const t of tabs) {
    if (t.id == null) continue;
    if (!stale.some((s) => s.id === t.id)) {
      survivorsByWindow.set(t.windowId, (survivorsByWindow.get(t.windowId) ?? 0) + 1);
    }
  }

  let closable = stale;
  if (windowIds.size === 1) {
    const onlyWindowId = [...windowIds][0];
    if (onlyWindowId != null && (survivorsByWindow.get(onlyWindowId) ?? 0) === 0) {
      const keep = [...stale].sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
      closable = stale.filter((s) => s.id !== keep?.id);
      if (closable.length === 0) return;
    }
  }

  // A tab can be closed (by the user or a crash) between query and remove;
  // only corral tabs that were actually closed.
  const results = await Promise.allSettled(closable.map((s) => chrome.tabs.remove(s.id)));
  const closed = closable.filter((_, i) => results[i]!.status === "fulfilled");
  if (closed.length === 0) return;

  await prependCorral(closed.map((s) => s.entry));
  const { count } = await bumpClosedToday(closable.length);
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}
