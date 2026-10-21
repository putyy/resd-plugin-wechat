var WECHAT_INJECTION_CACHE_REVISION = 1;

function endsWith(value, suffix) {
  return value.slice(-suffix.length) === suffix;
}

function firstHeader(headers, name) {
  var expected = name.toLowerCase();
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === expected) {
      var values = headers[key];
      return values && values.length ? values[0] : "";
    }
  }
  return "";
}

function queryValue(rawUrl, name) {
  var match = new RegExp("[?&]" + name + "=([^&#]*)").exec(rawUrl);
  try { return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : ""; }
  catch (error) { return ""; }
}

function isHTTPURL(value) {
  return typeof value === "string" && value.length <= 32768 &&
    /^https?:\/\/[^\s/@?#]+(?:[/?#][^\s]*|$)$/i.test(value);
}

function creationTimeMilliseconds(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !isFinite(value) || value <= 0 ||
      Math.floor(value) !== value || value > 253402300799) return 0;
  return value * 1000;
}

function mediaResources(payload, pageUrl, api) {
  var description = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.objectDesc : null;
  if (!payload || payload.event !== "playing" || typeof payload.feedId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.feedId) ||
      !description || typeof description !== "object" || Array.isArray(description)) {
    api.log("wechat: resource rejected: invalid playback envelope");
    return [];
  }
  var createdAt = creationTimeMilliseconds(payload.createtime);
  var media = description.media;
  if (!Array.isArray(media) || media.length !== 1 || !media[0] || typeof media[0] !== "object" ||
      Array.isArray(media[0]) || Number(media[0].mediaType) !== 4 ||
      !isHTTPURL(media[0].url) || !isHTTPURL(payload.playbackUrl)) {
    api.log("wechat: resource rejected: expected one playing video");
    return [];
  }

  var resources = [];
  for (var index = 0; index < media.length; index++) {
    var item = media[index] || {};
    var rawUrl = payload.playbackUrl;
    var formats = [];
    if (Array.isArray(item.spec)) {
      for (var specIndex = 0; specIndex < Math.min(item.spec.length, 64); specIndex++) {
        var format = item.spec[specIndex] && item.spec[specIndex].fileFormat;
        if (typeof format === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(format)) formats.push(format);
      }
    }

    var metadata = {"wechat.fileFormats": formats, "wechat.feedId": payload.feedId};
    if (createdAt) metadata.createdAt = createdAt;
    var processors = [];
    if (item.decodeKey && (typeof item.decodeKey !== "string" || !/^\d{1,20}$/.test(item.decodeKey))) {
      api.log("wechat: resource rejected: invalid decode key");
      return [];
    }
    if (typeof item.decodeKey === "string" && /^\d{1,20}$/.test(item.decodeKey)) {
      processors.push({
        type: "plugin-wasm",
        options: {processor: "isaac64-prefix", seed: item.decodeKey}
      });
    }

    var trackId = "video-primary";
    var groupKey = "wechat:video:feed:" + payload.feedId;
    var actions = [];
    if (processors.length) {
      actions.push({
        id: "decrypt-local-file",
        data: {options: {seed: item.decodeKey}}
      });
    }
    var size = Number(item.fileSize);
    if (!isFinite(size) || size < 0 || Math.floor(size) !== size || size > 9007199254740991) size = 0;
    resources.push({
      groupKey: groupKey,
      title: typeof description.description === "string" ? description.description.slice(0, 4096) : "",
      coverUrl: isHTTPURL(item.coverUrl) ? item.coverUrl : "",
      kind: "media.video",
      tracks: [{
        id: trackId,
        role: "video",
        url: rawUrl,
        mime: "video/mp4",
        extension: ".mp4",
        size: size,
        processors: processors
      }],
      requiredTracks: ["video"],
      capabilities: ["download", "preview", "open", "copy"],
      preview: {
        renderer: "video",
        mode: "range-proxy",
        mime: "video/mp4",
        trackId: trackId
      },
      metadata: metadata,
      actions: actions,
      source: {pageUrl: isHTTPURL(payload.pageUrl) && /^https:\/\/channels\.weixin\.qq\.com(?::443)?\//.test(payload.pageUrl) ? payload.pageUrl : pageUrl}
    });
  }
  return resources;
}

