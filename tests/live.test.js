const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const samples = require("./live-samples");
const plugin = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), plugin);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "./fixtures/live-stream.json"), "utf8"));
const payload = fixture.steps[0].message;

function api() {
  const refs = new Map();
  return {pluginVersion: "1.0.3", log() {}, correlate: {
    register(value) {
      for (const alias of value.aliases) {
        const entries = refs.get(alias) || [];
        if (!entries.some((ref) => ref.groupKey === value.groupKey && ref.trackId === value.trackId && ref.role === value.role)) {
          entries.push({groupKey: value.groupKey, trackId: value.trackId, role: value.role});
        }
        refs.set(alias, entries);
      }
    },
    find(alias) { return refs.get(alias) || null; }
  }};
}
function bridge(type, value, hostAPI) {
  const result = plugin.onPageMessage({...value, event: type}, fixture.context, hostAPI);
  return {...result, resources: result.resources || []};
}
function media(url, hostAPI, contentType = "video/x-flv", statusCode = 206,
  headers = {Range: ["bytes=100-"], Origin: ["https://channels.weixin.qq.com"]}) {
  const parsed = new URL(url);
  return plugin.onObservation({stage: "response", request: {url, host: parsed.host, path: parsed.pathname,
    headers},
    response: {statusCode, contentType}}, hostAPI);
}
const resolve = (value, hostAPI) => bridge("live-stream", value, hostAPI);

test("resources require a registered stream's successful response, without a playing report", () => {
  for (const mime of ["video/x-flv", "audio/video", "application/octet-stream"]) {
    const hostAPI = api();
    assert.equal(media(payload.playbackUrl, hostAPI).handled, false);
    assert.equal(resolve(payload, hostAPI).resources.length, 0);
    assert.equal(bridge("live-ready", payload, hostAPI).resources.length, 0);
    const pending = resolve(payload, hostAPI);
    assert.equal(pending.data.observed, false);
    assert.equal(pending.resources.length, 0);
    const result = media(payload.playbackUrl, hostAPI, mime);
    assert.equal(result.handled, true);
    assert.equal(result.resources, undefined);
    const resource = resolve(payload, hostAPI).resources[0];
    assert.equal(resource.title, payload.title);
    assert.equal(resource.metadata.author, payload.author);
    assert.equal(resource.coverUrl, payload.coverUrl);
    assert.equal(resource.kind, "stream.live");
    const plan = plugin.createDownloadPlan({resource, options: {settings: {quality: "high"}}});
    assert.equal(plan.inputs[0].executor, "ffmpeg-hls");
    assert.equal(plan.inputs[0].url, payload.playbackUrl);
    assert.equal(plan.inputs[0].headers.Origin, "https://channels.weixin.qq.com");
  }
});

test("preloads, invalid responses and earlier loads do not create a live resource", () => {
  const hostAPI = api();
  bridge("live-ready", payload, hostAPI);
  media(payload.playbackUrl, hostAPI, "text/html");
  media(payload.playbackUrl, hostAPI, "video/x-flv", 404);
  media(payload.playbackUrl, hostAPI, "video/x-flv", 304);
  assert.equal(resolve(payload, hostAPI).resources.length, 0);
  media(payload.playbackUrl, hostAPI);
  assert.equal(resolve({...payload, active: false}, hostAPI).resources.length, 0);
  assert.equal(resolve(payload, hostAPI).resources.length, 1);
  const next = {...payload, loadId: "another-load"};
  bridge("live-ready", next, hostAPI);
  assert.equal(resolve(next, hostAPI).resources.length, 0);
  media(payload.playbackUrl, hostAPI);
  assert.equal(resolve(next, hostAPI).resources.length, 1);
  assert.equal(bridge("live-playing", payload, hostAPI).resources.length, 0);
});

test("invalid bridge data keeps generic fallback", () => {
  const hostAPI = api();
  for (const value of [{...payload, roomId: ""}, {...payload, loadId: ""}, {...payload, active: "true"},
    {...payload, playbackUrl: "https://example.com/sample.flv"},
    {...payload, playbackUrl: "https://user@host.qq.com/sample.flv"},
    {...payload, pageUrl: "https://example.com/live"}]) {
    assert.equal(bridge("live-ready", value, hostAPI).ok, false);
  }
  assert.equal(plugin.onPageMessage(payload, {...fixture.context, origin: "https://example.com"}, hostAPI).ok, false);
  assert.equal(media(payload.playbackUrl, hostAPI).handled, false);
});

