/*
 * MusicFree 插件：YouTube
 * ---------------------------------------------------------------------------
 * 平台      : YouTube（youtube.com / music.youtube.com / youtu.be）
 * 能力      : 搜索 · 播放（全长音频）· 单曲信息 · 歌词（LRCLIB）· 链接导入
 * 版本      : 0.1.0
 * 依赖      : axios（App 白名单内置）
 *
 * 为什么用 ANDROID 客户端？
 *   YouTube 在 2025 年后对 youtubei/v1/player 加了 bot 校验。实测（2026-11-23，
 *   机房出口 IP）：WEB / MWEB / TVHTML5 / WEB_EMBEDDED / IOS / ANDROID_MUSIC /
 *   ANDROID_VR 大多返回 LOGIN_REQUIRED 或 UNPLAYABLE，只有 ANDROID 20.03.02 连续
 *   8/8 返回 status=OK，且 adaptiveFormats 里全是裸 url（无 signatureCipher）。
 *   所以主客户端是 ANDROID，ANDROID_VR 作为第二顺位兜底。
 *
 * 两条硬事实（不是配置问题，改不了）：
 *   1) 返回的音频 URL 绑定「请求它的那个 IP」。插件在手机上跑、手机自己请求，
 *      所以能播；把 URL 拷到别的网络就 403。
 *   2) URL 有效期约 6 小时，过期需重新解析 —— 本插件每次都现取，不缓存。
 * ---------------------------------------------------------------------------
 */

const AXIOS = require("axios");

/* App 全局把 axios.defaults.timeout 压到 2000ms，player 请求在移动网络下会超时 */
try {
  AXIOS.defaults.timeout = 20000;
} catch (e) {
  /* ignore */
}

const API = "https://www.youtube.com/youtubei/v1/";

const CLIENT_ANDROID = {
  clientName: "ANDROID",
  clientVersion: "20.03.02",
  deviceMake: "Google",
  deviceModel: "Pixel 8",
  osName: "Android",
  osVersion: "14",
  platform: "MOBILE",
  hl: "en",
  gl: "US",
  androidSdkVersion: 34,
};
const UA_ANDROID =
  "com.google.android.youtube/20.03.02 (Linux; U; Android 14; en_US; Pixel 8 Build/UQ1A.240105.002) gzip";

const CLIENT_VR = {
  clientName: "ANDROID_VR",
  clientVersion: "1.62.27",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  osName: "Android",
  osVersion: "12L",
  platform: "MOBILE",
  hl: "en",
  gl: "US",
};
const UA_VR =
  "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip";

const CLIENT_WEB = {
  clientName: "WEB",
  clientVersion: "2.20241126.01.00",
  hl: "en",
  gl: "US",
  platform: "DESKTOP",
};
const UA_WEB =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let _visitorData = "";

/* ------------------------------------------------------------ 基础请求 */

async function ytApi(path, body, client, ua) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": ua,
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
  };
  if (_visitorData) headers["X-Goog-Visitor-Id"] = _visitorData;

  const payload = { context: { client: client } };
  Object.keys(body || {}).forEach((k) => {
    payload[k] = body[k];
  });

  const res = await AXIOS.post(API + path + "?prettyPrint=false", payload, {
    headers,
    timeout: 20000,
  });
  const data = res && res.data;
  if (data && data.responseContext && data.responseContext.visitorData) {
    _visitorData = data.responseContext.visitorData;
  }
  return data;
}

/* ------------------------------------------------------------ 工具 */

function txt(o) {
  if (!o) return "";
  if (typeof o === "string") return o;
  if (o.simpleText) return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map((r) => r.text || "").join("");
  return "";
}

function bestThumb(thumbnails) {
  if (!thumbnails || !thumbnails.length) return undefined;
  const sorted = thumbnails.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0] && sorted[0].url;
}

