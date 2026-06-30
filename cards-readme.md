# cards.json — Card Rewards Database

This file contains all the card data for the Card Rewards Optimizer app.
Edit this file to update card benefits, add new cards, or remove old ones.
No changes to `index.html` needed — just save and the app picks it up on next load.

---

## Structure

The file has three top-level sections:

```json
{
  "banks": { ... },
  "rewards": { ... },
  "perks": { ... }
}
```

---

## `banks`

Maps each bank name to its list of card names. The bank name is what appears on the button grid.

```json
"banks": {
  "Amex": ["Amex Gold Card", "Amex Platinum Card", "Amex Green Card"],
  "Chase": ["Chase Sapphire Preferred", "Chase Freedom Flex"]
}
```

- Bank names must exactly match what you want shown in the UI
- Card names must exactly match the keys used in `rewards` and `perks`

---

## `rewards`

Maps each card name to its rates for every spending category.

```json
"rewards": {
  "Amex Gold Card": {
    "Dining":           { "r": "4x points", "n": "4x Membership Rewards at restaurants worldwide" },
    "Travel":           { "r": "3x points", "n": "3x on flights booked directly with airlines" },
    "Groceries":        { "r": "4x points", "n": "4x at US supermarkets (up to $25k/year)" },
    "Gas":              { "r": "1x points", "n": "No gas bonus" },
    "Streaming":        { "r": "1x points", "n": "No streaming bonus" },
    "Online Shopping":  { "r": "1x points", "n": "No online shopping bonus" },
    "Hotels":           { "r": "1x points", "n": "No hotel bonus" },
    "Drugstore":        { "r": "1x points", "n": "No drugstore bonus" },
    "Transit":          { "r": "1x points", "n": "No transit bonus" },
    "Entertainment":    { "r": "1x points", "n": "No entertainment bonus" },
    "Home Improvement": { "r": "1x points", "n": "No home improvement bonus" },
    "General":          { "r": "1x points", "n": "1x on all other purchases" }
  }
}
```

### Fields
- `r` — Short rate shown in results (e.g. `"4x points"`, `"5% cash back"`, `"2x miles"`)
- `n` — Longer note shown below the rate in results

### Rate format matters
The app uses these exact strings to rank cards. Supported formats:
- Points: `"1x points"` through `"14x points"`
- Cash back: `"1% cash back"` through `"6% cash back"`
- Miles: `"1x miles"` through `"10x miles"`

### Required categories
Every card must have all 12 categories:
`Dining`, `Travel`, `Groceries`, `Gas`, `Streaming`, `Online Shopping`,
`Hotels`, `Drugstore`, `Transit`, `Entertainment`, `Home Improvement`, `General`

---

## `perks`

Maps each card name to its annual fee, base reward rate, and perks list.

```json
"perks": {
  "Amex Gold Card": {
    "fee":   "$325/year",
    "base":  "1x on all other purchases",
    "perks": [
      "$120 dining credit ($10/mo at Grubhub, Cheesecake Factory, etc.)",
      "$120 Uber Cash ($10/mo, Uber Eats or Uber rides)",
      "No foreign transaction fees"
    ]
  }
}
```

### Fields
- `fee` — Annual fee shown in the card benefits panel
- `base` — Base earn rate shown in the card benefits panel
- `perks` — Array of perk strings, shown as a checklist in the benefits panel

---

## Adding a new card

1. Add the card name to the correct bank in `banks`
2. Add a full entry in `rewards` with all 12 categories
3. Add an entry in `perks` with fee, base, and perks list
4. Save the file — the app picks it up on next load (no server restart needed)

## Removing a card

1. Remove its name from `banks`
2. Remove its entry from `rewards`
3. Remove its entry from `perks`

## Quarterly categories (Chase Freedom Flex & Discover it Cash Back)

These cards' rates are handled dynamically by the app based on what you set in
Settings → Quarterly 5% categories. The rates in `rewards` for these cards
reflect their base (non-quarterly) rates. The app overrides them at runtime.

---

## Deployment

Place `cards.json` in the same folder as `index.html` on your Nginx server:

```
/mnt/user/appdata/nginx/www/
  index.html
  cards.json        ← this file
  manifest.json
  service-worker.js
```
