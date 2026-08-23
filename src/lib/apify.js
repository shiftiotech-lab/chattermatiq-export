/**
 * Apify client — runs an Actor (e.g. instagram-comment-scraper), waits for it,
 * reads the output dataset, and normalizes results into the shared comment shape.
 */
const API = 'https://api.apify.com/v2';

/** Apify run-start API requires actor IDs as `owner~name` (slashes 404). */
function actorIdKey(actorId) {
  return actorId.replace('/', '~');
}

async function startActor(actorId, input, token) {
  const url = `${API}/acts/${actorIdKey(actorId)}/runs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let msg = `Apify failed to start ${actorId} (${res.status})`;
    try { msg = (await res.json())?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return (await res.json()).data; // { id, status, defaultDatasetId }
}

async function pollRunStatus(runId, token) {
  const res = await fetch(`${API}/actor-runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Apify status check failed (${res.status})`);
  return (await res.json()).data;
}

async function getDatasetItems(datasetId, token, limit = 500, offset = 0) {
  const res = await fetch(
    `${API}/datasets/${datasetId}/items?format=json&limit=${limit}&offset=${offset}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Apify dataset read failed (${res.status})`);
  return res.json();
}

/**
 * Run an actor and block until it finishes, returning the dataset items.
 * @param {object} o { actorId, input, token, timeoutMs }
 */
export async function runActor({ actorId, input, token, timeoutMs = 180000 }) {
  const run = await startActor(actorId, input, token);
  const runId = run.id;
  const datasetId = run.defaultDatasetId;
  const start = Date.now();

  // Poll until SUCCEEDED / FAILED / TIMED-OUT.
  let runMeta = null;
  for (;;) {
    const st = await pollRunStatus(runId, token);
    if (st.status === 'SUCCEEDED') { runMeta = st; break; }
    if (['FAILED', 'TIMED-OUT', 'ABORTED'].includes(st.status)) {
      throw new Error(`Apify actor ${actorId} ${st.status}: ${st.stats?.errorMessage || ''}`.trim());
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Apify actor ${actorId} timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Drain the dataset (paginate).
  const items = [];
  let offset = 0;
  for (;;) {
    const batch = await getDatasetItems(datasetId, token, 500, offset);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    offset += batch.length;
    if (batch.length < 500) break;
  }

  return { items, costUsd: Number(runMeta?.usageTotalUsd) || 0 };
}