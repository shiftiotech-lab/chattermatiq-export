/**
 * Reddit comment fetcher — via Reddit's OAuth (application-only) API.
 *
 * Reddit blocks the public JSON endpoint from datacenter IPs, but the OAuth
 * client-credentials flow (free app registration) is NOT blocked and returns
 * the full comment tree for a public post. No user scopes needed.
 */

/**
 * Parse a Reddit URL into post context.
 * Accepts: /r/<sub>/comments/<id>/<slug>, comments/<id>, /<sub>/comments/<id>/
 * Returns { subreddit?, postId } or null.
 */
export function extractRedditUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const allowed = host.endsWith('reddit.com') || host === 'redd.it';
  if (!allowed) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  // redd.it/<id> short link
  if (host === 'redd.it') {
    const id = segs[0];
    if (id) return { postId: id };
  }
  // /r/<sub>/comments/<postid>/<slug>  OR  /comments/<postid>
  const ci = segs.indexOf('comments');
  if (ci >= 0 && segs[ci + 1]) {
    let subreddit = null;
    if (ci >= 2 && segs[ci - 2] === 'r') subreddit = segs[ci - 1];
    return { subreddit, postId: segs[ci + 1] };
  }
  return null;
}

/**
 * Fetch comments for a Reddit post via OAuth.
 * @param {object} o { subreddit?, postId, token, userAgent, maxComments }
 * @returns {Promise<{title, subreddit, url, comments, hasMore, truncated}>}
 */
export async function fetchRedditThread({ postId, token, userAgent, maxComments = 1000 }) {
  if (!postId || !token) throw new Error('Missing Reddit post id or token');

  const url = `https://oauth.reddit.com/comments/${postId}?limit=100&raw_json=1&showmore=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
  });
  if (res.status === 401) throw new Error('Reddit token invalid or expired — re-register the app / refresh token.');
  if (res.status === 403) throw new Error('Reddit denied access from this network.');
  if (!res.ok) {
    let msg = `Reddit API error ${res.status}`;
    try { const b = await res.json(); msg = b?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();

  // data[0] = post listing, data[1] = comments listing
  const post = data?.[0]?.data?.children?.[0]?.data;
  const commentTree = data?.[1]?.data?.children || [];
  const title = post?.title || null;
  const subreddit = post?.subreddit || null;
  const permalink = post?.permalink || null;

  const comments = [];
  let hasMore = false;

  // Walk the comment tree (replies come nested under data.replies).
  const walk = (children, depth) => {
    for (const child of children) {
      if (child.kind === 't1' && child.data) {
        const d = child.data;
        const c = {
          id: d.id ? `t1_${d.id}` : null,
          author: d.author || '[deleted]',
          text: d.body || '',
          timestamp: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
          likes: typeof d.score === 'number' ? d.score : 0,
          replies: [],
        };
        comments.push(c);
        const replies = d.replies?.data?.children || [];
        if (replies.length) {
          const before = comments.length;
          walk(replies, depth + 1);
          // Attach the nested replies (in order) to this comment.
          c.replies = comments.slice(before);
        }
        if (d.count && d.count > 0) hasMore = true;
        if (comments.length >= maxComments) return;
      } else if (child.kind === 'more') {
        hasMore = true;
      }
    }
  };
  walk(commentTree, 0);

  const truncated = comments.length >= maxComments;

  return {
    title,
    subreddit,
    url: permalink ? `https://www.reddit.com${permalink}` : `https://www.reddit.com/comments/${postId}`,
    comments,
    hasMore,
    truncated,
  };
}