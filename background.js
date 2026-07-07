// Load secrets/config from the separate "env" file (config.js).
try { importScripts('config.js'); } catch (e) { /* config.js optional */ }
const ENV = self.ENV || {};

// Open the app in a FULL browser tab (not a side panel). Clicking the toolbar
// icon focuses the existing app tab if one is already open, otherwise creates it.
const APP_URL = chrome.runtime.getURL('app.html');

function openApp() {
  chrome.tabs.query({}, (tabs) => {
    const existing = (tabs || []).find((t) => t.url && t.url.startsWith(APP_URL));
    if (existing) {
      chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) chrome.windows.update(existing.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: APP_URL });
    }
  });
}

chrome.action.onClicked.addListener(openApp);

// ============================================================
// DROPY REVIEW SERVER — image upload config
// Fill these once you have the API spec. While endpoint is empty, uploads are
// skipped and the selected source image URLs are used as a fallback.
// ============================================================
const DROPY_UPLOAD = {
  endpoint: '',            // e.g. 'https://your-dropy-server/api/review-images'
  method: 'POST',
  authHeader: '',          // e.g. 'Authorization'
  authValue: '',           // e.g. 'Bearer xxxxx'
  mode: 'url',             // 'url' = send image URLs as JSON; 'file' = multipart upload of the actual files
  skuField: 'sku',
  imageField: 'image'      // field name for the image (file mode) or images array key (url mode)
};