test("wxlivecdn URLs retain queries and accept default-port spellings", () => {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, "./fixtures/live-wxlivecdn.json"), "utf8"));
  const selected = input.steps[0].message, hostAPI = api();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin.json"), "utf8"));
  assert.ok(manifest.permissions.domains.includes("pull-m1.wxlivecdn.com"));
  assert.ok(manifest.match.some((r) => r.host === "pull-m1.wxlivecdn.com" && r.readBody === false));
  assert.equal(media(selected.playbackUrl, hostAPI).handled, false);
  bridge("live-ready", selected, hostAPI);
  assert.equal(media(selected.playbackUrl.replace(":443/", "/"), hostAPI).handled, true);
  assert.equal(media(selected.playbackUrl + "&different=1", hostAPI).handled, false);
  const resource = resolve(selected, hostAPI).resources[0];
  assert.equal(resource.source.pageUrl, "https://channels.weixin.qq.com/web/pages/home");
  assert.equal(plugin.createDownloadPlan({resource}).inputs[0].url, selected.playbackUrl);
  for (const host of ["pull-m1.wxlivecdn.com.example.com", "fake-pull-m1.wxlivecdn.com", "other.wxlivecdn.com"]) {
    assert.equal(plugin.liveURLAlias(selected.playbackUrl.replace("pull-m1.wxlivecdn.com", host)), "");
  }
});

test("home and detail qualities suppress generic duplicates without sharing response proof", () => {
  const hostAPI = api();
  const homeURL = "https://pull-m1.wxlivecdn.com:443/trtc_12345/orig_111222_nh420.flv?cdntagname=nh420&q=3";
  const detailURL = "https://pull-m1.wxlivecdn.com/trtc_12345/orig_111222_jf521.flv?cdntagname=jf521&q=4";
  const home = {...payload, liveId: "111222", playbackUrl: homeURL, loadId: "home-load"};
  const detail = {...home, playbackUrl: detailURL, loadId: "detail-load"};
  // The home request arrives before any metadata or exact URL registration.
  assert.equal(media(homeURL, hostAPI).handled, true);
  assert.equal(resolve(home, hostAPI).resources.length, 0);
  assert.equal(media(homeURL, hostAPI, "video/x-flv", 200, {Origin: ["https://example.com"]}).handled, false);
  bridge("live-ready", home, hostAPI);
  media(homeURL, hostAPI);
  const first = resolve(home, hostAPI).resources[0];
  assert.equal(media(detailURL, hostAPI, "video/x-flv", 200, {}).handled, true);
  bridge("live-ready", detail, hostAPI);
  // A response observed before this load was registered is not proof for it.
  assert.equal(resolve(detail, hostAPI).resources.length, 0);
  media(detailURL, hostAPI);
  const second = resolve(detail, hostAPI).resources[0];
  assert.equal(second.groupKey, first.groupKey);
  assert.equal(second.tracks[0].url, detailURL);
  assert.equal(first.tracks[0].url, homeURL);
  const otherRoom = detailURL.replace("111222", "333444");
  assert.equal(media(otherRoom, hostAPI, "video/x-flv", 200, {}).handled, false);
  assert.equal(media(detailURL, api(), "text/html", 200, {}).handled, false);
  assert.equal(plugin.liveSession("https://pull-m1.wxlivecdn.com/other.flv?next=/trtc_12345/orig_111222_nh420.flv"), null);
});

