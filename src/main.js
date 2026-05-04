/**
 * AxioMariuS — Main Orchestrator
 *
 * Enriches an Excel CRM with LinkedIn contact data and tension signals
 * (from web news and Glassdoor reviews) using a local LLM (Ollama).
 *
 * Workflow per lead:
 *   1. LinkedIn  — Find HR/People decision-maker → write name/title/URL to CRM
 *   2. Signals   — Web news OR Glassdoor reviews → write tension signal to CRM
 *
 * Usage: node src/main.js
 *   --dry-run   Show what would be done without modifying the CRM
 *   --reset     Clear checkpoint and start from scratch
 */

'use strict';

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ExcelJS       = require('exceljs');
const path          = require('path');
const fs            = require('fs');

const cfg        = require('./config_loader');
const logger     = require('./logger');
const cache      = require('./cache');
const { atomicWriteCRM, validateCRMIntegrity } = require('./crm_writer');
const { initCheckpoint, isDone, markDone, getSummary, resetCheckpoint } = require('./checkpoint');
const { scrapeCompanyHR, verifyProfileLink, splitFullName, selectBestProfile } = require('./linkedin');
const { captureWebSignal } = require('./web_enricher');

puppeteer.use(StealthPlugin());

// ── CLI flags ─────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const RESET   = process.argv.includes('--reset');

// ── CRM helpers ───────────────────────────────────────────────────────────

const COLS = cfg.get('crm.columns');

function getCellValue(row, colKey) {
    const idx  = COLS[colKey];
    if (!idx) return null;
    const cell = row.getCell(idx);
    if (cell.value && typeof cell.value === 'object' && cell.value.text) return cell.value.text;
    return cell.value ?? null;
}

function setCellValue(row, colKey, value) {
    const idx = COLS[colKey];
    if (idx) row.getCell(idx).value = value;
}

function appendCellValue(row, colKey, text, sep = ' | ') {
    const existing = getCellValue(row, colKey) || '';
    setCellValue(row, colKey, [existing, text].filter(Boolean).join(sep));
}

function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    logger.info(`Anti-detection pause: ${(ms / 1000).toFixed(1)}s`);
    return new Promise(r => setTimeout(r, ms));
}

// ── Eligibility checks ────────────────────────────────────────────────────

function isEligibleStage(stage) {
    const stages = cfg.get('crm.eligible_stages', ['New', 'Lead']);
    return stages.some(s => String(stage || '').includes(s));
}

function needsLinkedIn(url) {
    return !url ||
        !String(url).startsWith('http') ||
        !String(url).includes('linkedin.com/in/') ||
        String(url).includes('Not found');
}

function needsSignal(signal) {
    return !signal || String(signal).trim() === '';
}

// ── Main ──────────────────────────────────────────────────────────────────

