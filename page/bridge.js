// Share one initialization probe between every video and live player in this document.
if (!window.__resdWechatBridge) {
  var ready = pageApi.probe();
  var enabled = true;
  window.__resdWechatBridge = Object.freeze({
    send: function (message, signal) {
      return ready.then(function (available) {
        if (!available || !enabled || (signal && signal.aborted)) return {ok: false};
        return pageApi.send(message).then(function (result) {
          if (!result || result.ok !== true) enabled = false;
          return result || {ok: false};
        });
      }).catch(function () { enabled = false; return {ok: false}; });
    }
  });
}