// ============================================================
// SHOPIFY FILES API — host review images on the store's CDN (public URLs that
// Judge.me can fetch). Fill these from a custom app with `write_files` scope.
// When configured, this is used for image upload (preferred over DROPY_UPLOAD).
// ============================================================
// Values come from the separate config.js ("env" file). Edit them there.
// Trim to guard against stray whitespace/newlines that would break auth.
const SHOPIFY = {
  domain: (ENV.SHOPIFY_SHOP_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
  token: (ENV.SHOPIFY_ACCESS_TOKEN || '').trim(),
  apiVersion: (ENV.SHOPIFY_API_VERSION || '2025-07').trim()
};

async function shopifyGraphql(query, variables) {
  const r = await fetch(`https://${SHOPIFY.domain}/admin/api/${SHOPIFY.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY.token },
    body: JSON.stringify({ query, variables })
  });
  return r.json();
}

// Uploads one image (Blob) to Shopify Files. Returns { url, id } (id is the
// Shopify file GID, used later to delete it).
async function uploadToShopifyFiles(blob, filename) {
  // 1) Ask Shopify for a staged upload target
  const stagedQ = `mutation($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}} userErrors{field message}}}`;
  const staged = await shopifyGraphql(stagedQ, {
    input: [{ filename, mimeType: blob.type || 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST', fileSize: String(blob.size) }]
  });
  const target = staged && staged.data && staged.data.stagedUploadsCreate && staged.data.stagedUploadsCreate.stagedTargets && staged.data.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    const errs = (staged && staged.data && staged.data.stagedUploadsCreate && staged.data.stagedUploadsCreate.userErrors) || (staged && staged.errors) || 'unknown';
    throw new Error('stagedUploadsCreate: ' + JSON.stringify(errs));
  }

  // 2) POST the bytes to the staged target (params first, file last)
  const fd = new FormData();
  (target.parameters || []).forEach((p) => fd.append(p.name, p.value));
  fd.append('file', blob, filename);
  const up = await fetch(target.url, { method: 'POST', body: fd });
  if (!up.ok && up.status !== 201 && up.status !== 0) throw new Error('staged POST failed: ' + up.status);

  // 3) Register the file in Shopify
  const createQ = `mutation($files:[FileCreateInput!]!){fileCreate(files:$files){files{id fileStatus alt preview{image{url}} ... on MediaImage{image{url}}} userErrors{field message}}}`;
  const created = await shopifyGraphql(createQ, { files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE' }] });
  const file = created && created.data && created.data.fileCreate && created.data.fileCreate.files && created.data.fileCreate.files[0];
  if (!file) {
    const errs = (created && created.data && created.data.fileCreate && created.data.fileCreate.userErrors) || (created && created.errors) || 'unknown';
    throw new Error('fileCreate: ' + JSON.stringify(errs));
  }

  // 4) Poll until the CDN URL is ready (file processing is async)
  let url = (file.image && file.image.url) || (file.preview && file.preview.image && file.preview.image.url) || '';
  const nodeQ = `query($id:ID!){node(id:$id){... on MediaImage{fileStatus image{url} preview{image{url}}}}}`;
  for (let i = 0; i < 12 && !url; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const q = await shopifyGraphql(nodeQ, { id: file.id });
    const node = q && q.data && q.data.node;
    if (node) {
      url = (node.image && node.image.url) || (node.preview && node.preview.image && node.preview.image.url) || '';
      if (node.fileStatus === 'FAILED') throw new Error('file processing FAILED');
    }
  }
  return { url, id: file.id };
}

// Deletes Shopify Files by their GIDs.
async function deleteShopifyFiles(fileIds) {
  const ids = (fileIds || []).filter(Boolean);
  if (!ids.length || !SHOPIFY.domain || !SHOPIFY.token) return { ok: false, deleted: 0 };
  const q = `mutation($fileIds:[ID!]!){fileDelete(fileIds:$fileIds){deletedFileIds userErrors{message}}}`;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 25) {
    try {
      const r = await shopifyGraphql(q, { fileIds: ids.slice(i, i + 25) });
      const d = r && r.data && r.data.fileDelete && r.data.fileDelete.deletedFileIds;
      if (d) deleted += d.length;
    } catch (e) { /* keep going */ }
  }
  return { ok: true, deleted };
}

// POOL of reusable background tabs for scraping. A single shared tab would force
// every source (Lens, Google, Pinterest, Amazon) to run one-at-a-time; the pool
// lets concurrent runInTab() calls each grab their OWN tab so sources run in
// PARALLEL. Tabs are reused across calls and all closed at the end of a run. The
// id set is mirrored to session storage so a service-worker restart can still
// find and close them (no orphaned tabs).
const scrapeTabs = new Set(); // every scrape tab we created
const freeTabs = [];          // subset currently idle & reusable

function tabExists(id) {
  return new Promise((resolve) => {
    if (id == null) { resolve(false); return; }
    chrome.tabs.get(id, () => resolve(!chrome.runtime.lastError));
  });
}

async function loadScrapeTabs() {
  if (scrapeTabs.size) return;
  try { const r = await chrome.storage.session.get('scrapeTabs'); ((r && r.scrapeTabs) || []).forEach((id) => scrapeTabs.add(id)); } catch (e) {}
}
async function persistScrapeTabs() {
  try { await chrome.storage.session.set({ scrapeTabs: Array.from(scrapeTabs) }); } catch (e) {}
}

// Grab an idle tab (reuse a live one, else create). Marks it busy until released.
async function acquireTab() {
  await loadScrapeTabs();
  while (freeTabs.length) {
    const id = freeTabs.pop();
    if (await tabExists(id)) return id;
    scrapeTabs.delete(id); // stale (closed) — drop it
  }
  const id = await new Promise((resolve) => {
    chrome.tabs.create({ url: 'about:blank', active: false }, (tab) => resolve(tab.id));
  });
  scrapeTabs.add(id);
  await persistScrapeTabs();
  return id;
}

function releaseTab(id) {
  if (id != null && scrapeTabs.has(id) && !freeTabs.includes(id)) freeTabs.push(id);
}

async function closeAllScrapeTabs() {
  await loadScrapeTabs();
  for (const id of scrapeTabs) { try { chrome.tabs.remove(id); } catch (e) {} }
  scrapeTabs.clear();
  freeTabs.length = 0;
  try { await chrome.storage.session.remove('scrapeTabs'); } catch (e) {}
}

// Navigates a pooled tab to `url`, waits for load (+settle), runs `injectFn` in
// the page, returns its result, and releases the tab. Resolves null on timeout.
// Concurrent calls use different pooled tabs, enabling parallel scraping.
function runInTab(url, injectFn, opts) {
  const settle = (opts && opts.settle) || 1800;
  const timeout = (opts && opts.timeout) || 30000;
  return new Promise(async (resolve) => {
    const tabId = await acquireTab();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(guard);
      releaseTab(tabId); // return to the pool for reuse
      resolve(result);
    };
    function listener(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          chrome.scripting.executeScript({ target: { tabId }, func: injectFn }, (res) => {
            finish(res && res[0] ? res[0].result : null);
          });
        }, settle);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    const guard = setTimeout(() => finish(null), timeout);
    chrome.tabs.update(tabId, { url });
  });
}

// --- injected: first product link on a dropy.in search results page ---
function findFirstDropyProduct() {
  const a = document.querySelector('a[href*="/products/"]');
  return a ? a.getAttribute('href') : null;
}

// --- injected: scrape a dropy.in (Shopify) product page. Uses the product JSON
// (/products/<handle>.js) for the authoritative image list, and fetches each
// image's bytes SAME-ORIGIN (the tab has Cloudflare clearance) so we always get
// ALL product photos — no logo / recommended-product pollution, no lazy-load gaps.
async function extractDropyProductPage() {
  function ld() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const p = JSON.parse((s.textContent || '').trim());
        const items = Array.isArray(p) ? p : (p['@graph'] || [p]);
        for (const it of items) {
          if (it && (it['@type'] === 'Product' || (Array.isArray(it['@type']) && it['@type'].includes('Product')))) return it;
        }
      } catch (e) {}
    }
    return null;
  }
  const abs = (u) => (u && u.startsWith('//')) ? ('https:' + u) : u;
  const sized = (u, w) => {
    if (!u) return u;
    // Drop any existing Shopify _NxN size token so we get a fresh large render
    // instead of enlarging an already-shrunk thumbnail.
    u = u.replace(/_(\d{2,4})x(\d{2,4})?(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/i, '');
    // Replace an existing width param rather than appending a conflicting one.
    if (/[?&]width=\d+/i.test(u)) return u.replace(/([?&]width)=\d+/i, '$1=' + w);
    return u + (u.includes('?') ? '&' : '?') + 'width=' + w;
  };

  const data = {};
  const j = ld();
  if (j) {
    data.name = (j.name || '').toString().trim();
    data.sku = (j.sku || '').toString().trim();
    data.brand = (j.brand && (j.brand.name || (typeof j.brand === 'string' ? j.brand : ''))) || '';
    data.category = (j.category || '').toString().trim();
    data.full_description = (j.description || '').toString().trim();
    data.short_description = data.full_description.slice(0, 600);
  }

  const imgKey = (u) => {
    const p = (u || '').split('?')[0].split('#')[0];
    return p.substring(p.lastIndexOf('/') + 1).replace(/_(\d+)x(\d+)?\./, '.').toLowerCase();
  };

  // Collect the product's image URLs (NOT logo / recommended / cart).
  const urls = [];
  const seenK = new Set();
  const addU = (u) => {
    u = abs((u || '').trim());
    if (!u || !/^https?:/i.test(u)) return;
    const k = imgKey(u);
    if (!k || seenK.has(k)) return;
    seenK.add(k);
    urls.push(u);
  };

  if (j && j.image) {
    const imgs = Array.isArray(j.image) ? j.image : [j.image];
    imgs.forEach((x) => addU(typeof x === 'string' ? x : (x && x.url) || ''));
  }
  const ogm = document.querySelector('meta[property="og:image"]');
  if (ogm) addU(ogm.getAttribute('content'));

  // Gallery / thumbnail <img> on the page (these carry every image's URL even
  // when the slider has only rendered one), minus logo / recommended / cart.
  const EXCLUDE = 'header, footer, nav, [class*="recommend" i], [class*="related" i], ' +
    '[class*="complementary" i], cart-drawer, [class*="cart" i], [id*="cart" i], ' +
    '[class*="logo" i], [class*="header" i], [class*="footer" i], [class*="announce" i], ' +
    '[class*="upsell" i], [class*="cross-sell" i]';
  const GALLERY = '.product__media img, .product__media-item img, media-gallery img, ' +
    '.product-gallery img, [id^="MediaGallery"] img, .product-single__photo img, ' +
    '.product__media-list img, .product__photo img, [class*="thumbnail" i] img, ' +
    '[class*="product"][class*="media"] img, [class*="product"][class*="gallery"] img';
  document.querySelectorAll(GALLERY).forEach((im) => {
    if (im.closest && im.closest(EXCLUDE)) return;
    let u = im.getAttribute('src') || im.getAttribute('data-src') || im.currentSrc || '';
    if (!u) { const ss = im.getAttribute('srcset'); if (ss) u = ss.split(',')[0].trim().split(' ')[0]; }
    addU(u);
  });

  // Also try the Shopify product JSON for a fuller list + clean description.
  try {
    const r = await fetch(location.pathname.replace(/\/$/, '') + '.js', { credentials: 'include' });
    if (r.ok) {
      const pj = await r.json();
      if (Array.isArray(pj.images)) pj.images.forEach(addU);
      if (!data.full_description && pj.description) {
        data.full_description = pj.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        data.short_description = data.full_description.slice(0, 600);
      }
    }
  } catch (e) { /* fetch may be blocked; DOM URLs already collected */ }

  // Load each URL via a real <img> (Cloudflare allows image loads) and draw to
  // canvas for its bytes at HIGH RESOLUTION + HIGH QUALITY so the uploaded
  // review photos are crisp. Same-origin dropy.in images don't taint the canvas.
  const toDataUrl = (u) => new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    img.onload = () => {
      try {
        const maxD = 2400; // keep full clarity; only shrink if larger than this
        const sc = Math.min(1, maxD / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * sc));
        cv.height = Math.max(1, Math.round(img.naturalHeight * sc));
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        finish({ data: cv.toDataURL('image/jpeg', 0.95), w: img.naturalWidth, h: img.naturalHeight });
      } catch (e) { finish({ data: '', w: 0, h: 0 }); } // cross-origin -> URL-only
    };
    img.onerror = () => finish({ data: '', w: 0, h: 0 });
    setTimeout(() => finish({ data: '', w: 0, h: 0 }), 12000);
    img.src = sized(u, 2600); // request a large version from Shopify's CDN
  });

  // Loads a URL and pads it onto a WHITE SQUARE canvas with margin. Google Lens
  // auto-crops to the dominant object; padding makes the whole product the
  // object (with breathing room) so Lens stops cropping into it.
  const padToSquare = (u) => new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const side = Math.round(Math.max(w, h) * 1.25); // ~12.5% margin all around
        const cv = document.createElement('canvas');
        cv.width = side; cv.height = side;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, side, side);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
        finish(cv.toDataURL('image/jpeg', 0.95));
      } catch (e) { finish(''); }
    };
    img.onerror = () => finish('');
    setTimeout(() => finish(''), 12000);
    img.src = sized(u, 2000);
  });

  const gallery = [];
  for (const u of urls.slice(0, 8)) {
    const r = await toDataUrl(u);
    gallery.push({ url: u, data: r.data, w: r.w, h: r.h, alt: '' });
  }

  data.gallery = gallery.map((g) => ({ url: g.url, data: g.data, alt: g.alt }));
  data.images = urls.slice(0, 12);
  data.image = urls[0] || '';

  // Pick the cleanest image for the Lens search: a captured one that's the most
  // square (avoids wide multi-jar composites), then pad it so Lens won't over-crop.
  const captured = gallery.filter((g) => g.data && g.w && g.h);
  let lensSrc = captured.slice().sort((a, b) =>
    Math.abs(a.w / a.h - 1) - Math.abs(b.w / b.h - 1))[0];
  if (lensSrc) {
    data.imageData = (await padToSquare(lensSrc.url)) || lensSrc.data;
  } else {
    data.imageData = (gallery.find((g) => g.data) || {}).data || '';
  }

  if (!data.name) data.name = document.querySelector('h1')?.innerText?.trim() || document.title || '';
  if (!data.full_description) {
    const ogd = document.querySelector('meta[name="description"], meta[property="og:description"]');
    data.short_description = ogd ? (ogd.getAttribute('content') || '') : '';
  }
  return data;
}

// --- injected: collect visual-match images from a Google Lens results page ---
// async: opens the "Visual matches" tab if present, then scrolls to lazy-load.
async function scrapeLensImages() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Open the "Visual matches" view if there's a tab for it.
  const tabEls = Array.from(document.querySelectorAll('a, [role="link"], [role="tab"], span, div'));
  const vm = tabEls.find((e) => {
    const t = (e.textContent || '').trim();
    return /^visual matches$/i.test(t) || /exact matches/i.test(t);
  });
  if (vm) { try { vm.click(); } catch (e) {} await wait(2500); }

  // Scroll deeper to load many more results (more candidates).
  for (let i = 0; i < 14; i++) { window.scrollBy(0, window.innerHeight); await wait(700); }
  // Click any "more results" / "show more" button if present.
  Array.from(document.querySelectorAll('input[type="button"], button, [role="button"]')).forEach((b) => {
    if (/more results|show more|load more/i.test((b.textContent || b.value || ''))) { try { b.click(); } catch (e) {} }
  });
  await wait(1200);

  // TRUE user-generated content: social / community / video platforms.
  const UGC = /(instagram|cdninstagram|fbcdn|facebook|tiktok|tiktokcdn|reddit|redd\.it|redditmedia|pinimg|pinterest|twimg|twitter|x\.com|ytimg|youtube)/i;
  // Shopping / catalog CDNs = listing & white-background model shots — DROP these.
  const SHOPPING = /(media-amazon|ssl-images-amazon|images-amazon|images-na|rukminim|fkcdn|flixcart|nykaa|myntassets|myntra|assets\.ajio|ajio|jiomart|alicdn|aliexpress|ae0?1\.alicdn|ebayimg|scene7|cdn\.shopify|\/cdn\/shop\/)/i;
  const isThumb = (u) => /gstatic\.com|googleusercontent\.com|encrypted-tbn|\/images\?q=tbn|tbn:/i.test(u);

  // Upgrade known thumbnail URLs to higher resolution where possible.
  const upscale = (u) => {
    // YouTube: /vi/<id>/<thumb>.jpg -> sddefault (640) — clearer than default.
    u = u.replace(/(i\.?ytimg\.com\/vi\/[^/]+\/)[a-z0-9_]+\.jpg/i, '$1sddefault.jpg');
    // Generic CDN size query params (width/w/height/h/size/sz) -> bump way up.
    u = u.replace(/([?&](?:width|w|height|h|size|sz))=\d+/ig, '$1=2048');
    // Shopify-style _123x456 (or _123x) filename size token -> drop it to get
    // the original (largest) render instead of a shrunk thumbnail.
    u = u.replace(/_(\d{2,4})x(\d{2,4})?(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/i, '');
    // Google usercontent / ggpht size suffix (=s200, =w200-h200) -> larger.
    u = u.replace(/=s\d+(-c)?$/i, '=s2048');
    u = u.replace(/=w\d+-h\d+(-[a-z]+)?$/i, '=w2048');
    return u;
  };

  // Each candidate keeps a THUMB (loads reliably in the picker for display) and
  // a FULL url (the real high-res source, used for the actual upload).
  const items = [];
  const seen = new Set();
  const MARKETING = /(?:^|[/_\-.])(banner|hero|promo|promotion|campaign|billboard|advert|advertis|adbanner|lifestyle|keyvisual|kv|cover|header[_-]?img|masthead|catalog|catalogue|packshot|render|mockup|template|infographic|swatch|logo|placeholder|sprite)(?:[/_\-.]|$)/i;
  const push = (fullUrl, thumbUrl, ref, ctx) => {
    let f = (fullUrl || thumbUrl || '').trim();
    const t = (thumbUrl || fullUrl || '').trim();
    if (!f || !/^https?:/i.test(f) || f.startsWith('data:')) return;
    if (/\.svg(\?|$)/i.test(f)) return;
    if (/googlelogo|nav_logo|branding|\/gen_204|favicon|gstatic\.com\/(?:images\/branding|ui)/i.test(f)) return;
    if (MARKETING.test(f)) return;
    if (SHOPPING.test(f) || SHOPPING.test(ref || '')) return;
    f = upscale(f);
    if (seen.has(f)) return;
    seen.add(f);
    items.push({
      full: f,
      thumb: t || f,
      ctx: ((ref || '') + ' ' + (ctx || '')).trim().slice(0, 240),
      ugc: UGC.test(f) || UGC.test(ref || '')
    });
  };

  // Result images: the <img> is the displayable thumbnail; the closest anchor's
  // imgurl is the full-resolution source.
  document.querySelectorAll('img').forEach((img) => {
    const w = img.naturalWidth || img.width || 0;
    if (w && w < 40) return;
    const thumb = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (!thumb || thumb.startsWith('data:')) return;
    const a = img.closest('a');
    let full = thumb;
    if (a) { const m = (a.href || '').match(/[?&]imgurl=([^&]+)/); if (m) { try { full = decodeURIComponent(m[1]); } catch (e) {} } }
    const ref = a ? a.getAttribute('href') : '';
    const ctx = [img.getAttribute('alt'), img.getAttribute('aria-label'), ref].filter(Boolean).join(' ');
    push(full, thumb, ref, ctx);
  });
  // imgurl anchors that had no paired <img> (full only).
  document.querySelectorAll('a[href*="imgurl="]').forEach((a) => {
    try {
      const mu = (a.href || '').match(/[?&]imgurl=([^&]+)/);
      const mr = (a.href || '').match(/[?&]imgrefurl=([^&]+)/);
      if (mu) push(decodeURIComponent(mu[1]), '', mr ? decodeURIComponent(mr[1]) : '', (a.getAttribute('aria-label') || a.textContent || '').slice(0, 160));
    } catch (e) {}
  });

  // Real UGC first.
  items.sort((a, b) => (b.ugc ? 1 : 0) - (a.ugc ? 1 : 0));
  const out = items.slice(0, 60);
  return { items: out, ugc: out.filter((i) => i.ugc).length, text: (document.body ? document.body.innerText : '').slice(0, 2500) };
}

// --- injected: scrape CUSTOMER REVIEW images from an Amazon product page ---
// (real photos uploaded by buyers — NOT the catalog/product image block).
async function scrapeAmazonReviewImages() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bodyText = document.body ? (document.body.innerText || '') : '';
  if (
    document.querySelector('form[action*="validateCaptcha"], #captchacharacters') ||
    /Robot Check|not a robot|Enter the characters you see/i.test((document.title || '') + ' ' + bodyText.slice(0, 500))
  ) {
    return { captcha: true, images: [] };
  }

  // Jump to the reviews area and scroll so customer images lazy-load.
  const rev = document.querySelector('#reviewsMedley, #customerReviews, #cm-cr-dp-review-list, [data-hook="reviews-medley-footer"]');
  if (rev && rev.scrollIntoView) rev.scrollIntoView();
  for (let i = 0; i < 8; i++) { window.scrollBy(0, window.innerHeight); await wait(700); }
  await wait(900);

  const out = [];
  const seen = new Set();
  const fullRes = (u) => u.replace(/\._[A-Z0-9,_]+_\.(jpe?g|png|webp)/i, '.$1'); // strip size modifier
  const add = (u) => {
    if (!u || !/^https?:/i.test(u)) return;
    if (!/media-amazon\.com\/images\/I\//i.test(u)) return; // only real photo files
    u = fullRes(u);
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  // Customer-images strip + per-review image tiles (review sections only).
  const SEL = '#cr-media-carousel img, [data-hook="cr-media-carousel"] img, ' +
    '[data-hook="review-image-tile"], img[data-hook="review-image-tile"], ' +
    '.review-image-tile, #cm_cr_carousel_images_section img, .cr-lightbox-image-thumbnail img, ' +
    '#reviewsMedley img[src*="media-amazon.com/images/I"], #cm-cr-dp-review-list img[src*="media-amazon.com/images/I"]';
  document.querySelectorAll(SEL).forEach((el) => {
    const u = (el.tagName === 'IMG')
      ? (el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src') || '')
      : (el.getAttribute('src') || '');
    add(u);
  });

  return { images: out.slice(0, 30) };
}

// --- injected: scrape Google Search AI Overview text (best-effort) ---
function scrapeAiOverview() {
  const sels = [
    '[data-attrid="SGEAnswer"]', '[data-subtree="aifo"]',
    'div[aria-label*="AI Overview" i]', '#m-x-content',
    '.YzCcne', '.LT6XE', '.wDYxhc'
  ];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    const t = el && (el.innerText || '').trim();
    if (t && t.length > 80) return t.slice(0, 2500);
  }
  // Fallback: featured snippet / knowledge panel description
  const fb = document.querySelector('.hgKElc, .kno-rdesc span, [data-attrid="description"]');
  const ft = fb && (fb.innerText || '').trim();
  return ft ? ft.slice(0, 1500) : '';
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(',');
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Runs Google Lens on the product image and scrapes the visual matches.
// PREFERRED path (reliable): host the image on Shopify Files to get a public
// cdn.shopify.com URL (which Google CAN fetch, unlike Cloudflare-blocked
// dropy.in), then lens.google.com/uploadbyurl. Falls back to a raw byte-upload.
async function lensSearchByBytes(dataUrl) {
  if (!dataUrl) return { images: [], text: '' };

  // Preferred: public Shopify URL -> uploadbyurl
  if (SHOPIFY.domain && SHOPIFY.token) {
    try {
      const blob = dataUrlToBlob(dataUrl);
      const uploaded = await uploadToShopifyFiles(blob, 'lens-search.jpg');
      const publicUrl = uploaded && uploaded.url;
      if (publicUrl) {
        const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(publicUrl)}`;
        const scraped = await runInTab(lensUrl, scrapeLensImages, { settle: 4500, timeout: 45000 });
        // searchFileId lets the panel clean up this temporary search image later.
        return Object.assign({ images: [], text: '', resultUrl: lensUrl, via: 'shopify-url', searchFileId: uploaded.id }, scraped || {});
      }
    } catch (e) { /* fall through to byte-upload */ }
  }

  // Fallback: raw byte-upload (often rate-limited / rejected by Google)
  try {
    const blob = dataUrlToBlob(dataUrl);
    const fd = new FormData();
    fd.append('encoded_image', blob, 'product.jpg');
    fd.append('image_content', '');
    const resp = await fetch('https://www.google.com/searchbyimage/upload', {
      method: 'POST', body: fd, redirect: 'follow'
    });
    const resultUrl = resp.url || '';
    if (!resultUrl || !/google\.[^/]+\/search/i.test(resultUrl) || /\/searchbyimage\/upload/i.test(resultUrl)) {
      return { images: [], text: '', resultUrl, error: 'byte-upload not accepted (configure Shopify for reliable Lens)' };
    }
    const scraped = await runInTab(resultUrl, scrapeLensImages, { settle: 4500, timeout: 45000 });
    return Object.assign({ images: [], text: '', resultUrl, via: 'byte-upload' }, scraped || {});
  } catch (e) {
    return { images: [], text: '', error: e.message };
  }
}

