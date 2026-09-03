# Stale

Arc-style auto-archive for Chrome. Closes tabs you haven't touched in a while and keeps them in a restorable corral. About 7KB of JavaScript, no framework, no host permissions.

## Install

1. `bun install && bun run build`
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `dist/`

## How it works

A 15-minute `chrome.alarms` sweep wakes the MV3 service worker (which is otherwise dead ~99% of the time). Staleness is `Date.now() - tab.lastAccessed > cadence`, and only focusing a tab resets the clock. Cadence presets are 8h / 24h (default) / 3d / 1 week, stored in `chrome.storage.sync`.

Closed tabs go to the corral (`chrome.storage.local`, capped at 300) with favicon, title, and URL, then get closed via `chrome.tabs.remove`. Each tab is closed individually, so a tab that dies mid-sweep doesn't corrupt the corral.

Exempt from closing: the active tab, pinned tabs, incognito windows, and the final tab of the final window (closing that one would quit Chrome). Not exempt: audible tabs (music and Meet tabs die with the timer), tab groups, and `chrome://` pages.

The first sweep after a browser restart closes everything already past the cadence. Call it the fresh-browser effect.

The popup has the preset segmented control, a pause toggle, and the corral. The list shows the 10 most recent entries with a **Load more**; click a row to restore, × to delete. Clear is a two-tap confirm. Missing or broken favicons fall back to a colored letter tile. Restore validates the URL scheme first, because `chrome.tabs.create` silently resolves garbage URLs against the extension origin and a restore that fails would leave the entry stuck in the corral.

## Development

| Command | What it does |
| --- | --- |
| `bun run build` | Build `dist/` |
| `bun run watch` | Rebuild on change (reload the extension in Chrome after each build) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run smoke` | Boots a throwaway headless Chrome, loads the extension, verifies the full close→corral→badge pipeline |
| `bun run icons` | Rasterizes `assets/icon.svg` to the PNG sizes the manifest references |

## Verified findings

These were the two open technical unknowns from the design phase, both tested on a throwaway Chrome 152 profile via the CDP `Extensions.loadUnpacked` API:

1. `beforeunload` does not block `chrome.tabs.remove()`. A tab with an active handler was closed programmatically without any confirmation prompt, and landed in the corral. No failure path needed.
2. `lastAccessed` across restart: inconclusive, but benign either way. Headless Chrome wouldn't restore the previous session, so this couldn't be exercised. If the timestamp survives restarts (it comes from the session service), the startup sweep closes stale tabs immediately as designed. If Chrome resets it on restore, restored tabs get one grace cycle. No data-loss risk either way. Worth one manual check on a real profile if the startup behavior ever looks wrong.

Also worth knowing:

- Chrome 137+ removed the `--load-extension` launch flag for branded Chrome. Automation now uses the CDP `Extensions.loadUnpacked` command, which is what `bun run smoke` uses.
- The service worker naps constantly (that's the design). When testing via CDP, polls that span wake/sleep cycles give bogus readings; run assertions inside a single worker lifetime (the smoke script does this).
- One transient artifact, seen only in headless: reading the badge ~10ms earlier than a second identical read returned `undefined` vs `"3"`. Browser-side badge state is set correctly. Not a product issue.

## Manual checklist (real Chrome)

- [ ] Preset selection survives a browser restart
- [ ] A tab left unfocused past the cadence closes and appears in the corral
- [ ] Clicking a corral row reopens the URL
- [ ] Pinned tab, active tab, and the final tab of the final window are never closed
- [ ] Pause stops all closing; resume picks it back up
- [ ] Badge count appears after a sweep and resets the next day
- [ ] Corral paginates: 10 visible, Load more reveals the rest
- [ ] Broken favicons fall back to a letter tile; bad URLs refuse to restore

## Scope

Personal-use, unpacked only. No Web Store publishing, no options page, no search, no per-domain rules, no minimum-tabs floor. Incognito is out of scope by default (the extension isn't enabled there).

## License

MIT — see [LICENSE](LICENSE).
