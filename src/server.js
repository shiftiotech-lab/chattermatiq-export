import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { extractVideoId, fetchComments, fetchVideoMeta } from './lib/youtube.js';
import { flattenComments, toCsv, HEADERS } from './lib/csv.js';

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
  version: '0.1.0',
}));

// Parse a URL -> video info + preview of real comments (no login needed for preview of first N).
app.post('/api/preview', async (req, reply) => {
  const { url } = req.body || {};
  const videoId = extractVideoId(url);
  if (!videoId) {
    return reply.code(400).send({ error: 'Please provide a valid YouTube URL.' });
  }
  if (!API_KEY) {
    return reply
      .code(500)
      .send({ error: 'Server not configured with a YouTube API key (YOUTUBE_API_KEY).' });
  }
  try {
    const [meta, { comments }] = await Promise.all([
      fetchVideoMeta({ videoId, apiKey: API_KEY }),
      fetchComments({ videoId, apiKey: API_KEY, maxResults: 15 }),
    ]);
    return { video: meta, comments: comments.slice(0, 15), truncated: comments.length >= 15 };
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: err.message });
  }
});

// Export all comments as CSV.
app.post('/api/export', async (req, reply) => {
  const { url, maxResults = 1000 } = req.body || {};
  const videoId = extractVideoId(url);
  if (!videoId) {
    return reply.code(400).send({ error: 'Please provide a valid YouTube URL.' });
  }
  if (!API_KEY) {
    return reply
      .code(500)
      .send({ error: 'Server not configured with a YouTube API key (YOUTUBE_API_KEY).' });
  }
  try {
    const limit = Math.min(Math.max(Number(maxResults) || 1000, 1), 10000);
    const [meta, result] = await Promise.all([
      fetchVideoMeta({ videoId, apiKey: API_KEY }),
      fetchComments({ videoId, apiKey: API_KEY, maxResults: limit }),
    ]);
    const rows = flattenComments(result.comments);
    const csv = toCsv(rows);
    const safeTitle = (meta.title || videoId).replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="comments_${safeTitle}.csv"`)
      .send(BOM + csv);
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: err.message });
  }
});

const BOM = '\uFEFF'; // UTF-8 BOM so Excel opens UTF-8 CSV correctly

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`ChattermatIQ export API listening on :${PORT}`);
});