// POSTs selected images to the dropy review server. `images` is an array of
// { url, dataUrl } (dataUrl = captured bytes when available). Returns { ok, urls }
// where urls are PUBLIC hosted URLs (never data URLs). If not configured, returns
// the original source URLs so the flow still works.
async function uploadReviewImages(sku, images) {
  const items = (images || []).map((x) => (typeof x === 'string' ? { url: x, dataUrl: '' } : x));
  const sourceUrls = items.map((i) => i.url).filter(Boolean);

  // Preferred: Shopify Files API → public cdn.shopify.com URLs (Judge.me-fetchable).
  // Keeps urls/fileIds 1:1 with the input order (uses source URL on failure).
  if (SHOPIFY.domain && SHOPIFY.token) {
    const urls = [];
    const fileIds = [];
    let okCount = 0;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      try {
        let blob = null;
        if (it.dataUrl) blob = dataUrlToBlob(it.dataUrl);
        else if (it.url) blob = await (await fetch(it.url)).blob();
        if (!blob) { urls.push(it.url || ''); fileIds.push(''); continue; }
        const u = await uploadToShopifyFiles(blob, `review-${sku}-${n + 1}.jpg`);
        urls.push((u && u.url) || it.url || '');
        fileIds.push((u && u.id) || '');
        if (u && u.url) okCount++;
      } catch (e) { urls.push(it.url || ''); fileIds.push(''); }
    }
    if (okCount) return { ok: true, configured: true, via: 'shopify', urls, fileIds };
    return { ok: false, configured: true, via: 'shopify', error: 'Shopify upload returned no URLs', urls: sourceUrls, fileIds };
  }

  if (!DROPY_UPLOAD.endpoint) {
    return { ok: false, configured: false, urls: sourceUrls };
  }
  try {
    if (DROPY_UPLOAD.mode === 'file') {
      // Multipart: prefer captured bytes (dataUrl); else fetch the URL.
      const urls = [];
      for (const it of items) {
        let blob = null;
        if (it.dataUrl) blob = dataUrlToBlob(it.dataUrl);
        else if (it.url) blob = await (await fetch(it.url)).blob();
        if (!blob) continue;
        const fd = new FormData();
        fd.append(DROPY_UPLOAD.skuField, sku);
        fd.append(DROPY_UPLOAD.imageField, blob, 'review.jpg');
        const r = await fetch(DROPY_UPLOAD.endpoint, {
          method: DROPY_UPLOAD.method,
          headers: DROPY_UPLOAD.authHeader ? { [DROPY_UPLOAD.authHeader]: DROPY_UPLOAD.authValue } : {},
          body: fd
        });
        const j = await r.json().catch(() => ({}));
        urls.push(j.url || j.location || it.url);
      }
      return { ok: true, configured: true, urls: urls.filter(Boolean) };
    }

    // url mode: send the image URLs as JSON, expect hosted URLs back.
    const headers = { 'Content-Type': 'application/json' };
    if (DROPY_UPLOAD.authHeader) headers[DROPY_UPLOAD.authHeader] = DROPY_UPLOAD.authValue;
    const body = {};
    body[DROPY_UPLOAD.skuField] = sku;
    body[DROPY_UPLOAD.imageField + 's'] = sourceUrls;
    const r = await fetch(DROPY_UPLOAD.endpoint, { method: DROPY_UPLOAD.method, headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: true, configured: true, urls: j.urls || j.images || sourceUrls };
  } catch (e) {
    return { ok: false, configured: true, error: e.message, urls: sourceUrls };
  }
}

