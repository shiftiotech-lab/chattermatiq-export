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