#!/usr/bin/env node
// Cinema VIP Stream — Stremio addon v3.0.0
// Native HLS via VaPlayer API + VidSrc WASM decryption
// All providers return m3u8 for in-app Stremio playback
// Works with IMDb-based catalogs (Cinemeta, etc.)

'use strict';

import express from 'express';

const app = express();
const VERSION = '3.0.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ─── VidSrc WASM Decryption ─────────────────────────────────────────────────
const wasmCache = { module: null, windowKey: null };

async function decryptVidsrcStreams(encryptedB64, wasmUrl) {
  try {
    // Download and compile WASM (cached per window key)
    const windowKey = wasmUrl.match(/w=(\d+)/)?.[1] || 'default';
    if (!wasmCache.module || wasmCache.windowKey !== windowKey) {
      const resp = await fetch(wasmUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': UA },
      });
      if (!resp.ok) throw new Error(`WASM fetch failed: ${resp.status}`);
      const wasmBytes = Buffer.from(await resp.arrayBuffer());
      wasmCache.module = await WebAssembly.compile(wasmBytes);
      wasmCache.windowKey = windowKey;
    }

    const inst = await WebAssembly.instantiate(wasmCache.module, {});
    const ex = inst.exports;
    const enc = Buffer.from(encryptedB64, 'base64');
    const ptr = ex.alloc(enc.length);
    new Uint8Array(ex.memory.buffer, ptr, enc.length).set(enc);
    const outLen = ex.decrypt(ptr, enc.length);
    const result = Buffer.from(ex.memory.buffer, ptr + 12, outLen).toString('utf8');
    return result.split('\n').filter(s => s.trim());
  } catch (e) {
    console.error('VidSrc decrypt error:', e.message);
    return [];
  }
}

// ─── VidSrc API — fetches encrypted m3u8 and decrypts via WASM ──────────────
async function getVidsrcStreams(imdbId, type, season, episode) {
  const streams = [];
  try {
    const apiType = type === 'series' ? 'tv' : 'movie';
    let apiUrl = `https://data.vidsrc.sh/api.php?type=${apiType}&imdb=${imdbId}&stream_urls`;
    if (type === 'series' && season && episode) {
      apiUrl += `&season=${season}&episode=${episode}`;
    }

    const resp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': 'https://cloudorchestranova.com/',
      },
    });
    if (!resp.ok) return streams;

    const data = await resp.json();
    const encrypted = data?.data?.stream_urls;
    const wasmUrl = data?.vs?.wasm_url;

    if (typeof encrypted === 'string' && wasmUrl) {
      const urls = await decryptVidsrcStreams(encrypted, wasmUrl);
      for (let i = 0; i < urls.length; i++) {
        streams.push({
          name: `[ CinemaVIP ] 🎬 VidSrc HLS`,
          title: `Server ${i + 1} · Plays in Stremio app`,
          url: urls[i],
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                Referer: 'https://cloudorchestranova.com/',
                'User-Agent': UA,
              },
            },
          },
        });
      }
    }
  } catch (e) {
    console.error('VidSrc failed:', e.message);
  }
  return streams;
}

// ─── VaPlayer API — direct m3u8 ─────────────────────────────────────────────
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

    const resp = await fetch(`${VA_API}?${params.toString()}`, {
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': UA, Referer: referer, Origin: VA_ORIGIN },
    });
    if (!resp.ok) return streams;

    const json = await resp.json();
    if (json.status_code !== '200' && json.status_code !== 200) return streams;

    const urls = json.data?.stream_urls || [];
    for (let i = 0; i < urls.length; i++) {
      streams.push({
        name: `[ CinemaVIP ] ▶️ VaPlayer HLS`,
        title: `Server ${i + 1} · Plays in Stremio app`,
        url: urls[i],
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              Referer: `${VA_ORIGIN}/`,
              'User-Agent': UA,
            },
          },
        },
      });
    }
  } catch (e) {
    console.error('VaPlayer failed:', e.message);
  }
  return streams;
}

