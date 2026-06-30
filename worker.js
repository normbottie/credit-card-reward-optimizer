/**
 * Card Rewards Sync Worker
 * Cloudflare Worker + KV backend for the Card Rewards Optimizer.
 *
 * Responsibilities:
 *   1. Cross-device sync          — GET/PUT /sync
 *   2. Subscription confirmation  — POST /subscribe
 *   3. Card-data overlay          — GET /overrides   (app merges over cards.json)
 *   4. Weekly benefit check       — scheduled() cron + GET /run-check (manual)
 *   5. Admin approve / dismiss    — GET/POST /review  (HMAC-token gated)
 *
 * Secrets (set via `wrangler secret put`):
 *   SYNC_SECRET        — Bearer token the app sends with /sync, /overrides, /run-check
 *   MJ_APIKEY_PUBLIC   — Mailjet public API key
 *   MJ_APIKEY_PRIVATE  — Mailjet private API key
 *   ANTHROPIC_API_KEY  — Claude API key (benefit detection)
 *   APPROVAL_SECRET    — HMAC key that signs approve/dismiss links
 *   FROM_EMAIL         — optional; defaults to cards@norm.network
 *
 * Vars (wrangler.toml [vars]):
 *   CARDS_URL    — URL of the live cards.json   (default https://rewards.norm.network/cards.json)
 *   APP_URL      — app URL for the "Open app" button (default https://rewards.norm.network)
 *   PUBLIC_BASE  — this worker's public base URL, used to build review links
 *   CLAUDE_MODEL — model id (default claude-sonnet-5)
 *   BATCH_SIZE   — cards per Claude request (default 8)
 *
 * KV binding (wrangler.toml):
 *   REWARDS_KV   — namespace for state, overrides, pending, checklog
 *
 * KV keys:
 *   state      — sync state { users: { Name: { cards, email, admin, ... } }, ... }
 *   overrides  — { rewards: { card: { cat: {r,n} } }, perks: { card: { fee, base } }, lastUpdated }
 *   pending    — { runId, generatedAt, changes: [ {id, card, type, category, old, new, note, source, sourceTitle, status} ] }
 *   checklog   — [ { runId, at, detected, error } ]   (most recent 20)
 */

