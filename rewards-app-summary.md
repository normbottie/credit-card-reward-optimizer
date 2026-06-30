# Card Rewards Optimizer — App Summary

## Overview
A PWA (Progressive Web App) that helps users find the best credit card to use for each spending category. Single HTML file, vanilla JS, served via nginx on Unraid.

## URLs
- **App:** `https://rewards.norm.network`
- **Sync server:** `https://sync.norm.network/sync`
- **App file:** `/mnt/user-data/outputs/index.html` (deploy to Unraid nginx www folder)
- **Sync server:** `/mnt/user-data/outputs/sync-server.js` (Node.js, runs as Docker container)
- **Cards database:** `/mnt/user-data/outputs/cards.json`
- **Email template:** `/mnt/user-data/outputs/email-template.html`
- **Roadmap:** `/mnt/user-data/outputs/ROADMAP.md`

## Architecture
- Single HTML file, vanilla JS, no framework
- Card data loaded from external `cards.json` (fetched on load)
- User data stored in localStorage + synced to Node.js server
- Service worker for PWA/offline support
- Anti-FOUC script in `<head>` for dark mode and collapse state

## Sync Server
- Node.js HTTP server, Docker container `rewards-sync` on port 3002
- Data stored at `/mnt/user/appdata/rewards-sync/data/sync.json`
- Deep merges users object on POST, handles null values to delete fields
- `sync.json` structure: `{ users: { "Name": { cards, quarterly, prime, dark, email } }, admin, last_quarter }`

## Multi-User Support
- First launch shows user picker modal with slide animation
- Register/pick states with left/right slide animation
- `activeUser` variable tracks current user
- `getUserKey(field)` returns `cc_{name}_{field}` localStorage key
- Per-user: cards, quarterly settings, Prime toggle, dark mode, email, admin flag
- Inline rename via ✏️ button on active user pill
- Inline delete via 🗑️ → ✅/❌ animated confirmation on other user pills
- Log out shows pick modal

## Key localStorage Keys
- Per-user: `cc_{name}_cards`, `cc_{name}_quarterly`, `cc_{name}_prime`, `cc_{name}_dark`, `cc_{name}_email`
- Shared: `cc_dark` (FOUC fallback), `cc_last_quarter`, `cc_users`, `cc_active_user`, `cc_sync_queue`, `cc_admin`, `cc_collapse`

## Key JS Functions (all global scope)
- `loadCardsData(callback)` — fetches cards.json
- `getCardRate(card, cat)` — applies Amazon Prime and quarterly overrides
- `applyServerData(serverData)` — applies server sync to local state
- `showPickState()` / `showRegisterState(fromSettings)` — modal states
- `setModalContent(html, direction)` — animates content swap left/right
- `selectExistingUser(name)` — picks existing user
- `logOut()` — resets state, shows pick modal
- `checkQuarterChange()` — runs after server sync, shows toast if new quarter
- `switchSettingsTab(tab)` — fades body, swaps content
- `renameUser()` — inline pill edit
- `initRemoveUser(btn)` / `confirmRemoveUser(name)` / `cancelRemoveUser()` — animated delete flow
- `setDark(on)` — saves to both `cc_dark` (FOUC) and per-user key, syncs to server
- `renderBanks()` — shows sec1 section, renders bank buttons
- `saveCollapseState()` / `toggleSection(id)` — collapse/expand sections

## UI Sections
- **sec1** — Step 1: bank-first card selection (starts `display:none` in HTML)
- **step2** — Step 2: 11 spending categories (starts `display:none` in HTML)
- **Results** — ranked cards with fade-in animation
- **Settings sheet** — 90vh fixed height, two tabs: General and Users
- **Benefits panel** — tabs per saved card, shows card perks

## Settings Tabs
- **General:** dark mode toggle, quarterly 5% categories, reload/save buttons
- **Users:** Amazon Prime toggle, user pills with rename/delete, email input, admin toggle, log out button

## Cards Database (cards.json)
- External file fetched on load
- Error banner is context-aware (blue preview mode for blob: protocol, red for server failure)
- `lastUpdated` field shown in benefits panel
- Chase Amazon Prime Rewards Visa: 5%/3% based on per-user Prime toggle

## Collapse State (FOUC Prevention)
- Two-phase: inline `<style>` in `<head>` hides sections instantly before paint
- IIFE at bottom of script applies real CSS classes and removes style tag
- Both `sec1` and `step2` start `display:none` in HTML
- `renderBanks()` shows `sec1` when data loads

## Quarterly System
- 4 quarters: Q1 (Jan-Mar), Q2 (Apr-Jun), Q3 (Jul-Sep), Q4 (Oct-Dec)
- Toast shown when quarter changes, dismissed when user updates categories
- Server stores `last_quarter` — server dismissal always wins
- Debug 🐛 button cycles quarters and clears server state (admin only)
- Quarterly data is SHARED across users (not per-user)

## Dark Mode
- Per-user, saved to `cc_{name}_dark` and `cc_dark` (FOUC fallback)
- Applied in `loadUserData()` when switching users
- Synced to server under `users.{name}.dark`

## PWA
- `manifest.json` and `service-worker.js` in same folder as `index.html`
- Stale-while-revalidate caching strategy
- Safe area insets for iOS
- Favicon: teal background, dark teal card, gold stripe

## Deployment
1. Copy `index.html`, `cards.json`, `manifest.json`, `service-worker.js` to nginx www folder on Unraid
2. Sync server runs as Docker container: `docker run -d --name rewards-sync -p 3002:3001 -v /mnt/user/appdata/rewards-sync/data:/app/data --restart unless-stopped rewards-sync`

## Roadmap Status
- ✅ Amazon Prime subscription toggle
- ✅ Multi-user support
- ✅ Subdomain routing
- ✅ Remote access via Tailscale
- ✅ Automated benefit detection & email notifications (Cloudflare Worker cron + Claude API web_search + Mailjet)

## Benefit Detection & Approval (in worker.js)
- Weekly Worker cron (Mon 14:00 UTC) detects card benefit changes via Claude API web_search
- Admins (admin toggle) get a full-list email with HMAC-signed Accept/Dismiss links from cards@norm.network
- Non-admins get a read-only email of changes for cards in their wallet only
- Accept writes to a KV `overrides` overlay; app fetches GET /overrides and merges over cards.json on load
- Endpoints: scheduled() + /run-check (manual), /review (GET confirm page, POST apply), /overrides, /pending
- Secrets needed: ANTHROPIC_API_KEY, APPROVAL_SECRET, MJ_APIKEY_PUBLIC/PRIVATE (SYNC_SECRET existing)
