/**
 * Lemmy comment fetcher — via each instance's public API. No credentials, no
 * approval, no rate gate for light use. Lemmy is open-source/federated, so
 * comment data on public posts is freely readable.
 *
 * URL forms handled:
 *   https://<instance>/post/<id>            (canonical)
 *   https://<instance>/c/<community>/post/<id>
 *   https://<instance>/comment/<id>         (resolves to its post)
 *   lemmy.ml / lemm.ee / sh.itjust.works / lemmy.world / etc.
 */

/**
 * Extract { instance, postId } from a Lemmy post/comment URL. Returns null if
 * not a recognizable Lemmy URL.
 */
export function extractLemmyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  // All public Lemmy instances are subdomains of known TLDs; rather than a
  // huge allowlist, accept any host that has a /post/ or /comment/ path and is
  // NOT a known non-Lemmy platform.
  const host = u.hostname.toLowerCase();
  const blocked = ['youtube.com','youtu.be','reddit.com','redd.it','instagram.com',
    'facebook.com','fb.watch','tiktok.com','x.com','twitter.com','linkedin.com','github.com'];
  if (blocked.some((b) => host.endsWith(b) || host === b)) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  const pi = segs.indexOf('post');
  const ci = segs.indexOf('comment');
  if (pi >= 0 && segs[pi + 1]) return { instance: host, postId: segs[pi + 1] };
  if (ci >= 0 && segs[ci + 1]) return { instance: host, commentId: segs[ci + 1] };
  return null;
}

/**
 * Fetch comments for a Lemmy post.
 * @param {object} o { instance, postId, maxComments }
 * @returns {Promise<{title, community, instance, url, comments, hasMore}>}
 */
export async function fetchLemmyThread({ instance, postId, maxComments = 1000 }) {
  if (!instance || !postId) throw new Error('Missing Lemmy instance or post id');
  const api = `https://${instance}/api/v3`;

  // Post metadata (from the first comment_view's embedded post object — avoids a 2nd call)
  let postMeta = {};

  // Comments (flat list; Lemmy returns all depth levels).
  const comments = [];
  let page = 1;
  let total = 0;
  let hasMore = false;
  do {
    const cr = await fetch(
      `${api}/comment/list?post_id=${postId}&limit=50&page=${page}&max_depth=8&type=All`,
      { headers: { 'User-Agent': 'chattermatiq/0.1' } }
    );
    if (!cr.ok) {
      if (page === 1) throw new Error(`Lemmy API error ${cr.status}`);
      break;
    }
    const cd = await cr.json();
    const batch = cd.comments || [];
    if (batch.length === 0) break;
    // Grab post meta from the first comment view — it embeds {post, community}.
    if (!postMeta.title && batch[0]?.post) {
      postMeta.title = batch[0].post.name || null;
      postMeta.url = batch[0].post.ap_id || `https://${instance}/post/${postId}`;
      postMeta.originalInstance = batch[0].post.instance_id;
    }
    if (!postMeta.community && batch[0]?.community) {
      postMeta.community = batch[0].community.name || null;
    }
    for (const cv of batch) {
      if (comments.length >= maxComments) break;
      const cm = cv.comment || {};
      comments.push({
        id: cm.id ? `lemmy_${cm.id}` : null,
        author: cv.creator?.name || '[deleted]',
        text: cm.content || '',
        timestamp: cm.published || null,
        likes: typeof cv.counts?.score === 'number' ? cv.counts.score : 0,
        replies: [],
      });
    }
    total += batch.length;
    hasMore = batch.length === 50;
    page += 1;
    if (batch.length < 50) break;
  } while (hasMore && comments.length < maxComments);

  const truncated = comments.length >= maxComments;

  return {
    title: postMeta.title || `Post ${postId}`,
    community: postMeta.community,
    instance,
    url: postMeta.url || `https://${instance}/post/${postId}`,
    comments,
    hasMore,
    truncated,
  };
}