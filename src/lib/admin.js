import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUsage } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerAdmin(app, { token }) {
  if (!token) {
    app.log.warn('Admin panel disabled: set ADMIN_TOKEN in .env');
    return;
  }

  // Token-protected JSON endpoint.
  app.get('/api/admin/usage', async (req, reply) => {
    const provided = req.query.token || req.headers['x-admin-token'];
    if (!provided || provided !== token) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const data = readUsage({
      platform: req.query.platform || null,
      days: Number(req.query.days) || 90,
      limit: Math.min(Number(req.query.limit) || 2000, 10000),
    });
    return reply.send(data);
  });

  // Admin page (served from admin.html in this dir).
  app.get('/admin', async (req, reply) => {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
      return reply.type('text/html').send(html);
    } catch (e) {
      return reply.code(500).send('admin.html missing');
    }
  });
}