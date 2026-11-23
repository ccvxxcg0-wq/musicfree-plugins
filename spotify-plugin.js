/**
 * MusicFree 插件：Spotify
 * ------------------------------------------------------------------
 * 走 Spotify Web API 的 Client Credentials 流程（只需 clientId / clientSecret，
 * 不需要登录你的账号），实现搜索、专辑、歌手、歌单、新发行、歌词、导入链接。
 *
 * 播放说明：Spotify 的正式音频流是 Widevine DRM 加密的，任何 JS 播放器都解不了。
 * 本插件按优先级取音频：
 *   1. 歌曲自带的 preview_url（30 秒试听 mp3，官方 CDN，可直接播）
 *   2. 你自己配的 resolverUrl（外部解析服务，返回 { url } 或纯文本 URL）
 * 两者都没有就明确报错，不会假装能播。
 *
 * 歌词来自 lrclib.net（免费、无需 key、带时间轴）。
 */
const axios = require("axios");
const CryptoJs = require("crypto-js");

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const LYRIC_URL = "https://lrclib.net/api/get";

const PAGE = 20;
const ALBUM_PAGE = 50;
const PLAYLIST_PAGE = 100;

let _token = null;
let _tokenExp = 0;

/* ------------------------------------------------------------------ 配置 */

function vars() {
  try {
    if (typeof env !== "undefined" && env && typeof env.getUserVariables === "function") {
      return env.getUserVariables() || {};
    }
  } catch (e) {}
  return {};
}

function cfg() {
  const v = vars();
  const pick = key => String(v[key] == null ? "" : v[key]).trim();
  return {
    clientId: pick("clientId"),
    clientSecret: pick("clientSecret"),
    market: (pick("market") || "US").toUpperCase(),
    resolverUrl: pick("resolverUrl"),
  };
}

/* -------------------------------------------------------------- 基础工具 */

