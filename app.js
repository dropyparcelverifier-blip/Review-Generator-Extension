// ============================================================
// REVIEW GENERATOR - MAIN LOGIC
// ============================================================

let products = [];   // [{ asin, sku }]
let uploadedFileBase = ''; // base name of the uploaded list — used to name the output CSV
// ONE combined CSV per batch, persisted across Stop→Continue/resume so all
// reviews keep going into the SAME file (no duplicate "reviews (1).csv").
// { fileName, rows: string[] } — rows are accumulated across every run of the batch.
let csvBatch = null;
let lastFailed = []; // items that failed/were skipped in the last run (for Retry)
let runSearchIds = []; // temp Lens SEARCH images uploaded this run (safe to delete)
let runReviewIds = [];  // review PHOTOS re-hosted this run (IN USE by the CSV — deleting breaks reviews)
// Two independent run modes with SEPARATE progress + output files:
//  - 'text'  → fully automatic, no image picking → "<name>.csv"
//  - 'image' → interactive photo picking, one review per photo → "<name>_images.csv"
// Each mode tracks its own done-ASINs and its own CSV batch so running one never
// blocks or overwrites the other (you can do text now and images later).
let runMode = 'text';
let doneAsinsText = new Set();  // completed ASINs for the TEXT run (persisted)
let doneAsinsImage = new Set(); // completed ASINs for the IMAGE run (persisted)
let doneAsins = doneAsinsText;  // points at the ACTIVE mode's set during a run
let lastMode = 'text';          // mode of the last run (used by Retry)
let genFailStreak = 0;          // consecutive products that generated 0 reviews (Gemini health)
let isProcessing = false;
let isPaused = false;
let geminiTabId = null;

// ============================================================
// INDIAN DATA POOLS
// ============================================================

const LANGUAGE_STYLES = [
  'Pure Indian English', 'Hinglish', 'Marathi-English'
];

// Pool of natural, common review emojis. A random few are suggested per batch
// so emojis vary across the file instead of always being 👍.
const EMOJI_POOL = ['❤️', '😍', '🙌', '👌', '🔥', '💯', '😊', '✨', '🥰', '😁', '🙏', '👍', '😎', '💕'];

// ============================================================
// PROMPT BUILDER
// ============================================================

// Distinct real-shopper scenarios. Assigning a different one to each review
// forces variety so reviews don't all sound the same across batches.
const REVIEW_ANGLES = [
  'bought it for themselves after seeing it online',
  'gifted it to their wife/husband',
  'buying it again (2nd or 3rd time, repeat customer)',
  'was skeptical at first but ended up liking it',
  'bought it for their mother/father (elderly parent)',
  'bought it for their kid/teenager',
  'a friend or colleague recommended it',
  'first time trying this brand',
  'bought it for a specific season problem (winter dryness / summer / monsoon)',
  'uses it daily before going to office/college',
  'keeps it for travel / carries in bag',
  'had a small issue with delivery or packaging but the product itself is fine',
  'switched to this after their old routine stopped working',
  'just a quick happy one-liner, very satisfied',
  'a detailed enthusiast who really got into it',
  'bought it on a whim, low expectations, pleasantly surprised',
  'practical no-nonsense buyer who just states if it works',
  'bought multiple/stocked up for the family'
];

function buildPrompt(productData, batchNum, totalBatches, reviewCount, usedNames = [], photoGenders = []) {
  const starDist = randomStarDistribution(reviewCount);
  const starsForBatch = starDist.join(', ');

  const photoCtx = productData.imageMeta || productData.name || 'the product';
  const photosThisBatch = photoGenders.length;
  const genderSpec = photoGenders.map((g, i) => `(${i + 1}) ${g}`).join(', ');
  const photoRule = photosThisBatch > 0
    ? `EXACTLY ${photosThisBatch} of the ${reviewCount} reviews in this batch are from customers who ATTACHED THEIR OWN PHOTO. Set "has_photo": true for ONLY those ${photosThisBatch}, and their reviewer genders MUST match this list in order: ${genderSpec}. For each, set "reviewer_gender" accordingly: "female" -> a woman (female Indian name); "male" -> a man (male Indian name); "kids" -> a PARENT writing about their child/baby using it (name can be either gender, mention the kid); "neutral" -> any gender. Those photo reviews may casually reference their pic (tied to ${photoCtx}). EVERY OTHER review: "has_photo": false, must NOT mention any photo, and set "reviewer_gender" to the gender its own name implies ("male"/"female").`
    : `No review in this batch has a photo: set "has_photo": false for ALL of them, do NOT mention any photo/pic/image, and set "reviewer_gender" ("male"/"female") to match each reviewer's name.`;

  const langStyles = getRandomSubset(LANGUAGE_STYLES, reviewCount);
  const angles = getRandomSubset(REVIEW_ANGLES, reviewCount);

  const avoidNames = usedNames.length
    ? `\nDO NOT reuse any of these reviewer names already used for this product (pick fresh, different Indian names): ${usedNames.slice(-60).join(', ')}.`
    : '';

  const hasEmoji = Math.random() < 0.45;
  // Rotate a random emoji palette per batch so emojis VARY across the file
  // instead of every review defaulting to 👍.
  const emojiPalette = getRandomSubset(EMOJI_POOL, 4);
  const emojiInstruction = hasEmoji
    ? `AT MOST 1 review in this batch may include 1-2 natural emojis in its body. If you add one, pick from these and VARY it (do NOT default to 👍): ${emojiPalette.join(' ')}. All other reviews must have ZERO emojis, and NO review title may contain an emoji.`
    : 'NO emojis in any review in this batch.';

  const includeComparison = Math.random() < 0.2;
  const comparisonNote = includeComparison
    ? 'One review in this batch can naturally mention a competitor product for comparison. Keep it subtle and organic.'
    : 'No competitor comparisons in this batch.';

  const today = new Date().toISOString().split('T')[0];
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const prompt = `You are simulating ${reviewCount} DIFFERENT real Indian shoppers who each bought this product and are quickly writing a review on their phone. They are ordinary people, not writers. Generate exactly ${reviewCount} reviews in strict JSON array format. The reviews must read like genuine human customers - casual, imperfect and varied - NOT like AI or marketing text.

PRODUCT INFORMATION (these are the REAL facts about this exact product - base every review on them, do not contradict or invent beyond them):
- Product Name: ${productData.name || 'Unknown'}
- Brand: ${productData.brand || 'N/A'}
- Category: ${productData.category || 'General'}
- Key Features (from the listing): ${productData.bullets || productData.short_description || 'N/A'}
- Description: ${productData.full_description || productData.short_description || 'N/A'}
- Specifications: ${productData.specifications || 'N/A'}
- Google AI Overview (real-world summary of what this product is & how people use it - use as factual context, do NOT copy verbatim): ${productData.aiOverview || 'N/A'}
- Extra research (visual matches / feedback themes): ${productData.webReference || 'N/A'}
- Review photo context (what the attached customer photos show): ${productData.imageMeta || 'N/A'}

STRICT RULES:
0. SCRIPT: Write EVERY review (title and body) using ENGLISH / ROMAN letters ONLY. NEVER use Devanagari/Hindi/Marathi script or any non-English alphabet. Marathi-English and Hinglish must be fully romanized - e.g. write "khupach chaan volume aahe", NOT "खूपच छान"; write "magvla hota", NOT "मागवला होता". Not a single native-script character anywhere.
1. Language styles for each review (in order): ${langStyles.join(', ')}
2. Star ratings for each review (in order): ${starsForBatch}
3. EACH review must be based on a DIFFERENT scenario/angle (in order), so no two reviews feel alike: ${angles.map((a, i) => `(${i + 1}) ${a}`).join('; ')}
4. Reviewer name MUST match the language style (Marathi name + a Maharashtra city like Pune/Nagpur/Nashik for Marathi-English; common North-Indian/neutral Indian names + cities for Hinglish and Indian English). Every name must be UNIQUE within this batch - real first AND last names, vary them widely (not all "Sharma"/"Patil").${avoidNames}
6. Location must be a realistic Indian city+state matching the reviewer's region
7. ABSOLUTELY NO price, cost, MRP, discount, deal, offer, or rupee amount mentioned anywhere
7b. NEVER mention any shopping site or marketplace by name (NO "Amazon", "Flipkart", "Myntra", "Nykaa", "Meesho", "Snapdeal", "Ajio", etc.) and never say "the seller", "this listing" or "ordered it on/from <site>". These reviews are shown on a different store. If mentioning delivery, keep it generic: "the order arrived", "delivery was quick", "packaging was fine".
8. Talk about REAL personal experience, NOT a feature list. Mention WHY they bought it, who it's for (self, wife, mom, kids, gift), when/how they use it, and how it actually worked for THEM. Refer to the product loosely ("this", "it", "the cream/mousse/balm") - real people rarely repeat the full product name. Each review should naturally include ONE concrete, accurate detail from the product info above (a real benefit, ingredient, material, size, scent or use-case) - woven into their experience, in their own words, not copied like a spec.
8c. ${photoRule}
9. ${emojiInstruction}
10. ${comparisonNote}
11. Review title: short, casual, 2-7 words - how a real person types it (often lowercase, sometimes just "nice", "good product", "value for money", "as expected"). The review_title MUST be in the SAME language style as that review's review_body (Hinglish title for Hinglish body, Marathi-English title for Marathi-English body). Same person, same casual tone.
12. Length must VARY A LOT. Roughly half the reviews should be very short (3-12 words, e.g. "Good product, works as expected" or "Bahut accha hai, satisfied"). A few medium. Only 1-2 longer/detailed. Do NOT make them all the same polished paragraph.
13. Date: random between ${oneYearAgo} and ${today}, format YYYY-MM-DD
14. Helpful votes: random 0-50 (most reviews should have low numbers like 0-5; only a few higher)
15. Verified Purchase: always "Yes"
16. Some reviews can mention how long they have been using it (2 weeks, 1 month, few months), delivery/packaging, or repurchasing.
17. DO NOT start every review the same way. Vary openings - some start mid-thought, some with the verdict, some with the reason they bought it. No two reviews in this batch may share the same opening words.

HUMAN REALISM - MAKE THEM NOT LOOK AI-GENERATED (very important):
- Write like a normal Indian shopper typing fast on a phone, NOT like marketing copy or a polished blog.
- Use casual/imperfect writing: occasional lowercase, missing capital letters, missing commas, run-on or incomplete sentences, casual short forms (gud, nyc, plz, thnx, awsm, mst, rly, pls, n).
- Add a few small, natural typos in some reviews (not every one).
- Even 4-5 star reviews can have a tiny gripe ("packaging was so-so but product good", "delivery was late but worth it", "smell could be better").
- BANNED AI-sounding words/phrases - do NOT use: "exceptional", "exceptionally", "elevate", "game-changer", "top-notch", "highly recommend to anyone", "must-have", "overall", "in conclusion", "truly remarkable", "delve", "seamless", "boasts", "plethora", "when it comes to", "I am thrilled", "this product offers", "leaves much to be desired".
- Avoid perfectly balanced "pros and cons" structures and tidy summaries. Real reviews are uneven and a bit random.
- Vary sentence rhythm hugely between reviews. They must read like ${reviewCount} DIFFERENT people, not one writer.

ACCURACY - STAY TRUE TO THE REAL PRODUCT (very important):
- First work out exactly WHAT this product is and HOW it is actually used from the product info, then make every review clearly about THIS product used correctly. A hair mousse is applied to hair for hold/volume; a lip balm goes on lips; a supplement is consumed for health; etc. NEVER describe a wrong use.
- Use only REAL facts from the product info. Do NOT invent ingredients, certifications, numbers, claims, model names, colours or features the product does not have. If unsure about a detail, stay general about the experience instead of making something up.
- Match the product's real category and audience (e.g. baby product -> a parent; men's grooming -> mostly men). Benefits mentioned must be ones this product can actually deliver.
- Different reviewers should praise/notice DIFFERENT real aspects (one the texture, one the smell, one ease of use, one results over time) so it doesn't sound scripted.

REAL HUMAN EMOTION (very important - this is what makes them believable):
- Every review must carry a genuine FEELING, not a flat neutral tone. Real people write because they felt something - relief, happiness, excitement, gratitude, mild irritation, surprise, reassurance for their family, etc.
- Tie the emotion to WHY it mattered to them personally: e.g. relief that a long-standing problem finally got sorted, happiness that a parent/child is comfortable, surprise that it actually worked after doubting it, satisfaction of a repeat buyer who trusts it now.
- Match the emotion to the star rating: 5-star = clearly happy / impressed / relieved / loyal; 4-star = satisfied but with one honest small letdown they actually felt.
- Show the feeling through natural words and rhythm (a little emphasis, "honestly", "ngl", "was worried but", "so glad", "thank god", "kaafi khush", "ekdum mast vatla"), NOT by over-the-top gushing or fake drama.
- Vary the emotion across the batch - do not give them all the same upbeat tone.

RESPOND WITH ONLY A VALID JSON ARRAY. No markdown, no backticks, no explanation. Just the JSON:
[
  {
    "reviewer_name": "Name Here",
    "location": "City, State",
    "star_rating": 5,
    "review_title": "Title here",
    "review_body": "Body here",
    "date": "YYYY-MM-DD",
    "verified_purchase": "Yes",
    "helpful_votes": 12,
    "language_style": "Hinglish",
    "has_photo": false,
    "reviewer_gender": "male"
  }
]`;

  return prompt;
}

