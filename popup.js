import {
  PROXY_TYPES,
  ROUTING_MODES,
  generateProxyId,
  parseDomainList,
} from "./config.js";

const PROXY_PORT_MIN = 1;
const PROXY_PORT_MAX = 65535;
const STATUS_TIMEOUT_MS = 2500;

const elements = {
  enabledToggle: document.getElementById("enabledToggle"),
  proxyList: document.getElementById("proxyList"),
  addProxyButton: document.getElementById("addProxyButton"),
  saveButton: document.getElementById("saveButton"),
  statusMessage: document.getElementById("statusMessage"),
};

// Local editable state: mirrors the saved config; written on "Save & apply".
// Each entry: { id, name, type, mode, enabled, host, port, username, password, domains[] }.
let proxies = [];

// Collapsed card ids, persisted in localStorage so the state survives popup
// reopens (the popup is destroyed every time it closes).
const COLLAPSED_KEY = "collapsedProxyIds";

function loadCollapsedIds() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function persistCollapsedIds() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedIds]));
  } catch {
    // storage unavailable — collapse state stays session-only
  }
}

const collapsedIds = loadCollapsedIds();

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function showStatus(message, kind = "info") {
  const el = elements.statusMessage;
  el.textContent = message;
  el.className = "status " + kind;
  if (kind !== "info") {
    setTimeout(() => {
      if (el.textContent === message) {
        el.textContent = "";
        el.className = "status";
      }
    }, STATUS_TIMEOUT_MS);
  }
}

// Minimal domain validation: reject empty, spaces, scheme prefixes, and obviously invalid chars.
function isValidDomain(value) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("://") || trimmed.includes("/")) {
    return false;
  }
  if (!/^[a-z0-9.-]+$/.test(trimmed)) {
    return false;
  }
  if (!trimmed.includes(".")) {
    return false;
  }
  return trimmed;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function textInput({ value = "", placeholder = "", type = "text" } = {}) {
  const input = el("input");
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  return input;
}

