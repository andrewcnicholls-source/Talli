/* =====================================================================
   Serve the repository root as Cloudflare Pages would: static files,
   "/admin" finding admin.html, and the Pages Functions in functions/ for
   the routes _routes.json gives them (plan A2). Bound to 127.0.0.1 only.
   For the browser suite; nothing in production runs this.

   The functions are the real files, called through the same handlers
   their onRequestGet calls. The one difference is the project they read:
   in production that comes from the hostname, and 127.0.0.1 would mean
   the hosted test project, which the suites must never touch. So this
   passes the local stack instead.

       node tests/lib/serve.js [port]
   ===================================================================== */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function resolve(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const candidates = [p, p + '.html'];
  for (const c of candidates) {
    const full = path.normalize(path.join(ROOT, c));
    // Nothing outside the repository, and nothing that is not the site.
    if (!full.startsWith(ROOT + path.sep)) return null;
    if (/[\\/](node_modules|\.git|supabase|tests|scripts|docs)[\\/]/.test(full.slice(ROOT.length))) return null;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

let site;
async function functionRoute(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = url.pathname.match(/^\/events\/?$|^\/events\/([^/]+)\/?$|^\/sitemap\.xml$/);
  const go = url.pathname.match(/^\/go\/?$|^\/go\/([^/]+)\/?$/);
  if (go && req.method === 'GET') {
    if (!site) site = await import(pathToFileURL(path.join(ROOT, 'functions', '_lib', 'site.js')).href);
    const { stack } = require('./stack');
    const project = { name: 'local', supabaseUrl: stack.apiUrl, anonKey: stack.anonKey };
    const request = new Request(url);
    const answer = go[1] ? await site.handlePlace(request, project, decodeURIComponent(go[1]))
      : site.handleGoIndex(request, project);
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
    return true;
  }
  if (!m || req.method !== 'GET') return false;
  // A file URL, not a path: on Windows import() refuses a bare C:\ path.
  if (!site) site = await import(pathToFileURL(path.join(ROOT, 'functions', '_lib', 'site.js')).href);
  const { stack } = require('./stack');
  const project = { name: 'local', supabaseUrl: stack.apiUrl, anonKey: stack.anonKey };
  const request = new Request(url);
  const answer = url.pathname === '/sitemap.xml' ? await site.handleSitemap(request, project)
    : m[1] ? await site.handleSeries(request, project, decodeURIComponent(m[1]))
    : await site.handleCatalogue(request, project);
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  res.end(Buffer.from(await answer.arrayBuffer()));
  return true;
}

http.createServer(async (req, res) => {
  try {
    if (await functionRoute(req, res)) return;
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(e)); return;
  }
  const file = resolve(req.url);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
