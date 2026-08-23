import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUsage, readCosts } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerAdmin(app, { token, username = '', password = '' }) {
  if (!token) {
    app.log.warn('Admin panel disabled: set ADMIN_TOKEN in .env');
    return;
  }

  function authorized(req) {
    const provided = (req.query.token || req.headers['x-admin-token'] || req.query.admin_token) || '';
    return provided === token;
  }
  function deny(reply) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  // Login: exchange username+password for the admin token (sent in the body).
  // If ADMIN_USER/ADMIN_PASS are set, they gate access; otherwise token is required directly.
  app.post('/api/admin/login', async (req, reply) => {
    const { u, p } = req.body || {};
    if (username && password) {
      if (u === username && p === password) {
        return reply.send({ ok: true, token });
      }
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    // No user/pass configured — just echo whether a token was supplied.
    if (u === token || p === token) return reply.send({ ok: true, token });
    return reply.code(401).send({ error: 'Invalid credentials' });
  });

  // Token-protected usage endpoint (all links + comments + AI usage).
  app.get('/api/admin/usage', async (req, reply) => {
    if (!authorized(req)) return deny(reply);
    const data = readUsage({
      platform: req.query.platform || null,
      days: Number(req.query.days) || 90,
      limit: Math.min(Number(req.query.limit) || 2000, 10000),
    });
    return reply.send(data);
  });

  // Token-protected cost endpoint (Apify + DeepSeek spend per session).
  app.get('/api/admin/costs', async (req, reply) => {
    if (!authorized(req)) return deny(reply);
    const data = readCosts({
      days: Number(req.query.days) || 30,
      limit: Math.min(Number(req.query.limit) || 500, 5000),
    });
    return reply.send(data);
  });

  // Admin usage page (shell only — data fetched via token-protected /api/admin/*).
  app.get('/admin', async (req, reply) => {
    try {
      reply.type('text/html').send(fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'));
    } catch (e) {
      return reply.code(500).send('admin.html missing');
    }
  });

  // Admin costs page (shell only).
  app.get('/admin/costs', async (req, reply) => {
    try {
      reply.type('text/html').send(fs.readFileSync(path.join(__dirname, 'admin-costs.html'), 'utf8'));
    } catch (e) {
      return reply.code(500).send('admin-costs.html missing');
    }
  });
}
