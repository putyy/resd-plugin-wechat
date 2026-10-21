const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../page/bridge.js"), "utf8");
const plugin = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), plugin);
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "./fixtures/video.json"), "utf8")).steps[0].message;

for (const name of fs.readdirSync(path.join(__dirname, "fixtures")).filter((name) => name.endsWith(".json"))) {
  test("page-message fixture: " + name, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
    const aliases = new Map(), latestByGroup = new Map();
    const api = {pluginVersion: "1.0.3", log() {}, correlate: {
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
      const result = step.observation ? plugin.onObservation(step.observation, api) :
        plugin.onPageMessage(step.message, fixture.context, api);
      for (const resource of result.resources || []) latestByGroup.set(resource.groupKey, resource);
    }
    // Check each group's latest emitted version; host persistence/merge is outside this contract.
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

function page(available, send = () => Promise.resolve({ok: true})) {
  let probes = 0, sends = 0;
  const context = {Promise, Object, pageApi: {
    probe() { probes++; return Promise.resolve(available); },
    send(message) { sends++; return send(message); }
  }};
  context.window = context;
  vm.runInNewContext(source, context);
  return {context, bridge: context.__resdWechatBridge, probes: () => probes, sends: () => sends};
}

test("one document shares its probe across video and live reports", async () => {
  const p = page(true);
  vm.runInNewContext(source, p.context);
  await Promise.all([p.bridge.send(payload), p.bridge.send({event: "live-ready"})]);
  assert.equal(p.probes(), 1);
  assert.equal(p.sends(), 2);
});

test("failed or pending probes never send business data", async () => {
  const p = page(false);
  assert.equal((await p.bridge.send(payload)).ok, false);
  assert.equal((await p.bridge.send(payload)).ok, false);
  assert.equal(p.sends(), 0);
  let release;
  const pending = page(new Promise((resolve) => { release = resolve; }));
  const result = pending.bridge.send(payload);
  await Promise.resolve();
  assert.equal(pending.sends(), 0);
  release(true);
  assert.equal((await result).ok, true);
});

test("send failures disable reports without throwing", async () => {
  for (const send of [() => Promise.reject(new Error("offline")), () => Promise.resolve({ok: false})]) {
    const p = page(true, send);
    assert.equal((await p.bridge.send(payload)).ok, false);
    assert.equal((await p.bridge.send(payload)).ok, false);
    assert.equal(p.sends(), 1);
  }
});

test("page messages validate context and retain the complete page address", () => {
  const context = {scriptId: "wechat-bridge", origin: "https://channels.weixin.qq.com", pageUrl: payload.pageUrl};
  const api = {log() {}};
  const value = {...payload, pageUrl: payload.pageUrl + "?example=1#sample"};
  const result = plugin.onPageMessage(value, context, api);
  assert.equal(result.ok, true);
  assert.equal(result.resources[0].source.pageUrl, value.pageUrl);
  for (const invalid of [{...context, scriptId: "other"}, {...context, origin: "https://example.com"}]) {
    assert.equal(plugin.onPageMessage(value, invalid, api).ok, false);
  }
  for (const invalid of [null, [], {event: "unknown"}, {...value, padding: "x".repeat(65536)}]) {
    assert.equal(plugin.onPageMessage(invalid, context, api).ok, false);
  }
});