const FROM_NAME = 'Card Rewards Optimizer';
const TEAL = '#2aaa9c';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const CATEGORIES = [
  'Dining', 'Travel', 'Groceries', 'Gas', 'Streaming', 'Online Shopping',
  'Hotels', 'Drugstore', 'Transit', 'Entertainment', 'Home Improvement', 'General',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fromEmail(env) {
  return (env.FROM_EMAIL && String(env.FROM_EMAIL).trim()) || 'cards@norm.network';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ── HMAC helpers (sign / verify approval links) ───────────────────
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function signChange(env, runId, changeId, action) {
  return hmacHex(env.APPROVAL_SECRET, `${runId}:${changeId}:${action}`);
}

// ── KV accessors ──────────────────────────────────────────────────
async function getState(env) {
  return (await env.REWARDS_KV.get('state', 'json')) || {};
}
async function getOverrides(env) {
  return (await env.REWARDS_KV.get('overrides', 'json')) || { rewards: {}, perks: {}, lastUpdated: null };
}
async function getPending(env) {
  return await env.REWARDS_KV.get('pending', 'json');
}
async function logRun(env, entry) {
  const log = (await env.REWARDS_KV.get('checklog', 'json')) || [];
  log.unshift(entry);
  await env.REWARDS_KV.put('checklog', JSON.stringify(log.slice(0, 20)));
}

// Merge overrides over base cards data to get the current "known" values.
function applyOverrides(base, overrides) {
  const rewards = JSON.parse(JSON.stringify(base.rewards || {}));
  const perks = JSON.parse(JSON.stringify(base.perks || {}));
  for (const card in (overrides.rewards || {})) {
    rewards[card] = Object.assign({}, rewards[card] || {}, overrides.rewards[card]);
  }
  for (const card in (overrides.perks || {})) {
    perks[card] = Object.assign({}, perks[card] || {}, overrides.perks[card]);
  }
  return { banks: base.banks || {}, rewards, perks };
}

// ── Claude benefit detection ──────────────────────────────────────
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Build the compact "known values" payload for a set of card names.
function snapshotCards(cards, current) {
  return cards.map((card) => {
    const r = current.rewards[card] || {};
    const p = current.perks[card] || {};
    const rates = {};
    CATEGORIES.forEach((c) => { if (r[c] && r[c].r) rates[c] = r[c].r; });
    return { card, fee: p.fee || null, base: p.base || null, rates };
  });
}

function extractJsonArray(text) {
  if (!text) return [];
  // Prefer a fenced ```json block; else the last [...] in the text.
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  let raw = m ? m[1] : null;
  if (!raw) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) raw = text.slice(start, end + 1);
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function callClaudeBatch(env, cardSnapshot) {
  const model = env.CLAUDE_MODEL || 'claude-sonnet-5';
  const sys =
    'You are a credit-card benefits auditor. For each card you are given its CURRENTLY ' +
    'RECORDED reward rates, annual fee, and base reward. Use web search to verify each ' +
    'against the issuer\'s current published terms (prefer the issuer site, then reputable ' +
    'sources like nerdwallet.com, thepointsguy.com, creditcards.com). Report ONLY values ' +
    'that have clearly and verifiably changed. Be conservative: if uncertain or sources ' +
    'conflict, do not report it. Never invent values.\n\n' +
    'Return ONLY a fenced ```json block containing an array. Each element:\n' +
    '{ "card": string (exact name as given),\n' +
    '  "type": "rate" | "fee" | "base",\n' +
    '  "category": string (required when type=="rate", one of the given categories),\n' +
    '  "old": string (the recorded value),\n' +
    '  "new": string (the corrected value, same format as old, e.g. "3x points", "$325/year", "2% cash back"),\n' +
    '  "note": string (short human note for the change),\n' +
    '  "source_url": string,\n' +
    '  "source_title": string }\n' +
    'If nothing changed, return [].';
  const userMsg =
    'Audit these cards. Recorded values:\n\n```json\n' +
    JSON.stringify(cardSnapshot, null, 2) +
    '\n```';

  const messages = [{ role: 'user', content: userMsg }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }];

  // Server-side tool loop: keep re-sending while stop_reason === 'pause_turn'.
  let text = '';
  for (let i = 0; i < 4; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 4096, system: sys, tools, messages }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    (data.content || []).forEach((b) => { if (b.type === 'text') text += b.text + '\n'; });
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    break;
  }
  return extractJsonArray(text);
}

