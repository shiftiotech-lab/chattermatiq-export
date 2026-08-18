/**
 * Normalized comment-source registry.
 *
 * Every platform adapter returns the SAME shape:
 *   {
 *     platform: 'youtube' | 'instagram' | 'facebook' | 'x' | 'linkedin' | 'reddit',
 *     source: { title, channel?, url, platformLabel },
 *     comments: [ { id, author, text, timestamp?, likes?, replies: [...] } ],
 *     truncated, hasMore
 *   }
 *
 * The CSV export and DeepSeek analysis consume only this shape, so a new
 * platform = adding one adapter here; nothing downstream changes.
 */

import { extractVideoId, fetchComments, fetchVideoMeta } from './youtube.js';
import { runActor } from './apify.js';

/** Detect which platform a URL points to. Returns lowercase platform id or null. */
export function detectPlatform(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim().toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com') || u.includes('instagr.am')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('facebook')) return 'facebook';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x';
  if (u.includes('linkedin.com')) return 'linkedin';
  if (u.includes('reddit.com') || u.includes('redd.it')) return 'reddit';
  return null;
}

/**
 * Fetch a preview (small sample).
 * @returns normalized source object
 */
export async function fetchPreview(url, env) {
  const platform = detectPlatform(url);
  switch (platform) {
    case 'youtube': return youtubePreview(url, env);
    case 'instagram': return apifyPreview(url, env, 'instagram');
    case 'facebook': return apifyPreview(url, env, 'facebook');
    case 'x': return apifyPreview(url, env, 'x');
    case 'linkedin': return apifyPreview(url, env, 'linkedin');
    case 'reddit': return apifyPreview(url, env, 'reddit');
    default:
      throw new Error(
        `Platform not recognized: ${platform || 'this URL'}. ` +
        'We support YouTube, Instagram, Facebook, X, LinkedIn, and Reddit.'
      );
  }
}

/**
 * Fetch all comments for export.
 */
export async function fetchAll(url, env, maxResults = 1000) {
  const platform = detectPlatform(url);
  switch (platform) {
    case 'youtube': return youtubeAll(url, env, maxResults);
    case 'instagram': return apifyAll(url, env, 'instagram', maxResults);
    case 'facebook': return apifyAll(url, env, 'facebook', maxResults);
    case 'x': return apifyAll(url, env, 'x', maxResults);
    case 'linkedin': return apifyAll(url, env, 'linkedin', maxResults);
    case 'reddit': return apifyAll(url, env, 'reddit', maxResults);
    default:
      throw new Error(
        `Platform not recognized: ${platform || 'this URL'}. ` +
        'We support YouTube, Instagram, Facebook, X, LinkedIn, and Reddit.'
      );
  }
}

// ---------- YouTube (free, official Data API) ----------

async function youtubePreview(url, env) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Please provide a valid YouTube URL.');
  const [meta, { comments }] = await Promise.all([
    fetchVideoMeta({ videoId, apiKey: env.YOUTUBE_API_KEY }),
    fetchComments({ videoId, apiKey: env.YOUTUBE_API_KEY, maxResults: 15 }),
  ]);
  return norm('youtube', { title: meta.title, channel: meta.channel, url: meta.url }, comments.slice(0, 15));
}

async function youtubeAll(url, env, maxResults) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Please provide a valid YouTube URL.');
  const limit = Math.min(Math.max(Number(maxResults) || 1000, 1), 10000);
  const [meta, result] = await Promise.all([
    fetchVideoMeta({ videoId, apiKey: env.YOUTUBE_API_KEY }),
    fetchComments({ videoId, apiKey: env.YOUTUBE_API_KEY, maxResults: limit }),
  ]);
  return norm('youtube', { title: meta.title, channel: meta.channel, url: meta.url }, result.comments);
}

// ---------- Apify-powered platforms (Instagram, Facebook, X, LinkedIn, Reddit) ----------

const APIFY_ACTORS = {
  instagram: { actor: 'apify/instagram-comment-scraper', input: (url) => ({ directUrls: [url] }) },
  facebook: { actor: 'apify/facebook-comments-scraper', input: (url) => ({ startUrls: [{ url }], includeNestedComments: true, viewOption: 'RANKED_UNFILTERED' }) },
  x: { actor: 'apidojo/twitter-replies-scraper', input: (url) => ({ urls: [url] }) },
  linkedin: { actor: 'apimaestro/linkedin-post-comments-replies-engagements-scraper-no-cookies', input: (url) => ({ url }) },
  reddit: { actor: 'newbs/reddit-comment-scraper', input: (url) => ({ postUrls: [url] }) },
};

