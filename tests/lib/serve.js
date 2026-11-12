/* =====================================================================
   Serve the repository root as Cloudflare Pages would: static files, and
   "/admin" finding admin.html. Bound to 127.0.0.1 only. For the browser
   suite; nothing in production runs this.

       node tests/lib/serve.js [port]
   ===================================================================== */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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

http.createServer((req, res) => {
  const file = resolve(req.url);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
