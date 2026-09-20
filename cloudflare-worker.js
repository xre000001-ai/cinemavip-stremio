// Cloudflare Worker — VixSrc Proxy for Stremio Addon
// 
// HOW TO DEPLOY:
// 1. Go to https://dash.cloudflare.com
// 2. Login (free account is fine)
// 3. Click "Workers & Pages" in left sidebar
// 4. Click "Create Application" → "Create Worker"
// 5. Name it anything (e.g., "vixsrc-proxy")
// 6. Replace ALL code with this file's content
// 7. Click "Deploy"
// 8. Copy the URL (e.g., https://vixsrc-proxy.your-name.workers.dev)
// 9. Repeat for as many workers as you want (different names)
//
// Each worker = 100,000 free requests/day
// 3 workers = 300,000 requests/day (more than enough)

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response(JSON.stringify({ 
        error: 'Missing ?url= parameter',
        usage: '?url=https://vixsrc.to/api/movie/tt0111161',
        worker: 'vixsrc-proxy',
        version: '1.0.0'
      }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Only allow vixsrc.to domains
    if (!target.includes('vixsrc.to')) {
      return new Response(JSON.stringify({ error: 'Only vixsrc.to allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const resp = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Referer': 'https://vixsrc.to/',
          'Origin': 'https://vixsrc.to',
          'Accept': '*/*'
        },
        redirect: 'follow'
      });

      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') || 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};