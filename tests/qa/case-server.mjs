// case-server.mjs - a tiny static server that behaves like GitHub Pages: file names are matched
// letter for letter (a wrong-case URL is a 404 even on Windows), and the folder it serves can sit
// above the repository so the game is reachable at /<repo-folder>/ as on a sub-path.
//
//   import { startCaseServer } from './case-server.mjs';
//   const s = await startCaseServer(rootDir);  // s.url, s.requests, s.close()
//
// Only for the QA scripts; it listens on 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

/** Resolves url path segments under root with exact-case matching; null when any segment differs or is missing. */
export function resolveExact(root, urlPath) {
  let dir = root;
  const segs = urlPath.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '..' || segs[i] === '.') return null;
    let list;
    try { list = fs.readdirSync(dir); } catch { return null; }
    if (!list.includes(segs[i])) return null;
    dir = path.join(dir, segs[i]);
  }
  try {
    if (fs.statSync(dir).isDirectory()) {
      const idx = path.join(dir, 'index.html');
      return fs.existsSync(idx) ? idx : null;
    }
  } catch { return null; }
  return dir;
}

export async function startCaseServer(root) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = resolveExact(root, u);
    requests.push({ url: u, status: f ? 200 : 404 });
    if (!f) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}
