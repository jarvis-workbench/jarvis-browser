# Chrome Sync

Unpacked Manifest V3 extension for moving the current tab login state between Chrome and Jarvis Browser.

## Install

- Chrome: open `chrome://extensions`, enable developer mode, load this directory.
- Jarvis Browser: open a site session, use the BrowserView extension manager, and install this directory globally or for the site.

## Use

1. Open the logged-in website in the source browser.
2. Open the Chrome Sync popup and export the current tab.
3. Open the same website in the target browser and target profile/session.
4. Open Chrome Sync, choose the exported `.jarvis-session-sync.zip` file, and import it.
5. Refresh the page and verify the login state.

## Format

The exported file uses format version `jarvis-session-sync-v1` and contains:

- `manifest.json`
- `web-state.json`

The ZIP is not encrypted. Its `web-state.json` includes cookies, localStorage, sessionStorage, IndexedDB records, and CacheStorage entries that are accessible to browser extension and page APIs for the current tab origins.

Browser-internal or system-bound state cannot be moved by an extension. This includes service worker registrations, HTTP auth caches, TLS client certificates, OS keychain entries, and server-side device binding.