// ─── Embed providers (browser fallbacks) ────────────────────────────────────
const PROVIDERS = [
  { name: 'VidSrc.to',   build: (p) => p.type === 'series'
    ? `https://vidsrc.to/embed/tv/${p.imdbId}/${p.season}-${p.episode}`
    : `https://vidsrc.to/embed/movie/${p.imdbId}` },
  { name: 'VidSrc.me',   build: (p) => p.type === 'series'
    ? `https://vidsrcme.ru/embed/tv/${p.imdbId}/${p.season}-${p.episode}`
    : `https://vidsrcme.ru/embed/movie/${p.imdbId}` },
  { name: '2Embed',      build: (p) => p.type === 'series'
    ? `https://www.2embed.cc/embed/tv/${p.imdbId}/${p.season}-${p.episode}`
    : `https://www.2embed.cc/embed/movie/${p.imdbId}` },
  { name: 'SuperEmbed',  build: (p) => p.type === 'series'
    ? `https://multiembed.mov/?video_id=${p.imdbId}&s=${p.season}&e=${p.episode}`
    : `https://multiembed.mov/?video_id=${p.imdbId}` },
  { name: 'VidFast',     build: (p) => p.type === 'series'
    ? `https://vidfast.vc/embed/tv/${p.imdbId}/${p.season}-${p.episode}`
    : `https://vidfast.vc/embed/movie/${p.imdbId}` },
  { name: 'EmbedSu',     build: (p) => p.type === 'series'
    ? `https://www.embed.su/embed/tv/${p.imdbId}/${p.season}-${p.episode}`
    : `https://www.embed.su/embed/movie/${p.imdbId}` },
  { name: 'MoviesAPI',   build: (p) => p.type === 'series'
    ? `https://moviesapi.to/tv/${p.imdbId}-${p.season}-${p.episode}`
    : `https://moviesapi.to/movie/${p.imdbId}` },
  { name: 'VidLink',     build: (p) => p.type === 'series'
    ? `https://vidlink.pro/tv/${p.imdbId}/${p.season}/${p.episode}`
    : `https://vidlink.pro/movie/${p.imdbId}` },
];

// ─── Stream ID parser ───────────────────────────────────────────────────────
function parseStreamId(rawId) {
  const decoded = decodeURIComponent(rawId).replace(/\.json$/, '');
  const parts = decoded.split(':');
  const imdbId = parts[0];
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  if (parts.length === 1) return { type: 'movie', imdbId };
  if (parts.length === 3) {
    const season = Number(parts[1]);
    const episode = Number(parts[2]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
    return { type: 'series', imdbId, season, episode };
  }
  return null;
}

// ─── Manifest ───────────────────────────────────────────────────────────────
const MANIFEST = {
  id: 'com.cinemavip.stream',
  version: VERSION,
  name: 'Cinema VIP Stream',
  description: 'Free movie & TV streams — all native HLS playback in Stremio app. VidSrc + VaPlayer WASM decryption. Works with all IMDb catalogs.',
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

app.get('/manifest.json', (req, res) => res.json(MANIFEST));

app.get('/configure', (req, res) => {
  const host = req.headers.host || 'localhost';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cinema VIP Stream — Install</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#161b22;border:1px solid #232a33;border-radius:16px;padding:40px;max-width:520px;width:90%;text-align:center}
h1{font-size:28px;color:#e50914;margin-bottom:8px}p{color:#888;line-height:1.6;margin-bottom:16px}
a.b{display:inline-block;background:#e50914;color:#fff;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;text-decoration:none}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0;text-align:left}
.f{background:#0a0a0b;border:1px solid #232a33;border-radius:10px;padding:10px 12px;font-size:13px;color:#c9d1d9}
.f b{color:#e6e9ef}.ft{font-size:12px;color:#444;margin-top:20px}
.native{background:#1a3a1a;border-color:#2a5a2a}
</style></head><body><div class="c">
<h1>🎬 Cinema VIP Stream v${VERSION}</h1>
<p><b>ALL streams play in Stremio app</b> — no browser needed.<br>VidSrc WASM + VaPlayer HLS decryption.</p>
<div class="grid">
<div class="f native"><b>🎬 VidSrc HLS</b> — 3 servers</div>
<div class="f native"><b>▶️ VaPlayer HLS</b> — 3 servers</div>
</div>
<a class="b" href="stremio://${host}/manifest.json">⬇️ Install in Stremio</a>
<p class="ft">v${VERSION} · 6 native HLS streams · IMDb compatible</p>
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

    // Run VidSrc and VaPlayer in parallel
    const [vidsrcStreams, vaplayerStreams] = await Promise.all([
      getVidsrcStreams(imdbId, type, season, episode),
      getVaPlayerStreams(imdbId, type, season, episode),
    ]);

    const streams = [...vidsrcStreams, ...vaplayerStreams];

    // Browser fallbacks (only if no native streams found)
    if (streams.length === 0) {
      for (const p of PROVIDERS) {
        streams.push({
          name: `[ CinemaVIP ] ${p.name}`,
          title: 'Opens in browser',
          externalUrl: p.build(parsed),
          behaviorHints: { notWebReady: true },
        });
      }
    }

    return res.json({ streams });
  } catch (e) {
    console.error('Stream error:', e.message);
    return res.json({ streams: [] });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: VERSION, uptime: Math.round(process.uptime()) });
});

app.get('/', (req, res) => res.redirect('/configure'));

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cinema VIP Stream v${VERSION} on :${PORT}`);
});// v3.0.0 deployed
