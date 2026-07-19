chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'inject_prompt') {
    handleGeminiPrompt(msg.prompt).then(response => {
      sendResponse(response);
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleGeminiPrompt(prompt) {
  // Wait for page to be ready
  await waitFor(() => {
    return document.querySelector('.ql-editor, [contenteditable="true"], .input-area [contenteditable], div[role="textbox"], .text-input-field textarea, textarea[aria-label], .ql-editor[data-placeholder]');
  }, 15000);

  // Find the input field
  const inputField = findInputField();
  if (!inputField) {
    throw new Error('Could not find Gemini input field');
  }

  // Clear and type the prompt
  inputField.focus();
  await sleep(200);

  // Set content
  if (inputField.tagName === 'TEXTAREA') {
    inputField.value = prompt;
    inputField.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    inputField.innerHTML = '';
    await sleep(100);
    // Use clipboard to paste long prompts
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', prompt);
      inputField.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (e) {
      // Fallback: insert via execCommand
      inputField.focus();
      document.execCommand('insertText', false, prompt);
    }
  }

  // Snapshot the current last-response text BEFORE submitting. When we reuse a
  // chat across batches, the previous answer is still on screen; without this
  // baseline, waitForResponse would re-return the old answer and we'd get
  // duplicate reviews.
  const baselineResponse = getLastResponseText();

  await sleep(400);

  // Verify the prompt actually landed in the field. Synthetic paste can
  // silently fail on Gemini's editor, which leaves the send button disabled.
  const currentValue = (inputField.tagName === 'TEXTAREA')
    ? inputField.value
    : (inputField.innerText || inputField.textContent || '');
  if (!currentValue.trim()) {
    inputField.focus();
    document.execCommand('insertText', false, prompt);
    await sleep(500);
  }

  // Submit. A found-but-disabled send button must NOT be treated as "sent" —
  // fall through to the Enter key instead, otherwise the request never fires.
  const sendBtn = findSendButton();
  if (sendBtn && !isDisabled(sendBtn)) {
    sendBtn.click();
  } else {
    pressEnter(inputField);
    // Give the UI a beat, then retry the button in case Enter was ignored.
    await sleep(600);
    const retryBtn = findSendButton();
    if (retryBtn && !isDisabled(retryBtn)) retryBtn.click();
  }

  // Wait for response to complete
  const responseText = await waitForResponse(120000, baselineResponse);

  return { response: responseText };
}

// Returns the rendered text of the most recent model response, or '' if none.
function getLastResponseText() {
  const els = document.querySelectorAll(
    '.response-container, .model-response-text, .markdown-main-panel, ' +
    '.conversation-container .model-response, message-content, ' +
    '.response-content, [data-message-author-role="model"], ' +
    '.chat-message.model, .gemini-response'
  );
  if (els.length === 0) return '';
  const last = els[els.length - 1];
  return last.innerText || last.textContent || '';
}

function findInputField() {
  const selectors = [
    '.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="prompt"]',
    'div[contenteditable="true"][data-placeholder]',
    '.input-area [contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    'textarea[aria-label]',
    '.text-input-field textarea',
    '[contenteditable="true"]'
  ];
  
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findSendButton() {
  const selectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="Submit"]',
    'button.send-button',
    '.send-button',
    'button[data-test-id="send-button"]',
    'button mat-icon-button[aria-label*="Send"]'
  ];
  
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  
  // Fallback: find button with send icon
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    const text = (btn.innerText || '').toLowerCase();
    if (ariaLabel.includes('send') || ariaLabel.includes('submit') || 
        text.includes('send') || btn.querySelector('mat-icon, .material-icons')) {
      if (btn.offsetParent !== null) return btn;
    }
  }
  
  return null;
}

// A finished JSON array must have BALANCED brackets, not merely end in ']'. We scan
// from the first '[' tracking string state, so a ']' inside a review body (e.g.
// "Great value [5/5]") during a mid-stream stall does NOT look complete — preventing
// a truncated response from being accepted as done.
function jsonArrayLooksComplete(text) {
  const t = (text || '').trim();
  const start = t.indexOf('[');
  if (start < 0 || !/\][\s`]*$/.test(t)) return false; // must contain and end at a ]
  let depth = 0, inStr = false, esc = false, closed = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) closed = true; }
  }
  return closed && depth === 0 && !inStr; // top-level array fully balanced & closed
}

async function waitForResponse(timeout = 120000, baselineText = '') {
  // Wait for the response to start generating
  await sleep(1500);

  let lastText = '';
  let lastChange = Date.now();
  const startTime = Date.now();
  const POLL = 700;
  const STABLE_MS = 3500;      // generic fallback: text unchanged this long => done
  const JSON_STABLE_MS = 1200; // we asked for a JSON array — once it ends with ] and
                               // briefly stops growing, it's definitely finished

  while (Date.now() - startTime < timeout) {
    let currentText = getLastResponseText();

    // Fallback: get all model responses
    if (!currentText) {
      const allMessages = document.querySelectorAll('[class*="response"], [class*="message"]');
      if (allMessages.length > 0) {
        const last = allMessages[allMessages.length - 1];
        currentText = last.innerText || '';
      }
    }

    // The previous answer may still be on screen (reused chat). Ignore it until
    // a genuinely new/changed response appears, so we never return stale text.
    if (baselineText && currentText === baselineText) {
      await sleep(POLL);
      continue;
    }

    if (currentText !== lastText) {
      // Still streaming (text is growing) — reset the stability timer.
      lastText = currentText;
      lastChange = Date.now();
    } else if (currentText) {
      const stableFor = Date.now() - lastChange;
      // Fast path: a BALANCED JSON array that stopped growing. Bracket-balance (not
      // "ends in ]") avoids returning a truncated array when the stream stalls right
      // after a ] inside a review body.
      if (jsonArrayLooksComplete(currentText) && stableFor >= JSON_STABLE_MS) {
        return currentText;
      }
      // Generic fallback: stable a while AND no visible Stop button.
      if (stableFor >= STABLE_MS && !isStillGenerating()) {
        return currentText;
      }
    }

    await sleep(POLL);
  }

  return lastText || 'TIMEOUT: No response received';
}

// Narrow, visibility-checked test for whether Gemini is still generating.
// While generating, a visible "Stop"/"Stop response" control is shown; once
// finished it disappears. We deliberately avoid broad [class*="loading"]
// selectors because Gemini's app keeps hidden loading elements in the DOM
// permanently, which would make every response look like it's still streaming.
function isStillGenerating() {
  const candidates = document.querySelectorAll(
    'button[aria-label*="Stop" i], button[aria-label*="stop response" i], ' +
    '[aria-label*="Stop generating" i], .stop-button, button[data-test-id="stop-button"]'
  );
  for (const el of candidates) {
    if (el.offsetParent !== null) return true; // visible stop control => generating
  }
  return false;
}

function waitFor(conditionFn, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const result = conditionFn();
      if (result) {
        resolve(result);
      } else if (Date.now() - start > timeout) {
        reject(new Error('Timeout waiting for element'));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

function isDisabled(el) {
  return el.disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.getAttribute('disabled') !== null;
}

function pressEnter(el) {
  el.focus();
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
