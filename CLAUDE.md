# NLB Library Dashboard — Project Brief

## What This Is

A personal reading list tracker that shows live book availability across Singapore's NLB (National Library Board) branches. Built as a single self-contained HTML file with vanilla JS. No framework, no build step.

The app lets a user search the NLB catalogue, add books to a personal reading list, and see at a glance which branches have copies available — so they can plan a library trip efficiently.

---

## Architecture

### Single HTML File (`app.html`)
All HTML, CSS, and JavaScript live in one file. There are no imports, no bundler, no external JS dependencies — only Google Fonts loaded via CDN.

### Backend Proxy (`PROXY` constant)
The app talks to a separate backend proxy hosted on Render:
```
const PROXY = 'https://YOUR-APP-NAME.onrender.com';
```
This proxy wraps NLB's catalogue API (which requires a server-side key and CORS handling). Two endpoints are used:

| Endpoint | Purpose |
|---|---|
| `GET /search?q={query}&limit=30` | Search the NLB catalogue |
| `GET /availability?brn={brn}&title={title}&author={author}` | Get per-branch availability for one book |

The proxy returns availability keyed by **branch code** (e.g. `GEPL`, `CLL`). The frontend maps these to branch keys using `CODE_TO_KEY` and `KEY_TO_B` lookups.

### Persistence
All state is persisted to `localStorage`:
- `nlb_reading` — the user's reading list (array of book objects)
- `nlb_branches` — the user's selected branches (array of branch keys)

Availability data is cached in-memory (`availCache`) and also written back into each book's `.avail` field so it survives page refresh without re-fetching.

---

## Data Model

### Book object (stored in `reading[]`)
```js
{
  brn:      string,   // NLB BRN (unique book ID)
  title:    string,
  author:   string,
  isbn:     string,
  language: string,   // lowercase, e.g. "english", "chinese"
  avail:    object    // keyed by branch key -> availability info (cached)
}
```

### Availability info (per branch, from proxy)
```js
{
  available: number,  // copy count
  status:    string,  // "yes" | "low" | "no"
  shelf: {
    callno:  string,  // e.g. "ENG 823.92 WAT"
    section: string   // e.g. "Fiction"
  }
}
```

### Branch object (hardcoded in `BRANCHES[]`)
```js
{
  key:     string,  // internal key, e.g. "geylang"
  code:    string,  // NLB branch code, e.g. "GEPL"
  label:   string,  // Short display name, e.g. "Geylang"
  name:    string,  // Full library name
  address: string,
  maps:    string,  // Google Maps URL
  hours:   string,  // Opening hours text
  pg:      string | null  // Optional nearby playground note (for visits with kids)
}
```

---

## Key Flows

### Search & Add
1. User types a query and presses Enter or clicks Search
2. `doSearch()` hits `PROXY/search` and renders results in a dropdown overlay
3. User clicks `+ Add` — `addBook()` pushes to `reading[]`, saves to localStorage, triggers `fetchAvail(brn)`, re-renders

### Availability Fetch
- `fetchAvail(brn)` calls `PROXY/availability`, maps branch codes to keys, writes to `availCache` and the book's `.avail` field
- Called on add, on `refreshAll()`, and on page load for every existing book
- On failure, sets `availCache[brn] = { _failed: true }` — shows a Retry button in the UI

### Shelf Location
- Tapping an available branch dot calls `showShelf(brn, branchKey, el)`
- Opens a slide-down panel below the index card showing call number and section
- Only tappable if `shelf.callno` is populated in the availability data
- A "spotlight" effect dims all other cards while a shelf panel is open

### Plan Visit
- `planVisit()` scores each active branch by total available copy count across the full reading list
- Highlights the best branch in a `.plan-box` overlay with address, hours, Google Maps link, and optional playground note
- Animates a "BEST BET" stamp badge on open

---

## UI Structure (top to bottom)

```
header            — Site title + date stamp (sticky)
search-wrap       — Search input + results dropdown (sticky below header)
controls          — Sort, language filter, refresh (scrollable strip)
branch-strip      — Branch filter tabs + "Plan visit" button
branch-panel      — Expand/collapse branch selector (checkboxes)
plan-box          — Best branch recommendation card (animated stamp)
summary           — Count stats: On list / Available / Last copy / On loan
books-list        — Reading list cards
  book-card
    idx-card      — Title, author, meta, remove button (index card style)
    shelf-panel   — Slide-down: call number + section (per branch)
    dot-row       — Branch availability dots (tappable if shelf data exists)
legend            — Colour key
toast             — Ephemeral feedback messages (bottom center)
```

---

## Visual Design

**Theme:** Vintage library / index card aesthetic.

**Fonts:**
- Playfair Display — titles and headings
- Courier Prime — UI chrome, buttons, mono data
- Libre Baskerville italic — secondary body text

**Palette:**
- Cream backgrounds: `#f5f0e8` / `#ede8dc` / `#e0d8c8`
- Ink-brown text: `#2a2318` / `#5a4a32` / `#8a7a62`
- Terracotta accent: `#c44a1a` (date stamp, on-loan, call numbers)
- Archive green: `#3a6a2a` (available)
- Amber: `#8a6a1a` (last copy)

**Card details:**
- Dog-ear corner (CSS triangle)
- Worn bottom edge (repeating dashes via `::after`)
- Subtle hatched texture overlay

**Status dots:** Green = available, amber = last copy, terracotta (faded) = on loan

**Interaction details:**
- Shimmer loading placeholders while availability fetches
- Spotlight dimming: all other cards fade when a shelf panel is open
- Animated Best Bet stamp (scale + rotate spring animation)
- Slide-down shelf panels with smooth max-height transition

---

## Branch Configuration

27 NLB branches are hardcoded in `BRANCHES[]`. Key branches with playground notes (relevant for family visits) include: Geylang, Central, Tampines, Pasir Ris, Punggol, Marine Parade.

Default active branches on first load: Geylang, Central, Tampines, Pasir Ris.

To add a branch: append an entry to `BRANCHES[]` with the correct NLB branch `code`. It will automatically appear in the branch panel, the filter strip, and the Plan Visit scoring.

---

## State & Rendering

- `reading[]` — source of truth for the reading list
- `availCache{}` — in-memory map of `brn -> { branchKey -> availInfo }`
- `activeKeys[]` — which branches are currently enabled
- `branchFilter` — `'all'` or a single branch key (controls the active tab)
- `availOnly` — boolean, filters to only books with at least one available copy
- `renderBooks()` is the single re-render function; always called after any state change

---

## Known TODOs / Extension Points

- [ ] Replace `PROXY` placeholder with deployed Render URL
- [ ] eBook / AV support (currently shown as "Physical only" in search results)
- [ ] Per-book notes field
- [ ] PWA manifest + service worker for mobile home screen / offline use
- [ ] Opening hours are currently hardcoded as generic "10am–9pm" — real hours vary and change for public holidays
- [ ] `planVisit()` scoring could incorporate geolocation to weight branches by travel distance
- [ ] Pagination or "load more" for search results (currently capped at 30 from the proxy)
