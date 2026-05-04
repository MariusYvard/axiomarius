/**
 * Web Enricher — AxioMariuS
 *
 * Searches the web for recent tension signals about a company:
 * restructuring, layoffs, leadership changes, etc.
 *
 * Uses a Google search via Puppeteer (no API key required).
 */

'use strict';

const cfg = require('./config_loader');

/**
 * Search the web for recent signals about a company.
 *
 * @param {Page} page - Puppeteer page (fresh, not the LinkedIn page)
 * @param {string} company
 * @returns {Promise<{label: string, verbatim: string}|null>}
 */
async function captureWebSignal(page, company) {
    const keywords = cfg.get('signals.web_keywords', [
        'restructuring', 'layoffs', 'merger', 'reorganization', 'turnover'
    ]);

    const currentYear = new Date().getFullYear();
    const kwString    = keywords.slice(0, 5).join(' OR ');
    const query       = encodeURIComponent(`"${company}" (${kwString}) ${currentYear}`);

    try {
        await page.goto(`https://www.google.com/search?q=${query}&num=5&hl=en`, {
            waitUntil: 'domcontentloaded',
            timeout:   20000,
        });

        const results = await page.evaluate(() => {
            const snippets = Array.from(document.querySelectorAll('.VwiC3b, .s3v9rd, .st'));
            return snippets.slice(0, 5).map(el => el.innerText.trim()).filter(t => t.length > 30);
        });

        if (!results.length) return null;

        // Find the first snippet that contains a known keyword
        const kws = keywords.map(k => k.toLowerCase());
        const hit  = results.find(r => kws.some(k => r.toLowerCase().includes(k)));

        if (!hit) return null;

        // Derive a short label
        const matchedKw = kws.find(k => hit.toLowerCase().includes(k)) || keywords[0];
        const label     = matchedKw.charAt(0).toUpperCase() + matchedKw.slice(1);

        return { label, verbatim: hit.substring(0, 300) };

    } catch (err) {
        console.warn(`[WebEnricher] Error for ${company}: ${err.message}`);
        return null;
    }
}

module.exports = { captureWebSignal };