function randomStarDistribution(count) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    const rand = Math.random();
    if (rand < 0.65) stars.push(5);
    else stars.push(4);
  }
  return stars;
}

function getRandomSubset(arr, count) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(shuffled[i % shuffled.length]);
  }
  return result;
}

// ============================================================
// UI CONTROLS
// ============================================================

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileCount = document.getElementById('fileCount');
const removeFile = document.getElementById('removeFile');
const startTextBtn = document.getElementById('startTextBtn');
const startImageBtn = document.getElementById('startImageBtn');
const stopBtn = document.getElementById('stopBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const resetBtn = document.getElementById('resetBtn');
const imagePicker = document.getElementById('imagePicker');
const imageGrid = document.getElementById('imageGrid');
const useImagesBtn = document.getElementById('useImagesBtn');
const skipImagesBtn = document.getElementById('skipImagesBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const retryBtn = document.getElementById('retryBtn');
const addImagesBtn = document.getElementById('addImagesBtn');
const clearImagesBtn = document.getElementById('clearImagesBtn');

// Live run metrics
const stats = { total: 0, done: 0, reviews: 0, images: 0, issues: 0, startTime: 0 };
let timerInterval = null;

function resetStats(total) {
  stats.total = total; stats.done = 0; stats.reviews = 0; stats.images = 0; stats.issues = 0;
  stats.startTime = Date.now();
  renderMetrics();
}

function renderMetrics() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('mDone', `${stats.done}/${stats.total}`);
  set('mReviews', stats.reviews);
  set('mImages', stats.images);
  set('mIssues', stats.issues);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - stats.startTime;
    const avg = stats.done > 0 ? elapsed / stats.done : 0;
    const remaining = avg > 0 ? avg * (stats.total - stats.done) : 0;
    const txt = document.getElementById('timeText');
    if (txt) txt.textContent = remaining > 0
      ? `${fmtTime(elapsed)} elapsed · ~${fmtTime(remaining)} left`
      : `${fmtTime(elapsed)} elapsed`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// File Upload
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});
removeFile.addEventListener('click', resetUpload);
startTextBtn.addEventListener('click', () => startProcessing('text'));
startImageBtn.addEventListener('click', () => startProcessing('image'));

stopBtn.addEventListener('click', () => {
  isProcessing = false;
  isPaused = false; // release any pause-wait so the loop can exit
  if (pickResolve) pickResolve([]); // release a pending image picker
  pauseBtn.classList.add('hidden');
  resumeBtn.classList.add('hidden');
  log('Stopping after current step...', 'warn');
});

pauseBtn.addEventListener('click', () => {
  isPaused = true;
  pauseBtn.classList.add('hidden');
  resumeBtn.classList.remove('hidden');
  updateProductStatus('Paused', null);
  log('Paused — will hold at the next safe point. Click Continue to resume.', 'warn');
});

resumeBtn.addEventListener('click', () => {
  isPaused = false;
  resumeBtn.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
  log('Resumed', 'success');
});

resetBtn.addEventListener('click', () => {
  products = [];
  showStep('step-upload');
  resetUpload();
});

clearLogBtn.addEventListener('click', () => {
  document.getElementById('logArea').innerHTML = '';
});

// Results-screen: delete THIS run's review photos (for a run you're not importing).
// Temporary Lens search images are cleaned up automatically at the end of the run.
clearImagesBtn.addEventListener('click', async () => {
  if (!runReviewIds.length) return;
  if (!confirm(`⚠ Delete this run's ${runReviewIds.length} review photo(s) from Shopify Files?\n\nThis BREAKS these images if you've already imported this run's CSV. Only do it for a run you did NOT import. Can't be undone.`)) return;
  clearImagesBtn.disabled = true;
  clearImagesBtn.textContent = 'Deleting...';
  const res = await deleteShopifyImages(runReviewIds);
  await removeFromStore('review', runReviewIds);
  log(`Deleted ${res.deleted || 0} review photo(s) from Shopify`, res.ok ? 'success' : 'warn');
  runReviewIds = [];
  clearImagesBtn.disabled = false;
  clearImagesBtn.classList.add('hidden');
});

retryBtn.addEventListener('click', () => {
  if (lastFailed.length === 0) return;
  products = lastFailed.slice();
  startProcessing(lastMode); // retry in the same mode the failed run used
});

// After a TEXT run, do the image pass on the SAME list (no re-upload). Image
// progress is tracked separately, so this processes every product afresh.
addImagesBtn.addEventListener('click', () => {
  if (!products.length) { alert('Upload the ASIN list again to add image reviews.'); return; }
  startProcessing('image');
});

// Blocks while the run is paused (and still active), so processing halts at a
// safe checkpoint without losing progress. Returns when resumed or stopped.
async function waitWhilePaused() {
  while (isPaused && isProcessing) {
    await sleep(400);
  }
}

// --- Image picker: shows candidate images and resolves with the chosen items ---
let pickResolve = null;
let pickItems = [];

// Safety net: if the picker is in "real photos only" mode and every real-photo cell
// got filtered out (too small / broken / removed), auto-switch to showing ALL so you
// are never stranded with an empty grid and a run that appears frozen.
function maybeUnfilterPicker() {
  const box = document.getElementById('ugcOnly');
  if (!box || !box.checked) return;
  if (imageGrid.querySelector('.image-cell.ugc')) return; // real photos still visible
  box.checked = false;
  imageGrid.classList.remove('ugc-only');
  const hint = document.getElementById('pickerHint');
  if (hint) hint.textContent = 'No real-photo matches remained — showing ALL candidates. Tap ✓ keep, ✕ remove, ⤢ enlarge.';
}

// items: array of { url, dataUrl }. Displays dataUrl (reliable) or url, and
// resolves with the selected items (objects), preserving url + bytes.
function pickImages(items) {
  return new Promise((resolve) => {
    if (!items || items.length === 0 || !isProcessing) { resolve([]); return; }
    imageGrid.innerHTML = '';
    items.forEach((item, idx) => {
      const display = item.dataUrl || item.thumb || item.url; // thumb loads reliably
      if (!display) return;
      const cell = document.createElement('div');
      cell.className = 'image-cell' + (item.ugc ? ' ugc' : '');
      cell.dataset.idx = idx;
      // Remove a cell AND keep the grid from ending up empty in real-only mode.
      const drop = () => { if (cell.parentNode) cell.remove(); maybeUnfilterPicker(); };

      // Badge genuine user-taken photos (social / customer-review sources) so the
      // real-vibe ones stand out from catalog shots.
      if (item.ugc) {
        const tag = document.createElement('span');
        tag.className = 'ugc-tag';
        tag.textContent = '👤 real';
        tag.title = 'Genuine user photo (social / customer review)';
        cell.appendChild(tag);
      }

      const img = document.createElement('img');
      img.src = display;
      img.loading = 'lazy';
      img.onerror = () => drop(); // drop images that won't load
      img.onload = () => {
        const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
        const r = h ? w / h : 1;
        // Drop banner/ad shapes (the preview keeps the real aspect ratio).
        if (w && h && (r > 2.4 || r < 0.4)) drop();
      };

      // The picker shows the thumbnail, but we UPLOAD `item.url` — probe ITS real
      // resolution and drop sources too small to be a decent review photo (Google
      // Lens returns tiny ~200px cached thumbnails). Captured (dataUrl) candidates
      // are already full-res, so skip them. On a probe error we keep the cell (we
      // couldn't measure — don't drop what might still upload fine).
      const MIN_UPLOAD_PX = 350;
      if (item.url && !item.dataUrl) {
        const probe = new Image();
        probe.onload = () => {
          const pw = probe.naturalWidth || 0, ph = probe.naturalHeight || 0;
          if (pw && ph && Math.min(pw, ph) < MIN_UPLOAD_PX) drop();
        };
        probe.src = item.url;
      }

      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';

      // persona tag: who the photo represents -> drives the matched reviewer
      cell.dataset.persona = item.persona || 'neutral';
      const personaBar = document.createElement('div');
      personaBar.className = 'persona-bar';
      [['neutral', '—'], ['female', '♀'], ['male', '♂'], ['kids', '🧒']].forEach(([val, label]) => {
        const b = document.createElement('button');
        b.className = 'persona-btn' + (cell.dataset.persona === val ? ' active' : '');
        b.textContent = label;
        b.title = val;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          cell.dataset.persona = val;
          personaBar.querySelectorAll('.persona-btn').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
        });
        personaBar.appendChild(b);
      });

      // ✕ remove this image entirely (e.g. it's a different/irrelevant product)
      const removeBtn = document.createElement('button');
      removeBtn.className = 'cell-btn cell-remove';
      removeBtn.title = 'Remove this image';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => { e.stopPropagation(); drop(); });

      // ⤢ open the original full-size image in a new tab to inspect
      const zoom = document.createElement('a');
      zoom.className = 'cell-btn cell-zoom';
      zoom.title = 'View original size';
      zoom.textContent = '⤢';
      zoom.href = item.url || display;
      zoom.target = '_blank';
      zoom.rel = 'noopener';
      zoom.addEventListener('click', (e) => e.stopPropagation());

      cell.appendChild(img);
      cell.appendChild(check);
      cell.appendChild(removeBtn);
      cell.appendChild(zoom);
      cell.appendChild(personaBar);
      cell.addEventListener('click', () => cell.classList.toggle('selected')); // tick = keep
      imageGrid.appendChild(cell);
    });
    pickItems = items;
    imagePicker.classList.remove('hidden');
    try { imagePicker.scrollIntoView({ block: 'nearest' }); } catch (e) {}

    // Start from the REAL set only when there are enough genuine photos to be
    // useful (>= 6). Otherwise show all (real sorted first + badged) so we never
    // strand you with too few. Either way the toggle lets you switch.
    const REAL_DEFAULT_MIN = 6;
    const ugcCount = items.filter((it) => it.ugc).length;
    const startReal = ugcCount >= REAL_DEFAULT_MIN;
    const ugcBox = document.getElementById('ugcOnly');
    if (ugcBox) {
      ugcBox.checked = startReal;
      imageGrid.classList.toggle('ugc-only', startReal);
    }
    const hint = document.getElementById('pickerHint');
    if (hint) {
      hint.textContent = startReal
        ? `Showing ${ugcCount} real user photo(s) — uncheck below to see all ${items.length}. ✕ removes wrong variants/combos, ⤢ enlarges.`
        : `${items.length} candidate(s)${ugcCount ? ` · ${ugcCount} flagged 👤 real (shown first)` : ''}. Tap ✓ keep, ✕ remove, ⤢ enlarge. Tick "real photos only" to filter.`;
    }
    updateProductStatus('Select review images, then click Continue', null);
    pickResolve = (val) => {
      imagePicker.classList.add('hidden');
      pickResolve = null;
      pickItems = [];
      resolve(val);
    };
  });
}

function collectSelectedImages() {
  return Array.from(imageGrid.querySelectorAll('.image-cell.selected'))
    .map((c) => {
      const it = pickItems[Number(c.dataset.idx)];
      return it ? Object.assign({}, it, { persona: c.dataset.persona || 'neutral' }) : null;
    })
    .filter(Boolean);
}

useImagesBtn.addEventListener('click', () => { if (pickResolve) pickResolve(collectSelectedImages()); });
skipImagesBtn.addEventListener('click', () => { if (pickResolve) pickResolve([]); });

// "Real user photos only" — hides non-UGC (catalog/search) cells in the picker.
const ugcOnly = document.getElementById('ugcOnly');
if (ugcOnly) ugcOnly.addEventListener('change', () => {
  imageGrid.classList.toggle('ugc-only', ugcOnly.checked);
});

const ASIN_RE = /\b(B0[A-Z0-9]{8}|\d{9}[\dX])\b/i; // ASIN: B0XXXXXXXX or 10-digit ISBN-style

// Pulls a clean ASIN out of a raw cell/line: accepts a bare ASIN, a
// "Dropy-<ASIN>" sku, or an Amazon URL containing /dp/<ASIN> or /gp/product/<ASIN>.
function extractAsin(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const dp = s.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i);
  if (dp) return dp[1].toUpperCase();
  const m = s.match(ASIN_RE);
  return m ? m[1].toUpperCase() : null;
}

function buildProducts(asins) {
  // de-dupe while preserving order
  const seen = new Set();
  const list = [];
  for (const a of asins) {
    if (a && !seen.has(a)) { seen.add(a); list.push({ asin: a, sku: `Dropy-${a}` }); }
  }
  return list;
}

