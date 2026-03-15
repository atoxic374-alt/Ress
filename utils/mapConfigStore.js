const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'data', 'serverMapConfig.json');
let writeQueue = Promise.resolve();

function normalizeLegacy(data) {
    if (data && data.imageUrl && !data.global) {
        return { global: data };
    }
    return data || {};
}

function loadMapConfigsSync() {
    try {
        if (!fs.existsSync(configPath)) return {};
        return normalizeLegacy(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch (e) {
        console.error('Error reading serverMapConfig:', e.message);
        return {};
    }
}

function writeMapConfigsSync(allConfigs) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(allConfigs, null, 2));
        return true;
    } catch (e) {
        console.error('Error writing serverMapConfig:', e.message);
        return false;
    }
}

function writeMapConfigsQueued(allConfigs) {
    writeQueue = writeQueue
        .then(async () => {
            fs.writeFileSync(configPath, JSON.stringify(allConfigs, null, 2));
            return true;
        })
        .catch(err => {
            console.error('Error queued-writing serverMapConfig:', err);
            return false;
        });
    return writeQueue;
}

module.exports = {
    configPath,
    loadMapConfigsSync,
    writeMapConfigsSync,
    writeMapConfigsQueued
};
