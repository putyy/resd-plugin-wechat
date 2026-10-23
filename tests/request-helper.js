function report(plugin, message, api, overrides = {}) {
  const address = "https://channels.weixin.qq.com/res-downloader/wechat";
  const request = {method: "POST", url: address, host: "channels.weixin.qq.com", path: "/res-downloader/wechat",
    headers: {"Content-Type": ["application/json"], Origin: ["https://channels.weixin.qq.com"]},
    body: JSON.stringify(message), ...overrides};
  const result = plugin.onObservation({stage: "request", request}, api);
  return {...JSON.parse(result.syntheticResponse.body), resources: result.resources || [],
    statusCode: result.syntheticResponse.statusCode, decision: result.decision};
}
module.exports = {report};
