const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {report} = require("./request-helper");
const plugin = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), plugin);
const source = "(" + plugin.installWechatSender.toString() + ")()";
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/video.json"), "utf8")).steps[0].message;
const hostAPI = {pluginVersion: "1.0.4", log() {}};

for (const name of fs.readdirSync(path.join(__dirname, "fixtures")).filter((name) => name.endsWith(".json"))) {
  test("request fixture: " + name, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
    const aliases = new Map(), latestByGroup = new Map();
    const api = {...hostAPI, correlate: {
      register(value) {
        for (const alias of value.aliases) {
          const refs = aliases.get(alias) || [];
          if (!refs.some((ref) => ref.groupKey === value.groupKey && ref.trackId === value.trackId && ref.role === value.role)) {
            refs.push({groupKey: value.groupKey, trackId: value.trackId, role: value.role});
          }
          aliases.set(alias, refs);
        }
      },
      find(alias) { return aliases.get(alias) || null; }
    }};
    for (const step of fixture.steps) {
      const result = step.observation ? plugin.onObservation(step.observation, api) : report(plugin, step.message, api);
      for (const resource of result.resources || []) latestByGroup.set(resource.groupKey, resource);
    }
    const resources = [...latestByGroup.values()];
    assert.equal(resources.length, fixture.expected.resourceCount);
    const urls = resources.flatMap((resource) => Array.from(resource.tracks, (track) => track.url));
    for (const expected of fixture.expected.resourceUrls || []) assert.ok(urls.includes(expected));
    if (fixture.expected.processorTypes) {
      const plan = plugin.createDownloadPlan({resource: resources[0]});
      const types = Array.from(plan.inputs).flatMap((input) => Array.from(input.processors || [], (processor) => processor.type));
      assert.deepEqual(types, fixture.expected.processorTypes);
    }
  });
}

function page(available = true, send = () => Promise.resolve({ok: true}), options = {}) {
  const requests = [], timers = new Map();
  let id = 0;
  const context = {Promise, Object, AbortController, TextEncoder,
    location: {href: options.pageUrl || payload.pageUrl},
    setTimeout(fn, delay) { timers.set(++id, {fn, delay}); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(address, init) {
      requests.push({address, init});
      const result = init.method === "GET" ? Promise.resolve(available).then((value) =>
        typeof value === "object" ? value : {ok: value, plugin: "official.wechat"}) : send(JSON.parse(init.body));
      return result.then((body) => ({ok: true, json: () => Promise.resolve(body)}));
    }};
  context.window = context;
  vm.runInNewContext(source, context);
  return {context, sender: context.__resdWechatSender, requests, timers,
    probes: () => requests.filter((r) => r.init.method === "GET"),
    sends: () => requests.filter((r) => r.init.method === "POST")};
}

test("player JS alone initializes one probe for the whole document", async () => {
  const p = page();
  vm.runInNewContext(source, p.context);
  await Promise.all([p.sender.send(payload), p.sender.send({event: "live-ready"})]);
  assert.equal(p.probes().length, 1);
  assert.equal(p.sends().length, 2);
  const probe = p.probes()[0];
  assert.equal(probe.address, "/res-downloader/wechat?type=probe");
  assert.equal(Object.hasOwn(probe.init, "body"), false);
  for (const {address, init} of p.requests) {
    assert.ok(address.startsWith("/res-downloader/wechat"));
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.redirect, "error");
    assert.equal(init.mode, "same-origin");
  }
  assert.equal(p.context.pageApi, undefined);
  assert.equal(p.timers.size, 0);
});

test("failed, spoofed and timed-out probes never send business data", async () => {
  for (const result of [false, {ok: true, plugin: "other"}]) {
    const p = page(result);
    assert.equal((await p.sender.send(payload)).ok, false);
    assert.equal((await p.sender.send(payload)).ok, false);
    assert.equal(p.probes().length, 1);
    assert.equal(p.sends().length, 0);
  }
  let release;
  const p = page(new Promise((resolve) => { release = resolve; }));
  const result = p.sender.send(payload);
  for (const {fn} of [...p.timers.values()]) fn();
  assert.equal((await result).ok, false);
  release(true);
  await Promise.resolve();
  assert.equal((await p.sender.send(payload)).ok, false);
  assert.equal(p.sends().length, 0);
});

test("pending initialization has a bounded queue and honours cancellation", async () => {
  let release;
  const p = page(new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const queued = Array.from({length: 16}, (_, index) => p.sender.send({...payload, feedId: "sample-" + index},
    index === 0 ? controller.signal : undefined));
  assert.equal((await p.sender.send(payload)).ok, false);
  assert.equal(p.sends().length, 0);
  controller.abort(); release(true);
  const results = await Promise.all(queued);
  assert.equal(results[0].ok, false);
  assert.equal(p.sends().length, 15);
});

test("transport failures stop reports and oversized UTF-8 messages are rejected locally", async () => {
  for (const send of [() => Promise.reject(new Error("offline")), () => Promise.resolve({ok: false})]) {
    const p = page(true, send);
    assert.equal((await p.sender.send(payload)).ok, false);
    assert.equal((await p.sender.send(payload)).ok, false);
    assert.equal(p.sends().length, 1);
  }
  const p = page();
  assert.equal((await p.sender.send({...payload, padding: "字".repeat(30000)})).ok, false);
  assert.equal(p.sends().length, 0);
  assert.equal(page(true, undefined, {pageUrl: "https://example.com/watch"}).sender, undefined);
});

test("the plugin intercepts probes and reports and preserves the full page URL", () => {
  const probe = report(plugin, null, hostAPI, {method: "GET", url: "https://channels.weixin.qq.com:443/res-downloader/wechat?type=probe",
    host: "channels.weixin.qq.com:443", headers: {}, body: ""});
  assert.equal(probe.ok, true);
  assert.equal(probe.decision, "stop");
  assert.equal(probe.resources.length, 0);
  const value = {...payload, pageUrl: payload.pageUrl + "?example=1#sample"};
  const result = report(plugin, value, hostAPI);
  assert.equal(result.ok, true);
  assert.equal(result.resources[0].source.pageUrl, value.pageUrl);
  const invalidCases = [
    [{headers: {Origin: ["https://example.com"], "Content-Type": ["application/json"]}}, 403],
    [{headers: {"Content-Type": ["text/plain"]}}, 415],
    [{method: "DELETE"}, 405], [{truncated: true}, 413],
    [{body: "x".repeat(65537)}, 413], [{body: JSON.stringify({padding: "字".repeat(30000)})}, 413],
    [{body: "{"}, 400]
  ];
  for (const [overrides, status] of invalidCases) {
    const rejected = report(plugin, payload, hostAPI, overrides);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.statusCode, status);
    assert.equal(rejected.resources.length, 0);
  }
  for (const invalid of [null, [], {event: "unknown"}, {...value, pageUrl: "https://example.com/watch"}]) {
    assert.equal(report(plugin, invalid, hostAPI).ok, false);
  }
  const unrelated = plugin.onObservation({stage: "request", request: {method: "POST", url: "https://example.com/res-downloader/wechat",
    host: "example.com", path: "/res-downloader/wechat", headers: {}}}, hostAPI);
  assert.equal(unrelated.decision, "continue");
  assert.equal(unrelated.syntheticResponse, undefined);
});
