# Jarvis TG Content Downloader

Unpacked Manifest V3 extension for Chrome and Jarvis Browser.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Click "Load unpacked".
4. Select this directory: `extensions/tg-content-downloader`.

## Install in Jarvis Browser

Open a site session, open the BrowserView plugin manager, choose global or site install, and select this directory.

## Behavior

- Runs only on `https://web.telegram.org/*`.
- Adds download buttons only inside Telegram message bubbles and the active right-side media/story panels.
- Avoids chat-list avatars and conversation avatars by not scanning the whole page for images, background images, or links.
- Supports single downloads, album checkbox downloads, visible media-panel batch downloads, month batch buttons, and popup selected downloads.
- Captures video/audio sources loaded through `fetch`, `XMLHttpRequest`, and `URL.createObjectURL` only to resolve message media after the user triggers a download.
- Downloads blobs or ranged media in the page context so Chrome and Jarvis can both hand the final file to their normal download managers.

This implementation intentionally omits third-party analytics and rating-limit prompts from the installed Chrome extension that was inspected.
