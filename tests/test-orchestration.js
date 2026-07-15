// Orchestration test: drives the REAL startProcessing() two-phase pipeline with
// mocked prepareProduct/generateProduct/pickImages/sleep and a stateful storage
// mock, to verify prefetch alignment, skips, resume/same-file, and stop.
const fs = require('fs');
const vm = require('vm');

const SRC = require('path').join(__dirname, '..', 'app.js');
let code = fs.readFileSync(SRC, 'utf8');

// Append an in-scope driver so it can read/write the module-level `let` vars.
code += `
globalThis.__t = {
  startProcessing,
  setProducts: (v) => { products = v; },
  setSettings: (v) => { settings = Object.assign({}, settings, v); },
  setFileBase: (v) => { uploadedFileBase = v; },
  resetState: () => { csvBatch = null; geminiTabId = null; isProcessing = false; isPaused = false; loadProgress(); },
  csvBatch: () => csvBatch,
  isProcessing: () => isProcessing,
  install: (spec) => {
    globalThis.__prepareCalls = [];
    globalThis.__pickCount = 0;
    globalThis.__genCount = 0;
    globalThis.__seq = []; // order of scrape ('prep') vs pick ('pick') events
    prepareProduct = async (item, idx) => {
      globalThis.__prepareCalls.push(item.asin);
      globalThis.__seq.push('prep');
      const s = (spec.prep && spec.prep[item.asin]) || {};
      if (s.skip) return { skip: true, error: s.error || 'not found on dropy.in' };
      return { productData: { name: 'P-' + item.asin, brand: '', lensText: '' }, candidates: s.candidates || [{url:'u',thumb:'t'}], refImg: '', refFull: '' };
    };
    generateProduct = async (job) => {
      globalThis.__genCount++;
      if (spec.stopAfterGen && globalThis.__genCount >= spec.stopAfterGen) isProcessing = false;
      // Mirror the real image-mode behavior: an empty photo selection generates
      // nothing (0 reviews) and returns the "skipped" marker.
      if (job.mode === 'image' && (job.selected || []).length === 0) {
        return { asin: job.item.asin, sku: job.item.sku, name: job.productData.name, reviews: 0, images: 0, error: 'no images picked (skipped)' };
      }
      const s = (spec.gen && spec.gen[job.item.asin]) || { reviews: 1 };
      const n = spec.genAllZero ? 0 : (s.reviews == null ? 1 : s.reviews); // genAllZero simulates Gemini logged out
      const imgs = (spec.imagesFor && spec.imagesFor[job.item.asin]) || 0;
      if (n > 0) {
        const arr = [];
        for (let x = 0; x < n; x++) arr.push('r:' + job.item.asin + ':' + x);
        setCsvProduct(job.item.asin, arr, imgs); // per-ASIN replace (was rows.push)
      }
      return { asin: job.item.asin, sku: job.item.sku, name: job.productData.name, reviews: n, images: imgs, error: n ? null : 'no reviews' };
    };
    pickImages = async (cands) => {
      globalThis.__pickCount++;
      globalThis.__seq.push('pick');
      if (spec.stopAfterPick && globalThis.__pickCount >= spec.stopAfterPick) isProcessing = false;
      if (spec.pickEmpty) return []; // simulate the user picking NO photos
      return (cands || []).slice(0, 1);
    };
    sleep = async () => {};
    waitWhilePaused = async () => {};
  },
  snap: () => ({
    prepareCalls: globalThis.__prepareCalls.slice(),
    rows: csvBatch ? csvAllRows() : null,
    fileName: csvBatch ? csvFileName() : null,
    asins: csvBatch ? csvBatch.asins : null,
    pickCount: globalThis.__pickCount,
    seq: globalThis.__seq ? globalThis.__seq.slice() : [],
  }),
};
`;

