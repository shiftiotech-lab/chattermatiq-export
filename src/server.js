import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { fetchPreview, fetchAll, detectPlatform } from './lib/sources.js';
import { flattenComments, toCsv, HEADERS } from './lib/csv.js';
import { analyzeWithDeepSeek } from './lib/deepseek.js';
import { logUsage, weeklyUsage } from './lib/usage.js';
import { registerAdmin } from './lib/admin.js';

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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
// Free-tier export cap: unauthenticated exports return at most this many comments.
const FREE_COMMENTS = Math.max(1, Number(process.env.FREE_COMMENTS) || 50);
// Per-user weekly quota (free tier). Paid/tiered users bypass via isPaid().
const WEEK_COMMENTS = Math.max(0, Number(process.env.WEEK_COMMENTS) || 100);
const WEEK_ANALYSES = Math.max(0, Number(process.env.WEEK_ANALYSES) || 20);

// User identity for usage tracking: prefer a persistent client id sent by the
// frontend (localStorage), fall back to the real client IP (via nginx proxy).
function identity(req) {
  const cid = (req.headers['x-client-id'] || '').trim();
  const fwd = (req.headers['x-forwarded-for'] || '').trim();
  const ip = (fwd.split(',')[0] || req.ip || '').trim();
  return { uid: cid || null, ip: ip || req.ip || null };
}

// A request is "paid" when it carries a valid paid entitlements token.
// Without any payment integration wired yet, this always returns false, so
// every user is on the FREE_COMMENTS cap. Flip on once Razorpay is integrated.
function isPaid(req) {
  return false;
}

// Enforce the free per-user weekly quota. Returns an error message if over quota,
// or null if the request may proceed.
function quotaError(req, forComments, forAnalysis) {
  if (isPaid(req)) return null;
  const { uid, ip } = identity(req);
  const w = weeklyUsage({ uid, ip });
  const roomComments = Math.max(0, WEEK_COMMENTS - w.comments);
  const roomAnalyses = Math.max(0, WEEK_ANALYSES - w.analyses);
  if (forComments > roomComments) {
    return `You've used your free quota (${w.comments}/${WEEK_COMMENTS} comments this week). Upgrade to keep exporting full threads.`;
  }
  if (forAnalysis && roomAnalyses < 1) {
    return `You've used your free AI analyses (${w.analyses}/${WEEK_ANALYSES}) this week. Upgrade to keep AI insights.`;
  }
  return null;
}

// GET /api/quota — report a user's current free-tier weekly allowance.
app.get('/api/quota', async (req) => {
  const { uid, ip } = identity(req);
  const w = weeklyUsage({ uid, ip });
  const paid = isPaid(req);
  return {
    paid,
    commentsUsed: w.comments,
    commentsLimit: paid ? null : WEEK_COMMENTS,
    analysesUsed: w.analyses,
    analysesLimit: paid ? null : WEEK_ANALYSES,
  };
});

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
  const { uid, ip } = identity(req);
  // Free weekly quota (comments + AI analyses).
  const blocked = quotaError(req, FREE_COMMENTS, true);
  if (blocked) {
    logUsage({ action: 'preview', platform: detectPlatform(url), url, status: 429, uid, ip, error: blocked.slice(0, 120) });
    return reply.code(429).send({ error: blocked, code: 'QUOTA' });
  }
  try {
    const result = await fetchPreview(url, process.env, FREE_COMMENTS);
    const comments = (result.comments || []).slice(0, FREE_COMMENTS);
    result.comments = comments;
    logUsage({ action: 'preview', platform: result.platform, url, comments: comments.length, status: 200, uid, ip, apifyCostUsd: result.costUsd || 0 });
    const ai = DEEPSEEK_KEY
      ? await analyzeWithDeepSeek({
          comments: result.comments,
          apiKey: DEEPSEEK_KEY,
          model: DEEPSEEK_MODEL,
          videoTitle: result.source.title,
          maxComments: comments.length, // analyze exactly what was fetched
        })
      : null;
    logUsage({ action: 'analysis', platform: result.platform, url, status: 200, uid, ip, ai: ai ? 'ok' : 'off', aiCostUsd: ai?.costUsd || 0, aiTokens: ai?.tokens || 0 });
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
    logUsage({ action: 'preview', platform: detectPlatform(url), url, status, uid, ip, error: err.message.slice(0, 120) });
    return reply.code(status).send({ error: err.message });
  }
});

// Export all comments as CSV (free tier capped at FREE_COMMENTS unless a paid key is supplied).
app.post('/api/export', async (req, reply) => {
  const { url, maxResults = 1000 } = req.body || {};
  const { uid, ip } = identity(req);
  // Paid tier: a valid entitlements key unlocks the full requested amount.
  const cap = isPaid(req) ? Number(maxResults) : Math.min(Number(maxResults), FREE_COMMENTS);
  // Free weekly quota: block if this would exceed the user's weekly comment budget.
  const blocked = quotaError(req, cap, false);
  if (blocked) {
    logUsage({ action: 'export', platform: detectPlatform(url), url, status: 429, uid, ip, error: blocked.slice(0, 120) });
    return reply.code(429).send({ error: blocked, code: 'QUOTA' });
  }
  try {
    const result = await fetchAll(url, process.env, cap);
    const srcUrl = result.source?.url || url;
    const rows = flattenComments(result.comments, srcUrl);
    const csv = toCsv(rows);
    logUsage({ action: 'export', platform: result.platform, url, comments: result.comments?.length || 0, status: 200, uid, ip, apifyCostUsd: result.costUsd || 0 });
    const safeTitle = (result.source.title || url).replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.platform}_${safeTitle}.csv"`)
      .send(BOM + csv);
  } catch (err) {
    app.log.error(err);
    const status = err.message.startsWith('Platform not yet supported') ? 501 : 502;
    logUsage({ action: 'export', platform: detectPlatform(url), url, status, uid, ip, error: err.message.slice(0, 120) });
    return reply.code(status).send({ error: err.message });
  }
});

const BOM = '\uFEFF'; // UTF-8 BOM so Excel opens UTF-8 CSV correctly

registerAdmin(app, { token: ADMIN_TOKEN, username: ADMIN_USER, password: ADMIN_PASS });

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`ChattermatIQ export API listening on :${PORT}`);
});