async function run() {
    logger.startSession();

    if (RESET) {
        resetCheckpoint();
        logger.info('Checkpoint cleared — starting fresh.');
    }

    if (DRY_RUN) {
        logger.warn('DRY RUN mode — CRM will not be modified.');
    }

    const crmPath = path.resolve(process.cwd(), cfg.get('crm.file', 'CRM.xlsx'));

    if (!validateCRMIntegrity(crmPath)) {
        logger.error(`CRM not found or corrupted: ${crmPath}`);
        process.exit(1);
    }

    // Load CRM
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(crmPath);

    const sheetName   = cfg.get('crm.sheet', 'Pipeline');
    const startRow    = cfg.get('crm.data_start_row', 2);
    const sheet       = workbook.getWorksheet(sheetName);

    if (!sheet) {
        logger.error(`Sheet "${sheetName}" not found in ${crmPath}`);
        process.exit(1);
    }

    logger.info(`Sheet loaded: ${sheet.actualRowCount} rows`);

    // Collect eligible leads
    const toEnrich = [];
    for (let i = startRow; i <= sheet.actualRowCount; i++) {
        const row     = sheet.getRow(i);
        const company = getCellValue(row, 'company');
        const stage   = getCellValue(row, 'stage');
        const url     = getCellValue(row, 'linkedin_url');
        const signal  = getCellValue(row, 'signal');

        if (!company || typeof company !== 'string' || !company.trim()) continue;

        if (isEligibleStage(stage)) {
            const wantsLinkedIn = needsLinkedIn(String(url || ''));
            const wantsSignal   = needsSignal(String(signal || ''));

            if (wantsLinkedIn || wantsSignal) {
                toEnrich.push({
                    row, rowIndex: i,
                    company:       company.trim(),
                    linkedinUrl:   String(url || ''),
                    signal:        String(signal || ''),
                    firstName:     String(getCellValue(row, 'first_name') || ''),
                    wantsLinkedIn,
                    wantsSignal,
                });
            }
        }
    }

    if (toEnrich.length === 0) {
        logger.info('All eligible leads are already enriched. Nothing to do.');
        return;
    }

    logger.info(`${toEnrich.length} lead(s) to enrich.`);

    // Cache maintenance
    cache.purgeExpired();
    const cacheStats = cache.getStats();
    if (cacheStats.total > 0) {
        logger.info(`[Cache] ${cacheStats.valid} valid entries.`);
    }

    // Checkpoint
    const { runId, isResume } = initCheckpoint();
    if (isResume) {
        const cp = getSummary();
        logger.info(`Resuming run ${runId} — already done: ${cp.linkedin} LinkedIn, ${cp.glassdoor} signals.`);
    } else {
        logger.info(`New run started: ${runId}`);
    }

    // Browser
    const delayMin = cfg.get('linkedin.delay_min', 3000);
    const delayMax = cfg.get('linkedin.delay_max', 7000);

    const browser = await puppeteer.launch({
        headless:        cfg.get('linkedin.headless', false),
        userDataDir:     path.resolve(process.cwd(), cfg.get('linkedin.session_dir', './chrome-session')),
        args:            ['--no-sandbox', '--disable-setuid-sandbox'],
        protocolTimeout: cfg.get('linkedin.protocol_timeout', 180000),
    });

    let linkedinPage = await browser.newPage();
    await linkedinPage.setViewport({ width: 1280, height: 800 });

    const stats    = { linkedin: 0, signal: 0, deadLinks: 0, skipped: 0, errors: 0 };
    let   mustSave = false;

    try {
        for (const lead of toEnrich) {
            const { row, company } = lead;
            let { linkedinUrl, firstName, wantsLinkedIn, wantsSignal } = lead;

            logger.info(`\n── ${company} ──`);

            // ── 1. LINKEDIN ───────────────────────────────────────────────
            if (wantsLinkedIn && isDone(company, 'linkedin')) {
                logger.info(`[Checkpoint] LinkedIn already done for ${company} — skip.`);
                wantsLinkedIn = false;
            }

            if (wantsLinkedIn) {
                // Verify existing URL if present
                if (linkedinUrl && linkedinUrl.includes('linkedin.com/in/')) {
                    const valid = await verifyProfileLink(linkedinPage, linkedinUrl);
                    if (!valid) {
                        logger.warn('Dead link — relaunching scrape.');
                        stats.deadLinks++;
                        linkedinUrl = '';
                    } else {
                        logger.info('LinkedIn URL valid — skipping scrape.');
                        wantsLinkedIn = false;
                    }
                }

                if (wantsLinkedIn) {
                    try {
                        logger.info(`Scraping HR profiles for ${company}...`);
                        const candidates = await scrapeCompanyHR(linkedinPage, company);

                        if (candidates === null) {
                            logger.warn('LinkedIn session expired. Run `node setup.js` to re-authenticate, then restart.');
                            break;
                        }

                        if (candidates.length > 0) {
                            logger.info(`${candidates.length} profiles found — selecting with LLM...`);
                            const decision = await selectBestProfile(candidates, company);

                            if (decision.found && decision.profile) {
                                const profile               = decision.profile;
                                const { firstName: fn, lastName: ln } = splitFullName(profile.name);

                                if (!DRY_RUN) {
                                    setCellValue(row, 'first_name',   fn);
                                    setCellValue(row, 'last_name',    ln);
                                    setCellValue(row, 'title',        profile.title || '');
                                    setCellValue(row, 'linkedin_url', profile.linkedin_url);
                                    if (decision.reason) appendCellValue(row, 'notes', `[LinkedIn] ${decision.reason}`);
                                    row.commit();
                                    mustSave = true;
                                }

                                linkedinUrl = profile.linkedin_url;
                                firstName   = fn;
                                markDone(company, 'linkedin');
                                logger.success(`Selected: ${fn} ${ln} — ${profile.title}`);
                                stats.linkedin++;

                            } else {
                                logger.warn(`No valid HR leader found for ${company}.`);
                                if (!DRY_RUN) {
                                    setCellValue(row, 'linkedin_url', 'Not found (AI rejection)');
                                    if (decision.reason) appendCellValue(row, 'notes', `[LinkedIn] ${decision.reason}`);
                                    row.commit();
                                    mustSave = true;
                                }
                                stats.skipped++;
                            }
                        } else {
                            logger.warn(`No HR profiles found for ${company}.`);
                            stats.skipped++;
                        }

                        await randomDelay(delayMin, delayMax);

                    } catch (err) {
                        logger.error(`LinkedIn error for ${company}: ${err.message}`);
                        stats.errors++;

                        if (err.message.toLowerCase().includes('detach') || err.message.toLowerCase().includes('frame')) {
                            logger.warn('Detached frame — recreating LinkedIn page...');
                            try { await linkedinPage.close(); } catch {}
                            try {
                                linkedinPage = await browser.newPage();
                                await linkedinPage.setViewport({ width: 1280, height: 800 });
                            } catch (e2) {
                                logger.error(`Failed to recreate page: ${e2.message}`);
                            }
                        }
                    }
                }
            }

            // ── 2. SIGNAL DETECTION ───────────────────────────────────────
            if (wantsSignal && isDone(company, 'signal')) {
                logger.info(`[Checkpoint] Signal already done for ${company} — skip.`);
                wantsSignal = false;
            }

            if (wantsSignal) {
                try {
                    // Check cache first
                    let signal = cache.get(company);
                    let source = 'cache';

                    if (!signal) {
                        // Try web news first (faster, no login required)
                        const webPage = await browser.newPage();
                        logger.info(`Searching web signals for ${company}...`);
                        signal = await captureWebSignal(webPage, company);
                        await webPage.close();
                        source = 'web';

                        if (signal && signal.label) {
                            cache.set(company, signal);
                        }
                    }

                    if (signal && signal.label) {
                        if (!DRY_RUN) {
                            setCellValue(row, 'signal', signal.label);
                            const note = `[${source}] ${(signal.verbatim || signal.label).substring(0, 250)}`;
                            appendCellValue(row, 'notes', note);
                            row.commit();
                            mustSave = true;
                        }
                        markDone(company, 'signal');
                        logger.success(`Signal: ${signal.label} (source: ${source})`);
                        stats.signal++;
                    } else {
                        logger.warn(`No signal found for ${company}.`);
                    }

                    await randomDelay(delayMin, delayMax);

                } catch (err) {
                    logger.error(`Signal search error for ${company}: ${err.message}`);
                    stats.errors++;
                }
            }
        }

    } finally {
        await browser.close();
        logger.info('Browser closed.');
    }

    // Atomic save
    if (mustSave && !DRY_RUN) {
        logger.info('Saving CRM...');
        await atomicWriteCRM(workbook, crmPath);
        logger.success('CRM saved.');
    } else if (!mustSave) {
        logger.info('No changes — save skipped.');
    }

    // Report
    logger.endSession(stats.linkedin + stats.signal, stats.skipped, stats.errors);
    console.log('\n' + '═'.repeat(55));
    console.log('  AxioMariuS — Run Report');
    console.log('═'.repeat(55));
    console.log(`  LinkedIn enriched  : ${stats.linkedin}`);
    console.log(`  Signals found      : ${stats.signal}`);
    console.log(`  Dead links fixed   : ${stats.deadLinks}`);
    console.log(`  Skipped (no match) : ${stats.skipped}`);
    console.log(`  Errors             : ${stats.errors}`);
    console.log('═'.repeat(55));
    console.log(`  Logs: ${logger.getLogPath()}`);
}

run().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
