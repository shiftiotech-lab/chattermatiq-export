import { extractVideoId } from './src/lib/youtube.js';
import { flattenComments, toCsv } from './src/lib/csv.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);