# Card Rewards Optimizer — Roadmap

This file tracks planned features and improvements for the Card Rewards Optimizer app.

---

## Features

========================

- [ ] Automated benefit change detection & cards.json updates
  - Sync server runs a weekly cron job (e.g. Sunday night)
  - Calls Claude API with web_search tool, checking each card for benefit changes
  - Detected changes written to data/pending_updates.json with source URLs
  - Two types of emails sent per weekly run:
      1. Admin email (you): full list of all detected changes across all cards,
         with Accept/Dismiss controls — you approve what goes into cards.json
      2. Per-user emails: each non-admin user gets a read-only email showing only
         changes relevant to cards in their own wallet, no approval controls
  - If a non-admin user has no relevant changes that week, no email sent to them
  - Admin always gets the full review email if any changes are detected
  - Email matches app theme; wallet cards highlighted with teal border + "★ In your wallet" badge
  - Non-wallet cards included but dimmed in all emails for full context
  - Each change shows: card name, category, old value → new value, source URL
  - CTA button in admin email links to app to review and accept/dismiss
  - Accepted changes written directly to cards.json — no manual editing needed
  - Every weekly run logged to data/check.log with timestamp and result summary
  - Requires: ANTHROPIC_API_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER,
      SMTP_PASS, ADMIN_EMAIL, and per-user email addresses in sync.json
  - Email template saved as email-template.html for reference

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

When adding the automated benefit detection feature, also pass:

```bash
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SMTP_HOST=mail.example.com \
  -e SMTP_PORT=587 \
  -e SMTP_USER=you@example.com \
  -e SMTP_PASS=yourpassword \
  -e ADMIN_EMAIL=you@example.com \
```
