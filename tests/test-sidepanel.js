// Full unit-test harness for the PURE logic in sidepanel.js.
// Loads the REAL file in a stubbed sandbox (no drift), then exercises the
// function-declaration globals across edge cases.
const fs = require('fs');
const vm = require('vm');

const SRC = require('path').join(__dirname, '..', 'app.js');
let code = fs.readFileSync(SRC, 'utf8');

// ---- Minimal DOM/chrome stubs so top-level code + initDashboard() don't throw ----
function makeEl() {
  const fn = function () { return fn; };
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'style') return {};
      if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (p === 'dataset') return {};
      if (p === 'value') return '';
      if (p === 'checked') return false;
      if (['textContent', 'innerHTML', 'innerText'].includes(p)) return '';
      if (p === 'querySelectorAll') return () => [];
      if (p === 'querySelector') return () => null;
      if (typeof p === 'symbol') return () => '';
      return makeEl();
    },
    set() { return true; },
    apply() { return makeEl(); }
  });
}
const document = {
  getElementById: () => makeEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  body: makeEl(),
  addEventListener: () => {},
};
const chromeStub = {
  runtime: { sendMessage: () => {}, lastError: null, onMessage: { addListener() {} } },
  storage: {
    local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: () => {} },
    session: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb(), remove: () => {} },
  },
  downloads: { download: () => {} },
  tabs: {}, action: { onClicked: { addListener() {} } }, sidePanel: { setPanelBehavior() {} },
};

const sandbox = {
  document, chrome: chromeStub, window: {}, console,
  Math, Date, JSON, RegExp, Set, Map, Array, Object, String, Number, Boolean,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  atob, btoa, Buffer, setTimeout, clearTimeout, alert: () => {}, confirm: () => true,
  XLSX: { read: () => ({}), utils: {} }, FileReader: function () {}, Image: function () {},
  Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'app.js' });
} catch (e) {
  console.error('LOAD FAILED:', e.stack);
  process.exit(1);
}

// ---- tiny test framework ----
let pass = 0, fail = 0; const fails = [];
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; fails.push(`FAIL: ${msg}\n   expected ${e}\n   got      ${a}`); }
}
function ok(cond, msg) { if (cond) pass++; else { fail++; fails.push(`FAIL: ${msg}`); } }
const G = sandbox; // function declarations live on the context global

// ===================== extractAsin =====================
eq(G.extractAsin('B071HN7KK6'), 'B071HN7KK6', 'bare ASIN');
eq(G.extractAsin('b071hn7kk6'), 'B071HN7KK6', 'lowercase ASIN -> upper');
eq(G.extractAsin('Dropy-B071HN7KK6'), 'B071HN7KK6', 'Dropy- prefix');
eq(G.extractAsin('https://www.amazon.in/dp/B071HN7KK6'), 'B071HN7KK6', '/dp/ URL');
eq(G.extractAsin('https://www.amazon.com/gp/product/B08XYZ1234/ref=x'), 'B08XYZ1234', '/gp/product/ URL');
eq(G.extractAsin('  B071HN7KK6  '), 'B071HN7KK6', 'trims');
eq(G.extractAsin('1234567890'), '1234567890', '10-digit ISBN-style');
eq(G.extractAsin('123456789X'), '123456789X', 'ISBN with X');
eq(G.extractAsin('garbage'), null, 'no asin -> null');
eq(G.extractAsin(''), null, 'empty -> null');
eq(G.extractAsin(null), null, 'null -> null');
eq(G.extractAsin('note B071HN7KK6 here'), 'B071HN7KK6', 'asin in text');

// ===================== buildProducts =====================
eq(G.buildProducts(['B071HN7KK6', 'B071HN7KK6', 'B08XYZ1234']),
   [{ asin: 'B071HN7KK6', sku: 'Dropy-B071HN7KK6' }, { asin: 'B08XYZ1234', sku: 'Dropy-B08XYZ1234' }],
   'buildProducts dedups + sku');
eq(G.buildProducts([]), [], 'buildProducts empty');
eq(G.buildProducts([null, 'B071HN7KK6', undefined]), [{ asin: 'B071HN7KK6', sku: 'Dropy-B071HN7KK6' }], 'buildProducts skips falsy');

