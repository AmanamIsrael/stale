import {
  PRESETS,
  clearCorral,
  getClosedToday,
  getCorral,
  getSettings,
  removeFromCorral,
  saveSettings,
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

// chrome.tabs.create silently resolves garbage URLs against the extension
// origin, so garbage must be caught here rather than left to the API.
function isRestorableUrl(url: string): boolean {
  try {
    return ["http:", "https:", "file:", "chrome:", "chrome-extension:"].includes(
      new URL(url).protocol,
    );
  } catch {
    return false;
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
        void getSettings().then((s) =>
          saveSettings({ ...s, cadenceMinutes: p.minutes }),
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
    if (!entry.url || !isRestorableUrl(entry.url)) {
      showError("This entry has no restorable URL.");
      return;
    }
    link.disabled = true;
    link.setAttribute("aria-busy", "true");
    chrome.tabs.create({ url: entry.url }).then(
      async () => {
        // Remove before closing; closing first can abort the storage write.
        await removeFromCorral(entry.id);
        window.close();
      },
      () => {
        link.disabled = false;
        link.removeAttribute("aria-busy");
        showError("Chrome refused to open this URL.");
      },
    );
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
    void removeFromCorral(entry.id);
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

pauseEl.addEventListener("click", () => {
  void getSettings().then((s) => saveSettings({ ...s, paused: !s.paused }));
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
    void clearCorral();
    return;
  }
  clearEl.classList.add("armed");
  clearEl.setAttribute("aria-pressed", "true");
  clearEl.textContent = "Sure?";
  clearArmTimer = setTimeout(disarmClear, 2500);
});

moreEl.addEventListener("click", () => {
  visibleCount += PAGE_SIZE;
  void refresh();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync" || area === "local") void refresh();
});

void refresh();
