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

## YouTube

**安装地址**

```
https://cdn.jsdelivr.net/gh/ccvxxcg0-wq/musicfree-plugins@main/youtube-plugin.js
```

备用镜像：`https://fastly.jsdelivr.net/gh/ccvxxcg0-wq/musicfree-plugins@main/youtube-plugin.js`

**不需要配置任何变量。** 装完就能搜、就能放全长音频。

**能力**

- 搜索：关键词搜索，支持翻页
- 播放：解析 `googlevideo.com` 直链，**全长音频**（不是 30 秒试听）
- 音质：低 m4a 50k / 标准 m4a 130k / 高 m4a 首选 / 超高 最高码率（通常 opus 136k）
- 单曲信息：标题、频道、时长、封面、播放量
- 歌词：lrclib.net，按标题+歌手+时长核对，配不上就留空
- 导入：`youtube.com/watch`、`youtu.be`、`music.youtube.com`、`shorts`、`live`、纯 11 位 ID

不做榜单 / 歌单 / 歌手页 —— 这些端点需要额外鉴权，稳定性差。

**三条硬事实**

1. 国内必须自备代理，`youtube.com` 直连不通。
2. 直链绑定请求方 IP，换网络打开即 403；插件在手机上跑所以能播，复制到电脑不行。
3. 直链约 6 小时过期；插件不缓存，每次播放重新解析。

**为什么用 ANDROID 客户端**

2025 年后 YouTube 对 `youtubei/v1/player` 加了 bot 校验。官方示例插件用的 `ANDROID_MUSIC 6.14.50` 已彻底失效（`LOGIN_REQUIRED`，连 `streamingData` 都不返回）。实测对照（2026-11-23，机房出口 IP，同一视频）：

| 客户端 | 结果 |
|---|---|
| `ANDROID 20.03.02` | 8/8 成功，全部裸 url |
| `ANDROID_VR 1.62.27` | 1/8 成功 |
| `WEB` / `MWEB` / `TVHTML5` | UNPLAYABLE |
| `WEB_EMBEDDED_PLAYER` | 视频不可用 |
| `IOS 19.45.4` | HTTP 400 |
| `ANDROID_MUSIC 6.14.50` | LOGIN_REQUIRED |

主客户端 ANDROID，VR 兜底，两个都失败才报错。

**报错对照**

| 现象 | 原因 |
|---|---|
| `YouTube 拒绝解析：Sign in to confirm you're not a bot` | 出口 IP 是机房 IP，换住宅/移动线路 |
| 搜索有结果但播不出 | 代理不稳，换节点重试 |
| 没有歌词 | LRCLIB 无此曲，正常 |

## 版本

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1.0 | 2026-11-23 | YouTube 插件：搜索（含翻页）/ 全长音频 / 单曲信息 / LRCLIB 歌词 / 链接导入；离线 63 项 + 联机 10 项通过 |
| 0.1.1 | 2026-11-23 | Spotify 插件填入 `srcUrl`，支持 MusicFree 内「检查更新」 |
| 0.1.0 | 2026-11-23 | Spotify 插件首版：13 个方法，离线测试 56 项通过 |

## 许可

AGPL-3.0（与 MusicFree 保持一致）。仅供学习参考，不提供任何破解或绕过付费的内容。