// ===================== csvBaseFromFile =====================
eq(G.csvBaseFromFile('Skincare.txt'), 'Skincare', 'csvBase strips .txt');
eq(G.csvBaseFromFile('My Brand.xlsx'), 'My Brand', 'csvBase strips .xlsx, keeps spaces');
eq(G.csvBaseFromFile('a/b:c*d.csv'), 'a_b_c_d', 'csvBase replaces illegal filename chars');
eq(G.csvBaseFromFile('noext'), 'noext', 'csvBase no extension');
eq(G.csvBaseFromFile(''), '', 'csvBase empty');

// ===================== csvField =====================
eq(G.csvField('plain'), 'plain', 'csvField plain');
eq(G.csvField('a,b'), '"a,b"', 'csvField comma quoted');
eq(G.csvField('he said "hi"'), '"he said ""hi"""', 'csvField doubles quotes');
eq(G.csvField('line1\nline2'), '"line1\nline2"', 'csvField newline quoted');
eq(G.csvField(5), '5', 'csvField number');
eq(G.csvField(null), '', 'csvField null');
eq(G.csvField(undefined), '', 'csvField undefined');

// ===================== formatReviewDate =====================
eq(G.formatReviewDate('2025-03-14'), '2025-03-14 00:00:00 UTC', 'date valid');
eq(G.formatReviewDate('2025-03-14T10:00:00'), '2025-03-14 00:00:00 UTC', 'date w/ time');
ok(/^\d{4}-\d{2}-\d{2} 00:00:00 UTC$/.test(G.formatReviewDate('')), 'date empty -> fallback format');
ok(/^\d{4}-\d{2}-\d{2} 00:00:00 UTC$/.test(G.formatReviewDate('bad')), 'date bad -> fallback format');
ok(/^\d{4}-\d{2}-\d{2} 00:00:00 UTC$/.test(G.formatReviewDate(null)), 'date null -> fallback');

// ===================== cleanText =====================
eq(G.cleanText('itâ€™s'), "it's", 'mojibake apostrophe');
eq(G.cleanText('“hello”'), '"hello"', 'smart quotes');
eq(G.cleanText('a–b'), 'a-b', 'en dash');
eq(G.cleanText('x​y'), 'xy', 'zero-width removed');
eq(G.cleanText(''), '', 'cleanText empty');
eq(G.cleanText(null), '', 'cleanText null');
eq(G.cleanText('too    many   spaces'), 'too many spaces', 'collapse spaces');

// ===================== emoji helpers =====================
ok(G.containsEmoji('nice 😍'), 'containsEmoji true');
ok(!G.containsEmoji('nice'), 'containsEmoji false');
eq(G.stripEmojis('good 👍 product 🔥'), 'good product', 'stripEmojis');
eq(G.stripEmojis('plain'), 'plain', 'stripEmojis none');
{
  const c1 = G.capEmojis('a 😍 b 🔥 c 💯', 1);
  const n1 = (c1.match(/\p{Extended_Pictographic}/gu) || []).length;
  ok(n1 === 1, 'capEmojis to 1 keeps exactly 1, got ' + n1);
}
{
  const capped = G.capEmojis('a 😍 b 🔥 c 💯', 2);
  const count = (capped.match(/\p{Extended_Pictographic}/gu) || []).length;
  ok(count <= 2, 'capEmojis <= 2 kept, got ' + count);
}

// ===================== randomStarDistribution =====================
{
  let allValid = true, correctLen = true;
  for (let n = 0; n < 200; n++) {
    const d = G.randomStarDistribution(10);
    if (d.length !== 10) correctLen = false;
    if (d.some(s => s !== 4 && s !== 5)) allValid = false;
  }
  ok(correctLen, 'randomStarDistribution length');
  ok(allValid, 'randomStarDistribution only 4/5');
  eq(G.randomStarDistribution(0), [], 'star dist 0');
}

// ===================== getRandomSubset =====================
{
  const r = G.getRandomSubset(['a', 'b', 'c'], 2);
  eq(r.length, 2, 'getRandomSubset length 2');
  const r2 = G.getRandomSubset(['a', 'b'], 5); // count > arr -> cycles
  eq(r2.length, 5, 'getRandomSubset cycles length');
  ok(r2.every(x => x === 'a' || x === 'b'), 'getRandomSubset cycles values');
}

