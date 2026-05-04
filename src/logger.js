/**
 * Logger — AxioMariuS
 *
 * Console + file logger with color output and session tracking.
 * Log file: axiomarius_<date>.log
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, `axiomarius_${new Date().toISOString().slice(0, 10)}.log`);

const COLORS = {
    reset:   '\x1b[0m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    red:     '\x1b[31m',
    cyan:    '\x1b[36m',
    gray:    '\x1b[90m',
};

let _sessionStart = null;

function _write(level, msg, color) {
    const ts      = new Date().toISOString().slice(11, 19);
    const console_msg = `${color}[${ts}] ${level.padEnd(7)} ${msg}${COLORS.reset}`;
    const file_msg    = `[${new Date().toISOString()}] ${level} ${msg}`;

    process.stdout.write(console_msg + '\n');

    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(LOG_FILE, file_msg + '\n');
    } catch (_) {}
}

const logger = {
    info:    msg => _write('INFO',    msg, COLORS.cyan),
    success: msg => _write('SUCCESS', msg, COLORS.green),
    warn:    msg => _write('WARN',    msg, COLORS.yellow),
    error:   msg => _write('ERROR',   msg, COLORS.red),

    startSession() {
        _sessionStart = Date.now();
        _write('INFO', '═══ AxioMariuS — Session started ═══', COLORS.green);
    },

    endSession(enriched, ignored, errors) {
        const elapsed = _sessionStart ? Math.round((Date.now() - _sessionStart) / 1000) : 0;
        _write('INFO', `═══ Session done — ${enriched} enriched, ${ignored} skipped, ${errors} errors — ${elapsed}s ═══`, COLORS.green);
    },

    getLogPath() { return LOG_FILE; },
};

module.exports = logger;