// Base name for the output CSV, derived from the uploaded file (so the CSV is
// named after your input list / brand). Strips the extension and any characters
// illegal in a filename.
function csvBaseFromFile(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')          // drop extension
    .replace(/[\\/:*?"<>|]+/g, '_')   // illegal filename chars -> _
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function finalizeUpload(file, parsedCount) {
  if (products.length === 0) {
    alert('No valid ASINs found. The file should list one ASIN per line (e.g. B071HN7KK6).');
    return;
  }
  uploadedFileBase = csvBaseFromFile(file.name); // name the output CSV after the input file
  const dupes = (parsedCount || products.length) - products.length;
  fileName.textContent = file.name;
  fileCount.textContent = dupes > 0 ? `${products.length} ASINs (${dupes} duplicate${dupes > 1 ? 's' : ''} removed)` : `${products.length} ASINs`;
  dropZone.classList.add('hidden');
  fileInfo.classList.remove('hidden');
  startTextBtn.disabled = false;
  startImageBtn.disabled = false;
}

function handleFile(file) {
  const isTxtOrCsv = /\.(txt|csv)$/i.test(file.name);
  const isExcel = /\.xlsx?$/i.test(file.name);

  if (!isTxtOrCsv && !isExcel) {
    alert('Please upload a .txt file with one ASIN per line (or an .xlsx).');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      let asins = [];
      if (isTxtOrCsv) {
        asins = String(e.target.result)
          .split(/[\r\n,]+/)
          .map(extractAsin)
          .filter(Boolean);
      } else {
        const workbook = XLSX.read(e.target.result, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        // Scan every cell for an ASIN (handles bare ASIN / Dropy-<ASIN> / URL columns)
        asins = rows.flat().map(extractAsin).filter(Boolean);
      }
      products = buildProducts(asins);
      finalizeUpload(file, asins.length);
    } catch (err) {
      alert('Error reading file: ' + err.message);
    }
  };

  if (isTxtOrCsv) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

function resetUpload() {
  products = [];
  fileInput.value = '';
  dropZone.classList.remove('hidden');
  fileInfo.classList.add('hidden');
  startTextBtn.disabled = true;
  startImageBtn.disabled = true;
}

function showStep(stepId) {
  document.querySelectorAll('.step').forEach(s => { s.classList.remove('active'); s.classList.add('hidden'); });
  const step = document.getElementById(stepId);
  step.classList.remove('hidden');
  step.classList.add('active');
}

function log(message, type = 'info') {
  const logArea = document.getElementById('logArea');
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-${type}">${message}</span>`;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;
}

// ============================================================
// MAIN PROCESSING
// ============================================================

// Circuit-breaker for a systemically-failing run (the classic cause: Gemini is not
// logged in, so EVERY batch fails after all its retries). If the first few products
// in a row generate zero reviews and NOTHING has succeeded all run, stop instead of
// grinding through the whole list producing an empty CSV. Called after each product.
const GEN_FAIL_LIMIT = 3;
function checkGenHealth(result) {
  if ((result.reviews || 0) > 0) { genFailStreak = 0; return; }
  // An intentional skip (e.g. no photos picked in image mode) isn't a Gemini failure.
  const e = (result.error || '').toLowerCase();
  if (e.includes('skipped') || e.includes('no images')) return;
  genFailStreak++;
  if (genFailStreak >= GEN_FAIL_LIMIT && stats.reviews === 0 && isProcessing) {
    log(`⛔ No reviews generated for the first ${GEN_FAIL_LIMIT} products in a row — Gemini is most likely NOT logged in (or is blocked). Open the Gemini tab, sign in at gemini.google.com, then re-run this list (it resumes where it stopped). Stopping now so the whole batch isn't wasted.`, 'error');
    isProcessing = false;
  }
}

async function startProcessing(mode) {
  if (!products.length) {
    alert('No ASINs to process. Please upload a .txt list first.');
    return;
  }
  // Select the run mode. Default 'text' (automatic, no image picking).
  runMode = mode === 'image' ? 'image' : 'text';
  lastMode = runMode;
  doneAsins = runMode === 'image' ? doneAsinsImage : doneAsinsText;
  csvSinceFlush = 0; csvLastFlushAt = 0; // fresh throttle each run (1st product flushes)
  genFailStreak = 0;                     // fresh Gemini-health streak each run
  isProcessing = true;
  isPaused = false;
  showStep('step-processing');
  stopBtn.classList.remove('hidden');
  pauseBtn.classList.remove('hidden');
  resumeBtn.classList.add('hidden');

  const results = [];
  const totalProducts = products.length;
  runSearchIds = []; runReviewIds = [];

  // Resume vs. fresh batch for the combined CSV. Resume the SAME batch if the
  // current run targets the same output file (`base`) OR shares any ASIN — so a
  // rerun (even of just the failed ASIN, even after you DELETED the file on disk)
  // MERGES into the existing reviews instead of overwriting them. This is the fix
  // for "rerun clobbered the other ASINs". Image runs use a separate base/key.
  const suffix = runMode === 'image' ? '_images' : '';
  const dateStr = new Date().toISOString().slice(0, 10);
  const base = uploadedFileBase ? `${uploadedFileBase}${suffix}` : `reviews${suffix}_${dateStr}_${Date.now()}`;
  const persisted = await loadCsvBatch(); // reads the active mode's batch key
  const persistedBase = persisted && (persisted.base || (persisted.fileName ? String(persisted.fileName).replace(/\.csv$/i, '') : ''));
  // Resume the persisted batch only when this run is a SUBSET of it (a rerun / Retry
  // of the same list — EVERY current ASIN is already in the batch) OR it targets the
  // same output file. Merely SHARING one ASIN with an unrelated list must NOT merge
  // that list in or erase its file (a different upload starts its own fresh batch).
  const isSubset = persisted && Array.isArray(persisted.asins) && products.every((p) => persisted.asins.includes(p.asin));
  const sameFile = persisted && persistedBase && uploadedFileBase && persistedBase === base;
  if (persisted && (isSubset || sameFile)) {
    csvBatch = persisted;
  } else {
    csvBatch = { base, asins: products.map((p) => p.asin) };
  }
  migrateBatch(csvBatch); // ensure rowsByAsin/imgByAsin; carry legacy flat rows
  // Follow the current uploaded name; if it changed, the file must be rewritten
  // (and the old-name file erased on the next write).
  if (uploadedFileBase && csvBatch.base !== base) { csvBatch.base = base; csvBatch.written = false; }
  // Remember every ASIN this batch has ever covered so its rows are never dropped.
  csvBatch.asins = Array.from(new Set([...(csvBatch.asins || []), ...products.map((p) => p.asin)]));
  // Persisted image selections (by ASIN), so a Stop/close during selection or
  // generation doesn't force you to re-pick — resume jumps straight to generating.
  if (!csvBatch.pending || typeof csvBatch.pending !== 'object') csvBatch.pending = {};
  const rowsBefore = csvRowCount(); // rows carried over from earlier runs of this batch
  if (rowsBefore) log(`Resuming batch — merging into ${csvFileName()} (${rowsBefore} review(s) already saved)`, 'info');

  resetStats(totalProducts);
  buildAsinTable(products);
  startTimer();

  // Build the work list, skipping ASINs already completed in a previous run —
  // UNLESS "regenerate already-done" is on, in which case done ASINs are reprocessed
  // and their rows are REPLACED in the file (setCsvProduct), not duplicated.
  const forceRegen = !!(document.getElementById('forceRegen') && document.getElementById('forceRegen').checked);
  const todo = [];
  for (let i = 0; i < totalProducts; i++) {
    const item = products[i];
    if (doneAsins.has(item.asin) && !forceRegen) {
      updateAsinRow(i, 'done', item.asin, 'already done');
      log(`Skipping ${item.asin} — already done in a previous run`, 'info');
      results.push({ asin: item.asin, sku: item.sku, name: item.asin, reviews: 0, images: 0, alreadyDone: true });
      stats.done++;
      renderMetrics();
    } else {
      if (doneAsins.has(item.asin)) log(`Regenerating ${item.asin} — overwriting its earlier reviews`, 'info');
      todo.push({ item, i });
    }
  }

  const setStepTitle = (t) => { const el = document.getElementById('stepTitle'); if (el) el.textContent = t; };

  // ============================================================
  // TEXT MODE — fully automatic. No image picking: look up each product on
  // dropy (lightweight, no image search) and generate text-only reviews,
  // streaming them into "<name>.csv". Unattended — the user can step away.
  // ============================================================
  if (runMode === 'text') {
    setStepTitle('Generating text reviews · automatic');
    if (todo.length && isProcessing) {
      log(`Generating text reviews for ${todo.length} product(s) — no image selection needed. You can step away.`, 'success');
    }
    for (let k = 0; k < todo.length; k++) {
      await waitWhilePaused();
      if (!isProcessing) { log('Stopped', 'warn'); break; }

      const { item, i } = todo[k];
      updateOverallProgress(k + 1, todo.length);
      updateAsinRow(i, 'processing', null, 'looking up...');
      updateProductStatus('Finding product on dropy.in...', item.asin);
      log(`Text ${k + 1}/${todo.length}: ${item.asin}`, 'info');

      let data;
      try {
        data = await prepareProduct(item, i, true); // textOnly — skip all image search
      } catch (e) {
        data = { skip: true, error: e.message };
      }

      if (!data || data.skip) {
        const err = (data && data.error) || 'not found on dropy.in';
        log(`Skipped ${item.asin}: ${err}`, 'error');
        updateAsinRow(i, 'skipped', item.asin, err);
        results.push({ asin: item.asin, sku: item.sku, name: item.asin, reviews: 0, images: 0, error: err });
        stats.done++; stats.issues++;
        renderMetrics();
        continue;
      }

      const unverified = data.productData.asinVerified === false;
      updateAsinRow(i, 'processing', data.productData.name, unverified ? '⚠ unverified — generating' : 'generating...');
      let result;
      try {
        result = await generateProduct({ item, i, productData: data.productData, selected: [], mode: 'text' });
      } catch (err) {
        log(`Error generating ${item.asin}: ${err.message}`, 'error');
        result = { asin: item.asin, sku: item.sku, name: data.productData.name || 'Error', reviews: 0, images: 0, error: err.message };
      }
      if (unverified) result.unverified = true; // surfaced in results so it isn't missed
      results.push(result);
      updateAsinRow(i, classifyResult(result), result.name, `${result.reviews || 0} rev${unverified ? ' · ⚠ unverified' : ''}`);
      checkGenHealth(result); // stop early if Gemini is logged out (nothing generating)

      // Persist rows + mark done as each product finishes (crash-safe resume) AND
      // write the CSV to disk now (crash-proof the file itself, no resume needed).
      if ((result.reviews || 0) > 0) {
        csvBatch.written = false;         // new rows not on disk yet
        const persistedOk = await saveCsvBatch();
        if (persistedOk) markDone(item.asin);
        if (await maybeFlushCsvToDisk()) await saveCsvBatch(); // throttled disk write; persist written=true only if it wrote
      }

      stats.done++;
      stats.reviews += (result.reviews || 0);
      if (result.error || (result.reviews || 0) === 0) stats.issues++;
      renderMetrics();

      if (k < todo.length - 1 && isProcessing) await sleep(800);
    }
  } else {
  // ============================================================
  // PHASE 1 — SELECTION (interactive). Pick images for every product
  // back-to-back. While you pick one product, the NEXT is already being scraped
  // in the background (1-ahead look-ahead) so its picker opens with no wait.
  // Text generation is deferred to Phase 2 — you never wait on Gemini here.
  // ============================================================
  setStepTitle('Step 1 of 2 · Select Images');
  const prepared = []; // { item, i, productData, selected } → generated in Phase 2
  let prefetch = null; // { k, promise } — the next product being scraped ahead
  for (let k = 0; k < todo.length; k++) {
    await waitWhilePaused();
    if (!isProcessing) { log('Stopped during selection', 'warn'); break; }

    const { item, i } = todo[k];
    updateOverallProgress(k + 1, todo.length);

    // Restore a previously-saved selection (from an interrupted run) — skip the
    // re-scrape and re-pick entirely and hand it straight to Phase 2.
    const savedPick = csvBatch.pending[item.asin];
    if (savedPick && savedPick.productData) {
      const selCount = (savedPick.selected || []).length;
      log(`Restored your earlier selection for ${item.asin} (${selCount} image(s)) — no re-scrape needed`, 'info');
      updateAsinRow(i, 'queued', savedPick.productData.name || item.asin, `${selCount} img selected (restored)`);
      stats.images += selCount; renderMetrics(); // count selected photos toward the total
      prepared.push({ item, i, productData: savedPick.productData, selected: savedPick.selected || [] });
      continue;
    }

    updateAsinRow(i, 'processing', null, 'finding images...');
    updateProductStatus('Finding product & images...', item.asin);
    log(`Selecting ${k + 1}/${todo.length}: ${item.asin}`, 'info');

    // Use the prefetched scrape if it's for this product; else scrape now.
    let data;
    try {
      data = (prefetch && prefetch.k === k) ? await prefetch.promise : await prepareProduct(item, i);
    } catch (e) {
      data = { skip: true, error: e.message };
    }
    prefetch = null;

    // Kick off scraping the NEXT product that ISN'T already restored-from-pending
    // (those need no scrape) while you pick this one's images.
    {
      let j = k + 1;
      while (j < todo.length && csvBatch.pending[todo[j].item.asin]) j++;
      if (j < todo.length && isProcessing) {
        prefetch = { k: j, promise: prepareProduct(todo[j].item, todo[j].i).catch((e) => ({ skip: true, error: e.message })) };
      }
    }

    if (!data || data.skip) {
      const err = (data && data.error) || 'not found on dropy.in';
      log(`Skipped ${item.asin}: ${err}`, 'error');
      updateAsinRow(i, 'skipped', item.asin, err);
      results.push({ asin: item.asin, sku: item.sku, name: item.asin, reviews: 0, images: 0, error: err });
      stats.done++; stats.issues++;
      renderMetrics();
      continue;
    }

    // Interactive image pick. Hosting + generation happen in Phase 2.
    const unverified = data.productData.asinVerified === false;
    let selected = [];
    if (data.candidates.length && isProcessing) {
      log('Select the review images, then click "Upload selected & continue"...', 'info');
      const refName = unverified
        ? `⚠ UNVERIFIED — is this ${item.asin}?  ${data.productData.name}`
        : data.productData.name;
      setProductRef(data.refImg, refName, data.refFull);
      selected = await pickImages(data.candidates);
      setProductRef('', '');
      const discarded = data.candidates.length - selected.length;
      log(`${selected.length} image(s) selected → will upload · ${discarded} unselected discarded (not uploaded, no trace)`, selected.length ? 'success' : 'info');
    }
    // Free the heavy captured image data (base64 galleries + padded Lens image)
    // before buffering — Phase 2 only needs the text fields, `lensText`, and the
    // picked `selected` items. Without this, dozens of buffered products would
    // hold hundreds of MB of base64 in memory.
    ['gallery', 'imageData', 'images', 'originalImages', 'image'].forEach((key) => { delete data.productData[key]; });

    // Persist this selection so a Stop/close before generation doesn't lose it.
    csvBatch.pending[item.asin] = { productData: data.productData, selected };
    await saveCsvBatch();

    prepared.push({ item, i, productData: data.productData, selected });
    stats.images += selected.length; renderMetrics(); // running total of selected photos
    updateAsinRow(i, 'queued', data.productData.name, `${selected.length} img selected${unverified ? ' · ⚠ unverified' : ''}`);
  }

  // ============================================================
  // PHASE 2 — GENERATION (unattended). All picks are done, so you're free.
  // Reviews generate one product at a time (Gemini is a single tab) and stream
  // into the combined CSV as they finish.
  // ============================================================
  setStepTitle('Step 2 of 2 · Generating Reviews');
  if (prepared.length && isProcessing) {
    log(`Selections done — generating reviews for ${prepared.length} product(s) in the background. You can step away.`, 'success');
  }
  for (let j = 0; j < prepared.length; j++) {
    await waitWhilePaused();
    if (!isProcessing) { log('Stopped during generation', 'warn'); break; }

    const job = prepared[j];
    job.mode = 'image'; // one review per selected photo, all carrying a photo
    updateOverallProgress(j + 1, prepared.length);
    updateAsinRow(job.i, 'processing', job.productData.name, 'generating...');
    log(`Generating ${j + 1}/${prepared.length}: ${job.productData.name}`, 'info');

    let result;
    try {
      result = await generateProduct(job);
    } catch (err) {
      log(`Error generating ${job.item.asin}: ${err.message}`, 'error');
      result = { asin: job.item.asin, sku: job.item.sku, name: job.productData.name || 'Error', reviews: 0, images: 0, error: err.message };
    }
    // Carry the unverified flag onto the result so the completion summary flags it
    // (same as text mode) — an unconfirmed ASIN shouldn't vanish after the run.
    const unv = job.productData.asinVerified === false;
    if (unv && (result.reviews || 0) > 0) result.unverified = true;
    results.push(result);
    updateAsinRow(job.i, classifyResult(result), result.name,
      `${result.reviews || 0} rev${result.images ? ` · ${result.images} img` : ''}${unv ? ' · ⚠ unverified' : ''}`);
    checkGenHealth(result); // stop early if Gemini is logged out (nothing generating)

    // Persist rows to storage and mark done AS EACH product finishes, so closing
    // the panel mid-generation loses nothing and completed ASINs skip on resume
    // (the file is rewritten from these rows below and on any resume). Only mark
    // done if the persist actually succeeded — never skip unsaved reviews.
    if ((result.reviews || 0) > 0) {
      csvBatch.written = false; // new rows not on disk yet
      delete csvBatch.pending[job.item.asin]; // selection consumed — no longer needed
      const persisted = await saveCsvBatch();
      if (persisted) markDone(job.item.asin);
      if (await maybeFlushCsvToDisk()) await saveCsvBatch(); // throttled disk write; persist written=true only if it wrote
    } else if ((job.selected || []).length === 0) {
      // User deliberately picked NO photos for this product → record it as handled
      // so it isn't re-scraped/re-prompted (and doesn't loop generating 0 reviews)
      // on every resume. Genuine generation failures (selected>0, reviews=0) keep
      // their pending so Retry/resume can try again.
      delete csvBatch.pending[job.item.asin];
      const persisted = await saveCsvBatch();
      if (persisted) markDone(job.item.asin);
    }

    stats.done++;
    stats.reviews += (result.reviews || 0);
    // NOTE: images are counted once, at selection time in Phase 1 (not here) — so
    // the Images metric reflects total SELECTED photos and isn't double-counted.
    if (result.error || (result.reviews || 0) === 0) stats.issues++;
    renderMetrics();

    if (j < prepared.length - 1 && isProcessing) await sleep(800);
  }
  } // end image mode

  // Write/overwrite the ONE combined CSV for this batch — same file across
  // Stop→Continue/resume (overwrite, never "reviews (1).csv"). Only (re)download
  // when this run actually ADDED rows, or the file was never written for this
  // batch (e.g. a prior run crashed before writing). A plain rerun of an
  // all-already-done batch adds nothing, so it must NOT re-download the old file.
  // The file is already streamed to disk after each product (flushCsvToDisk), so
  // this is a safety net: only (re)write if a per-product flush didn't land.
  const addedThisRun = csvRowCount() - rowsBefore;
  if (csvRowCount() && !csvBatch.written) {
    const ok = await writeCsvNow();
    await saveCsvBatch();
    log(ok
      ? `✅ ${csvFileName()} saved — ${addedThisRun} new this run, ${csvRowCount()} reviews total in the file`
      : `⚠ Couldn't write ${csvFileName()} to disk — the reviews are saved inside the extension and will be written on the next run of this list.`,
      ok ? 'success' : 'warn');
  } else if (csvRowCount()) {
    const msg = addedThisRun > 0
      ? `✅ ${csvFileName()} — ${addedThisRun} new this run, ${csvRowCount()} total (written to disk as it ran)`
      : `No new reviews this run — ${csvFileName()} already saved (not re-downloaded)`;
    log(msg, addedThisRun > 0 ? 'success' : 'info');
  }

  // Auto-delete the run's temporary Lens search images (disposable, never in the CSV).
  await autoCleanSearchImages();

  // Close Gemini tab + the shared scraping tab
  if (geminiTabId) {
    chrome.runtime.sendMessage({ action: 'close_tab', tabId: geminiTabId });
    geminiTabId = null;
  }
  chrome.runtime.sendMessage({ action: 'close_scrape_tab' });

  isProcessing = false;
  isPaused = false;
  stopTimer();
  stopBtn.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  resumeBtn.classList.add('hidden');

  showResults(results);
}

// Self-heal: close any stale Gemini tab and open a fresh one. Used when the
// tab dies, logs out, or stops responding so the run can repair itself.
async function recoverGemini() {
  try {
    if (geminiTabId) {
      await new Promise((resolve) =>
        chrome.runtime.sendMessage({ action: 'close_tab', tabId: geminiTabId }, () => resolve())
      );
    }
  } catch (e) { /* ignore */ }

  geminiTabId = null;
  const res = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ action: 'open_gemini' }, resolve)
  );
  geminiTabId = res && res.tabId;
  await sleep(3500);
  return !!geminiTabId;
}

// PHASE 1 helper: scrape the product on dropy.in and gather review-image
// candidates. No text generation and no user interaction, so it is safe to run
// AHEAD of time (prefetch) while the user picks the previous product's images.
// Returns { productData, candidates, refImg, refFull } or { skip:true, error }.
async function prepareProduct(item, productIndex, textOnly = false) {
  const asin = item.asin;
  const sku = item.sku;

  // Step 1: Find the product on dropy.in via predictive search matched to the
  // ASIN (background verifies the ASIN against candidates' product JSON).
  log(`Looking up ${asin} on dropy.in...`, 'info');

  const productData = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'dropy_lookup', query: sku, asin }, (response) => resolve(response || {}));
  });

  if (!productData.name) {
    return { skip: true, error: productData.error || 'not found on dropy.in' };
  }

  const productName = productData.name;
  log(`Product: ${productName}`, 'success');

  // VERIFY the match. The background already confirmed the ASIN against each
  // candidate's product JSON (dropyMatched); as a backstop we also check the
  // scraped fields. Guards against scraping a wrong/recommended product.
  const hay = [productData.productUrl, productData.sku, productData.barcode, productData.name, productData.full_description, productData.short_description]
    .filter(Boolean).join(' ').toUpperCase();
  productData.asinVerified = productData.dropyMatched === true || hay.includes(String(asin).toUpperCase());
  if (!productData.asinVerified) {
    if (settings.strictMatch) {
      log(`Skipped ${asin}: dropy result "${productName}" doesn't match this ASIN (strict match on)`, 'error');
      return { skip: true, error: `dropy result doesn't match ASIN ${asin} (possible wrong product)` };
    }
    log(`⚠ Couldn't confirm "${productName}" matches ${asin} — check the reference image is the right product`, 'warn');
  }

  // TEXT MODE fast path: reviews carry no photos, so skip ALL image search
  // (Lens/Google/Pinterest/Amazon/Bing/social) entirely. Just return the scraped
  // product data — the run goes straight to generating text reviews.
  if (textOnly) {
    productData.lensText = '';
    return { productData, candidates: [], refImg: '', refFull: '' };
  }

  // Step 2: gather REAL user photos from several sources. Each result item is
  // { full, thumb, ctx, ugc } — we DISPLAY the thumb (loads reliably) and UPLOAD
  // the full-res source (high quality). Lens drives the visual search.
  const bg = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
  const originals = productData.originalImages || [];
  const lensSource = originals[0] || '';
  const webItems = [];
  let lensText = '';

  // All sources run IN PARALLEL — each uses its own pooled scrape tab in the
  // background, so total time ≈ the slowest source instead of their sum.
  const barcode = productData.barcode || '';
  let amzItems = [];
  const jobs = [];

  // Bias the web image searches toward genuine user shots (unboxings, in-hand,
  // real customer photos) rather than catalog/marketing images.
  const baseQ = `${productName} ${productData.brand || ''}`.trim();
  const ugcQ = `${baseQ} review unboxing real photo`;

  if (settings.srcLens && isProcessing) jobs.push((async () => {
    try {
      let lens = {};
      if (productData.imageData) {
        log('Searching Google Lens (padded, no-crop) ...', 'info');
        lens = await bg({ action: 'lens_by_bytes', imageData: productData.imageData });
      } else if (lensSource) {
        lens = await bg({ action: 'lens_by_url', imageUrl: lensSource });
      }
      lensText = lens.text || '';
      (lens.items || []).forEach((it) => webItems.push(it));
      if (lens.searchFileId) addUploadedIds([lens.searchFileId], 'search'); // temp search image (safe to clean up)
      if (lens.resultUrl) log(`Lens results page: ${lens.resultUrl}`, 'info');
      if (lens.error) log(`Lens note: ${lens.error}`, 'warn');
    } catch (e) { /* optional */ }
  })());

  if (settings.srcGoogle && isProcessing) jobs.push((async () => {
    try {
      log('Searching Google Images for real review photos...', 'info');
      const gi = await bg({ action: 'google_images', query: ugcQ });
      (gi.items || []).forEach((it) => webItems.push(it));
    } catch (e) { /* optional */ }
  })());

  if (settings.srcPinterest && isProcessing) jobs.push((async () => {
    try {
      log('Searching Pinterest...', 'info');
      const pin = await bg({ action: 'google_images', query: `${productName} ${productData.brand || ''} site:pinterest.com` });
      // Pinterest = user-curated boards -> treat as real UGC.
      (pin.items || []).forEach((it) => { it.ugc = true; webItems.push(it); });
    } catch (e) { /* optional */ }
  })());

  if (settings.srcAmazon && isProcessing) jobs.push((async () => {
    try {
      log('Scraping Amazon customer review images...', 'info');
      const amz = await bg({ action: 'amazon_review_images', asin, domains: marketDomains() });
      amzItems = (amz.images || []).map((u) => ({ full: u, thumb: u, ctx: '', ugc: true }));
      if (amzItems.length) log(`Amazon review photos: ${amzItems.length} (from ${amz.source || 'amazon'})`, 'success');
    } catch (e) { /* optional */ }
  })());

  if (settings.srcBing && isProcessing) jobs.push((async () => {
    try {
      log('Searching Bing Images...', 'info');
      const b = await bg({ action: 'bing_images', query: ugcQ });
      (b.items || []).forEach((it) => webItems.push(it));
    } catch (e) { /* optional */ }
  })());

  if (settings.srcSocial && isProcessing) jobs.push((async () => {
    for (const site of ['reddit.com', 'instagram.com']) {
      if (!isProcessing) break;
      try {
        log(`Searching ${site}...`, 'info');
        const s = await bg({ action: 'google_images', query: `${baseQ} review site:${site}` });
        // Site-scoped social results ARE genuine user posts — flag as real
        // regardless of URL detection (Google's new UI hides the source domain).
        (s.items || []).forEach((it) => { it.ugc = true; webItems.push(it); });
      } catch (e) { /* optional */ }
    }
  })());

  await Promise.all(jobs);

  // Extra search vectors: ASIN + barcode (unique IDs pull the EXACT product).
  // Run these sequentially AFTER the parallel sources, only if we're still thin.
  if (settings.srcGoogle && isProcessing && webItems.length < 18) {
    for (const q of [asin, barcode].filter(Boolean)) {
      if (!isProcessing || webItems.length >= 18) break;
      try {
        log(`Searching by ${q === asin ? 'ASIN' : 'barcode'}: ${q}`, 'info');
        const r = await bg({ action: 'google_images', query: `${q} ${productData.brand || ''}` });
        (r.items || []).forEach((it) => webItems.push(it));
      } catch (e) { /* optional */ }
    }
  }

  // Relevance (UNIVERSAL): keep web items whose context mentions this product's
  // brand/name keywords; drop clear other-product matches.
  const STOP = new Set([
    'the','and','for','with','from','your','this','that','to','in','of','by','at','on',
    'review','reviews','best','price','buy','online','official','store','amazon','flipkart','new',
    'look','product','products','set','combo','kit','value','genuine','authentic','original',
    'premium','natural','organic','pure','advanced','professional','classic','edition','version',
    'multi','all','daily','use','pack','packs','refill','free',
    'gram','grams','litre','liter','litres','liters','inch','inches','meter','metre','count','counts',
    'piece','pieces','pair','pairs','size','sizes','large','small','medium','mini','plus','color','colour',
    'cream','lotion','serum','face','skin','care','hair','body','day','night',
    'moisturizer','moisturiser','milliliters','millilitre','ounce','ounces'
  ]);
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const words = (s) => ((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const brandTokens = words(productData.brand).filter((w) => w.length >= 3 && !STOP.has(w));
  const nameTokens = words(productName).filter((w) => w.length >= 4 && !STOP.has(w));
  const tokens = Array.from(new Set([...brandTokens, ...nameTokens])).slice(0, 12);
  // ASIN / barcode are exact unique IDs — a context containing either is a sure match.
  const idTokens = [norm(asin), norm(barcode)].filter((t) => t && t.length >= 6);

  // Merge: Amazon review photos lead, then web items.
  //  - "matched"  = context names THIS product (brand/name/ASIN/barcode) -> trusted
  //  - "unknown"  = no context at all -> kept only to top up (capped)
  //  - mismatch (context names a DIFFERENT product) -> dropped
  const matched = [];
  const unknown = [];
  const seenFull = new Set();
  let dropped = 0;
  amzItems.forEach((it) => { if (it.full && !seenFull.has(it.full)) { seenFull.add(it.full); matched.push(it); } });
  webItems.forEach((it) => {
    if (!it || !it.full || seenFull.has(it.full)) return;
    seenFull.add(it.full);
    const ctxWords = new Set(words(it.ctx));                     // WHOLE words in the context
    if (!ctxWords.size) { unknown.push(it); return; }            // no context -> can't judge
    const c = norm(it.ctx);
    // ASIN/barcode are long & unique, so a substring hit is safe. Brand/name
    // tokens must match as WHOLE WORDS — otherwise a short token (e.g. a 3-letter
    // brand like "bbr", or "7005") matches random substrings inside CDN-URL
    // hashes and pulls in totally unrelated products (e.g. lotion for springs).
    if (idTokens.some((t) => c.includes(t)) || tokens.some((t) => ctxWords.has(t))) matched.push(it); // confirmed
    else dropped++;                                              // different product
  });
  matched.sort((a, b) => (b.ugc ? 1 : 0) - (a.ugc ? 1 : 0)); // amazon/ugc first
  // Only pad with unknowns if we don't have many confirmed matches.
  const unknownCap = matched.length >= 12 ? 0 : Math.max(6, 12 - matched.length);
  const kept = matched.concat(unknown.slice(0, unknownCap));
  if (dropped) log(`Filtered out ${dropped} other-product image(s)`, 'info');
  if (unknown.length > unknownCap) log(`Hid ${unknown.length - unknownCap} unverified image(s) (use ✕ to remove any wrong ones)`, 'info');

  // Candidates: thumb for display, full for upload. `ugc` marks genuine
  // user-taken photos (Amazon reviews, Instagram/Reddit/TikTok, etc.) vs catalog
  // shots — the picker uses it to badge/sort/filter for a "real customer" vibe.
  // Real user photos first.
  kept.sort((a, b) => (b.ugc ? 1 : 0) - (a.ugc ? 1 : 0));
  const candidates = kept.map((it) => ({ url: it.full, thumb: it.thumb, dataUrl: '', alt: '', ugc: !!it.ugc }));
  // ALWAYS add the product's own images (from dropy) as a guaranteed baseline —
  // marked catalog (ugc:false) — so the picker is never empty even when the web
  // sources return nothing usable or everything gets filtered out.
  const seenUrls = new Set(candidates.map((c) => c.url));
  originals.forEach((u) => { if (u && !seenUrls.has(u)) { seenUrls.add(u); candidates.push({ url: u, thumb: u, dataUrl: '', alt: '', ugc: false }); } });
  (productData.gallery || []).forEach((g) => { if (g && g.url && !seenUrls.has(g.url)) { seenUrls.add(g.url); candidates.push({ url: g.url, thumb: g.data || g.url, dataUrl: g.data, alt: g.alt, ugc: false }); } });
  const ugcCount = candidates.filter((c) => c.ugc).length;
  log(`Candidates ready: ${kept.length} photo(s) — ${ugcCount} real user photo(s) (${matched.length} confirmed this product)`, 'info');

  // Reference image shown large in the picker while choosing.
  const g0 = (productData.gallery && productData.gallery[0]) || {};
  const refImg = g0.data || originals[0] || productData.image || '';        // displays reliably
  const refFull = originals[0] || g0.url || productData.image || refImg;     // full-size on tap

  productData.lensText = lensText; // carried to Phase 2 for the review prompt
  return { productData, candidates, refImg, refFull };
}

// PHASE 2 helper: host the picked images, gather AI Overview context, then
// generate the reviews via Gemini and append them to the combined CSV. Runs
// unattended after all selections are done. job = { item, productData, selected }.
async function generateProduct(job) {
  const { item, productData, selected } = job;
  const isImageMode = job.mode === 'image';
  const asin = item.asin;
  const sku = item.sku;
  const productName = productData.name;
  const bg = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));

  // Step 3: Host the selected images on Shopify Files (original cdn.shopify.com
  // URLs used as-is; the rest re-hosted). Persona stays aligned with each URL.
  let imageUrls = [];
  if (selected && selected.length && isProcessing) {
    // Original Shopify images are already public — used directly. Others are
    // re-hosted on Shopify Files. Persona stays aligned with each final URL.
    const directIdx = [];
    const uploadIdx = [];
    selected.forEach((s, i) => {
      if (s.url && /cdn\.shopify\.com/i.test(s.url) && !s.dataUrl) directIdx.push(i);
      else uploadIdx.push(i);
    });

    let hosted = [];
    let uploadedIds = [];
    if (uploadIdx.length) {
      updateProductStatus('Hosting selected images...', productName);
      log(`Hosting ${uploadIdx.length} image(s) on Shopify...`, 'info');
      const up = await bg({ action: 'upload_images', sku, images: uploadIdx.map((i) => selected[i]) });
      hosted = up.urls || [];
      // Track EVERY file we created on Shopify (incl. any created-but-stranded when
      // its URL wasn't ready) so cleanup can reach them all — never orphan a file.
      uploadedIds = up.createdFileIds || up.fileIds || [];
      if (up.ok) log(`Hosted ${hosted.filter(Boolean).length} image(s)`, 'success');
      else if (up.configured === false) log('Shopify not configured — using source URLs', 'warn');
      else log('Host failed — using source URLs' + (up.error ? ': ' + up.error : ''), 'warn');
      // Images are hosted by handing Shopify the source URL (server-side fetch),
      // so this only trips when Shopify AND the extension both fail to fetch it —
      // usually a hotlink-protected image. Falls back to the source URL.
      if (up.fetchFails) {
        log(`⚠ ${up.fetchFails} image(s) couldn't be hosted (Shopify couldn't fetch them) — used the source URL. These are usually hotlink-protected; pick a different photo if it matters.`, 'warn');
      }
    }
    // Review photos — IN USE by the CSV, so tracked separately from temp images.
    addUploadedIds(uploadedIds, 'review');

    const imageItems = [];
    directIdx.forEach((i) => imageItems.push({ url: selected[i].url, persona: selected[i].persona || 'neutral' }));
    uploadIdx.forEach((i, k) => {
      const u = hosted[k] || selected[i].url;
      if (u) imageItems.push({ url: u, persona: selected[i].persona || 'neutral' });
    });

    imageUrls = imageItems.map((it) => it.url);
    productData.photoItems = imageItems;       // {url, persona} — for CSV gender match
    if (directIdx.length) log(`${directIdx.length} original image(s) used as-is`, 'success');

    // Metadata scraped from the selected images (alt text) — extra context for Gemini.
    const metas = selected.map((s) => (s.alt || '').trim()).filter(Boolean);
    productData.imageMeta = Array.from(new Set(metas)).join('; ').slice(0, 600);
  }
  productData.imageUrls = imageUrls;

  if (!isProcessing) {
    return { asin, sku, name: productName, reviews: 0, images: 0, error: 'stopped' };
  }

  // Step 5: AI Overview (Google Search) + Lens text as extra review context
  updateProductStatus('Getting AI Overview...', productName);
  log('Fetching Google AI Overview...', 'info');
  let aiOverview = '';
  try {
    const ov = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'ai_overview', query: `${productName} ${productData.brand || ''} review` },
        (response) => resolve(response || {})
      );
    });
    aiOverview = ov.text || '';
  } catch (e) { /* optional */ }
  productData.aiOverview = aiOverview;
  productData.webReference = [aiOverview, productData.lensText || ''].filter(Boolean).join('\n---\n').slice(0, 3000);
  log(aiOverview ? 'AI Overview collected' : 'No AI Overview (using Lens text)', aiOverview ? 'success' : 'warn');

  // Step 6: Open Gemini (or reuse)
  if (!geminiTabId) {
    updateProductStatus('Opening Gemini...', productName);
    log('Opening Gemini tab...', 'info');
    
    const geminiResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'open_gemini' }, resolve);
    });
    geminiTabId = geminiResult && geminiResult.tabId;
    if (!geminiTabId) {
      throw new Error('Could not open Gemini tab');
    }
    await sleep(3000); // Wait for Gemini to load
    log('Gemini ready', 'success');
  } else {
    // New chat for new product
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'new_gemini_chat', tabId: geminiTabId }, resolve);
    });
    await sleep(2000);
  }

  // Step 4: Generate reviews in batches (count + batch size from Settings).
  // IMAGE mode: exactly one review per hosted photo, every review carries a
  // photo. TEXT mode: a random count between the configured min/max, no photos.
  const rMin = settings.min || 25, rMax = settings.max || 100;
  let totalReviews;
  if (isImageMode) {
    totalReviews = (productData.photoItems || []).length;
    if (!totalReviews) {
      log('No photos picked for this product — skipped in image mode (nothing to add to the images CSV)', 'warn');
      return { asin, sku, name: productName, reviews: 0, images: 0, error: 'no images picked (skipped)' };
    }
  } else {
    totalReviews = Math.floor(Math.random() * (Math.max(rMin, rMax) - rMin + 1)) + rMin;
  }
  const batchSize = settings.batch || 10;
  const totalBatches = Math.ceil(totalReviews / batchSize);
  let allReviews = [];
  const seenKeys = new Set();  // dedupe review bodies across all batches
  const seenNames = new Set(); // avoid repeating reviewer names across batches
  // One "photo review" per selected image — its gender follows the image persona.
  const personaToGender = (p) => (p === 'female' || p === 'male' || p === 'kids') ? p : 'neutral';
  const photoQueue = (productData.photoItems || []).map((it) => personaToGender(it.persona));

  updateProductStatus(`Generating ${totalReviews} reviews...`, productName);
  log(`Target: ${totalReviews} reviews in ${totalBatches} batches${photoQueue.length ? `, ${photoQueue.length} with a photo` : ''}`, 'info');

  for (let batch = 0; batch < totalBatches; batch++) {
    await waitWhilePaused();
    if (!isProcessing) break;

    const remaining = totalReviews - allReviews.length;
    const currentBatchSize = Math.min(batchSize, remaining);
    const photoGenders = photoQueue.splice(0, Math.min(currentBatchSize, photoQueue.length));

    updateBatchProgress(batch, totalBatches);
    log(`Batch ${batch + 1}/${totalBatches} (${currentBatchSize} reviews${photoGenders.length ? `, ${photoGenders.length} w/ photo` : ''})...`, 'info');

    // Build and send prompt (feed already-used names so Gemini picks fresh ones)
    const prompt = buildPrompt(productData, batch, totalBatches, currentBatchSize, Array.from(seenNames), photoGenders);
    
    let retries = 0;
    let batchReviews = null;

    while (retries < 3 && !batchReviews) {
      try {
        const geminiResponse = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'send_to_gemini',
            tabId: geminiTabId,
            prompt: prompt
          }, (response) => {
            if (response?.error) reject(new Error(response.error));
            else resolve(response);
          });
        });

        batchReviews = parseGeminiResponse(geminiResponse.response);
        
        if (!batchReviews || batchReviews.length === 0) {
          throw new Error('Empty response');
        }
      } catch (e) {
        retries++;
        log(`Batch ${batch + 1} attempt ${retries} failed: ${e.message}`, 'warn');
        if (retries < 3) {
          const msg = (e.message || '').toLowerCase();
          const tabBroken = msg.includes('no response') || msg.includes('connection') ||
                            msg.includes('port closed') || msg.includes('no tab') ||
                            msg.includes('timeout');
          if (tabBroken) {
            // Self-heal: the Gemini tab is unresponsive/closed — reopen it fresh.
            log('Gemini unresponsive — reopening tab (self-heal)...', 'warn');
            await recoverGemini();
          } else {
            // Just a bad/empty response — start a clean chat and retry.
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({ action: 'new_gemini_chat', tabId: geminiTabId }, resolve);
            });
            await sleep(2000);
          }
        }
      }
    }

    // If the batch failed entirely, repair Gemini before the next batch so one
    // bad batch doesn't cascade into all the rest failing. Re-queue its photo
    // slots so we don't lose photo reviews for the selected images.
    if (!batchReviews || batchReviews.length === 0) {
      if (photoGenders.length) photoQueue.unshift(...photoGenders);
      await recoverGemini();
    }

    if (batchReviews && batchReviews.length > 0) {
      // Drop reviews that duplicate a body, a reviewer name, or a title already
      // collected for this product — keeps the set genuinely unique.
      const uniqueReviews = batchReviews.filter(r => {
        const bodyKey = (r.review_body || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
        const nameKey = (r.reviewer_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const titleKey = (r.review_title || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!bodyKey || seenKeys.has(bodyKey) || (nameKey && seenNames.has(nameKey)) || (titleKey && seenKeys.has('t:' + titleKey))) {
          return false;
        }
        seenKeys.add(bodyKey);
        if (titleKey) seenKeys.add('t:' + titleKey);
        if (nameKey) seenNames.add(nameKey);
        return true;
      });
      const dupes = batchReviews.length - uniqueReviews.length;
      allReviews = allReviews.concat(uniqueReviews);
      log(`Batch ${batch + 1} done: ${uniqueReviews.length} reviews${dupes ? ` (${dupes} duplicates dropped)` : ''} (total: ${allReviews.length})`, 'success');
    } else {
      log(`Batch ${batch + 1} failed after 3 retries, skipping`, 'error');
      log('Tip: make sure you are logged into Gemini in the opened tab (gemini.google.com).', 'warn');
    }

    // Cooldown between batches
    if (batch < totalBatches - 1) {
      const cooldown = 500 + Math.random() * 1000;
      await sleep(cooldown);

      // New chat every 3 batches to avoid context issues
      if ((batch + 1) % 3 === 0) {
        log('Refreshing Gemini chat...', 'info');
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'new_gemini_chat', tabId: geminiTabId }, resolve);
        });
        await sleep(2000);
      }
    }
  }

  // Step 5: Add this product's reviews to the combined CSV (written once, at the
  // end of the run, as a single file for the whole batch).
  if (allReviews.length > 0) {
    updateProductStatus('Adding reviews to combined CSV...', productName);
    // SKU is deterministic from the input ASIN — always filled. Pass image items
    // ({url, persona}) so each photo lands on a same-gender review.
    const rows = buildCsvRows(allReviews, productData, productData.photoItems || []);
    // SET (replace) this ASIN's slice — so a rerun of this ASIN overwrites just its
    // own rows and never duplicates or drops the other ASINs already in the file.
    setCsvProduct(asin, rows, (productData.imageUrls || []).length);
    log(`✅ ${allReviews.length} reviews saved for this product (file total: ${csvRowCount()})`, 'success');
  } else {
    log('No reviews generated for this product', 'error');
  }

  return {
    asin, sku, name: productName,
    reviews: allReviews.length,
    images: (productData.imageUrls || []).length,
    error: allReviews.length === 0 ? 'No reviews generated' : null
  };
}

