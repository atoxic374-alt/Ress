const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./storagePaths');

const STORE_PATH = path.join(getDataDir(), 'responsibility-shortcuts.json');
const STORE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_STORED_REQUESTS = 10000;
const MAX_STORED_COOLDOWN_KEYS = 50000;
const PRUNE_WATERMARK = 500;
const SAVE_DEBOUNCE_MS = 200;
let storeCache = null;
let saveTimer = null;
let writeQueue = Promise.resolve();

function normalizeStore(value) {
  const state = value && typeof value === 'object' ? value : {};
  if (!state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests)) state.requests = {};
  if (!state.cooldowns || typeof state.cooldowns !== 'object' || Array.isArray(state.cooldowns)) state.cooldowns = {};
  if (!state.callCooldowns || typeof state.callCooldowns !== 'object' || Array.isArray(state.callCooldowns)) state.callCooldowns = {};
  return state;
}

function pruneOldestEntries(collection, maxEntries, getTimestamp) {
  const entries = Object.entries(collection);
  if (entries.length <= maxEntries) return false;
  entries.sort((a, b) => getTimestamp(a[1]) - getTimestamp(b[1]));
  const targetSize = Math.max(0, maxEntries - PRUNE_WATERMARK);
  for (const [key] of entries.slice(0, entries.length - targetSize)) delete collection[key];
  return true;
}

function pruneStore(state, now = Date.now()) {
  const cutoff = now - STORE_TTL_MS;
  let changed = false;
  for (const [token, request] of Object.entries(state.requests)) {
    if (!request || !Number.isFinite(Number(request.createdAt)) || Number(request.createdAt) < cutoff) {
      delete state.requests[token];
      changed = true;
    }
  }
  for (const [key, at] of Object.entries(state.cooldowns)) {
    if (!Number.isFinite(Number(at)) || Number(at) < cutoff) {
      delete state.cooldowns[key];
      changed = true;
    }
  }
  for (const [key, at] of Object.entries(state.callCooldowns)) {
    if (!Number.isFinite(Number(at)) || Number(at) < cutoff) {
      delete state.callCooldowns[key];
      changed = true;
    }
  }
  changed = pruneOldestEntries(state.requests, MAX_STORED_REQUESTS, request => Number(request?.createdAt || 0)) || changed;
  changed = pruneOldestEntries(state.cooldowns, MAX_STORED_COOLDOWN_KEYS, value => Number(value || 0)) || changed;
  changed = pruneOldestEntries(state.callCooldowns, MAX_STORED_COOLDOWN_KEYS, value => Number(value || 0)) || changed;
  return changed;
}

function loadShortcutStore() {
  if (storeCache) return storeCache;
  try {
    storeCache = normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
  } catch {
    storeCache = normalizeStore({});
  }
  if (pruneStore(storeCache)) saveShortcutStore();
  return storeCache;
}

function flushShortcutStore() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot = JSON.stringify((() => {
    const state = loadShortcutStore();
    pruneStore(state);
    return state;
  })(), null, 2);
  const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  const operation = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
    try {
      await fs.promises.writeFile(tempPath, snapshot, 'utf8');
      await fs.promises.rename(tempPath, STORE_PATH);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  });
  writeQueue = operation.catch(error => {
    console.error('تعذر حفظ مخزن اختصارات المسؤوليات:', error.message);
  });
  return operation.then(() => true, () => false);
}

function flushScheduledSave() {
  saveTimer = null;
  void flushShortcutStore();
}

function saveShortcutStore() {
  pruneStore(loadShortcutStore());
  if (!saveTimer) saveTimer = setTimeout(flushScheduledSave, SAVE_DEBOUNCE_MS);
  return true;
}

module.exports = { loadShortcutStore, saveShortcutStore, flushShortcutStore, STORE_PATH, STORE_TTL_MS };
