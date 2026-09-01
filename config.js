// Default configuration persisted in chrome.storage.local.
// Shape: {
//   proxy: {
//     type: "socks5" | "http",
//     host,
//     port,
//     username: string, // optional, HTTP proxy auth
//     password: string, // optional, HTTP proxy auth
//   },
//   routedDomains: string[],
//   enabled: boolean,
// }
const DEFAULT_CONFIG = {
  enabled: false,
  proxy: {
    type: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: "",
    password: "",
  },
  routedDomains: [],
};

const STORAGE_KEY = "socks5RouterConfig";

const PROXY_TYPES = ["socks5", "http"];

// Load the saved config, falling back to defaults if anything is missing or corrupted.
// We never let a bad storage state crash the service worker: callers always get a usable object.
export async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const config = stored[STORAGE_KEY];
    if (!config || typeof config !== "object") {
      return { ...DEFAULT_CONFIG };
    }
    const type = PROXY_TYPES.includes(config.proxy?.type)
      ? config.proxy.type
      : DEFAULT_CONFIG.proxy.type;
    return {
      enabled: Boolean(config.enabled),
      proxy: {
        type,
        host: String(config.proxy?.host ?? DEFAULT_CONFIG.proxy.host),
        port: Number(config.proxy?.port ?? DEFAULT_CONFIG.proxy.port),
        username: String(config.proxy?.username ?? ""),
        password: String(config.proxy?.password ?? ""),
      },
      routedDomains: Array.isArray(config.routedDomains)
        ? config.routedDomains.map(String)
        : [],
    };
  } catch (error) {
    console.error("[socks5-router] Failed to load config, using defaults:", error);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

// Build a PAC (Proxy Auto-Config) script that sends matched domains through the
// proxy and everything else direct. We embed the rules into the script source so
// Chrome can evaluate them synchronously per request without round-tripping to
// the service worker.
//
// Note: a PAC script cannot carry proxy credentials — for an authenticated HTTP
// proxy the credentials are supplied separately from background.js via
// chrome.webRequest.onAuthRequired.
function buildPacScript(config) {
  const { type, host, port } = config.proxy;
  const domains = config.routedDomains
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);

  // The PAC body runs in a sandboxed context with no access to our module scope,
  // so we inject the values as literals.
  const domainsJson = JSON.stringify(domains);
  const proxyHost = JSON.stringify(host);
  const proxyPort = Number(port);
  const proxyDirective = JSON.stringify(type === "http" ? "PROXY" : "SOCKS5");

  return `
    const ROUTED_DOMAINS = ${domainsJson};
    const PROXY_DIRECTIVE = ${proxyDirective};
    const PROXY_HOST = ${proxyHost};
    const PROXY_PORT = ${proxyPort};

    function FindProxyForURL(url, host) {
      // Normalize: strip leading "www." so user-facing rules like "example.com"
      // also match "www.example.com" without forcing the user to add both.
      const normalized = host.toLowerCase().replace(/^www\\./, "");

      for (let i = 0; i < ROUTED_DOMAINS.length; i++) {
        const rule = ROUTED_DOMAINS[i];
        if (normalized === rule || normalized.endsWith("." + rule)) {
          return PROXY_DIRECTIVE + " " + PROXY_HOST + ":" + PROXY_PORT;
        }
      }
      return "DIRECT";
    }
  `;
}

export function applyProxyConfig(config) {
  if (!config.enabled) {
    return chrome.proxy.settings.clear({ scope: "regular" });
  }

  return chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "pac_script",
      pacScript: {
        data: buildPacScript(config),
        mandatory: false,
      },
    },
  });
}

// Re-read config and reapply proxy settings. Called whenever storage changes
// or the extension starts up.
export async function syncProxyFromStorage() {
  const config = await loadConfig();
  await applyProxyConfig(config);
  return config;
}