// Returns array of normalized change objects (no ids/tokens yet).
async function detectChanges(env, opts = {}) {
  const cardsUrl = env.CARDS_URL || 'https://rewards.norm.network/cards.json';
  const baseRes = await fetch(cardsUrl, { cf: { cacheTtl: 0 } });
  if (!baseRes.ok) throw new Error(`Failed to fetch cards.json (${baseRes.status})`);
  const base = await baseRes.json();
  const overrides = await getOverrides(env);
  const current = applyOverrides(base, overrides);

  let allCards = Object.keys(current.rewards);

  // Test mode: skip Claude, synthesize one change so the email + approval path
  // can be verified deterministically. Triggered by /run-check?test=1.
  if (opts.test) {
    const card = allCards[0];
    const curP = current.perks[card] || {};
    return {
      detected: [{
        card,
        type: 'fee',
        category: null,
        old: curP.fee || '(unknown)',
        new: 'TEST $0/year',
        note: 'Synthetic test change — safe to dismiss.',
        source: 'https://example.com/test',
        sourceTitle: 'test source',
      }],
      totalCards: allCards.length,
    };
  }

  if (opts.limit && opts.limit > 0) allCards = allCards.slice(0, opts.limit); // testing: cap card count
  const batchSize = parseInt(env.BATCH_SIZE, 10) || 8;
  const detected = [];

  for (const grp of chunk(allCards, batchSize)) {
    const snap = snapshotCards(grp, current);
    let raw;
    try {
      raw = await callClaudeBatch(env, snap);
    } catch (e) {
      // Skip this batch on error but keep going with the rest.
      console.log('batch error:', e.message);
      continue;
    }
    for (const c of raw) {
      if (!c || !c.card || !c.type || !c.new) continue;
      if (!current.rewards[c.card] && !current.perks[c.card]) continue; // unknown card
      if (c.type === 'rate' && !c.category) continue;
      // Drop if recorded value already equals the proposed value (no real change).
      const cur = current.rewards[c.card] || {};
      const curP = current.perks[c.card] || {};
      let oldVal = c.old;
      if (c.type === 'rate') oldVal = (cur[c.category] && cur[c.category].r) || c.old;
      else if (c.type === 'fee') oldVal = curP.fee || c.old;
      else if (c.type === 'base') oldVal = curP.base || c.old;
      if (String(oldVal).trim() === String(c.new).trim()) continue;
      detected.push({
        card: c.card,
        type: c.type,
        category: c.type === 'rate' ? c.category : null,
        old: oldVal || '(unknown)',
        new: String(c.new).trim(),
        note: c.note || '',
        source: c.source_url || '',
        sourceTitle: c.source_title || (c.source_url ? c.source_url.replace(/^https?:\/\//, '').split('/')[0] : ''),
      });
    }
  }
  return { detected, totalCards: allCards.length };
}

// ── Email building (matches email-template.html) ──────────────────
function changeRow(label, oldVal, newVal) {
  return (
    '<table cellpadding="0" cellspacing="0" style="margin-bottom:6px;"><tr>' +
    `<td style="font-size:13px;color:#6b7280;padding-right:8px;">${esc(label)}</td>` +
    `<td style="font-size:13px;color:#dc2626;font-weight:500;padding-right:8px;text-decoration:line-through;">${esc(oldVal)}</td>` +
    '<td style="font-size:13px;color:#6b7280;padding-right:8px;">&rarr;</td>' +
    `<td style="font-size:13px;color:#16a34a;font-weight:500;">${esc(newVal)}</td>` +
    '</tr></table>'
  );
}

function changeLabel(ch) {
  if (ch.type === 'fee') return 'Annual fee';
  if (ch.type === 'base') return 'Base reward';
  return ch.category || 'Rate';
}

function sourceLink(ch) {
  if (!ch.source) return '';
  return `<a href="${esc(ch.source)}" style="font-size:12px;color:${TEAL};text-decoration:none;">📎 ${esc(ch.sourceTitle || ch.source)}</a>`;
}

// One change card. `controls` (HTML) appended for admin emails.
function changeCard(ch, inWallet, controls) {
  const border = inWallet ? `border:1.5px solid ${TEAL};` : 'border:1px solid #e5e7eb;';
  const dim = inWallet ? '' : 'opacity:0.75;';
  const badge = inWallet
    ? '<span style="display:inline-block;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;white-space:nowrap;">★ In your wallet</span>'
    : '<span style="display:inline-block;background:#f9fafb;border:1px solid #e5e7eb;color:#9ca3af;font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;white-space:nowrap;">Not in wallet</span>';
  return (
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;${border}border-radius:10px;overflow:hidden;${dim}"><tr><td style="padding:16px;">` +
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;"><tr>' +
    `<td style="font-size:13px;font-weight:600;color:#111111;width:100%;">${esc(ch.card)}</td>` +
    `<td align="right">${badge}</td></tr></table>` +
    changeRow(changeLabel(ch), ch.old, ch.new) +
    (ch.note ? `<div style="font-size:12px;color:#6b7280;margin:2px 0 8px;">${esc(ch.note)}</div>` : '<div style="height:4px"></div>') +
    sourceLink(ch) +
    (controls || '') +
    '</td></tr></table>'
  );
}

function shell(innerHtml, subtitle, ctaHtml) {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    `<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">` +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:32px 16px;"><tr><td align="center">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">' +
    `<tr><td style="background-color:${TEAL};border-radius:12px 12px 0 0;padding:24px 28px;">` +
    '<div style="color:white;font-size:17px;font-weight:600;letter-spacing:-0.2px;">Card Rewards Optimizer</div>' +
    `<div style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:2px;">${esc(subtitle)}</div></td></tr>` +
    '<tr><td style="background-color:#ffffff;padding:28px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">' +
    innerHtml + (ctaHtml || '') +
    '</td></tr>' +
    '<tr><td style="background-color:#f8fafc;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:16px 28px;">' +
    '<p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;line-height:1.5;">Sent by your Card Rewards Optimizer<br>Changes are suggestions only — always verify before updating</p>' +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function noChangesSummary(n) {
  if (n <= 0) return '';
  return (
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#f8fafc;"><tr>' +
    `<td style="padding:14px 16px;"><div style="font-size:13px;color:#6b7280;">✓ <strong style="color:#111111;">${n} other card${n === 1 ? '' : 's'}</strong> — no changes detected</div></td>` +
    '</tr></table>'
  );
}

async function adminEmailHtml(env, pending, wallet, totalCards) {
  const base = (env.PUBLIC_BASE || '').replace(/\/$/, '');
  const items = await Promise.all(pending.changes.map(async (ch) => {
    const acc = await signChange(env, pending.runId, ch.id, 'accept');
    const dis = await signChange(env, pending.runId, ch.id, 'dismiss');
    const accUrl = `${base}/review?run=${encodeURIComponent(pending.runId)}&id=${encodeURIComponent(ch.id)}&action=accept&token=${acc}`;
    const disUrl = `${base}/review?run=${encodeURIComponent(pending.runId)}&id=${encodeURIComponent(ch.id)}&action=dismiss&token=${dis}`;
    const controls =
      '<table cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr>' +
      `<td style="padding-right:8px;"><a href="${accUrl}" style="display:inline-block;background:${TEAL};color:#fff;font-size:13px;font-weight:600;text-decoration:none;padding:8px 18px;border-radius:6px;">Accept</a></td>` +
      `<td><a href="${disUrl}" style="display:inline-block;background:#fff;color:#6b7280;font-size:13px;font-weight:500;text-decoration:none;padding:8px 18px;border-radius:6px;border:1px solid #e5e7eb;">Dismiss</a></td>` +
      '</tr></table>';
    return changeCard(ch, wallet.includes(ch.card), controls);
  }));
  const cardsWithChanges = new Set(pending.changes.map((c) => c.card)).size;
  const inner =
    '<p style="margin:0 0 6px;font-size:20px;font-weight:600;color:#111111;letter-spacing:-0.3px;">Benefit changes detected</p>' +
    '<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.5;">You are an admin. Review each change below and click <strong>Accept</strong> to apply it to the shared card data, or <strong>Dismiss</strong> to discard it.</p>' +
    items.join('') + noChangesSummary(totalCards - cardsWithChanges);
  const cta =
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">' +
    `<a href="${esc(env.APP_URL || 'https://rewards.norm.network')}" style="display:inline-block;background:#111111;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:12px 28px;border-radius:8px;">Open app</a>` +
    '</td></tr></table>';
  return shell(inner, 'Weekly benefit check', cta);
}

function userEmailHtml(env, changes, wallet, totalCards) {
  const items = changes.map((ch) => changeCard(ch, true, '')).join('');
  const cardsWithChanges = new Set(changes.map((c) => c.card)).size;
  const inner =
    '<p style="margin:0 0 6px;font-size:20px;font-weight:600;color:#111111;letter-spacing:-0.3px;">Benefit changes for your cards</p>' +
    '<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.5;">The following changes were found for cards in your wallet during this week\'s automated check. An admin reviews and applies updates.</p>' +
    items + noChangesSummary(Math.max(0, wallet.length - cardsWithChanges));
  const cta =
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">' +
    `<a href="${esc(env.APP_URL || 'https://rewards.norm.network')}" style="display:inline-block;background:#111111;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:12px 28px;border-radius:8px;">Open app</a>` +
    '</td></tr></table>';
  return shell(inner, 'Weekly benefit check', cta);
}

async function sendMail(env, toEmail, toName, subject, htmlPart, textPart) {
  if (!env.MJ_APIKEY_PUBLIC || !env.MJ_APIKEY_PRIVATE) {
    throw new Error('Mailjet not configured');
  }
  const payload = {
    Messages: [{
      From: { Email: fromEmail(env), Name: FROM_NAME },
      To: [{ Email: toEmail, Name: toName || toEmail }],
      Subject: subject,
      TextPart: textPart || subject,
      HTMLPart: htmlPart,
    }],
  };
  const auth = btoa(`${env.MJ_APIKEY_PUBLIC}:${env.MJ_APIKEY_PRIVATE}`);
  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Mailjet ${res.status}: ${detail.slice(0, 200)}`);
  }
}

// ── The weekly job ────────────────────────────────────────────────
async function runCheck(env, opts = {}) {
  const runId = 'run_' + Date.now();
  let detected = [];
  let totalCards = 0;
  try {
    const r = await detectChanges(env, opts);
    detected = r.detected;
    totalCards = r.totalCards;
  } catch (e) {
    await logRun(env, { runId, at: new Date().toISOString(), detected: 0, error: e.message });
    throw e;
  }

  if (!detected.length) {
    await logRun(env, { runId, at: new Date().toISOString(), detected: 0 });
    return { runId, detected: 0, emailsSent: 0 };
  }

  // Assign stable ids and persist pending.
  const changes = detected.map((c, i) => Object.assign({ id: `c${i}`, status: 'pending' }, c));
  const pending = { runId, generatedAt: new Date().toISOString(), changes };
  await env.REWARDS_KV.put('pending', JSON.stringify(pending));

  // Recipients from sync state.
  const state = await getState(env);
  const users = (state && state.users) || {};
  let emailsSent = 0;

  for (const name in users) {
    const u = users[name] || {};
    const email = (u.email || '').trim();
    if (!email) continue;
    const wallet = Array.isArray(u.cards) ? u.cards : [];
    try {
      if (u.admin) {
        const body = await adminEmailHtml(env, pending, wallet, totalCards);
        await sendMail(env, email, name, 'Benefit changes — review & approve', body,
          'Benefit changes were detected. Open the app to review and approve.');
        emailsSent++;
      } else {
        const relevant = changes.filter((c) => wallet.includes(c.card));
        if (!relevant.length) continue; // no email if nothing relevant
        const body = userEmailHtml(env, relevant, wallet, totalCards);
        await sendMail(env, email, name, 'Benefit changes for your cards', body,
          'Benefit changes were detected for cards in your wallet.');
        emailsSent++;
      }
    } catch (e) {
      console.log('email error for', name, e.message);
    }
  }

  await logRun(env, { runId, at: new Date().toISOString(), detected: changes.length, emailsSent });
  return { runId, detected: changes.length, emailsSent };
}

// ── Approve / dismiss ─────────────────────────────────────────────
function reviewResultPage(title, msg, env) {
  const inner =
    `<p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">${esc(title)}</p>` +
    `<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.5;">${esc(msg)}</p>`;
  const cta =
    '<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">' +
    `<a href="${esc(env.APP_URL || 'https://rewards.norm.network')}" style="display:inline-block;background:#111;color:#fff;font-size:14px;font-weight:500;text-decoration:none;padding:12px 28px;border-radius:8px;">Open app</a>` +
    '</td></tr></table>';
  return shell(inner, 'Admin review', cta);
}

// GET /review → confirmation page (does NOT mutate, so mail prefetch can't auto-apply).
async function reviewConfirmPage(env, runId, id, action, token) {
  const pending = await getPending(env);
  if (!pending || pending.runId !== runId) {
    return html(reviewResultPage('Link expired', 'This review link is no longer valid — a newer check has run or the change was already handled.', env), 410);
  }
  const ch = pending.changes.find((c) => c.id === id);
  if (!ch) return html(reviewResultPage('Not found', 'That change could not be found.', env), 404);
  if (ch.status !== 'pending') {
    return html(reviewResultPage('Already handled', `This change was already ${esc(ch.status)}.`, env), 200);
  }
  const verb = action === 'accept' ? 'Accept' : 'Dismiss';
  const summary = `${esc(ch.card)} — ${esc(changeLabel(ch))}: ${esc(ch.old)} → ${esc(ch.new)}`;
  const btnColor = action === 'accept' ? TEAL : '#6b7280';
  const inner =
    `<p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111;">${esc(verb)} this change?</p>` +
    `<p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.5;">${summary}</p>` +
    `<form method="POST" action="${(env.PUBLIC_BASE || '').replace(/\/$/, '')}/review" style="margin:0;">` +
    `<input type="hidden" name="run" value="${esc(runId)}">` +
    `<input type="hidden" name="id" value="${esc(id)}">` +
    `<input type="hidden" name="action" value="${esc(action)}">` +
    `<input type="hidden" name="token" value="${esc(token)}">` +
    `<button type="submit" style="display:inline-block;background:${btnColor};color:#fff;font-size:14px;font-weight:600;border:none;padding:12px 28px;border-radius:8px;cursor:pointer;">Confirm ${esc(verb)}</button>` +
    '</form>';
  return html(shell(inner, 'Admin review', ''));
}

// POST /review → apply.
async function reviewApply(env, runId, id, action) {
  const pending = await getPending(env);
  if (!pending || pending.runId !== runId) {
    return html(reviewResultPage('Link expired', 'This review link is no longer valid.', env), 410);
  }
  const ch = pending.changes.find((c) => c.id === id);
  if (!ch) return html(reviewResultPage('Not found', 'That change could not be found.', env), 404);
  if (ch.status !== 'pending') {
    return html(reviewResultPage('Already handled', `This change was already ${esc(ch.status)}.`, env), 200);
  }

  if (action === 'accept') {
    const ov = await getOverrides(env);
    ov.rewards = ov.rewards || {};
    ov.perks = ov.perks || {};
    if (ch.type === 'rate') {
      ov.rewards[ch.card] = ov.rewards[ch.card] || {};
      ov.rewards[ch.card][ch.category] = { r: ch.new, n: ch.note || ('Updated ' + todayISO()) };
    } else if (ch.type === 'fee') {
      ov.perks[ch.card] = ov.perks[ch.card] || {};
      ov.perks[ch.card].fee = ch.new;
    } else if (ch.type === 'base') {
      ov.perks[ch.card] = ov.perks[ch.card] || {};
      ov.perks[ch.card].base = ch.new;
    }
    ov.lastUpdated = todayISO();
    await env.REWARDS_KV.put('overrides', JSON.stringify(ov));
    ch.status = 'accepted';
  } else {
    ch.status = 'dismissed';
  }
  await env.REWARDS_KV.put('pending', JSON.stringify(pending));

  const verb = action === 'accept' ? 'accepted' : 'dismissed';
  const summary = `${ch.card} — ${changeLabel(ch)}: ${ch.old} → ${ch.new}`;
  return html(reviewResultPage(
    `Change ${verb}`,
    action === 'accept'
      ? `Applied: ${summary}. The app will pick it up on next load.`
      : `Dismissed: ${summary}.`,
    env,
  ));
}

// ── HTTP entrypoint ───────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env).catch((e) => console.log('runCheck failed:', e.message)));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // ── /review (HMAC-token gated, no Bearer) ────────────────────
    if (pathname === '/review') {
      const params = request.method === 'POST'
        ? new URLSearchParams(await request.text())
        : url.searchParams;
      const runId = params.get('run') || '';
      const id = params.get('id') || '';
      const action = params.get('action') || '';
      const token = params.get('token') || '';
      if (action !== 'accept' && action !== 'dismiss') {
        return html(reviewResultPage('Bad request', 'Unknown action.', env), 400);
      }
      const expected = await signChange(env, runId, id, action);
      if (!timingSafeEqual(token, expected)) {
        return html(reviewResultPage('Invalid link', 'This approval link could not be verified.', env), 403);
      }
      return request.method === 'POST'
        ? reviewApply(env, runId, id, action)
        : reviewConfirmPage(env, runId, id, action, token);
    }

    // ── Everything below requires the Bearer secret ──────────────
    const auth = request.headers.get('Authorization') || '';
    const authed = auth === `Bearer ${env.SYNC_SECRET}`;

    // POST /subscribe
    if (pathname === '/subscribe') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const email = (body && body.email ? String(body.email) : '').trim();
      const name = (body && body.user ? String(body.user) : '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email address' }, 400);
      try {
        const greeting = name ? `Hi ${esc(name)},` : 'Hi there,';
        await sendMail(env, email, name, 'Your subscription is confirmed',
          `<p>${greeting}</p><p>This confirms that <strong>${esc(email)}</strong> is now subscribed to <strong>Card Rewards Optimizer</strong> benefit-change notifications.</p><p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>`,
          `${name ? 'Hi ' + name : 'Hi there'},\n\nThis confirms that ${email} is now subscribed to Card Rewards Optimizer benefit-change notifications.`);
      } catch (e) {
        return json({ error: 'Email sending failed', detail: e.message }, 502);
      }
      return json({ ok: true, sent: email });
    }

    // GET /overrides — card-data overlay the app merges over cards.json
    if (pathname === '/overrides') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return json(await getOverrides(env));
    }

    // GET /run-check — manual trigger; runs in the background, returns immediately.
    // Optional ?limit=N caps the number of cards checked (fast/cheap smoke test).
    if (pathname === '/run-check') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      const limit = parseInt(url.searchParams.get('limit'), 10) || 0;
      const test = url.searchParams.get('test') === '1';
      ctx.waitUntil(runCheck(env, { limit, test }).catch((e) => console.log('run-check failed:', e.message)));
      return json({
        ok: true, started: true, test, limit: limit || 'all',
        note: test
          ? 'Test run started — a synthetic change will be emailed to admins. Poll /checklog in ~30s.'
          : 'Check started in background. Poll /checklog (and /pending) in 1-3 min for results.',
      });
    }

    // GET /pending — inspect current pending changes (testing)
    if (pathname === '/pending') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      return json((await getPending(env)) || { changes: [] });
    }

    // GET /checklog — recent run summaries: detected counts, emails sent, errors (testing)
    if (pathname === '/checklog') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      return json((await env.REWARDS_KV.get('checklog', 'json')) || []);
    }

    // GET/PUT /sync
    if (pathname === '/sync') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      if (request.method === 'GET') {
        return json((await env.REWARDS_KV.get('state', 'json')) || {});
      }
      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
        await env.REWARDS_KV.put('state', JSON.stringify(body));
        return json({ ok: true });
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    return json({ error: 'Not found' }, 404);
  },
};