// Keep every query parameter: signatures and stream variants are not aliases.
function liveURLAlias(value) {
  if (!isHTTPURL(value)) return "";
  var match = /^(https?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+))?(\/[^#]*)(?:#.*)?$/i.exec(value);
  if (!match || !/\.flv(?:\?|$)/i.test(match[4])) return "";
  var host = match[2].toLowerCase();
  if (!endsWith(host, ".qq.com") && host !== "pull-m1.wxlivecdn.com") return "";
  var scheme = match[1].toLowerCase();
  var port = match[3] || "";
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = "";
  return "wechat:live-url:" + scheme + "://" + host + (port ? ":" + port : "") + match[4];
}

// TRTC quality variants carry the same live ID in the path. This alias is
// solely for generic suppression; response confirmation still requires the
// exact URL so a response for one quality cannot validate another quality.
function liveSession(value) {
  var alias = liveURLAlias(value);
  var match = alias && /^wechat:live-url:https?:\/\/[^/]+\/trtc_(\d{1,32})\/orig_(\d{1,32})_[A-Za-z0-9_-]{1,64}\.flv(?:\?|$)/.exec(alias);
  return match ? {id: match[2], alias: "wechat:live-session:" + match[1] + ":" + match[2]} : null;
}

function isWechatPageRequest(request) {
  var headers = request.headers || {};
  return /^https:\/\/channels\.weixin\.qq\.com(?::443)?(?:\/|$)/i.test(firstHeader(headers, "Origin")) ||
    /^https:\/\/channels\.weixin\.qq\.com(?::443)?\//i.test(firstHeader(headers, "Referer"));
}

function livePayload(payload, event, api) {
  if (!payload || Array.isArray(payload) || payload.event !== event ||
      typeof payload.roomId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.roomId) ||
      typeof payload.liveId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.liveId) ||
      typeof payload.loadId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.loadId) ||
      typeof payload.active !== "boolean" ||
      !liveURLAlias(payload.playbackUrl) ||
      typeof payload.pageUrl !== "string" || payload.pageUrl.length > 32768 ||
      !/^https:\/\/channels\.weixin\.qq\.com(?::443)?\//.test(payload.pageUrl) ||
      typeof payload.title !== "string" || payload.title.length > 4096 ||
      typeof payload.author !== "string" || payload.author.length > 512 ||
      typeof payload.coverUrl !== "string" || payload.coverUrl.length > 32768) {
    api.log("wechat: live report rejected: invalid envelope");
    return null;
  }
  return payload;
}

function liveGroup(payload) {
  return "wechat:live:" + payload.roomId + ":" + payload.liveId;
}

function registerLive(payload, api) {
  if (!api.correlate) return false;
  var aliases = [liveURLAlias(payload.playbackUrl)];
  var session = liveSession(payload.playbackUrl);
  if (session && session.id === payload.liveId) aliases.push(session.alias);
  api.correlate.register({groupKey: liveGroup(payload), trackId: "live-" + payload.loadId, role: "video",
    aliases: aliases});
  return true;
}

function liveResource(payload) {
  return {
    groupKey: liveGroup(payload), kind: "stream.live",
    title: payload.title || (payload.author ? payload.author + "的直播" : "直播 " + payload.roomId),
    coverUrl: isHTTPURL(payload.coverUrl) ? payload.coverUrl : "",
    tracks: [{id: "live-primary", role: "video", executor: "ffmpeg-hls", url: payload.playbackUrl,
      mime: "video/x-flv", extension: ".flv", headers: {Origin: "https://channels.weixin.qq.com", Referer: payload.pageUrl}}],
    requiredTracks: ["video"], capabilities: ["download", "preview", "open", "copy"],
    preview: {renderer: "video", mode: "proxy", mime: "video/x-flv", trackId: "live-primary"},
    metadata: {author: payload.author, "wechat.roomId": payload.roomId, "wechat.liveId": payload.liveId,
      "stream.protocol": "flv", "stream.mode": "live", "stream.requiresFFmpeg": true},
    source: {pageUrl: payload.pageUrl}
  };
}

