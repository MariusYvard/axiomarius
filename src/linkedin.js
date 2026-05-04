/**
 * LinkedIn Module — AxioMariuS
 *
 * Puppeteer-based LinkedIn scraping functions:
 *   - scrapeCompanyHR     : find HR/People decision-makers at a company
 *   - verifyProfileLink   : check whether a LinkedIn profile URL still exists
 *   - splitFullName       : decompose a full name into first / last
 *   - selectBestProfile   : delegate profile selection to local LLM (Ollama)
 */

'use strict';

const ollama = require('ollama');
const cfg    = require('./config_loader');

// ── Verify a LinkedIn profile URL is still valid ──────────────────────────

async function verifyProfileLink(page, url) {
    if (!url || !url.includes('/in/') || url.includes('/company/')) return false;
    try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status   = response.status();
        if (status === 404 || status === 999) return false;

        return await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            const isError  =
                bodyText.includes('page not found') ||
                bodyText.includes("this page doesn") ||
                bodyText.includes('profile is not available');
            const errorEl  = document.querySelector('.error-container, .profile-unavailable');
            const nameEl   = document.querySelector('h1.text-heading-xlarge, h1[class*="text-heading"]');
            return !isError && !errorEl && !!nameEl;
        });
    } catch (e) {
        console.warn(`Could not verify link (${e.message})`);
        return false;
    }
}

// ── Split a full name into first / last ───────────────────────────────────

function splitFullName(fullName) {
    if (!fullName || fullName.trim() === '') return { firstName: '', lastName: '' };

    const clean = fullName
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    const parts = clean.split(' ').filter(Boolean);
    if (parts.length === 0) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ── Extract HR profiles from company page ─────────────────────────────────

async function _extractWithSelectors(page) {
    try {
        await page.waitForSelector('.org-people-profile-card, .artdeco-entity-lockup', { timeout: 10000 });
    } catch (_) {}

    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await new Promise(r => setTimeout(r, 1500));
    }

    const targetKw  = cfg.get('linkedin.target_keywords',  ['hr', 'people', 'talent']);
    const excludeKw = cfg.get('linkedin.exclude_keywords', ['sales', 'engineer']);

    return page.evaluate((targetKw, excludeKw) => {
        const selectors = [
            '.org-people-profile-card',
            '.artdeco-entity-lockup--size-4',
            '.artdeco-entity-lockup',
            '.org-people-view-module__profile-card',
        ];

        let cards = [];
        selectors.forEach(s => {
            const found = document.querySelectorAll(s);
            if (found.length > cards.length) cards = Array.from(found);
        });

        const results = [];
        cards.forEach(card => {
            const nameEl  = card.querySelector('.artdeco-entity-lockup__title, [class*="title"]');
            const titleEl = card.querySelector('.artdeco-entity-lockup__subtitle, [class*="subtitle"]');
            const linkEl  = card.querySelector('a[href*="/in/"]');

            if (nameEl && titleEl && linkEl) {
                const name  = nameEl.innerText.split('\n')[0].trim();
                const title = titleEl.innerText.trim().replace(/\n/g, ' ');
                const url   = linkEl.href.split('?')[0];
                const t     = title.toLowerCase();

                const isExcluded = excludeKw.some(kw => t.includes(kw));
                const isTarget   = targetKw.some(kw => t.includes(kw));

                if (!isExcluded && isTarget) {
                    results.push({ name, title, linkedin_url: url });
                }
            }
        });

        const unique = Array.from(new Map(results.map(r => [r.linkedin_url, r])).values());
        return unique.slice(0, 20);
    }, targetKw, excludeKw);
}

// ── Main scrape function ───────────────────────────────────────────────────

async function scrapeCompanyHR(page, company) {
    console.log(`Scraping HR profiles for: ${company}`);

    try {
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });

        const isLoggedOut = await page.$('.nav__button-secondary');
        if (isLoggedOut) {
            console.log('LinkedIn session expired. Run `node setup.js` to re-authenticate.');
            return null;
        }

        // Search for company page
        const searchUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(company)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        const companyUrl = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/company/"]'));
            const link  = links.find(l =>
                l.href.includes('/company/') &&
                !l.href.includes('/jobs') &&
                !l.href.includes('/content')
            );
            return link ? link.href.split('?')[0] : null;
        });

        if (!companyUrl) {
            // Fallback: global people search
            const query = encodeURIComponent(`"${company}" AND (HR OR People OR Talent OR "Human Resources")`);
            await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${query}`, { waitUntil: 'networkidle2' });
            return _extractWithSelectors(page);
        }

        // Search people at company with HR keywords
        const hrKeywords = 'DRH OR "Head of People" OR "Chief People" OR "HR Director" OR "People & Culture"';
        const filteredUrl = `${companyUrl.replace(/\/$/, '')}/people/?keywords=${encodeURIComponent(hrKeywords)}`;
        await page.goto(filteredUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        return _extractWithSelectors(page);

    } catch (err) {
        console.error(`Error scraping ${company}: ${err.message}`);
        return [];
    }
}

// ── LLM-based profile selection (Ollama) ─────────────────────────────────

async function selectBestProfile(profiles, company) {
    const model = cfg.get('llm.model', 'gemma3:12b');

    const prompt = `You are an expert recruiter. From this list of LinkedIn profiles, select the most senior HR or People decision-maker for "${company}":
${JSON.stringify(profiles)}

Rules:
1. Absolute priority: CHRO, Chief People Officer, Head of HR, HR Director.
2. Reject profiles unrelated to Human Resources.
3. If none qualify, respond {"found": false}.

Respond ONLY in JSON:
{
  "found": boolean,
  "profile": {"name": "", "title": "", "linkedin_url": ""},
  "reason": ""
}`;

    try {
        const res = await ollama.default.chat({
            model,
            think:    false,
            messages: [{ role: 'user', content: prompt }],
            options:  { temperature: 0.1, num_predict: 300 },
        });

        const content   = (res.message.content || '').trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
        return { found: false };
    } catch (err) {
        console.error('Ollama unreachable or error:', err.message);
        return { found: false };
    }
}

module.exports = {
    verifyProfileLink,
    splitFullName,
    scrapeCompanyHR,
    selectBestProfile,
};
