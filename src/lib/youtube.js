/**
 * YouTube comment fetcher — uses the official YouTube Data API v3.
 * Real comments: author, text, published timestamp, like count, and threaded replies.
 */

const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Extract a YouTube video ID from many URL formats:
 *   https://www.youtube.com/watch?v=ID
 *   https://youtu.be/ID
 *   https://www.youtube.com/shorts/ID
 *   https://www.youtube.com/embed/ID
 * Returns null if not a recognized YouTube URL.
 */
export function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, '');
    if (!host.includes('youtube.com') && host !== 'youtu.be') return null;

    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/')[1] || '';
      return id.length === 11 ? id : null;
    }
    const v = parsed.searchParams.get('v');
    if (v && v.length === 11) return v;
    // /shorts/ID, /embed/ID, /live/ID, /v/ID
    const m = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})$/);
    if (m) return m[1];
    // bare /ID
    const bare = parsed.pathname.split('/').filter(Boolean)[0];
    if (bare && bare.length === 11) return bare;
    return null;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch all top-level comments (with threaded replies) for a video.
 * @param {object} opts { videoId, apiKey, maxResults?, part? }
 * @returns {Promise<{video:object, comments:Array, truncated:boolean, quotaUsed:number}>}
 */
export async function fetchComments({ videoId, apiKey, maxResults = 200, perPage = 50 }) {
  if (!videoId) throw new Error('Missing videoId');
  if (!apiKey) throw new Error('Missing YouTube API key');

  const comments = [];
  let nextPageToken = '';
  let quotaUsed = 0;

  // First call also fetches video title/channel metadata in the same quota allotment
  // (separate call, quota 1 unit).
  const params = new URLSearchParams({
    part: 'snippet,replies',
    textFormat: 'plainText',
    maxResults: String(Math.min(perPage, 100)),
    videoId,
    key: apiKey,
  });

  do {
    if (nextPageToken) params.set('pageToken', nextPageToken);
    const url = `${YT_API}/commentThreads?${params.toString()}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`Network error contacting YouTube: ${err.message}`);
    }
    quotaUsed += 1;
    if (res.status === 403) {
      let msg = 'YouTube quota exceeded or access denied';
      try {
        const body = await res.json();
        msg = body?.error?.message || msg;
      } catch {}
      throw new Error(msg);
    }
    if (!res.ok) {
      let msg = `YouTube API error ${res.status}`;
      try {
        const body = await res.json();
        msg = body?.error?.message || msg;
      } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    for (const item of data.items || []) {
      const sn = item.snippet || {};
      const top = sn.topLevelComment?.snippet || {};

      const comment = {
        id: item.id || top.id || null,
        author: top.authorDisplayName || 'Unknown',
        text: top.textOriginal || '',
        timestamp: top.publishedAt || null,       // ISO 8601
        likes: top.likeCount ?? 0,
        replies: [],
      };

      // Threaded replies (from 'replies' in this response — only included when
      // part=snippet,replies and threads are loaded).
      for (const rep of item.replies?.comments || []) {
        const r = rep.snippet || {};
        comment.replies.push({
          id: rep.id || null,
          author: r.authorDisplayName || 'Unknown',
          text: r.textOriginal || '',
          timestamp: r.publishedAt || null,
          likes: r.likeCount ?? 0,
        });
      }
      comments.push(comment);
    }
    nextPageToken = data.nextPageToken || '';
    // Be gentle with quota / rate limits.
    await delay(200);
  } while (nextPageToken && comments.length < maxResults);

  const truncated = Boolean(nextPageToken) && comments.length >= maxResults;

  return {
    videoId,
    comments,
    truncated,
    hasMore: Boolean(nextPageToken),
    nextPageToken: nextPageToken || null,
    quotaUsed,
  };
}

/** Fetch video metadata (title, channel, url) — 1 quota unit. */
export async function fetchVideoMeta({ videoId, apiKey }) {
  const url = `${YT_API}/videos?part=snippet&id=${videoId}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `YouTube API error ${res.status}`;
    try { msg = (await res.json())?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  const it = (data.items || [])[0]?.snippet || {};
  return {
    videoId,
    title: it.title || null,
    channel: it.channelTitle || null,
    publishedAt: it.publishedAt || null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}