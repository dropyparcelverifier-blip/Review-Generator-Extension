# CLAUDE.md

Guidance for working in this repo. Chrome MV3 extension that generates realistic
Indian product reviews for **dropy.in** products using **Gemini**, attaching real
customer photos and exporting an import-ready CSV.

## Entry point & UI
- Click the toolbar icon → `background.js` `openApp()` opens **`app.html` in a full
  browser tab** (focuses the existing tab if already open). It is NOT a side panel
  anymore (the `sidePanel` API was removed).
- The app tab must stay open for a run — closing it stops the JS. It stays focused
  because all scraping/Gemini tabs open with `active:false`.

## Files
- `manifest.json` — MV3. Permissions: `activeTab, scripting, tabs, downloads,
  storage, unlimitedStorage`. Host perms for gemini/dropy/google/lens/amazon/shopify.
- `background.js` — **service worker**. Scraping orchestration, the scrape-tab pool,
  Google Lens search, Shopify Files upload, and the `chrome.runtime.onMessage` router.
- `app.js` — the full-page **UI + main run logic** (the two-phase pipeline lives in
  `startProcessing`; `prepareProduct` = Phase 1 scrape, `generateProduct` = Phase 2).
- `app.html` / `app.css` — UI markup/styles (centered, `max-width:1080px`).
- `gemini-content.js` — content script on `gemini.google.com`: types the prompt and
  reads the finished response (JSON-array completion detection).
- `dropy-content.js` — content script on `dropy.in` (legacy `scrape_dropy` path; the
  live flow uses `dropy_lookup` + the injected `extractDropyProductPage`).
- `config.js` — **SECRETS**, git-ignored. Sets `self.ENV = { SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_ACCESS_TOKEN, SHOPIFY_API_VERSION }`. Copy from `config.example.js`. The
  Admin token needs `write_files` scope. **Never commit; rotate if exposed.**
- `libs/xlsx.full.min.js` — Excel parsing for `.xlsx` ASIN lists.

## Run flow (`app.js` → `startProcessing(mode)`)
Two **independent** run modes, each its own button on the upload screen, each with
its own progress + output file (run text now, images later — order doesn't matter):

- **Text mode** (`startProcessing('text')`, default) — **fully automatic, no image
  picking.** For each ASIN: `prepareProduct(item, i, /*textOnly*/true)` does ONLY the
  dropy lookup (skips all image search), then `generateProduct({…, mode:'text'})`
  generates the configured min–max **text-only** reviews and streams rows into
  **`<name>.csv`**. Unattended — the user walks away.
- **Image mode** (`startProcessing('image')`) — the interactive two-phase pipeline:
  - **Phase 1 — Selection:** `prepareProduct` scrapes dropy + gathers candidate images
    from **Lens, Google Images, Pinterest, Amazon reviews in PARALLEL**; you pick. A
    **1-ahead prefetch** scrapes the next product while you pick. Selections persist
    per-ASIN (`csvBatchImage.pending`) so Stop/close doesn't force a re-pick.
  - **Phase 2 — Generation (unattended):** `generateProduct({…, mode:'image'})` hosts
    picked images on Shopify Files, then generates **exactly one review per hosted
    photo** (every review carries a photo) → **`<name>_images.csv`**.

Both: 1) upload `.txt/.csv/.xlsx` → `extractAsin` → `products`; 4) **one CSV per batch**,
`conflictAction:'overwrite'` + stable filename so Stop→resume keeps the SAME file.

## Persistence (`chrome.storage.local`) — **namespaced by mode**
- `doneAsins` (text) / `doneAsinsImage` (image) — completed ASINs per mode, skipped on
  re-run. Separate so a text run never makes the image run skip that ASIN (or vice-versa).
- `csvBatch` (text) / `csvBatchImage` (image) — `{ fileName, rows, asins, pending }`.
  `rows` accumulate; `pending` holds saved image selections by ASIN (image mode only).
  Persisted after each product (crash-safe); an ASIN is marked done only after rows persist.
  The active mode's key is chosen by `doneStoreKey()` / `csvStoreKey()`.
- **Crash-proof disk file:** `flushCsvToDisk()` (over)writes the CSV to disk after EACH
  product, not just at run end — a power loss mid-run leaves a complete file on disk,
  no resume needed. `written` is set true only AFTER the file is actually sent, so
  storage never claims "on disk" when it isn't. Run-end write is now just a safety net.
- `settings`, `history`, `uploadedFileIds` (Shopify file GIDs for cleanup).
- `chrome.storage.session` mirrors scrape-tab ids so a SW restart can't orphan tabs.

## Key background message actions
`dropy_lookup`, `lens_by_bytes` / `lens_by_url`, `google_images`,
`amazon_review_images`, `ai_overview`, `upload_images`, `open_gemini` /
`send_to_gemini` / `new_gemini_chat` / `close_tab`, `save_file` (accepts
`conflictAction`), `delete_shopify_files`, `close_scrape_tab`.

## Notable behaviors
- **Scrape tabs** (`openScrapeTab`/`closeScrapeTab`/`closeAllScrapeTabs`): each
  `runInTab` opens its own background tab and **closes it the moment the scrape
  finishes**, so tabs never accumulate; concurrent calls are what make sources run
  in parallel. Open-tab ids are mirrored to `chrome.storage.session` so a SW
  restart can still close any leftovers (`close_scrape_tab` at run end).
- **Wrong-product guard:** `prepareProduct` verifies the ASIN appears in the dropy
  product's handle/SKU/description. `settings.strictMatch` → skip unverified; else warn
  and flag it in the picker/row.
- **Cloudflare detection:** dropy search/product pages return a "blocked" signal (vs
  "not found") so the UI can say "pass the check, then retry".
- **Image quality:** real review photos are uploaded as raw source bytes (no
  recompression). Canvas capture (`toDataUrl`/`padToSquare`, JPEG ~0.95, ≤2400px) is
  used only for the Lens *search* image and the no-real-photos fallback.
- **Image relevance:** whole-word token matching against brand/name (+ unique
  ASIN/barcode substring) — short tokens must match as whole words.

## Testing
Harnesses live in `tests/` and load `app.js`/`background.js` in a Node `vm` sandbox
with stubbed `document`/`chrome`, exercising the pure functions + the real
`startProcessing` with mocked I/O (no browser needed). Run everything:
```
npm test        # runs all 4 suites (~143 assertions)
npm run check   # node --check on app.js + background.js
```
- `test-sidepanel` — parsing, CSV, filtering, prompts, dedup, emoji/date/text helpers.
- `test-orchestration` — 2-phase pipeline, prefetch alignment, skips, resume/same-file,
  Stop, and pick-persistence (drives real `startProcessing`).
- `test-background` — `dataUrlToBlob`, and the `sized`/`upscale` URL transforms.
- `test-parallel` — proves sources run concurrently + ASIN-match verification.

Note: function declarations attach to the vm global; `const`/`let` module vars do not
(test via the functions, or an appended in-scope driver — see `test-orchestration`).
Injected page scrapers (live DOM) and Shopify/Gemini I/O aren't unit-tested — verify
those in a real browser.

## Gotchas
- `config.js` is git-ignored — verify with `git check-ignore config.js` before any push.
- Gemini must be **logged in** in the opened tab or batches fail (there's retry +
  self-heal, but not for a logged-out account).
- Files are `app.*` (renamed from `sidepanel.*`). `background.js` opens `app.html`.
- Git shows harmless `LF will be replaced by CRLF` warnings on Windows.
- End commit messages with the `Co-Authored-By: Claude` trailer; branch off `main`
  before committing if asked to commit.
