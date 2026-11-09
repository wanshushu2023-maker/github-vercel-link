// 本地预览服务器：静态文件 + 用 Vercel 相同的 handler 签名模拟 /api/*
// 用法: node scripts/dev-server.mjs [--port 4317]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : process.env.PORT || 4317);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    const payload = JSON.stringify(body);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.end(payload);
    return res;
  };
  res.send = (body) => { res.end(body); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  decorate(res);
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\/+$/, '');
    if (!/^[a-z0-9_-]+$/i.test(name)) return res.status(404).json({ ok: false, error: 'Not Found' });
    const file = path.join(ROOT, 'api', name + '.js');
    try {
      await fs.access(file);
      const handler = require(file);
      return handler(req, res);
    } catch (err) {
      console.error('[api]', err.message);
      return res.status(404).json({ ok: false, error: 'Not Found', detail: err.message });
    }
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return res.status(403).end('Forbidden');

  try {
    const body = await fs.readFile(file);
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(body);
  } catch {
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('local preview ready: http://127.0.0.1:' + PORT);
});
