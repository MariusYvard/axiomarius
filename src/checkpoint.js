/**
 * Checkpoint — AxioMariuS
 *
 * Persists run state to disk. If the process crashes or is interrupted,
 * the next run picks up where it left off — no reprocessing completed steps.
 *
 * TTL: 24h — after that, a fresh run is started automatically.
 * File: .checkpoint.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const CHECKPOINT_FILE = path.join(process.cwd(), '.checkpoint.json');
const TTL_MS = 24 * 60 * 60 * 1000;

let _state = null;

function _load() {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    } catch (_) {
        return null;
    }
}

function _save() {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(_state, null, 2), 'utf8');
}

/**
 * Initialize checkpoint. Returns { runId, isResume }.
 */
function initCheckpoint() {
    const existing = _load();
    const now      = Date.now();

    if (existing && (now - (existing.startedAt || 0)) < TTL_MS) {
        _state = existing;
        return { runId: _state.runId, isResume: true };
    }

    _state = {
        runId:     randomUUID().slice(0, 8),
        startedAt: now,
        done:      {},   // { "company:step": true }
    };
    _save();
    return { runId: _state.runId, isResume: false };
}

/** Check whether a step is already done for a company. */
function isDone(company, step) {
    if (!_state) initCheckpoint();
    return !!_state.done[`${company}:${step}`];
}

/** Mark a step as done for a company. */
function markDone(company, step) {
    if (!_state) initCheckpoint();
    _state.done[`${company}:${step}`] = true;
    _save();
}

/** Get a summary of completed steps. */
function getSummary() {
    if (!_state) return { linkedin: 0, glassdoor: 0 };
    const keys = Object.keys(_state.done);
    return {
        linkedin:  keys.filter(k => k.endsWith(':linkedin')).length,
        glassdoor: keys.filter(k => k.endsWith(':signal')).length,
    };
}

/** Reset checkpoint (start fresh). */
function resetCheckpoint() {
    _state = null;
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
}

module.exports = { initCheckpoint, isDone, markDone, getSummary, resetCheckpoint };
