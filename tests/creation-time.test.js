const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const plugin = vm.createContext({});
vm.runInContext(source, plugin);
const description = {
  description: "Private example title",
  media: [{url: "https://cdn.example.com/example.mp4", fileSize: 1234}]
};

function observe(payload, type, fullIntercept) {
  const result = plugin.onObservation({
    stage: "request", settings: {fullIntercept},
    request: {
      url: "https://wxapp.tc.qq.com/res-downloader/wechat?type=" + type,
      body: JSON.stringify(payload)
    }
  }, {pluginVersion: "1.0.1", log() {}});
  return {result};
}

test("details provide integer milliseconds in either capture mode", () => {
  for (const fullIntercept of [true, false]) {
    for (const createtime of [1774790002, "1774790002"]) {
      const {result} = observe({createtime, objectDesc: description}, "2", fullIntercept);
      assert.equal(result.resources.length, 1);
      const resource = result.resources[0];
      assert.equal(resource.metadata.createdAt, 1774790002000);
      assert.equal(typeof resource.metadata.createdAt, "number");
      assert.equal(resource.metadata.publishedAt, undefined);
      assert.equal(resource.title, description.description);
    }
  }
});

test("missing or malformed time does not discard the media or invent a date", () => {
  for (const createtime of [undefined, null, 0, -1, 1.5, true, "", "invalid", "1.5", {}, [], 253402300800, 1774790002000]) {
    const {result} = observe({createtime, objectDesc: description}, "2", true);
    assert.equal(result.resources.length, 1);
    assert.equal(Object.hasOwn(result.resources[0].metadata, "createdAt"), false);
  }
  assert.equal(plugin.creationTimeMilliseconds(Infinity), 0);
  assert.equal(plugin.creationTimeMilliseconds(NaN), 0);
});

test("both capture modes use the shared envelope and reject unwrapped data", () => {
  const payload = {objectDesc: description};
  const media = observe(payload, "1", true).result.resources[0];
  const detail = observe({createtime: 1774790002, objectDesc: description}, "2", true).result.resources[0];
  assert.equal(media.groupKey, detail.groupKey);
  assert.equal(Object.hasOwn(media.metadata, "createdAt"), false);
  assert.equal(observe(payload, "1", false).result.resources.length, 0);
  assert.equal(observe(payload, "2", false).result.resources.length, 1);
  for (const invalid of [description, null, [], {objectDesc: null}, {objectDesc: "invalid"}]) {
    for (const type of ["1", "2"]) {
      assert.equal(observe(invalid, type, true).result.resources.length, 0);
    }
  }
});

test("detail hook sends only the shared envelope without diagnostic requests", () => {
  const code = plugin.injectWechatHooks("class Detail { async finderGetCommentDetail(input){return await this.load(input)}async next(){} }");
  new vm.Script(code);
  assert.ok(code.includes("body:JSON.stringify({objectDesc:res.data.object.objectDesc,createtime:res.data.object.createtime})"));
  assert.ok(!code.includes("body:JSON.stringify(res.data.object)"));
  assert.ok(!code.includes("debug-detail"));
  assert.ok(!code.includes("body:JSON.stringify(res.data)"));
});

test("media getter forwards time without serializing the full instance", () => {
  const code = plugin.injectWechatHooks("class Feed { get media(){return this.value;} }");
  const requests = [];
  vm.runInNewContext(code + `
    var feed = new Feed();
    feed.objectDesc = {description: "Example", media: [{url: "https://cdn.example.com/example.mp4"}]};
    feed.createtime = 1774790002;
    feed.self = feed;
    feed.value = [];
    feed.media;
  `, {fetch: (url, options) => {
    requests.push({url, body: options.body});
    return Promise.resolve();
  }});
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("type=1"));
  const payload = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(payload).sort(), ["createtime", "objectDesc"]);
  assert.equal(payload.createtime, 1774790002);
  assert.equal(payload.objectDesc.description, "Example");
  const {result} = observe(payload, "1", true);
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].metadata.createdAt, 1774790002000);
  assert.equal(result.resources[0].metadata.publishedAt, undefined);
  assert.equal(observe(payload, "1", false).result.resources.length, 0);
  delete payload.createtime;
  assert.equal(Object.hasOwn(observe(payload, "1", true).result.resources[0].metadata, "createdAt"), false);
  assert.ok(!code.includes("debug-media"));
});
