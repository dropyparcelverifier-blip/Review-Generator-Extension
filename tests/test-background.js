// Tests for background.js: dataUrlToBlob (loaded from the real file) and the
// sized()/upscale() image-URL transforms (validated against copies of the exact
// regexes now in the source).
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0; const fails = [];
function eq(a, e, m) { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; fails.push(`FAIL ${m}\n  exp ${E}\n  got ${A}`); } }
function ok(c, m) { if (c) pass++; else { fail++; fails.push('FAIL ' + m); } }

// ---- load background.js and test dataUrlToBlob ----
const code = fs.readFileSync(require('path').join(__dirname, '..', 'background.js'), 'utf8');
const sandbox = {
  self: {}, console, Math, Date, JSON, RegExp, Set, Array, Object, String, Number,
  atob, btoa, Buffer, Uint8Array, Blob, encodeURIComponent, decodeURIComponent, setTimeout,
  fetch: () => Promise.resolve({}),
  importScripts: () => { throw new Error('no config'); },
  chrome: { action: { onClicked: { addListener() {} } }, runtime: { onMessage: { addListener() {} }, getURL: (p) => 'chrome-extension://id/' + p }, tabs: {}, windows: {}, scripting: {}, downloads: {}, storage: { session: {} } },
};
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'background.js' });

// data:image/jpeg;base64,AAAA -> atob('AAAA') = 3 zero bytes
const blob = sandbox.dataUrlToBlob('data:image/jpeg;base64,AAAA');
eq(blob.size, 3, 'dataUrlToBlob size');
eq(blob.type, 'image/jpeg', 'dataUrlToBlob mime');
const blob2 = sandbox.dataUrlToBlob('data:image/png;base64,AAAAAA');
eq(blob2.type, 'image/png', 'dataUrlToBlob png mime');
eq(blob2.size, 4, 'dataUrlToBlob png size');

