const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {report} = require("./request-helper");

const plugin = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), plugin);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "./fixtures/video.json"), "utf8"));
const envelope = fixture.steps[0].message;

function observe(payload) {
  const result = report(plugin, payload, {pluginVersion: "1.0.4", log() {}});
  return {...result, resources: result.resources || []};
}

test("playing video preserves a valid creation date as integer milliseconds", () => {
  for (const createtime of [1774790002, "1774790002"]) {
    const resource = observe({...envelope, createtime}).resources[0];
    assert.equal(resource.metadata.createdAt, 1774790002000);
    assert.equal(typeof resource.metadata.createdAt, "number");
  }
});

test("missing or malformed time never invents a date or drops the video", () => {
  for (const createtime of [undefined, null, 0, -1, 1.5, true, "", "invalid", "1.5", {}, [], 253402300800, 1774790002000]) {
    const result = observe({...envelope, createtime});
    assert.equal(result.resources.length, 1);
    assert.equal(Object.hasOwn(result.resources[0].metadata, "createdAt"), false);
  }
  assert.equal(plugin.creationTimeMilliseconds(Infinity), 0);
  assert.equal(plugin.creationTimeMilliseconds(NaN), 0);
});

test("playback requires one video, a stable identity and an actual player URL", () => {
  for (const payload of [null, [], {}, {...envelope, event: "play"}, {...envelope, feedId: ""},
    {...envelope, playbackUrl: "blob:example"}, {...envelope, objectDesc: {media: []}},
    {...envelope, objectDesc: {media: [{mediaType: 9}]}},
    {...envelope, objectDesc: {media: [{}, {}]}}]) {
    assert.equal(observe(payload).resources.length, 0);
  }
});