// ===================== escapeControlCharsInStrings =====================
eq(G.escapeControlCharsInStrings('["a\nb"]'), '["a\\nb"]', 'escape newline in string');
eq(G.escapeControlCharsInStrings('[\n  "x"\n]'), '[\n  "x"\n]', 'structural whitespace untouched');
eq(G.escapeControlCharsInStrings('"tab\there"'), '"tab\\there"', 'escape tab in string');

// ===================== parseGeminiResponse =====================
function firstReview(json) { const r = G.parseGeminiResponse(json); return r; }
{
  const base = (over = {}) => Object.assign({
    reviewer_name: 'Ravi Kumar', location: 'Pune, Maharashtra', star_rating: 5,
    review_title: 'nice', review_body: 'works well for me', date: '2025-01-01',
    verified_purchase: 'Yes', helpful_votes: 2, language_style: 'Hinglish',
    has_photo: false, reviewer_gender: 'male'
  }, over);

  // plain array
  let r = firstReview(JSON.stringify([base()]));
  eq(r && r.length, 1, 'parse plain array');

  // markdown fences
  r = firstReview('```json\n' + JSON.stringify([base()]) + '\n```');
  eq(r && r.length, 1, 'parse fenced');

  // trailing text after array
  r = firstReview(JSON.stringify([base()]) + '\nHope this helps!');
  eq(r && r.length, 1, 'parse trailing text');

  // trailing comma
  r = firstReview('[' + JSON.stringify(base()) + ',]');
  eq(r && r.length, 1, 'parse trailing comma');

  // newline inside a string literal
  r = firstReview('[{"reviewer_name":"Ravi Kumar","review_title":"ok","review_body":"line1\nline2 good","star_rating":5,"reviewer_gender":"male"}]');
  eq(r && r.length, 1, 'parse raw newline in body');

  // not an array
  eq(G.parseGeminiResponse('{"a":1}'), null, 'parse non-array -> null');
  eq(G.parseGeminiResponse('no json at all'), null, 'parse no-json -> null');
  eq(G.parseGeminiResponse(''), null, 'parse empty -> null');

  // native script review is DROPPED by normalize
  r = firstReview(JSON.stringify([base({ review_body: 'खूपच छान आहे' })]));
  eq(r, [], 'native-script review dropped');

  // price mention dropped
  r = firstReview(JSON.stringify([base({ review_body: 'good but costs 500 rupees' })]));
  eq(r, [], 'price review dropped');

  // platform mention dropped
  r = firstReview(JSON.stringify([base({ review_body: 'ordered from Amazon quick delivery' })]));
  eq(r, [], 'platform review dropped');

  // missing name dropped
  r = firstReview(JSON.stringify([base({ reviewer_name: '' })]));
  eq(r, [], 'missing name dropped');

  // missing title dropped (normalize requires title)
  r = firstReview(JSON.stringify([base({ review_title: '' })]));
  eq(r, [], 'missing title dropped');

  // numeric coercion + gender lower
  r = firstReview(JSON.stringify([base({ star_rating: '4', helpful_votes: '10', reviewer_gender: 'FEMALE' })]));
  ok(r && r[0].star_rating === 4 && r[0].helpful_votes === 10 && r[0].reviewer_gender === 'female', 'numeric coercion + gender lowercased');

  // emoji budget: only ONE emoji-bearing review kept with emoji
  const arr = [base({ review_body: 'love it 😍', reviewer_name: 'A One' }),
               base({ review_body: 'great 🔥', reviewer_name: 'B Two' })];
  r = firstReview(JSON.stringify(arr));
  const withEmoji = r.filter(x => G.containsEmoji(x.review_body)).length;
  ok(withEmoji <= 1, 'emoji budget <=1 per batch, got ' + withEmoji);
  eq(r.length, 2, 'both reviews kept (emoji stripped from 2nd)');
}

