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

const { loadConfig, saveConfig, applyProxyConfig, parseDomainList } = await import(
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

await test("v2 load defaults unknown/missing mode to include", async () => {
  storedData = {
    socks5RouterConfig: {
      enabled: false,
      proxies: [
        { id: "m1", name: "Old", type: "socks5", host: "1.2.3.4", port: 1080, domains: ["a.dev"] },
        { id: "m2", name: "Weird", mode: "bogus", type: "socks5", host: "5.6.7.8", port: 1080, domains: ["b.dev"] },
      ],
    },
  };
  const config = await loadConfig();
  assert.equal(config.proxies[0].mode, "include");
  assert.equal(config.proxies[1].mode, "include");
});

await test("v2 load defaults missing/invalid enabled to true", async () => {
  storedData = {
    socks5RouterConfig: {
      enabled: true,
      proxies: [
        { id: "e1", name: "No field", type: "socks5", host: "1.2.3.4", port: 1080, domains: ["a.dev"] },
        { id: "e2", name: "Explicit off", enabled: false, type: "socks5", host: "5.6.7.8", port: 1080, domains: ["b.dev"] },
        { id: "e3", name: "Corrupt", enabled: "yes", type: "socks5", host: "9.9.9.9", port: 1080, domains: ["c.dev"] },
      ],
    },
  };
  const config = await loadConfig();
  assert.equal(config.proxies[0].enabled, true); // missing -> on
  assert.equal(config.proxies[1].enabled, false); // explicit false survives
  assert.equal(config.proxies[2].enabled, true); // junk -> on
});

console.log("PAC is ASCII-only (chrome.proxy rejects non-ASCII pacScript.data)");

await test("generated PAC script contains only ASCII characters", async () => {
  const config = {
    enabled: true,
    proxies: [
      { id: "a", name: "Name with — dash and ümlaut", type: "socks5", host: "1.1.1.1", port: 1080, domains: ["x.dev", "пример.рф"] },
    ],
  };
  await applyProxyConfig(config);
  const pac = lastPacScript();
  // The whole generated script must be ASCII-only, whatever the config holds.
  const nonAscii = [...pac].filter((ch) => ch.charCodeAt(0) > 0x7E);
  assert.deepEqual(nonAscii, []);
  // The Cyrillic domain is Punycode-encoded, so it survives.
  assert.ok(pac.includes("xn--e1afmkfd.xn--p1ai"));
  assert.ok(!pac.includes("пример"));
  // IDN domain still routes: PAC matches the hostname Chrome passes in
  // (Chrome hands FindProxyForURL the punycode form).
  const find = makeFindProxy(pac);
  assert.equal(find("http://xn--e1afmkfd.xn--p1ai/", "xn--e1afmkfd.xn--p1ai"), "SOCKS5 1.1.1.1:1080");
});

await test("sanitizer converts IDN domains to Punycode", async () => {
  storedData = {
    socks5RouterConfig: {
      enabled: true,
      proxies: [
        { id: "idn", name: "IDN", type: "socks5", host: "ПРИМЕР.РФ", port: 1080, domains: ["ПРИМЕР.РФ", "münchen.de", "plain.io"] },
      ],
    },
  };
  const config = await loadConfig();
  assert.equal(config.proxies[0].host, "xn--e1afmkfd.xn--p1ai");
  assert.deepEqual(config.proxies[0].domains, [
    "xn--e1afmkfd.xn--p1ai",
    "xn--mnchen-3ya.de",
    "plain.io",
  ]);
});

await test("parseDomainList converts IDN candidates to Punycode", async () => {
  assert.deepEqual(parseDomainList("пример.рф\nexample.com"), ["xn--e1afmkfd.xn--p1ai", "example.com"]);
  assert.deepEqual(parseDomainList("MÜNCHEN.DE"), ["xn--mnchen-3ya.de"]);
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

console.log("domain list parsing");

await test("parseDomainList splits on newlines, commas, semicolons, whitespace", async () => {
  assert.deepEqual(parseDomainList("a.dev\nb.org"), ["a.dev", "b.org"]);
  assert.deepEqual(parseDomainList("a.dev,b.org; c.dev"), ["a.dev", "b.org", "c.dev"]);
  assert.deepEqual(parseDomainList("  a.dev \n\t b.org  "), ["a.dev", "b.org"]);
  assert.deepEqual(parseDomainList("Example.COM\nWWW.Foo.IO"), ["example.com", "www.foo.io"]);
});

await test("parseDomainList dedupes and drops empties, keeps order", async () => {
  assert.deepEqual(parseDomainList("a.dev\nA.DEV\n\nb.org\na.dev"), ["a.dev", "b.org"]);
  assert.deepEqual(parseDomainList(""), []);
  assert.deepEqual(parseDomainList(null), []);
  assert.deepEqual(parseDomainList(undefined), []);
  assert.deepEqual(parseDomainList(" , ; \n "), []);
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

console.log("exclude-mode routing");

await test("exclude-mode proxy routes everything except its domains", async () => {
  const config = {
    enabled: true,
    proxies: [
      {
        id: "x",
        name: "Catch-all",
        type: "socks5",
        mode: "exclude",
        host: "9.9.9.9",
        port: 1080,
        username: "",
        password: "",
        domains: ["local.io", "corp.net"],
      },
    ],
  };
  await applyProxyConfig(config);
  const find = makeFindProxy(lastPacScript());
  // listed exceptions -> direct
  assert.equal(find("http://local.io/", "local.io"), "DIRECT");
  assert.equal(find("http://www.local.io/", "www.local.io"), "DIRECT");
  assert.equal(find("http://deep.corp.net/", "deep.corp.net"), "DIRECT");
  // everything else -> the catch-all proxy
  assert.equal(find("http://plain.org/", "plain.org"), "SOCKS5 9.9.9.9:1080");
  assert.equal(find("http://sub.local.io.example.org/", "sub.local.io.example.org"), "SOCKS5 9.9.9.9:1080");
  assert.equal(find("http://localhost.io/", "localhost.io"), "SOCKS5 9.9.9.9:1080");
});

await test("exclude-mode proxy with empty list routes everything", async () => {
  const config = {
    enabled: true,
    proxies: [
      { id: "x", name: "All", type: "http", mode: "exclude", host: "8.8.8.8", port: 8080, username: "", password: "", domains: [] },
    ],
  };
  await applyProxyConfig(config);
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://anything.dev/", "anything.dev"), "PROXY 8.8.8.8:8080");
  assert.equal(find("http://other.org/", "other.org"), "PROXY 8.8.8.8:8080");
});

await test("include beats exclude regardless of card order", async () => {
  const config = {
    enabled: true,
    proxies: [
      {
        id: "x",
        name: "Catch-all",
        type: "socks5",
        mode: "exclude",
        host: "9.9.9.9",
        port: 1080,
        username: "",
        password: "",
        domains: ["a.dev"],
      },
      {
        id: "y",
        name: "Specific",
        type: "http",
        mode: "include",
        host: "7.7.7.7",
        port: 3128,
        username: "",
        password: "",
        domains: ["a.dev"],
      },
    ],
  };
  await applyProxyConfig(config);
  const find = makeFindProxy(lastPacScript());
  // a.dev is excluded by the catch-all but listed on the include proxy —
  // the include proxy is evaluated first and wins even though it is lower
  // in the card order.
  assert.equal(find("http://a.dev/", "a.dev"), "PROXY 7.7.7.7:3128");
  // everything else falls to the catch-all.
  assert.equal(find("http://other.org/", "other.org"), "SOCKS5 9.9.9.9:1080");
});

await test("several exclude proxies: first non-excluding wins", async () => {
  const config = {
    enabled: true,
    proxies: [
      {
        id: "x",
        name: "One",
        type: "socks5",
        mode: "exclude",
        host: "1.1.1.1",
        port: 1080,
        username: "",
        password: "",
        domains: ["a.dev", "shared.io"],
      },
      {
        id: "y",
        name: "Two",
        type: "http",
        mode: "exclude",
        host: "2.2.2.2",
        port: 8080,
        username: "",
        password: "",
        domains: ["b.org", "shared.io"],
      },
    ],
  };
  await applyProxyConfig(config);
  const find = makeFindProxy(lastPacScript());
  // excluded by the first catch-all, not by the second -> the second takes it
  assert.equal(find("http://a.dev/", "a.dev"), "PROXY 2.2.2.2:8080");
  // excluded by the second catch-all, not by the first -> the first takes it
  assert.equal(find("http://b.org/", "b.org"), "SOCKS5 1.1.1.1:1080");
  // excluded by both -> direct
  assert.equal(find("http://shared.io/", "shared.io"), "DIRECT");
  // excluded by none -> first catch-all wins
  assert.equal(find("http://plain.org/", "plain.org"), "SOCKS5 1.1.1.1:1080");
});

await test("exclude proxy with bad port stays out of the PAC", async () => {
  const config = {
    enabled: true,
    proxies: [
      { id: "x", name: "Bad", type: "socks5", mode: "exclude", host: "9.9.9.9", port: "abc", domains: [] },
      { id: "y", name: "Good", type: "http", mode: "exclude", host: "3.3.3.3", port: 8080, domains: ["ok.dev"] },
    ],
  };
  await applyProxyConfig(config);
  const routes = JSON.parse(lastPacScript().match(/const ROUTES = (\[[\s\S]*?\]);/)[1]);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].host, "3.3.3.3");
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://ok.dev/", "ok.dev"), "DIRECT");
  assert.equal(find("http://other.org/", "other.org"), "PROXY 3.3.3.3:8080");
});

console.log("per-proxy enabled flag");

await test("disabled proxies stay out of the PAC; others keep routing", async () => {
  const config = {
    enabled: true,
    proxies: [
      { id: "a", name: "Off", type: "socks5", enabled: false, host: "1.1.1.1", port: 1080, domains: ["x.dev"] },
      { id: "b", name: "On", type: "http", host: "2.2.2.2", port: 8080, username: "", password: "", domains: ["y.dev"] },
      { id: "c", name: "Off catch-all", type: "socks5", enabled: false, mode: "exclude", host: "3.3.3.3", port: 1080, domains: [] },
    ],
  };
  await applyProxyConfig(config);
  const routes = JSON.parse(lastPacScript().match(/const ROUTES = (\[[\s\S]*?\]);/)[1]);
  assert.equal(routes.length, 1); // only the enabled proxy made it in
  assert.equal(routes[0].host, "2.2.2.2");
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://x.dev/", "x.dev"), "DIRECT"); // its proxy is off
  assert.equal(find("http://y.dev/", "y.dev"), "PROXY 2.2.2.2:8080");
  assert.equal(find("http://plain.org/", "plain.org"), "DIRECT"); // catch-all is off too
});

await test("all proxies disabled routes everything direct", async () => {
  const config = {
    enabled: true,
    proxies: [
      { id: "a", name: "Off", type: "socks5", enabled: false, host: "1.1.1.1", port: 1080, domains: ["x.dev"] },
    ],
  };
  await applyProxyConfig(config);
  const find = makeFindProxy(lastPacScript());
  assert.equal(find("http://x.dev/", "x.dev"), "DIRECT");
  assert.equal(find("http://other.org/", "other.org"), "DIRECT");
});

await test("disabled config clears proxy settings", async () => {
  proxySettings.length = 0;
  await applyProxyConfig({ enabled: false, proxies: [] });
  assert.equal(proxySettings[0], "cleared");
});

console.log(`\n${passed} tests passed`);