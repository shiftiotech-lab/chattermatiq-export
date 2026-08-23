/** CSV generation for comment exports. Plain RFC-4180-ish escaping, no deps. */

// Convert a timestamp to India Standard Time (Asia/Kolkata, UTC+05:30).
// Returns a clean, sortable local string, e.g. "2026-08-23 16:22:05 IST".
function toIst(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  // Asia/Kolkata has a fixed +05:30 offset (no DST).
  const ist = new Date(d.getTime() + 330 * 60000);
  return ist.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') + ' IST';
}

function esc(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Flatten comments (top-level + replies) into rows. */
export function flattenComments(comments) {
  const rows = [];
  for (const c of comments) {
    rows.push({
      Level: 'Top-level',
      CommentID: c.id || '',
      Author: c.author,
      CommentText: c.text,
      Timestamp: c.timestamp || '',
      Date: toIst(c.timestamp),
      Likes: c.likes,
      RepliesCount: c.replies ? c.replies.length : 0,
      ReplyTo: '',
    });
    for (const r of c.replies || []) {
      rows.push({
        Level: 'Reply',
        CommentID: r.id || '',
        Author: r.author,
        CommentText: r.text,
        Timestamp: r.timestamp || '',
        Date: toIst(r.timestamp),
        Likes: r.likes,
        RepliesCount: 0,
        ReplyTo: c.id || '',
      });
    }
  }
  return rows;
}

const HEADERS = [
  'Level', 'CommentID', 'Author', 'CommentText',
  'Timestamp', 'Date', 'Likes', 'RepliesCount', 'ReplyTo',
];
export { HEADERS };

/** @param {Array<object>} rows flattened rows */
export function toCsv(rows) {
  const lines = [HEADERS.map(esc).join(',')];
  for (const r of rows) {
    lines.push(HEADERS.map((h) => esc(r[h])).join(','));
  }
  return lines.join('\n');
}