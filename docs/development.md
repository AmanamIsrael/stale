# Development notes

Testing archaeology and gotchas. The public README stays lean; this is for anyone hacking on the extension.

## Internals

A 15-minute `chrome.alarms` sweep wakes the MV3 service worker (which is otherwise dead ~99% of the time). Staleness is `Date.now() - tab.lastAccessed > cadence`, and only focusing a tab resets the clock. The cadence preset lives in `chrome.storage.sync`.

The worker saves recovery copies in `chrome.storage.local` before calling `chrome.tabs.remove`. Each candidate's current eligibility and URL are checked again after saving. Successful closures and their daily count are committed together; failed or skipped closures are removed from the corral. The completed corral keeps the 300 most recent entries. Recovery copies temporarily exceed that cap so every candidate is backed up before closing.

If the worker stops or the final storage write fails, recovery copies remain available. Some may refer to tabs that are still open, and the daily counter may omit closures from the interrupted sweep. This favors keeping a recoverable URL over deleting an uncertain entry.

The popup sends mutations to the worker. A Web Lock serializes corral changes and sweeps, preventing concurrent read→modify→write operations from overwriting entries. Settings use a separate lock so pausing can take effect during a sweep. Persistent data lives in Chrome storage; locks are released automatically if the worker stops.

The worker validates the URL scheme before calling `chrome.tabs.create`, because Chrome silently resolves relative URLs against the extension origin. It removes the corral entry only after creation succeeds, and owns that cleanup even if opening the tab dismisses the popup. Failed operations are reported in the popup.

`bun run test` runs deterministic failure and concurrency regressions with Node 24's real Web Locks implementation and a Chrome API fixture. `bun run smoke` checks the built extension against actual Chrome. Add `--headed --keep-open` to leave a separate test profile open with the ordinary 24-hour cadence and a populated corral.

## Things we had to test to believe

Two open questions from the design phase, both checked on a throwaway Chrome 152 profile via the CDP `Extensions.loadUnpacked` API:

1. `beforeunload` does not block `chrome.tabs.remove()`. A tab with an active handler was closed programmatically without any confirmation prompt, and landed in the corral. No failure path needed.
2. `lastAccessed` across restart: inconclusive, but benign either way. Headless Chrome wouldn't restore the previous session, so this couldn't be exercised. If the timestamp survives restarts (it comes from the session service), the startup sweep closes stale tabs immediately as designed. If Chrome resets it on restore, restored tabs get one grace cycle. No data-loss risk either way. Worth one manual check on a real profile if the startup behavior ever looks wrong.

## CDP gotchas

- Chrome 137+ removed the `--load-extension` launch flag for branded Chrome. Automation now uses the CDP `Extensions.loadUnpacked` command, which is what `bun run smoke` uses.
- The service worker naps constantly (that's the design). When testing via CDP, polls that span wake/sleep cycles give bogus readings; run assertions inside a single worker lifetime (the smoke script does this).
- One transient artifact, seen only in headless: reading the badge ~10ms earlier than a second identical read returned `undefined` vs `"3"`. Browser-side badge state is set correctly. Not a product issue.

## Sanity checks in a real browser

- [ ] Preset selection survives a browser restart
- [ ] A tab left unfocused past the cadence closes and appears in the corral
- [ ] Clicking a corral row reopens the URL
- [ ] Pinned, active, audible, and navigating tabs, and the final tab of the final window are never closed
- [ ] Pause stops all closing; resume picks it back up
- [ ] Badge count appears after a sweep and resets the next day
- [ ] Corral paginates: 10 visible, Load more reveals the rest
- [ ] Broken favicons fall back to a letter tile; bad URLs refuse to restore
