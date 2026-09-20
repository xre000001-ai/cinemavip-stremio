#!/usr/bin/env node
// Cinema VIP Stream — Stremio addon v5.1.0
// VaPlayer: 3 native HLS (m3u8) — plays in Stremio app
// VixSrc: 1 native HLS with multi-audio + subtitles (via proxy fallback)
// 8 embed providers: browser fallbacks (externalUrl)

'use strict';

import express from 'express';

const app = express();
const VERSION = '5.2.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ─── VaPlayer API — reliable m3u8 ───────────────────────────────────────────
const VA_API = 'https://streamdata.vaplayer.ru/api.php';
const VA_ORIGIN = 'https://nextgencloudfabric.com';

async function getVaPlayerStreams(imdbId, type, season, episode) {
  const streams = [];
  try {
    const params = new URLSearchParams({ imdb: imdbId, type: type === 'series' ? 'tv' : 'movie' });
    if (type === 'series' && season && episode) {
      params.set('season', String(season));
      params.set('episode', String(episode));
    }
    const referer = type === 'series'
      ? `${VA_ORIGIN}/embed/tv/${imdbId}/${season}/${episode}`
      : `${VA_ORIGIN}/embed/movie/${imdbId}`;

    const resp = await fetch(`${VA_API}?${params}`, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': UA, Referer: referer, Origin: VA_ORIGIN },
    });
    if (!resp.ok) return streams;
    const json = await resp.json();
    if (String(json.status_code) !== '200') return streams;

    const urls = json.data?.stream_urls || [];
    const title = json.data?.title || '';
    for (let i = 0; i < urls.length; i++) {
      streams.push({
        name: `[ CinemaVIP ] ▶️ Server ${i + 1}`,
        title: `${title}\nHLS · Plays in Stremio app`,
        url: urls[i],
        behaviorHints: { notWebReady: false },
      });
    }
  } catch (e) { console.error('VaPlayer:', e.message); }
  return streams;
}

// ─── VixSrc API — HLS with multi-audio + subtitles ─────────────────────────
// VIXSRC_PROXY: comma-separated Cloudflare Worker URLs for fallback
// Hardcoded CF Workers (ready for when VixSrc stops blocking CF IPs)
const VIX_PROXIES = (process.env.VIXSRC_PROXY || 'https://cinemavip-proxy1.xre000001.workers.dev,https://cinemavip-proxy2.xre000001.workers.dev,https://cinemavip-proxy3.xre000001.workers.dev')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const vixSrcCache = new Map();
const VIX_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function getVixCacheKey(imdbId, type, season, episode) {
  if (type === 'series') return `tv:${imdbId}:${season}:${episode}`;
  return `movie:${imdbId}`;
}

// Try fetching VixSrc URL — direct first, then round-robin proxies
let proxyIndex = 0;
async function vixFetch(url) {
  // Try direct first (works on residential IPs)
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': UA, Referer: 'https://vixsrc.to/', Origin: 'https://vixsrc.to' },
    });
    if (r.ok) return r;
  } catch {}

  // Try each proxy in round-robin
  for (let i = 0; i < VIX_PROXIES.length; i++) {
    const idx = (proxyIndex + i) % VIX_PROXIES.length;
    const proxy = VIX_PROXIES[idx];
    try {
      const proxyUrl = `${proxy}?url=${encodeURIComponent(url)}`;
      const r = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        proxyIndex = (idx + 1) % VIX_PROXIES.length; // rotate
        return r;
      }
    } catch {}
  }
  return null;
}