// ---- stateful storage + capture ----
const localStore = {};
const saved = []; // captured save_file downloads
function makeEl() {
  const fn = function () { return fn; };
  return new Proxy(fn, { get(t, p) { if (p === 'classList') return { add(){},remove(){},toggle(){},contains(){return false;} }; if (p==='style') return {}; if (p==='dataset') return {}; if (['value','textContent','innerHTML','innerText'].includes(p)) return ''; if (p==='checked') return false; if (p==='querySelectorAll') return ()=>[]; if (p==='querySelector') return ()=>null; if (typeof p==='symbol') return ()=> ''; return makeEl(); }, set(){return true;}, apply(){return makeEl();} });
}
const document = { getElementById: (id) => (id === 'forceRegen' ? { checked: !!globalThis.__forceRegen } : makeEl()), querySelector: () => null, querySelectorAll: () => [], createElement: () => makeEl(), body: makeEl(), addEventListener(){} };
const chromeStub = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => { if (msg && msg.action === 'save_file') saved.push({ filename: msg.filename, conflictAction: msg.conflictAction }); if (cb) cb(msg && msg.action === 'save_file' ? { ok: true, downloadId: saved.length } : { ok: true }); },
    onMessage: { addListener(){} },
  },
  storage: {
    local: {
      get: (keys, cb) => { const out = {}; (Array.isArray(keys)?keys:[keys]).forEach(k => { if (k in localStore) out[k] = localStore[k]; }); cb && cb(out); },
      set: (obj, cb) => { Object.assign(localStore, JSON.parse(JSON.stringify(obj))); cb && cb(); },
      remove: (k, cb) => { delete localStore[k]; cb && cb(); },
    },
    session: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: () => {} },
  },
  downloads: { download: () => {} }, tabs: {}, action: { onClicked: { addListener(){} } }, sidePanel: { setPanelBehavior(){} },
};
const sandbox = {
  document, chrome: chromeStub, console, Math, Date, JSON, RegExp, Set, Map, Array, Object, String, Number, Boolean,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, atob, btoa, Buffer,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, alert: () => {}, confirm: () => true,
  XLSX: { read: () => ({}), utils: {} }, FileReader: function(){}, Image: function(){}, Blob: function(){}, URL: { createObjectURL: () => '', revokeObjectURL(){} },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
const T = sandbox.__t;

// ---- test framework ----
let pass = 0, fail = 0; const fails = [];
function eq(a, e, m) { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; fails.push(`FAIL ${m}\n  exp ${E}\n  got ${A}`); } }
function ok(c, m) { if (c) pass++; else { fail++; fails.push('FAIL ' + m); } }
function resetStore() { for (const k in localStore) delete localStore[k]; saved.length = 0; T.resetState(); }
const P = (...a) => a.map(x => ({ asin: x, sku: 'Dropy-' + x }));

