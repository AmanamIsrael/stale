import {
  PRESETS,
  getClosedToday,
  getCorral,
  getSettings,
  mutate,
  removeFromCorral,
  type CorralEntry,
} from "./shared";

const PAGE_SIZE = 10;

const presetsEl = document.querySelector<HTMLDivElement>("#presets")!;
const pauseEl = document.querySelector<HTMLButtonElement>("#pause")!;
const clearEl = document.querySelector<HTMLButtonElement>("#clear")!;
const corralEl = document.querySelector<HTMLUListElement>("#corral")!;
const emptyEl = document.querySelector<HTMLParagraphElement>("#empty")!;
const todayEl = document.querySelector<HTMLSpanElement>("#today")!;
const moreEl = document.querySelector<HTMLButtonElement>("#more")!;
const errorEl = document.querySelector<HTMLParagraphElement>("#error")!;

// Pagination state; survives storage-triggered re-renders while the popup is open.
let visibleCount = PAGE_SIZE;
let clearArmTimer: ReturnType<typeof setTimeout> | undefined;
let hideErrorTimer: ReturnType<typeof setTimeout> | undefined;

function when(closedAt: number): string {
  const mins = Math.round((Date.now() - closedAt) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fullWhen(closedAt: number): string {
  return new Date(closedAt).toLocaleString();
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function avatarFor(entry: CorralEntry): HTMLElement {
  const domain = domainOf(entry.url);
  const letter =
    (domain || entry.title || "?").trim().charAt(0).toUpperCase() || "?";
  const el = document.createElement("span");
  el.className = "avatar";
  el.textContent = letter;
  el.style.backgroundColor = `hsl(${hueOf(domain || entry.title)} 42% 50%)`;
  return el;
}

function iconFor(entry: CorralEntry): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "icon";
  if (entry.favIconUrl) {
    const img = document.createElement("img");
    img.src = entry.favIconUrl;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    // Favicons expire, 404, or belong to extensions that can't be loaded here.
    img.addEventListener(
      "error",
      () => wrap.replaceChildren(avatarFor(entry)),
      { once: true },
    );
    wrap.append(img);
  } else {
    wrap.append(avatarFor(entry));
  }
  return wrap;
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.hidden = false;
  clearTimeout(hideErrorTimer);
  hideErrorTimer = setTimeout(() => (errorEl.hidden = true), 4000);
}

async function runAction(
  control: HTMLButtonElement | HTMLInputElement,
  action: () => Promise<void>,
): Promise<void> {
  if (control.disabled) return;
  control.disabled = true;
  control.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    showError(error instanceof Error ? error.message : "The operation failed. Try again.");
    await refreshSafely();
  } finally {
    control.disabled = false;
    control.removeAttribute("aria-busy");
  }
}

function renderPresets(cadenceMinutes: number): void {
  presetsEl.replaceChildren(
    ...PRESETS.map((p) => {
      const label = document.createElement("label");
      label.title = `Close tabs after ${p.label}`;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "cadence";
      input.value = String(p.minutes);
      input.checked = p.minutes === cadenceMinutes;
      input.addEventListener("change", () => {
        void runAction(input, () =>
          mutate({ kind: "set-cadence", minutes: p.minutes }),
        );
      });
      const span = document.createElement("span");
      span.textContent = p.short;
      label.append(input, span);
      return label;
    }),
  );
}

function renderRow(entry: CorralEntry): HTMLLIElement {
  const li = document.createElement("li");

  li.append(iconFor(entry));

  const link = document.createElement("button");
  link.className = "link";
  link.type = "button";
  link.textContent = entry.title || entry.url || "Untitled";
  link.title = entry.url ? `${entry.title}\n${entry.url}` : entry.title;
  link.setAttribute("aria-label", `Restore ${entry.title || entry.url}`);
  link.addEventListener("click", () => {
    void runAction(link, async () => {
      // The worker owns tab creation and cleanup even if activation dismisses
      // this popup before the response arrives.
      await mutate({ kind: "restore", id: entry.id });
      window.close();
    });
  });

  const whenEl = document.createElement("span");
  whenEl.className = "when";
  whenEl.textContent = when(entry.closedAt);
  whenEl.title = fullWhen(entry.closedAt);

  const remove = document.createElement("button");
  remove.className = "remove";
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${entry.title || entry.url}`);
  remove.addEventListener("click", () => {
    void runAction(remove, () => removeFromCorral(entry.id));
  });

  li.append(link, whenEl, remove);
  return li;
}

function renderCorral(corral: CorralEntry[]): void {
  const slice = corral.slice(0, visibleCount);
  corralEl.replaceChildren(...slice.map(renderRow));
  emptyEl.hidden = corral.length > 0;

  const hidden = corral.length - slice.length;
  moreEl.hidden = hidden <= 0;
  if (hidden > 0) {
    moreEl.textContent = `Load more · ${hidden} hidden`;
  }
}

async function refresh(): Promise<void> {
  const [settings, corral, closedToday] = await Promise.all([
    getSettings(),
    getCorral(),
    getClosedToday(),
  ]);
  renderPresets(settings.cadenceMinutes);
  pauseEl.setAttribute("aria-pressed", String(settings.paused));
  pauseEl.textContent = settings.paused ? "Resume" : "Pause";
  renderCorral(corral);
  todayEl.textContent = closedToday > 0 ? `${closedToday} closed today` : "";
}

async function refreshSafely(): Promise<void> {
  try {
    await refresh();
  } catch {
    showError("Could not load Stale. Close the popup and try again.");
  }
}

pauseEl.addEventListener("click", () => {
  void runAction(pauseEl, () => mutate({ kind: "toggle-pause" }));
});

function disarmClear(): void {
  clearTimeout(clearArmTimer);
  clearEl.textContent = "Clear";
  clearEl.classList.remove("armed");
  clearEl.setAttribute("aria-pressed", "false");
}

clearEl.addEventListener("click", () => {
  if (clearEl.classList.contains("armed")) {
    disarmClear();
    void runAction(clearEl, () => mutate({ kind: "clear" }));
    return;
  }
  clearEl.classList.add("armed");
  clearEl.setAttribute("aria-pressed", "true");
  clearEl.textContent = "Sure?";
  clearArmTimer = setTimeout(disarmClear, 2500);
});

moreEl.addEventListener("click", () => {
  visibleCount += PAGE_SIZE;
  void refreshSafely();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && changes.settings) || (area === "local" && (changes.corral || changes.closedToday))) {
    void refreshSafely();
  }
});

void refreshSafely();