test("live injection is idempotent and preserves JavaScript syntax", () => {
  for (const target of ["live", "live-preview"]) {
    const patched = plugin.injectWechatLiveHooks(samples[target], target, api());
    assert.notEqual(patched, samples[target]);
    new vm.Script(patched.replace(/import\{[^;]+;/g, ""));
    assert.equal(plugin.injectWechatLiveHooks(patched, target, api()), patched);
  }
  const unsupported = 'const component={name:"UnknownPlayer"};';
  assert.equal(plugin.injectWechatLiveHooks(unsupported, "live", api()), unsupported);
});

function page({pending = false, failed = false, lostAck = false, active = true, autoResponse = true} = {}) {
  const hostAPI = api(), requests = [], resources = [], order = [], timers = new Map();
  let release, timerID = 0;
  const gate = pending ? new Promise((r) => { release = r; }) : Promise.resolve();
  const room = {id: payload.roomId, liveInfo: {liveId: payload.liveId},
    objectDesc: {description: payload.title}, contact: {nickname: payload.author}, coverImgUrl: payload.coverUrl};
  const stream = {url: payload.playbackUrl, active};
  // Intentionally no event APIs: the integration must not subscribe to playing.
  const video = {isConnected: true, paused: true};
  const player = {load() { order.push("load"); if (autoResponse) media(stream.url, hostAPI); },
    play() { order.push("play"); return "site-play-result"; }, destroy() { order.push("destroy"); }};
  const context = {Map, Promise, Object, AbortController, location: {href: payload.pageUrl},
    setTimeout(fn, ms) { const id = ++timerID; timers.set(id, {fn, ms}); return id; }, clearTimeout(id) { timers.delete(id); },
    pageApi: {probe: () => Promise.resolve(true), send(value) {
      const type = value.event;
      requests.push(value);
      if (failed && type === "live-ready") return Promise.reject(new Error("bridge unavailable"));
      return gate.then(() => {
        const result = plugin.onPageMessage(value, {scriptId: "wechat-bridge", origin: "https://channels.weixin.qq.com",
          pageUrl: payload.pageUrl}, hostAPI);
        resources.push(...(result.resources || [])); order.push(type);
        if (lostAck && type === "live-ready") throw new Error("ready response lost");
        return result;
      });
    }}};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../page/bridge.js"), "utf8"), context);
  vm.runInNewContext("(" + plugin.wechatLivePageBridge.toString() + ")()", context);
  context.__resdWechatLive.bind(player, () => room, () => stream, () => video);
  function tick() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } }
  return {hostAPI, requests, resources, order, timers, room, stream, video, player, release, tick};
}
const settle = () => new Promise(setImmediate);

test("an active stream resolves after response headers while the video is still paused", async () => {
  const p = page({pending: true});
  p.player.load(); await settle(); assert.deepEqual(p.order, []);
  p.release(); await settle();
  assert.deepEqual(p.order, ["live-ready", "load", "live-stream"]);
  assert.equal(p.resources.length, 1);
  assert.equal(p.video.paused, true);
  assert.equal(p.timers.size, 0);
});

test("late responses are resolved without playing, with polling cleaned up afterward", async () => {
  const p = page({autoResponse: false});
  p.player.load(); await settle();
  assert.equal(p.resources.length, 0);
  assert.equal(p.timers.size, 1);
  media(p.stream.url, p.hostAPI); p.tick(); await settle();
  assert.equal(p.resources.length, 1);
  assert.equal(p.timers.size, 0);
});

test("a preloaded stream is captured when selected without a second network response", async () => {
  const p = page({active: false});
  p.player.load(); await settle(); assert.equal(p.resources.length, 0);
  p.stream.active = true;
  assert.equal(p.player.play(), "site-play-result"); await settle();
  assert.equal(p.resources.length, 1);
  assert.equal(p.order.filter((x) => x === "load").length, 1);
});

test("failed registration or lost acknowledgments stop reporting without blocking playback", async () => {
  const failed = page({failed: true}); failed.player.load(); await settle();
  assert.ok(failed.order.includes("load")); assert.equal(failed.resources.length, 0);
  assert.equal(media(failed.stream.url, failed.hostAPI).handled, false);
  const p = page({lostAck: true}); p.player.load(); await settle();
  assert.ok(p.order.includes("load")); assert.equal(p.resources.length, 0);
});

test("timeouts resume loading; destruction and room changes stop deferred resolution", async () => {
  const p = page({pending: true}); p.player.load(); p.tick(); await settle();
  assert.ok(p.order.includes("load")); p.player.destroy(); p.release(); await settle();
  assert.equal(p.resources.length, 0); assert.equal(p.timers.size, 0);
  const changed = page({autoResponse: false}); changed.player.load(); await settle();
  changed.room.id = "another-room"; changed.tick(); await settle();
  assert.equal(changed.resources.length, 0); assert.equal(changed.timers.size, 0);
});
