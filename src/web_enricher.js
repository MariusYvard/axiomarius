/**
 * Web Enricher - AxioMariuS
 *
 * Searches the web for recent tension signals about a company:
 * restructuring, layoffs, leadership changes, etc.
 *
 * Primary:  DuckDuckGo HTML (no anti-bot, no CAPTCHA risk)
 * Fallback: Google (for small companies with limited DDG coverage)
 */

'use strict';

const cfg = require('./config_loader');

/**
 * Search for recent signals about a company.
 * Tries DuckDuckGo first; falls back to Google if no results are found.
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

    const signal = await _searchDDG(page, company, query, keywords)
               ?? await _searchGoogle(page, company, query, keywords);

    return signal;
}

/**
 * DuckDuckGo HTML search — primary source.
 * Static page, no JS required, rarely triggers anti-bot.
 */
async function _searchDDG(page, company, query, keywords) {
    try {
        await page.goto(`https://duckduckgo.com/html/?q=${query}`, {
            waitUntil: 'domcontentloaded',
            timeout:   20000,
        });

        const results = await page.evaluate(() => {
            const snippets = Array.from(document.querySelectorAll('.result__snippet'));
            return snippets.slice(0, 5).map(el => el.innerText.trim()).filter(t => t.length > 30);
        });

        const signal = _extractSignal(results, keywords);
        if (signal) console.log(`[WebEnricher] DDG hit for ${company}: ${signal.label}`);
        return signal;

    } catch (err) {
        console.warn(`[WebEnricher] DDG error for ${company}: ${err.message}`);
        return null;
    }
}

/**
 * Google search — fallback for small companies with limited DDG coverage.
 */
async function _searchGoogle(page, company, query, keywords) {
    try {
        console.log(`[WebEnricher] DDG returned nothing for ${company}, trying Google...`);

        await page.goto(`https://www.google.com/search?q=${query}&num=5&hl=en`, {
            waitUntil: 'domcontentloaded',
            timeout:   20000,
        });

        const results = await page.evaluate(() => {
            const snippets = Array.from(document.querySelectorAll('.VwiC3b, .s3v9rd, .st'));
            return snippets.slice(0, 5).map(el => el.innerText.trim()).filter(t => t.length > 30);
        });

        const signal = _extractSignal(results, keywords);
        if (signal) console.log(`[WebEnricher] Google hit for ${company}: ${signal.label}`);
        return signal;

    } catch (err) {
        console.warn(`[WebEnricher] Google error for ${company}: ${err.message}`);
        return null;
    }
}

/**
 * Extract a signal label and verbatim from a list of result snippets.
 * Returns null if no snippet contains a known keyword.
 *
 * @param {string[]} results
 * @param {string[]} keywords
 * @returns {{label: string, verbatim: string}|null}
 */
function _extractSignal(results, keywords) {
    if (!results.length) return null;

    const kws = keywords.map(k => k.toLowerCase());
    const hit  = results.find(r => kws.some(k => r.toLowerCase().includes(k)));

    if (!hit) return null;

    const matchedKw = kws.find(k => hit.toLowerCase().includes(k)) || keywords[0];
    const label     = matchedKw.charAt(0).toUpperCase() + matchedKw.slice(1);

    return { label, verbatim: hit.substring(0, 300) };
}

module.exports = { captureWebSignal };