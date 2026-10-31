const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const vacationManagerPath = require.resolve('./utils/vacationManager');
const originalLoad = Module._load;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ress-vacation-reconciliation-'));
const runtimeResponsibilitiesPath = path.join(tempDir, 'responsibilities.json');
const userId = '98765432109876543';
const otherUserId = '87654321098765432';
const responsibilityName = 'VacationReconcileTestOnly';
const roleId = '76543210987654321';
const previousGlobalResponsibilities = global.responsibilities;

const databaseData = {
    [responsibilityName]: {
        responsibles: [otherUserId],
        roles: [roleId]
    }
};
const directJsonData = {
    [responsibilityName]: {
        responsibles: [userId, otherUserId],
        roles: [roleId]
    }
};

fs.writeFileSync(runtimeResponsibilitiesPath, JSON.stringify(directJsonData, null, 2));

global.responsibilities = structuredClone(databaseData);

const fakeManager = {
    async getResponsibilities() {
        return structuredClone(databaseData);
    },
    async updateResponsibility(name, config) {
        databaseData[name] = structuredClone(config);
        global.responsibilities = structuredClone(databaseData);
        fs.writeFileSync(runtimeResponsibilitiesPath, JSON.stringify(databaseData, null, 2));
        return true;
    }
};

const fakeDatabase = { getDatabase: () => fakeManager };
const fakeStoragePaths = {
    getDataDir: () => tempDir,
    getDataFilePath: fileName => path.join(tempDir, fileName)
};

function mockModuleLoad(request, parent, isMain) {
    if (parent?.filename === vacationManagerPath && request === './storagePaths') return fakeStoragePaths;
    if (parent?.filename === vacationManagerPath && request === './database') return fakeDatabase;
    if (request === 'discord.js') return { EmbedBuilder: class EmbedBuilder {} };
    if (request === './colorManager' && parent?.filename === vacationManagerPath) return {};
    return originalLoad.call(this, request, parent, isMain);
}

async function run() {
    try {
        Module._load = mockModuleLoad;
        const vacationManager = require('./utils/vacationManager');
        const loadedResponsibilities = await vacationManager.getResponsibilitiesForVacation();
        const assignments = vacationManager.captureResponsibilityAssignments(loadedResponsibilities, userId);
        assert.deepEqual(assignments, [{ name: responsibilityName, index: 0, roleIds: [roleId] }]);

        const result = await vacationManager.removeUserFromResponsibilities(userId, assignments);
        assert.deepEqual(result.failed, []);
        assert.equal(databaseData[responsibilityName].responsibles.includes(userId), false);

        const savedJson = JSON.parse(fs.readFileSync(runtimeResponsibilitiesPath, 'utf8'));
        assert.equal(savedJson[responsibilityName].responsibles.includes(userId), false);
        assert.deepEqual(savedJson[responsibilityName].responsibles, [otherUserId]);

        console.log('Vacation responsibility reconciliation test passed.');
    } finally {
        Module._load = originalLoad;
        if (previousGlobalResponsibilities === undefined) delete global.responsibilities;
        else global.responsibilities = previousGlobalResponsibilities;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