async function getVixSrcStreams(imdbId, type, season, episode) {
  const streams = [];
  const cacheKey = getVixCacheKey(imdbId, type, season, episode);

  // Check cache first
  const cached = vixSrcCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < VIX_CACHE_TTL) {
    streams.push({
      name: `[ CinemaVIP ] 🎬 VixSrc`,
      title: `VixSrc HLS\nMulti-audio + subtitles · Plays in Stremio app`,
      url: cached.url,
      behaviorHints: { notWebReady: false },
    });
    return streams;
  }

  try {
    // Step 1: Get embed path from VixSrc API
    const apiUrl = type === 'series'
      ? `https://vixsrc.to/api/tv/${imdbId}/${season}/${episode}`
      : `https://vixsrc.to/api/movie/${imdbId}`;

    const apiResp = await vixFetch(apiUrl);
    if (!apiResp) return streams;

    const apiData = await apiResp.json();
    const embedPath = apiData?.src;
    if (!embedPath) return streams;

    // Step 2: Get masterPlaylist from embed page
    const embedResp = await vixFetch(`https://vixsrc.to${embedPath}`);
    if (!embedResp) return streams;

    const html = await embedResp.text();

    // Extract masterPlaylist URL, token, and expires
    const urlMatch = html.match(/url:\s*'([^']+)'/);
    const tokenMatch = html.match(/'token':\s*'([^']+)'/);
    const expiresMatch = html.match(/'expires':\s*'([^']+)'/);

    if (!urlMatch || !tokenMatch || !expiresMatch) return streams;

    const playlistUrl = urlMatch[1];
    const token = tokenMatch[1];
    const expires = expiresMatch[1];

    // Build HLS URL — NO ?b=1 (triggers Cloudflare block)
    const separator = playlistUrl.includes('?') ? '&' : '?';
    const hlsUrl = `${playlistUrl}${separator}token=${token}&expires=${expires}`;

    // Cache it
    vixSrcCache.set(cacheKey, { url: hlsUrl, ts: Date.now() });

    streams.push({
      name: `[ CinemaVIP ] 🎬 VixSrc`,
      title: `VixSrc HLS\nMulti-audio + subtitles · Plays in Stremio app`,
      url: hlsUrl,
      behaviorHints: { notWebReady: false },
    });
  } catch (e) { /* VixSrc may fail — VaPlayer still works */ }
  return streams;
}

// ─── Embed providers (browser fallbacks) ────────────────────────────────────
const PROVIDERS = [
  { name: '🎬 VidSrc.to',   build: p => p.type === 'series' ? `https://vidsrc.to/embed/tv/${p.imdbId}/${p.season}-${p.episode}` : `https://vidsrc.to/embed/movie/${p.imdbId}` },
  { name: '📺 VidSrc.me',   build: p => p.type === 'series' ? `https://vidsrcme.ru/embed/tv/${p.imdbId}/${p.season}-${p.episode}` : `https://vidsrcme.ru/embed/movie/${p.imdbId}` },
  { name: '🎞️ 2Embed',      build: p => p.type === 'series' ? `https://www.2embed.cc/embed/tv/${p.imdbId}/${p.season}-${p.episode}` : `https://www.2embed.cc/embed/movie/${p.imdbId}` },
  { name: '▶️ SuperEmbed',  build: p => p.type === 'series' ? `https://multiembed.mov/?video_id=${p.imdbId}&s=${p.season}&e=${p.episode}` : `https://multiembed.mov/?video_id=${p.imdbId}` },
  { name: '⚡ VidFast',     build: p => p.type === 'series' ? `https://vidfast.vc/embed/tv/${p.imdbId}/${p.season}-${p.episode}` : `https://vidfast.vc/embed/movie/${p.imdbId}` },
  { name: '🌐 EmbedSu',     build: p => p.type === 'series' ? `https://www.embed.su/embed/tv/${p.imdbId}/${p.season}-${p.episode}` : `https://www.embed.su/embed/movie/${p.imdbId}` },
  { name: '🎥 MoviesAPI',   build: p => p.type === 'series' ? `https://moviesapi.to/tv/${p.imdbId}-${p.season}-${p.episode}` : `https://moviesapi.to/movie/${p.imdbId}` },
  { name: '🔗 VidLink',     build: p => p.type === 'series' ? `https://vidlink.pro/tv/${p.imdbId}/${p.season}/${p.episode}` : `https://vidlink.pro/movie/${p.imdbId}` },
];

// ─── Parser ─────────────────────────────────────────────────────────────────
function parseStreamId(rawId) {
  const decoded = decodeURIComponent(rawId).replace(/\.json$/, '');
  const parts = decoded.split(':');
  const imdbId = parts[0];
  if (!imdbId?.startsWith('tt')) return null;
  if (parts.length === 1) return { type: 'movie', imdbId };
  if (parts.length === 3) {
    const s = Number(parts[1]), e = Number(parts[2]);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    return { type: 'series', imdbId, season: s, episode: e };
  }
  return null;
}

