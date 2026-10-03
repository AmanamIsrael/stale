# Stale

Arc-style auto-archive for Chrome. Tabs you haven't touched in a while get closed and parked in a restorable corral. No framework, no host permissions.

## Install

1. `bun install && bun run build`
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `dist/`

## Using it

Pick a cadence: 8h, 24h (default), 3d, or 1 week. Focusing a tab resets its clock. When a tab goes stale it closes and lands in the corral, which keeps your 300 most recent with favicon, title, and URL. Click a row to restore, × to delete. Clear is a two-tap confirm. Pause stops all closing.

Two things worth knowing before you trust it with your tabs:

- The first sweep after a browser restart closes everything already past the cadence. Call it the fresh-browser effect.
- Recovery copies are saved before tabs close. If a sweep is interrupted, the corral may include a backup of a tab that's still open.

## What it won't close

Active tabs, pinned tabs, audible tabs, incognito windows, tabs navigating to another page, and the final tab of the final window (closing that one would quit Chrome). Tabs without a restorable URL stay open. Tab groups and `chrome://` pages are not spared.

## What it isn't

Personal-use, unpacked only. No Web Store publishing, no options page, no search, no per-domain rules, no minimum-tabs floor. Incognito stays off by default (the extension isn't enabled there).

## Hacking on it

| Command | What it does |
| --- | --- |
| `bun run build` | Build `dist/` |
| `bun run watch` | Rebuild on change (reload the extension in Chrome after each build) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Focused archive and tab-safety regressions (Node 24+) |
| `bun run smoke` | Boots a throwaway headless Chrome, loads the extension, verifies the full close→corral→badge pipeline |
| `bun run smoke --headed --keep-open` | Runs the Chrome check and leaves the extension open for manual testing |
| `bun run icons` | Rasterizes `assets/icon.svg` to the PNG sizes the manifest references |

Internals and testing notes live in [docs/development.md](docs/development.md).

## License

MIT — see [LICENSE](LICENSE).
