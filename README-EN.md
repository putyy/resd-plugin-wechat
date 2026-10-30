# resd-plugin-wechat

[中文](README.md) | [English](README-EN.md)

A WeChat Channels resource plugin for [res-downloader](https://github.com/putyy/res-downloader) that captures videos, image posts, and the current live stream and processes video files that require decryption.

## Features

- Offers Playback capture (default), Detail capture, and Full capture.
- Playback capture collects videos when the main player or card preview actually plays. When the active image post starts playing, all its images are captured as separate resources.
- Captures the selected FLV live stream once its connection succeeds, with the room title, anchor name, and cover. Playback need not have started; inactive preloaded streams produce no resources.
- Lets you select from the available download qualities.
- Processes encrypted videos using the WASM module bundled with the plugin.
- Supports previewing, downloading, opening, copying, and decrypting local video files.

## Installation

Once published, the plugin can be installed from Plugin Management in `res-downloader`. You can also download the source ZIP for the desired version and import it using the option to install from an archive.

## Settings

- **Capture mode**: Playback capture waits for video or image-post playback. Detail capture collects media when post details arrive, without requiring playback. Full capture combines page media objects, details, and playback; it may include recommended or preloaded posts but does not turn pages automatically. Live capture is independent of this setting. Reopen Channels after switching.
- **Download quality**: Ordinary videos offer Default, High, Medium, and Low. High ranks reported variants by resolution, then bitrate, including available HDR variants; entries without ranking data retain their reported order. Displayed sizes retain the interface value and may differ from downloaded sizes. Images and live streams retain their current URLs.
- **Enable logging**: Disabled by default. Logs player injection results and data validation failures.

### Supported Template Variables

| Variable | Description |
| --- | --- |
| `{{title}}` | Post or live room title |
| `{{created_at}}` | Post creation date in the local time zone, using `20060102` by default. Custom formats such as `{{created_at:2006-01-02}}` are supported. Empty if no valid timestamp is available. |
| `{{ext}}` | Downloaded file extension without the leading dot |
| `{{id}}` | Resource ID in the application |
| `{{kind}}` | Resource kind: `media.video`, `media.image`, or `stream.live` |
| `{{plugin}}` | Plugin ID: `official.wechat` |
| `{{host}}` | Main domain of the download URL |
| `{{track}}` | Download track ID: `video-primary`, `image-primary`, or `live-primary` |
| `{{date}}` | Local date when the save path is generated, using `20060102` by default |
| `{{time}}` | Local time when the save path is generated, using `150405` by default |

## Notes

- Checks res-downloader once when the player scripts load. A failed check skips reporting for that document without interrupting playback. Keep the proxy enabled during capture. Reopen Channels after updating the plugin; clear the WeChat browser cache if it still uses old scripts.
- Playback capture includes homepage autoplay and hover previews once they actually play. Image-post capture does not depend on background music and also supports posts without music.
- Live recording requires FFmpeg configured in the application settings. Use Stop and Save to finish recording. Replay and recapture a stream if its URL expires.
- Home previews and detail views of the same live room merge into one resource, shown once its metadata is available.

## Development and Validation

Run these commands from the `res-downloader` project root:

```bash
go run main.go plugin lint ./plugins/resd-plugin-wechat
for fixture in ./plugins/resd-plugin-wechat/fixtures/*.json; do
  go run main.go plugin replay ./plugins/resd-plugin-wechat "$fixture"
done
node --test ./plugins/resd-plugin-wechat/tests/creation-time.test.js
node --test ./plugins/resd-plugin-wechat/tests/injection-cache.test.js
node --test ./plugins/resd-plugin-wechat/tests/playback.test.js
node --test ./plugins/resd-plugin-wechat/tests/live.test.js
node --test ./plugins/resd-plugin-wechat/tests/request.test.js
go run main.go plugin pack ./plugins/resd-plugin-wechat
```

Sanitized fixtures and tests cover video capture, live stream correlation, page injection, resource deduplication and invalid data handling.

Development note: `fixtures/` contains request- and response-hook CLI replay inputs. `tests/fixtures/` contains resource-report contract cases covered by `tests/request.test.js` and `tests/live.test.js`.

## License

[MIT](LICENSE)
