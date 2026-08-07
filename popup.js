const PROXY_PORT_MIN = 1;
const PROXY_PORT_MAX = 65535;
const STATUS_TIMEOUT_MS = 2500;

const elements = {
  enabledToggle: document.getElementById("enabledToggle"),
  proxyHost: document.getElementById("proxyHost"),
  proxyPort: document.getElementById("proxyPort"),
  addDomainForm: document.getElementById("addDomainForm"),
  domainInput: document.getElementById("domainInput"),
  domainList: document.getElementById("domainList"),
  saveButton: document.getElementById("saveButton"),
  statusMessage: document.getElementById("statusMessage"),
};

let routedDomains = [];

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

function renderDomainList() {
  const list = elements.domainList;
  list.innerHTML = "";

  if (routedDomains.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No domains — add one above.";
    list.appendChild(empty);
    return;
  }

  for (const domain of routedDomains) {
    const item = document.createElement("li");

    const name = document.createElement("span");
    name.className = "domain-name";
    name.textContent = domain;

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Remove ${domain}`;
    remove.addEventListener("click", () => removeDomain(domain));

    item.append(name, remove);
    list.appendChild(item);
  }
}

function addDomain(domain) {
  if (routedDomains.includes(domain)) {
    showStatus(`Already in list: ${domain}`, "info");
    return;
  }
  routedDomains.push(domain);
  renderDomainList();
}

function removeDomain(domain) {
  routedDomains = routedDomains.filter((d) => d !== domain);
  renderDomainList();
}

function readProxyFromForm() {
  const host = elements.proxyHost.value.trim();
  const port = Number(elements.proxyPort.value);

  if (!host) {
    return { ok: false, error: "Host is required" };
  }
  if (!Number.isFinite(port) || port < PROXY_PORT_MIN || port > PROXY_PORT_MAX) {
    return { ok: false, error: "Port must be between 1 and 65535" };
  }
  return { ok: true, host, port };
}

async function applyChanges() {
  const proxyResult = readProxyFromForm();
  if (!proxyResult.ok) {
    showStatus(proxyResult.error, "error");
    return;
  }

  const config = {
    enabled: elements.enabledToggle.checked,
    proxy: { host: proxyResult.host, port: proxyResult.port },
    routedDomains: routedDomains.slice(),
  };

  try {
    const response = await sendMessage({ type: "setConfig", config });
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
    elements.proxyHost.value = config.proxy.host;
    elements.proxyPort.value = String(config.proxy.port);
    routedDomains = Array.isArray(config.routedDomains) ? config.routedDomains.slice() : [];
    renderDomainList();
  } catch (error) {
    showStatus(`Failed to load config: ${error.message}`, "error");
  }
}

function bindEvents() {
  elements.enabledToggle.addEventListener("change", async () => {
    try {
      // Save the current form state alongside the toggle, so the enabled flag is persisted
      // with the proxy settings the user actually sees.
      await applyChanges();
    } catch (error) {
      showStatus(error.message, "error");
    }
  });

  elements.addDomainForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const domain = isValidDomain(elements.domainInput.value);
    if (!domain) {
      showStatus("Enter a valid domain (e.g. example.com)", "error");
      return;
    }
    addDomain(domain);
    elements.domainInput.value = "";
    elements.domainInput.focus();
  });

  elements.saveButton.addEventListener("click", applyChanges);
}

populateFromConfig().then(() => {
  bindEvents();
});
