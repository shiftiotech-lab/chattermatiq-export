import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { fetchPreview, fetchAll } from './lib/sources.js';
import { flattenComments, toCsv, HEADERS } from './lib/csv.js';
import { analyzeWithDeepSeek } from './lib/deepseek.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

// Load env vars from .env (tiny own loader, no deps)
const envPath = join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const API_KEY = process.env.YOUTUBE_API_KEY || '';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat';

// --- Static frontend (built Vite app, if present) ---
const DIST = join(__dirname, '..', 'dist');
fs.existsSync(DIST) &&
  app.register(async (srv) => {
    await srv.register(import('@fastify/static'), { root: DIST });
    srv.setNotFoundHandler((req, reply) => {
      if (req.raw.url.startsWith('/api')) {
        reply.code(404).send({ error: 'Not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  });

// --- GET /api/health ---
app.get('/api/health', async () => ({
  status: 'ok',
  hasApiKey: Boolean(API_KEY),
  aiEnabled: Boolean(DEEPSEEK_KEY),
  version: '0.1.0',
}));

// Parse a URL -> platform info + preview of real comments (no login needed for preview of first N).
app.post('/api/preview', async (req, reply) => {
  const { url } = req.body || {};
  try {
    const result = await fetchPreview(url, process.env);
    const ai = DEEPSEEK_KEY
      ? await analyzeWithDeepSeek({
          comments: result.comments,
          apiKey: DEEPSEEK_KEY,
          model: DEEPSEEK_MODEL,
          videoTitle: result.source.title,
          maxComments: 15,
        })
      : null;
    return {
      platform: result.platform,
      video: result.source,
      comments: result.comments,
      truncated: result.truncated,
      ai,
    };
  } catch (err) {
    app.log.error(err);
    const status = err.message.startsWith('Platform not yet supported') ? 501 : 502;
    return reply.code(status).send({ error: err.message });
  }
});

// Export all comments as CSV.
app.post('/api/export', async (req, reply) => {
  const { url, maxResults = 1000 } = req.body || {};
  try {
    const result = await fetchAll(url, process.env, maxResults);
    const rows = flattenComments(result.comments);
    const csv = toCsv(rows);
    const safeTitle = (result.source.title || url).replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.platform}_${safeTitle}.csv"`)
      .send(BOM + csv);
  } catch (err) {
    app.log.error(err);
    const status = err.message.startsWith('Platform not yet supported') ? 501 : 502;
    return reply.code(status).send({ error: err.message });
  }
});

const BOM = '\uFEFF'; // UTF-8 BOM so Excel opens UTF-8 CSV correctly

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`ChattermatIQ export API listening on :${PORT}`);
});