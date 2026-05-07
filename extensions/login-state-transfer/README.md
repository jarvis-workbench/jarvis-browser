# Jarvis Login State Transfer

Unpacked Manifest V3 extension for moving website login state both ways between Chrome and Jarvis Browser.

## Install

- Chrome: open `chrome://extensions`, enable developer mode, load this directory.
- Jarvis Browser: open a site session, use the BrowserView extension manager, and install this directory globally or for the site.

## Use

1. Open the logged-in website in the source browser.
2. Open the extension popup and export the current website state.
3. Open the same website in the target browser and target profile/session.
4. Open the extension popup, choose the exported JSON file, and import it.
5. Refresh the page and verify the login state.

## Coverage

The state file includes cookies, localStorage, sessionStorage, IndexedDB records, and CacheStorage entries that are accessible to browser extension and page APIs for the current tab origins.

Browser-internal or system-bound state cannot be moved by an extension. This includes service worker registrations, HTTP auth caches, TLS client certificates, OS keychain entries, and server-side device binding.