// ============================================================
// GEMINI RESPONSE PARSER
// ============================================================

// Escapes raw control characters (newline, tab, CR) that occur INSIDE JSON
// string literals, while leaving structural whitespace between tokens intact.
// Other illegal control chars inside strings are dropped.
function escapeControlCharsInStrings(str) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      out += ch;       // previous char was a backslash; pass this through verbatim
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch.charCodeAt(0) < 0x20) { /* drop other control chars */ }
      else out += ch;
    } else {
      out += ch; // structural whitespace/tokens — leave untouched
    }
  }

  return out;
}

// Detects characters from non-Latin scripts (Devanagari, Gujarati, Telugu,
// Tamil, Bengali, Kannada, Malayalam, Arabic, CJK, etc.). Reviews must be fully
// romanized; if native script slips in, stripping it would leave holes in the
// sentence, so we reject the whole review instead.
const NONLATIN_RE = /[؀-ۿ܀-ݏऀ-෿฀-๿぀-ヿ一-鿿가-힯]/;

// Emoji + variation selectors + ZWJ + regional indicators + skin tones.
const EMOJI_PATTERN = '[\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\uFE0F\\u200D]';
const EMOJI_RE_G = new RegExp(EMOJI_PATTERN, 'gu');
const EMOJI_RE_T = new RegExp(EMOJI_PATTERN, 'u');

