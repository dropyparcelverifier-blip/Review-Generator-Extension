// dropy.in is a Shopify store. The most reliable source of structured product
// data is the Product JSON-LD block (standardized, theme-independent), so we
// read that first and only fall back to DOM selectors / meta tags for gaps.
function getProductJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    try {
      const parsed = JSON.parse((s.textContent || '').trim());
      const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const it of items) {
        if (it && (it['@type'] === 'Product' || (Array.isArray(it['@type']) && it['@type'].includes('Product')))) {
          return it;
        }
      }
    } catch (e) { /* malformed block — skip */ }
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extract_product') {
    try {
      const data = {};
      const ld = getProductJsonLd();

      // --- Primary: Shopify Product JSON-LD ---
      if (ld) {
        data.name = (ld.name || '').toString().trim();
        data.sku = (ld.sku || ld.mpn || (ld.offers && !Array.isArray(ld.offers) && ld.offers.sku) || '').toString().trim();
        data.brand = (ld.brand && (ld.brand.name || (typeof ld.brand === 'string' ? ld.brand : ''))) || '';
        data.category = (ld.category || '').toString().trim();
        data.short_description = (ld.description || '').toString().trim();
        if (ld.image) {
          const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
          data.images = imgs.map(x => (typeof x === 'string' ? x : (x && x.url) || '')).filter(Boolean).slice(0, 5);
        }
      }

      // Product name (fallback if JSON-LD missing it)
      if (!data.name) data.name = document.querySelector('h1.product_title, h1.entry-title, .product-title h1, h1')?.innerText?.trim() || '';
      
      // Price
      data.price = document.querySelector('.price .woocommerce-Price-amount, .product-price, .price ins .amount, .price .amount, .price__regular, .price-item')?.innerText?.trim() || '';

      // Description (fill only if JSON-LD didn't provide one)
      if (!data.short_description) {
        const descEl = document.querySelector('.woocommerce-product-details__short-description, .product-short-description, .summary .description, .product__description, .product-single__description, [class*="product"][class*="description"]');
        data.short_description = descEl?.innerText?.trim() || '';
      }

      // Full description
      const fullDescEl = document.querySelector('#tab-description, .woocommerce-Tabs-panel--description, .product-description, .product__description, .product-single__description, .rte');
      data.full_description = fullDescEl?.innerText?.trim()?.substring(0, 2000) || '';

      // Category (fallback)
      if (!data.category) {
        data.category = document.querySelector('.posted_in a, .product_meta .posted_in a, .product-category a, .breadcrumb a:last-of-type')?.innerText?.trim() || '';
      }

      // Brand (fallback)
      if (!data.brand) {
        data.brand = document.querySelector('.product_meta .tagged_as a, .brand a, [class*="brand"]')?.innerText?.trim() || '';
      }

      // SKU (fallback — Shopify/Woo themes that expose it in the DOM)
      if (!data.sku) {
        data.sku = document.querySelector('.sku, .product_meta .sku, [class*="sku"], .product-single__sku')?.innerText?.replace(/^sku:?\s*/i, '').trim() || '';
      }

      // Attributes / specifications
      const specs = [];
      document.querySelectorAll('.woocommerce-product-attributes tr, .product-attributes tr, .shop_attributes tr').forEach(row => {
        const label = row.querySelector('th, td:first-child')?.innerText?.trim();
        const value = row.querySelector('td:last-child, td:nth-child(2)')?.innerText?.trim();
        if (label && value) specs.push(`${label}: ${value}`);
      });
      data.specifications = specs.join(', ');
      
      // Additional info from tabs
      const additionalInfo = document.querySelector('#tab-additional_information, .woocommerce-Tabs-panel--additional_information');
      if (additionalInfo) {
        data.additional_info = additionalInfo.innerText?.trim()?.substring(0, 1000) || '';
      }
      
      // Tags
      const tags = [];
      document.querySelectorAll('.tagged_as a, .product_tag a').forEach(a => {
        tags.push(a.innerText.trim());
      });
      data.tags = tags.join(', ');
      
      // Images (fill only if JSON-LD didn't provide any)
      if (!data.images || data.images.length === 0) {
        const images = [];
        document.querySelectorAll('.woocommerce-product-gallery__image img, .product-images img, .wp-post-image, .product__media img, .product-single__photo img').forEach(img => {
          const src = img.getAttribute('data-large_image') || img.getAttribute('data-src') || img.src;
          if (src && !src.includes('placeholder')) images.push(src);
        });
        data.images = images.slice(0, 5);
      }
      
      // Meta description fallback
      const metaDesc = document.querySelector('meta[name="description"]');
      if (!data.short_description && metaDesc) {
        data.short_description = metaDesc.getAttribute('content') || '';
      }
      
      // OG title fallback
      if (!data.name) {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        data.name = ogTitle?.getAttribute('content') || document.title || '';
      }
      
      // Collect all visible text for context
      const bodyText = document.querySelector('.product, .single-product, main, article')?.innerText || '';
      data.page_context = bodyText.substring(0, 3000);
      
      sendResponse(data);
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true; // async response for extract_product only — keep the channel open
  }
  // Other actions: no response, so don't hold the channel open (return undefined).
});
