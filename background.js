import {
  loadConfig,
  saveConfig,
  syncProxyFromStorage,
  applyProxyConfig,
} from "./config.js";

const STORAGE_KEY = "socks5RouterConfig";

// In-memory copy of the config so the onAuthRequired handler can answer
// synchronously, without a storage round-trip per auth challenge.
let cachedConfig = null;

function updateCache(config) {
  cachedConfig = config;
  return config;
}

// Reapply proxy settings whenever the stored config changes (popup edits, other surfaces).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) {
    return;
  }
  syncProxyFromStorage()
    .then(updateCache)
    .catch((error) => {
      console.error(
        "[socks5-router] Failed to reapply proxy after storage change:",
        error,
      );
    });
});

// Restore proxy state on service worker startup / browser launch.
syncProxyFromStorage()
  .then(updateCache)
  .catch((error) => {
    console.error("[socks5-router] Failed to restore proxy on startup:", error);
  });

// Surface proxy errors to the extension's error console so misconfigurations are visible
// instead of silently failing in the network stack.
chrome.proxy.onProxyError.addListener((error) => {
  console.error("[socks5-router] Proxy error:", error?.details ?? error);
});

// Authenticated HTTP proxies: a PAC script cannot carry credentials, so we answer
// the proxy's 407 challenge here. We only respond to challenges that come from
// our configured HTTP proxy; website basic-auth prompts are left to the browser.
chrome.webRequest.onAuthRequired.addListener(
  (details) => {
    const proxy = cachedConfig?.proxy;
    if (!proxy || proxy.type !== "http" || !proxy.username) {
      return; // take no action on the challenge
    }
    if (!details.isProxy) {
      return;
    }
    const { challenger } = details;
    if (
      !challenger ||
      challenger.host !== proxy.host ||
      challenger.port !== proxy.port
    ) {
      return;
    }
    return {
      authCredentials: {
        username: proxy.username,
        password: proxy.password,
      },
    };
  },
  { urls: ["<all_urls>"] },
  ["blocking"],
);

// Lightweight message bridge for the popup: get/set config and force a reapply.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("[socks5-router] Message handler error:", error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });
  return true; // keep the message channel open for the async response
});

async function handleMessage(message) {
  switch (message?.type) {
    case "getConfig":
      return { ok: true, config: await loadConfig() };

    case "setConfig": {
      await saveConfig(message.config);
      const config = await syncProxyFromStorage();
      return { ok: true, config };
    }

    case "toggleEnabled": {
      const current = await loadConfig();
      const updated = { ...current, enabled: !current.enabled };
      await saveConfig(updated);
      await applyProxyConfig(updated);
      return { ok: true, config: updated };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}