// The page keeps metadata locally. The host confirms successful stream headers
// through correlation IDs; no live body or native playing event is required.
function wechatLivePageBridge() {
  if (window.__resdWechatLive && window.__resdWechatLive.revision === 7) return;
  function snapshot(getRoom, getStream, loadId) {
    var room = getRoom(), stream = getStream();
    if (!room || !stream) return null;
    var description = room.objectDesc || {}, info = room.liveInfo || {}, contact = room.contact || {};
    var cover = description.liveDesc || {}, media = (description.media || [])[0] || {};
    var value = {roomId: String(room.activeRoomId || room.id || ""), liveId: String(room.liveId || info.liveId || ""),
      loadId: loadId, active: stream.active === true, playbackUrl: stream.url, pageUrl: location.href,
      title: String(description.description || "").slice(0, 4096), author: String(contact.nickname || "").slice(0, 512),
      coverUrl: String(room.coverImgUrl || cover.liveFrameUrl || cover.liveCoverUrl ||
        media.fullCoverUrl || media.coverUrl || media.fullThumbUrl || media.thumbUrl || "").slice(0, 32768)};
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.roomId) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.liveId) ||
        typeof value.playbackUrl !== "string" || value.playbackUrl.length > 32768 ||
        !/^https?:\/\/[^\s]+\.flv(?:[?#][^\s]*)?$/i.test(value.playbackUrl)) return null;
    return value;
  }
  function send(value, type, signal) {
    return Promise.resolve().then(function () {
      var bridge = window.__resdWechatBridge;
      return bridge ? bridge.send(Object.assign({event: type}, value), signal) : {ok: false};
    }).then(function (result) {
      return {ok: result.ok === true, observed: !!(result.data && result.data.observed)};
    });
  }
  function bind(player, getRoom, getStream, getVideo) {
    if (!player || player.__resdLiveBound || typeof getRoom !== "function") return;
    var loadId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    var initial, video;
    try { initial = snapshot(getRoom, getStream, loadId); video = getVideo(); } catch (error) { return; }
    if (!initial || !video) return;
    player.__resdLiveBound = true;
    var originalLoad = player.load, originalPlay = player.play, originalDestroy = player.destroy;
    var destroyed = false, started = false, loading = false, resolved = false, resolving = false;
    var controller, resolveController, resolveTimer = 0, delay = 100;
    function current(activeOnly) {
      try {
        var value = snapshot(getRoom, getStream, loadId);
        return !destroyed && value && value.roomId === initial.roomId && value.liveId === initial.liveId &&
          value.playbackUrl === initial.playbackUrl && getVideo() === video &&
          (!activeOnly || (value.active && video.isConnected)) ? value : null;
      } catch (error) { return null; }
    }
    function finish(retry) {
      resolving = false;
      if (retry && current(true) && !resolved && !resolveTimer) {
        resolveTimer = setTimeout(function () { resolveTimer = 0; resolveStream(); }, delay);
        delay = Math.min(delay * 2, 1000);
      }
    }
    function resolveStream() {
      try {
        if (!started || resolved || resolving || resolveTimer) return;
        var value = current(true);
        if (!value) return;
        resolving = true;
        resolveController = typeof AbortController === "function" ? new AbortController() : null;
        send(value, "live-stream", resolveController ? resolveController.signal : undefined).then(function (result) {
          if (result && result.ok === true && result.observed === true) resolved = true;
          finish(!!result && result.ok === true && !resolved);
        }).catch(function () { finish(true); });
      } catch (error) { finish(false); }
    }
    player.load = function () {
      if (destroyed || loading) return;
      var receiver = this, args = arguments;
      loading = true;
      var timer;
      controller = typeof AbortController === "function" ? new AbortController() : null;
      var timeout = new Promise(function (resolve) { timer = setTimeout(function () {
        if (controller) controller.abort();
        resolve(null);
      }, 1000); });
      Promise.race([send(initial, "live-ready", controller ? controller.signal : undefined).catch(function () { return null; }), timeout]).then(function () {
        clearTimeout(timer); loading = false;
        if (current(false)) { started = true; originalLoad.apply(receiver, args); resolveStream(); }
      });
    };
    // Activating a preloaded stream need not create a new network request.
    if (typeof originalPlay === "function") player.play = function () {
      resolveStream();
      return originalPlay.apply(this, arguments);
    };
    player.destroy = function () {
      destroyed = true;
      if (controller) controller.abort();
      if (resolveController) resolveController.abort();
      if (resolveTimer) clearTimeout(resolveTimer);
      return originalDestroy.apply(this, arguments);
    };
  }
  window.__resdWechatLive = {revision: 7, bind: bind};
}

