const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const samples = require("./component-samples");

const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const plugin = vm.createContext({});
vm.runInContext(source, plugin);
const api = {pluginVersion: "1.0.3", log() {}};

function feed(id = "example-one") {
  const media = {url: "https://finder.video.qq.com/example.mp4", decodeKey: "2136343393", spec: [{fileFormat: "hd"}]};
  return {id, media, objectDescMedia: media, createtime: 1774790002,
    objectDesc: {description: "Example video", media: [media]},
    videoUrl: media.url + "?token=example&X-snsvideoflag=hd"};
}

function page(target, options = {}) {
  const requests = [];
  const handlers = new Map();
  const video = {isConnected: true, paused: true, ended: false};
  const instance = {on(type, handler) { handlers.set(type, handler); }, tech_: {el: () => video}};
  const sandbox = {Map, location: {href: "https://channels.weixin.qq.com/web/pages/feed"},
    __resdWechatBridge: {send(payload) { requests.push({body: JSON.stringify(payload)}); return Promise.resolve({ok: true}); }},
    component: (value) => value,
    computed: (get) => ({get value() { return get(); }}),
    ref: (value) => ({value: options.nativeRef === false && value === video ? null : value}), video, instance,
    tracker: {video() {}}, valid: () => true,
    wrapper: (value) => value, open() {}, PreviewVideo: {},
    create: (component, props, children, flags, dynamicProps) => ({props, dynamicProps})};
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const patched = plugin.injectWechatHooks(samples[target], target, api);
  assert.notEqual(patched, samples[target]);
  new vm.Script(patched);
  vm.runInContext(patched, context);
  return {requests, handlers, video, context, definition: vm.runInContext("definition", context)};
}

test("main player emits only after playing and only for its active work", () => {
  const p = page("main");
  const props = {feed: feed(), active: false};
  const siteEvents = [];
  p.definition.setup(props, {emit: (event) => siteEvents.push(event)});
  for (const event of ["loadstart", "loadedmetadata", "canplaythrough", "play"]) p.handlers.get(event)();
  assert.equal(p.requests.length, 0);
  p.video.paused = false;
  p.handlers.get("playing")();
  assert.equal(p.requests.length, 0);
  props.active = true;
  p.handlers.get("playing")();
  p.handlers.get("playing")();
  assert.equal(p.requests.length, 1);
  const payload = JSON.parse(p.requests[0].body);
  assert.equal(payload.feedId, props.feed.id);
  assert.equal(payload.playbackUrl, props.feed.videoUrl);
  assert.equal(payload.objectDesc.media.length, 1);
  assert.ok(siteEvents.includes("playing"));
  assert.equal(siteEvents.filter((event) => event === "playing").length, 3);
});

test("preview keeps its original callbacks and rejects events from a recycled card", () => {
  const p = page("preview");
  const props = {feed: feed(), active: true, disablePlay: false};
  const render = p.definition.setup(props, {emit() {}});
  const first = render({}, []);
  assert.ok(first.dynamicProps.includes("onPlaying"));
  first.props.onPlay();
  first.props.onLoadeddata();
  assert.equal(p.requests.length, 0);
  p.video.paused = false;
  first.props.onPlaying({target: p.video});
  assert.equal(p.requests.length, 1);
  props.feed = feed("example-two");
  first.props.onPlaying({target: p.video});
  assert.equal(p.requests.length, 1);
  const second = render({}, []);
  second.props.onPlaying({target: p.video});
  assert.equal(JSON.parse(p.requests[1].body).feedId, "example-two");
  props.disablePlay = true;
  second.props.onPlaying({target: p.video});
  assert.equal(p.requests.length, 2);
});

test("detached or paused media never causes a playback report", () => {
  const p = page("main");
  p.definition.setup({feed: feed(), active: true}, {emit() {}});
  p.handlers.get("playing")();
  p.video.paused = false;
  p.video.isConnected = false;
  p.handlers.get("playing")();
  assert.equal(p.requests.length, 0);
});

test("plain HTML5 playback resolves the native tech element and retains player-added parameters", () => {
  const p = page("main", {nativeRef: false});
  const selected = feed();
  selected.media.decodeKey = "";
  const props = {feed: selected, active: true};
  const result = p.definition.setup(props, {emit() {}});
  result.player.currentSource = () => ({src: selected.videoUrl + "&taskid=example-task"});
  p.video.paused = false;
  p.handlers.get("playing")();
  assert.equal(p.requests.length, 1);
  assert.equal(JSON.parse(p.requests[0].body).playbackUrl, selected.videoUrl + "&taskid=example-task");
});

test("metadata access and detail APIs no longer get capture hooks", () => {
  const untouched = 'class Feed { get media(){return this.value} async finderGetCommentDetail(input){return this.load(input)} }';
  assert.equal(plugin.injectWechatHooks(untouched, "main", api), untouched);
  assert.equal(plugin.injectWechatHooks(untouched, "preview", api), untouched);
});

test("default downloads preserve the player URL and quality overrides replace one parameter", () => {
  const observed = "https://finder.video.qq.com/example.mp4?token=example%2Bvalue&X-snsvideoflag=sd&web=1";
  const resource = {tracks: [{id: "video-primary", url: observed, extension: ".mp4"}],
    metadata: {"wechat.fileFormats": ["hd", "sd"]}};
  const resolve = (quality) => plugin.createDownloadPlan({resource, options: {settings: {quality}}});
  assert.equal(resolve("default").inputs[0].url, observed);
  const high = resolve("high").inputs[0].url;
  assert.equal(new URL(high).searchParams.getAll("X-snsvideoflag").length, 1);
  assert.equal(new URL(high).searchParams.get("X-snsvideoflag"), "hd");
  assert.ok(high.includes("token=example%2Bvalue"));
  assert.ok(high.includes("web=1"));
});

test("generic suppression claims player preloads without swallowing article media", () => {
  const response = (host, origin, contentType = "video/mp4", pathname = "/example.mp4") => plugin.onObservation({
    stage: "response", request: {host, path: pathname, url: "https://" + host + pathname,
      headers: origin ? {Origin: [origin]} : {}}, response: {statusCode: 206, contentType}
  }, {...api, correlate: {find: () => null}});
  assert.equal(response("finder.video.qq.com:443").handled, true);
  assert.equal(response("wxapp.tc.qq.com", "https://channels.weixin.qq.com", "application/octet-stream", "/20302/example.mp4").handled, true);
  assert.equal(response("finder.video.qq.com", "https://mp.weixin.qq.com").handled, false);
  assert.equal(response("other.qq.com", "https://example.com").handled, false);
});
