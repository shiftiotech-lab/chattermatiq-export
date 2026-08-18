/**
 * Normalized comment-source registry.
 *
 * Every platform adapter returns the SAME shape:
 *   {
 *     platform: 'youtube' | 'reddit' | ...,
 *     source: { title, channel?, url, platformLabel },
 *     comments: [ { id, author, text, timestamp?, likes?, replies: [...] } ],
 *     truncated, hasMore
 *   }
 *
 * The CSV export and DeepSeek analysis both consume only this shape, so adding
 * a new platform = adding one adapter here, nothing else changes downstream.
 */

import { extractVideoId, fetchComments, fetchVideoMeta } from './youtube.js';
import { extractRedditUrl, fetchRedditThread } from './reddit.js';

/** Detect which platform a URL points to. Returns lowercase platform id or null. */
export function detectPlatform(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim().toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('reddit.com') || u.includes('redd.it') || u.includes('reddit')) return 'reddit';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x';
  if (u.includes('linkedin.com')) return 'linkedin';
  return null;
}

/**
 * Fetch a preview (small sample, no login required).
 * @returns normalized source object
 */
export async function fetchPreview(url, env) {
  const platform = detectPlatform(url);
  switch (platform) {
    case 'youtube':
      return youtubePreview(url, env);
    case 'reddit':
      return redditPreview(url, env);
    default:
      throw new Error(
        `Platform not yet supported: ${platform || 'unknown'}. ` +
        'We currently support YouTube and Reddit.'
      );
  }
}

/**
 * Fetch all comments for export.
 */
export async function fetchAll(url, env, maxResults = 1000) {
  const platform = detectPlatform(url);
  switch (platform) {
    case 'youtube':
      return youtubeAll(url, env, maxResults);
    case 'reddit':
      return redditAll(url, env, maxResults);
    default:
      throw new Error(
        `Platform not yet supported: ${platform || 'unknown'}. ` +
        'We currently support YouTube and Reddit.'
      );
  }
}

// ---------- YouTube adapters (already normalized by youtube.js, map to shape) ----------

async function youtubePreview(url, env) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Please provide a valid YouTube URL.');
  const [meta, { comments }] = await Promise.all([
    fetchVideoMeta({ videoId, apiKey: env.YOUTUBE_API_KEY }),
    fetchComments({ videoId, apiKey: env.YOUTUBE_API_KEY, maxResults: 15 }),
  ]);
  return {
    platform: 'youtube',
    source: {
      title: meta.title,
      channel: meta.channel,
      url: meta.url,
      platformLabel: 'YouTube',
    },
    comments: comments.slice(0, 15),
    truncated: comments.length >= 15,
    hasMore: comments.length >= 15,
  };
}

async function youtubeAll(url, env, maxResults) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Please provide a valid YouTube URL.');
  const limit = Math.min(Math.max(Number(maxResults) || 1000, 1), 10000);
  const [meta, result] = await Promise.all([
    fetchVideoMeta({ videoId, apiKey: env.YOUTUBE_API_KEY }),
    fetchComments({ videoId, apiKey: env.YOUTUBE_API_KEY, maxResults: limit }),
  ]);
  return {
    platform: 'youtube',
    source: { title: meta.title, channel: meta.channel, url: meta.url, platformLabel: 'YouTube' },
    comments: result.comments,
    truncated: result.truncated,
    hasMore: result.hasMore,
  };
}

// ---------- Reddit adapters (OAuth client-credentials, free after app registration) ----------

async function redditPreview(url, env) {
  const info = extractRedditUrl(url);
  if (!info) throw new Error('Please provide a valid Reddit post URL.');
  const { clientId, clientSecret, userAgent } = requireRedditAuth(env);
  const token = await getRedditToken({ clientId, clientSecret, userAgent });
  const result = await fetchRedditThread({ ...info, token, userAgent, maxComments: 20 });
  return {
    platform: 'reddit',
    source: {
      title: result.title,
      channel: result.subreddit ? `r/${result.subreddit}` : null,
      url: result.url,
      platformLabel: 'Reddit',
    },
    comments: result.comments.slice(0, 20),
    truncated: result.comments.length >= 20,
    hasMore: result.hasMore,
  };
}

async function redditAll(url, env, maxResults) {
  const info = extractRedditUrl(url);
  if (!info) throw new Error('Please provide a valid Reddit post URL.');
  const { clientId, clientSecret, userAgent } = requireRedditAuth(env);
  const token = await getRedditToken({ clientId, clientSecret, userAgent });
  const limit = Math.min(Math.max(Number(maxResults) || 1000, 1), 5000);
  const result = await fetchRedditThread({ ...info, token, userAgent, maxComments: limit });
  return {
    platform: 'reddit',
    source: {
      title: result.title,
      channel: result.subreddit ? `r/${result.subreddit}` : null,
      url: result.url,
      platformLabel: 'Reddit',
    },
    comments: result.comments,
    truncated: result.truncated,
    hasMore: result.hasMore,
  };
}

function requireRedditAuth(env) {
  const clientId = env.REDDIT_CLIENT_ID || '';
  const clientSecret = env.REDDIT_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    throw new Error(
      'Reddit requires a free app registration. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env ' +
      '(create one at https://www.reddit.com/prefs/apps → "script" app).'
    );
  }
  const userAgent = env.REDDIT_USER_AGENT || 'chattermatiq-export:v0.1 (by /u/manjyot)';
  return { clientId, clientSecret, userAgent };
}

export async function getRedditToken({ clientId, clientSecret, userAgent }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    let msg = `Reddit OAuth failed (${res.status})`;
    try { const b = await res.json(); msg = b?.error || b?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Reddit OAuth returned no access token');
  return data.access_token;
}