function containsEmoji(text) { return EMOJI_RE_T.test(text || ''); }
function stripEmojis(text) {
  return String(text || '').replace(EMOJI_RE_G, '').replace(/\s{2,}/g, ' ').trim();
}
function capEmojis(text, max) {
  let n = 0;
  return String(text || '')
    .replace(EMOJI_RE_G, (m) => {
      // Variation selectors / ZWJ / skin-tone modifiers attach to the previous
      // emoji — don't count them, just keep them if the base was kept.
      const isModifier = /[️‍]/.test(m) || /[\u{1F3FB}-\u{1F3FF}]/u.test(m);
      if (isModifier) return n <= max ? m : '';
      n++;
      return n <= max ? m : '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Normalizes typography that makes reviews look pasted/AI or breaks importers:
// fixes UTF-8 mojibake (â€™), converts smart quotes/dashes to plain ASCII, and
// removes zero-width / BOM characters. (ZWJ ‍ is left for emoji handling.)
function cleanText(text) {
  if (!text) return '';
  let s = String(text);
  s = s
    .replace(/â€™/g, "'").replace(/â€˜/g, "'")
    .replace(/â€œ/g, '"').replace(/â€/g, '"')
    .replace(/â€"/g, '-').replace(/â€"/g, '-')
    .replace(/ /g, ' ');
  s = s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...');
  s = s.replace(/[​‌﻿]/g, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

// Detects any mention of price/money, which rule 7 forbids.
const PRICE_RE = /(₹|\$\s?\d|\brs\.?\s*\d|\brupees?\b|\bmrp\b|\bprice\b|\bcost\b|\bdiscount\b|\boffer\b|\bdeal\b|\bcheap\b|\bexpensive\b|\bworth the money\b)/i;

// Reviews are displayed on the Dropy store, so any mention of the source
// marketplace (Amazon etc.) must be rejected.
const PLATFORM_RE = /\b(amazon|flipkart|myntra|nykaa|meesho|snapdeal|ajio|amzn)\b/i;

// Cleans and validates each review:
//  - coerces numeric fields to real numbers
//  - drops reviews containing native (non-Roman) script
//  - drops reviews that mention price/money (enforced in code, not just prompt)
//  - drops reviews missing a name, body, or title
function normalizeReviews(arr) {
  let emojiBudget = 1; // allow at most ONE emoji-bearing review per batch (~1 in 10-15)

  return arr
    .filter(r => r && r.reviewer_name && r.review_body)
    .map(r => {
      // Clean typography first (mojibake, smart quotes, zero-width).
      let title = cleanText(r.review_title);
      let body = cleanText(r.review_body);
      const name = cleanText(r.reviewer_name);

      // Titles never carry emojis. Bodies: keep 1-2 emojis on at most one
      // review per batch, strip from the rest.
      title = stripEmojis(title);
      if (containsEmoji(body) && emojiBudget > 0) {
        body = capEmojis(body, 2);
        emojiBudget--;
      } else {
        body = stripEmojis(body);
      }

      return {
        ...r,
        review_title: title,
        review_body: body,
        reviewer_name: name,
        star_rating: Number(r.star_rating) || 5,
        helpful_votes: Number(r.helpful_votes) || 0,
        has_photo: r.has_photo === true || r.has_photo === 'true',
        reviewer_gender: String(r.reviewer_gender || '').toLowerCase().trim()
      };
    })
    .filter(r => {
      const blob = `${r.review_title} ${r.review_body} ${r.reviewer_name}`;
      return (
        r.review_title &&
        r.review_body &&
        r.reviewer_name &&
        !NONLATIN_RE.test(blob) &&
        !PRICE_RE.test(r.review_body) &&
        !PRICE_RE.test(r.review_title) &&
        !PLATFORM_RE.test(blob)
      );
    });
}

function parseGeminiResponse(rawText) {
  if (!rawText) return null;

  // Try to extract JSON from the response
  let jsonStr = rawText;

  // Remove markdown code blocks
  jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  
  // Find JSON array
  const startIdx = jsonStr.indexOf('[');
  const endIdx = jsonStr.lastIndexOf(']');
  
  if (startIdx === -1 || endIdx === -1) return null;
  
  jsonStr = jsonStr.substring(startIdx, endIdx + 1);

  // Clean up common issues
  jsonStr = jsonStr
    .replace(/,\s*]/g, ']')  // trailing commas
    .replace(/,\s*}/g, '}'); // trailing commas in objects

  // Escape control chars (newlines/tabs) ONLY when they appear inside a
  // string literal. Structural whitespace between tokens must be left as-is,
  // otherwise pretty-printed JSON gets corrupted (e.g. "[\n {" -> "[\\n {").
  jsonStr = escapeControlCharsInStrings(jsonStr);

  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return normalizeReviews(parsed);
    }
  } catch (e) {
    // Try fixing common JSON issues
    try {
      // Sometimes Gemini adds trailing text
      const fixedJson = jsonStr.replace(/\}[^}\]]*$/, '}]');
      const parsed = JSON.parse(fixedJson);
      if (Array.isArray(parsed)) {
        return normalizeReviews(parsed);
      }
    } catch (e2) {
      console.error('JSON parse failed:', e2.message);
    }
  }
  
  return null;
}