function iconButton(text, title, onClick) {
  const button = el("button", "btn-icon");
  button.type = "button";
  button.textContent = text;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

// Keep the multi-line domain textarea sized to its content (capped by CSS
// max-height). Also re-run on card expand — scrollHeight reads 0 while the
// card body is display:none.
function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

function renderProxies() {
  const list = elements.proxyList;
  list.innerHTML = "";

  if (proxies.length === 0) {
    const empty = el("p", "empty");
    empty.textContent = "No proxies — add one below.";
    list.appendChild(empty);
    return;
  }

  proxies.forEach((proxy, index) => {
    list.appendChild(buildProxyCard(proxy, index));
  });
}

function buildProxyCard(proxy, index) {
  const card = el("section", "proxy-card");
  card.classList.toggle("collapsed", collapsedIds.has(proxy.id));

  // Summary line shown in place of the body when the card is collapsed.
  const summary = el("div", "card-summary");
  const refreshSummary = () => {
    const type = (PROXY_TYPES.includes(proxy.type) ? proxy.type : "socks5").toUpperCase();
    const host = (proxy.host || "").trim() || "—";
    const port = String(proxy.port || "").trim() || "—";
    const count = proxy.domains.length;
    const routing =
      proxy.mode === "exclude"
        ? count === 0
          ? "everything"
          : `all except ${count} ${count === 1 ? "domain" : "domains"}`
        : `${count} ${count === 1 ? "domain" : "domains"}`;
    summary.textContent = `${type} · ${host}:${port} · ${routing}`;
    summary.title = summary.textContent;
  };
  refreshSummary();

  // --- Header: collapse toggle, editable name, order/remove actions ---
  const header = el("div", "proxy-card-header");

  const toggle = el("button", "btn-icon collapse-btn");
  toggle.type = "button";
  const syncCollapseUi = () => {
    const collapsed = collapsedIds.has(proxy.id);
    toggle.textContent = collapsed ? "▸" : "▾";
    toggle.title = collapsed ? "Expand" : "Collapse";
    if (collapsed) {
      refreshSummary();
    }
  };
  toggle.addEventListener("click", () => {
    if (collapsedIds.has(proxy.id)) {
      collapsedIds.delete(proxy.id);
    } else {
      collapsedIds.add(proxy.id);
    }
    persistCollapsedIds();
    card.classList.toggle("collapsed");
    if (!collapsedIds.has(proxy.id)) {
      autoGrow(domainInput); // re-measure after unhiding the card body
    }
    syncCollapseUi();
  });
  syncCollapseUi();

  const name = textInput({ value: proxy.name, placeholder: `Proxy ${index + 1}` });
  name.className = "proxy-name";
  name.spellcheck = false;
  name.addEventListener("input", () => {
    proxy.name = name.value;
  });

  // Per-proxy on/off switch: a disabled proxy keeps its settings but is
  // excluded from routing. Toggling saves immediately (like the global
  // toggle) — no need to hunt for "Save & apply".
  const proxySwitch = el("label", "switch mini-switch");
  proxySwitch.title = "Enable/disable this proxy";
  const proxyCheckbox = el("input");
  proxyCheckbox.type = "checkbox";
  proxyCheckbox.checked = proxy.enabled !== false;
  const proxyTrack = el("span", "switch-track");
  proxySwitch.append(proxyCheckbox, proxyTrack);
  card.classList.toggle("disabled", !proxyCheckbox.checked);
  proxyCheckbox.addEventListener("change", async () => {
    proxy.enabled = proxyCheckbox.checked;
    card.classList.toggle("disabled", !proxy.enabled);
    applyChanges(); // save + apply right away
  });

  const actions = el("div", "card-actions");
  const up = iconButton("↑", "Move up (higher priority)", () => moveProxy(index, -1));
  up.disabled = index === 0;
  const down = iconButton("↓", "Move down (lower priority)", () => moveProxy(index, 1));
  down.disabled = index === proxies.length - 1;
  const remove = iconButton("✕", "Remove this proxy", () => removeProxy(index));
  remove.classList.add("remove-btn");
  actions.append(up, down, remove);

  header.append(toggle, name, proxySwitch, actions);

  // --- Type / Host / Port ---
  const row = el("div", "row");

  const typeField = el("label", "field field-type");
  const typeSpan = el("span");
  typeSpan.textContent = "Type";
  const typeSelect = el("select");
  for (const type of PROXY_TYPES) {
    const option = el("option");
    option.value = type;
    option.textContent = type === "socks5" ? "SOCKS5" : "HTTP";
    typeSelect.appendChild(option);
  }
  typeSelect.value = PROXY_TYPES.includes(proxy.type) ? proxy.type : "socks5";
  typeSelect.addEventListener("change", () => {
    proxy.type = typeSelect.value;
    authFields.hidden = typeSelect.value !== "http";
  });
  typeField.append(typeSpan, typeSelect);

  const hostField = el("label", "field");
  const hostSpan = el("span");
  hostSpan.textContent = "Host";
  const hostInput = textInput({ value: proxy.host, placeholder: "127.0.0.1" });
  hostInput.spellcheck = false;
  hostInput.addEventListener("input", () => {
    proxy.host = hostInput.value;
  });
  hostField.append(hostSpan, hostInput);

  const portField = el("label", "field field-port");
  const portSpan = el("span");
  portSpan.textContent = "Port";
  const portInput = textInput({ value: proxy.port, placeholder: "1080", type: "number" });
  portInput.min = PROXY_PORT_MIN;
  portInput.max = PROXY_PORT_MAX;
  portInput.addEventListener("input", () => {
    proxy.port = portInput.value;
  });
  portField.append(portSpan, portInput);

  row.append(typeField, hostField, portField);

  // --- Auth (HTTP only) ---
  const authFields = el("div", "auth-fields");
  const authRow = el("div", "row");

  const userField = el("label", "field");
  const userSpan = el("span");
  userSpan.textContent = "Username";
  const userInput = textInput({ value: proxy.username });
  userInput.autocapitalize = "off";
  userInput.spellcheck = false;
  userInput.addEventListener("input", () => {
    proxy.username = userInput.value;
  });
  userField.append(userSpan, userInput);

  const passField = el("label", "field");
  const passSpan = el("span");
  passSpan.textContent = "Password";
  const passInput = textInput({ value: proxy.password, type: "password" });
  passInput.addEventListener("input", () => {
    proxy.password = passInput.value;
  });
  passField.append(passSpan, passInput);

  authRow.append(userField, passField);
  const authHint = el("p", "hint");
  authHint.textContent = "Optional. Fill in only if your HTTP proxy requires credentials.";
  authFields.append(authRow, authHint);
  authFields.hidden = proxy.type !== "http";

  // --- Routing mode + domains for this proxy ---
  const domainsSection = el("div", "domains-section");

  const domainList = el("ul", "domain-list");

  // The mode decides what the domain list below means: the listed domains
  // themselves, or everything except them.
  const modeField = el("label", "field mode-field");
  const modeSpan = el("span");
  modeSpan.textContent = "Routing mode";
  const modeSelect = el("select");
  const MODE_LABELS = {
    include: "Only listed domains",
    exclude: "All except listed",
  };
  for (const mode of ROUTING_MODES) {
    const option = el("option");
    option.value = mode;
    option.textContent = MODE_LABELS[mode];
    modeSelect.appendChild(option);
  }
  modeSelect.value = ROUTING_MODES.includes(proxy.mode) ? proxy.mode : "include";

  const modeHint = el("p", "hint");

  // Everything on the card that depends on the current mode: the hint, the
  // collapsed-card summary, and the domain list's empty-state text.
  const syncModeUi = () => {
    const exclude = proxy.mode === "exclude";
    modeHint.textContent = exclude
      ? "Everything except the listed domains (and their subdomains) goes through this proxy."
      : "The listed domains and their subdomains go through this proxy.";
    renderDomainChips(proxy, domainList);
    refreshSummary();
  };
  modeSelect.addEventListener("change", () => {
    proxy.mode = modeSelect.value;
    syncModeUi();
  });
  modeField.append(modeSpan, modeSelect);

  // Multi-domain input: paste a whole list — one domain per line, or
  // comma/whitespace separated. Enter adds, Shift+Enter inserts a newline.
  const addForm = el("form", "row add-domain-form");
  const domainInput = el("textarea", "domain-input");
  domainInput.rows = 1;
  domainInput.placeholder = "example.com — paste a list, one per line";
  domainInput.autocapitalize = "off";
  domainInput.spellcheck = false;
  domainInput.addEventListener("input", () => autoGrow(domainInput));
  domainInput.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return; // IME composition in progress
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (typeof addForm.requestSubmit === "function") {
        addForm.requestSubmit();
      } else {
        addForm.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    }
  });
  const addButton = el("button", "btn btn-primary");
  addButton.type = "submit";
  addButton.textContent = "Add";
  addForm.append(domainInput, addButton);
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const candidates = parseDomainList(domainInput.value);
    if (candidates.length === 0) {
      showStatus("Enter at least one valid domain (e.g. example.com)", "error");
      return;
    }
    let added = 0;
    const duplicates = [];
    const invalid = [];
    for (const candidate of candidates) {
      const domain = isValidDomain(candidate);
      if (!domain) {
        invalid.push(candidate);
      } else if (proxy.domains.includes(domain)) {
        duplicates.push(domain);
      } else {
        proxy.domains.push(domain);
        added += 1;
      }
    }
    if (added === 0) {
      // Nothing usable — keep the text so the user can fix it.
      if (invalid.length > 0) {
        showStatus(`Invalid: ${invalid.join(", ")}`, "error");
      } else {
        showStatus(`Already in list: ${duplicates.join(", ")}`, "info");
      }
      return;
    }
    renderDomainChips(proxy, domainList);
    domainInput.value = "";
    autoGrow(domainInput);
    domainInput.focus();
    const parts = [`Added ${added} ${added === 1 ? "domain" : "domains"}`];
    if (duplicates.length > 0) {
      parts.push(`${duplicates.length} already in list`);
    }
    if (invalid.length > 0) {
      parts.push(`${invalid.length} invalid`);
    }
    showStatus(parts.join(", "), invalid.length > 0 ? "info" : "success");
  });

  domainsSection.append(modeField, modeHint, addForm, domainList);
  syncModeUi();
  autoGrow(domainInput);

  const body = el("div", "proxy-card-body");
  body.append(row, authFields, domainsSection);

  card.append(header, summary, body);
  return card;
}