function durationToSec(s) {
  if (!s) return undefined;
  const parts = String(s).split(":").map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
  if (!parts.length) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function secToDur(sec) {
  if (!sec && sec !== 0) return undefined;
  const n = parseInt(sec, 10);
  if (isNaN(n)) return undefined;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0
    ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0")
    : m + ":" + String(s).padStart(2, "0");
}

/* 归一化：小写、去掉标点与多余空格，便于标题/歌手比对 */
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[!-/:-@[-`{-~]/g, " ")
    .replace(/[，。、；：！？·—“”‘’（）《》【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDur(s) {
  const sec = durationToSec(s);
  return sec || 0;
}

/* 从各种链接里抠出 11 位 videoId */
function parseVideoId(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /\/v\/([A-Za-z0-9_-]{11})/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------ 映射 */

function toMusic(vr) {
  if (!vr || !vr.videoId) return null;
  const title = txt(vr.title) || "未知视频";
  const artist = txt(vr.ownerText) || txt(vr.longBylineText) || "YouTube";
  return {
    id: vr.videoId,
    title: title,
    artist: artist,
    album: undefined,
    artwork: bestThumb((vr.thumbnail && vr.thumbnail.thumbnails) || []),
    duration: secToDur(durationToSec(txt(vr.lengthText))),
    /* 播放时直接用，避免二次请求 */
    videoId: vr.videoId,
    rawTitle: title,
    rawArtist: artist,
    viewCount: txt(vr.viewCountText),
    publishedAt: txt(vr.publishedTimeText),
    live: !!vr.badges && JSON.stringify(vr.badges).indexOf("LIVE") >= 0,
  };
}

/* ------------------------------------------------------------ 搜索 */

const _searchCache = { key: "", tokens: [] };

function collectSearchItems(json) {
  const out = [];
  let nextToken = "";

  function scan(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(scan);
      return;
    }
    if (typeof node !== "object") return;
    if (node.videoRenderer) {
      const m = toMusic(node.videoRenderer);
      if (m) out.push(m);
    }
    if (node.continuationItemRenderer) {
      const ep =
        node.continuationItemRenderer.continuationEndpoint ||
        (node.continuationItemRenderer.button && node.continuationItemRenderer.button.buttonRenderer);
      const tok =
        (ep && ep.continuationCommand && ep.continuationCommand.token) ||
        (node.continuationItemRenderer.continuationEndpoint || {}).token;
      if (tok) nextToken = tok;
    }
    Object.keys(node).forEach((k) => {
      scan(node[k]);
    });
  }

  scan(json);
  return { items: out, token: nextToken };
}

async function search(query, page, type) {
  const p = page && page > 0 ? page : 1;
  const key = String(query || "");
  let json;

  if (p === 1 || _searchCache.key !== key) {
    json = await ytApi("search", { query: key }, CLIENT_WEB, UA_WEB);
    _searchCache.key = key;
    _searchCache.tokens = [];
  } else {
    const token = _searchCache.tokens[p - 2];
    if (!token) return { isEnd: true, data: [] };
    json = await ytApi("search", { continuation: token }, CLIENT_WEB, UA_WEB);
  }

  const parsed = collectSearchItems(json);
  const data = parsed.items;

  if (p > 1 && data.length === 0) {
    /* 兜底：有的响应把结果放在 appendContinuationItemsAction 里，已被 scan 覆盖 */
  }

  if (parsed.token) {
    _searchCache.tokens[p - 1] = parsed.token;
  } else {
    _searchCache.tokens = _searchCache.tokens.slice(0, p - 1);
  }

  return {
    isEnd: !parsed.token || data.length === 0,
    data: data,
  };
}

/* ------------------------------------------------------------ 播放解析 */

const PLAYER_CLIENTS = [
  { client: CLIENT_ANDROID, ua: UA_ANDROID, name: "ANDROID" },
  { client: CLIENT_VR, ua: UA_VR, name: "ANDROID_VR" },
];

async function fetchPlayer(videoId) {
  let lastReason = "";
  for (let i = 0; i < PLAYER_CLIENTS.length; i++) {
    const c = PLAYER_CLIENTS[i];
    let json;
    try {
      json = await ytApi(
        "player",
        { videoId: videoId, contentCheckOk: true, racyCheckOk: true },
        c.client,
        c.ua
      );
    } catch (e) {
      lastReason = "请求失败(" + c.name + ")";
      continue;
    }
    if (!json) continue;
    const status = (json.playabilityStatus && json.playabilityStatus.status) || "";
    const sd = json.streamingData;
    if (status === "OK" && sd) return json;
    lastReason =
      (json.playabilityStatus && json.playabilityStatus.reason) || status || "无法解析";
  }
  const err = new Error("YouTube 拒绝解析：" + lastReason);
  err.__lastReason = lastReason;
  throw err;
}

const AUDIO_TARGET = {
  low: 52000,
  standard: 132000,
  high: 160000,
  super: 1000000,
};

function pickAudioUrl(playerJson, quality) {
  const sd = playerJson.streamingData || {};
  const all = [].concat(sd.formats || [], sd.adaptiveFormats || []);
  const audio = all.filter(
    (f) =>
      f &&
      f.url &&
      String(f.mimeType || "").indexOf("audio") === 0 &&
      /* 排除视频轨里混的 audio */
      !/avc1|vp9|vp09|av01/.test(String(f.mimeType || ""))
  );
  if (!audio.length) return null;

  const q = quality && AUDIO_TARGET[quality] ? quality : "standard";
  const target = AUDIO_TARGET[q];

  /* 除 super 外，优先 mp4/m4a：安卓与 iOS 都能硬解，opus/webm 在 iOS 上可能哑火 */
  let pool = audio;
  if (q !== "super") {
    const mp4 = audio.filter((f) => String(f.mimeType).indexOf("mp4") >= 0);
    if (mp4.length) pool = mp4;
  }

  pool.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
  let chosen = pool[0];
  for (let i = 0; i < pool.length; i++) {
    if ((pool[i].bitrate || 0) <= target) chosen = pool[i];
    else break;
  }
  return { url: chosen.url, itag: chosen.itag, bitrate: chosen.bitrate, mimeType: chosen.mimeType };
}

async function getMediaSource(musicItem, quality) {
  const videoId = parseVideoId(musicItem && (musicItem.videoId || musicItem.id));
  if (!videoId) {
    throw new Error("NOT RETRY");
  }
  const player = await fetchPlayer(videoId);
  const pick = pickAudioUrl(player, quality);
  if (!pick || !pick.url) {
    throw new Error("未找到可播放的音频轨");
  }
  return { url: pick.url };
}

/* ------------------------------------------------------------ 单曲信息 */

async function getMusicInfo(musicItem) {
  const videoId = parseVideoId(musicItem && (musicItem.videoId || musicItem.id));
  if (!videoId) return null;
  const player = await fetchPlayer(videoId);
  const vd = player.videoDetails || {};
  const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
  return {
    id: videoId,
    title: vd.title || (musicItem && musicItem.title) || "未知视频",
    artist: vd.author || (musicItem && musicItem.artist) || "YouTube",
    artwork: bestThumb(thumbs) || (musicItem && musicItem.artwork),
    duration: secToDur(vd.lengthSeconds) || (musicItem && musicItem.duration),
    album: undefined,
    videoId: videoId,
    rawTitle: vd.title,
    rawArtist: vd.author,
    viewCount: vd.viewCount,
  };
}

/* ------------------------------------------------------------ 歌词 */

function cleanForLyric(title, artist) {
  let t = String(title || "");
  let a = String(artist || "");

  a = a
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/官方频道|官方帳號|官方账号/g, "")
    .trim();

  /* "周杰伦 - 晴天" 这种把歌手从标题里拆出来 */
  const dash = t.match(/^(.{1,40}?)\s*[-–—]\s*(.+)$/);
  if (dash && (!a || a === "YouTube")) {
    a = dash[1].trim();
    t = dash[2];
  }

  t = t
    .replace(/[【\[（(][^】\]）)]*[】\]）)]/g, " ")
    .replace(
      /\b(official\s*(music\s*)?(video|audio|lyric\s*video|mv)|official|lyrics?|mv|m\/v|hd|hq|4k|8k|remaster(ed)?|audio|video|live|visualizer|performance)\b/gi,
      " "
    )
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, "")
    .trim();

  return { title: t, artist: a };
}

async function getLyric(musicItem) {
  const rawTitle = (musicItem && (musicItem.rawTitle || musicItem.title)) || "";
  const rawArtist = (musicItem && (musicItem.rawArtist || musicItem.artist)) || "";
  const cleaned = cleanForLyric(rawTitle, rawArtist);
  if (!cleaned.title) return { rawLrc: "" };

  const params = { track_name: cleaned.title };
  if (cleaned.artist && cleaned.artist !== "YouTube") params.artist_name = cleaned.artist;

  let list = [];
  try {
    const res = await AXIOS.get("https://lrclib.net/api/search", {
      params: params,
      headers: { "Lrclib-Client": "MusicFree YouTube Plugin v0.1.0" },
      timeout: 8000,
    });
    list = (res && res.data) || [];
  } catch (e) {
    return { rawLrc: "" };
  }
  if (!Array.isArray(list) || !list.length) return { rawLrc: "" };

  /* LRCLIB 的 search 是模糊匹配，会返回同名不同曲、甚至完全无关的歌。
     逐条打分：标题命中 +3、歌手命中 +1、有时轴 +2，时长对不上 -2。
     分数不到 3 的一律丢弃 —— 宁可没歌词，也不要配错歌。 */
  const rawNorm = normText(rawTitle);
  const artistNorm = normText(rawArtist);
  const myDur = parseDur(musicItem && musicItem.duration);

  let best = null;
  let bestScore = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || (!c.syncedLyrics && !c.plainLyrics)) continue;
    const ct = normText(c.trackName);
    const ca = normText(c.artistName);
    let score = 0;
    if (ct && rawNorm && rawNorm.indexOf(ct) >= 0) score += 3;
    if (ca && artistNorm && artistNorm.indexOf(ca) >= 0) score += 1;
    if (c.syncedLyrics) score += 2;
    if (myDur && c.duration && Math.abs(myDur - c.duration) > 10) score -= 2;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best || bestScore < 3) return { rawLrc: "" };
  return { rawLrc: best.syncedLyrics || best.plainLyrics || "" };
}

/* ------------------------------------------------------------ 导入 */

async function importMusicItem(urlLike) {
  const raw = typeof urlLike === "string" ? urlLike : urlLike && urlLike.url;
  const videoId = parseVideoId(raw);
  if (!videoId) return null;
  try {
    const info = await getMusicInfo({ videoId: videoId });
    if (info) return info;
  } catch (e) {
    /* 解析不了就返回最小条目，App 之后仍可尝试播放 */
  }
  return { id: videoId, videoId: videoId, title: videoId, artist: "YouTube" };
}

/* ------------------------------------------------------------ 导出 */

module.exports = {
  platform: "YouTube",
  version: "0.1.0",
  appVersion: ">=0.4.0",
  srcUrl: "https://cdn.jsdelivr.net/gh/ccvxxcg0-wq/musicfree-plugins@main/youtube-plugin.js",
  author: "Little Code Sauce",
  description:
    "YouTube 搜索与全长音频播放。\n\n" +
    "**要点**\n" +
    "- 播放走 ANDROID 客户端解析，返回的是绑定手机出口 IP 的临时直链，手机自己请求即可播。\n" +
    "- 链接约 6 小时过期，每次播放都会重新解析，不做缓存。\n" +
    "- 歌词来自 LRCLIB（按标题+歌手匹配，自动清理 Official Video 这类后缀）。\n" +
    "- 可直接粘贴 youtube.com/watch、youtu.be、music.youtube.com、shorts 链接导入。\n\n" +
    "**已知限制**\n" +
    "- 国内网络需自备代理，否则 youtube.com 无法访问。\n" +
    "- 若代理出口是机房 IP，YouTube 可能要求登录验证（Sign in to confirm you're not a bot），此时解析失败，属网络侧限制。\n" +
    "- 不提供榜单/歌单/歌手页：这些端点需要额外鉴权，不稳定，宁可不做。",
  primaryKey: ["videoId"],
  cacheControl: "no-cache",
  supportedSearchType: ["music"],
  userVariables: [],
  search: search,
  getMediaSource: getMediaSource,
  getMusicInfo: getMusicInfo,
  getLyric: getLyric,
  importMusicItem: importMusicItem,
};