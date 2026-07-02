# Card Rewards Optimizer — Roadmap

This file tracks planned features and improvements for the Card Rewards Optimizer app.

---

## Features

========================

- [x] Automated benefit change detection & approval  (built on the Cloudflare Worker)
  - Cloudflare Worker cron runs the check monthly — 1st of the month 14:00 UTC (`crons` in wrangler.toml)
  - Only cards in at least one user's wallet are audited
  - Worker fetches cards.json + current overrides, calls Claude API (claude-sonnet-5) with the
    web_search tool in batches, detecting benefit changes per card
  - Detected changes stored in KV under `pending` with source URLs; runs logged in KV `checklog`
  - Two email types per run, sent via Mailjet from cards@norm.network:
      1. Admin email: every user with the admin toggle gets the full list of all detected
         changes, each with Accept / Dismiss buttons (admins hold approval privileges)
      2. Per-user emails: each non-admin gets a read-only email of only the changes for cards
         in their own wallet, no approval controls
  - No email to a non-admin with no relevant changes that week
  - Email matches app theme; wallet cards get teal border + "★ In your wallet", others dimmed
  - Each change shows: card name, category/fee/base, old value → new value, source link
  - Approval is via HMAC-signed links in the admin email:
      • GET /review shows a confirmation page (so mail-client prefetch can't auto-apply)
      • POST /review applies it — Accept writes the change into the KV `overrides` overlay,
        Dismiss discards it. Tampered/forged tokens are rejected (403).
  - Accepted changes are NOT written to cards.json directly — they live in the KV overrides
    overlay, which the app fetches from GET /overrides and merges over cards.json on load.
    cards.json remains the hand-edited base; overrides are the approved deltas.
  - Requires secrets: ANTHROPIC_API_KEY, APPROVAL_SECRET, MJ_APIKEY_PUBLIC, MJ_APIKEY_PRIVATE,
    SYNC_SECRET (existing), and per-user emails + admin flags already in sync state
  - Manual test trigger: GET /run-check (Bearer SYNC_SECRET). Inspect with GET /pending.
  - Email template (email-template.html) was the design reference; the Worker generates the
    live emails dynamically in the same style.

- [x] Amazon Prime subscription toggle
  - Toggle in Settings: "Amazon Prime subscription active"
  - When enabled: Chase Amazon Prime Rewards Visa shows 5% on Amazon/Whole Foods
  - When disabled: shows 3% with a note to enable Prime for 5%
  - Toggle state persists and syncs across devices

- [x] Multi-user support
  - First launch user picker with slide animation between pick/register states
  - Register new user flow with back/cancel
  - Switch users via pills in Settings → Users tab
  - Per-user: cards, quarterly settings, Prime toggle, dark mode, email, admin flag
  - Inline rename by tapping ✏️ on your own pill
  - Inline delete with 🗑️ → ✅/❌ animated confirmation
  - Log out returns to user picker modal
  - All user data synced to server under users.{name} in sync.json
  - Cross-device sync per user

- [x] Subdomain routing instead of port
  - NGINX Proxy Manager installed on Unraid at 192.168.1.101
  - rewards.norm.network → app, sync.norm.network → sync server
  - unraid.norm.network, adguard.norm.network also configured
  - AdGuard Home handles local DNS rewrites
  - SYNC_URL updated to http://sync.norm.network/sync

- [x] Remote access via Tailscale
  - Tailscale running on Unraid as exit node
  - Phone/laptop use Unraid as exit node when away from home
  - AdGuard DNS routed through Tailscale for ad blocking away from home
  - All subdomains (rewards.norm.network etc.) work via Tailscale

---

## TODO

- [x] Add email field when onboarding a new user
  - Optional email input on the register screen; validated, saved per-user, and synced
- [x] Change triangles for minimizing steps to hamburgers
  - Section collapse icons are now hamburgers (horizontal when open, rotated 90° when collapsed)
- [x] Only search for changes on cards that are in user wallets
  - Worker audits only the union of all users' wallet cards (cron + /run-check)
- [x] Change benefit-change search from weekly to monthly
  - Cron is now `0 14 1 * *` (1st of month, 14:00 UTC); email copy updated
- [x] Add a button to start the search manually
  - Admin-only "Search for benefit changes now" in Settings → Users, drives the
    resumable /run-check loop with live progress
- [x] Add a button to approve all benefit changes at once instead of one by one
  - Admin email has an HMAC-signed "Accept all" link (with confirmation page), and
    Settings → Users has an admin "Approve all pending changes" button (POST /approve-all)

---

## Deployment files

| File | Purpose |
|------|---------|
| `index.html` | Main app |
| `cards.json` | Card rewards database (edit to update benefits) |
| `cards-readme.md` | Guide to editing cards.json |
| `manifest.json` | PWA manifest |
| `service-worker.js` | Offline caching |
| `sync-server.js` | Cross-device sync server (runs in Docker) |
| `Dockerfile` | Docker build for sync server |
| `docker-compose.yml` | Docker compose config |
| `email-template.html` | HTML email template for benefit change notifications |

## Sync server

The sync server runs as a Docker container on Unraid on port 3002.
To restart it after changes:

```bash
docker rm -f rewards-sync
docker build -t rewards-sync /mnt/user/appdata/rewards-sync/
docker run -d --name rewards-sync -p 3002:3001 \
  -v /mnt/user/appdata/rewards-sync/data:/app/data \
  --restart unless-stopped rewards-sync
```

## Benefit-check Worker (Cloudflare)

The benefit detection + approval feature lives in `worker.js` (deployed with wrangler),
not the Docker sync server. To deploy / configure:

```bash
# one-time: set the secrets (values are not stored in wrangler.toml)
wrangler secret put ANTHROPIC_API_KEY     # Claude API key
wrangler secret put APPROVAL_SECRET       # any long random string (signs approve links)
wrangler secret put MJ_APIKEY_PUBLIC      # Mailjet public key
wrangler secret put MJ_APIKEY_PRIVATE     # Mailjet private key
# SYNC_SECRET already set; FROM_EMAIL optional (defaults to cards@norm.network)

wrangler deploy
```

Then in the Mailjet dashboard, verify **cards@norm.network** as a sender (or its domain),
or the sends will be rejected.

Cron schedule and non-secret config are in `wrangler.toml` (`[triggers]` + `[vars]`).
Test without waiting for the cron: `curl -H "Authorization: Bearer <SYNC_SECRET>" \
https://rewards-sync.normbottie.workers.dev/run-check`
