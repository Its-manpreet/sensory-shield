// Tiny static server for the browser demo pages (localhost only). Usage: npm run demo
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8765;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };

http
  .createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, path.normalize(url));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`demo: http://localhost:${PORT}/assets/demo-flash.html`));
