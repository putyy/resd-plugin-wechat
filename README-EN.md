# resd-plugin-wechat

[中文](README.md) | [English](README-EN.md)

A WeChat Channels resource plugin for `res-downloader` that detects videos and images and processes video files that require decryption.

## Features

- Captures video and image resources from WeChat Channels pages.
- Lets you select from the available download qualities.
- Processes encrypted videos using the WASM module bundled with the plugin.
- Supports previewing, downloading, opening, copying, and decrypting local video files.

## Installation

Once published, the plugin can be installed from Plugin Management in `res-downloader`. You can also download the source ZIP for the desired version and import it using the option to install from an archive.

## Settings

- **Full capture mode**: Captures resources from page media objects and detail data. When disabled, captures only from detail data.
- **Download quality**: Select Default, Ultra, High, Medium, or Low, depending on the qualities actually available for the resource.
- **Enable logging**: Disabled by default. Reserved as a general debugging switch; the plugin currently does not emit debug logs.

### Supported Template Variables

| Variable | Description |
| --- | --- |
| `{{title}}` | Post title |
| `{{created_at}}` | Post creation date in the local time zone, using `20060102` by default. Custom formats such as `{{created_at:2006-01-02}}` are supported. Empty if no valid timestamp is available. |
| `{{ext}}` | Downloaded file extension without the leading dot |
| `{{id}}` | Resource ID in the application |
| `{{kind}}` | Resource kind: `media.video` or `media.image` |
| `{{plugin}}` | Plugin ID: `official.wechat` |
| `{{host}}` | Main domain of the download URL |
| `{{track}}` | Download track ID: `video-primary` or `image-primary` |
| `{{date}}` | Local date when the save path is generated, using `20060102` by default |
| `{{time}}` | Local time when the save path is generated, using `150405` by default |

## Development and Validation

Run these commands from the `res-downloader` project root:

```bash
go run main.go plugin lint ./plugins/resd-plugin-wechat
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/video.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/image.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/detail-dedupe.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/inject-hook.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/media-created-at-hook.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/media-created-at.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/detail-hook.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/detail-created-at.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/finder-video.json
go run main.go plugin replay ./plugins/resd-plugin-wechat ./plugins/resd-plugin-wechat/fixtures/full-created-at.json
node --test ./plugins/resd-plugin-wechat/tests/creation-time.test.js
node --test ./plugins/resd-plugin-wechat/tests/injection-cache.test.js
go run main.go plugin pack ./plugins/resd-plugin-wechat
```

Fixtures contain only sanitized, fictional data and example URLs.

## License

[MIT](LICENSE)
