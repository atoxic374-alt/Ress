const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const problemSettingsPath = path.join(dataDir, 'problemSettings.json');
const activeProblemsPath = path.join(dataDir, 'activeProblems.json');
const problemLogsPath = path.join(dataDir, 'problemLogs.json');

function readJson(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return defaultValue;
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
        return defaultValue;
    }
}

function writeJson(filePath, data) {
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
        return false;
    }
}

class ProblemManager {
    constructor() {
        this.ensureDataFiles();
        this.client = null;
    }

    setClient(client) {
        this.client = client;
    }

    ensureDataFiles() {
        if (!fs.existsSync(problemSettingsPath)) {
            const defaultSettings = {
                menuChannel: null,
                logChannel: null,
                allowedUsers: {
                    type: null,
                    targets: []
                }
            };
            writeJson(problemSettingsPath, defaultSettings);
        }

        if (!fs.existsSync(activeProblemsPath)) {
            writeJson(activeProblemsPath, {});
        }

        if (!fs.existsSync(problemLogsPath)) {
            writeJson(problemLogsPath, []);
        }
    }

    getSettings() {
        return readJson(problemSettingsPath, {
            menuChannel: null,
            logChannel: null,
            allowedUsers: {
                type: null,
                targets: []
            }
        });
    }

    updateSettings(newSettings) {
        return writeJson(problemSettingsPath, newSettings);
    }

    async hasPermission(userId, guild, botOwners) {
        const settings = this.getSettings();

        if (botOwners.includes(userId)) return true;
        if (guild.ownerId === userId) return true;

        if (!settings.allowedUsers.type) return false;

        switch (settings.allowedUsers.type) {
            case 'owners':
                return botOwners.includes(userId);

            case 'roles':
                try {
                    const member = await guild.members.fetch(userId);
                    const userRoles = member.roles.cache.map(role => role.id);
                    return settings.allowedUsers.targets.some(roleId => userRoles.includes(roleId));
                } catch {
                    return false;
                }

            case 'responsibility':
                const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
                const responsibilities = readJson(responsibilitiesPath, {});

                for (const respName of settings.allowedUsers.targets) {
                    const respData = responsibilities[respName];
                    if (respData && respData.responsibles && respData.responsibles.includes(userId)) {
                        return true;
                    }
                }
                return false;
        }

        return false;
    }

    getActiveProblems() {
        return readJson(activeProblemsPath, {});
    }

    createProblem(guildId, parties, reason, createdBy) {
        const activeProblems = this.getActiveProblems();
        const problemId = `problem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const problemRecord = {
            id: problemId,
            guildId: guildId,
            parties: parties,
            reason: reason,
            createdBy: createdBy,
            createdAt: Date.now(),
            status: 'active',
            violations: []
        };

        activeProblems[problemId] = problemRecord;
        writeJson(activeProblemsPath, activeProblems);

        this.logAction('PROBLEM_CREATED', {
            problemId,
            parties,
            reason,
            createdBy,
            timestamp: Date.now()
        });

        return { success: true, problemId, record: problemRecord };
    }

    deleteProblem(problemId) {
        const activeProblems = this.getActiveProblems();

        if (!activeProblems[problemId]) {
            return { success: false, error: 'البروبليم غير موجود' };
        }

        const problemRecord = activeProblems[problemId];
        delete activeProblems[problemId];
        writeJson(activeProblemsPath, activeProblems);

        this.logAction('PROBLEM_DELETED', {
            problemId,
            parties: problemRecord.parties,
            deletedAt: Date.now()
        });

        return { success: true };
    }

    deleteAllProblems(guildId) {
        const activeProblems = this.getActiveProblems();
        let deletedCount = 0;

        for (const [problemId, problem] of Object.entries(activeProblems)) {
            if (problem.guildId === guildId) {
                delete activeProblems[problemId];
                deletedCount++;
            }
        }

        writeJson(activeProblemsPath, activeProblems);

        this.logAction('ALL_PROBLEMS_DELETED', {
            guildId,
            deletedCount,
            timestamp: Date.now()
        });

        return { success: true, deletedCount };
    }

    reactivateProblem(problemId) {
        const activeProblems = this.getActiveProblems();

        if (!activeProblems[problemId]) {
            return { success: false, error: 'البروبليم غير موجود' };
        }

        activeProblems[problemId].status = 'active';
        activeProblems[problemId].violations = [];
        writeJson(activeProblemsPath, activeProblems);

        return { success: true };
    }

    addViolation(problemId, violatorId, type, messageLink = null) {
        const activeProblems = this.getActiveProblems();

        if (!activeProblems[problemId]) {
            return { success: false, error: 'البروبليم غير موجود' };
        }

        const violation = {
            violatorId,
            type,
            messageLink,
            timestamp: Date.now()
        };

        activeProblems[problemId].violations.push(violation);
        writeJson(activeProblemsPath, activeProblems);

        return { success: true, violation };
    }

    checkIfInProblem(userId1, userId2, guildId) {
        const activeProblems = this.getActiveProblems();

        for (const [problemId, problem] of Object.entries(activeProblems)) {
            if (problem.guildId === guildId) {
                if (problem.parties.includes(userId1) && problem.parties.includes(userId2)) {
                    return { inProblem: true, problemId, problem };
                }
            }
        }

        return { inProblem: false };
    }

    getUserProblems(userId, guildId) {
        const activeProblems = this.getActiveProblems();
        const userProblems = [];

        for (const [problemId, problem] of Object.entries(activeProblems)) {
            if (problem.guildId === guildId && problem.parties.includes(userId)) {
                userProblems.push({ problemId, ...problem });
            }
        }

        return userProblems;
    }

    getGuildProblems(guildId) {
        const activeProblems = this.getActiveProblems();
        const guildProblems = [];

        for (const [problemId, problem] of Object.entries(activeProblems)) {
            if (problem.guildId === guildId) {
                guildProblems.push({ problemId, ...problem });
            }
        }

        return guildProblems;
    }

    getStatistics(guildId) {
        const activeProblems = this.getActiveProblems();
        const logs = readJson(problemLogsPath, []);

        let totalProblems = 0;
        let activeCount = 0;
        let violatedCount = 0;
        let totalViolations = 0;

        for (const [_, problem] of Object.entries(activeProblems)) {
            if (problem.guildId === guildId) {
                totalProblems++;
                if (problem.status === 'active') activeCount++;
                if (problem.status === 'violated') violatedCount++;
                totalViolations += problem.violations ? problem.violations.length : 0;
            }
        }

        const guildLogs = logs.filter(log => {
            if (log.data && log.data.problemId) {
                const problem = activeProblems[log.data.problemId];
                return problem && problem.guildId === guildId;
            }
            return log.data && log.data.guildId === guildId;
        });

        return {
            totalProblems,
            activeCount,
            violatedCount,
            totalViolations,
            totalLogs: guildLogs.length
        };
    }

    logAction(type, data) {
        const logs = readJson(problemLogsPath, []);
        logs.push({
            type,
            data,
            timestamp: Date.now()
        });

        if (logs.length > 500) {
            logs.splice(0, logs.length - 500);
        }

        writeJson(problemLogsPath, logs);
    }

    getLogs() {
        return readJson(problemLogsPath, []);
    }
}

module.exports = new ProblemManager();
