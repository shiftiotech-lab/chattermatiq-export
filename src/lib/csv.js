/** CSV generation for comment exports. Plain RFC-4180-ish escaping, no deps. */

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
      Date: c.timestamp ? new Date(c.timestamp).toISOString() : '',
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
        Date: r.timestamp ? new Date(r.timestamp).toISOString() : '',
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