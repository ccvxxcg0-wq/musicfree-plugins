# musicfree-plugins

给 [MusicFree](https://github.com/maotoumao/MusicFree) 用的第三方插件源。走 jsDelivr 分发，安装地址长期有效。

## Spotify

**安装地址**

```
https://cdn.jsdelivr.net/gh/ccvxxcg0-wq/musicfree-plugins@main/spotify-plugin.js
```

MusicFree → 插件设置 → 从网络安装 → 粘贴上面的地址。

**使用前必须配置两个变量**（插件的「设置用户变量」）：

| 变量 | 说明 |
|---|---|
| `clientId` | Spotify Developer Dashboard 里 App 的 Client ID |
| `clientSecret` | 同一个 App 的 Client Secret（填成密码型，只存本机） |
| `market` | 可选，默认 `US`。填 `CN` 能搜到的曲目最少 |
| `resolverUrl` | 可选，外部解析服务地址，用来取全长音频 |

凭据申请：<https://developer.spotify.com/dashboard> → Create app → 勾选 Web API → 复制 ID/Secret。插件用 Client Credentials 流程，不需要登录你的 Spotify 账号。

**能力**

- 搜索：单曲 / 专辑 / 歌手 / 歌单
- 浏览：专辑曲目、歌手作品与热门曲、歌单曲目、新发行（专辑 / 单曲）
- 推荐：Spotify 官方分类（Pop / Rock / Jazz…）下的歌单
- 歌词：lrclib.net，带时间轴
- 导入：`open.spotify.com/track|album|playlist|artist/ID`、`spotify:kind:ID`、纯 22 位 ID
- 评论：无（Spotify 没有公开评论 API）

**播放**

Spotify 正式音频是 Widevine DRM 加密流，纯 JS 播放器解不开。插件只有两条取音频的路径：

1. `preview_url` — 官方 30 秒试听 mp3，无 DRM
2. `resolverUrl` — 你配的解析服务，把元数据映射到其他可播放来源

2024-11 之后新建的 Spotify App 通常不再返回 `preview_url`（老 App 还有）。两条都拿不到时插件明确报错，不会静默卡住。

`resolverUrl` 协议：

```
GET {resolverUrl}?spotifyId=<id>&isrc=<isrc>&title=<t>&artist=<a>&album=<al>&duration=<sec>
```

返回任一种即可：

```json
{ "url": "https://...", "headers": { "Referer": "..." } }
```

```json
{ "url": "https://..." }
```

或纯文本 URL 一行。

## 版本

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1.1 | 2026-11-23 | 填入 `srcUrl`，支持 MusicFree 内「检查更新」 |
| 0.1.0 | 2026-11-23 | 首版：13 个方法，离线测试 56 项通过 |

## 许可

AGPL-3.0（与 MusicFree 保持一致）。仅供学习参考，不提供任何破解或绕过付费的内容。