# grok2api-manage

Unpacked Manifest V3 extension for Chrome and Jarvis Browser.

## Install in Jarvis Browser

1. Open a `grok.com` site session.
2. Open the extension manager from the browser toolbar.
3. Install this directory as a site or global unpacked extension:
   `extensions/grok2api-manage`
4. Click the `grok2api-manage` action to open the popup.

## Features

### SSO

- Reads the current session cookie named `sso`.
- Shows the cookie value in a readonly textarea.
- When missing, placeholder is `当前对话未登录`, and both `复制` / `导出到text文件` are disabled.
- Export writes a `.text` file named after the current site/tab title.

### Device Auth

- Accepts a device code.
- On `开始授权`, opens a new tab in the current conversation/session:
  `https://accounts.x.ai/oauth2/device?user_code=<DEVICE_CODE>`

## Notes

- In Jarvis Browser, cookie read and session-tab creation use the `jarvisExtensionPopup` bridge.
- In Chrome, the same popup falls back to `chrome.cookies` and `chrome.tabs`.
