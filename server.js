#!/usr/bin/env node
// Cinema VIP Stream — Stremio addon v4.0.0
// VaPlayer: 3 native HLS (m3u8) — plays in Stremio app
// VixSrc: 1 native HLS with subtitles — plays in Stremio app
// 8 embed providers: browser fallbacks (externalUrl)

'use strict';

import express from 'express';

const app = express();
const VERSION = '4.0.0';
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
        name: `[ CinemaVIP ] ▶️ VaPlayer ${i + 1}`,
        title: `${title}\nHLS · Plays in Stremio app`,
        url: urls[i],
        behaviorHints: { notWebReady: false },
      });
    }
  } catch (e) { console.error('VaPlayer:', e.message); }
  return streams;
}

// ─── VixSrc API — HLS with subtitles ────────────────────────────────────────
async function getVixSrcStreams(imdbId, type, season, episode) {
  const streams = [];
  try {
    // Step 1: Get embed path from VixSrc API
    const apiUrl = type === 'series'
      ? `https://vixsrc.to/api/tv/${imdbId}/${season}/${episode}`
      : `https://vixsrc.to/api/movie/${imdbId}`;

    const apiResp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': UA },
    });
    if (!apiResp.ok) return streams;

    const apiData = await apiResp.json();
    const embedPath = apiData?.src;
    if (!embedPath) return streams;

    // Step 2: Get masterPlaylist from embed page
    const embedResp = await fetch(`https://vixsrc.to${embedPath}`, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': UA },
    });
    if (!embedResp.ok) return streams;

    const html = await embedResp.text();

    // Extract masterPlaylist URL, token, and expires from the HTML
    const urlMatch = html.match(/url:\s*'([^']+)'/);
    const tokenMatch = html.match(/'token':\s*'([^']+)'/);
    const expiresMatch = html.match(/'expires':\s*'([^']+)'/);

    if (!urlMatch || !tokenMatch || !expiresMatch) return streams;

    const playlistUrl = urlMatch[1];
    const token = tokenMatch[1];
    const expires = expiresMatch[1];

    // Build the final HLS URL
    const separator = playlistUrl.includes('?') ? '&' : '?';
    const hlsUrl = `${playlistUrl}${separator}token=${token}&expires=${expires}&h=1`;

    streams.push({
      name: `[ CinemaVIP ] 🎬 VixSrc`,
      title: `VixSrc HLS\nMulti-audio + subtitles · Plays in Stremio app`,
      url: hlsUrl,
      behaviorHints: { notWebReady: false },
    });
  } catch (e) { console.error('VixSrc:', e.message); }
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
  description: 'Free movies & TV — 4 native HLS servers (VaPlayer + VixSrc) play in Stremio app + 8 browser fallbacks. IMDb compatible.',
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
<div class="i"><b>🌐 8 Providers</b><br>Browser fallback</div>
<div class="i"><b>📊 11 Total</b><br>4 native + 8 fallback</div>
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

app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION, uptime: Math.round(process.uptime()) }));
app.get('/', (req, res) => res.redirect('/configure'));

app.listen(PORT, '0.0.0.0', () => console.log(`Cinema VIP Stream v${VERSION} on :${PORT}`));