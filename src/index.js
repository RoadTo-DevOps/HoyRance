import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMongoStore } from './storage/mongoStore.js';
import { handleApi } from './routes/api.js';
import { startMarketLoop } from './runtime/marketLoop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 5177);
const JSON_DB_PATH = path.join(ROOT, 'data', 'db.json');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function loadJsonSeed() {
  if (process.env.MONGODB_IMPORT_JSON_ON_EMPTY === 'false') return null;

  try {
    const text = await fs.readFile(JSON_DB_PATH, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read JSON seed at ${JSON_DB_PATH}: ${error.message}`);
    }
    return null;
  }
}

const store = await createMongoStore({
  seedState: await loadJsonSeed()
});
startMarketLoop(store);

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    await handleApi(req, res, store);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'API route not found', code: 'ROUTE_NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log(`Bainan API server running at http://localhost:${PORT}`);
  console.log(`MongoDB database: ${store.dbName}`);
});

async function shutdown() {
  server.close();
  await store.close?.();
}

process.once('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});

process.once('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});
