const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./storagePaths');

const ownersPath = path.join(getDataDir(), 'owners.json');

function normalizeIds(ids) {
    const values = Array.isArray(ids) ? ids : [];
    return [...new Set(values
        .map(value => String(value || '').replace(/[<@!>]/g, '').trim())
        .filter(id => /^\d{15,21}$/.test(id)))];
}

function normalizeStore(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        users: normalizeIds(source.users || source.owners),
        roles: normalizeIds(source.roles || source.ownerRoles)
    };
}

function loadOwners() {
    try {
        if (!fs.existsSync(ownersPath)) {
            const defaults = { users: [], roles: [] };
            fs.mkdirSync(path.dirname(ownersPath), { recursive: true });
            fs.writeFileSync(ownersPath, JSON.stringify(defaults, null, 2));
            return defaults;
        }
        return normalizeStore(JSON.parse(fs.readFileSync(ownersPath, 'utf8')));
    } catch (error) {
        console.error('خطأ في قراءة owners.json:', error);
        return { users: [], roles: [] };
    }
}

function saveOwners(value = {}) {
    const normalized = normalizeStore(value);
    const tempPath = `${ownersPath}.tmp`;
    try {
        fs.mkdirSync(path.dirname(ownersPath), { recursive: true });
        fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
        fs.renameSync(tempPath, ownersPath);
        return normalized;
    } catch (error) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        console.error('خطأ في حفظ owners.json:', error);
        return loadOwners();
    }
}

function isOwnerMember(member, owners = loadOwners()) {
    if (!member) return false;
    const userId = String(member.id || member.user?.id || '');
    if (owners.users.includes(userId)) return true;
    return Boolean(member.roles?.cache && owners.roles.some(roleId => member.roles.cache.has(roleId)));
}

module.exports = { ownersPath, normalizeIds, loadOwners, saveOwners, isOwnerMember };