// ============================================================
// CSV GENERATOR
// ============================================================

// RFC-4180 CSV escaping: wrap a field in quotes if it has a comma, quote, or
// newline, and double any internal quotes.
function csvField(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Review-import column format:
// title,body,rating,review_date,reviewer_name,product_sku,picture_urls
// Judge.me import format. Product is matched by product_id (strongest), then
// product_handle / product_url. reviewer_email is generated from the name.
const CSV_HEADERS = ['title', 'body', 'rating', 'review_date', 'reviewer_name', 'reviewer_email', 'product_url', 'picture_urls', 'product_id', 'product_handle'];

// Synthesizes a stable reviewer email from the name (e.g. "Kelly M" -> kelly.m@...
// style, but Judge.me wants a plain address): <namesquashed>@customer.review.
function reviewerEmail(name) {
  const local = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return (local || 'reviewer') + '@customer.review';
}

// Builds the CSV DATA rows (no header) for ONE product's reviews. Image-to-review
// matching is per-product, so this runs once per product and the rows are
// concatenated into a single combined file for the whole run.
function buildCsvRows(reviews, product, imageItems) {
  // `product` carries the Judge.me match keys from the dropy/Shopify lookup.
  // (A bare string is tolerated as a legacy handle for older callers/tests.)
  const p = (product && typeof product === 'object') ? product : { productHandle: product };
  const handle = p.productHandle || p.handle || '';
  const productId = p.productId || p.product_id || '';
  const productUrl = p.storeProductUrl || p.productUrl || p.product_url || '';
  // Attach each photo to a has_photo review whose GENDER matches the image's
  // persona (female photo -> female reviewer, etc.) so picture and reviewer
  // stay consistent. 'neutral'/'kids' accept any reviewer.
  const picByIndex = {};
  const imgs = (imageItems || []).map((x) => (typeof x === 'string' ? { url: x, persona: 'neutral' } : x));
  if (imgs.length && reviews.length) {
    const photoIdx = reviews.map((_, i) => i).filter((i) => reviews[i].has_photo);
    const used = new Set();
    const genderOf = (i) => (reviews[i].reviewer_gender || '').toLowerCase();
    const takeMatch = (persona) => {
      let idx = photoIdx.find((i) => !used.has(i) && (persona === 'neutral' || persona === 'kids' || genderOf(i) === persona));
      if (idx === undefined) idx = photoIdx.find((i) => !used.has(i)); // any remaining photo review
      if (idx === undefined) idx = reviews.map((_, i) => i).find((i) => !used.has(i) && !picByIndex[i]); // any review
      if (idx !== undefined) used.add(idx);
      return idx;
    };
    imgs.forEach((it) => {
      const idx = takeMatch((it.persona || 'neutral').toLowerCase());
      if (idx !== undefined) picByIndex[idx] = it.url;
    });
  }

  return reviews.map((r, i) => [
    csvField(r.review_title || ''),
    csvField(r.review_body || ''),
    csvField(r.star_rating || 5),
    csvField(formatReviewDate(r.date)),
    csvField(r.reviewer_name || ''),
    csvField(reviewerEmail(r.reviewer_name)),
    csvField(productUrl),
    csvField(picByIndex[i] || ''),
    csvField(productId),
    csvField(handle)
  ].join(','));
}

// Writes ONE CSV file containing all rows accumulated across the run.
// Resolves TRUE only if the file was actually written (save_file OK, or the Blob
// fallback completed) — so callers never mark `written` when the write failed.
function writeCombinedCsv(rows, fileName) {
  const csv = [CSV_HEADERS.join(',')].concat(rows).join('\r\n');
  return new Promise((resolve) => {
    // Save silently via chrome.downloads (saveAs:false) — no "Save As" prompt.
    // UTF-8 data URL keeps any emojis intact. Falls back to a Blob download.
    try {
      const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      // overwrite (not uniquify) so resuming a batch keeps ONE file, not copies.
      chrome.runtime.sendMessage({ action: 'save_file', filename: fileName, dataUrl, conflictAction: 'overwrite' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          resolve({ ok: downloadCsvFallback(csv, fileName), downloadId: null });
        } else {
          resolve({ ok: true, downloadId: (resp.downloadId != null ? resp.downloadId : null) });
        }
      });
    } catch (e) {
      resolve({ ok: downloadCsvFallback(csv, fileName), downloadId: null });
    }
  });
}

