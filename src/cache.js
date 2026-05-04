/**
 * Signal Cache — AxioMariuS
 *
 * Persistent file-based cache for Glassdoor signals.
 * Avoids re-scraping the same company between runs.
 *
 * TTL: configurable (default 30 days)
 * File: signal_cache.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config_loader');

const CACHE_FILE = path.join(process.cwd(), 'signal_cache.json');

function _getTTL() {
    return cfg.get('signals.cache_ttl_days', 30) * 24 * 60 * 60 * 1000;
}

function _normalize(company) {
    return (company || '').toLowerCase().trim().replace(/\s+/g, '_');
}

function _load() {
    if (!fs.existsSync(CACHE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (_) {
        return {};
    }
}

function _save(cache) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[Cache] Write failed: ${e.message}`);
    }
}

/**
 * Get cached signal for a company, or null if absent/expired.
 * @param {string} company
 * @returns {object|null}
 */
function get(company) {
    const cache = _load();
    const key   = _normalize(company);
    const entry = cache[key];

    if (!entry) return null;

    const age = Date.now() - (entry.ts || 0);
    if (age > _getTTL()) {
        delete cache[key];
        _save(cache);
        return null;
    }

    const ageDays = Math.floor(age / 86400000);
    console.log(`[Cache] HIT for "${company}" (age: ${ageDays}d)`);
    return entry.signal;
}

/**
 * Store a signal in cache for a company.
 * @param {string} company
 * @param {object} signal - { label, verbatim, ... }
 */
function set(company, signal) {
    const cache = _load();
    const key   = _normalize(company);
    cache[key]  = { ts: Date.now(), company, signal };
    _save(cache);
    console.log(`[Cache] SET for "${company}"`);
}

/**
 * Remove expired entries from cache.
 * @returns {number} number of entries removed
 */
function purgeExpired() {
    const cache = _load();
    const ttl   = _getTTL();
    const now   = Date.now();
    let   count = 0;

    for (const key of Object.keys(cache)) {
        if ((now - (cache[key].ts || 0)) > ttl) {
            delete cache[key];
            count++;
        }
    }

    if (count > 0) {
        _save(cache);
        console.log(`[Cache] Purged ${count} expired entries.`);
    }
    return count;
}

/** Return stats about the current cache state. */
function getStats() {
    const cache   = _load();
    const ttl     = _getTTL();
    const now     = Date.now();
    const entries = Object.values(cache);
    const valid   = entries.filter(e => (now - e.ts) < ttl).length;

    return { total: entries.length, valid, expired: entries.length - valid };
}

module.exports = { get, set, purgeExpired, getStats };
