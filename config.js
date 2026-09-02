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
//         mode: "include" | "exclude",
//                             // include: route ONLY the listed domains through
//                             //   this proxy, everything else is direct;
//                             // exclude: route EVERYTHING through this proxy
//                             //   EXCEPT the listed domains.
//         enabled: boolean,  // per-proxy switch: a disabled proxy keeps its
//                             //   settings but is excluded from routing
//         host: string,
//         port: number,
//         username: string,  // optional, HTTP proxy auth
//         password: string,  // optional, HTTP proxy auth
//         domains: string[], // routed domains (include) / exceptions (exclude)
//       },
//     ],
//   }
//
// The legacy v1 shape ({ enabled, proxy: {...}, routedDomains: [] }) is migrated
// transparently on load: the single proxy becomes proxies[0] with its domains.
// The v2 shape is written back to storage on the next save. Configs saved
// before `mode` existed default to "include" — the original behavior.

const STORAGE_KEY = "socks5RouterConfig";

export const PROXY_TYPES = ["socks5", "http"];
export const ROUTING_MODES = ["include", "exclude"];

export function generateProxyId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Convert one domain to its ASCII (Punycode) form: "пример.рф" ->
// "xn--e1afmkfd.xn--p1ai". Internationalized domains MUST be Punycode inside
// the PAC script — chrome.proxy.settings rejects non-ASCII pacScript.data
// ("supports only ASCII code"). The URL parser does the IDN conversion for us
// in every engine (service worker, popup, Node). Falls back to the
// lowercased input when the domain can't parse as a URL (e.g. still being
// typed) so the raw value is never lost.
export function toAsciiDomain(domain) {
  const trimmed = String(domain ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  if (!/[^\x00-\x7F]/.test(trimmed)) {
    return trimmed; // already ASCII — no URL round-trip needed
  }
  try {
    return new URL("http://" + trimmed).hostname;
  } catch {
    return trimmed;
  }
}

// Split raw pasted/typed text into candidate domains: newline, comma,
// semicolon, or whitespace separated. Candidates are trimmed, lowercased and
// deduped, order preserved. Tokenizing only — whether a candidate is a
// usable domain is decided by the caller (popup validation).
export function parseDomainList(text) {
  const seen = new Set();
  const domains = [];
  for (const token of String(text ?? "").split(/[\s,;]+/)) {
    const domain = toAsciiDomain(token);
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
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
    mode: ROUTING_MODES.includes(raw?.mode) ? raw.mode : "include",
    // Anything but an explicit false keeps the proxy on — old configs and
    // corrupt values never silently disable a user's proxies.
    enabled: raw?.enabled === false ? false : true,
    // Punycode for hosts too: Chrome reports 407 challengers (and connects)
    // in ASCII form, so background.js compares like-for-like only if the
    // stored host is already converted.
    host: toAsciiDomain(raw?.host),
    port: Number.isFinite(port) ? port : 0,
    username: String(raw?.username ?? ""),
    password: String(raw?.password ?? ""),
    domains: Array.isArray(raw?.domains)
      ? raw.domains
          .map((domain) => toAsciiDomain(String(domain)))
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

// Build a PAC (Proxy Auto-Config) script implementing the config's routing:
//   - "include" proxies match only their listed domains;
//   - "exclude" proxies are catch-alls for everything else.
// The rules are embedded into the script source as literals so Chrome can
// evaluate them synchronously per request without round-tripping to the
// service worker.
//
// Evaluation order:
//   1. include routes, in card order — the first whose list matches the host
//      wins. Card order is the priority.
//   2. exclude routes, in card order — the first whose exception list does
//      NOT contain the host claims everything else. A host excluded by every
//      exclude route goes direct.
// Include routes always beat exclude ones, so a domain explicitly listed on
// an include proxy overrides a same-domain exception on a catch-all proxy.
//
// Note: a PAC script cannot carry proxy credentials — for authenticated HTTP
// proxies the credentials are supplied separately from background.js via
// chrome.webRequest.onAuthRequired.
function buildPacScript(config) {
  const routes = config.proxies
    .map((proxy) => ({
      mode: proxy.mode === "exclude" ? "exclude" : "include",
      enabled: proxy.enabled !== false,
      directive: proxy.type === "http" ? "PROXY" : "SOCKS5",
      // Punycode here too: chrome.proxy rejects non-ASCII pacScript.data, and
      // the test path (applyProxyConfig with an unsanitized config) skips
      // loadConfig's sanitizer.
      host: toAsciiDomain(proxy.host),
      port: Number(proxy.port),
      domains: proxy.domains
        .map((domain) => toAsciiDomain(String(domain)))
        .filter((domain) => domain.length > 0),
    }))
    // Defensive: disabled proxies, proxies with an unusable host/port, and
    // include proxies with no domains can never serve traffic — keep them out
    // of the PAC entirely. An exclude proxy with no domains is meaningful
    // (route everything through it), so it stays.
    .filter(
      (route) =>
        route.enabled &&
        route.host.length > 0 &&
        Number.isFinite(route.port) &&
        route.port >= 1 &&
        route.port <= 65535 &&
        (route.mode === "exclude" || route.domains.length > 0),
    );

  return `
    const ROUTES = ${JSON.stringify(routes).replace(/[^\u0020-\u007E]/g, (ch) =>
      "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
    )};

    function FindProxyForURL(url, host) {
      // Normalize: strip leading "www." so user-facing rules like "example.com"
      // also match "www.example.com" without forcing the user to add both.
      const normalized = host.toLowerCase().replace(/^www\\./, "");

      // Pass 1 - specific routes: the first "only listed domains" proxy whose
      // list matches the host wins.
      for (let i = 0; i < ROUTES.length; i++) {
        const route = ROUTES[i];
        if (route.mode === "exclude") {
          continue;
        }
        for (let j = 0; j < route.domains.length; j++) {
          const rule = route.domains[j];
          if (normalized === rule || normalized.endsWith("." + rule)) {
            return route.directive + " " + route.host + ":" + route.port;
          }
        }
      }

      // Pass 2 - catch-all routes: everything not matched above goes to the
      // first "all except listed" proxy whose exception list does NOT contain
      // the host.
      for (let i = 0; i < ROUTES.length; i++) {
        const route = ROUTES[i];
        if (route.mode !== "exclude") {
          continue;
        }
        let excluded = false;
        for (let j = 0; j < route.domains.length; j++) {
          const rule = route.domains[j];
          if (normalized === rule || normalized.endsWith("." + rule)) {
            excluded = true;
            break;
          }
        }
        if (!excluded) {
          return route.directive + " " + route.host + ":" + route.port;
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