// Crash-proofing: (over)write the batch's CSV to disk RIGHT NOW, as each product
// finishes — not just at run end. So if an unattended run loses power (or the tab
// closes) mid-batch, a complete file with everything done-so-far is already on
// disk, no resume run needed. Uses the same overwrite+stable-name so it stays ONE
// file. `written` is set true ONLY after the write is confirmed, so storage never
// claims "on disk" when it isn't (else the run-end net wrongly skips the rewrite).
async function flushCsvToDisk() {
  return writeCsvNow(); // writes the union of all ASINs' rows; sets `written` on success
}

// Throttled crash-proof write: keeps the on-disk file fresh WITHOUT one download
// entry per product. Writes on the first product, then at most every N products or
// every ~30s. The run-end safety net still writes if the last product was
// throttled (so the final file is always complete). Resolves true if it wrote.
// On a failed write the throttle isn't advanced, so the next product retries.
const CSV_FLUSH_EVERY = 5;
const CSV_FLUSH_MS = 30000;
let csvSinceFlush = 0;
let csvLastFlushAt = 0;
async function maybeFlushCsvToDisk(force) {
  csvSinceFlush++;
  const now = Date.now();
  if (force || csvSinceFlush >= CSV_FLUSH_EVERY || (now - csvLastFlushAt) >= CSV_FLUSH_MS) {
    const ok = await flushCsvToDisk();
    if (ok) { csvSinceFlush = 0; csvLastFlushAt = now; }
    return ok;
  }
  return false;
}

// Returns true if the fallback download completed without throwing.
function downloadCsvFallback(csv, fileName) {
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch (e) { return false; }
}

// Converts a "YYYY-MM-DD" date into the importer's "YYYY-MM-DD 00:00:00 UTC"
// format. If the date is missing/unparseable, falls back to a random date
// within the last year so the review_date column is never blank.
function formatReviewDate(d) {
  const m = d && String(d).match(/\d{4}-\d{2}-\d{2}/);
  if (m) return `${m[0]} 00:00:00 UTC`;
  const past = Date.now() - Math.floor(Math.random() * 365) * 86400000;
  return `${new Date(past).toISOString().slice(0, 10)} 00:00:00 UTC`;
}

// ============================================================
// UI UPDATES
// ============================================================

function updateOverallProgress(current, total) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  document.getElementById('overallProgress').style.width = pct + '%';
  document.getElementById('overallText').textContent = `Product ${current} / ${total}`;
}

function updateBatchProgress(current, total) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  document.getElementById('batchProgress').style.width = pct + '%';
  document.getElementById('batchText').textContent = `Batch ${current + 1} / ${total}`;
}

