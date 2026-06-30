/**
 * Card Rewards Sync Worker
 * Cloudflare Worker + KV backend for the Card Rewards Optimizer.
 *
 * Environment variables (set via `wrangler secret put`):
 *   SYNC_SECRET  — Bearer token the app must send with every request
 *
 * KV binding (configured in wrangler.toml):
 *   REWARDS_KV   — KV namespace for storing sync state
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Auth check
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.SYNC_SECRET}`) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const { pathname } = new URL(request.url);

    if (pathname !== '/sync') {
      return json({ error: 'Not found' }, 404);
    }

    // GET /sync — return stored state
    if (request.method === 'GET') {
      const data = await env.REWARDS_KV.get('state', 'json');
      return json(data || {});
    }

    // PUT /sync — overwrite stored state
    if (request.method === 'PUT') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      await env.REWARDS_KV.put('state', JSON.stringify(body));
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  },
};
