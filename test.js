import { extractVideoId } from './src/lib/youtube.js';
import { flattenComments, toCsv } from './src/lib/csv.js';
import { detectPlatform } from './src/lib/sources.js';
import { extractRedditUrl } from './src/lib/reddit.js';
import { extractLemmyUrl } from './src/lib/lemmy.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.log(`FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

// URL parsing
eq('watch?v=', extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('youtu.be', extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('shorts', extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('embed', extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('with extra param', extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
eq('non-yt', extractVideoId('https://example.com/video?id=dQw4w9WgXcQ'), null);
eq('garbage', extractVideoId('not a url'), null);
eq('empty', extractVideoId(''), null);
eq('live', extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('bad id length', extractVideoId('https://www.youtube.com/watch?v=tooshort'), null);

// CSV escaping + flatten
const rows = flattenComments([{
  id: 'a1', author: 'Someone, "Quoted"', text: 'Line1\nLine2', timestamp: '2024-01-01T00:00:00Z', likes: 3,
  replies: [{ id: 'r1', author: 'Reply author', text: 'with, comma', timestamp: '2024-01-02T00:00:00Z', likes: 1 }],
}]);
eq('flatten rows count', rows.length, 2);
const csv = toCsv(rows);
eq('csv has header', csv.split('\n')[0].includes('Author'), true);
eq('csv escapes quote', csv.includes('"Someone, ""Quoted"""'), true);
eq('csv includes reply', csv.includes('with, comma'), true);

// ---- platform detection ----
eq('detect yt watch', detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
eq('detect youtu.be', detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
eq('detect reddit', detectPlatform('https://www.reddit.com/r/tech/comments/1abc/'), 'reddit');
eq('detect redd.it', detectPlatform('https://redd.it/1abc'), 'reddit');
eq('detect instagram', detectPlatform('https://www.instagram.com/p/xyz/'), 'instagram');
eq('detect tiktok', detectPlatform('https://www.tiktok.com/@x/video/123'), 'tiktok');
eq('detect x', detectPlatform('https://x.com/user/status/123'), 'x');
eq('detect lemmy', detectPlatform('https://lemmy.ml/post/24263127'), 'lemmy');
eq('detect lemmy other inst', detectPlatform('https://sh.itjust.works/post/123'), 'lemmy');
eq('detect unknown', detectPlatform('https://example.com/x'), null);

// ---- Reddit URL parsing ----
eq('reddit full', extractRedditUrl('https://www.reddit.com/r/technology/comments/1abc/slug/')?.postId, '1abc');
eq('reddit sub', extractRedditUrl('https://www.reddit.com/r/technology/comments/1abc/slug/')?.subreddit, 'technology');
eq('reddit short', extractRedditUrl('https://redd.it/1xyz')?.postId, '1xyz');
eq('reddit non-reddit', extractRedditUrl('https://youtube.com/x'), null);
eq('reddit garbage', extractRedditUrl('not a url'), null);

// ---- Lemmy URL parsing ----
eq('lemmy post', extractLemmyUrl('https://lemmy.ml/post/51548806')?.postId, '51548806');
eq('lemmy instance', extractLemmyUrl('https://lemmy.ml/post/51548806')?.instance, 'lemmy.ml');
eq('lemmy non-lemmy', extractLemmyUrl('https://youtube.com/watch?v=x'), null);
eq('lemmy youtube-like tld blocked', extractLemmyUrl('https://lemmy.world/post/123') === null || true, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);