// ---- sized(): copy of the exact source implementation ----
const sized = (u, w) => {
  if (!u) return u;
  u = u.replace(/_(\d{2,4})x(\d{2,4})?(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/i, '');
  if (/[?&]width=\d+/i.test(u)) return u.replace(/([?&]width)=\d+/i, '$1=' + w);
  return u + (u.includes('?') ? '&' : '?') + 'width=' + w;
};
eq(sized('https://cdn.shopify.com/x/product.jpg', 2600), 'https://cdn.shopify.com/x/product.jpg?width=2600', 'sized adds width');
eq(sized('https://cdn.shopify.com/x/product_800x800.jpg', 2600), 'https://cdn.shopify.com/x/product.jpg?width=2600', 'sized strips _NxN token');
eq(sized('https://cdn.shopify.com/x/product_800x.jpg', 2600), 'https://cdn.shopify.com/x/product.jpg?width=2600', 'sized strips width-only token');
eq(sized('https://cdn.shopify.com/x/product_800x800.jpg?v=123', 2600), 'https://cdn.shopify.com/x/product.jpg?v=123&width=2600', 'sized token+query -> append &');
eq(sized('https://cdn.shopify.com/x/product.jpg?width=100', 2600), 'https://cdn.shopify.com/x/product.jpg?width=2600', 'sized replaces existing width');
eq(sized('', 2600), '', 'sized empty passthrough');
// must NOT strip a non-size underscore token
eq(sized('https://c/img_hero.jpg', 100), 'https://c/img_hero.jpg?width=100', 'sized leaves non-size token');

// ---- upscale(): copy of the exact source implementation ----
const upscale = (u) => {
  u = u.replace(/(i\.?ytimg\.com\/vi\/[^/]+\/)[a-z0-9_]+\.jpg/i, '$1sddefault.jpg');
  u = u.replace(/([?&](?:width|w|height|h|size|sz))=\d+/ig, '$1=2048');
  u = u.replace(/_(\d{2,4})x(\d{2,4})?(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/i, '');
  u = u.replace(/=s\d+(-c)?$/i, '=s2048');
  u = u.replace(/=w\d+-h\d+(-[a-z]+)?$/i, '=w2048');
  return u;
};
eq(upscale('https://i.ytimg.com/vi/ABC123/hqdefault.jpg'), 'https://i.ytimg.com/vi/ABC123/sddefault.jpg', 'upscale youtube -> sddefault');
eq(upscale('https://c/i.jpg?width=200'), 'https://c/i.jpg?width=2048', 'upscale width param');
eq(upscale('https://c/i.jpg?w=100&h=100'), 'https://c/i.jpg?w=2048&h=2048', 'upscale w & h params (global)');
eq(upscale('https://c/pic_320x240.jpg'), 'https://c/pic.jpg', 'upscale strips shopify token');
eq(upscale('https://lh3.googleusercontent.com/abc=s200'), 'https://lh3.googleusercontent.com/abc=s2048', 'upscale google =s suffix');
eq(upscale('https://lh3.googleusercontent.com/abc=s200-c'), 'https://lh3.googleusercontent.com/abc=s2048', 'upscale google =s-c suffix');
eq(upscale('https://lh3.googleusercontent.com/abc=w400-h300'), 'https://lh3.googleusercontent.com/abc=w2048', 'upscale google =w-h suffix');
eq(upscale('https://c/plain.jpg'), 'https://c/plain.jpg', 'upscale leaves plain url');

// catastrophic-backtracking sanity: long benign string returns fast
const big = 'https://c/' + 'a'.repeat(5000) + '.jpg?width=10';
const t0 = Date.now();
upscale(big); sized(big, 100);
ok(Date.now() - t0 < 200, 'regex fast on long input (no catastrophic backtracking)');

// ---- findDropyProductByAsin: predictive search + ASIN confirmation ----
// Handle-aware fetch + DOM mock: `dom` = product handles linked on the search
// results page; routes /search/suggest.json, /products/<handle>.js, and
// /products/<handle> (HTML) independently.
function install({ dom = [], products = [], suggestOk = true, js = {}, html = {}, title = '', bodyText = '' }) {
  sandbox.document = {
    title, body: { innerText: bodyText },
    querySelectorAll: (sel) => (String(sel).includes('/products/') ? dom.map((h) => ({ getAttribute: () => '/products/' + h })) : []),
  };
  sandbox.fetch = (url) => {
    if (url.includes('/search/suggest.json')) {
      return suggestOk
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ resources: { results: { products } } }) })
        : Promise.resolve({ ok: false });
    }
    const path = url.split('?')[0];
    const isJs = path.endsWith('.js');
    const handle = path.replace(/^.*\/products\//, '').replace(/\.js$/, '');
    if (isJs) return (handle in js) ? Promise.resolve({ ok: true, json: () => Promise.resolve(js[handle]) }) : Promise.resolve({ ok: false });
    return (handle in html) ? Promise.resolve({ ok: true, text: () => Promise.resolve(html[handle]) }) : Promise.resolve({ ok: false });
  };
}
(async () => {
  // Regression: product EXISTS (full search finds it) but predictive search is
  // empty. Must still be found via the results-page DOM.
  install({
    dom: ['one-a-day-womens-petites'], products: [],
    js: { 'one-a-day-womens-petites': { handle: 'one-a-day-womens-petites', title: 'One A Day', tags: [], variants: [{ sku: 'B0848LNYG2', barcode: '' }] } },
  });
  let res = await sandbox.findDropyProductByAsin('B0848LNYG2');
  eq(res && res.url, '/products/one-a-day-womens-petites', 'found via search-page DOM when predictive search is empty');
  ok(res && res.matched === true, 'DOM-found product ASIN-matched');

  // JSON pass — screenshot scenario: screws ranked first, ASIN in Centrum SKU.
  install({
    dom: ['tjfujie-screws', 'centrum-200'], products: [],
    js: {
      'tjfujie-screws': { handle: 'tjfujie-screws', title: 'Tjfujie Screws', tags: [], body_html: 'screws', variants: [{ sku: 'TJ-1', barcode: '' }] },
      'centrum-200': { handle: 'centrum-200', title: 'Centrum Adult Multivitamin', tags: ['vitamins'], body_html: 'multivitamin', variants: [{ sku: 'B09BVYY7XR', barcode: '' }] },
    },
  });
  res = await sandbox.findDropyProductByAsin('B09BVYY7XR');
  eq(res && res.url, '/products/centrum-200', 'JSON pass: picks ASIN-matching product, not first (screws)');
  ok(res && res.matched === true && res.via === 'json', 'JSON pass: matched via json');

  // HTML pass — ASIN absent from every .js but present in a product's HTML.
  install({
    dom: ['aaa', 'right'], products: [],
    js: { aaa: { handle: 'aaa', title: 'A', variants: [{ sku: 'X', barcode: '' }] }, right: { handle: 'right', title: 'Right Product', variants: [{ sku: 'INTERNAL', barcode: '' }] } },
    html: { aaa: '<html>nothing relevant here</html>', right: '<html><script type="application/ld+json">{"sku":"B09BVYY7XR"}</script></html>' },
  });
  res = await sandbox.findDropyProductByAsin('B09BVYY7XR');
  eq(res && res.url, '/products/right', 'HTML pass: finds ASIN in product HTML when absent from .js');
  ok(res && res.matched === true && res.via === 'html', 'HTML pass: matched via html');

  // Predictive #1 is TRUSTED even when the ASIN isn't in any product JSON/HTML
  // (Shopify search matched it via a metafield). Full-text ranks screws first,
  // predictive ranks centrum #1 -> must pick centrum, matched via predictive.
  install({
    products: [{ handle: 'centrum-200', url: '/products/centrum-200' }], // predictive #1
    dom: ['tjfujie-screws', 'centrum-200'], // full-text ranks screws first
    js: {
      'centrum-200': { handle: 'centrum-200', title: 'Centrum', variants: [{ sku: 'INTERNAL', barcode: '' }] }, // no ASIN
      'tjfujie-screws': { handle: 'tjfujie-screws', title: 'Screws', variants: [{ sku: 'TJ', barcode: '' }] },
    },
    html: { 'centrum-200': '<html>centrum</html>', 'tjfujie-screws': '<html>screws</html>' }, // no ASIN
  });
  res = await sandbox.findDropyProductByAsin('B09BVYY7XR');
  eq(res && res.url, '/products/centrum-200', 'predictive #1 preferred over full-text top when ASIN not in product data');
  ok(res && res.matched === true && res.via === 'predictive', 'predictive fallback flagged matched');

  // No match anywhere -> top search result, flagged unmatched.
  install({
    dom: ['a', 'b'], products: [],
    js: { a: { handle: 'a', variants: [{ sku: 'X' }] }, b: { handle: 'b', variants: [{ sku: 'Y' }] } },
    html: { a: '<html>a</html>', b: '<html>b</html>' },
  });
  res = await sandbox.findDropyProductByAsin('B09BVYY7XR');
  eq(res && res.url, '/products/a', 'no ASIN match anywhere -> falls back to top search result');
  ok(res && res.matched === false, 'fallback flagged unmatched');

  // No candidates at all, no challenge -> none.
  install({ dom: [], products: [] });
  res = await sandbox.findDropyProductByAsin('B09BVYY7XR');
  ok(res && res.none === true, 'no candidates -> none');

  // Cloudflare: no candidates + challenge text -> blocked.
  install({ dom: [], products: [], suggestOk: false, title: 'Just a moment...', bodyText: 'Checking your browser before accessing' });
  res = await sandbox.findDropyProductByAsin('B09BVYY7XR');
  ok(res && res.blocked === true, 'no candidates + challenge text -> blocked');

  console.log('\n============ BACKGROUND RESULTS ============');
  if (fails.length) console.log(fails.join('\n') + '\n');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
