# resd-plugin-wechat

[中文](README.md) | [English](README-EN.md)

A WeChat Channels resource plugin for [res-downloader](https://github.com/putyy/res-downloader) that captures playing videos and the current live stream and processes video files that require decryption.

## Features

- Captures a video when the main player or card preview starts playing. Preloads and detail requests alone do not trigger capture.
- Captures the selected FLV live stream once its connection succeeds, with the room title, anchor name, and cover. Playback need not have started; inactive preloaded streams produce no resources.
- Lets you select from the available download qualities.
- Processes encrypted videos using the WASM module bundled with the plugin.
- Supports previewing, downloading, opening, copying, and decrypting local video files.

## Installation

Once published, the plugin can be installed from Plugin Management in `res-downloader`. You can also download the source ZIP for the desired version and import it using the option to install from an archive.

## Settings

- **Download quality**: Select Default, Ultra, High, Medium, or Low for ordinary videos, depending on the available qualities. Live streams retain the current playback URL.
- **Enable logging**: Disabled by default. Logs player injection results and data validation failures.

### Supported Template Variables

| Variable | Description |
| --- | --- |
| `{{title}}` | Post or live room title |
| `{{created_at}}` | Post creation date in the local time zone, using `20060102` by default. Custom formats such as `{{created_at:2006-01-02}}` are supported. Empty if no valid timestamp is available. |
| `{{ext}}` | Downloaded file extension without the leading dot |
| `{{id}}` | Resource ID in the application |
| `{{kind}}` | Resource kind: `media.video` or `stream.live` |
| `{{plugin}}` | Plugin ID: `official.wechat` |
| `{{host}}` | Main domain of the download URL |
| `{{track}}` | Download track ID: `video-primary` or `live-primary` |
| `{{date}}` | Local date when the save path is generated, using `20060102` by default |
| `{{time}}` | Local time when the save path is generated, using `150405` by default |

## Notes

- Checks res-downloader once when the player scripts load. A failed check skips reporting for that document without interrupting playback. Keep the proxy enabled during capture. Reopen Channels after updating the plugin; clear the WeChat browser cache if it still uses old scripts.
- Homepage autoplay and hover previews are captured once they actually play. Image posts do not trigger video capture.
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
