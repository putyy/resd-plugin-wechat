const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin.json"), "utf8"));

function observe(plugin, pluginVersion, url, body, enableLog) {
  const address = new URL(url);
  return plugin.onObservation({
    stage: "response",
    settings: {enableLog},
    request: {url, host: address.hostname, path: address.pathname, headers: {}},
    response: {statusCode: 200, body}
  }, {pluginVersion, log() {}});
}

test("page and dependency scripts share a cache key across releases and revisions", () => {
  const plugin = vm.createContext({});
  vm.runInContext(source, plugin);
  const revision = plugin.WECHAT_INJECTION_CACHE_REVISION;
  const nextVersion = (Number(manifest.version.split(".")[0]) + 1) + ".0.0";
  const scenarios = [
    {version: manifest.version, revision},
    {version: nextVersion, revision},
    {version: manifest.version, revision: revision + 1}
  ];
  const cacheKeys = new Set();

  for (const scenario of scenarios) {
    plugin.WECHAT_INJECTION_CACHE_REVISION = scenario.revision;
    const expectedKey = scenario.version + "-" + scenario.revision;
    cacheKeys.add(expectedKey);
    for (const page of ["feed", "home"]) {
      for (const enableLog of [false, true]) {
        const result = observe(plugin, scenario.version,
          "https://channels.weixin.qq.com/web/pages/" + page,
          '<script src="https://res.wx.qq.com/t/wx_fed/finder/web/chunk.js"></script>', enableLog);
        assert.equal(result.decision, "continue");
        assert.equal(result.patch?.body,
          '<script src="https://res.wx.qq.com/t/wx_fed/finder/web/chunk.js?v=' + expectedKey + '"></script>');

        // Follow the URL actually emitted by the page, as the browser would.
        const scriptURL = result.patch.body.match(/src="([^"]+)"/)[1];
        const dependency = observe(plugin, scenario.version, scriptURL, 'load("next.js")', enableLog);
        assert.equal(dependency.decision, "continue");
        assert.equal(dependency.patch?.body, 'load("next.js?v=' + expectedKey + '")');
      }
    }
  }
  assert.equal(cacheKeys.size, scenarios.length);
});