function injectWechatLiveHooks(body, target, api) {
  var marker = "/* resd-wechat-stream:" + target + " */";
  if (body.indexOf(marker) >= 0) return body;
  var id = "[$A-Z_a-z][$\\w]*", changed = body;
  if (target === "live") {
    var start = body.indexOf('name:"FlvCorePlayer"');
    var section = start < 0 ? "" : body.slice(start);
    var setup = new RegExp("setup\\((" + id + "),\\{emit:" + id + "\\}\\)\\{").exec(section);
    // Resolve this build's room-store export instead of hardcoding its local alias.
    var storeImport = new RegExp("\\bby as (" + id + ")\\b").exec(body);
    var room = storeImport && new RegExp("(" + id + ")=" + storeImport[1].replace(/\$/g, "\\$") + "\\(\\)").exec(section);
    var video = new RegExp("(" + id + ")\\.value\\.addEventListener\\(\"playing\",").exec(section);
    var load = new RegExp("(" + id + ")\\.value\\.load\\(\\)").exec(section);
    if (setup && room && video && load) {
      var bind = 'window.__resdWechatLive.bind(' + load[1] + '.value,function(){return ' + room[1] +
        '},function(){return ' + setup[1] + '.stream},function(){return ' + video[1] + '.value}),';
      changed = body.slice(0, start + load.index) + bind + body.slice(start + load.index);
    }
  } else if (target === "live-preview") {
    // The preview passes its own room getter to the shared FLV player helper.
    var preview = /emits:\["preview-end","error-or-end"\],setup\(([$\w]+),[$\w]+\)\{/.exec(body);
    var call = preview && new RegExp("\\{videoRef:" + id + ",isPlaying:" + id + "\\}=(" + id + ")\\((" + id + "),(" + id + "),").exec(body.slice(preview.index));
    if (call) {
      var position = preview.index + call.index + call[0].length;
      var depth = 1, quote = "", end = position;
      for (; end < body.length && depth; end++) {
        var ch = body[end];
        if (quote) { if (ch === "\\") end++; else if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      var helper = new RegExp("function " + call[1].replace(/\$/g, "\\$") + "\\((" + id + "),(" + id + "),((?:" + id + ",){4}" + id + ")\\)\\{").exec(body);
      var helperSection = helper && body.slice(helper.index, preview.index);
      var previewVideo = helperSection && new RegExp("(" + id + ")\\.value\\.addEventListener\\(\"playing\",").exec(helperSection);
      var previewLoad = helperSection && new RegExp("(" + id + ")\\.value\\.load\\(\\)").exec(helperSection);
      if (!depth && helper && previewVideo && previewLoad) {
        changed = body.slice(0, end - 1) + ',function(){return ' + preview[1] + '.obj}' + body.slice(end - 1);
        var bindPreview = 'window.__resdWechatLive.bind(' + previewLoad[1] + '.value,__resdLiveRoom,function(){return {url:' +
          helper[1] + '.value,active:' + helper[2] + '.value}},function(){return ' + previewVideo[1] + '.value}),';
        var loadPosition = helper.index + previewLoad.index;
        changed = changed.slice(0, loadPosition) + bindPreview + changed.slice(loadPosition);
        changed = changed.slice(0, helper.index) + changed.slice(helper.index).replace(helper[0], helper[0].slice(0, -2) + ',__resdLiveRoom){');
      }
    }
  }
  if (changed === body) { api.log("wechat: " + target + " stream hook did not match"); return body; }
  api.log("wechat: " + target + " stream hook installed");
  return marker + "\n(" + wechatLivePageBridge.toString() + ")();\n" + changed;
}

// Serialized into the site's modules; this function is never run in the host VM.
function wechatPlaybackPageBridge() {
  if (window.__resdWechatPlayback && window.__resdWechatPlayback.revision === 4) return;
  var sent = new Map();
  function report(feed, playbackUrl, video, player) {
    try {
      if (!video && player && player.tech_ && typeof player.tech_.el === "function") video = player.tech_.el();
      if (player && typeof player.currentSource === "function") {
        var source = player.currentSource();
        if (source && typeof source.src === "string" && /^https?:\/\//.test(source.src)) playbackUrl = source.src;
      }
      if (!feed || feed.isImage || !video || !video.isConnected || typeof video.paused !== "boolean" || video.paused || video.ended ||
          typeof playbackUrl !== "string" || !/^https?:\/\//.test(playbackUrl)) return;
      var feedId = String(feed.id || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(feedId)) return;
      var media = feed.media;
      if (!media || !media.url) return;
      var raw = feed.objectDescMedia || {};
      var item = {
        mediaType: 4, url: media.url, urlToken: media.urlToken || "",
        decodeKey: media.decodeKey || "", fileSize: raw.url === media.url ? raw.fileSize || 0 : 0,
        coverUrl: media.fullCoverUrl || media.coverUrl || media.fullThumbUrl || media.thumbUrl || "",
        spec: (Array.isArray(media.spec) ? media.spec : []).slice(0, 64).map(function (spec) {
          return {fileFormat: spec && spec.fileFormat};
        })
      };
      var payload = {
        event: "playing", feedId: feedId, playbackUrl: playbackUrl, pageUrl: location.href,
        createtime: feed.createtime,
        objectDesc: {description: String(feed.objectDesc && feed.objectDesc.description || "").slice(0, 4096), media: [item]}
      };
      var body = JSON.stringify(payload);
      if (body.length > 65536 || sent.get(feedId) === body) return;
      sent.delete(feedId);
      sent.set(feedId, body);
      while (sent.size > 256) sent.delete(sent.keys().next().value);
      var bridge = window.__resdWechatBridge;
      if (!bridge) { sent.delete(feedId); return; }
      bridge.send(payload).then(function (result) {
        if (!result.ok && sent.get(feedId) === body) sent.delete(feedId);
      }).catch(function () {
        if (sent.get(feedId) === body) sent.delete(feedId);
      });
    } catch (error) {
      // Diagnostics must never interrupt the site's playback callbacks.
      if (feedId && sent.get(feedId) === body) sent.delete(feedId);
    }
  }
  function listener(getFeed, getURL, isActive) {
    try {
      var id = String(getFeed().id || "");
      var url = getURL();
      return function (event) {
        try {
          var feed = getFeed();
          if (isActive() && String(feed.id || "") === id && getURL() === url) report(feed, url, event.target);
        } catch (error) {}
      };
    } catch (error) { return function () {}; }
  }
  window.__resdWechatPlayback = {revision: 4, report: report, listener: listener};
}

function injectWechatHooks(body, target, api) {
  var marker = "/* resd-wechat-playing:" + target + " */";
  if (body.indexOf(marker) >= 0) return body;
  var component = target === "main" ? "VideoPlayer" : "Preview";
  var start = body.indexOf('__name:"' + component + '"');
  if (start < 0) {
    api.log("wechat: " + target + " player component did not match");
    return body;
  }
  var end = body.indexOf('__name:"', start + 8);
  if (end < 0) end = body.length;
  var section = body.slice(start, end);
  var identifier = "[$A-Z_a-z][$\\w]*";
  var setup = new RegExp("setup\\((" + identifier + "),\\{emit:" + identifier + "\\}\\)\\{").exec(section);
  var changed = section;
  if (setup && target === "main") {
    var eventList = '["loadstart","loadedmetadata","durationchange","progress","canplaythrough","play","playing","timeupdate","waiting","pause","seeking","ratechange","ended"]';
    var eventStart = section.indexOf(eventList + ".forEach(");
    var url = new RegExp("\\b(" + identifier + ")=" + identifier + "\\(\\(\\)=>\\{(?:var [^;]+;)?const\\{feed:").exec(section);
    var video = new RegExp("\\.video\\((" + identifier + ")\\.value,").exec(section);
    if (eventStart >= 0 && url && video) {
      var events = section.slice(eventStart);
      var loop = new RegExp("\\.forEach\\((" + identifier + ")=>\\{").exec(events);
      if (loop) {
        var event = loop[1].replace(/\$/g, "\\$");
        var player = new RegExp("\\(" + identifier + "=(" + identifier + ")\\.value\\)==null\\|\\|" + identifier + "\\.on\\(" + event + ",").exec(events);
        var forward = new RegExp("(" + identifier + ")\\(" + event + "\\)\\)\\}\\)\\}\\)").exec(events);
        if (forward && player) {
          var call = forward[1] + "(" + loop[1] + ")";
          var position = eventStart + forward.index;
          var report = '(' + loop[1] + '==="playing"&&' + setup[1] + '.active&&window.__resdWechatPlayback.report(' +
            setup[1] + '.feed,' + url[1] + '.value.url,' + video[1] + '.value,' + player[1] + '.value),' + call + ')';
          changed = section.slice(0, position) + report + section.slice(position + call.length);
        }
      }
    }
  } else if (setup && target === "preview") {
    var preview = new RegExp("(" + identifier + ")\\.value\\?[^?]{0,80}\\{key:0,src:(" + identifier + ")\\.value,url:\\2\\.value,seed:").exec(section);
    var handlers = /onPlay:[$\w]+,onPause:[$\w]+,onSeeking:[$\w]+,onLoadeddata:[$\w]+,onNetworkError:[$\w]+/.exec(section);
    var props = '["src","url","seed","duration","keepalive","feed-id","class","ml-extends","style"]';
    if (preview && handlers && section.indexOf(props) >= 0) {
      var listener = 'onPlaying:window.__resdWechatPlayback.listener(function(){return ' + setup[1] + '.feed},' +
        'function(){return ' + preview[2] + '.value},function(){return ' + preview[1] + '.value&&!'+ setup[1] + '.disablePlay}),';
      changed = section.slice(0, handlers.index) + listener + section.slice(handlers.index);
      changed = changed.replace(props, props.slice(0, -1) + ',"onPlaying"]');
    }
  }
  if (changed === section) {
    api.log("wechat: " + target + " playing hook did not match");
    return body;
  }
  api.log("wechat: " + target + " playing hook installed");
  return marker + "\n(" + wechatPlaybackPageBridge.toString() + ")();\n" + body.slice(0, start) + changed + body.slice(end);
}

function playbackReport(payload, pageUrl, api) {
  var resources = mediaResources(payload, pageUrl, api);
  if (api.correlate) resources.forEach(function (resource) {
    api.correlate.register({groupKey: resource.groupKey, trackId: "video-primary", role: "video", aliases: [resource.tracks[0].url]});
  });
  return resources;
}

function liveReport(payload, type, api) {
  var live = livePayload(payload, type, api);
  var alias = live && liveURLAlias(live.playbackUrl);
  var matches = function (ref) { return ref.groupKey === liveGroup(live) && ref.trackId === "live-" + live.loadId; };
  var claimed = live && api.correlate && (api.correlate.find(alias) || []).some(matches);
  var accepted = !!live && (type === "live-ready" || (live.active && claimed)) && registerLive(live, api);
  var observed = accepted && type === "live-stream" && (api.correlate.find("wechat:live-response:" + alias) || []).some(matches);
  if (type === "live-ready" || observed || !accepted) api.log("wechat: " + type + (accepted ? " accepted" : " rejected"));
  return {ok: !!accepted, data: {observed: !!observed}, resources: observed ? [liveResource(live)] : []};
}

function onPageMessage(message, context, api) {
  if (!context || context.scriptId !== "wechat-bridge" ||
      !/^https:\/\/channels\.weixin\.qq\.com(?::443)?$/i.test(context.origin) ||
      !message || typeof message !== "object" || Array.isArray(message)) return {ok: false};
  var body = JSON.stringify(message);
  if (body.length > 65536) return {ok: false};
  if (message.event === "live-ready" || message.event === "live-stream") return liveReport(message, message.event, api);
  if (message.event === "playing") {
    var resources = playbackReport(message, context.pageUrl, api);
    return {ok: resources.length > 0, resources: resources};
  }
  return {ok: false};
}

function onObservation(observation, api) {
  var request = observation.request;
  var response = observation.response;
  var cacheVersion = api.pluginVersion + "-" + WECHAT_INJECTION_CACHE_REVISION;

  if (observation.stage !== "response" || !response || (response.statusCode !== 200 && response.statusCode !== 206 && response.statusCode !== 304)) {
    return {decision: "continue"};
  }

  var host = (request.host || "").toLowerCase().replace(/:\d+$/, "");
  var path = request.path;
  var contentType = (response.contentType || "").toLowerCase();
  var liveAlias = liveURLAlias(request.url);
  if (liveAlias) {
    var liveRefs = api.correlate ? (api.correlate.find(liveAlias) || []).filter(function (ref) {
      return ref.role === "video" && /^live-[A-Za-z0-9_-]{1,64}$/.test(ref.trackId);
    }) : [];
    var streamMIME = /^(?:video\/(?:x-flv|flv)|audio\/video|(?:application|binary)\/octet-stream)(?:;|$)/.test(contentType);
    var session = liveSession(request.url);
    var knownSession = session && api.correlate && (api.correlate.find(session.alias) || []).some(function (ref) {
      return ref.role === "video" && /^live-[A-Za-z0-9_-]{1,64}$/.test(ref.trackId) && endsWith(ref.groupKey, ":" + session.id);
    });
    if (liveRefs.length && response.statusCode !== 304 && streamMIME) {
      liveRefs.forEach(function (ref) {
        api.correlate.register({groupKey: ref.groupKey, trackId: ref.trackId, role: ref.role,
          aliases: ["wechat:live-response:" + liveAlias]});
      });
      api.log("wechat: live stream response matched");
    }
    // Home previews can arrive before any room metadata, and can select a
    // different quality than the detail player. Claim only recognizable TRTC
    // streams with WeChat page context, not unrelated traffic on the CDN.
    return {decision: "continue", handled: liveRefs.length > 0 ||
      !!(session && streamMIME && (knownSession || isWechatPageRequest(request)))};
  }
  if (response.statusCode === 304) return {decision: "continue"};
  var mediaResponse = contentType.indexOf("video/") === 0 ||
    (/^(application|binary)\/octet-stream(?:;|$)/.test(contentType) && /(?:\/20302\/|\/stodownload|\.mp4$)/i.test(path));
  if (mediaResponse && (host === "qq.com" || endsWith(host, ".qq.com"))) {
    var origin = firstHeader(request.headers, "Origin");
    var referer = firstHeader(request.headers, "Referer");
    var channelContext = /^https:\/\/channels\.weixin\.qq\.com(?::443)?(?:\/|$)/i.test(origin) ||
      /^https:\/\/channels\.weixin\.qq\.com(?::443)?\//i.test(referer);
    var known = api.correlate && (api.correlate.find(request.url) || []).length > 0;
    // Finder's headerless media traffic is also used by the WeChat desktop
    // player. Keep its existing suppression when no page context is supplied.
    var headerlessFinder = host === "finder.video.qq.com" && !origin && !referer;
    return {decision: "continue", handled: channelContext || known || headerlessFinder};
  }

  if (response.truncated) return {decision: "continue"};
  var body = response.body || "";
  var changed = false;
  var suffix = ".js?v=" + cacheVersion + "\"";
  if (host === "channels.weixin.qq.com" && path.indexOf("/web/pages/") === 0) {
    var pageBody = body.split(".js\"").join(suffix);
    changed = changed || pageBody !== body;
    body = pageBody;
  }

  if (endsWith(host, "res.wx.qq.com")) {
    if (endsWith(request.url, ".js?v=" + cacheVersion)) {
      var dependencyBody = body.split(".js\"").join(suffix);
      changed = changed || dependencyBody !== body;
      body = dependencyBody;
    }
    var target = path.indexOf("/FinderHome.publish") >= 0 ? "main" :
      path.indexOf("/AuthorObjectCard.vue_vue_type_style_index_1_lang.publish") >= 0 ? "preview" : "";
    if (target && !response.truncated) {
      var injected = injectWechatHooks(body, target, api);
      changed = changed || injected !== body;
      body = injected;
    }
    var liveTarget = path.indexOf("/useViewportProbe.publish") >= 0 ? "live" :
      path.indexOf("/LiveStatBox.publish") >= 0 ? "live-preview" : "";
    if (liveTarget) {
      var liveInjected = injectWechatLiveHooks(body, liveTarget, api);
      changed = changed || liveInjected !== body;
      body = liveInjected;
    }
  }

  return changed ? {decision: "continue", patch: {body: body}} : {decision: "continue"};
}

function createDownloadPlan(input) {
  var resource = input.resource;
  var options = input.options || {};
  if (resource.kind === "stream.live") {
    var liveTrack = resource.tracks[0];
    return {inputs: [{id: liveTrack.id, executor: "ffmpeg-hls", url: liveTrack.url,
      headers: liveTrack.headers || {}, extension: liveTrack.extension || ".flv"}],
      output: {input: liveTrack.id, extension: liveTrack.extension || ".flv"}};
  }
  var settings = options.settings || {};
  var qualityModes = {"default": 0, "ultra": 1, "high": 2, "medium": 3, "low": 4};
  var quality = qualityModes[settings.quality] || 0;
  var primaryTrack = resource.tracks && resource.tracks.length ? resource.tracks[0] : {};
  var rawUrl = primaryTrack.url;
  var metadata = resource.metadata || {};
  var formats = metadata["wechat.fileFormats"] || [];

  if (quality === 1 && rawUrl.indexOf("encfilekey=") >= 0 && rawUrl.indexOf("token=") >= 0) {
    var encfilekey = queryValue(rawUrl, "encfilekey");
    var token = queryValue(rawUrl, "token");
    rawUrl = rawUrl.split("?")[0] + "?encfilekey=" + encodeURIComponent(encfilekey) + "&token=" + encodeURIComponent(token);
  } else if (quality > 1 && formats.length) {
    var choices = [formats[0], formats[Math.floor(formats.length / 2)], formats[formats.length - 1]];
    var choiceIndex = quality - 2;
    if (choiceIndex >= 0 && choiceIndex < choices.length) {
      rawUrl = setQueryValue(rawUrl, "X-snsvideoflag", choices[choiceIndex]);
    }
  }

  return {
    inputs: [{
      id: primaryTrack.id || "primary",
      executor: "http-file",
      url: rawUrl,
      headers: primaryTrack.headers || {},
      extension: primaryTrack.extension || "",
      processors: primaryTrack.processors || []
    }],
    output: {
      input: primaryTrack.id || "primary",
      extension: primaryTrack.extension || ""
    }
  };
}

function setQueryValue(rawUrl, name, value) {
  var fragmentIndex = rawUrl.indexOf("#");
  var fragment = fragmentIndex < 0 ? "" : rawUrl.slice(fragmentIndex);
  var base = fragmentIndex < 0 ? rawUrl : rawUrl.slice(0, fragmentIndex);
  var queryIndex = base.indexOf("?");
  var query = queryIndex < 0 ? [] : base.slice(queryIndex + 1).split("&");
  var kept = query.filter(function (part) { return part && part.split("=")[0] !== name; });
  kept.push(name + "=" + encodeURIComponent(value));
  return (queryIndex < 0 ? base : base.slice(0, queryIndex)) + "?" + kept.join("&") + fragment;
}