// Injected into the Amazon product page (runs in the page's context).
// Returns { captcha:true } if Amazon served a robot/CAPTCHA wall, otherwise
// the extracted product fields.
function extractAmazonProduct() {
  const bodyText = document.body ? (document.body.innerText || '') : '';
  if (
    document.querySelector('form[action*="validateCaptcha"], #captchacharacters, img[src*="captcha"]') ||
    /Robot Check|Enter the characters you see below|not a robot|Type the characters you see/i.test(
      (document.title || '') + ' ' + bodyText.slice(0, 600)
    )
  ) {
    return { captcha: true };
  }

  const txt = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim() : '';
  };

  const data = {};
  data.name = txt('#productTitle') || txt('#title');

  let brand = txt('#bylineInfo') || txt('a#brand') || txt('#bylineInfo_feature_div a');
  brand = brand.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim();
  data.brand = brand;

  const bullets = [];
  document.querySelectorAll('#feature-bullets li, #feature-bullets .a-list-item').forEach((li) => {
    const t = (li.innerText || '').trim();
    if (t && !/^see more|^hide/i.test(t)) bullets.push(t);
  });
  data.bullets = bullets.slice(0, 10).join(' | ');

  data.full_description = (txt('#productDescription') || '').slice(0, 2000);

  const cats = [];
  document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a').forEach((a) => {
    const t = (a.innerText || '').trim();
    if (t) cats.push(t);
  });
  data.category = cats.join(' > ');

  const specs = [];
  document.querySelectorAll('#detailBullets_feature_div li').forEach((li) => {
    const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
    if (t) specs.push(t);
  });
  document.querySelectorAll(
    '#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, .prodDetTable tr'
  ).forEach((tr) => {
    const th = tr.querySelector('th');
    const td = tr.querySelector('td');
    if (th && td) specs.push(`${(th.innerText || '').trim()}: ${(td.innerText || '').replace(/\s+/g, ' ').trim()}`);
  });
  data.specifications = specs.slice(0, 15).join(', ');

  data.short_description = data.bullets || data.full_description.slice(0, 500);
  data.tags = '';
  return data;
}