// ===================== buildCsvRows =====================
{
  const rev = (over = {}) => Object.assign({
    reviewer_name: 'N', review_title: 't', review_body: 'b', star_rating: 5,
    date: '2025-01-01', has_photo: false, reviewer_gender: 'male'
  }, over);

  // no images -> empty picture col, correct count
  let rows = G.buildCsvRows([rev(), rev()], 'Dropy-X', []);
  eq(rows.length, 2, 'buildCsvRows count');
  eq(rows[0].split(',').length, 7, 'buildCsvRows 7 columns');
  ok(rows.every(r => r.endsWith(',')), 'buildCsvRows empty picture col when no images');

  // gender match: female image -> female has_photo review
  const reviews = [rev({ has_photo: true, reviewer_gender: 'male', reviewer_name: 'M' }),
                   rev({ has_photo: true, reviewer_gender: 'female', reviewer_name: 'F' }),
                   rev({ has_photo: false, reviewer_gender: 'male', reviewer_name: 'X' })];
  rows = G.buildCsvRows(reviews, 'Dropy-X', [{ url: 'https://img/f.jpg', persona: 'female' }]);
  ok(rows[1].includes('https://img/f.jpg'), 'female image -> female reviewer row');
  ok(!rows[0].includes('https://img/f.jpg') && !rows[2].includes('https://img/f.jpg'), 'image only on the matched row');

  // more images than photo-reviews -> falls back to any review, no crash, each url placed once
  rows = G.buildCsvRows([rev({ has_photo: true, reviewer_gender: 'male' }), rev({ has_photo: false })],
    'Dropy-X', [{ url: 'a.jpg', persona: 'male' }, { url: 'b.jpg', persona: 'female' }, { url: 'c.jpg', persona: 'neutral' }]);
  const joined = rows.join('\n');
  ok(joined.includes('a.jpg') && joined.includes('b.jpg'), 'extra images assigned to fallback reviews');
  eq(rows.length, 2, 'more images than reviews: still 2 rows');

  // string image items (legacy) tolerated
  rows = G.buildCsvRows([rev({ has_photo: true })], 'Dropy-X', ['plain-url.jpg']);
  ok(rows[0].includes('plain-url.jpg'), 'string image item tolerated');

  // CSV escaping inside a row
  rows = G.buildCsvRows([rev({ review_body: 'a, b "c"', reviewer_name: 'Doe, John' })], 'Dropy-X', []);
  ok(rows[0].includes('"a, b ""c"""') && rows[0].includes('"Doe, John"'), 'row-level CSV escaping');
}

// ===================== classifyResult =====================
eq(G.classifyResult({ alreadyDone: true }), 'done', 'classify alreadyDone');
eq(G.classifyResult({ reviews: 5 }), 'done', 'classify has reviews');
eq(G.classifyResult({ reviews: 0, error: 'not found on dropy.in' }), 'skipped', 'classify not found -> skipped');
eq(G.classifyResult({ reviews: 0, error: 'stopped' }), 'skipped', 'classify stopped -> skipped');
eq(G.classifyResult({ reviews: 0, error: 'Gemini exploded' }), 'error', 'classify generic error');

// ===================== buildPrompt =====================
{
  const pd = { name: 'Test Cream', brand: 'BrandX', category: 'Skincare', bullets: 'moisturizes', full_description: 'A cream', specifications: '50g' };
  let p = G.buildPrompt(pd, 0, 3, 10, [], []);
  ok(p.includes('Test Cream') && p.includes('BrandX'), 'prompt includes product facts');
  ok(p.includes('10 reviews') || p.includes('10 DIFFERENT'), 'prompt includes count');
  ok(p.includes('No review in this batch has a photo'), 'prompt no-photo rule when photoGenders empty');

  // with photo genders
  p = G.buildPrompt(pd, 0, 3, 10, ['Ravi', 'Sita'], ['male', 'female']);
  ok(p.includes('EXACTLY 2 of the 10'), 'prompt photo rule count');
  ok(p.includes('DO NOT reuse'), 'prompt avoids used names');

  // empty product data doesn't crash
  p = G.buildPrompt({}, 0, 1, 5, [], []);
  ok(typeof p === 'string' && p.length > 0, 'prompt handles empty product data');
}

// ---- report ----
console.log('\n================ RESULTS ================');
if (fails.length) console.log(fails.join('\n') + '\n');
console.log(`PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