// ─── Manifest ───────────────────────────────────────────────────────────────
const MANIFEST = {
  id: 'com.cinemavip.stream',
  version: VERSION,
  name: 'Cinema VIP Stream',
  description: 'Free movies & TV — 4 native HLS (VaPlayer + VixSrc) play in Stremio app + 8 browser fallbacks.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(MANIFEST);
});

app.get('/configure', (req, res) => {
  const host = req.headers.host;
  const proxyStatus = VIX_PROXIES.length > 0
    ? `<div class="i h"><b>🛡️ Proxy</b><br>${VIX_PROXIES.length} worker(s) active</div>`
    : `<div class="i"><b>⚠️ No Proxy</b><br>VixSrc needs residential IP</div>`;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cinema VIP Stream</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#161b22;border:1px solid #232a33;border-radius:16px;padding:40px;max-width:500px;width:90%;text-align:center}
h1{font-size:28px;color:#e50914;margin-bottom:8px}p{color:#888;line-height:1.6;margin-bottom:20px}
a.b{display:inline-block;background:#e50914;color:#fff;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;text-decoration:none}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0;text-align:left}
.i{background:#0a0a0b;border:1px solid #232a33;border-radius:10px;padding:10px;font-size:13px;color:#c9d1d9}
.h{border-color:#2a5a2a;background:#1a3a1a}.i b{color:#e6e9ef}.ft{font-size:12px;color:#444;margin-top:16px}
</style></head><body><div class="c">
<h1>🎬 Cinema VIP Stream v${VERSION}</h1>
<p>Free movies &amp; TV shows</p>
<div class="g">
<div class="i h"><b>▶️ VaPlayer 1-3</b><br>HLS · Stremio app</div>
<div class="i h"><b>🎬 VixSrc</b><br>HLS + subtitles · Stremio app</div>
${proxyStatus}
<div class="i"><b>📊 12 Total</b><br>4 native + 8 fallback</div>
</div>
<a class="b" href="stremio://${host}/manifest.json">⬇️ Install in Stremio</a>
<p class="ft">v${VERSION} · IMDb compatible · zero bandwidth</p>
</div></body></html>`);
});

// Stream endpoint
app.get('/stream/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!['movie', 'series'].includes(type)) return res.json({ streams: [] });
    const parsed = parseStreamId(id);
    if (!parsed || type !== parsed.type) return res.json({ streams: [] });

    const { imdbId, season, episode } = parsed;
    const streams = [];

    // Fetch native HLS sources in parallel
    const [vaStreams, vixStreams] = await Promise.all([
      getVaPlayerStreams(imdbId, type, season, episode),
      getVixSrcStreams(imdbId, type, season, episode),
    ]);

    streams.push(...vaStreams);
    streams.push(...vixStreams);

    // Browser fallbacks
    for (const p of PROVIDERS) {
      streams.push({
        name: `[ CinemaVIP ] ${p.name}`,
        title: 'Opens in browser',
        externalUrl: p.build(parsed),
        behaviorHints: { notWebReady: true },
      });
    }

    return res.json({ streams });
  } catch (e) { console.error('Stream:', e.message); return res.json({ streams: [] }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION, proxies: VIX_PROXIES.length, uptime: Math.round(process.uptime()) }));
app.get('/', (req, res) => res.redirect('/configure'));

// Pre-warm VixSrc cache on startup
async function prewarmVixSrc() {
  console.log('Pre-warming VixSrc cache...');
  const streams = await getVixSrcStreams('tt0111161', 'movie');
  if (streams.length > 0) {
    console.log('VixSrc cache warmed ✓');
  } else {
    console.log('VixSrc pre-warm failed (will retry on request)');
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cinema VIP Stream v${VERSION} on :${PORT}`);
  console.log(`VixSrc proxies: ${VIX_PROXIES.length || 'none (direct only)'}`);
  prewarmVixSrc();
});