// Tries each Amazon domain in order; moves to the next on timeout, CAPTCHA, or
// empty result. Calls sendResponse once with the first good scrape (or an error).
function scrapeAmazonAcrossDomains(asin, domains, sendResponse) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= domains.length) {
      sendResponse({ error: 'Amazon scrape failed (blocked/not found on all domains)', name: '' });
      return;
    }
    const domain = domains[idx++];
    const url = `https://${domain}/dp/${asin}`;
    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;
      let settled = false;
      const finish = (result, retry) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(guard);
        try { chrome.tabs.remove(tabId); } catch (e) {}
        if (retry) tryNext();
        else sendResponse(result);
      };
      function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => {
            chrome.scripting.executeScript(
              { target: { tabId }, func: extractAmazonProduct },
              (res) => {
                const data = res && res[0] && res[0].result;
                if (!data || data.captcha || !data.name) {
                  finish(null, true); // blocked or empty -> try next domain
                } else {
                  data.source = domain;
                  finish(data, false);
                }
              }
            );
          }, 1800);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      const guard = setTimeout(() => finish(null, true), 30000);
    });
  };
  tryNext();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'save_file') {
    // Silent save — no "Save As" dialog, auto-rename on conflict.
    chrome.downloads.download(
      { url: msg.dataUrl, filename: msg.filename, saveAs: false, conflictAction: msg.conflictAction || 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'download failed' });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true;
  }

  if (msg.action === 'scrape_amazon') {
    const domains = (msg.domains && msg.domains.length) ? msg.domains : ['www.amazon.in', 'www.amazon.com'];
    scrapeAmazonAcrossDomains(msg.asin, domains, sendResponse);
    return true;
  }

  if (msg.action === 'dropy_lookup') {
    (async () => {
      const searchUrl = `https://dropy.in/search?q=${encodeURIComponent(msg.query)}`;
      const href = await runInTab(searchUrl, findFirstDropyProduct, { settle: 2000 });
      if (!href) { sendResponse({ error: 'Product not found on dropy.in', name: '' }); return; }
      const productUrl = href.startsWith('http') ? href : ('https://dropy.in' + href);
      const data = await runInTab(productUrl, extractDropyProductPage, { settle: 1800 });
      if (!data || !data.name) { sendResponse({ error: 'Could not scrape dropy product', name: '' }); return; }
      data.productUrl = productUrl;

      // Get the ORIGINAL, untouched image files from Shopify's public product
      // JSON on the myshopify domain (cdn.shopify.com URLs — no Cloudflare, no
      // editing). These are preferred over the canvas-captured fallback.
      try {
        const handle = (productUrl.split('/products/')[1] || '').split(/[?#]/)[0];
        if (handle && SHOPIFY.domain) {
          const r = await fetch(`https://${SHOPIFY.domain}/products/${handle}.js`);
          if (r.ok) {
            const pj = await r.json();
            if (Array.isArray(pj.images) && pj.images.length) {
              data.originalImages = pj.images.map((u) => (u && u.startsWith('//')) ? ('https:' + u) : u).filter(Boolean);
            }
            // Barcode (UPC/EAN/GTIN) from the variant — a strong unique key.
            const bc = pj.variants && pj.variants.find((v) => v && v.barcode && String(v.barcode).trim());
            if (bc) data.barcode = String(bc.barcode).trim();
            if (!data.full_description && pj.description) {
              data.full_description = String(pj.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              data.short_description = data.full_description.slice(0, 600);
            }
          }
        }
      } catch (e) { /* fall back to captured gallery */ }

      sendResponse(data);
    })();
    return true;
  }

  if (msg.action === 'amazon_review_images') {
    (async () => {
      const domains = (msg.domains && msg.domains.length) ? msg.domains : ['www.amazon.in', 'www.amazon.com'];
      for (const d of domains) {
        const res = await runInTab(`https://${d}/dp/${msg.asin}`, scrapeAmazonReviewImages, { settle: 2500, timeout: 35000 });
        if (res && !res.captcha && res.images && res.images.length) {
          sendResponse({ images: res.images, source: d });
          return;
        }
      }
      sendResponse({ images: [] });
    })();
    return true;
  }

  if (msg.action === 'google_images') {
    (async () => {
      if (!msg.query) { sendResponse({ images: [], ugc: 0 }); return; }
      const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(msg.query)}`;
      const scraped = await runInTab(url, scrapeLensImages, { settle: 3500, timeout: 40000 });
      sendResponse(scraped || { images: [], ugc: 0 });
    })();
    return true;
  }

  if (msg.action === 'lens_by_url') {
    (async () => {
      if (!msg.imageUrl) { sendResponse({ images: [], text: '' }); return; }
      const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(msg.imageUrl)}`;
      const scraped = await runInTab(lensUrl, scrapeLensImages, { settle: 4500, timeout: 45000 });
      sendResponse(Object.assign({ images: [], text: '', resultUrl: lensUrl, via: 'public-url' }, scraped || {}));
    })();
    return true;
  }

  if (msg.action === 'lens_by_bytes') {
    (async () => {
      const result = await lensSearchByBytes(msg.imageData);
      sendResponse(result || { images: [], text: '' });
    })();
    return true;
  }

  if (msg.action === 'lens_search') {
    (async () => {
      if (!msg.imageUrl) { sendResponse({ images: [], text: '' }); return; }
      const url = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(msg.imageUrl)}`;
      const result = await runInTab(url, scrapeLensImages, { settle: 4000, timeout: 35000 });
      sendResponse(result || { images: [], text: '' });
    })();
    return true;
  }

  if (msg.action === 'ai_overview') {
    (async () => {
      const url = `https://www.google.com/search?q=${encodeURIComponent(msg.query)}`;
      const text = await runInTab(url, scrapeAiOverview, { settle: 3000 });
      sendResponse({ text: text || '' });
    })();
    return true;
  }

  if (msg.action === 'upload_images') {
    (async () => {
      const result = await uploadReviewImages(msg.sku, msg.images || []);
      sendResponse(result);
    })();
    return true;
  }

  if (msg.action === 'scrape_dropy') {
    chrome.tabs.create({ url: msg.url, active: false }, (tab) => {
      const tabId = tab.id;
      let settled = false;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(guard);
        try { chrome.tabs.remove(tabId); } catch (e) {}
        sendResponse(response);
      };
      function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: 'extract_product' }, (response) => {
              finish(response || { error: chrome.runtime.lastError?.message || 'No data extracted' });
            });
          }, 1500);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Safety net: never let the side panel await forever on a stuck load.
      const guard = setTimeout(() => finish({ error: 'Timed out loading product page' }), 45000);
    });
    return true;
  }

  if (msg.action === 'search_web') {
    const query = encodeURIComponent(msg.query);
    const url = `https://www.google.com/search?q=${query}`;
    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;
      let settled = false;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(guard);
        try { chrome.tabs.remove(tabId); } catch (e) {}
        sendResponse(response);
      };
      function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => {
            chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const results = [];
                document.querySelectorAll('.g, .tF2Cxc').forEach(el => {
                  const text = el.innerText || '';
                  if (text.length > 50) results.push(text.substring(0, 500));
                });
                return results.slice(0, 5).join('\n---\n');
              }
            }, (injectionResults) => {
              finish({ data: injectionResults?.[0]?.result || '' });
            });
          }, 1500);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Web search is optional context — don't let it stall the run.
      const guard = setTimeout(() => finish({ data: '' }), 30000);
    });
    return true;
  }

  if (msg.action === 'open_gemini') {
    chrome.tabs.create({ url: 'https://gemini.google.com/app?hl=en-IN', active: false }, (tab) => {
      sendResponse({ tabId: tab.id });
    });
    return true;
  }

  if (msg.action === 'send_to_gemini') {
    chrome.tabs.sendMessage(msg.tabId, {
      action: 'inject_prompt',
      prompt: msg.prompt
    }, (response) => {
      sendResponse(response || { error: 'No response from Gemini' });
    });
    return true;
  }

  if (msg.action === 'close_tab') {
    chrome.tabs.remove(msg.tabId);
    sendResponse({ done: true });
    return true;
  }

  if (msg.action === 'close_scrape_tab') {
    (async () => { await closeAllScrapeTabs(); sendResponse({ done: true }); })();
    return true;
  }

  if (msg.action === 'delete_shopify_files') {
    (async () => { sendResponse(await deleteShopifyFiles(msg.fileIds || [])); })();
    return true;
  }

  if (msg.action === 'new_gemini_chat') {
    chrome.tabs.update(msg.tabId, { url: 'https://gemini.google.com/app?hl=en-IN' }, () => {
      sendResponse({ done: true });
    });
    return true;
  }
});