function b64(str) {
  return CryptoJs.enc.Base64.stringify(CryptoJs.enc.Utf8.parse(str));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function img(images) {
  if (!images || !images.length) return undefined;
  let best = images[0];
  for (let i = 1; i < images.length; i++) {
    const w = images[i] && images[i].width ? images[i].width : 0;
    if (w > (best && best.width ? best.width : 0)) best = images[i];
  }
  return best && best.url ? best.url : undefined;
}

function joinArtists(list) {
  return (list || [])
    .map(a => (a && a.name ? a.name : ""))
    .filter(Boolean)
    .join(" / ");
}

function toSec(ms) {
  return ms && ms > 0 ? Math.round(ms / 1000) : undefined;
}

function makeId(kind, id) {
  return "sp:" + kind + ":" + id;
}

function parseId(item) {
  const raw = String((item && item.id) || "");
  const parts = raw.split(":");
  if (parts.length >= 3 && parts[0] === "sp") {
    return { kind: parts[1], sid: parts.slice(2).join(":") };
  }
  return { kind: null, sid: raw };
}

/* ---------------------------------------------------------------- 鉴权 */

async function getToken(force) {
  const c = cfg();
  if (!c.clientId || !c.clientSecret) throw new Error("NO_CREDENTIALS");
  if (!force && _token && Date.now() < _tokenExp - 60000) return _token;

  const res = await axios.post(TOKEN_URL, "grant_type=client_credentials", {
    headers: {
      Authorization: "Basic " + b64(c.clientId + ":" + c.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });
  const data = res && res.data ? res.data : {};
  if (!data.access_token) throw new Error("TOKEN_FAILED");
  _token = data.access_token;
  _tokenExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return _token;
}

async function api(path, params, retried) {
  const token = await getToken(false);
  try {
    const res = await axios.get(API + path, {
      params: params || {},
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      timeout: 15000,
    });
    return res && res.data ? res.data : {};
  } catch (err) {
    const resp = err && err.response;
    const status = resp && resp.status;
    if (status === 401 && !retried) {
      _token = null;
      _tokenExp = 0;
      await getToken(true);
      return api(path, params, true);
    }
    if (status === 429 && !retried) {
      const h = (resp && resp.headers) || {};
      const wait = Number(h["retry-after"] || h["Retry-After"] || 2);
      await sleep(Math.min(Math.max(wait, 1), 8) * 1000);
      return api(path, params, true);
    }
    throw err;
  }
}

/* ------------------------------------------------------------ 对象映射 */

function toMusic(track, albumFallback) {
  if (!track || !track.id) return null;
  const al = track.album || albumFallback || {};
  return {
    id: makeId("track", track.id),
    title: track.name || "未知歌曲",
    artist: joinArtists(track.artists) || "未知歌手",
    album: al.name || undefined,
    artwork: img(al.images),
    duration: toSec(track.duration_ms),
    /* 以下为播放/歌词所需原始字段，App 会连同条目一起保存 */
    isrc: (track.external_ids && track.external_ids.isrc) || undefined,
    previewUrl: track.preview_url || undefined,
    rawTitle: track.name || undefined,
    rawArtist: (track.artists && track.artists[0] && track.artists[0].name) || undefined,
    rawAlbum: al.name || undefined,
    releaseDate: al.release_date || undefined,
    trackNumber: track.track_number || undefined,
    discNumber: track.disc_number || undefined,
    popularity: track.popularity == null ? undefined : track.popularity,
    explicit: !!track.explicit,
  };
}

function toAlbum(album) {
  if (!album || !album.id) return null;
  return {
    id: makeId("album", album.id),
    title: album.name || "未知专辑",
    artist: joinArtists(album.artists) || "未知歌手",
    artwork: img(album.images),
    date: album.release_date,
    worksNum: album.total_tracks,
    albumType: album.album_type,
  };
}

function toArtist(artist) {
  if (!artist || !artist.id) return null;
  return {
    id: makeId("artist", artist.id),
    name: artist.name || "未知歌手",
    avatar: img(artist.images),
    fans: artist.followers ? artist.followers.total : undefined,
    description: artist.genres && artist.genres.length ? artist.genres.join(" / ") : undefined,
  };
}

function toSheet(playlist) {
  if (!playlist || !playlist.id) return null;
  return {
    id: makeId("playlist", playlist.id),
    title: playlist.name || "未命名歌单",
    artist: (playlist.owner && playlist.owner.display_name) || undefined,
    artwork: img(playlist.images),
    worksNum: playlist.tracks ? playlist.tracks.total : undefined,
    description: playlist.description || undefined,
  };
}

/* ---------------------------------------------------------------- 搜索 */

async function search(query, page, type) {
  const c = cfg();
  const q = String(query == null ? "" : query).trim();
  if (!q) return { isEnd: true, data: [] };

  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * PAGE;
  const kind = type || "music";
  const map = {
    music: { type: "track", conv: x => toMusic(x) },
    album: { type: "album", conv: toAlbum },
    artist: { type: "artist", conv: toArtist },
    sheet: { type: "playlist", conv: toSheet },
  };
  const entry = map[kind];
  if (!entry) return { isEnd: true, data: [] };

  const data = await api("/search", {
    q,
    type: entry.type,
    limit: PAGE,
    offset,
    market: c.market,
  });
  const box = data && data[entry.type + "s"];
  const raw = (box && box.items) || [];
  const list = raw.map(entry.conv).filter(Boolean);
  const total = (box && box.total) || 0;
  return {
    isEnd: !box || !box.next || offset + list.length >= total,
    data: list,
  };
}

/* ------------------------------------------------------------ 播放地址 */

async function getMediaSource(musicItem) {
  const c = cfg();
  const item = musicItem || {};
  const parsed = parseId(item);

  // 1) 条目自带 preview_url
  if (item.previewUrl) return { url: item.previewUrl };

  // 2) 重新拉一次 track，preview_url 可能刚生成
  if (parsed.sid) {
    try {
      const track = await api("/tracks/" + parsed.sid, { market: c.market });
      if (track && track.preview_url) return { url: track.preview_url };
      if (track && track.external_ids && track.external_ids.isrc && !item.isrc) {
        item.isrc = track.external_ids.isrc;
      }
    } catch (e) {}
  }

  // 3) 外部解析服务
  if (c.resolverUrl) {
    const params = {
      spotifyId: parsed.sid || "",
      isrc: item.isrc || "",
      title: item.rawTitle || item.title || "",
      artist: item.rawArtist || item.artist || "",
      album: item.rawAlbum || item.album || "",
      duration: item.duration || "",
    };
    try {
      const res = await axios.get(c.resolverUrl, { params, timeout: 25000 });
      const data = res && res.data;
      const url = typeof data === "string" ? data : data && (data.url || data.src);
      if (url) {
        return {
          url,
          headers: (data && data.headers) || undefined,
          userAgent: (data && data.userAgent) || undefined,
        };
      }
    } catch (e) {}
  }

  throw new Error("NOT RETRY");
}

/* ---------------------------------------------------------- 补充信息 */

async function getMusicInfo(base) {
  const parsed = parseId(base);
  if (parsed.kind !== "track" || !parsed.sid) return null;
  const track = await api("/tracks/" + parsed.sid, { market: cfg().market });
  return toMusic(track) || null;
}

async function getLyric(musicItem) {
  const item = musicItem || {};
  const title = item.rawTitle || item.title;
  const artist = item.rawArtist || String(item.artist || "").split(" / ")[0];
  if (!title) throw new Error("NOT RETRY");

  const params = { track_name: title, artist_name: artist || "" };
  const album = item.rawAlbum || item.album;
  if (album) params.album_name = album;
  if (item.duration) params.duration = Math.round(item.duration);

  const res = await axios.get(LYRIC_URL, {
    params,
    timeout: 15000,
    headers: {
      "Lrclib-Client": "MusicFree-Spotify-Plugin v0.1.0 (https://musicfree.catcat.work)",
    },
  });
  const data = res && res.data;
  if (!data || (!data.syncedLyrics && !data.plainLyrics)) throw new Error("NOT RETRY");
  return { rawLrc: data.syncedLyrics || data.plainLyrics };
}

/* -------------------------------------------------------------- 专辑 */

async function getAlbumInfo(albumItem, page) {
  const parsed = parseId(albumItem);
  if (!parsed.sid) throw new Error("NOT RETRY");

  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * ALBUM_PAGE;
  const c = cfg();

  let meta = null;
  if (!albumItem.artwork || !albumItem.title) {
    try {
      meta = await api("/albums/" + parsed.sid, { market: c.market });
    } catch (e) {}
  }
  const albumRef = meta || {
    name: albumItem.title,
    images: albumItem.artwork ? [{ url: albumItem.artwork, width: 640 }] : [],
    release_date: albumItem.date,
    artists: [{ name: albumItem.artist }],
  };

  const data = await api("/albums/" + parsed.sid + "/tracks", {
    limit: ALBUM_PAGE,
    offset,
    market: c.market,
  });
  const raw = (data && data.items) || [];
  const musicList = raw
    .map(track => {
      const m = toMusic(track, albumRef);
      if (m) {
        m.album = albumRef.name || m.album;
        m.artwork = img(albumRef.images) || m.artwork;
        m.artist = m.artist === "未知歌手" ? joinArtists(albumRef.artists) : m.artist;
      }
      return m;
    })
    .filter(Boolean);

  return {
    isEnd: offset + raw.length >= ((data && data.total) || 0),
    musicList,
    albumItem: toAlbum(meta) || albumItem,
  };
}

/* -------------------------------------------------------------- 歌单 */

async function getMusicSheetInfo(sheetItem, page) {
  const parsed = parseId(sheetItem);
  if (!parsed.sid) throw new Error("NOT RETRY");

  // 专辑链接被当作歌单时，直接复用专辑逻辑
  if (parsed.kind === "album") {
    return getAlbumInfo({ ...sheetItem, id: makeId("album", parsed.sid) }, page);
  }

  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * PLAYLIST_PAGE;
  const c = cfg();

  const data = await api("/playlists/" + parsed.sid + "/tracks", {
    limit: PLAYLIST_PAGE,
    offset,
    market: c.market,
    additional_types: "track",
  });
  const raw = (data && data.items) || [];
  const musicList = raw
    .map(entry => toMusic(entry && (entry.track || entry)))
    .filter(Boolean);

  return {
    isEnd: offset + raw.length >= ((data && data.total) || 0),
    musicList,
    sheetItem,
  };
}

/* -------------------------------------------------------------- 歌手 */

async function getArtistWorks(artistItem, page, type) {
  const parsed = parseId(artistItem);
  if (!parsed.sid) throw new Error("NOT RETRY");
  const c = cfg();
  const p = Math.max(1, Number(page) || 1);

  if (type === "music") {
    const data = await api("/artists/" + parsed.sid + "/top-tracks", { market: c.market });
    const list = ((data && data.tracks) || []).map(t => toMusic(t)).filter(Boolean);
    return { isEnd: true, data: list };
  }

  const offset = (p - 1) * PAGE;
  const data = await api("/artists/" + parsed.sid + "/albums", {
    include_groups: "album,single",
    limit: PAGE,
    offset,
    market: c.market,
  });
  const list = ((data && data.items) || []).map(toAlbum).filter(Boolean);
  return {
    isEnd: offset + list.length >= ((data && data.total) || 0),
    data: list,
  };
}

/* ------------------------------------------------------------ 榜单/新发行 */

const NEW_RELEASES_DETAIL_ALBUMS = 6;

async function getTopLists() {
  return [
    {
      title: "新发行",
      data: [
        { id: "new:album", title: "最新专辑" },
        { id: "new:single", title: "最新单曲" },
      ],
    },
  ];
}

async function getTopListDetail(topListItem, page) {
  const id = String((topListItem && topListItem.id) || "");
  const c = cfg();
  const p = Math.max(1, Number(page) || 1);

  if (id !== "new:album" && id !== "new:single") {
    return { isEnd: true, musicList: [] };
  }

  const offset = (p - 1) * PAGE;
  const data = await api("/browse/new-releases", {
    limit: PAGE,
    offset,
    country: c.market,
  });
  const box = (data && data.albums) || {};
  const want = id === "new:album" ? "album" : "single";
  let albums = (box.items || []).filter(a => a && a.album_type === want);
  if (!albums.length) albums = (box.items || []).filter(Boolean);

  const isEnd = !box.next || offset + (box.items || []).length >= (box.total || 0);
  const take = albums.slice(0, NEW_RELEASES_DETAIL_ALBUMS);
  const musicList = [];
  for (let i = 0; i < take.length; i++) {
    const album = take[i];
    try {
      const tracks = await api("/albums/" + album.id + "/tracks", {
        limit: 20,
        market: c.market,
      });
      const ref = album;
      (tracks && tracks.items ? tracks.items : []).forEach(t => {
        const m = toMusic(t, ref);
        if (m) {
          m.album = ref.name;
          m.artwork = img(ref.images) || m.artwork;
          musicList.push(m);
        }
      });
    } catch (e) {}
  }

  return { isEnd, musicList };
}

/* ------------------------------------------------------- 推荐歌单（分类） */

async function getRecommendSheetTags() {
  const c = cfg();
  const data = await api("/browse/categories", { limit: 30, country: c.market });
  const items = ((data && data.categories && data.categories.items) || [])
    .map(cat => ({ id: "cat:" + cat.id, title: cat.name }))
    .filter(x => x.title);

  const featured = [{ id: "cat:toplists", title: "流行榜单" }];
  return {
    pinned: featured,
    data: items.length ? [{ title: "分类", data: items }] : [],
  };
}

async function getRecommendSheetsByTag(tag, page) {
  const id = String((tag && tag.id) || "");
  if (id.indexOf("cat:") !== 0) return { isEnd: true, data: [] };

  const c = cfg();
  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * PAGE;
  const data = await api("/browse/categories/" + id.slice(4) + "/playlists", {
    limit: PAGE,
    offset,
    country: c.market,
  });
  const box = (data && data.playlists) || {};
  const list = (box.items || []).map(toSheet).filter(Boolean);
  return {
    isEnd: !box.next || offset + list.length >= (box.total || 0),
    data: list,
  };
}

/* -------------------------------------------------------------- 导入 */

function parseSpotifyRef(input) {
  const s = String(input == null ? "" : input).trim();
  if (!s) return null;

  let m = s.match(/^spotify:(track|album|artist|playlist):([A-Za-z0-9]+)/);
  if (m) return { kind: m[1], id: m[2] };

  m = s.match(/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(track|album|artist|playlist)\/([A-Za-z0-9]+)/i);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };

  m = s.match(/\/(track|album|artist|playlist)\/([A-Za-z0-9]{22})/);
  if (m) return { kind: m[1], id: m[2] };

  if (/^[A-Za-z0-9]{22}$/.test(s)) return { kind: "track", id: s };
  return null;
}

async function importMusicSheet(urlLike) {
  const ref = parseSpotifyRef(urlLike);
  if (!ref) throw new Error("NOT RETRY");
  const c = cfg();

  if (ref.kind === "playlist") {
    const data = await api("/playlists/" + ref.id, { market: c.market });
    const sheet = toSheet(data);
    return sheet ? [sheet] : [];
  }

  if (ref.kind === "album") {
    const data = await api("/albums/" + ref.id, { market: c.market });
    const album = toAlbum(data);
    if (!album) return [];
    return [{ ...album, worksNum: data.total_tracks }];
  }

  if (ref.kind === "artist") {
    const data = await api("/artists/" + ref.id + "/albums", {
      include_groups: "album",
      limit: 20,
      market: c.market,
    });
    return ((data && data.items) || []).map(toAlbum).filter(Boolean);
  }

  throw new Error("NOT RETRY");
}

async function importMusicItem(urlLike) {
  const ref = parseSpotifyRef(urlLike);
  if (!ref) throw new Error("NOT RETRY");
  const c = cfg();

  if (ref.kind === "track") {
    const data = await api("/tracks/" + ref.id, { market: c.market });
    const item = toMusic(data);
    return item ? [item] : [];
  }

  if (ref.kind === "album") {
    const albumInfo = await getAlbumInfo({ id: makeId("album", ref.id) }, 1);
    return albumInfo.musicList || [];
  }

  if (ref.kind === "playlist") {
    const sheetInfo = await getMusicSheetInfo({ id: makeId("playlist", ref.id) }, 1);
    return sheetInfo.musicList || [];
  }

  throw new Error("NOT RETRY");
}

/* -------------------------------------------------------------- 导出 */

module.exports = {
  platform: "Spotify",
  version: "0.1.1",
  author: "Little Code Sauce",
  description: [
    "**Spotify 音乐源**（Client Credentials，无需登录账号）",
    "",
    "- 搜索：单曲 / 专辑 / 歌手 / 歌单",
    "- 浏览：专辑曲目、歌手作品与热门、歌单曲目、新发行",
    "- 推荐：Spotify 官方分类下的歌单",
    "- 歌词：lrclib.net，带时间轴",
    "- 导入：粘贴 `open.spotify.com/...` 链接直接进歌单 / 单曲",
    "",
    "**播放**：Spotify 正式音频为 Widevine DRM 加密，JS 播放器无法解密。",
    "本插件只用 `preview_url`（30 秒官方试听），或你在「用户变量」里配置的",
    "`resolverUrl` 外部解析服务返回的地址。两者都没有时会明确报错。",
  ].join("\n"),
  appVersion: ">=0.4.0",
  srcUrl:
    "https://cdn.jsdelivr.net/gh/ccvxxcg0-wq/musicfree-plugins@main/spotify-plugin.js",
  cacheControl: "no-cache",
  primaryKey: ["id"],
  defaultSearchType: "music",
  supportedSearchType: ["music", "album", "artist", "sheet"],
  hints: {
    importMusicSheet: [
      "支持 `https://open.spotify.com/playlist/xxxx` 与 `spotify:playlist:xxxx`",
      "专辑链接会以「单张专辑」形式导入",
      "歌手链接会导入该歌手的专辑列表",
    ],
  },
  userVariables: [
    {
      key: "clientId",
      name: "Client ID",
      hint: "Spotify Developer Dashboard → 你的 App → Client ID",
    },
    {
      key: "clientSecret",
      name: "Client Secret",
      hint: "同一个 App 的 Client Secret，仅存本机",
      type: "password",
    },
    {
      key: "market",
      name: "市场代码",
      hint: "两位国家码，影响可搜到的曲目与试听，默认 US",
    },
    {
      key: "resolverUrl",
      name: "外部解析服务（可选）",
      hint: "返回 {url} 或纯文本音频地址，参数：spotifyId/isrc/title/artist/album/duration",
    },
  ],

  search,
  getMediaSource,
  getMusicInfo,
  getLyric,
  getAlbumInfo,
  getMusicSheetInfo,
  getArtistWorks,
  getTopLists,
  getTopListDetail,
  getRecommendSheetTags,
  getRecommendSheetsByTag,
  importMusicSheet,
  importMusicItem,
};