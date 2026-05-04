/**
 * CRM Writer — AxioMariuS
 *
 * Atomic write to Excel CRM with integrity verification.
 * Uses TEMP → BACKUP → RENAME pattern to prevent data loss
 * even on cloud-synced drives (OneDrive, Dropbox, etc.).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Write an ExcelJS workbook atomically to disk.
 * Keeps a single rolling backup at <file>.bak
 */
async function atomicWriteCRM(workbook, filePath) {
    const tmpPath = filePath + '.tmp';
    const bakPath = filePath + '.bak';
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await workbook.xlsx.writeFile(tmpPath);

            if (fs.existsSync(filePath)) {
                fs.renameSync(filePath, bakPath);
            }

            fs.renameSync(tmpPath, filePath);
            return;

        } catch (err) {
            console.warn(`[CRM] Write attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);

            if (attempt === MAX_RETRIES) {
                // Last resort: copy + delete
                try {
                    fs.copyFileSync(tmpPath, filePath);
                    fs.unlinkSync(tmpPath);
                    return;
                } catch (copyErr) {
                    throw new Error(`CRM write failed after ${MAX_RETRIES} attempts: ${copyErr.message}`);
                }
            }

            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

/**
 * Verify the CRM file exists and is readable.
 */
function validateCRMIntegrity(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`[CRM] File not found: ${filePath}`);
        return false;
    }

    try {
        const stat = fs.statSync(filePath);
        if (stat.size < 100) {
            console.error('[CRM] File appears corrupted (too small).');
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[CRM] Cannot read file: ${err.message}`);
        return false;
    }
}

module.exports = { atomicWriteCRM, validateCRMIntegrity };