const PLATFORM_LABEL = {
  instagram: 'Instagram', facebook: 'Facebook', x: 'X/Twitter',
  linkedin: 'LinkedIn', reddit: 'Reddit',
};

function requireApify(env) {
  const token = env.APIFY_TOKEN || '';
  if (!token) {
    throw new Error(
      'This platform is pulled via Apify. Add APIFY_TOKEN to .env ' +
      '(https://apify.com → Settings → Integrations).'
    );
  }
  return token;
}

async function runApify(platform, url, env, maxResults) {
  const token = requireApify(env);
  const cfg = APIFY_ACTORS[platform];
  const actorId = cfg.actor;
  const input = cfg.input(url);

  const items = await runActor({ actorId, input, token });

  // Normalize Apify item rows into the shared shape (fields vary by actor).
  const comments = items
    .map((it) => ({
      id: it.id || it.commentUrl || it.commentId || it.commentUrlPlatform || null,
      author: nameOf(it.commentAuthor)
        || nameOf(it.ownerUsername) || nameOf(it.owner?.username)
        || nameOf(it.author) || nameOf(it.authorName) || nameOf(it.profileName)
        || nameOf(it.user?.username) || nameOf(it.creatorName) || 'Unknown',
      text: it.commentText
        || it.text || it.comment || it.body || it.description || it.content || '',
      timestamp: it.commentTimestamp
        || it.timestamp || it.createdAt || it.date || it.publishedAt || null,
      likes: typeof it.commentScore === 'number' ? it.commentScore
        : (typeof it.likesCount === 'number' ? it.likesCount : it.likeCount ?? it.likes ?? 0),
      replies: arrayReplies(it),
    }))
    .filter((c) => c.text && c.text.trim());

  // Best-effort source title/channel from the first item.
  const first = items[0] || {};
  const title = first.postTitle || first.postOwnerUsername
    ? (first.postTitle || first.fullText || first.status || `Post @${first.postOwnerUsername}`)
    : null;
  const channel = first.subreddit ? `r/${first.subreddit}` : (first.postOwnerUsername ? `@${first.postOwnerUsername}` : null);

  return { comments, title, channel, url };
}

async function apifyPreview(url, env, platform) {
  const { comments, title, channel, url: srcUrl } = await runApify(platform, url, env, 20);
  return norm(platform, { title, channel, url: srcUrl }, comments.slice(0, 20));
}

async function apifyAll(url, env, platform, maxResults) {
  const limit = Math.min(Math.max(Number(maxResults) || 1000, 1), 10000);
  const { comments, title, channel, url: srcUrl } = await runApify(platform, url, env, limit);
  return norm(platform, { title, channel, url: srcUrl }, comments);
}

// ---------- shared normalizer ----------

function norm(platform, source, comments) {
  return {
    platform,
    source: {
      title: source.title || null,
      channel: source.channel || null,
      url: source.url || null,
      platformLabel: PLATFORM_LABEL[platform] || platform,
    },
    comments,
    truncated: comments.length > 0,
    hasMore: comments.length > 0,
  };
}

/** Handle reply arrays that differ across actors (IG 'replies[]', FB 'comments[]'). */
function arrayReplies(it) {
  const arr = Array.isArray(it.replies) ? it.replies : (Array.isArray(it.comments) ? it.comments : []);
  return arr.map((r) => ({
    id: r.id || r.commentUrl || r.commentId || null,
    author: nameOf(r.commentAuthor) || nameOf(r.ownerUsername) || nameOf(r.username)
      || nameOf(r.author) || nameOf(r.profileName) || 'Unknown',
    text: r.commentText || r.text || r.comment || '',
    timestamp: r.commentTimestamp || r.timestamp || r.createdAt || r.date || null,
    likes: typeof r.commentScore === 'number' ? r.commentScore
      : (typeof r.likesCount === 'number' ? r.likesCount : r.likeCount ?? 0),
  }));
}

/** Coerce an author field that may be a string, null, or an object `{name}`. */
function nameOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v.username || v.handle || '';
  return String(v);
}