async function run() {
  // ============================================================
  // IMAGE MODE (S1-S11) — drives the interactive pick pipeline. Progress lives
  // under doneAsinsImage / csvBatchImage; the file gets a "_images" suffix.
  // ============================================================
  // S1 happy path
  resetStore(); T.setSettings({ min: 5, max: 5, batch: 10 });
  T.setProducts(P('A', 'B', 'C'));
  T.install({});
  await T.startProcessing('image');
  let s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C'], 'S1 prepare called once each, in order');
  eq(s.rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'S1 rows one per product');
  eq(localStore.doneAsinsImage.sort(), ['A', 'B', 'C'], 'S1 all marked done (image key)');
  ok(!localStore.doneAsins, 'S1 image run does NOT touch the text done-key');
  ok(saved.length >= 1 && saved[saved.length - 1].conflictAction === 'overwrite', 'S1 file saved with overwrite');
  ok(/^reviews_images_/.test(s.fileName), 'S1 stable _images filename');

  // S2 middle product not found (skip) — prefetch stays aligned
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ prep: { B: { skip: true } } });
  await T.startProcessing('image');
  s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C'], 'S2 prepare still called for all incl skipped');
  eq(s.rows, ['r:A:0', 'r:C:0'], 'S2 only A and C generated');
  eq(localStore.doneAsinsImage.sort(), ['A', 'C'], 'S2 skipped B not marked done');

  // S3 resume: A already done, csvBatchImage persisted with prior rows + asins
  resetStore();
  localStore.doneAsinsImage = ['A'];
  localStore.csvBatchImage = { fileName: 'reviews_images_prev.csv', rows: ['old:1'], asins: ['A', 'B', 'C'] };
  T.resetState(); // reload done sets from the seeded storage (simulates panel reload)
  T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing('image');
  s = T.snap();
  eq(s.prepareCalls, ['B', 'C'], 'S3 A skipped (already done), only B,C prepared');
  eq(s.fileName, 'reviews_images_prev.csv', 'S3 reuses same file on resume');
  eq(s.rows, ['old:1', 'r:B:0', 'r:C:0'], 'S3 appends to carried rows');
  eq(localStore.doneAsinsImage.sort(), ['A', 'B', 'C'], 'S3 B,C added to done');

  // S4 stop DURING selection (after 2 picks) -> no generation, nothing lost-marked
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterPick: 2 });
  await T.startProcessing('image');
  s = T.snap();
  eq(s.rows, [], 'S4 stop-in-selection: nothing generated');
  ok(!localStore.doneAsinsImage || localStore.doneAsinsImage.length === 0, 'S4 nothing marked done');
  ok(localStore.csvBatchImage.pending && localStore.csvBatchImage.pending.A, 'S4 completed pick (A) saved');
  ok(!localStore.csvBatchImage.pending.B, 'S4 Stop-interrupted pick (B) NOT saved -> re-pick on resume');

  // S5 stop DURING generation (after 1) -> that one saved+done, rest not
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterGen: 1 });
  await T.startProcessing('image');
  s = T.snap();
  eq(s.rows, ['r:A:0'], 'S5 stop-in-gen: first product saved');
  eq(localStore.doneAsinsImage, ['A'], 'S5 only first marked done');
  ok(saved.length >= 1, 'S5 file written with partial');

  // S6 new list (no overlap) after a persisted batch -> fresh file
  resetStore();
  localStore.csvBatchImage = { fileName: 'reviews_images_old.csv', rows: ['x'], asins: ['A', 'B', 'C'] };
  T.resetState();
  T.setProducts(P('D', 'E')); T.install({});
  await T.startProcessing('image');
  s = T.snap();
  ok(s.fileName !== 'reviews_images_old.csv', 'S6 new list -> fresh file, not old');
  eq(s.rows, ['r:D:0', 'r:E:0'], 'S6 fresh rows (no carry from unrelated batch)');

  // S7 two consecutive skips keep prefetch aligned
  resetStore(); T.setProducts(P('A', 'B', 'C', 'D')); T.install({ prep: { B: { skip: true }, C: { skip: true } } });
  await T.startProcessing('image');
  s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C', 'D'], 'S7 all prepared once despite 2 skips');
  eq(s.rows, ['r:A:0', 'r:D:0'], 'S7 only A and D generated');

  // S8 product that yields 0 reviews -> not marked done, counted as issue
  resetStore(); T.setProducts(P('A', 'B')); T.install({ gen: { B: { reviews: 0 } } });
  await T.startProcessing('image');
  s = T.snap();
  eq(s.rows, ['r:A:0'], 'S8 zero-review product adds no rows');
  eq(localStore.doneAsinsImage, ['A'], 'S8 zero-review product not marked done');

  // S9 pick-persistence: stop after generating A (B,C picked+saved), then resume
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterGen: 1 });
  await T.startProcessing('image');
  ok((localStore.csvBatchImage.pending && localStore.csvBatchImage.pending.B && localStore.csvBatchImage.pending.C), 'S9 B,C selections persisted after stop');
  ok(!localStore.csvBatchImage.pending.A, 'S9 generated A cleared from pending');
  // resume with a fresh panel state + fresh mocks (prepareCalls reset)
  T.resetState(); T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing('image');
  s = T.snap();
  eq(s.prepareCalls, [], 'S9 resume re-scrapes NOTHING (A done, B,C restored)');
  eq(s.rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'S9 resume generates restored B,C onto same file');
  eq(localStore.doneAsinsImage.sort(), ['A', 'B', 'C'], 'S9 all done after resume');
  ok(!localStore.csvBatchImage.pending || Object.keys(localStore.csvBatchImage.pending).length === 0, 'S9 pending fully drained');

  // S10 rerun of an ALL-already-done batch must NOT re-download the file
  resetStore(); T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing('image');
  ok(saved.length >= 1, 'S10 first run writes the file');
  ok(localStore.csvBatchImage.written === true, 'S10 batch flagged written after first run');
  // rerun: fresh panel, same products (both already done), same persisted batch
  T.resetState(); saved.length = 0; T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing('image');
  s = T.snap();
  eq(s.prepareCalls, [], 'S10 rerun processes nothing (all done)');
  eq(saved.length, 0, 'S10 rerun of all-done batch does NOT re-download the file');

  // S11 output CSV is named after the uploaded file (cerave.txt -> cerave_images.csv)
  resetStore(); T.setFileBase('cerave'); T.setProducts(P('A')); T.install({});
  await T.startProcessing('image');
  eq(T.snap().fileName, 'cerave_images.csv', 'S11 fresh batch named after uploaded file');
  ok(saved.length && saved[saved.length - 1].filename === 'cerave_images.csv', 'S11 downloaded as cerave_images.csv');
  // resume the same batch but with a different upload name -> follows the new name
  T.resetState(); T.setFileBase('newname'); T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing('image');
  eq(T.snap().fileName, 'newname_images.csv', 'S11 resume follows the current uploaded file name');
  T.setFileBase(''); // reset for any later scenarios

  // S12 image mode, user picks NO photos for a product -> handled once, not looped
  resetStore(); T.setProducts(P('A')); T.install({ pickEmpty: true });
  await T.startProcessing('image');
  s = T.snap();
  eq(s.rows, [], 'S12 empty-pick product generates nothing');
  eq(localStore.doneAsinsImage, ['A'], 'S12 intentional no-photo pick marked done (no infinite re-run)');
  ok(!localStore.csvBatchImage.pending || !localStore.csvBatchImage.pending.A, 'S12 empty-pick pending cleared');

  // ============================================================
  // TEXT MODE (T1-T4) — fully automatic, NO image picking. Progress lives under
  // doneAsins / csvBatch; the file has NO "_images" suffix.
  // ============================================================
  // T1 happy path: generates every product, never opens the picker
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing('text');
  s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C'], 'T1 every product looked up, in order');
  eq(s.pickCount, 0, 'T1 text mode NEVER opens the image picker');
  eq(s.rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'T1 rows one per product');
  ok(saved.length >= 1 && saved.length <= 3, 'T1 CSV written to disk, throttled (not one per product)');
  eq(localStore.doneAsins.sort(), ['A', 'B', 'C'], 'T1 all marked done (text key)');
  ok(!localStore.doneAsinsImage, 'T1 text run does NOT touch the image done-key');
  ok(/^reviews_/.test(s.fileName) && !/_images/.test(s.fileName), 'T1 plain (non-image) filename');

  // T2 skip a not-found product
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ prep: { B: { skip: true } } });
  await T.startProcessing('text');
  s = T.snap();
  eq(s.rows, ['r:A:0', 'r:C:0'], 'T2 only A and C generated');
  eq(localStore.doneAsins.sort(), ['A', 'C'], 'T2 skipped B not marked done');

  // T3 resume: A already text-done, csvBatch carried
  resetStore();
  localStore.doneAsins = ['A'];
  localStore.csvBatch = { fileName: 'cerave.csv', rows: ['old:1'], asins: ['A', 'B', 'C'] };
  T.resetState();
  T.setFileBase('cerave'); T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing('text');
  s = T.snap();
  eq(s.prepareCalls, ['B', 'C'], 'T3 A skipped, only B,C looked up');
  eq(s.fileName, 'cerave.csv', 'T3 reuses same text file on resume');
  eq(s.rows, ['old:1', 'r:B:0', 'r:C:0'], 'T3 appends to carried rows');
  T.setFileBase('');

  // T4 stop DURING generation (after 1) -> first saved+done, rest not
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterGen: 1 });
  await T.startProcessing('text');
  s = T.snap();
  eq(s.rows, ['r:A:0'], 'T4 stop-in-gen: first product saved');
  eq(localStore.doneAsins, ['A'], 'T4 only first marked done');

  // T5 disk-write throttle: a big run must NOT write once per product
  resetStore(); T.setProducts(P('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'));
  T.install({});
  await T.startProcessing('text');
  s = T.snap();
  eq(s.rows.length, 12, 'T5 all 12 products generated');
  ok(saved.length >= 2 && saved.length <= 6, 'T5 12-product run throttles disk writes to a handful (flush @1,6,11 + run-end), not 12');
  eq(localStore.doneAsins.length, 12, 'T5 all 12 marked done');

  // T6 circuit-breaker: Gemini logged out (every product yields 0 reviews) -> stop
  // after GEN_FAIL_LIMIT (3) products instead of grinding through the whole list.
  resetStore(); T.setProducts(P('A', 'B', 'C', 'D', 'E', 'F')); T.install({ genAllZero: true });
  await T.startProcessing('text');
  s = T.snap();
  eq(s.rows, [], 'T6 nothing generated (simulated Gemini logout)');
  eq(s.prepareCalls, ['A', 'B', 'C'], 'T6 stops after 3 systemic failures, not all 6');
  ok(!localStore.doneAsins || localStore.doneAsins.length === 0, 'T6 nothing marked done');

  // F1 rerun a FAILED asin merges into the file (the reported data-loss bug):
  // A,B done + C failed, then rerun only C -> A,B must be preserved, C added.
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ gen: { C: { reviews: 0 } } });
  await T.startProcessing('text');
  eq(T.snap().rows, ['r:A:0', 'r:B:0'], 'F1 A,B done, C failed');
  T.resetState(); T.setProducts(P('C')); T.install({});
  await T.startProcessing('text');
  eq(T.snap().rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'F1 rerun C MERGES (A,B not clobbered)');

  // F2 force-regenerate a finished asin REPLACES its rows (no dup), keeps the others.
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing('text');
  eq(T.snap().rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'F2 initial 3 products done');
  T.resetState(); T.setProducts(P('B')); T.install({ gen: { B: { reviews: 2 } } });
  globalThis.__forceRegen = true;
  await T.startProcessing('text');
  globalThis.__forceRegen = false;
  eq(T.snap().rows, ['r:A:0', 'r:B:0', 'r:B:1', 'r:C:0'], 'F2 B regenerated (replaced with 2 rows), A&C preserved');

  // F6 image mode scrapes ALL products BEFORE any picking (scrape-all → pick-all)
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing('image');
  const seq = T.snap().seq;
  const lastPrep = seq.lastIndexOf('prep');
  const firstPick = seq.indexOf('pick');
  ok(firstPick > -1 && lastPrep > -1 && lastPrep < firstPick, 'F6 all scraping happens before any picking');
  eq(seq.filter((x) => x === 'prep').length, 3, 'F6 all 3 scraped');
  eq(seq.filter((x) => x === 'pick').length, 3, 'F6 all 3 picked');

  // F3 total image count is stamped into the image filename
  resetStore(); T.setFileBase('cerave'); T.setProducts(P('A', 'B')); T.install({ imagesFor: { A: 3, B: 2 } });
  await T.startProcessing('image');
  eq(T.snap().fileName, 'cerave_images_5photos.csv', 'F3 total image count (5) in the filename');
  T.setFileBase('');

  // F4 regenerating an ASIN whose rows were migrated into __prior doesn't duplicate.
  resetStore();
  localStore.doneAsins = ['C', 'X'];
  localStore.csvBatch = { fileName: 'legacy.csv', rows: ['r:C:0', 'old:X'], asins: ['C', 'X'] };
  T.resetState();
  T.setFileBase('legacy'); T.setProducts(P('C')); T.install({});
  globalThis.__forceRegen = true;
  await T.startProcessing('text');
  globalThis.__forceRegen = false;
  eq(T.snap().rows, ['old:X', 'r:C:0'], 'F4 regenerated C not duplicated (legacy __prior row purged)');
  T.setFileBase('');

  // F5 a DIFFERENT list that merely SHARES one ASIN must start its OWN fresh batch —
  // never merge the other list's product in or clobber its file (the MEDIUM bug).
  resetStore(); T.setFileBase('lista'); T.setProducts(P('X', 'Y')); T.install({});
  await T.startProcessing('text');
  eq(T.snap().rows, ['r:X:0', 'r:Y:0'], 'F5 list A = X,Y');
  T.resetState(); T.setFileBase('listb'); T.setProducts(P('Y', 'Z')); T.install({});
  await T.startProcessing('text');
  const s5 = T.snap();
  eq(s5.fileName, 'listb.csv', 'F5 list B writes its OWN file');
  eq(s5.rows, ['r:Z:0'], 'F5 list B is fresh — list A\'s X did NOT leak in');
  T.setFileBase('');

  // ============================================================
  // CROSS-MODE ISOLATION (X1) — a text run and an image run over the SAME list
  // are independent: neither skips the other's ASINs, each writes its own file.
  // ============================================================
  resetStore(); T.setFileBase('cerave'); T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing('text');
  eq(localStore.doneAsins.sort(), ['A', 'B'], 'X1 text run marks the text done-key');
  ok(!localStore.doneAsinsImage, 'X1 text run leaves the image done-key empty');
  eq(T.snap().fileName, 'cerave.csv', 'X1 text file is cerave.csv');
  // now the IMAGE run on the same list — must process A,B (not skip them) + own file
  T.resetState(); T.setFileBase('cerave'); T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing('image');
  s = T.snap();
  eq(s.prepareCalls, ['A', 'B'], 'X1 image run does NOT skip the text-done products');
  eq(localStore.doneAsinsImage.sort(), ['A', 'B'], 'X1 image run marks the image done-key');
  eq(s.fileName, 'cerave_images.csv', 'X1 image file is the separate cerave_images.csv');
  ok(localStore.csvBatch && localStore.csvBatchImage, 'X1 both batches coexist in storage');
  T.setFileBase('');

  // report
  console.log('\n============ ORCHESTRATION RESULTS ============');
  if (fails.length) console.log(fails.join('\n') + '\n');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('RUN ERROR', e.stack); process.exit(2); });
