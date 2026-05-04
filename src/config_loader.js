/**
 * Config Loader — AxioMariuS
 *
 * Reads config.yaml and merges with environment variables.
 * Provides typed accessors for all configuration values.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_FILE = path.join(process.cwd(), 'config.yaml');

let _config = null;

function load() {
    if (_config) return _config;

    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error(
            `config.yaml not found in ${process.cwd()}.\n` +
            `Copy config.yaml from the project root and edit it to match your setup.`
        );
    }

    const raw = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));

    // Merge SMTP credentials from env vars (take priority over config.yaml)
    if (process.env.SMTP_USER) raw.reporting.smtp_user = process.env.SMTP_USER;
    if (process.env.SMTP_PASS) raw.reporting.smtp_pass = process.env.SMTP_PASS;
    if (process.env.SMTP_REPORT_TO) raw.reporting.report_to = process.env.SMTP_REPORT_TO;

    _config = raw;
    return _config;
}

// Convenience accessors
function get(path, fallback = undefined) {
    const cfg = load();
    const keys = path.split('.');
    let val = cfg;
    for (const key of keys) {
        if (val == null || typeof val !== 'object') return fallback;
        val = val[key];
    }
    return val !== undefined ? val : fallback;
}

module.exports = { load, get };
