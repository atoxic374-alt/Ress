const fs = require('fs');
const path = require('path');
const { getDataDir, getBotConfigPath } = require('./storagePaths');

const allowConfigPath = path.join(getDataDir(), 'allowConfig.json');
const EMPTY_CONFIG = {
    rooms: { roles: [], users: [] },
    check: { roles: [], users: [] }
};

function normalizeIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value || '').replace(/[<@!>]/g, '').trim())
        .filter(value => /^\d{15,21}$/.test(value)))];
}

function normalizeConfig(input = {}) {
    const result = {
        rooms: {
            roles: normalizeIds(input.rooms?.roles),
            users: normalizeIds(input.rooms?.users)
        },
        check: {
            roles: normalizeIds(input.check?.roles),
            users: normalizeIds(input.check?.users)
        }
    };

    // دعم الإعداد القديم داخل botConfig أثناء أول ترحيل فقط.
    result.rooms.roles = normalizeIds([
        ...result.rooms.roles,
        ...(input.roomsAllowedRoles || [])
    ]);
    result.check.roles = normalizeIds([
        ...result.check.roles,
        ...(input.checkAllowedRoles || [])
    ]);
    return result;
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return raw.trim() ? JSON.parse(raw) : fallback;
    } catch (error) {
        console.error(`❌ تعذر قراءة ${filePath}:`, error.message || error);
        return fallback;
    }
}

function writeJson(filePath, value) {
    const tempPath = `${filePath}.tmp`;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
        return true;
    } catch (error) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        console.error(`❌ تعذر حفظ ${filePath}:`, error.message || error);
        return false;
    }
}

function loadAllowConfig() {
    if (fs.existsSync(allowConfigPath)) {
        return normalizeConfig(readJson(allowConfigPath, EMPTY_CONFIG));
    }

    const legacy = readJson(getBotConfigPath(), {});
    const migrated = normalizeConfig(legacy);
    writeJson(allowConfigPath, migrated);
    return migrated;
}

function saveAllowConfig(config) {
    return writeJson(allowConfigPath, normalizeConfig(config));
}

function getAllowConfigPath() {
    return allowConfigPath;
}

function updateAllow(command, type, id, action) {
    const config = loadAllowConfig();
    if (!config[command] || !['roles', 'users'].includes(type)) {
        return { ok: false, reason: 'invalid_target' };
    }

    const list = config[command][type];
    const value = String(id || '').replace(/[<@!>]/g, '').trim();
    if (!/^\d{15,21}$/.test(value)) return { ok: false, reason: 'invalid_id' };

    const index = list.indexOf(value);
    if (action === 'add') {
        if (index !== -1) return { ok: false, reason: 'exists', config };
        list.push(value);
    } else {
        if (index === -1) return { ok: false, reason: 'missing', config };
        list.splice(index, 1);
    }

    const saved = saveAllowConfig(config);
    return { ok: saved, reason: saved ? action : 'save_failed', config };
}

module.exports = {
    loadAllowConfig,
    saveAllowConfig,
    updateAllow,
    getAllowConfigPath
};
