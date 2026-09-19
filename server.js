#!/usr/bin/env node
// Cinema VIP Stream — Stremio addon (zero-dependency Node.js 18+)
// Uses free embed APIs: VidSrc, 2Embed, SuperEmbed, VidFast, EmbedSu, MoviesAPI
// Stream-only: no catalogs, no bandwidth — streams open in browser via embed players

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const VERSION = '1.0.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const TMDB_BASE = 'https://api.themoviedb.org/3';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ─── Providers ──────────────────────────────────────────────────────────────
// Each provider: { name, icon, movie(id), tv(id,s,e) }
// All return externalUrl — the embed page plays in the user's browser

const PROVIDERS = [
  {
    name: 'VidSrc',
    icon: '🎬',
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: 'VidSrc.me',
    icon: '📺',
    movie: (id) => `https://vidsrcme.ru/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrcme.ru/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: '2Embed',
    icon: '🎞️',
    movie: (id) => `https://www.2embed.cc/embed/movie/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: 'SuperEmbed',
    icon: '▶️',
    movie: (id) => `https://multiembed.mov/?video_id=${id}`,
    tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&s=${s}&e=${e}`,
  },
  {
    name: 'VidFast',
    icon: '⚡',
    movie: (id) => `https://vidfast.vc/movie/${id}`,
    tv: (id, s, e) => `https://vidfast.vc/tv/${id}/${s}/${e}`,
  },
  {
    name: 'EmbedSu',
    icon: '🌐',
    movie: (id) => `https://www.embed.su/embed/movie/${id}`,
    tv: (id, s, e) => `https://www.embed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    name: 'MoviesAPI',
    icon: '🎥',
    movie: (id) => `https://moviesapi.to/movie/${id}`,
    tv: (id, s, e) => `https://moviesapi.to/tv/${id}-${s}-${e}`,
  },
  {
    name: 'VidLink',
    icon: '🔗',
    movie: (id) => `https://vidlink.pro/movie/${id}`,
    tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function htmlPage(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function fetchJSON(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ─── Metadata (Cinemeta — free, no auth) ────────────────────────────────────

async function getMeta(type, id) {
  const r = await fetchJSON(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`);
  if (!r?.meta) return null;
  return {
    title: r.meta.name || '',
    year: String(r.meta.year || '').slice(0, 4),
    poster: r.meta.poster || '',
  };
}

// ─── Stream builder ─────────────────────────────────────────────────────────

function buildStreams(type, id, se, ep) {
  const streams = [];
  for (const p of PROVIDERS) {
    const url = type === 'series' ? p.tv(id, se, ep) : p.movie(id);
    streams.push({
      name: `[ CinemaVIP ] ${p.icon} ${p.name}`,
      externalUrl: url,
    });
  }
  return streams;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

function manifest() {
  return {
    id: 'com.cinemavip.stream',
    version: VERSION,
    name: 'Cinema VIP Stream',
    description: 'Free movie & TV streams from VidSrc, 2Embed, SuperEmbed, VidFast, EmbedSu, MoviesAPI, VidLink. Zero bandwidth — streams play directly in your browser.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = (u.pathname || '/').replace(/\/+$/, '') || '/';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (p === '/' || p === '') {
      return htmlPage(res, `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cinema VIP Stream</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#161b22;border:1px solid #232a33;border-radius:16px;padding:40px;max-width:520px;width:90%;text-align:center}
h1{font-size:28px;color:#e50914;margin-bottom:8px}p{color:#888;line-height:1.6;margin-bottom:16px}
a.b{display:inline-block;background:#e50914;color:#fff;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:600;text-decoration:none}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0;text-align:left}
.f{background:#0a0a0b;border:1px solid #232a33;border-radius:10px;padding:10px 12px;font-size:13px;color:#c9d1d9}
.f b{color:#e6e9ef}.ft{font-size:12px;color:#444;margin-top:20px}
</style></head><body><div class="c">
<h1>🎬 Cinema VIP Stream</h1>
<p>Free movie &amp; TV streams from 8 providers.<br>Zero bandwidth — video plays directly in your browser.</p>
<div class="grid">
<div class="f"><b>🎬 VidSrc</b> — Original embed API</div>
<div class="f"><b>📺 VidSrc.me</b> — Mirror</div>
<div class="f"><b>🎞️ 2Embed</b> — Reliable embed</div>
<div class="f"><b>▶️ SuperEmbed</b> — Multi-server</div>
<div class="f"><b>⚡ VidFast</b> — Fast player</div>
<div class="f"><b>🌐 EmbedSu</b> — Clean embed</div>
<div class="f"><b>🎥 MoviesAPI</b> — API player</div>
<div class="f"><b>🔗 VidLink</b> — Direct link</div>
</div>
<a class="b" href="stremio://${(req.headers.host || 'localhost')}/manifest.json">Install in Stremio</a>
<p class="ft">v${VERSION} · stream-only addon · idPrefixes tt</p>
</div></body></html>`);
    }

    if (p === '/manifest.json' || p === '/manifest') {
      return json(res, manifest());
    }

    // Stream route
    const sm = p.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (sm) {
      const type = sm[1];
      const id = sm[2];
      const se = parseInt(u.searchParams.get('s') || u.searchParams.get('season') || '1', 10);
      const ep = parseInt(u.searchParams.get('e') || u.searchParams.get('episode') || '1', 10);

      if (!id.startsWith('tt')) return json(res, { streams: [] });

      const streams = buildStreams(type, id, se, ep);
      return json(res, { streams });
    }

    if (p === '/health') {
      return json(res, {
        status: 'ok',
        version: VERSION,
        providers: PROVIDERS.length,
        uptime: Math.round(process.uptime()),
      });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    console.error('ERR:', e.message);
    json(res, { error: 'internal' }, 500);
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

http.createServer(route).listen(PORT, '0.0.0.0', () => {
  console.log(`Cinema VIP Stream v${VERSION} listening on :${PORT}`);
});