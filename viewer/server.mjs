import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODELS_DIR = [path.join(__dirname, '..', 'stls'), path.join(__dirname, '..')]
  .find((dir) => fs.existsSync(dir));
const MODELS_DIR = path.resolve(process.argv[2] ?? DEFAULT_MODELS_DIR);
const STATIC_DIR = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function listModels() {
  const entries = await fsp.readdir(MODELS_DIR, { withFileTypes: true });
  const models = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.stl')) continue;
    const stat = await fsp.stat(path.join(MODELS_DIR, entry.name));
    models.push({ name: entry.name, size: stat.size });
  }
  models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return models;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function notFound(res) {
  send(res, 404, 'text/plain', 'Not found');
}

function insideDir(file, dir) {
  return file === dir || file.startsWith(dir + path.sep);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = decodeURIComponent(pathname);

    if (route === '/api/models') {
      const models = await listModels();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ dir: MODELS_DIR, models }));
      return;
    }

    if (route.startsWith('/models/')) {
      const name = path.basename(route.slice('/models/'.length));
      const file = path.join(MODELS_DIR, name);
      const stat = insideDir(file, MODELS_DIR) && path.extname(name).toLowerCase() === '.stl'
        ? await fsp.stat(file).catch(() => null)
        : null;
      if (!stat?.isFile()) return notFound(res);
      res.writeHead(200, {
        'content-type': 'model/stl',
        'content-length': stat.size,
        'cache-control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    const staticName = route === '/' ? 'index.html' : route.slice(1);
    const file = path.resolve(STATIC_DIR, staticName);
    const stat = insideDir(file, STATIC_DIR) ? await fsp.stat(file).catch(() => null) : null;
    if (!stat?.isFile()) return notFound(res);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 500, 'text/plain', `Server error: ${err.message}`);
  }
});

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const count = fs.readdirSync(MODELS_DIR).filter((n) => n.toLowerCase().endsWith('.stl')).length;
    console.log(`STL viewer running at http://localhost:${port}`);
    console.log(`Serving ${count} STL file(s) from ${MODELS_DIR}`);
    console.log('Press Ctrl+C to stop.');
  });
}

listen(Number(process.env.PORT ?? 4321), 10);
