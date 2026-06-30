/**
 * Card Rewards Sync Worker
 * Cloudflare Worker + KV backend for the Card Rewards Optimizer.
 *
 * Environment variables (set via `wrangler secret put`):
 *   SYNC_SECRET        — Bearer token the app must send with every request
 *   MJ_APIKEY_PUBLIC   — Mailjet public API key (for /subscribe)
 *   MJ_APIKEY_PRIVATE  — Mailjet private API key (for /subscribe)
 *   FROM_EMAIL         — verified Mailjet sender address (for /subscribe)
 *
 * KV binding (configured in wrangler.toml):
 *   REWARDS_KV   — KV namespace for storing sync state
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

    // POST /subscribe — send a subscription-confirmation email via Mailjet
    if (pathname === '/subscribe') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const email = (body && body.email ? String(body.email) : '').trim();
      const name = (body && body.user ? String(body.user) : '').trim();

      // Basic email shape check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'Invalid email address' }, 400);
      }

      if (!env.MJ_APIKEY_PUBLIC || !env.MJ_APIKEY_PRIVATE || !env.FROM_EMAIL) {
        return json({ error: 'Email sending not configured' }, 500);
      }

      const greeting = name ? `Hi ${name},` : 'Hi there,';
      const payload = {
        Messages: [
          {
            From: { Email: env.FROM_EMAIL, Name: 'Card Rewards Optimizer' },
            To: [{ Email: email, Name: name || email }],
            Subject: 'Your subscription is confirmed',
            TextPart:
              `${greeting}\n\n` +
              `This confirms that ${email} is now subscribed to ` +
              `Card Rewards Optimizer benefit-change notifications.\n\n` +
              `If you didn't request this, you can safely ignore this email.`,
            HTMLPart:
              `<p>${greeting}</p>` +
              `<p>This confirms that <strong>${email}</strong> is now subscribed to ` +
              `<strong>Card Rewards Optimizer</strong> benefit-change notifications.</p>` +
              `<p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>`,
          },
        ],
      };

      const mjAuth = btoa(`${env.MJ_APIKEY_PUBLIC}:${env.MJ_APIKEY_PRIVATE}`);
      let mjRes;
      try {
        mjRes = await fetch('https://api.mailjet.com/v3.1/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${mjAuth}`,
          },
          body: JSON.stringify(payload),
        });
      } catch {
        return json({ error: 'Failed to reach mail provider' }, 502);
      }

      if (!mjRes.ok) {
        const detail = await mjRes.text().catch(() => '');
        return json({ error: 'Mail provider error', detail }, 502);
      }

      return json({ ok: true, sent: email });
    }

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
