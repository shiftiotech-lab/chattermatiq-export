/**
 * Lightweight, zero-dependency usage tracking (append-only JSONL log).
 * Records every preview/export request so the admin panel can show who
 * (user/client), which platform, and which link they extracted.
 * A real DB can replace this later; this survives crashes and needs no setup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG = path.join(DATA_DIR, 'usage.jsonl');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Appends one usage row. Never throws — logging must not break a request. */
export function logUsage(entry) {
  try {
    ensureStore();
    const row = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
  } catch (e) {
    // swallow: analytics must never take down the API
  }
}

/**
 * Read + aggregate usage for the admin panel.
 * @param {object} o { platform?, days?, limit? }
 */
export function readUsage({ platform = null, days = 90, limit = 2000 } = {}) {
  ensureStore();
  const empty = { rows: [], summary: { total: 0, byPlatform: {}, byDay: {}, byUser: {} } };
  if (!fs.existsSync(LOG)) return empty;

  const cutoff = Date.now() - days * 86400000;
  const all = [];
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (new Date(r.ts).getTime() >= cutoff) all.push(r);
    } catch { /* bad line */ }
  }

  let filtered = all;
  if (platform) {
    filtered = filtered.filter((r) => {
      if (platform === 'error') return r.status && r.status >= 400;
      return r.platform === platform;
    });
  }

  const byPlatform = {}, byDay = {}, byUser = {};
  for (const r of filtered) {
    byPlatform[r.platform || 'unknown'] = (byPlatform[r.platform || 'unknown'] || 0) + 1;
    const d = (r.ts || '').slice(0, 10);
    if (d) byDay[d] = (byDay[d] || 0) + 1;
    const k = r.uid || r.ip || 'anon';
    byUser[k] = (byUser[k] || 0) + 1;
  }

  const rows = [...filtered].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
  return {
    rows,
    summary: { total: filtered.length, byPlatform, byDay, byUser },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Weekly per-user quota consumption.
 * Sums exported+previewed comments and AI analyses for a user over the last 7 days.
 * Uses the same logUsage log — no separate DB.
 * @param {object} o { uid, ip }
 * @returns {object} { comments, analyses, windowStart }
 */
export function weeklyUsage({ uid, ip = '' } = {}) {
  ensureStore();
  const key = (uid && uid !== 'anon') ? uid : ip;
  if (!key) return { comments: 0, analyses: 0, windowStart: null };
  if (!fs.existsSync(LOG)) return { comments: 0, analyses: 0, windowStart: null };

  const days = 7;
  const cutoff = Date.now() - days * 86400000;
  let comments = 0, analyses = 0, windowStart = null;
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ts = new Date(r.ts).getTime();
      if (isNaN(ts)) continue;
      const rkey = (r.uid && r.uid !== 'anon') ? r.uid : r.ip;
      if (rkey !== key) continue;
      if (ts < cutoff) continue;
      if (!windowStart) windowStart = r.ts;
      if (r.action === 'export' || r.action === 'preview') {
        comments += Number(r.comments) || 0;
      } else if (r.action === 'analysis') {
        analyses += 1;
      }
    } catch { /* bad line */ }
  }
  return { comments, analyses, windowStart };
}

/**
 * Aggregate Apify + DeepSeek spend per session (user/IP) over a window.
 * Sums apifyCostUsd (preview/export) and aiCostUsd (analysis) rows.
 * @param {object} o { days?, limit? }
 * @returns {object} { rows: [{user, apifyUsd, aiUsd, totalUsd, requests, analyses}], summary:{apifyUsd, aiUsd, totalUsd} }
 */
export function readCosts({ days = 30, limit = 500 } = {}) {
  ensureStore();
  const empty = { rows: [], summary: { apifyUsd: 0, aiUsd: 0, totalUsd: 0 } };
  if (!fs.existsSync(LOG)) return empty;

  const cutoff = Date.now() - days * 86400000;
  const agg = {}; // user -> {apify, ai, req, ana}
  let totalApify = 0, totalAi = 0;

  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ts = new Date(r.ts).getTime();
      if (isNaN(ts) || ts < cutoff) continue;
      const key = (r.uid && r.uid !== 'anon') ? ('u:' + r.uid) : ('ip:' + (r.ip || 'anon'));
      const u = agg[key] || (agg[key] = { apify: 0, ai: 0, req: 0, ana: 0 });
      u.req++;
      const apc = Number(r.apifyCostUsd) || 0;
      const aic = Number(r.aiCostUsd) || 0;
      if (r.action === 'analysis' || aic > 0) { u.ai += aic; u.ana++; }
      else { u.apify += apc; }
      // keep total regardless of action
      if (r.action === 'analysis') totalAi += aic;
      else if (apc > 0) totalApify += apc;
    } catch { /* bad line */ }
  }

  const rows = Object.entries(agg)
    .map(([user, v]) => ({
      user, apifyUsd: round2(v.apify), aiUsd: round2(v.ai),
      totalUsd: round2(v.apify + v.ai), requests: v.req, analyses: v.ana,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, limit);

  return { rows, summary: { apifyUsd: round2(totalApify), aiUsd: round2(totalAi), totalUsd: round2(totalApify + totalAi) } };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }