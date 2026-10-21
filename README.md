# resd-plugin-wechat

[中文](README.md) | [English](README-EN.md)

[res-downloader](https://github.com/putyy/res-downloader) 的微信视频号资源插件，用于捕获正在播放的视频及当前直播流，并处理需要解密的视频文件。

## 功能

- 在主播放器或卡片预览实际开始播放后捕获对应视频；预加载和仅打开详情不会触发捕获。
- 当前选中的 FLV 直播流连接成功后捕获直播间标题、主播和封面，不必等待画面开始播放；未激活的预加载流不生成资源。
- 支持按可用清晰度选择下载画质。
- 使用插件自带的 WASM 处理加密视频。
- 支持预览、下载、打开、复制和解密本地视频。

## 安装

发布后可在 `res-downloader` 的“插件管理”页面安装。也可以下载对应版本的源码 ZIP，通过“从压缩包安装”导入。

## 设置

- `下载画质`：普通视频可按实际提供的清晰度选择默认、超清、高清、中等或低清；直播使用当前播放地址。
- `启用日志`：默认关闭，开启后记录播放器注入结果及数据校验失败原因。

### 支持的魔法变量

| 变量 | 说明 |
| --- | --- |
| `{{title}}` | 作品或直播间标题 |
| `{{created_at}}` | 作品创建日期，按本地时区格式化，默认 `20060102`；支持 `{{created_at:2006-01-02}}` 等格式，未提供有效时间时为空 |
| `{{ext}}` | 下载文件扩展名，不含开头的点 |
| `{{id}}` | 应用中的资源 ID |
| `{{kind}}` | 资源类型：`media.video` 或 `stream.live` |
| `{{plugin}}` | 插件 ID：`official.wechat` |
| `{{host}}` | 下载地址的主域名 |
| `{{track}}` | 下载轨道 ID：`video-primary` 或 `live-primary` |
| `{{date}}` | 生成保存路径时的本地日期，默认 `20060102` |
| `{{time}}` | 生成保存路径时的本地时间，默认 `150405` |

## 注意事项

- 页面初始化时探测一次 res-downloader；探测失败时本页不上报，网页播放不受影响。修改插件或宿主后刷新页面。
- 首页自动播放和鼠标悬停后真正播放的预览视频也会被捕获；图文作品不触发视频捕获。
- 直播录制需要在应用设置中配置 FFmpeg；结束时使用“停止并保存”。直播链接过期后需重新播放并抓取。
- 首页预览和详情中的同一直播合并为一条资源，取得直播信息后显示。

## 开发与校验

在 `res-downloader` 项目根目录执行：

```bash
go run main.go plugin lint ./plugins/resd-plugin-wechat
for fixture in ./plugins/resd-plugin-wechat/fixtures/*.json; do
  go run main.go plugin replay ./plugins/resd-plugin-wechat "$fixture"
done
node --test ./plugins/resd-plugin-wechat/tests/creation-time.test.js
node --test ./plugins/resd-plugin-wechat/tests/injection-cache.test.js
node --test ./plugins/resd-plugin-wechat/tests/playback.test.js
node --test ./plugins/resd-plugin-wechat/tests/live.test.js
node --test ./plugins/resd-plugin-wechat/tests/bridge.test.js
go run main.go plugin pack ./plugins/resd-plugin-wechat
```

脱敏 fixture 和测试覆盖视频捕获、直播关联、页面注入、资源去重及无效数据处理。

开发说明：`fixtures/` 用于响应钩子的 CLI 回放；`tests/fixtures/` 用于消息桥契约测试，由 `tests/bridge.test.js` 和 `tests/live.test.js` 覆盖。

## License

[MIT](LICENSE)
