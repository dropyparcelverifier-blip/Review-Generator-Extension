// Proves the image sources run IN PARALLEL by driving the REAL prepareProduct()
// with a timing-instrumented sendMessage mock and measuring peak concurrency.
const fs = require('fs');
const vm = require('vm');

const SRC = require('path').join(__dirname, '..', 'app.js');
let code = fs.readFileSync(SRC, 'utf8');
code += `
globalThis.__p = {
  prepareProduct: (item, i) => prepareProduct(item, i),
  setSettings: (v) => { settings = Object.assign({}, settings, v); },
  setProcessing: (v) => { isProcessing = v; },
};
`;

// ---- instrumented chrome.runtime.sendMessage ----
let inFlight = 0, maxInFlight = 0;
const dispatched = [];
let includeAsin = true; // whether the dropy product data contains the ASIN
let googleItems = null;  // when set, google_images returns these exact items
function respond(msg) {
  const a = msg.action;
  if (a === 'dropy_lookup') return { name: 'Test Product', brand: 'BrandX', originalImages: ['https://cdn.shopify.com/x.jpg'], imageData: 'data:image/jpeg;base64,AAAA', barcode: '', productUrl: includeAsin ? 'https://dropy.in/products/bbr-B07RK4HST7-fork' : 'https://dropy.in/products/some-random-item' };
  if (a === 'lens_by_bytes' || a === 'lens_by_url') return { items: [{ full: 'https://f1', thumb: 't1', ctx: '', ugc: true }], text: 'lens' };
  if (a === 'google_images') return { items: googleItems || Array.from({ length: 20 }, (_, n) => ({ full: 'https://g' + n + msg.query, thumb: 't', ctx: '', ugc: false })) };
  if (a === 'amazon_review_images') return { images: ['https://media-amazon.com/images/I/a.jpg'], source: 'amazon.in' };
  if (a === 'bing_images') return { items: [{ full: 'https://bing1', thumb: 't', ctx: '', ugc: true }] };
  return {};
}
const chromeStub = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => {
      dispatched.push(msg.action);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight--; cb(respond(msg)); }, 30); // each scrape ~30ms
    },
    onMessage: { addListener() {} },
  },
  storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove() {} }, session: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove() {} } },
  downloads: { download() {} }, tabs: {}, action: { onClicked: { addListener() {} } }, sidePanel: { setPanelBehavior() {} },
};
function makeEl() { const fn = function () { return fn; }; return new Proxy(fn, { get(t, p) { if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } }; if (['value', 'textContent', 'innerHTML', 'innerText'].includes(p)) return ''; if (p === 'checked') return false; if (p === 'querySelectorAll') return () => []; if (p === 'querySelector') return () => null; if (typeof p === 'symbol') return () => ''; return makeEl(); }, set() { return true; }, apply() { return makeEl(); } }); }
const document = { getElementById: () => makeEl(), querySelector: () => null, querySelectorAll: () => [], createElement: () => makeEl(), body: makeEl(), addEventListener() {} };
const sandbox = {
  document, chrome: chromeStub, console, Math, Date, JSON, RegExp, Set, Map, Array, Object, String, Number, Boolean,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, atob, btoa, Buffer,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, alert: () => {}, confirm: () => true,
  XLSX: { read: () => ({}), utils: {} }, FileReader: function () {}, Image: function () {}, Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
const Pd = sandbox.__p;

let pass = 0, fail = 0; const fails = [];
function eq(a, e, m) { if (JSON.stringify(a) === JSON.stringify(e)) pass++; else { fail++; fails.push(`FAIL ${m}: exp ${JSON.stringify(e)} got ${JSON.stringify(a)}`); } }
function ok(c, m) { if (c) pass++; else { fail++; fails.push('FAIL ' + m); } }

(async () => {
  const item = { asin: 'B07RK4HST7', sku: 'Dropy-B07RK4HST7' };

  // 4 core sources ON -> peak concurrency 4 (Lens+Google+Pinterest+Amazon)
  Pd.setProcessing(true);
  Pd.setSettings({ srcLens: true, srcGoogle: true, srcPinterest: true, srcAmazon: true, srcBing: false, srcSocial: false });
  inFlight = 0; maxInFlight = 0; dispatched.length = 0;
  const data = await Pd.prepareProduct(item, 0);
  ok(data && Array.isArray(data.candidates), 'prepareProduct returns candidates');
  eq(maxInFlight, 4, 'all 4 core sources in-flight simultaneously (parallel)');
  ok(dispatched[0] === 'dropy_lookup', 'dropy_lookup runs first (sequential)');

  // Adding Bing as a 5th source -> peak concurrency 5.
  Pd.setProcessing(true);
  Pd.setSettings({ srcLens: true, srcGoogle: true, srcPinterest: true, srcAmazon: true, srcBing: true, srcSocial: false });
  inFlight = 0; maxInFlight = 0; dispatched.length = 0;
  await Pd.prepareProduct(item, 0);
  eq(maxInFlight, 5, 'Bing adds a 5th parallel source');
  ok(dispatched.includes('bing_images'), 'bing_images was dispatched');

  // Only 2 sources ON -> peak concurrency 2
  Pd.setProcessing(true);
  Pd.setSettings({ srcLens: true, srcGoogle: false, srcPinterest: false, srcAmazon: true, srcBing: false, srcSocial: false });
  inFlight = 0; maxInFlight = 0; dispatched.length = 0;
  await Pd.prepareProduct(item, 0);
  eq(maxInFlight, 2, 'only 2 enabled sources -> peak concurrency 2');

  // If it were SEQUENTIAL, maxInFlight would be 1. Prove it isn't:
  ok(maxInFlight > 1, 'sources are NOT sequential');

  // ---- ASIN-match verification ----
  Pd.setSettings({ srcLens: true, srcGoogle: true, srcPinterest: true, srcAmazon: true, srcBing: false, srcSocial: false, strictMatch: false });
  Pd.setProcessing(true); includeAsin = true;
  const okData = await Pd.prepareProduct(item, 0);
  ok(okData.productData && okData.productData.asinVerified === true, 'ASIN present in dropy data -> verified');

  Pd.setProcessing(true); includeAsin = false;
  const warnData = await Pd.prepareProduct(item, 0);
  ok(warnData.productData && warnData.productData.asinVerified === false, 'ASIN absent -> unverified');
  ok(!warnData.skip, 'warn mode (default) does NOT skip unverified');

  Pd.setSettings({ strictMatch: true });
  Pd.setProcessing(true); includeAsin = false;
  const skipData = await Pd.prepareProduct(item, 0);
  ok(skipData && skipData.skip === true, 'strictMatch ON -> unverified product is skipped');

  // ---- image relevance: whole-word context match keeps right, drops wrong ----
  // product brand 'BrandX' -> token 'brandx'. An image whose context names the
  // brand as a WHOLE WORD is kept; one whose context names a different product
  // (no token as a whole word) is dropped — even if a token appears as a substring.
  Pd.setSettings({ strictMatch: false, srcLens: false, srcPinterest: false, srcAmazon: false, srcGoogle: true });
  Pd.setProcessing(true); includeAsin = true;
  googleItems = [
    { full: 'https://match', thumb: 't', ctx: 'brandx official review', ugc: false },
    { full: 'https://wrong', thumb: 't', ctx: 'cerave lotion moisturizer', ugc: false },
    { full: 'https://substr', thumb: 't', ctx: 'embeddedbrandxinside hash', ugc: false }, // substring, not whole word
  ];
  const relData = await Pd.prepareProduct(item, 0);
  const urls = (relData.candidates || []).map((c) => c.url);
  ok(urls.includes('https://match'), 'context-matched image kept');
  ok(!urls.includes('https://wrong'), 'wrong-product image (mismatched context) dropped');
  ok(!urls.includes('https://substr'), 'substring-only token match dropped (whole-word required)');
  googleItems = null;

  console.log('\n============ PARALLEL RESULTS ============');
  if (fails.length) console.log(fails.join('\n') + '\n');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
