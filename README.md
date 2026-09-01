# Domain Proxy Router

A minimal Chrome extension (Manifest V3) that routes traffic for specific domains through a SOCKS5 or HTTP proxy, leaving everything else direct. Managed from a popup UI.

## What it does

- Sends requests to chosen domains through a proxy:
  - **SOCKS5** — `SOCKS5 host:port` (e.g. `127.0.0.1:1080` for a local SSH tunnel / Tor / `ssh -D`).
  - **HTTP** — `PROXY host:port`, with **optional login/password**.
- Leaves all other traffic direct.
- Subdomain-aware: adding `example.com` also matches `www.example.com`, `api.example.com`, etc.
- Persisted config; proxy is restored on browser restart.

## HTTP proxy authentication

A PAC script cannot carry credentials, so the extension answers the proxy's `407` challenge itself via `chrome.webRequest.onAuthRequired` (backed by the `webRequestAuthProvider` permission, available in current Chrome). It only replies to challenges coming from *your* configured proxy — website basic-auth prompts are left to the browser.

Notes:

- Credentials are optional: leave both fields empty for an open HTTP proxy.
- Credentials are stored in the extension's own storage (`chrome.storage.local`), not in the OS keychain.
- SOCKS5 proxies with username/password are not supported by Chrome's PAC routing — if you need an authenticated SOCKS5 proxy, run a local HTTP/SOCKS tunnel with auth instead.

## Important limitation

Chrome's `chrome.proxy` API applies proxy settings **per profile**, not per tab. True per-tab routing is not supported by the platform. If you need "this tab goes through proxy A, that tab through proxy B", that requires a separate Chrome profile, not an extension. This extension follows the proven per-domain approach (same as SwitchyOmega).

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`chrome-socks5-proxy`).
4. Pin the extension and click its icon to open the popup.

## Use

1. Toggle the switch in the popup header to enable routing.
2. Pick the proxy **Type** (SOCKS5 or HTTP), set **Host** and **Port**.
3. For an HTTP proxy that requires auth, fill in **Username** and **Password** (optional).
4. Add the domains you want routed (e.g. `example.com`).
5. Click **Save & apply**.

## Files

- `manifest.json` — MV3 manifest with `proxy`, `storage`, `webRequest`, `webRequestAuthProvider` permissions.
- `background.js` — service worker: applies `chrome.proxy.settings`, answers HTTP proxy auth challenges, surfaces `onProxyError`.
- `config.js` — config persistence + PAC script generation. The PAC script is what actually does per-domain routing inside Chrome's network stack.
- `popup.html` / `popup.css` / `popup.js` — UI for editing the proxy and the domain list.

## Icons

The manifest references `icons/icon16.png`, `icon48.png`, `icon128.png`. Drop your own PNGs there (or remove the `"icons"` block from `manifest.json` and Chrome will use a default icon). Placeholder PNGs are not included.

## How routing works

The extension generates a PAC (Proxy Auto-Config) script that Chrome evaluates for every request. The script checks the request's host against your domain list and returns `SOCKS5 host:port` / `PROXY host:port` for matches, `DIRECT` otherwise. This runs inside Chrome's network stack, so it's fast and works for all sub-resources of a page, not just the top-level document.