function updateProductStatus(status, name) {
  document.getElementById('currentProductStatus').textContent = status;
  if (name) document.getElementById('currentProductName').textContent = name;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function classifyResult(r) {
  if (r.alreadyDone) return 'done';
  if ((r.reviews || 0) > 0) return 'done';
  const e = (r.error || '').toLowerCase();
  if (e.includes('not found') || e.includes('dropy') || e.includes('stopped') || e.includes('blocked')
      || e.includes('no images') || e.includes('skipped')) return 'skipped';
  return 'error';
}

function showResults(results) {
  showStep('step-complete');

  // Loudly flag any product that generated reviews but whose dropy match couldn't
  // be ASIN-verified — easy to miss in an unattended text run's log.
  const unverified = results.filter(r => r.unverified && (r.reviews || 0) > 0);
  if (unverified.length) {
    log(`⚠ ${unverified.length} product(s) generated reviews but couldn't be ASIN-verified — double-check: ${unverified.map(r => r.asin).join(', ')}. Turn on Settings → "Skip unconfirmed matches" to auto-skip these next time.`, 'warn');
  }

  const doneCount = results.filter(r => (r.reviews || 0) > 0 || r.alreadyDone).length;
  const totalReviews = results.reduce((s, r) => s + (r.reviews || 0), 0);
  const totalImages = results.reduce((s, r) => s + (r.images || 0), 0);
  const issues = results.length - doneCount;
  const elapsed = fmtTime(Date.now() - stats.startTime);

  // Summary metric cards. Text runs never attach photos, so skip the Images card
  // (a permanent 0 there is just noise) unless the run actually produced some.
  const showImages = runMode === 'image' || totalImages > 0;
  document.getElementById('summaryGrid').innerHTML = `
    <div class="metric"><div class="metric-value good">${doneCount}/${results.length}</div><div class="metric-label">Products</div></div>
    <div class="metric"><div class="metric-value">${totalReviews}</div><div class="metric-label">Reviews</div></div>
    ${showImages ? `<div class="metric"><div class="metric-value">${totalImages}</div><div class="metric-label">Images</div></div>` : ''}
    <div class="metric"><div class="metric-value ${issues ? 'warn' : 'good'}">${issues}</div><div class="metric-label">Issues</div></div>
  `;

  document.getElementById('resultsCount').textContent = `${results.length} products · ${elapsed}`;

  const labels = { done: '✅ Done', skipped: '⏭ Skipped', error: '⚠️ Error' };
  const container = document.getElementById('results');
  container.innerHTML = results.map(r => {
    const cls = classifyResult(r);
    const detail = r.alreadyDone
      ? 'already done (skipped)'
      : (cls === 'done'
        ? `${r.reviews} reviews${r.images ? ` · ${r.images} image${r.images > 1 ? 's' : ''}` : ''}`
        : escapeHtml(r.error || 'no reviews'));
    return `
      <div class="result-card">
        <div>
          <div class="result-name">${escapeHtml(r.name || r.asin)}</div>
          <div class="result-count">${escapeHtml(r.asin)} · ${detail}</div>
        </div>
        <span class="result-status ${cls}">${labels[cls]}</span>
      </div>`;
  }).join('');

  // Offer to delete THIS run's review photos (only useful if you're not importing it).
  if (runReviewIds.length) {
    clearImagesBtn.classList.remove('hidden');
    clearImagesBtn.textContent = `🗑 Delete this run's ${runReviewIds.length} review photo(s) (⚠ only if not imported)`;
  } else {
    clearImagesBtn.classList.add('hidden');
  }

  // After a text run, offer a one-click image pass on the same list (image
  // progress is separate, so it won't be skipped as "already done").
  if (lastMode === 'text' && products.length) {
    addImagesBtn.classList.remove('hidden');
  } else {
    addImagesBtn.classList.add('hidden');
  }

  // Retry: only products that produced no reviews and weren't already done
  lastFailed = results.filter(r => (r.reviews || 0) === 0 && !r.alreadyDone).map(r => ({ asin: r.asin, sku: r.sku }));
  if (lastFailed.length) {
    retryBtn.classList.remove('hidden');
    retryBtn.textContent = `↻ Retry ${lastFailed.length} failed`;
  } else {
    retryBtn.classList.add('hidden');
  }

  // Charts + save to history
  renderCharts(results);
  saveHistory({
    date: new Date().toLocaleString('en-IN'),
    total: results.length, done: doneCount, reviews: totalReviews, images: totalImages, issues, elapsed
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// DASHBOARD: tabs, settings, per-ASIN table, history, charts
// ============================================================
const SETTINGS_DEFAULTS = { min: 25, max: 100, batch: 10, srcLens: true, srcGoogle: true, srcPinterest: true, srcAmazon: true, srcBing: true, srcSocial: true, market: 'in,com', strictMatch: false };
let settings = Object.assign({}, SETTINGS_DEFAULTS);

function loadSettings() {
  try {
    chrome.storage.local.get(['settings'], (r) => {
      settings = Object.assign({}, SETTINGS_DEFAULTS, (r && r.settings) || {});
      applySettingsToForm();
    });
  } catch (e) { /* storage unavailable */ }
}
function applySettingsToForm() {
  const set = (id, v) => { const el = document.getElementById(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
  set('setMin', settings.min); set('setMax', settings.max); set('setBatch', settings.batch);
  set('srcLens', settings.srcLens); set('srcGoogle', settings.srcGoogle); set('srcPinterest', settings.srcPinterest); set('srcAmazon', settings.srcAmazon);
  set('srcBing', settings.srcBing); set('srcSocial', settings.srcSocial);
  set('setMarket', settings.market);
  set('strictMatch', settings.strictMatch);
}
function saveSettings() {
  const num = (id, d, lo, hi) => { let v = parseInt((document.getElementById(id) || {}).value, 10); if (isNaN(v)) v = d; return Math.max(lo, Math.min(hi, v)); };
  const chk = (id) => !!(document.getElementById(id) || {}).checked;
  settings = {
    min: num('setMin', 25, 1, 500), max: num('setMax', 100, 1, 500), batch: num('setBatch', 10, 1, 20),
    srcLens: chk('srcLens'), srcGoogle: chk('srcGoogle'), srcPinterest: chk('srcPinterest'), srcAmazon: chk('srcAmazon'),
    srcBing: chk('srcBing'), srcSocial: chk('srcSocial'),
    market: (document.getElementById('setMarket') || {}).value || 'in,com',
    strictMatch: chk('strictMatch')
  };
  if (settings.min > settings.max) { const t = settings.min; settings.min = settings.max; settings.max = t; }
  try { chrome.storage.local.set({ settings }); } catch (e) {}
  applySettingsToForm();
  const s = document.getElementById('settingsSaved'); if (s) { s.textContent = 'Saved ✓'; setTimeout(() => { s.textContent = ''; }, 2000); }
}
function marketDomains() {
  return (settings.market || 'in,com').split(',').map((x) => (x === 'in' ? 'www.amazon.in' : 'www.amazon.com'));
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const panel = document.getElementById(b.dataset.tab);
      if (panel) { panel.classList.remove('hidden'); panel.classList.add('active'); }
      if (b.dataset.tab === 'tab-history') renderHistory();
      if (b.dataset.tab === 'tab-settings') updateUploadedUi();
    });
  });
}

// --- Per-ASIN status table ---
function buildAsinTable(items) {
  const t = document.getElementById('asinTable');
  if (!t) return;
  t.innerHTML = items.map((it, i) => `
    <div class="asin-row" id="arow-${i}">
      <div><div class="a-name" id="aname-${i}">${escapeHtml(it.asin)}</div><div class="a-sub" id="asub-${i}">${escapeHtml(it.sku)}</div></div>
      <div class="a-counts" id="acount-${i}"></div>
      <span class="a-badge queued" id="abadge-${i}">queued</span>
    </div>`).join('');
}
function updateAsinRow(i, status, name, counts) {
  const badge = document.getElementById('abadge-' + i);
  if (badge) { badge.className = 'a-badge ' + status; badge.textContent = status; }
  if (name) { const n = document.getElementById('aname-' + i); if (n) n.textContent = name; }
  if (counts != null) { const c = document.getElementById('acount-' + i); if (c) c.textContent = counts; }
}

// --- History (chrome.storage.local) ---
function saveHistory(entry) {
  try {
    chrome.storage.local.get(['history'], (r) => {
      const h = (r && r.history) || [];
      h.unshift(entry);
      chrome.storage.local.set({ history: h.slice(0, 50) });
    });
  } catch (e) {}
}
function renderHistory() {
  const el = document.getElementById('historyList');
  if (!el) return;
  try {
    chrome.storage.local.get(['history'], (r) => {
      const h = (r && r.history) || [];
      if (!h.length) { el.innerHTML = '<div class="history-empty">No runs yet.</div>'; return; }
      el.innerHTML = h.map((e) => `
        <div class="history-card">
          <div class="h-date">${escapeHtml(e.date)}</div>
          <div class="h-stats">${e.done}/${e.total} products · ${e.reviews} reviews · ${e.images} images · ${e.issues} issues${e.elapsed ? ' · ' + escapeHtml(e.elapsed) : ''}</div>
        </div>`).join('');
    });
  } catch (e) {}
}

// --- Charts (CSS bars) on the results screen ---
function renderCharts(results) {
  const el = document.getElementById('charts');
  if (!el) return;
  const done = results.filter((r) => (r.reviews || 0) > 0);
  const bar = (label, val, max) => `<div class="bar-row"><span class="bar-label">${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((val / max) * 100)}%"></div></div><span class="bar-val">${val}</span></div>`;
  let html = '';
  const top = done.slice().sort((a, b) => (b.reviews || 0) - (a.reviews || 0)).slice(0, 8);
  if (top.length) {
    const maxR = Math.max(1, ...top.map((r) => r.reviews || 0));
    html += `<div class="chart-block"><h4>Reviews per product (top ${top.length})</h4>${top.map((r) => bar(r.name || r.asin, r.reviews || 0, maxR)).join('')}</div>`;
  }
  // Count outcomes exactly as the result cards classify them (so already-done
  // products count as Done, not Error).
  const doneN = results.filter((r) => classifyResult(r) === 'done').length;
  const skippedN = results.filter((r) => classifyResult(r) === 'skipped').length;
  const errorN = results.filter((r) => classifyResult(r) === 'error').length;
  const maxS = Math.max(1, doneN, skippedN, errorN);
  html += `<div class="chart-block"><h4>Outcome</h4>${bar('Done', doneN, maxS)}${bar('Skipped', skippedN, maxS)}${bar('Error', errorN, maxS)}</div>`;
  el.innerHTML = html;
}

// --- Product reference image shown in the picker ---
function setProductRef(url, name, fullUrl) {
  const el = document.getElementById('productRef');
  if (!el) return;
  if (!url) { el.innerHTML = ''; return; }
  const open = fullUrl || url;
  el.innerHTML =
    `<div class="ref-label">Actual product (from dropy) — tap to enlarge</div>` +
    `<a href="${open}" target="_blank" rel="noopener"><img src="${url}"></a>` +
    `<div class="ref-text"><b>${escapeHtml((name || '').slice(0, 120))}</b></div>`;
}

// --- Uploaded Shopify images: tracked all-time by TYPE so cleanup can't nuke
// live review photos. `search` = temporary Lens search images (safe to delete);
// `review` = photos used in the CSV (deleting breaks imported reviews). ---
function normalizeUploads(r) {
  const store = (r && r.uploadedImages) || {};
  store.search = store.search || [];
  store.review = store.review || [];
  // Migrate the OLD flat key: unknown type -> treat as review (in-use, don't auto-delete).
  const oldFlat = (r && r.uploadedFileIds) || [];
  if (oldFlat.length) store.review = Array.from(new Set(store.review.concat(oldFlat)));
  return store;
}
function getUploads() {
  return new Promise((resolve) => {
    try { chrome.storage.local.get(['uploadedImages', 'uploadedFileIds'], (r) => resolve(normalizeUploads(r))); }
    catch (e) { resolve({ search: [], review: [] }); }
  });
}
function setUploads(store) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set({ uploadedImages: { search: store.search || [], review: store.review || [] }, uploadedFileIds: [] }, resolve); }
    catch (e) { resolve(); }
  });
}
function deleteShopifyImages(ids) {
  return new Promise((r) => chrome.runtime.sendMessage({ action: 'delete_shopify_files', fileIds: ids }, (x) => r(x || {})));
}
async function removeFromStore(kind, ids) {
  const store = await getUploads();
  const gone = new Set(ids);
  store[kind] = (store[kind] || []).filter((x) => !gone.has(x));
  await setUploads(store);
  updateUploadedUi();
}
async function addUploadedIds(ids, kind) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return;
  const key = kind === 'search' ? 'search' : 'review';
  (key === 'search' ? runSearchIds : runReviewIds).push(...ids);
  const store = await getUploads();
  store[key] = Array.from(new Set(store[key].concat(ids)));
  await setUploads(store);
  updateUploadedUi();
}
function updateUploadedUi() {
  const el = document.getElementById('uploadedInfo');
  if (!el) return;
  getUploads().then((store) => {
    const extra = store.search.length ? ` (+${store.search.length} temp not yet cleaned)` : '';
    el.textContent = store.review.length
      ? `${store.review.length} review photo(s) hosted on Shopify (all runs).${extra}`
      : 'No review photos uploaded yet.' + extra;
  });
}
// Automatically delete temporary Lens search images — they're disposable (used
// only to run the Lens search) and never referenced by the CSV. Called at the
// end of every run; also mops up any left by a prior interrupted run. Silent.
async function autoCleanSearchImages() {
  const store = await getUploads();
  if (!store.search.length) return;
  const res = await deleteShopifyImages(store.search);
  if (res && res.ok) {
    await setUploads(Object.assign(store, { search: [] }));
    if (res.deleted) log(`Cleaned up ${res.deleted} temporary Lens search image(s)`, 'info');
  }
  runSearchIds = [];
  updateUploadedUi();
}
// Dangerous: deletes the review photos used in your CSV — breaks imported reviews.
async function deleteReviewImages() {
  const store = await getUploads();
  if (!store.review.length) { alert('No review photos are tracked.'); return; }
  if (!confirm(`⚠ Delete all ${store.review.length} REVIEW photo(s) from Shopify Files?\n\nThis BREAKS the images in any reviews you already imported (their URLs will 404). Only do this for runs you did NOT import. Cannot be undone.`)) return;
  const btn = document.getElementById('deleteReviewBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }
  const res = await deleteShopifyImages(store.review);
  await setUploads(Object.assign(store, { review: [] }));
  runReviewIds = [];
  updateUploadedUi();
  if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete ALL review photos (⚠ breaks imported reviews)'; }
  alert(`Deleted ${res.deleted || 0} review photo(s).`);
}

// Storage keys are namespaced by run mode so the text run and image run keep
// SEPARATE progress + batches (text uses the original keys for back-compat).
function doneStoreKey() { return runMode === 'image' ? 'doneAsinsImage' : 'doneAsins'; }
function csvStoreKey() { return runMode === 'image' ? 'csvBatchImage' : 'csvBatch'; }

// --- Progress: completed ASINs persisted across runs (resume, don't restart) ---
function loadProgress() {
  try {
    chrome.storage.local.get(['doneAsins', 'doneAsinsImage'], (r) => {
      doneAsinsText = new Set((r && r.doneAsins) || []);
      doneAsinsImage = new Set((r && r.doneAsinsImage) || []);
      doneAsins = runMode === 'image' ? doneAsinsImage : doneAsinsText;
      updateProgressUi();
    });
  } catch (e) {}
}
function saveProgress() {
  try { chrome.storage.local.set({ [doneStoreKey()]: Array.from(doneAsins) }); } catch (e) {}
}
function markDone(asin) {
  if (asin && !doneAsins.has(asin)) { doneAsins.add(asin); saveProgress(); updateProgressUi(); }
}
function resetProgress() {
  // Forget progress for BOTH modes and drop both batch files.
  doneAsinsText = new Set();
  doneAsinsImage = new Set();
  doneAsins = runMode === 'image' ? doneAsinsImage : doneAsinsText;
  try { chrome.storage.local.set({ doneAsins: [], doneAsinsImage: [] }); } catch (e) {}
  csvBatch = null;
  try { chrome.storage.local.remove(['csvBatch', 'csvBatchImage']); } catch (e) {}
  updateProgressUi();
}

// --- Per-ASIN row storage: the batch keeps each ASIN's rows SEPARATELY so a
// rerun of one ASIN replaces only its own rows (never duplicates, never drops the
// others), and every write is the UNION of all completed ASINs. This is what makes
// re-running a failed/finished ASIN safe and non-destructive. ---
function migrateBatch(b) {
  if (!b) return;
  if (!b.rowsByAsin) b.rowsByAsin = {};
  if (!b.imgByAsin) b.imgByAsin = {};
  // Legacy flat `rows` array (older batches) -> keep them under a reserved key so
  // nothing already generated is ever lost on upgrade.
  if (Array.isArray(b.rows) && b.rows.length && !b.rowsByAsin.__prior) b.rowsByAsin.__prior = b.rows;
  delete b.rows;
  if (!b.base && b.fileName) b.base = String(b.fileName).replace(/\.csv$/i, '');
  delete b.fileName;
}
function csvAllRows() {
  const m = (csvBatch && csvBatch.rowsByAsin) || {};
  const out = [];
  for (const k of Object.keys(m)) out.push(...(m[k] || []));
  return out;
}
function csvRowCount() {
  const m = (csvBatch && csvBatch.rowsByAsin) || {};
  let n = 0; for (const k in m) n += (m[k] || []).length; return n;
}
function csvImageCount() {
  const m = (csvBatch && csvBatch.imgByAsin) || {};
  let n = 0; for (const k in m) n += (m[k] || 0); return n;
}
// SET (replace) one ASIN's rows + image count — so regenerating that ASIN overwrites
// just its slice of the file.
function setCsvProduct(asin, rows, images) {
  if (!csvBatch.rowsByAsin) csvBatch.rowsByAsin = {};
  if (!csvBatch.imgByAsin) csvBatch.imgByAsin = {};
  // Legacy migrated rows live in `__prior` (an untagged blob). When this product is
  // (re)written, drop any __prior rows for the SAME product (matched by the trailing
  // product_id|product_handle columns) so a regenerate never duplicates them.
  const prior = csvBatch.rowsByAsin.__prior;
  if (prior && prior.length && rows && rows.length) {
    const key = (r) => { const p = String(r).split(','); return (p[p.length - 2] || '').trim() + '|' + (p[p.length - 1] || '').trim(); };
    const mine = new Set(rows.map(key).filter((k) => k !== '|')); // only real product ids/handles
    if (mine.size) {
      csvBatch.rowsByAsin.__prior = prior.filter((r) => !mine.has(key(r)));
      if (!csvBatch.rowsByAsin.__prior.length) delete csvBatch.rowsByAsin.__prior;
    }
  }
  csvBatch.rowsByAsin[asin] = rows;
  csvBatch.imgByAsin[asin] = images || 0;
}
// The current output filename: base + (image-mode) the total photo count, so the
// count is visible right in the file name (e.g. cerave_images_45photos.csv).
function csvFileName() {
  if (!csvBatch) return '';
  const n = runMode === 'image' ? csvImageCount() : 0;
  return `${csvBatch.base}${n ? `_${n}photos` : ''}.csv`;
}
// Central write: (over)writes the union of all ASINs' rows to disk. When the image
// count changes the file name changes, so erase the previous file to keep it ONE
// file (not a pile of _10/_20/_30photos.csv). Returns true on a confirmed write.
async function writeCsvNow() {
  if (!csvBatch || !csvRowCount()) return false;
  const name = csvFileName();
  const res = await writeCombinedCsv(csvAllRows(), name);
  if (res && res.ok) {
    csvBatch.written = true;
    if (csvBatch.lastFile && csvBatch.lastFile !== name && csvBatch.lastDownloadId != null) {
      try { chrome.runtime.sendMessage({ action: 'erase_download', id: csvBatch.lastDownloadId }); } catch (e) {}
    }
    csvBatch.lastFile = name;
    if (res.downloadId != null) csvBatch.lastDownloadId = res.downloadId;
  }
  return !!(res && res.ok);
}

// --- Combined CSV batch: persisted so Stop→Continue/resume keeps ONE file ---
function loadCsvBatch() {
  const key = csvStoreKey();
  return new Promise((resolve) => {
    try { chrome.storage.local.get([key], (r) => resolve((r && r[key]) || null)); }
    catch (e) { resolve(null); }
  });
}
// Persists the batch (fileName + all rows so far) and resolves true on success.
// Returns false if the write failed (e.g. storage quota) so callers can avoid
// marking an ASIN "done" when its reviews weren't actually saved.
function saveCsvBatch() {
  const key = csvStoreKey();
  return new Promise((resolve) => {
    try { chrome.storage.local.set({ [key]: csvBatch }, () => resolve(!chrome.runtime.lastError)); }
    catch (e) { resolve(false); }
  });
}
function updateProgressUi() {
  const el = document.getElementById('progressInfo');
  if (!el) return;
  const t = doneAsinsText.size, im = doneAsinsImage.size;
  const parts = [];
  if (t) parts.push(`${t} text`);
  if (im) parts.push(`${im} image`);
  el.textContent = parts.length ? `${parts.join(' + ')} ASIN(s) marked done (skipped on re-run)` : 'No completed ASINs yet.';
}

function initDashboard() {
  initTabs();
  loadSettings();
  loadProgress();
  const ss = document.getElementById('saveSettingsBtn'); if (ss) ss.addEventListener('click', saveSettings);
  const ch = document.getElementById('clearHistoryBtn');
  if (ch) ch.addEventListener('click', () => { try { chrome.storage.local.set({ history: [] }); } catch (e) {} renderHistory(); });
  const rp = document.getElementById('resetProgressBtn');
  if (rp) rp.addEventListener('click', () => { if (confirm('Forget all completed ASINs and reprocess them next run?')) resetProgress(); });
  const dr = document.getElementById('deleteReviewBtn');
  if (dr) dr.addEventListener('click', deleteReviewImages);
  updateUploadedUi();
}
initDashboard();
