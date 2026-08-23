/**
 * DeepSeek insight layer (via OpenRouter, OpenAI-compatible).
 * Takes real comments and returns structured insight: sentiment, themes,
 * objections, and content recommendations. Falls back to null on any failure
 * so the caller can use keyword sentiment instead — never crashes the request.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * @param {object} opts
 * @param {Array<object>} opts.comments  real comments (author, text, likes, timestamp)
 * @param {string} opts.apiKey           OpenRouter/DeepSeek key
 * @param {string} opts.model            e.g. "deepseek/deepseek-chat"
 * @param {string|undefined} opts.videoTitle
 * @param {number} [opts.maxComments]    cap on comments sent to the model (token cost)
 * @returns {Promise<object|null>} { sentiment, themes, objections, recommendations }
 */
export async function analyzeWithDeepSeek({
  comments,
  apiKey,
  model,
  videoTitle,
  maxComments = 300,
}) {
  if (!apiKey || !model) return null;
  if (!Array.isArray(comments) || comments.length === 0) return null;

  // Downsample: prioritize by likes so the loudest voices are represented.
  const text = comments
    .slice()
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, maxComments)
    .map((c) => c.text)
    .filter(Boolean);

  if (text.length === 0) return null;

  const system = [
    'You are an expert social-media audience analyst.',
    'You are given real YouTube comments and produce a concise, honest strategic summary.',
    'Reply with STRICT JSON only, no markdown, no commentary:',
    '{"sentiment":{"positive":<0..100>,"neutral":<0..100>,"negative":<0..100>},"themes":["<short theme>",...],"objections":["<specific concern>",...],"top_requests":["<thing viewers want>",...],"recommendations":["<1 short action for the creator>",...]}',
    'sentiment percentages must sum to 100.',
    'themes: 3-5 recurring topics/emotions in the comments.',
    'objections: real concerns/criticisms people raised (empty array if none).',
    'top_requests: what viewers are asking for.',
    'recommendations: 2-3 concrete next steps for the video creator.',
    'Be specific to the actual comments, do not invent.',
  ].join(' ');

  const user = JSON.stringify({
    video_title: videoTitle || null,
    comments: text,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000); // hard 25s cap

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      console.error(`[deepseek] API error ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    // Parse defensively: strip any stray markdown fences.
    const cleaned = content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate + coerce sentiment.
    let s = parsed.sentiment || {};
    const pos = clampNum(s.positive);
    const neg = clampNum(s.negative);
    const neu = clampNum(s.neutral);
    const sum = pos + neg + neu || 1;
    const sentiment = {
      positive: Math.round((pos / sum) * 100),
      neutral: Math.round((neu / sum) * 100),
      negative: 100 - Math.round((pos / sum) * 100) - Math.round((neu / sum) * 100),
    };

    return {
      sentiment,
      themes: asStrArray(parsed.themes),
      objections: asStrArray(parsed.objections),
      topRequests: asStrArray(parsed.top_requests),
      recommendations: asStrArray(parsed.recommendations),
      sampleSize: comments.length, // exact count analyzed (matches fetched count)
    };
  } catch (err) {
    console.error('[deepseek] analyze error:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clampNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}
function asStrArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
}