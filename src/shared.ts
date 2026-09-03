export const CORRAL_CAP = 300;

export const PRESETS = [
  { label: "8 hours", short: "8h", minutes: 480 },
  { label: "24 hours", short: "24h", minutes: 1440 },
  { label: "3 days", short: "3d", minutes: 4320 },
  { label: "1 week", short: "1w", minutes: 10080 },
] as const;

export const DEFAULT_CADENCE_MINUTES = 1440;

export interface Settings {
  cadenceMinutes: number;
  paused: boolean;
}

export interface CorralEntry {
  id: string;
  url: string;
  title: string;
  favIconUrl?: string;
  closedAt: number;
}

interface ClosedToday {
  date: string;
  count: number;
}

export const DEFAULT_SETTINGS: Settings = {
  cadenceMinutes: DEFAULT_CADENCE_MINUTES,
  paused: false,
};

async function storageGet<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function storageGetSync<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.sync.get(key);
  return result[key] as T | undefined;
}

export async function getSettings(): Promise<Settings> {
  const settings = await storageGetSync<Partial<Settings>>("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

export async function getCorral(): Promise<CorralEntry[]> {
  return (await storageGet<CorralEntry[]>("corral")) ?? [];
}

export async function prependCorral(entries: CorralEntry[]): Promise<CorralEntry[]> {
  const corral = [...entries, ...(await getCorral())].slice(0, CORRAL_CAP);
  await chrome.storage.local.set({ corral });
  return corral;
}

export async function removeFromCorral(id: string): Promise<CorralEntry[]> {
  const corral = (await getCorral()).filter((e) => e.id !== id);
  await chrome.storage.local.set({ corral });
  return corral;
}

export async function clearCorral(): Promise<void> {
  await chrome.storage.local.set({ corral: [] });
}

export async function bumpClosedToday(n: number): Promise<ClosedToday> {
  const date = localDateKey();
  const closedToday = await storageGet<ClosedToday>("closedToday");
  const current = closedToday?.date === date ? (closedToday.count ?? 0) : 0;
  const next: ClosedToday = { date, count: current + n };
  await chrome.storage.local.set({ closedToday: next });
  return next;
}

export async function getClosedToday(): Promise<number> {
  const closedToday = await storageGet<ClosedToday>("closedToday");
  return closedToday?.date === localDateKey() ? (closedToday.count ?? 0) : 0;
}

export function localDateKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
