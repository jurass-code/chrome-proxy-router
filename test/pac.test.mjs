// Node tests for multi-proxy PAC routing and config migration.
// Run: node test/pac.test.mjs
// Zero dependencies: chrome.* is mocked and the generated PAC script is
// executed live via new Function — the same engine contract Chrome uses.

import { strict as assert } from "node:assert";

const proxySettings = [];
let storedData = {};

globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({ ...storedData }),
      set: async (entries) => Object.assign(storedData, entries),
    },
  },
  proxy: {
    settings: {
      clear: async () => proxySettings.push("cleared"),
      set: async (details) => proxySettings.push(details),
    },
  },
};

const { loadConfig, saveConfig, applyProxyConfig } = await import(
  new URL("../config.js", import.meta.url).href
);

function lastPacScript() {
  const last = proxySettings[proxySettings.length - 1];
  assert.ok(typeof last === "object", "expected chrome.proxy.settings.set to be called");
  return last.value.pacScript.data;
}

// Execute the generated PAC: extract FindProxyForURL and feed ROUTES in as a parameter
// (the embedded `const ROUTES = ...` declaration is stripped by slicing from the function).
function makeFindProxy(pacSource) {
  const routesMatch = pacSource.match(/const ROUTES = (\[[\s\S]*?\]);/);
  assert.ok(routesMatch, "PAC script must embed a ROUTES array");
  const routes = JSON.parse(routesMatch[1]);
  const body = pacSource.slice(pacSource.indexOf("function FindProxyForURL"));
  return new Function("ROUTES", body + "\nreturn FindProxyForURL;")(routes);
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok — ${name}`);
}

function multiConfig() {
  return {
    enabled: true,
    proxies: [
      {
        id: "a",
        name: "Local SOCKS",
        type: "socks5",
        host: "127.0.0.1",
        port: 1080,
        username: "",
        password: "",
        domains: ["a.dev", "foo.io"],
      },
      {
        id: "b",
        name: "Corp HTTP",
        type: "http",
        host: "10.0.0.1",
        port: 3128,
        username: "u1",
        password: "p1",
        domains: ["b.org", "deep.b.org"],
      },
    ],
  };
}

console.log("migration & sanitization");

await test("v1 config migrates into a single proxies[0] entry", async () => {
  storedData = {
    socks5RouterConfig: {
      enabled: true,
      proxy: { type: "http", host: "1.2.3.4", port: 8080, username: "u", password: "p" },
      routedDomains: ["Example.COM", "foo.net", "  "],
    },
  };
  const config = await loadConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.proxies.length, 1);
  const proxy = config.proxies[0];
  assert.equal(proxy.type, "http");
  assert.equal(proxy.host, "1.2.3.4");
  assert.equal(proxy.port, 8080);
  assert.deepEqual(proxy.domains, ["example.com", "foo.net"]);
});

await test("migrated config saves back as v2 and reloads identically", async () => {
  storedData = {
    socks5RouterConfig: {
      enabled: false,
      proxy: { type: "socks5", host: "9.9.9.9", port: 9050 },
      routedDomains: ["old.io"],
    },
  };
  const migrated = await loadConfig();
  await saveConfig(migrated);
  const reloaded = await loadConfig();
  assert.equal(reloaded.enabled, false);
  assert.equal(reloaded.proxies.length, 1);
  assert.equal(reloaded.proxies[0].host, "9.9.9.9");
  assert.deepEqual(reloaded.proxies[0].domains, ["old.io"]);
  // storage now holds the v2 shape
  assert.ok(Array.isArray(storedData.socks5RouterConfig.proxies));
});

await test("v2 load sanitizes entries (lowercase domains, defaults)", async () => {
  storedData = {
    socks5RouterConfig: {
      enabled: false,
      proxies: [
        {
          id: "x",
          name: "   ",
          type: "weird",
          host: " 5.5.5.5 ",
          port: "1080",
          domains: ["X.DEV", "", "  y.io  "],
        },
      ],
    },
  };
  const config = await loadConfig();
  const proxy = config.proxies[0];
  assert.equal(proxy.type, "socks5"); // unknown type -> socks5
  assert.equal(proxy.host, "5.5.5.5");
  assert.equal(proxy.port, 1080);
  assert.deepEqual(proxy.domains, ["x.dev", "y.io"]);
  assert.equal(proxy.name, "Proxy 1"); // blank name -> default
  assert.ok(proxy.id.length > 0); // generated id
});

await test("corrupt storage falls back to an empty v2 config without throwing", async () => {
  storedData = { socks5RouterConfig: "junk" };
  const config = await loadConfig();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.proxies, []);
  storedData = {};
  const empty = await loadConfig();
  assert.deepEqual(empty.proxies, []);
});

console.log("PAC routing");

await test("multi-proxy PAC routes each domain to its own proxy", async () => {
  await applyProxyConfig(multiConfig());
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://a.dev/x", "a.dev"), "SOCKS5 127.0.0.1:1080");
  assert.equal(find("http://www.a.dev/", "www.a.dev"), "SOCKS5 127.0.0.1:1080");
  assert.equal(find("http://sub.foo.io/", "sub.foo.io"), "SOCKS5 127.0.0.1:1080");
  assert.equal(find("http://b.org/", "b.org"), "PROXY 10.0.0.1:3128");
  assert.equal(find("http://deep.b.org/", "deep.b.org"), "PROXY 10.0.0.1:3128");
  assert.equal(find("http://www.deep.b.org/", "www.deep.b.org"), "PROXY 10.0.0.1:3128");
  assert.equal(find("http://plain.org/", "plain.org"), "DIRECT");
});

await test("overlapping domains: the first proxy in order wins", async () => {
  const config = {
    enabled: true,
    proxies: [
      {
        id: "a",
        name: "A",
        type: "socks5",
        host: "1.1.1.1",
        port: 1080,
        username: "",
        password: "",
        domains: ["shared.io"],
      },
      {
        id: "b",
        name: "B",
        type: "http",
        host: "2.2.2.2",
        port: 8080,
        username: "",
        password: "",
        domains: ["shared.io", "only-b.io"],
      },
    ],
  };
  await applyProxyConfig(config);
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://shared.io/", "shared.io"), "SOCKS5 1.1.1.1:1080");
  assert.equal(find("http://www.shared.io/", "www.shared.io"), "SOCKS5 1.1.1.1:1080");
  assert.equal(find("http://only-b.io/", "only-b.io"), "PROXY 2.2.2.2:8080");
});

await test("proxies without domains or with bad ports stay out of the PAC", async () => {
  const config = {
    enabled: true,
    proxies: [
      { id: "a", name: "A", type: "socks5", host: "1.1.1.1", port: "abc", domains: ["x.dev"] },
      { id: "b", name: "B", type: "socks5", host: "2.2.2.2", port: 1080, domains: [] },
      { id: "c", name: "C", type: "http", host: "3.3.3.3", port: 8080, domains: ["ok.dev"] },
    ],
  };
  await applyProxyConfig(config);
  const routes = JSON.parse(lastPacScript().match(/const ROUTES = (\[[\s\S]*?\]);/)[1]);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].host, "3.3.3.3");
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://x.dev/", "x.dev"), "DIRECT");
  assert.equal(find("http://ok.dev/", "ok.dev"), "PROXY 3.3.3.3:8080");
});

await test("enabled config with zero proxies routes everything direct", async () => {
  await applyProxyConfig({ enabled: true, proxies: [] });
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://whatever.com/", "whatever.com"), "DIRECT");
});

await test("disabled config clears proxy settings", async () => {
  proxySettings.length = 0;
  await applyProxyConfig({ enabled: false, proxies: [] });
  assert.equal(proxySettings[0], "cleared");
});

console.log(`\n${passed} tests passed`);