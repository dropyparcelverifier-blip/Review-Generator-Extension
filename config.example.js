// ============================================================
// TEMPLATE — copy this file to "config.js" and fill in your real values.
// config.js is gitignored and must NEVER be committed or shared.
// ============================================================
self.ENV = {
  // Shopify Files API (image hosting). Use the *.myshopify.com domain, NOT dropy.in.
  SHOPIFY_SHOP_DOMAIN: '',          // e.g. 'your-store.myshopify.com'
  SHOPIFY_ACCESS_TOKEN: '',         // Admin API token, e.g. 'shpat_xxxxxxxx'  (needs write_files)
  SHOPIFY_API_VERSION: '2025-07',

  // Default site-specific settings. Configure to the target store/domain you
  // want to generate reviews for by default (e.g., 'dropy.in' or 'rudraretail.com').
  // Leave blank to keep the current heuristics.
  DEFAULT_STORE_DOMAIN: '',        // e.g. 'dropy.in' or 'rudraretail.com'
  DEFAULT_STORE_TYPE: 'shopify',   // 'shopify' or 'generic' (controls product JSON scraping behavior)

  // AI provider selection for text generation. Supported: 'gemini', 'chatgpt', 'claude', 'api'
  // Note: this repo ships a content script for Gemini, ChatGPT, and Claude.
  // If you set AI_PROVIDER: 'api', the extension will POST { prompt } to
  // API_ENDPOINT with Authorization: Bearer API_KEY. The API must return JSON
  // with a text response at either `response` or `text`.
  AI_PROVIDER: 'gemini',

  // Generic API provider settings (used when AI_PROVIDER === 'api').
  // Example: API_ENDPOINT: 'https://your-api-host.example.com/generate'
  API_ENDPOINT: '',
  API_KEY: '',

  // Optional per-store upload endpoints — configure if you want images hosted
  // directly on a non-Shopify store. Example shape for RUDRA_UPLOAD:
  // RUDRA_UPLOAD: { endpoint: 'https://rudraretails.com/api/upload', method: 'POST', authHeader: 'Authorization', authValue: 'Bearer xxxxx', mode: 'url', skuField: 'sku', imageField: 'images' }
  RUDRA_UPLOAD: {}
};
