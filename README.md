# SOCKS5 Domain Router

A minimal Chrome extension (Manifest V3) that routes traffic for specific domains through a SOCKS5 proxy, leaving everything else direct. Managed from a popup UI.

## What it does

- Sends requests to chosen domains through a SOCKS5 proxy (`SOCKS5 host:port`).
- Leaves all other traffic direct.
- Subdomain-aware: adding `example.com` also matches `www.example.com`, `api.example.com`, etc.
- Persisted config; proxy is restored on browser restart.

## Important limitation

Chrome's `chrome.proxy` API applies proxy settings **per profile**, not per tab. True per-tab routing is not supported by the platform. If you need "this tab goes through proxy A, that tab through proxy B", that requires a separate Chrome profile, not an extension. This extension follows the proven per-domain approach (same as SwitchyOmega).

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`chrome-socks5-proxy`).
4. Pin the extension and click its icon to open the popup.

## Use

1. Toggle the switch in the popup header to enable routing.
2. Set your SOCKS5 **Host** and **Port** (e.g. `127.0.0.1:1080` for a local SSH tunnel / Tor / `ssh -D`).
3. Add the domains you want routed (e.g. `example.com`).
4. Click **Save & apply**.

## Files

- `manifest.json` — MV3 manifest with `proxy` + `storage` permissions.
- `background.js` — service worker: listens for config changes, applies `chrome.proxy.settings`, surfaces `onProxyError`.
- `config.js` — config persistence + PAC script generation. The PAC script is what actually does per-domain routing inside Chrome's network stack.
- `popup.html` / `popup.css` / `popup.js` — UI for editing the proxy and the domain list.

## Icons

The manifest references `icons/icon16.png`, `icon48.png`, `icon128.png`. Drop your own PNGs there (or remove the `"icons"` block from `manifest.json` and Chrome will use a default icon). Placeholder PNGs are not included.

## How routing works

The extension generates a PAC (Proxy Auto-Config) script that Chrome evaluates for every request. The script checks the request's host against your domain list and returns `SOCKS5 host:port` for matches, `DIRECT` otherwise. This runs inside Chrome's network stack, so it's fast and works for all sub-resources of a page, not just the top-level document.
