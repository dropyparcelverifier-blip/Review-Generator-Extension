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
    prepareProduct = async (item, idx) => {
      globalThis.__prepareCalls.push(item.asin);
      const s = (spec.prep && spec.prep[item.asin]) || {};
      if (s.skip) return { skip: true, error: s.error || 'not found on dropy.in' };
      return { productData: { name: 'P-' + item.asin, brand: '', lensText: '' }, candidates: s.candidates || [{url:'u',thumb:'t'}], refImg: '', refFull: '' };
    };
    generateProduct = async (job) => {
      const s = (spec.gen && spec.gen[job.item.asin]) || { reviews: 1 };
      const n = s.reviews == null ? 1 : s.reviews;
      for (let x = 0; x < n; x++) csvBatch.rows.push('r:' + job.item.asin + ':' + x);
      globalThis.__genCount++;
      if (spec.stopAfterGen && globalThis.__genCount >= spec.stopAfterGen) isProcessing = false;
      return { asin: job.item.asin, sku: job.item.sku, name: job.productData.name, reviews: n, images: 0, error: n ? null : 'no reviews' };
    };
    pickImages = async (cands) => {
      globalThis.__pickCount++;
      if (spec.stopAfterPick && globalThis.__pickCount >= spec.stopAfterPick) isProcessing = false;
      return (cands || []).slice(0, 1);
    };
    sleep = async () => {};
    waitWhilePaused = async () => {};
  },
  snap: () => ({
    prepareCalls: globalThis.__prepareCalls.slice(),
    rows: csvBatch ? csvBatch.rows.slice() : null,
    fileName: csvBatch ? csvBatch.fileName : null,
    asins: csvBatch ? csvBatch.asins : null,
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
const document = { getElementById: () => makeEl(), querySelector: () => null, querySelectorAll: () => [], createElement: () => makeEl(), body: makeEl(), addEventListener(){} };
const chromeStub = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => { if (msg && msg.action === 'save_file') saved.push({ filename: msg.filename, conflictAction: msg.conflictAction }); if (cb) cb({ ok: true }); },
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
  // S1 happy path
  resetStore(); T.setSettings({ min: 5, max: 5, batch: 10 });
  T.setProducts(P('A', 'B', 'C'));
  T.install({});
  await T.startProcessing();
  let s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C'], 'S1 prepare called once each, in order');
  eq(s.rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'S1 rows one per product');
  eq(localStore.doneAsins.sort(), ['A', 'B', 'C'], 'S1 all marked done');
  ok(saved.length >= 1 && saved[saved.length - 1].conflictAction === 'overwrite', 'S1 file saved with overwrite');
  ok(/^reviews_/.test(s.fileName), 'S1 stable filename');

  // S2 middle product not found (skip) — prefetch stays aligned
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ prep: { B: { skip: true } } });
  await T.startProcessing();
  s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C'], 'S2 prepare still called for all incl skipped');
  eq(s.rows, ['r:A:0', 'r:C:0'], 'S2 only A and C generated');
  eq(localStore.doneAsins.sort(), ['A', 'C'], 'S2 skipped B not marked done');

  // S3 resume: A already done, csvBatch persisted with prior rows + asins
  resetStore();
  localStore.doneAsins = ['A'];
  localStore.csvBatch = { fileName: 'reviews_prev.csv', rows: ['old:1'], asins: ['A', 'B', 'C'] };
  T.resetState(); // reload doneAsins from the seeded storage (simulates panel reload)
  T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing();
  s = T.snap();
  eq(s.prepareCalls, ['B', 'C'], 'S3 A skipped (already done), only B,C prepared');
  eq(s.fileName, 'reviews_prev.csv', 'S3 reuses same file on resume');
  eq(s.rows, ['old:1', 'r:B:0', 'r:C:0'], 'S3 appends to carried rows');
  eq(localStore.doneAsins.sort(), ['A', 'B', 'C'], 'S3 B,C added to done');

  // S4 stop DURING selection (after 2 picks) -> no generation, nothing lost-marked
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterPick: 2 });
  await T.startProcessing();
  s = T.snap();
  eq(s.rows, [], 'S4 stop-in-selection: nothing generated');
  ok(!localStore.doneAsins || localStore.doneAsins.length === 0, 'S4 nothing marked done');

  // S5 stop DURING generation (after 1) -> that one saved+done, rest not
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterGen: 1 });
  await T.startProcessing();
  s = T.snap();
  eq(s.rows, ['r:A:0'], 'S5 stop-in-gen: first product saved');
  eq(localStore.doneAsins, ['A'], 'S5 only first marked done');
  ok(saved.length >= 1, 'S5 file written with partial');

  // S6 new list (no overlap) after a persisted batch -> fresh file
  resetStore();
  localStore.csvBatch = { fileName: 'reviews_old.csv', rows: ['x'], asins: ['A', 'B', 'C'] };
  T.resetState();
  T.setProducts(P('D', 'E')); T.install({});
  await T.startProcessing();
  s = T.snap();
  ok(s.fileName !== 'reviews_old.csv', 'S6 new list -> fresh file, not old');
  eq(s.rows, ['r:D:0', 'r:E:0'], 'S6 fresh rows (no carry from unrelated batch)');

  // S7 two consecutive skips keep prefetch aligned
  resetStore(); T.setProducts(P('A', 'B', 'C', 'D')); T.install({ prep: { B: { skip: true }, C: { skip: true } } });
  await T.startProcessing();
  s = T.snap();
  eq(s.prepareCalls, ['A', 'B', 'C', 'D'], 'S7 all prepared once despite 2 skips');
  eq(s.rows, ['r:A:0', 'r:D:0'], 'S7 only A and D generated');

  // S8 product that yields 0 reviews -> not marked done, counted as issue
  resetStore(); T.setProducts(P('A', 'B')); T.install({ gen: { B: { reviews: 0 } } });
  await T.startProcessing();
  s = T.snap();
  eq(s.rows, ['r:A:0'], 'S8 zero-review product adds no rows');
  eq(localStore.doneAsins, ['A'], 'S8 zero-review product not marked done');

  // S9 pick-persistence: stop after generating A (B,C picked+saved), then resume
  resetStore(); T.setProducts(P('A', 'B', 'C')); T.install({ stopAfterGen: 1 });
  await T.startProcessing();
  ok((localStore.csvBatch.pending && localStore.csvBatch.pending.B && localStore.csvBatch.pending.C), 'S9 B,C selections persisted after stop');
  ok(!localStore.csvBatch.pending.A, 'S9 generated A cleared from pending');
  // resume with a fresh panel state + fresh mocks (prepareCalls reset)
  T.resetState(); T.setProducts(P('A', 'B', 'C')); T.install({});
  await T.startProcessing();
  s = T.snap();
  eq(s.prepareCalls, [], 'S9 resume re-scrapes NOTHING (A done, B,C restored)');
  eq(s.rows, ['r:A:0', 'r:B:0', 'r:C:0'], 'S9 resume generates restored B,C onto same file');
  eq(localStore.doneAsins.sort(), ['A', 'B', 'C'], 'S9 all done after resume');
  ok(!localStore.csvBatch.pending || Object.keys(localStore.csvBatch.pending).length === 0, 'S9 pending fully drained');

  // S10 rerun of an ALL-already-done batch must NOT re-download the file
  resetStore(); T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing();
  ok(saved.length >= 1, 'S10 first run writes the file');
  ok(localStore.csvBatch.written === true, 'S10 batch flagged written after first run');
  // rerun: fresh panel, same products (both already done), same persisted batch
  T.resetState(); saved.length = 0; T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing();
  s = T.snap();
  eq(s.prepareCalls, [], 'S10 rerun processes nothing (all done)');
  eq(saved.length, 0, 'S10 rerun of all-done batch does NOT re-download the file');

  // S11 output CSV is named after the uploaded file (cerave.txt -> cerave.csv)
  resetStore(); T.setFileBase('cerave'); T.setProducts(P('A')); T.install({});
  await T.startProcessing();
  eq(T.snap().fileName, 'cerave.csv', 'S11 fresh batch named after uploaded file');
  ok(saved.length && saved[saved.length - 1].filename === 'cerave.csv', 'S11 downloaded as cerave.csv');
  // resume the same batch but with a different upload name -> follows the new name
  T.resetState(); T.setFileBase('newname'); T.setProducts(P('A', 'B')); T.install({});
  await T.startProcessing();
  eq(T.snap().fileName, 'newname.csv', 'S11 resume follows the current uploaded file name');
  T.setFileBase(''); // reset for any later scenarios

  // report
  console.log('\n============ ORCHESTRATION RESULTS ============');
  if (fails.length) console.log(fails.join('\n') + '\n');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error('RUN ERROR', e.stack); process.exit(2); });
