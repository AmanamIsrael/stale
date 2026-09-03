# Development notes

Testing archaeology and gotchas. The public README stays lean; this is for anyone hacking on the extension.

## Internals

A 15-minute `chrome.alarms` sweep wakes the MV3 service worker (which is otherwise dead ~99% of the time). Staleness is `Date.now() - tab.lastAccessed > cadence`, and only focusing a tab resets the clock. The cadence preset lives in `chrome.storage.sync`.

Closed tabs go to the corral (`chrome.storage.local`, capped at 300) with favicon, title, and URL, then get closed via `chrome.tabs.remove`. Each tab is closed individually, so a tab that dies mid-sweep doesn't corrupt the corral.

Restore validates the URL scheme before calling `chrome.tabs.create`, because Chrome silently resolves garbage URLs against the extension origin and a restore that fails would leave the entry stuck in the corral.

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
- [ ] Pinned tab, active tab, and the final tab of the final window are never closed
- [ ] Pause stops all closing; resume picks it back up
- [ ] Badge count appears after a sweep and resets the next day
- [ ] Corral paginates: 10 visible, Load more reveals the rest
- [ ] Broken favicons fall back to a letter tile; bad URLs refuse to restore
