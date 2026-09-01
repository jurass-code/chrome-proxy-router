// Configuration persisted in chrome.storage.local.
//
// Shape (v2 — several proxies, each with its own domain list):
//   {
//     enabled: boolean,
//     proxies: [
//       {
//         id: string,        // unique stable id, generated
//         name: string,      // display name, e.g. "Work"
//         type: "socks5" | "http",
//         host: string,
//         port: number,
//         username: string,  // optional, HTTP proxy auth
//         password: string,  // optional, HTTP proxy auth
//         domains: string[], // domains routed through THIS proxy
//       },
//     ],
//   }
//
// The legacy v1 shape ({ enabled, proxy: {...}, routedDomains: [] }) is migrated
// transparently on load: the single proxy becomes proxies[0] with its domains.
// The v2 shape is written back to storage on the next save.

const STORAGE_KEY = "socks5RouterConfig";

export const PROXY_TYPES = ["socks5", "http"];

export function generateProxyId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Normalize one proxy entry coming from storage. Every field gets a safe
// default so a corrupted entry can never crash the service worker or the PAC
// builder.
function sanitizeProxy(raw, index) {
  const port = Number(raw?.port);
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : generateProxyId(),
    name: String(raw?.name ?? "").trim() || `Proxy ${index + 1}`,
    type: PROXY_TYPES.includes(raw?.type) ? raw.type : "socks5",
    host: String(raw?.host ?? "").trim(),
    port: Number.isFinite(port) ? port : 0,
    username: String(raw?.username ?? ""),
    password: String(raw?.password ?? ""),
    domains: Array.isArray(raw?.domains)
      ? raw.domains
          .map((domain) => String(domain).trim().toLowerCase())
          .filter((domain) => domain.length > 0)
      : [],
  };
}

// Legacy v1 -> v2: the single proxy becomes proxies[0], keeping its domains
// and enabled flag.
function migrateV1(config) {
  const domains = Array.isArray(config?.routedDomains)
    ? config.routedDomains
        .map((domain) => String(domain).trim().toLowerCase())
        .filter((domain) => domain.length > 0)
    : [];
  const proxy = sanitizeProxy(config?.proxy, 0);
  return {
    enabled: Boolean(config?.enabled),
    proxies: [{ ...proxy, domains }],
  };
}

// Load the saved config, falling back to an empty v2 config if anything is
// missing or corrupted. We never let a bad storage state crash the service
// worker: callers always get a usable object.
export async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const config = stored[STORAGE_KEY];
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { enabled: false, proxies: [] };
    }
    if (!Array.isArray(config.proxies)) {
      // v1 shape (or corrupt data) — migrate instead of crashing.
      return migrateV1(config);
    }
    return {
      enabled: Boolean(config.enabled),
      proxies: config.proxies.map((proxy, index) => sanitizeProxy(proxy, index)),
    };
  } catch (error) {
    console.error("[socks5-router] Failed to load config, using defaults:", error);
    return { enabled: false, proxies: [] };
  }
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

// Build a PAC (Proxy Auto-Config) script that routes each configured domain
// through its own proxy and everything else direct. The rules are embedded
// into the script source as literals so Chrome can evaluate them synchronously
// per request without round-tripping to the service worker.
//
// Proxies are checked in their configured order (the popup's card order);
// the first proxy whose domain list matches wins — that order is the priority.
//
// Note: a PAC script cannot carry proxy credentials — for authenticated HTTP
// proxies the credentials are supplied separately from background.js via
// chrome.webRequest.onAuthRequired.
function buildPacScript(config) {
  const routes = config.proxies
    .map((proxy) => ({
      directive: proxy.type === "http" ? "PROXY" : "SOCKS5",
      host: String(proxy.host).trim(),
      port: Number(proxy.port),
      domains: proxy.domains
        .map((domain) => String(domain).trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    }))
    // Defensive: a proxy without domains or with an unusable host/port can
    // never match — keep it out of the PAC entirely.
    .filter(
      (route) =>
        route.domains.length > 0 &&
        route.host.length > 0 &&
        Number.isFinite(route.port) &&
        route.port >= 1 &&
        route.port <= 65535,
    );

  return `
    const ROUTES = ${JSON.stringify(routes)};

    function FindProxyForURL(url, host) {
      // Normalize: strip leading "www." so user-facing rules like "example.com"
      // also match "www.example.com" without forcing the user to add both.
      const normalized = host.toLowerCase().replace(/^www\\./, "");

      for (let i = 0; i < ROUTES.length; i++) {
        const route = ROUTES[i];
        for (let j = 0; j < route.domains.length; j++) {
          const rule = route.domains[j];
          if (normalized === rule || normalized.endsWith("." + rule)) {
            return route.directive + " " + route.host + ":" + route.port;
          }
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