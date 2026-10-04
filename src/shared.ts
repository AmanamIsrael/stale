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

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.sync.get<{
    settings?: Partial<Settings>;
  }>("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

export type Mutation =
  | { kind: "set-cadence"; minutes: number }
  | { kind: "toggle-pause" }
  | { kind: "remove"; id: string }
  | { kind: "restore"; id: string }
  | { kind: "clear" };

export function isMutation(value: unknown): value is Mutation {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  switch (value.kind) {
    case "set-cadence":
      return "minutes" in value && PRESETS.some((preset) => preset.minutes === value.minutes);
    case "remove":
    case "restore":
      return "id" in value && typeof value.id === "string";
    case "toggle-pause":
    case "clear":
      return true;
    default:
      return false;
  }
}

export async function mutate(message: Mutation): Promise<void> {
  const response = await chrome.runtime.sendMessage<Mutation, unknown>(message);
  if (typeof response !== "object" || response === null || !("ok" in response)) {
    throw new Error("Stale did not respond. Try again.");
  }
  if (response.ok !== true) {
    throw new Error(
      "error" in response && typeof response.error === "string"
        ? response.error
        : "The operation failed. Try again.",
    );
  }
}

export async function getCorral(): Promise<CorralEntry[]> {
  const { corral } = await chrome.storage.local.get<{ corral?: CorralEntry[] }>("corral");
  return corral ?? [];
}

export async function removeFromCorral(id: string): Promise<void> {
  await mutate({ kind: "remove", id });
}

export async function getClosedToday(): Promise<number> {
  const { closedToday } = await chrome.storage.local.get<{
    closedToday?: ClosedToday;
  }>("closedToday");
  return closedToday?.date === localDateKey() ? (closedToday.count ?? 0) : 0;
}

// Chrome resolves relative URLs against the extension origin. Only archive and
// restore schemes that we can reopen as an independent tab.
export function isRestorableUrl(url: string): boolean {
  try {
    return ["http:", "https:", "file:", "chrome:", "chrome-extension:"].includes(
      new URL(url).protocol,
    );
  } catch {
    return false;
  }
}

export function localDateKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