function renderDomainChips(proxy, listEl) {
  listEl.innerHTML = "";

  if (proxy.domains.length === 0) {
    const empty = el("li", "empty");
    empty.textContent =
      proxy.mode === "exclude"
        ? "No exceptions — everything goes through this proxy."
        : "No domains — add one above.";
    listEl.appendChild(empty);
    return;
  }

  for (const domain of proxy.domains) {
    const item = el("li");
    const name = el("span", "domain-name");
    name.textContent = domain;
    const remove = el("button", "remove-btn");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Remove ${domain}`;
    remove.addEventListener("click", () => {
      proxy.domains = proxy.domains.filter((d) => d !== domain);
      renderDomainChips(proxy, listEl);
    });
    item.append(name, remove);
    listEl.appendChild(item);
  }
}

function moveProxy(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= proxies.length) {
    return;
  }
  [proxies[index], proxies[target]] = [proxies[target], proxies[index]];
  renderProxies();
}

function removeProxy(index) {
  const [removed] = proxies.splice(index, 1);
  if (removed && collapsedIds.delete(removed.id)) {
    persistCollapsedIds();
  }
  renderProxies();
}

function addProxy() {
  proxies.push({
    id: generateProxyId(),
    name: "",
    type: "socks5",
    mode: "include",
    enabled: true,
    host: "",
    port: "",
    username: "",
    password: "",
    domains: [],
  });
  renderProxies();
  const nameInputs = elements.proxyList.querySelectorAll(".proxy-name");
  nameInputs[nameInputs.length - 1]?.focus();
}

// Validate the local state and build the config to persist.
function buildConfigFromState() {
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const label = (proxy.name || "").trim() || `Proxy ${i + 1}`;

    // Only enabled proxies must be complete: a disabled one keeps its
    // (possibly unfinished) settings but routes nothing, so an empty
    // host/port there is not a save blocker.
    if (proxy.enabled !== false) {
      if (!(proxy.host || "").trim()) {
        return { ok: false, error: `${label}: host is required` };
      }
      const port = Number(proxy.port);
      if (!Number.isFinite(port) || port < PROXY_PORT_MIN || port > PROXY_PORT_MAX) {
        return { ok: false, error: `${label}: port must be between 1 and 65535` };
      }
      if ((proxy.username || proxy.password) && (!proxy.username || !proxy.password)) {
        return {
          ok: false,
          error: `${label}: username and password must be filled in together`,
        };
      }
    }
  }

  return {
    ok: true,
    config: {
      enabled: elements.enabledToggle.checked,
      proxies: proxies.map((proxy, index) => ({
        id: proxy.id || generateProxyId(),
        name: (proxy.name || "").trim() || `Proxy ${index + 1}`,
        type: PROXY_TYPES.includes(proxy.type) ? proxy.type : "socks5",
        mode: ROUTING_MODES.includes(proxy.mode) ? proxy.mode : "include",
        enabled: proxy.enabled !== false,
        host: (proxy.host || "").trim(),
        port: Number(proxy.port),
        username: (proxy.username || "").trim(),
        password: proxy.password || "",
        domains: proxy.domains.slice(),
      })),
    },
  };
}

async function applyChanges() {
  const result = buildConfigFromState();
  if (!result.ok) {
    showStatus(result.error, "error");
    return;
  }

  try {
    const response = await sendMessage({ type: "setConfig", config: result.config });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Unknown error");
    }
    showStatus("Saved & applied", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function populateFromConfig() {
  try {
    const response = await sendMessage({ type: "getConfig" });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Unknown error");
    }
    const { config } = response;
    elements.enabledToggle.checked = Boolean(config.enabled);
    proxies = (config.proxies ?? []).map((proxy) => ({
      ...proxy,
      port: proxy.port || "",
      mode: ROUTING_MODES.includes(proxy.mode) ? proxy.mode : "include",
      domains: proxy.domains.slice(),
    }));
    renderProxies();
  } catch (error) {
    showStatus(`Failed to load config: ${error.message}`, "error");
  }
}

function bindEvents() {
  elements.enabledToggle.addEventListener("change", () => {
    // Save the current form state alongside the toggle, so the enabled flag is
    // persisted with the proxy settings the user actually sees.
    applyChanges();
  });

  elements.saveButton.addEventListener("click", applyChanges);
  elements.addProxyButton.addEventListener("click", addProxy);
}

populateFromConfig().then(() => {
  bindEvents();
});