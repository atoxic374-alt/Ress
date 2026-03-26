const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const backupsDir = path.join(__dirname, '..', 'backups');


/**
 * نظام إدارة التوازي الذكي (Smart Concurrency Manager)
 * يقوم بتنفيذ المهام بأقصى سرعة ممكنة مع مراقبة حية للـ Rate Limits
 */
function pLimit(concurrency) {
    const queue = [];
    let activeCount = 0;
    let isPaused = false;
    let pauseTimer = null;

    const next = () => {
        activeCount--;
        if (queue.length > 0 && !isPaused) {
            const run = queue.shift();
            run();
        }
    };

    const limit = (fn) => new Promise((resolve, reject) => {
        const run = async () => {
            if (isPaused) {
                queue.push(run);
                return;
            }

            activeCount++;
            try {
                const result = await fn();
                resolve(result);
            } catch (error) {
                // إذا واجهنا Rate Limit حقيقي من ديسكورد (429)
                if (error.status === 429 || error.code === 429) {
                    const retryAfter = (error.retryAfter || 5) * 1000;
                    if (!isPaused) {
                        isPaused = true;
                        console.log(`[RateLimit] نظام الحماية الذكي تفعل: تهدئة لمدة ${retryAfter}ms`);
                        if (pauseTimer) clearTimeout(pauseTimer);
                        pauseTimer = setTimeout(() => {
                            isPaused = false;
                            console.log(`[RateLimit] استئناف العمل بأقصى سرعة...`);
                            while (queue.length > 0 && activeCount < concurrency) {
                                const nextRun = queue.shift();
                                nextRun();
                            }
                        }, retryAfter);
                    }
                    queue.unshift(run); // إعادة المحاولة لاحقاً
                    activeCount--;
                    return;
                }
                reject(error);
            } finally {
                if (!isPaused) next();
            }
        };

        if (activeCount < concurrency && !isPaused) run();
        else queue.push(run);
    });

    return limit;
}

async function ensureBackupsDir() {
    try {
        await fs.promises.access(backupsDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.promises.mkdir(backupsDir, { recursive: true });
        } else {
            throw error;
        }
    }
}
ensureBackupsDir();

async function readJSON(filePath, defaultValue = {}) {
    try {
        await fs.promises.access(filePath);
        const fileContent = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        if (error.code === 'ENOENT') { // File not found
            return defaultValue;
        }
        console.error(`خطأ في قراءة ${filePath}:`, error);
        return defaultValue;
    }
}

async function saveJSON(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true }).catch(err => { if (err.code !== 'EEXIST') throw err; });
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`خطأ في حفظ ${filePath}:`, error);
        return false;
    }
}

async function getDataJsonFiles() {
    const files = [];
    const stack = [''];

    while (stack.length > 0) {
        const relativeDir = stack.pop();
        const absDir = path.join(dataDir, relativeDir);
        let entries = [];

        try {
            entries = await fs.promises.readdir(absDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const relativePath = path.join(relativeDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(relativePath);
                continue;
            }

            if (entry.isFile() && entry.name.endsWith(".json")) {
                files.push(relativePath);
            }
        }
    }

    return files;
}


const protectionConfigPath = path.join(dataDir, 'protection.json');
let protectionConfigCache = null; // Cache for protection config
// أقصى سرعة تقنية مسموح بها مع نظام الحماية الذكي
// الرقم 40 هو "المنطقة الذهبية" (Sweet Spot) التي تعطي أداءً جباراً دون استفزاز نظام الحماية الأساسي لديسكورد
const DEFAULT_CONCURRENCY = 40; 
const protectionRuntime = {
    listenersInstalled: false,
    snapshotIntervals: new Map(),
    activeRestores: new Set(),
    pendingRestores: new Set(),
    removedAdminRoles: new Map(),
    mutedAdminRoles: new Map(),
    bulkRestoreSessions: new Map(),
    bulkRestoreSessionTimeouts: new Map(),
    allowedRoleAdminRestore: new Set(),
    protectionBootstrapped: false,
    botOwners: [] // سيتم تعبئتها عند التشغيل
};

function hasDangerousRolePermissions(role) {
    if (!role) return false;
    return role.permissions.has(PermissionFlagsBits.Administrator) ||
        role.permissions.has(PermissionFlagsBits.ManageGuild) ||
        role.permissions.has(PermissionFlagsBits.ManageRoles) ||
        role.permissions.has(PermissionFlagsBits.BanMembers) ||
        role.permissions.has(PermissionFlagsBits.KickMembers);
}

function isOwnerOrBotOwner(guild, userId) {
    if (!guild || !userId) return false;
    if (userId === guild.ownerId) return true;
    return (protectionRuntime.botOwners || []).includes(userId);
}

function buildStatusLine(text) {
    return `\n\n🕒 ${new Date().toISOString()}\n${text}`;
}

async function updateAlertMessages(client, sentAlerts = [], appendText = '', { disableButtons = false } = {}) {
    if (!sentAlerts || sentAlerts.length === 0) return;

    for (const alert of sentAlerts) {
        try {
            const channel = await client.channels.fetch(alert.channelId).catch(() => null);
            const message = channel ? await channel.messages.fetch(alert.messageId).catch(() => null) : null;
            if (!message) continue;

            const nextContent = message.content.includes(appendText) ? message.content : (message.content + appendText);
            let nextComponents = message.components;
            if (disableButtons && message.components?.length) {
                nextComponents = message.components.map(row => new ActionRowBuilder().addComponents(
                    row.components.map(component => ButtonBuilder.from(component).setDisabled(true))
                ));
            }

            await message.edit({ content: nextContent, components: nextComponents }).catch(() => null);
        } catch (err) {
            console.error("Failed to update alert message:", err);
        }
    }
}

function getCurrentRoleCount(guild) {
    return guild.roles.cache.filter(role => !role.managed && role.id !== guild.id).size;
}

function getCurrentChannelCount(guild) {
    return guild.channels.cache.filter(ch => !ch.isThread()).size;
}

async function getProtectionConfigAll() {
    if (!protectionConfigCache) {
        protectionConfigCache = await readJSON(protectionConfigPath, {});
    }
    return protectionConfigCache;
}

async function getGuildProtectionConfig(guildId) {
    const allConfig = await getProtectionConfigAll();
    return allConfig[guildId] || null;
}

async function setGuildProtectionConfig(guildId, config) {
    const all = await getProtectionConfigAll();
    if (!config.maxSnapshots) {
        config.maxSnapshots = 5; // Default to keeping 5 snapshots
    }
    all[guildId] = config;
    protectionConfigCache = all; // Update cache
    await saveJSON(protectionConfigPath, all);
}

async function getRecentExecutorId(guild, actionType) {
    try {
        const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
        const entry = logs.entries.first();
        if (!entry?.executor) return null;
        if (Date.now() - entry.createdTimestamp > 15000) return null;
        return entry.executor.id;
    } catch {
        return null;
    }
}


function isMajorProtectionIncident(guild, cfg) {
    const expectedChannels = cfg?.expectedChannels || 0;
    const expectedRoles = cfg?.expectedRoles || 0;
    const channelRatio = expectedChannels > 0 ? (getCurrentChannelCount(guild) / expectedChannels) : 1;
    const roleRatio = expectedRoles > 0 ? (getCurrentRoleCount(guild) / expectedRoles) : 1;

    const channelsMajor = cfg?.protectionTypes?.channelsCategories && channelRatio <= 0.75;
    const rolesMajor = cfg?.protectionTypes?.rolesPermissions && roleRatio <= 0.75;
    return channelsMajor || rolesMajor;
}

/**
 * نظام الاستجابة الفورية (Instant Overclocked Response)
 * يقوم بتشغيل جميع مراحل الحماية (عزل، عقاب، إعادة بناء) في نفس اللحظة بالتوازي
 */
async function processProtectionIncident(guild, cfg, actor, reason, restoreReason = reason) {
    const majorIncident = isMajorProtectionIncident(guild, cfg);
    const punishMode = majorIncident ? 'hard' : 'soft';
    const incidentReason = `Unauthorized ${reason}`;

    // تشغيل فوري لجميع المهام دون انتظار الواحدة للأخرى
    // هذا يضمن أن "إعادة البناء" تبدأ في نفس الملي ثانية التي يتم فيها "سحب الصلاحيات"
    const tasks = [
        punishExecutor(guild, actor, incidentReason, cfg.trustedUsers || [], punishMode),
        runProtectionRestore(guild, cfg, restoreReason)
    ];

    if (majorIncident) {
        // في الحوادث الكبرى، يتم تفعيل العزل الشامل فوراً
        tasks.push(disableAdministratorEverywhere(guild, `Protection: ${reason} lockdown`));
    }

    // تنفيذ متوازي حقيقي (Fire and Forget for maximum speed)
    Promise.allSettled(tasks).catch(err => console.error('[Protection] Critical error in parallel tasks:', err));
}

function formatActorText(userId, displayName = 'Unknown User', canMention = false) {
    if (canMention && userId) return `<@${userId}> (${displayName})`;
    return displayName;
}

async function punishExecutor(guild, userId, reason, trustedUsers = [], mode = 'soft', fallbackName = 'Unknown User') {
    if (!userId || trustedUsers.includes(userId) || userId === guild.ownerId || userId === guild.client.user.id) return;
    const member = await guild.members.fetch(userId).catch(err => { console.error(`Failed to fetch member ${userId}:`, err); return null; });
    const userObject = await guild.client.users.fetch(userId).catch(err => { console.error(`Failed to fetch user ${userId}:`, err); return null; });
    const actorName = member?.displayName || userObject?.globalName || userObject?.username || fallbackName;

    if (member) {
        const adminRoles = member.roles.cache.filter(r => r.permissions.has(PermissionFlagsBits.Administrator));
        if (adminRoles.size > 0) {
            protectionRuntime.removedAdminRoles.set(`${guild.id}:${userId}`, {
                roleIds: adminRoles.map(r => r.id),
                removedAt: Date.now(),
                reason,
                actorName,
                mode
            });
            await member.roles.remove(adminRoles.map(r => r.id)).catch(err => console.error(`Failed to remove admin roles for user ${userId} in guild ${guild.id}:`, err));
        }

        if (mode === 'hard') {
            await member.kick(`Protection: ${reason}`).catch(err => console.error(`Failed to kick user ${userId} from guild ${guild.id}:`, err));
        }
    }

    const owner = await guild.fetchOwner().catch(err => { console.error(`Failed to fetch guild owner for guild ${guild.id}:`, err); return null; });
    const recipients = [owner].filter(Boolean);
    
    // إضافة ملاك البوت إلى قائمة المستلمين
    for (const ownerId of (protectionRuntime.botOwners || [])) {
        if (ownerId === guild.ownerId) continue;
        const botOwner = await guild.client.users.fetch(ownerId).catch(() => null);
        if (botOwner) recipients.push(botOwner);
    }

    const isHard = mode === 'hard';
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${isHard ? 'restore_admin_roles_bulk_' : 'restore_admin_roles_'}${guild.id}:${userId || 'bulk'}`)
            .setLabel(isHard ? 'Restore All Admin Permissions' : 'Restore Admin Roles')
            .setStyle(ButtonStyle.Danger)
    );

    const alertContent = `⚠️ Protection alert in **${guild.name}**
Actor: ${formatActorText(userId, actorName, Boolean(userObject || member))}
Reason: ${reason}`;

    const sentMessages = [];
    for (const recipient of recipients) {
        const dmMessage = await recipient.send({
            content: alertContent,
            components: [row]
        }).catch(err => {
            console.error(`Failed to send DM to ${recipient.id}:`, err);
            return null;
        });
        if (dmMessage) sentMessages.push({ channelId: dmMessage.channel.id, messageId: dmMessage.id });
    }

    if (sentMessages.length > 0 && userId) {
        const key = `${guild.id}:${userId}`;
        const existing = protectionRuntime.removedAdminRoles.get(key);
        if (existing) {
            existing.sentAlerts = sentMessages;
            protectionRuntime.removedAdminRoles.set(key, existing);
        }
    }
}

async function disableAdministratorEverywhere(guild, reason = 'Protection global admin lockdown') {
    const adminRoles = guild.roles.cache.filter(role => !role.managed && role.id !== guild.id && role.permissions.has(PermissionFlagsBits.Administrator));
    if (!adminRoles.size) return { mutedRoles: 0 };

    const rolesArray = Array.from(adminRoles.values());
    const owner = await guild.fetchOwner().catch(() => null);
    const recipients = [owner].filter(Boolean);
    for (const ownerId of (protectionRuntime.botOwners || [])) {
        if (ownerId === guild.ownerId) continue;
        const botOwner = await guild.client.users.fetch(ownerId).catch(() => null);
        if (botOwner) recipients.push(botOwner);
    }

    await executeParallel(rolesArray, async (role) => {
        const memberIds = role.members.map(m => m.id).slice(0, 5000);
        const key = `${guild.id}:${role.id}`;
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`restore_admin_roles_bulk_${guild.id}:bulk`)
                .setLabel('Restore All Admin Permissions')
                .setStyle(ButtonStyle.Danger)
        );

        const alertContent = `🚨 **Global Lockdown** in **${guild.name}**
Role: **${role.name}**
Reason: ${reason}
Status: Administrator permission removed from all roles.`;

        const sentMessages = [];
        for (const recipient of recipients) {
            const dmMessage = await recipient.send({
                content: alertContent,
                components: [row]
            }).catch(() => null);
            if (dmMessage) sentMessages.push({ channelId: dmMessage.channel.id, messageId: dmMessage.id });
        }

        protectionRuntime.mutedAdminRoles.set(key, {
            roleId: role.id,
            oldPermissions: role.permissions.bitfield.toString(),
            roleName: role.name,
            mutedAt: Date.now(),
            reason,
            memberIds,
            sentAlerts: sentMessages
        });

        const newPermissions = role.permissions.remove(PermissionFlagsBits.Administrator);
        await role.setPermissions(newPermissions, reason).catch(err => console.error(`Failed to set permissions for role ${role.id} in guild ${guild.id}:`, err));
    }, DEFAULT_CONCURRENCY);

    return { mutedRoles: rolesArray.length };
}

function buildBulkRestoreComponents(guild, session) {
    const entries = Array.from(protectionRuntime.removedAdminRoles.entries())
        .filter(([key]) => key.startsWith(`${guild.id}:`))
        .map(([key, payload]) => {
            const targetId = key.split(':')[1];
            return { key, payload, targetId };
        });

    const mutedRoleEntries = Array.from(protectionRuntime.mutedAdminRoles.entries())
        .filter(([key]) => key.startsWith(`${guild.id}:`))
        .map(([key, payload]) => payload);

    const rolePool = new Map();
    entries.forEach(({ payload }) => {
        (payload.roleIds || []).forEach(roleId => {
            const role = guild.roles.cache.get(roleId);
            if (role) rolePool.set(roleId, role);
        });
    });

    mutedRoleEntries.forEach((payload) => {
        const role = guild.roles.cache.get(payload.roleId);
        if (role) rolePool.set(payload.roleId, role);
    });

    const roleOptions = Array.from(rolePool.values())
        .sort((a, b) => b.position - a.position)
        .slice(0, 25)
        .map(role => ({
            label: role.name.slice(0, 100),
            value: role.id,
            description: `ID: ${role.id}`.slice(0, 100),
            default: session.excludedRoleIds.has(role.id)
        }));

    const userPool = new Map();
    entries.forEach(({ targetId, payload }) => {
        const member = guild.members.cache.get(targetId);
        const username = member?.displayName || payload.actorName || `User ${targetId}`;
        userPool.set(targetId, {
            label: username.slice(0, 100),
            value: targetId,
            description: `ID: ${targetId}`.slice(0, 100),
            default: session.excludedUserIds.has(targetId)
        });
    });

    mutedRoleEntries.forEach((payload) => {
        (payload.memberIds || []).forEach((memberId) => {
            if (userPool.has(memberId)) return;
            const member = guild.members.cache.get(memberId);
            const username = member?.displayName || `User ${memberId}`;
            userPool.set(memberId, {
                label: username.slice(0, 100),
                value: memberId,
                description: `ID: ${memberId}`.slice(0, 100),
                default: session.excludedUserIds.has(memberId)
            });
        });
    });

    const userOptions = Array.from(userPool.values()).slice(0, 25);

    const rows = [];
    if (roleOptions.length) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`restore_bulk_roles_${session.id}`)
                .setPlaceholder('استثناء رولات من الاستعادة')
                .setMinValues(0)
                .setMaxValues(roleOptions.length)
                .addOptions(roleOptions)
        ));
    }

    if (userOptions.length) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`restore_bulk_users_${session.id}`)
                .setPlaceholder('استثناء أعضاء من الاستعادة')
                .setMinValues(0)
                .setMaxValues(userOptions.length)
                .addOptions(userOptions)
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`restore_bulk_confirm_${session.id}`).setLabel('تأكيد الاستعادة').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`restore_bulk_cancel_${session.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
    ));

    return rows;
}

async function restoreAdminRolesWithFilters(guild, excludedRoleIds = new Set(), excludedUserIds = new Set(), restoredByUserId = null) {
    const entries = Array.from(protectionRuntime.removedAdminRoles.entries())
        .filter(([key]) => key.startsWith(`${guild.id}:`));
    const mutedEntries = Array.from(protectionRuntime.mutedAdminRoles.entries())
        .filter(([key]) => key.startsWith(`${guild.id}:`));

    let restoredRoles = 0;
    let restoredMembers = 0;

    for (const [entryKey, payload] of entries) {
        const targetId = entryKey.split(':')[1];
        if (excludedUserIds.has(targetId)) continue;

        const member = await guild.members.fetch(targetId).catch(err => { console.error(`Failed to fetch target member ${targetId}:`, err); return null; });
        if (!member) continue;

        const validRoleIds = (payload.roleIds || [])
            .filter(roleId => !excludedRoleIds.has(roleId))
            .filter(roleId => guild.roles.cache.has(roleId));

        if (!validRoleIds.length) continue;

        await member.roles.add(validRoleIds, `Owner requested admin-role restore (${payload.reason || 'protection'})`).catch(err => console.error(`Failed to add admin roles for user ${member.id} in guild ${guild.id}:`, err));
        await updateAlertMessages(guild.client, payload.sentAlerts, buildStatusLine(`✅ **تمت الاستعادة عن طريق:** <@${restoredByUserId || guild.client.user.id}>\n**الحالة:** تم استعادة الرولات عبر الزر الجماعي.`), { disableButtons: true });
        protectionRuntime.removedAdminRoles.delete(entryKey);
        restoredRoles += validRoleIds.length;
        restoredMembers += 1;
    }

    const restoredAdminRoleIds = [];
    await executeParallel(mutedEntries, async ([entryKey, payload]) => {
        const role = guild.roles.cache.get(payload.roleId);
        if (!role || excludedRoleIds.has(payload.roleId)) return;
        protectionRuntime.allowedRoleAdminRestore.add(`${guild.id}:${role.id}`);
        await role.setPermissions(BigInt(payload.oldPermissions), 'Owner requested global admin permission restore').catch(err => console.error(`Failed to restore global admin permissions for role ${role.id} in guild ${guild.id}:`, err));
        protectionRuntime.allowedRoleAdminRestore.delete(`${guild.id}:${role.id}`);
        protectionRuntime.mutedAdminRoles.delete(entryKey);
        await updateAlertMessages(guild.client, payload.sentAlerts, buildStatusLine(`✅ **الحالة:** تم استعادة صلاحية Administrator للرول عن طريق <@${restoredByUserId || guild.client.user.id}>.`), { disableButtons: true });
        restoredAdminRoleIds.push(payload.roleId);
        restoredRoles += 1;
    }, DEFAULT_CONCURRENCY);

    if (excludedUserIds.size > 0 && restoredAdminRoleIds.length > 0) {
        await executeParallel(Array.from(excludedUserIds), async (memberId) => {
            const member = await guild.members.fetch(memberId).catch(err => { console.error(`Failed to fetch member ${memberId} for role removal:`, err); return null; });
            if (!member) return;
            const rolesToRemove = restoredAdminRoleIds.filter(roleId => member.roles.cache.has(roleId));
            if (rolesToRemove.length) {
                await member.roles.remove(rolesToRemove, 'Excluded user from admin role restore').catch(err => console.error(`Failed to remove excluded roles for user ${member.id} in guild ${guild.id}:`, err));
            }
        }, DEFAULT_CONCURRENCY);
    }

    return { restoredRoles, restoredMembers };
}

async function disableSourceButtons(interaction) {
    const message = interaction?.message;
    if (!message?.components?.length) return;

    try {
        const disabledRows = message.components.map(row => new ActionRowBuilder().addComponents(
            row.components.map(component => ButtonBuilder.from(component).setDisabled(true))
        ));
        await message.edit({ components: disabledRows }).catch(err => console.error(`Failed to edit message ${message.id}:`, err));
    } catch {}
}

async function handleRestoreAdminRoles(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('restore_admin_roles_')) return false;

    const parts = interaction.customId.replace('restore_admin_roles_', '').split(':');
    const guildId = parts[0];
    const targetId = parts[1];

    if (!guildId) {
        await interaction.reply({ content: '❌ Invalid request.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (invalid request):', err));
        return true;
    }

    const guild = interaction.client.guilds.cache.get(guildId) || await interaction.client.guilds.fetch(guildId).catch(err => { console.error(`Failed to fetch guild ${guildId} for interaction:`, err); return null; });
    if (!guild) {
        await interaction.reply({ content: '❌ Guild not found.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (guild not found):', err));
        return true;
    }

    if (!isOwnerOrBotOwner(guild, interaction.user.id)) {
        await interaction.reply({ content: '❌ This button is only for the server owner or bot owners.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (not owner):', err));
        return true;
    }

    const entryKey = `${guild.id}:${targetId}`;
    const payload = protectionRuntime.removedAdminRoles.get(entryKey);

    if (!payload) {
        await interaction.reply({ content: '⚠️ No stored admin roles to restore or already restored.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (no stored roles):', err));
        return true;
    }

    const member = await guild.members.fetch(targetId).catch(err => { console.error(`Failed to fetch target member ${targetId}:`, err); return null; });
    if (!member) {
        await updateAlertMessages(interaction.client, payload.sentAlerts, buildStatusLine(`⚠️ **فشل الاستعادة:** العضو <@${targetId}> غير موجود في السيرفر (قد يكون مطرود/خارج السيرفر).`));
        await interaction.reply({ content: `⚠️ ${payload.actorName || targetId} غير موجود الآن داخل السيرفر.`, ephemeral: true }).catch(err => console.error('Failed to reply to interaction (member not found):', err));
        return true;
    }

    const validRoleIds = (payload.roleIds || [])
        .filter(roleId => guild.roles.cache.has(roleId))
        .filter(roleId => {
            const role = guild.roles.cache.get(roleId);
            return role && hasDangerousRolePermissions(role);
        });
    if (validRoleIds.length === 0) {
        await updateAlertMessages(interaction.client, payload.sentAlerts, buildStatusLine('⚠️ **فشل الاستعادة:** الرولات المحفوظة لم تعد متاحة أو لم تعد خطيرة/إدارية.'));
        await interaction.reply({ content: '⚠️ Stored admin roles are no longer available.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (roles unavailable):', err));
        return true;
    }

    await member.roles.add(validRoleIds, `Owner/BotOwner requested admin-role restore (${payload.reason || 'protection'})`).catch(err => console.error(`Failed to add admin roles for user ${member.id} in guild ${guild.id}:`, err));

    await updateAlertMessages(interaction.client, payload.sentAlerts, buildStatusLine(`✅ **تمت الاستعادة عن طريق:** <@${interaction.user.id}>\n**الحالة:** تم استعادة الرولات بنجاح.`), { disableButtons: true });

    protectionRuntime.removedAdminRoles.delete(entryKey);
    await interaction.reply({ content: `✅ Restored ${validRoleIds.length} admin role(s) for ${member.displayName}. تم تحديث الحالة عند الجميع.`, ephemeral: true }).catch(err => console.error('Failed to reply to interaction (restore success):', err));
    return true;
}

async function handleBulkRestoreAdminRoles(interaction) {
    const customId = interaction.customId || '';

    if (interaction.isButton() && customId.startsWith('restore_admin_roles_bulk_')) {
        const guildId = customId.replace('restore_admin_roles_bulk_', '').split(':')[0];
        const guild = interaction.client.guilds.cache.get(guildId) || await interaction.client.guilds.fetch(guildId).catch(err => { console.error(`Failed to fetch guild ${guildId} for interaction:`, err); return null; });
        if (!guild) {
            await interaction.reply({ content: '❌ Guild not found.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (guild not found):', err));
            return true;
        }

        if (!isOwnerOrBotOwner(guild, interaction.user.id)) {
            await interaction.reply({ content: '❌ This button is only for the server owner or bot owners.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (not owner):', err));
            return true;
        }

        const entries = Array.from(protectionRuntime.removedAdminRoles.entries()).filter(([key]) => key.startsWith(`${guild.id}:`));
        if (!entries.length) {
            await interaction.reply({ content: '⚠️ لا توجد صلاحيات محفوظة للاستعادة.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (no saved permissions):', err));
            return true;
        }

        const sessionId = `${guild.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const session = {
            id: sessionId,
            guildId: guild.id,
            ownerId: interaction.user.id,
            excludedRoleIds: new Set(),
            excludedUserIds: new Set(),
            createdAt: Date.now(),
            expiresAt: Date.now() + (15 * 60 * 1000) // 15 minutes TTL
        };
        protectionRuntime.bulkRestoreSessions.set(sessionId, session);
        protectionRuntime.bulkRestoreSessionTimeouts.set(sessionId, setTimeout(() => {
            protectionRuntime.bulkRestoreSessions.delete(sessionId);
            protectionRuntime.bulkRestoreSessionTimeouts.delete(sessionId);
            console.log(`Bulk restore session ${sessionId} expired and was cleaned up.`);
        }, 15 * 60 * 1000));

        const rows = buildBulkRestoreComponents(guild, session);
        await interaction.reply({
            ephemeral: true,
            content: 'اختر الاستثناءات (الرولات/الأعضاء) ثم اضغط تأكيد الاستعادة.',
            components: rows
        }).catch(err => console.error("Failed to restore members:", err));
        await disableSourceButtons(interaction);
        return true;
    }

    if (interaction.isStringSelectMenu() && (customId.startsWith('restore_bulk_roles_') || customId.startsWith('restore_bulk_users_'))) {
        const sessionId = customId.replace('restore_bulk_roles_', '').replace('restore_bulk_users_', '');
        const session = protectionRuntime.bulkRestoreSessions.get(sessionId);
        if (!session) {
            await interaction.reply({ content: '⚠️ انتهت الجلسة.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (session ended):', err));
            return true;
        }

        if (interaction.user.id !== session.ownerId) {
            await interaction.reply({ content: '❌ هذه الجلسة مخصصة لمالك السيرفر فقط.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (session not owner):', err));
            return true;
        }

        const guild = interaction.client.guilds.cache.get(session.guildId) || await interaction.client.guilds.fetch(session.guildId).catch(err => { console.error(`Failed to fetch guild ${session.guildId} for bulk restore session:`, err); return null; });
        if (!guild) {
            await interaction.reply({ content: '❌ Guild not found.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (guild not found):', err));
            return true;
        }

        if (customId.startsWith('restore_bulk_roles_')) {
            session.excludedRoleIds = new Set(interaction.values);
        } else {
            session.excludedUserIds = new Set(interaction.values);
        }

        const rows = buildBulkRestoreComponents(guild, session);
        await interaction.update({
            content: 'تم تحديث الاستثناءات. اضغط تأكيد الاستعادة عند الجاهزية.',
            components: rows
        }).catch(err => console.error("Failed to restore members:", err));
        return true;
    }

    if (interaction.isButton() && (customId.startsWith('restore_bulk_confirm_') || customId.startsWith('restore_bulk_cancel_'))) {
        const sessionId = customId.replace('restore_bulk_confirm_', '').replace('restore_bulk_cancel_', '');
        const session = protectionRuntime.bulkRestoreSessions.get(sessionId);
        if (!session) {
            await interaction.reply({ content: '⚠️ انتهت الجلسة.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (session ended):', err));
            return true;
        }

        if (interaction.user.id !== session.ownerId) {
            await interaction.reply({ content: '❌ هذه الجلسة مخصصة لمالك السيرفر فقط.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (session not owner):', err));
            return true;
        }

        if (customId.startsWith('restore_bulk_cancel_')) {
            const timeout = protectionRuntime.bulkRestoreSessionTimeouts.get(sessionId);
            if (timeout) clearTimeout(timeout);
            protectionRuntime.bulkRestoreSessions.delete(sessionId);
            protectionRuntime.bulkRestoreSessionTimeouts.delete(sessionId);
         await interaction.update({ content: 'تم إلغاء العملية.', components: [] }).catch(err => console.error('Failed to update interaction (cancel bulk restore):', err));
            return true;
        }

        const guild = interaction.client.guilds.cache.get(session.guildId) || await interaction.client.guilds.fetch(session.guildId).catch(err => { console.error(`Failed to fetch guild ${session.guildId} for bulk restore session:`, err); return null; });
        if (!guild) {
            await interaction.reply({ content: '❌ Guild not found.', ephemeral: true }).catch(err => console.error('Failed to reply to interaction (guild not found):', err));
            return true;
        }

        const result = await restoreAdminRolesWithFilters(guild, session.excludedRoleIds, session.excludedUserIds, interaction.user.id);
        const timeout = protectionRuntime.bulkRestoreSessionTimeouts.get(sessionId);
        if (timeout) clearTimeout(timeout);
        protectionRuntime.bulkRestoreSessions.delete(sessionId);
        protectionRuntime.bulkRestoreSessionTimeouts.delete(sessionId);
        await interaction.update({
            content: `✅ تمت الاستعادة لـ ${result.restoredMembers} عضو وبعدد ${result.restoredRoles} رول إداري بواسطة <@${interaction.user.id}>.`,
            components: []
        }).catch(err => console.error('Failed to update interaction (confirm bulk restore):', err));
        return true;
    }

    return false;
}

/**
 * نظام إعادة البناء فائق السرعة (Ultra-Fast Reconstruction)
 * تم تحسينه ليتجاوز عمليات الفحص المتكررة ويبدأ الاستعادة فوراً
 */
async function runProtectionRestore(guild, cfg, reason = 'auto') {
    if (!cfg?.enabled) return;
    
    // منع التكرار مع السماح بالاستمرارية
    if (protectionRuntime.activeRestores.has(guild.id)) {
        protectionRuntime.pendingRestores.add(guild.id);
        return;
    }

    protectionRuntime.activeRestores.add(guild.id);
    try {
        // تجهيز الخيارات مسبقاً لتقليل وقت المعالجة
        const options = ['files', 'emojis'];
        if (cfg.protectionTypes?.serverSettings) options.push('serverinfo');
        if (cfg.protectionTypes?.rolesPermissions) {
            options.push('roles');
            options.push('memberroles');
        }
        if (cfg.protectionTypes?.channelsCategories) {
            options.push('categories');
            options.push('channels');
        }
        if (cfg.protectionTypes?.kickBan) options.push('bans');

        const uniqueOptions = Array.from(new Set(options));
        
        // جلب أحدث لقطة (Snapshot) فوراً دون دوران غير ضروري
        const latestSnapshot = cfg.latestBackupFile || (cfg.snapshotHistory && cfg.snapshotHistory.length > 0 ? cfg.snapshotHistory[cfg.snapshotHistory.length - 1] : null);
        
        if (latestSnapshot) {
            // تنفيذ الاستعادة بأقصى سرعة (بدون مؤشر تقدم لتقليل الـ API calls)
            const result = await restoreBackup(latestSnapshot, guild, guild.client.user.id, uniqueOptions, null);
            if (result?.success) {
                console.log(`[Protection] Instant reconstruction complete from: ${latestSnapshot}`);
            }
        }
    } catch (err) {
        console.error('[Protection] Reconstruction failed:', reason, err.message);
    } finally {
        protectionRuntime.activeRestores.delete(guild.id);
        // معالجة الطلبات المعلقة فوراً
        if (protectionRuntime.pendingRestores.has(guild.id)) {
            protectionRuntime.pendingRestores.delete(guild.id);
            const freshCfg = getGuildProtectionConfig(guild.id);
            if (freshCfg?.enabled) {
                setImmediate(() => runProtectionRestore(guild, freshCfg, `${reason}-pending`));
            }
        }
    }
}

async function createProtectionSnapshot(guild, cfg) {
    const snapshotName = `${guild.name}_protect_snapshot`;


    const result = await createBackup(guild, guild.client.user.id, snapshotName, null, false); // لقطات الحماية التلقائية لا تتضمن الرسائل لزيادة السرعة الفائقة والأداء المستقر
    if (!result.success) return;



    if (!cfg.snapshotHistory) {
        cfg.snapshotHistory = [];
    }
    cfg.snapshotHistory.push(result.fileName);

    // Keep only maxSnapshots
    while (cfg.snapshotHistory.length > (cfg.maxSnapshots || 5)) {
        const oldestSnapshot = cfg.snapshotHistory.shift();
        const oldestSnapshotPath = path.join(backupsDir, oldestSnapshot);
        try {
            await fs.promises.unlink(oldestSnapshotPath);
            console.log(`Deleted old snapshot file: ${oldestSnapshotPath}`);
        } catch (err) {
            console.error(`Failed to delete old snapshot file ${oldestSnapshotPath}:`, err);
        }
    }

    cfg.latestBackupFile = result.fileName; // Still keep track of the very latest for quick access
    cfg.expectedChannels = (result.data?.stats?.channels || 0) + (result.data?.stats?.categories || 0);
    cfg.expectedRoles = result.data?.stats?.roles || 0;
    cfg.updatedAt = Date.now();
    setGuildProtectionConfig(guild.id, cfg);
}

async function hydrateProtectionCache(guild) {
    await Promise.allSettled([
        guild.channels.fetch(),
        guild.roles.fetch(),
        guild.members.fetch()
    ]);
}

function startSnapshotRefresh(guild) {
    if (protectionRuntime.snapshotIntervals.has(guild.id)) {
        clearInterval(protectionRuntime.snapshotIntervals.get(guild.id));
    }

    const intervalId = setInterval(async () => {
        const liveCfg = getGuildProtectionConfig(guild.id);
        if (!liveCfg?.enabled) {
            clearInterval(intervalId);
            protectionRuntime.snapshotIntervals.delete(guild.id);
            return;
        }

        await createProtectionSnapshot(guild, liveCfg);
    }, 3 * 60 * 60 * 1000);

    protectionRuntime.snapshotIntervals.set(guild.id, intervalId);
}


async function refreshProtectionStateFast(guild, cfg) {
    if (!cfg?.enabled) return;
    await Promise.allSettled([
        hydrateProtectionCache(guild),
        createProtectionSnapshot(guild, cfg)
    ]);
    startSnapshotRefresh(guild);
}

async function handleTrustedActorChange(guild, cfg, actorId) {
    const trusted = cfg?.trustedUsers || [];
    if (!actorId || !trusted.includes(actorId)) return false;
    try {
        await refreshProtectionStateFast(guild, cfg);
        return true;
    } catch (err) {
        console.error(`Failed to refresh protection state for trusted actor ${actorId} in guild ${guild.id}:`, err);
        return false;
    }
}

async function bootstrapProtectionForClient(client) {
    if (protectionRuntime.protectionBootstrapped) return;
    protectionRuntime.protectionBootstrapped = true;

    // جلب ملاك البوت من تطبيق ديسكورد
    try {
        const app = await client.application.fetch();
        if (app.owner.id) {
            protectionRuntime.botOwners = [app.owner.id];
        } else if (app.owner.members) {
            protectionRuntime.botOwners = Array.from(app.owner.members.keys());
        }
    } catch (err) {
        console.error('Failed to fetch bot owners:', err);
    }

    const allCfg = await getProtectionConfigAll();
    const enabledGuilds = Object.entries(allCfg).filter(([, cfg]) => cfg?.enabled);

    await executeParallel(enabledGuilds, async ([guildId, cfg]) => {
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(err => { console.error(`Failed to fetch guild ${guildId} during bootstrap:`, err); return null; });
        if (!guild) return;

        await refreshProtectionStateFast(guild, cfg);
    }, DEFAULT_CONCURRENCY);
}

function ensureProtectionEngine(client) {
    if (protectionRuntime.listenersInstalled) return;
    protectionRuntime.listenersInstalled = true;

    const bootstrap = () => bootstrapProtectionForClient(client).catch(err => console.error('Failed to bootstrap protection for client:', err));
    if (typeof client.isReady === 'function' && client.isReady()) bootstrap();
    else client.once('ready', bootstrap);

    client.on('channelDelete', async (channel) => {
        const guild = channel.guild;
        if (!guild) return;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.channelsCategories) return;
        const actor = await getRecentExecutorId(guild, 12);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'channel delete', 'channelDelete');
    });

    client.on('channelCreate', async (channel) => {
        const guild = channel.guild;
        if (!guild) return;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.channelsCategories) return;
        const actor = await getRecentExecutorId(guild, 10);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'channel create', 'channelCreate');
    });

    client.on('channelUpdate', async (oldChannel, newChannel) => {
        const guild = newChannel.guild;
        if (!guild) return;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.channelsCategories) return;
        const actor = await getRecentExecutorId(guild, 11);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'channel update', 'channelUpdate');
    });

    client.on('roleDelete', async (role) => {
        const guild = role.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.rolesPermissions) return;
        const actor = await getRecentExecutorId(guild, 32);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'role delete', 'roleDelete');
    });

    client.on('roleCreate', async (role) => {
        const guild = role.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.rolesPermissions) return;
        const actor = await getRecentExecutorId(guild, 30);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'role create', 'roleCreate');
    });

    client.on('roleUpdate', async (oldRole, newRole) => {
        const guild = newRole.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled) return;

        // حماية صلاحية Administrator
        const hadAdmin = oldRole.permissions.has(PermissionFlagsBits.Administrator);
        const hasAdmin = newRole.permissions.has(PermissionFlagsBits.Administrator);

        if (!hadAdmin && hasAdmin) {
            const actorId = await getRecentExecutorId(guild, 31); // Role Update
            const isGlobalLockdown = protectionRuntime.mutedAdminRoles.has(`${guild.id}:${newRole.id}`);
            const allowByButton = protectionRuntime.allowedRoleAdminRestore.has(`${guild.id}:${newRole.id}`);

            if ((isGlobalLockdown && !allowByButton) || (!isOwnerOrBotOwner(guild, actorId) && !allowByButton)) {
                // إعادة الصلاحيات كما كانت
                await newRole.setPermissions(oldRole.permissions, 'Protection: Unauthorized Administrator permission grant').catch(() => null);
                
                // إذا كان هناك بلاغ نشط لهذه الرول، نحدث الرسالة
                const mutedPayload = protectionRuntime.mutedAdminRoles.get(`${guild.id}:${newRole.id}`);
                if (mutedPayload && mutedPayload.sentAlerts) {
                    await updateAlertMessages(guild.client, mutedPayload.sentAlerts, buildStatusLine(`⚠️ **تنبيه:** حاول <@${actorId || 'unknown'}> تفعيل صلاحية Administrator يدوياً وتم منعه.`));
                }
                return; // لا نكمل لمعالجة الحادثة العادية لأننا أصلحنا الخطأ
            }

            if (isGlobalLockdown && allowByButton) {
                const mutedPayload = protectionRuntime.mutedAdminRoles.get(`${guild.id}:${newRole.id}`);
                if (mutedPayload) {
                    await updateAlertMessages(guild.client, mutedPayload.sentAlerts, buildStatusLine(`✅ **تمت استعادة Administrator عبر الزر** بواسطة <@${actorId || guild.client.user.id}>.`), { disableButtons: true });
                    protectionRuntime.mutedAdminRoles.delete(`${guild.id}:${newRole.id}`);
                }
                protectionRuntime.allowedRoleAdminRestore.delete(`${guild.id}:${newRole.id}`);
                return;
            }
        }

        if (cfg.protectionTypes?.rolesPermissions) {
            const actor = await getRecentExecutorId(guild, 31);
            if (await handleTrustedActorChange(guild, cfg, actor)) return;
            await processProtectionIncident(guild, cfg, actor, 'role update', 'roleUpdate');
        }
    });

    client.on('guildUpdate', async (oldGuild, newGuild) => {
        const cfg = getGuildProtectionConfig(newGuild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.serverSettings) return;
        const actor = await getRecentExecutorId(newGuild, 1);
        if (await handleTrustedActorChange(newGuild, cfg, actor)) return;
        await processProtectionIncident(newGuild, cfg, actor, 'server update', 'guildUpdate');
    });

    client.on('guildBanAdd', async (ban) => {
        const guild = ban.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.kickBan) return;
        const actor = await getRecentExecutorId(guild, 22);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'ban', 'guildBanAdd');
    });

    client.on('guildMemberRemove', async (member) => {
        const guild = member.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.kickBan) return;
        const actor = await getRecentExecutorId(guild, 20);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'kick', 'guildMemberRemove');
    });

    client.on('emojiCreate', async (emoji) => {
        const guild = emoji.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.serverSettings) return;
        const actor = await getRecentExecutorId(guild, 60);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'emoji create', 'emojiCreate');
    });

    client.on('emojiUpdate', async (oldEmoji, newEmoji) => {
        const guild = newEmoji.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.serverSettings) return;
        const actor = await getRecentExecutorId(guild, 61);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'emoji update', 'emojiUpdate');
    });

    client.on('emojiDelete', async (emoji) => {
        const guild = emoji.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled || !cfg.protectionTypes?.serverSettings) return;
        const actor = await getRecentExecutorId(guild, 62);
        if (await handleTrustedActorChange(guild, cfg, actor)) return;
        await processProtectionIncident(guild, cfg, actor, 'emoji delete', 'emojiDelete');
    });

    client.on('guildMemberAdd', async (member) => {
        if (!member.user.bot) return;
        const guild = member.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled) return;
        const trusted = cfg.trustedUsers || [];
        if (trusted.includes(member.user.id)) return;
        const snap = await readJSON(path.join(backupsDir, cfg.latestBackupFile || ''), null);
        const allowedBots = new Set((snap?.data?.members || []).filter(m => m.userId).map(m => m.userId));
        if (!allowedBots.has(member.user.id)) {
            await member.kick('Protection: unknown bot').catch(err => console.error(`Failed to kick unknown bot ${member.id} in guild ${guild.id}:`, err));
        }
    });

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        const guild = newMember.guild;
        const cfg = getGuildProtectionConfig(guild.id);
        if (!cfg?.enabled) return;

        const key = `${guild.id}:${newMember.id}`;
        const payload = protectionRuntime.removedAdminRoles.get(key);
        if (!payload) return;

        // التحقق مما إذا تمت إضافة رولات إدارية أو رولات كانت مسحوبة
        const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
        if (addedRoles.size === 0) return;

        const isRestoringRemoved = addedRoles.some(role => (payload.roleIds || []).includes(role.id));
        const isAddingAdmin = addedRoles.some(role => role.permissions.has(PermissionFlagsBits.Administrator));

        if (isRestoringRemoved || isAddingAdmin) {
            const actorId = await getRecentExecutorId(guild, 25); // Member Role Update
            
            // إذا لم يكن الفاعل هو المالك أو أحد ملاك البوت، يتم سحب الرولات الخطيرة فوراً
            if (!isOwnerOrBotOwner(guild, actorId)) {
                const rolesToRemove = addedRoles.filter(role => (payload.roleIds || []).includes(role.id) || hasDangerousRolePermissions(role));
                await newMember.roles.remove(rolesToRemove, 'Protection: Unauthorized role restoration for punished user').catch(() => null);
                
                await updateAlertMessages(guild.client, payload.sentAlerts, buildStatusLine(`⚠️ **تنبيه:** حاول <@${actorId || 'unknown'}> استعادة رولات حساسة يدوياً وتم منعه تلقائياً.`));
            } else {
                // إذا كان الفاعل هو المالك أو أحد ملاك البوت، نغلق البلاغ حتى لو تمت يدوياً
                protectionRuntime.removedAdminRoles.delete(key);
                await updateAlertMessages(guild.client, payload.sentAlerts, buildStatusLine(`✅ **تمت الاستعادة يدوياً بواسطة:** <@${actorId || 'unknown'}>\n**الحالة:** تم تحديث الرولات وإغلاق البلاغ.`), { disableButtons: true });
            }
        }
    });

}

// دالة لإعادة المحاولة السريعة مع backoff خفيف جداً لزيادة الثبات
async function retryOperation(operation, maxRetries = 5, baseDelay = 1000, operationName = 'Operation Name') {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            if (error.code === 50001) { // Missing Access
                console.warn(`[${operationName}] Missing access, cannot retry.`);
                throw error;
            }
            if (error.code === 50013) { // Missing Permissions
                console.warn(`[${operationName}] Missing permissions, cannot retry.`);
                throw error;
            }
            if (error.status === 429 || error.code === 429) { // Discord Rate Limit
                const retryAfter = (error.headers && error.headers['retry-after']) ? parseInt(error.headers['retry-after']) * 1000 : baseDelay * (2 ** i) + Math.random() * 1000;
                console.warn(`[${operationName}] Rate limited. Retrying in ${retryAfter}ms. Attempt ${i + 1}/${maxRetries}`);
                await new Promise(resolve => setTimeout(resolve, retryAfter));
            } else if (error.code === 10003) { // Unknown Channel
                console.warn(`[${operationName}] Unknown Channel, skipping retry.`);
                throw error;
            } else if (error.code === 10007) { // Unknown Member
                console.warn(`[${operationName}] Unknown Member, skipping retry.`);
                throw error;
            } else {
                const delay = baseDelay * (2 ** i) + Math.random() * 1000; // Exponential backoff with jitter
                console.warn(`[${operationName}] Error: ${error.message}. Retrying in ${delay}ms. Attempt ${i + 1}/${maxRetries}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            if (i === maxRetries - 1) {
                console.error(`[${operationName}] Failed after ${maxRetries} attempts.`);
                throw error;
            }

            // backoff تصاعدي خفيف + jitter بسيط لتقليل تصادم الطلبات
            const jitter = 0;
            const delay = 0;
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}

// دالة تنفيذ متوازي باستخدام p-limit (أكثر ثباتاً من التوازي الوهمي)
async function executeParallel(items, operation, concurrency = DEFAULT_CONCURRENCY) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const parsedConcurrency = Number.isFinite(concurrency) && concurrency > 0
        ? Math.floor(concurrency)
        : DEFAULT_CONCURRENCY;
    const safeConcurrency = Math.max(1, Math.min(parsedConcurrency, items.length));
    const limit = pLimit(safeConcurrency);

    return Promise.allSettled(items.map((item, idx) => limit(() => operation(item, idx))));
}

// دالة لتحديث مؤشر التقدم (محسّنة للسيرفرات الضخمة)
async function updateProgress(message, title, current, total, details = '', forceUpdate = false) {
    try {
        // تحديث كل 5% أو عند الإجبار - لتقليل عدد الطلبات
        const percentage = Math.round((current / total) * 100);
        const lastPercentage = message._lastProgressPercentage || 0;

        if (!forceUpdate && percentage - lastPercentage < 5 && current !== total) {
            return; // تخطي التحديث إذا أقل من 5%
        }

        message._lastProgressPercentage = percentage;

        const progressBar = '▰'.repeat(Math.floor(percentage / 5)) + '▱'.repeat(20 - Math.floor(percentage / 5));

        const progressEmbed = colorManager.createEmbed()
            .setTitle(title)
            .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436856082646433893/hourglass.png?ex=69112001&is=690fce81&hm=ad1a68858ac5e7c4ab14bc4e51962f9eb5353809a46b958dc28f8a13e141a4f1&')
            .setDescription(`${progressBar} ${percentage}%\n\n**Process :** ${current}/${total}\n${details}`)
            .setFooter({ text: `Saving... | By Ahmed.` });

        // محاولة تحديث الرسالة الأصلية
        try {
            await message.edit({ embeds: [progressEmbed] });
        } catch (editError) {
            // التعامل مع timeout أو interaction منته
            if (editError.code === 10008 || editError.code === 40060 || editError.message?.includes('interaction')) {
                try {
                    // حفظ القناة الأصلية للتحديثات
                    if (!message._originalChannel) {
                        message._originalChannel = message.channel;
                    }

                    const targetChannel = message._originalChannel;

                    if (targetChannel && !message._newMessageSent) {
                        const newMessage = await targetChannel.send({ 
                            content: '**سيستغرق هذا بعض دقائق حسب حجم السيرفر :**',
                            embeds: [progressEmbed] 
                        });
                        Object.assign(message, newMessage);
                        message._newMessageSent = true;
                        message._originalChannel = targetChannel; // الاحتفاظ بالقناة الأصلية
                    } else if (message._newMessageSent) {
                        // تحديث الرسالة الجديدة
                        await message.edit({ embeds: [progressEmbed] });
                    }
                } catch (sendError) {
                    console.log('⚠️ لا يمكن إرسال تحديث التقدم - سيتم التخطي');
                }
            }
        }
    } catch (error) {
        // تجاهل الأخطاء الأخرى بصمت
        console.log('⚠️ خطأ في تحديث مؤشر التقدم - متابعة العملية');
    }
}

// نسخ رسائل القناة بشكل محسن وأسرع مع Streaming
async function backupChannelMessages(channel, maxMessages = 150) {
    const messages = [];
    let lastId;
    const batchSize = 100;
    let fetched = 0;

    try {
        while (fetched < maxMessages) {
            const fetchLimit = Math.min(batchSize, maxMessages - fetched);
            const options = { limit: fetchLimit };
            if (lastId) options.before = lastId;

            const batch = await retryOperation(
                async () => await channel.messages.fetch(options),
                2,
                300,
                `Fetch messages from ${channel.name}`
            );

            if (batch.size === 0) break;

            // معالجة الرسائل بشكل أخف على الذاكرة
            for (const msg of batch.values()) {
                messages.push({
                    id: msg.id,
                    author: { 
                        id: msg.author.id, 
                        username: msg.author.username, 
                        tag: msg.author.tag, 
                        avatar: msg.author.avatarURL() 
                    },
                    content: msg.content?.substring(0, 2000) || '', // حد أقصى 2000 حرف
                    timestamp: msg.createdTimestamp,
                    attachments: msg.attachments.size > 0 ? msg.attachments.map(att => ({ 
                        url: att.url, 
                        name: att.name, 
                        contentType: att.contentType 
                    })).slice(0, 10) : [], // حد أقصى 10 مرفقات
                    embeds: msg.embeds.length > 0 ? msg.embeds.slice(0, 5).map(emb => emb.toJSON()) : [] // حد أقصى 5 embeds
                });
            }

            fetched += batch.size;
            lastId = batch.last().id;

            if (batch.size < fetchLimit) break;

            // تقليل التأخير للسرعة الفائقة
        }

        return messages.reverse();
    } catch (error) {
        console.error(`فشل نسخ رسائل القناة ${channel.name}:`, error);
        return [];
    }
}

// نسخ Threads (محسّن بالمعالجة المتوازية الأقوى + Streaming)
async function backupThreads(channel, includeMessages = true) {
    const threads = [];
    try {
        const [activeThreads, archivedThreads] = await Promise.all([
           retryOperation(() => channel.threads.fetchActive(), 3, 0, 'Fetch active threads').catch(err => { console.error(`Failed to fetch active threads for channel ${channel.id}:`, err); return { threads: new Map() }; }),
           retryOperation(() => channel.threads.fetchArchived(), 3, 0, 'Fetch archived threads').catch(err => { console.error(`Failed to fetch archived threads for channel ${channel.id}:`, err); return { threads: new Map() }; })
        ]);

        const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];

        // زيادة المعالجة المتوازية إلى 8 ثريدات
        const threadBatchSize = 8;
        for (let i = 0; i < allThreads.length; i += threadBatchSize) {
            const batch = allThreads.slice(i, i + threadBatchSize);

            const results = await Promise.allSettled(
                batch.map(async (thread) => {
                    try {
                        const threadMessages = await backupChannelMessages(thread, 100); // زيادة إلى 100
                        return {
                            id: thread.id,
                            name: thread.name?.substring(0, 100) || 'Unnamed Thread', // حد أقصى للاسم
                            type: thread.type,
                            archived: thread.archived,
                            autoArchiveDuration: thread.autoArchiveDuration,
                            locked: thread.locked,
                           messages: includeMessages ? threadMessages : [],
                        };
                    } catch (err) {
                        console.error(`فشل نسخ ثريد ${thread.name}:`, err.message);
                        return null;
                    }
                })
            );

            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value !== null) {
                    threads.push(result.value);
                }
            });

        }
    } catch (error) {
        console.error(`فشل نسخ الثريدات للقناة ${channel.name}:`, error);
    }

    return threads;
}

// نسخ احتياطي شامل للسيرفر مع مؤشر تقدم
async function createBackup(guild, creatorId, backupName, progressMessage = null, includeMessages = true) {
    try {
        const timestamp = Date.now();
        const backupData = {
            guildId: guild.id,
            guildName: guild.name,
            createdBy: creatorId,
            createdAt: timestamp,
            name: backupName || `backup_${timestamp}`,
            version: '3.0',
            data: {
                files: {},
                roles: [],
                categories: [],
                channels: [],
                emojis: [],
                stickers: [],
                messages: {},
                threads: {},
                bans: [],
                members: []
            },
            stats: {
                roles: 0,
                channels: 0,
                categories: 0,
                textChannels: 0,
                voiceChannels: 0,
                files: 0,
                emojis: 0,
                stickers: 0,
                messages: 0,
                threads: 0,
                totalMessages: 0,
                bans: 0,
                members: 0
            }
        };

        let currentStep = 0;
        const totalSteps = 9;

        // 1. نسخ الملفات
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Json Copied...');
        }

        const jsonFiles = await getDataJsonFiles();
        await executeParallel(jsonFiles, async (fileName) => {
            const filePath = path.join(dataDir, fileName);
            if (!fs.existsSync(filePath)) return;
            const fileData = await readJSON(filePath, null);
            if (fileData !== null) {
                backupData.data.files[fileName] = fileData;
                backupData.stats.files++;
            }
        }, DEFAULT_CONCURRENCY);

        // 2. نسخ الرولات
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Roles Copied...');
        }

        const roles = Array.from(guild.roles.cache.values())
            .filter(role => !role.managed && role.id !== guild.id)
            .sort((a, b) => b.position - a.position);

        for (const role of roles) {
            backupData.data.roles.push({
                id: role.id,
                name: role.name,
                color: role.color,
                position: role.position,
                permissions: role.permissions.bitfield.toString(),
                hoist: role.hoist,
                mentionable: role.mentionable,
                icon: role.iconURL(),
                unicodeEmoji: role.unicodeEmoji
            });
            backupData.stats.roles++;
        }

        // 3. نسخ الكاتوقريات
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Channel , Categories Copied...');
        }

        const categories = Array.from(guild.channels.cache.values())
            .filter(ch => ch.type === ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);

        for (const category of categories) {
            const categoryData = {
                id: category.id,
                name: category.name,
                position: category.position,
                permissionOverwrites: [],
                channels: []
            };

            for (const [id, overwrite] of category.permissionOverwrites.cache) {
                categoryData.permissionOverwrites.push({
                    id: overwrite.id,
                    type: overwrite.type,
                    allow: overwrite.allow.bitfield.toString(),
                    deny: overwrite.deny.bitfield.toString()
                });
            }

            const channelsInCategory = Array.from(guild.channels.cache.values())
                .filter(ch => ch.parentId === category.id)
                .sort((a, b) => a.position - b.position);

            for (const channel of channelsInCategory) {
                const channelData = {
                    id: channel.id,
                    name: channel.name,
                    type: channel.type,
                    position: channel.position,
                    topic: channel.topic || null,
                    nsfw: channel.nsfw || false,
                    rateLimitPerUser: channel.rateLimitPerUser || 0,
                    bitrate: channel.bitrate || null,
                    userLimit: channel.userLimit || null,
                    permissionOverwrites: []
                };

                for (const [id, overwrite] of channel.permissionOverwrites.cache) {
                    channelData.permissionOverwrites.push({
                        id: overwrite.id,
                        type: overwrite.type,
                        allow: overwrite.allow.bitfield.toString(),
                        deny: overwrite.deny.bitfield.toString()
                    });
                }

                categoryData.channels.push(channelData);

                if (channel.type === ChannelType.GuildText) {
                    backupData.stats.textChannels++;
                } else if (channel.type === ChannelType.GuildVoice) {
                    backupData.stats.voiceChannels++;
                }
                backupData.stats.channels++;
            }

            backupData.data.categories.push(categoryData);
            backupData.stats.categories++;
        }

        // 4. نسخ القنوات خارج الكاتوقريات
        const channelsWithoutCategory = Array.from(guild.channels.cache.values())
            .filter(ch => !ch.parentId && ch.type !== ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);

        for (const channel of channelsWithoutCategory) {
            const channelData = {
                id: channel.id,
                name: channel.name,
                type: channel.type,
                position: channel.position,
                topic: channel.topic || null,
                nsfw: channel.nsfw || false,
                rateLimitPerUser: channel.rateLimitPerUser || 0,
                bitrate: channel.bitrate || null,
                userLimit: channel.userLimit || null,
                permissionOverwrites: [],
                parentId: null
            };

            for (const [id, overwrite] of channel.permissionOverwrites.cache) {
                channelData.permissionOverwrites.push({
                    id: overwrite.id,
                    type: overwrite.type,
                    allow: overwrite.allow.bitfield.toString(),
                    deny: overwrite.deny.bitfield.toString()
                });
            }

            backupData.data.channels.push(channelData);

            if (channel.type === ChannelType.GuildText) {
                backupData.stats.textChannels++;
            } else if (channel.type === ChannelType.GuildVoice) {
                backupData.stats.voiceChannels++;
            }
            backupData.stats.channels++;
        }

        // 5. نسخ الرسائل والثريدات (محسّن للسيرفرات الكبيرة + معالجة متوازية فائقة)
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Messages , Threads copied...');
        }

        const allTextChannels = Array.from(guild.channels.cache.filter(ch => ch.type === ChannelType.GuildText).values());
        let processedChannels = 0;
        const batchSize = 15; // زيادة إلى 15 قناة بالتوازي للسرعة الفائقة

        // معالجة القنوات بدفعات متوازية أكبر لتسريع العملية
        for (let i = 0; i < allTextChannels.length; i += batchSize) {
            const batch = allTextChannels.slice(i, i + batchSize);

            const results = await Promise.allSettled(
                batch.map(async (channel) => {
                    try {
                        // نسخ الرسائل والثريدات بالتوازي
                        const [messages, threads] = await Promise.all([
                            includeMessages ? backupChannelMessages(channel, 150) : Promise.resolve([]),
                            backupThreads(channel, includeMessages)
                        ]);

                        return { channel, messages, threads, success: true };
                    } catch (error) {
                        console.error(`فشل نسخ محتوى القناة ${channel.name}:`, error.message);
                        return { channel, success: false };
                    }
                })
            );

            // معالجة النتائج
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value.success) {
                    const { channel, messages, threads } = result.value;

                    if (messages.length > 0) {
                        backupData.data.messages[channel.id] = messages;
                        backupData.stats.messages += messages.length;
                        backupData.stats.totalMessages += messages.length;
                    }

                    if (threads.length > 0) {
                        backupData.data.threads[channel.id] = threads;
                        backupData.stats.threads += threads.length;
                        threads.forEach(t => backupData.stats.totalMessages += (t.messages?.length || 0));
                    }
                }
                processedChannels++;
            }

            // تحديث التقدم كل 5 قنوات فقط (تقليل عدد التحديثات)
            if (progressMessage && processedChannels % 5 === 0) {
                await updateProgress(
                    progressMessage, 
                    'Backup Loading', 
                    currentStep, 
                    totalSteps, 
                    `Messages... (${processedChannels}/${allTextChannels.length} Channel)`,
                    true
                );
            }

            // إزالة التأخير للسرعة القصوى
            // Discord rate limits سيتعامل معها retryOperation تلقائياً
        }
        

        // 6. نسخ الإيموجيات
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Emoji Copied...');
        }

        for (const emoji of guild.emojis.cache.values()) {
            backupData.data.emojis.push({
                id: emoji.id,
                name: emoji.name,
                url: emoji.url,
                animated: emoji.animated,
                roles: emoji.roles.cache.map(r => r.id)
            });
            backupData.stats.emojis++;
        }

        // 7. نسخ الملصقات (معلومات فقط)
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Stickers Copied...');
        }

        try {
            await guild.stickers.fetch();
            for (const sticker of guild.stickers.cache.values()) {
                backupData.data.stickers.push({
                    id: sticker.id,
                    name: sticker.name,
                    description: sticker.description,
                    tags: sticker.tags,
                    url: sticker.url,
                    note: 'لا يمكن استعادة الستيكرز تلقائياً - معلومات فقط'
                });
                backupData.stats.stickers++;
            }
        } catch (err) {
            console.error('خطأ في نسخ الستيكرز:', err);
        }

        // 8. نسخ الحظر
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Bans Copied...');
        }

        try {
            const bans = await guild.bans.fetch();
            for (const ban of bans.values()) {
                backupData.data.bans.push({
                    userId: ban.user.id,
                    username: ban.user.username,
                    tag: ban.user.tag,
                    reason: ban.reason || 'No reason provided'
                });
            }
            // تحديث الإحصائيات بعد جمع البيانات
            backupData.stats.bans = backupData.data.bans.length;
        } catch (err) {
            console.error('خطأ في نسخ الحظر:', err);
        }

        // 9. نسخ رولات الأعضاء (محسّن للسيرفرات الكبيرة)
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, 'Members Roles Copied...');
        }

        try {
            // جلب الأعضاء بالدفعات (chunks) لتجنب مشاكل الذاكرة
            await guild.members.fetch({ limit: 1000 });

            let processedMembers = 0;
            const totalMembers = guild.members.cache.size;

            for (const member of guild.members.cache.values()) {
                if (member.user.bot) continue;

                const memberRoles = member.roles.cache
                    .filter(role => role.id !== guild.id && !role.managed)
                    .map(role => role.id);

                if (memberRoles.length > 0) {
                    backupData.data.members.push({
                        userId: member.user.id,
                        username: member.user.username,
                        tag: member.user.tag,
                        roles: memberRoles,
                        nickname: member.nickname
                    });
                }

                processedMembers++;
                // تحديث التقدم كل 1000 عضو
                if (progressMessage && processedMembers % 1000 === 0) {
                    await updateProgress(
                        progressMessage, 
                        'Backup Loading', 
                        currentStep, 
                        totalSteps, 
                        `Members: ${processedMembers}/${totalMembers}`
                    );
                }
            }
            // تحديث الإحصائيات بعد جمع البيانات
            backupData.stats.members = backupData.data.members.length;
        } catch (err) {
            console.error('خطأ في نسخ رولات الأعضاء:', err);
        }

        // نسخ معلومات السيرفر
        backupData.data.serverInfo = {
            name: guild.name,
            icon: guild.iconURL({ size: 1024 }),
            banner: guild.bannerURL({ size: 1024 }),
            splash: guild.splashURL({ size: 1024 }),
            description: guild.description,
            verificationLevel: guild.verificationLevel,
            defaultMessageNotifications: guild.defaultMessageNotifications,
            explicitContentFilter: guild.explicitContentFilter,
            afkChannelId: guild.afkChannelId,
            afkTimeout: guild.afkTimeout,
            systemChannelId: guild.systemChannelId,
            premiumTier: guild.premiumTier
        };

        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', totalSteps, totalSteps, 'Saved...');
        }

        const backupFileName = `${guild.id}_${backupName || timestamp}.json`;
        const backupFilePath = path.join(backupsDir, backupFileName);

        if (saveJSON(backupFilePath, backupData)) {
            return {
                success: true,
                fileName: backupFileName,
                filePath: backupFilePath,
                data: backupData
            };
        }

        return { success: false, error: 'فشل في حفظ النسخة' };
    } catch (error) {
        console.error('خطأ في إنشاء النسخة:', error);
        return { success: false, error: error.message };
    }
}

// استعادة ذكية بالفروقات: تعديل الموجود + إنشاء الناقص + حذف الفائض فقط
async function restoreBackup(backupFileName, guild, restoredBy, options, progressMessage = null) {
    try {
        options = options || [];

        const backupFilePath = path.join(backupsDir, backupFileName);
        try { await fs.promises.access(backupFilePath); } catch { return { success: false, error: 'ملف النسخة غير موجود' }; }
        const backupData = await readJSON(backupFilePath);
        if (!backupData || !backupData.data) {
            return { success: false, error: 'بيانات النسخة تالفة' };
        }

        const stats = {
            rolesDeleted: 0, rolesCreated: 0, rolesMatched: 0,
            categoriesDeleted: 0, categoriesCreated: 0, categoriesMatched: 0,
            channelsDeleted: 0, channelsCreated: 0, channelsMatched: 0,
            filesRestored: 0, messagesRestored: 0,
            threadsRestored: 0, bansRestored: 0,
            memberRolesRestored: 0, errors: []
        };

        const roleMap = new Map();
        const channelMap = new Map();
        const categoryMap = new Map();

        let currentStep = 0;
        // حساب عدد الخطوات الديناميكي بناءً على الخيارات
        let totalSteps = 1; // استعادة ذكية بالفروقات
        if (options.includes('messages')) totalSteps++;
        if (options.includes('bans')) totalSteps++;
        if (options.includes('memberroles')) totalSteps++;

        // ═══════════════════════════════════════════════════════════════
        // 🚀 الخطوة 1: استعادة ذكية بالفروقات (بدون حذف شامل)
        // ═══════════════════════════════════════════════════════════════
        if (progressMessage) {
            await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, '⚡ Smart Diff Restore...');
        }

        // استعادة الملفات
        const restoreFilesTask = async () => {
            if (!options.includes('files')) return;
            for (const [fileName, fileData] of Object.entries(backupData.data.files || {})) {
                if (saveJSON(path.join(dataDir, fileName), fileData)) stats.filesRestored++;
            }
        };

        // استعادة معلومات السيرفر
        const restoreServerInfoTask = async () => {
            if (!options.includes('serverinfo') || !backupData.data.serverInfo) return;
            try {
                const updates = {};
                if (backupData.data.serverInfo.name && backupData.data.serverInfo.name !== guild.name) {
                    updates.name = backupData.data.serverInfo.name;
                }
                if (backupData.data.serverInfo.description !== undefined && backupData.data.serverInfo.description !== guild.description) {
                    updates.description = backupData.data.serverInfo.description;
                }

                if (Object.keys(updates).length > 0) {
                    await guild.edit(updates);
                }

                await Promise.allSettled([
                    (backupData.data.serverInfo.icon && backupData.data.serverInfo.icon !== guild.iconURL({ size: 1024 }))
                        ? guild.setIcon(backupData.data.serverInfo.icon)
                        : Promise.resolve(),
                    (backupData.data.serverInfo.banner && backupData.data.serverInfo.banner !== guild.bannerURL({ size: 1024 }))
                        ? guild.setBanner(backupData.data.serverInfo.banner)
                        : Promise.resolve()
                ]);
            } catch (err) {}
        };

        // مهمة الرولات (مطابقة الموجود + إنشاء الناقص + حذف الفائض)
        const restoreRolesTask = async () => {
            if (!options.includes('roles')) return;

            const backupRoles = [...(backupData.data.roles || [])];
            const existingRoles = Array.from(guild.roles.cache.values())
                .filter(r => !r.managed && r.id !== guild.id);
            const rolesByName = new Map();
            const rolesById = new Map(existingRoles.map(role => [role.id, role]));

            for (const role of existingRoles) {
                const key = (role.name || '').toLowerCase();
                if (!rolesByName.has(key)) rolesByName.set(key, []);
                rolesByName.get(key).push(role);
            }

            const usedExistingIds = new Set();
            const rolesToCreate = [];

            // مرحلة المطابقة من الكاش
            for (const roleData of backupRoles) {
                const queue = rolesByName.get((roleData.name || '').toLowerCase()) || [];
                const matchedById = rolesById.get(roleData.id);
                const matched = (matchedById && !usedExistingIds.has(matchedById.id)) ? matchedById : queue.find(r => !usedExistingIds.has(r.id));

                if (matched) {
                    usedExistingIds.add(matched.id);
                    roleMap.set(roleData.id, matched.id);
                    stats.rolesMatched++;
                } else {
                    rolesToCreate.push(roleData);
                }
            }

            // إنشاء الناقص دفعة واحدة بأعلى توازي
            await executeParallel(rolesToCreate, async (roleData) => {
                try {
                    const newRole = await retryOperation(
                        () => guild.roles.create({ name: roleData.name }),
                        2,
                        0,                        `Create role ${roleData.name}`
                    );
                    roleMap.set(roleData.id, newRole.id);
                    stats.rolesCreated++;
                } catch (err) {
                    console.error(`Failed to create role ${roleData.name}:`, err);
                }
            }, DEFAULT_CONCURRENCY);

            // حذف الرولات الزائدة غير الموجودة في النسخة
            await executeParallel(existingRoles, async (role) => {
                if (usedExistingIds.has(role.id)) return;
                try {
                    await role.delete("Smart diff restore - extra role").catch(err => console.error(`Failed to delete extra role ${role.id}:`, err));
                    stats.rolesDeleted++;
                } catch (err) {
                    console.error(`Failed to delete extra role ${role.id}:`, err);
                }
            }, DEFAULT_CONCURRENCY);

            // تطبيق خصائص الرولات بعد اكتمال الإنشاء/المطابقة
            await executeParallel(backupRoles, async (roleData) => {
                const newRoleId = roleMap.get(roleData.id);
                if (!newRoleId) return;

                const role = guild.roles.cache.get(newRoleId);
                if (!role) return;

                await Promise.allSettled([
                    retryOperation(
                        () => role.edit({
                            color: roleData.color,
                            permissions: BigInt(roleData.permissions),
                            hoist: roleData.hoist,
                            mentionable: roleData.mentionable,
                            name: roleData.name
                        }),
                        2,
                        0,
                        `Edit role ${roleData.name}`
                    ).catch(err => console.error(`Failed to edit role ${roleData.name}:`, err)),
                    retryOperation(
                        () => role.setPosition(roleData.position),
                        2,
                        0,
                        `Set role position ${roleData.name}`
                    ).catch(err => console.error(`Failed to set role position for ${roleData.name}:`, err))
                ]);
            }, DEFAULT_CONCURRENCY);
        };

        // دالة لتحويل الصلاحيات
        const convertPermissions = (overwrites = []) => {
            return overwrites.map(ow => {
                if (ow.id === backupData.guildId || ow.type === 1) {
                    return { id: ow.type === 1 ? ow.id : guild.id, allow: BigInt(ow.allow), deny: BigInt(ow.deny) };
                }
                const newRoleId = roleMap.get(ow.id);
                if (!newRoleId) return null;
                return { id: newRoleId, allow: BigInt(ow.allow), deny: BigInt(ow.deny) };
            }).filter(Boolean);
        };

        const restoreChannelsTask = async (rolesTaskPromise) => {
            if (!(options.includes('channels') || options.includes('categories'))) return;

            const backupCategories = backupData.data.categories || [];
            const backupStandaloneChannels = backupData.data.channels || [];
            const shouldRestoreCategories = options.includes('categories');
            const shouldRestoreChannels = options.includes('channels');

            const existingAllChannels = Array.from(guild.channels.cache.values());
            const existingCategories = existingAllChannels.filter(ch => ch.type === ChannelType.GuildCategory);
            const existingNonCategories = existingAllChannels.filter(ch => ch.type !== ChannelType.GuildCategory);
            const categoriesByName = new Map();
            const categoriesById = new Map(existingCategories.map(cat => [cat.id, cat]));
            const channelsBySignature = new Map();
            const channelsById = new Map(existingNonCategories.map(ch => [ch.id, ch]));
            const channelsByNameType = new Map();

            for (const cat of existingCategories) {
                const key = (cat.name || '').toLowerCase();
                if (!categoriesByName.has(key)) categoriesByName.set(key, []);
                categoriesByName.get(key).push(cat);
            }

            const getChannelKey = (parentId, name, type) => `${parentId || 'root'}::${(name || '').toLowerCase()}::${type}`;
            for (const ch of existingNonCategories) {
                const key = getChannelKey(ch.parentId, ch.name, ch.type);
                if (!channelsBySignature.has(key)) channelsBySignature.set(key, []);
                channelsBySignature.get(key).push(ch);

                const looseKey = `${(ch.name || '').toLowerCase()}::${ch.type}`;
                if (!channelsByNameType.has(looseKey)) channelsByNameType.set(looseKey, []);
                channelsByNameType.get(looseKey).push(ch);
            }

            const usedChannelIds = new Set();
            const channelRestoreConcurrency = DEFAULT_CONCURRENCY;
            const categoryRestoreConcurrency = DEFAULT_CONCURRENCY;
            const safeRetryCount = 5;
            const safeRetryDelay = 0;

            // 1) مطابقة/إنشاء الكاتقريات
            const categoriesToCreate = [];
            if (shouldRestoreCategories) {
                for (const catData of backupCategories) {
                    const queue = categoriesByName.get((catData.name || '').toLowerCase()) || [];
                    const matchedById = categoriesById.get(catData.id);
                    const matched = (matchedById && !usedChannelIds.has(matchedById.id)) ? matchedById : queue.find(c => !usedChannelIds.has(c.id));

                    if (matched) {
                        usedChannelIds.add(matched.id);
                        categoryMap.set(catData.id, matched.id);
                        channelMap.set(catData.id, matched.id);
                        stats.categoriesMatched++;
                    } else {
                        categoriesToCreate.push(catData);
                    }
                }

                await executeParallel(categoriesToCreate, async (catData) => {
                    try {
                        const created = await retryOperation(
                            () => guild.channels.create({
                                name: catData.name,
                                type: ChannelType.GuildCategory,
                                position: catData.position
                            }),
                            safeRetryCount,
                            safeRetryDelay,
                            `Create category ${catData.name}`
                        );
                        usedChannelIds.add(created.id);
                        categoryMap.set(catData.id, created.id);
                        channelMap.set(catData.id, created.id);
                        stats.categoriesCreated++;
                    } catch (err) {
                        console.error(`Failed to create category ${catData.name}:`, err);
                    }
                }, categoryRestoreConcurrency);
            }

            // 2) مطابقة/إنشاء قنوات داخل الكاتقريات
            const allChannelsInCategories = [];
            for (const catData of backupCategories) {
                const parentId = categoryMap.get(catData.id) || (categoriesByName.get((catData.name || '').toLowerCase()) || [])[0]?.id || null;
                for (const chData of catData.channels || []) {
                    allChannelsInCategories.push({ ...chData, parentId });
                }
            }

            const backupLooseChannelKeys = new Set([
                ...allChannelsInCategories.map(ch => `${(ch.name || '').toLowerCase()}::${ch.type}`),
                ...backupStandaloneChannels.map(ch => `${(ch.name || '').toLowerCase()}::${ch.type}`)
            ]);
            const backupCategoryNames = new Set(backupCategories.map(cat => (cat.name || '').toLowerCase()));

            const restoreChannelsInCategoriesPromise = shouldRestoreChannels ? executeParallel(allChannelsInCategories, async (chData) => {
                let targetParentId = chData.parentId;

                // محاولة إنقاذ الأب عند فقدان parentId
                if (!targetParentId) {
                    const guessedCategory = (categoriesByName.get((backupCategories.find(cat => (cat.channels || []).some(c => c.id === chData.id))?.name || '').toLowerCase()) || [])[0];
                    targetParentId = guessedCategory?.id || null;
                }

                const key = getChannelKey(targetParentId, chData.name, chData.type);
                const queue = channelsBySignature.get(key) || [];
                const looseQueue = channelsByNameType.get(`${(chData.name || '').toLowerCase()}::${chData.type}`) || [];
                const matchedById = channelsById.get(chData.id);
                const matched = (matchedById && !usedChannelIds.has(matchedById.id))
                    ? matchedById
                    : queue.find(ch => !usedChannelIds.has(ch.id));

                if (matched) {
                    usedChannelIds.add(matched.id);
                    channelMap.set(chData.id, matched.id);
                    stats.channelsMatched++;
                    await retryOperation(
                        () => matched.edit({ parent: targetParentId, position: chData.position }),
                        safeRetryCount,
                        safeRetryDelay,
                        `Edit channel ${chData.name}`
                    ).catch(err => console.error(`Failed to edit role ${roleData.name}:`, err));
                    return;
                }

                // إذا وجدنا روم بنفس الاسم/النوع لكن داخل كاتوقري غلط: نحذفه ثم ننشئ الصحيح
                const stray = looseQueue.find(ch => !usedChannelIds.has(ch.id));

                // لو ما عرفنا الأب نهائياً نسجل خطأ ونكمل
                if (!targetParentId) {
                    stats.errors.push(`تعذر تحديد الكاتوقري للروم ${chData.name} - تم التخطي`);
                    return;
                }

                try {
                    const opts = {
                        name: chData.name,
                        type: chData.type,
                        parent: targetParentId,
                        position: chData.position
                    };
                    if (chData.topic) opts.topic = chData.topic;
                    if (chData.nsfw !== undefined) opts.nsfw = chData.nsfw;
                    if (chData.rateLimitPerUser) opts.rateLimitPerUser = chData.rateLimitPerUser;
                    if (chData.bitrate) opts.bitrate = chData.bitrate;
                    if (chData.userLimit) opts.userLimit = chData.userLimit;

                    const newCh = await retryOperation(() => guild.channels.create(opts), safeRetryCount, 0, `Create channel ${chData.name}`);
                    usedChannelIds.add(newCh.id);
                    channelMap.set(chData.id, newCh.id);
                    stats.channelsCreated++;

                    if (stray && stray.parentId !== targetParentId) {
                        await stray.delete("Smart diff restore - recreate in correct category").catch(err => console.error(`Failed to delete stray channel ${stray.id}:`, err));
                        stats.channelsDeleted++;
                    }
                } catch (err) {
                    if (stray) {
                        usedChannelIds.add(stray.id);
                        channelMap.set(chData.id, stray.id);
                        stats.channelsMatched++;
                    }
                }
            }, channelRestoreConcurrency) : Promise.resolve();

            // 3) مطابقة/إنشاء القنوات خارج الكاتقريات
            const restoreStandaloneChannelsPromise = shouldRestoreChannels ? executeParallel(backupStandaloneChannels, async (chData) => {
                const key = getChannelKey(null, chData.name, chData.type);
                const queue = channelsBySignature.get(key) || [];
                const matchedById = channelsById.get(chData.id);
                const matched = (matchedById && !usedChannelIds.has(matchedById.id))
                    ? matchedById
                    : queue.find(ch => !usedChannelIds.has(ch.id));

                if (matched) {
                    usedChannelIds.add(matched.id);
                    channelMap.set(chData.id, matched.id);
                    stats.channelsMatched++;
                    await retryOperation(() => matched.edit({ position: chData.position }), safeRetryCount, 0, `Edit channel ${chData.name}`).catch(err => console.error(`Failed to edit channel position for ${chData.name}:`, err));
                    return;
                }

                try {
                    const opts = {
                        name: chData.name,
                        type: chData.type,
                        position: chData.position
                    };
                    if (chData.topic) opts.topic = chData.topic;
                    if (chData.nsfw !== undefined) opts.nsfw = chData.nsfw;
                    if (chData.rateLimitPerUser) opts.rateLimitPerUser = chData.rateLimitPerUser;
                    if (chData.bitrate) opts.bitrate = chData.bitrate;
                    if (chData.userLimit) opts.userLimit = chData.userLimit;

                   const newCh = await retryOperation(() => guild.channels.create(opts), safeRetryCount, 0, `Create channel ${chData.name}`);         usedChannelIds.add(newCh.id);
                    channelMap.set(chData.id, newCh.id);
                    stats.channelsCreated++;
                } catch (err) {
                    console.error(`Failed to delete extra role ${role.id}:`, err);
                }
            }, channelRestoreConcurrency) : Promise.resolve();

            // 4) حذف الزوائد بالتوازي مع الاستعادة (بدون انتظار تسلسلي)
            const deleteExtrasPromise = Promise.allSettled([
                shouldRestoreChannels
                    ? executeParallel(Array.from(guild.channels.cache.values()).filter(ch => ch.type !== ChannelType.GuildCategory), async (ch) => {
                        if (usedChannelIds.has(ch.id)) return;
                        const looseKey = `${(ch.name || '').toLowerCase()}::${ch.type}`;
                        if (backupLooseChannelKeys.has(looseKey)) return;
                        try {
                            await ch.delete("Smart diff restore - extra channel").catch(err => console.error(`Failed to delete extra channel ${ch.id}:`, err));
                            stats.channelsDeleted++;
                        } catch (err) {
                        console.error(`Failed to create category ${catData.name}:`, err);
                    }
                    }, DEFAULT_CONCURRENCY)
                    : Promise.resolve(),
                shouldRestoreCategories
                    ? executeParallel(Array.from(guild.channels.cache.values()).filter(ch => ch.type === ChannelType.GuildCategory), async (ch) => {
                        if (usedChannelIds.has(ch.id)) return;
                        const categoryName = (ch.name || '').toLowerCase();
                        if (backupCategoryNames.has(categoryName)) return;
                        try {
                            await ch.delete("Smart diff restore - extra category").catch(err => console.error(`Failed to delete extra category ${ch.id}:`, err));
                            stats.categoriesDeleted++;
                        } catch (err) {
                        console.error(`Failed to create category ${catData.name}:`, err);
                    }
                    }, DEFAULT_CONCURRENCY)
                    : Promise.resolve()
            ]);

            await Promise.allSettled([
                restoreChannelsInCategoriesPromise,
                restoreStandaloneChannelsPromise,
                deleteExtrasPromise
            ]);

            // 5) ترتيب نهائي
            const positions = [];
            for (const catData of backupCategories) {
                const newCatId = categoryMap.get(catData.id);
                if (shouldRestoreCategories && newCatId) positions.push({ channel: newCatId, position: catData.position });

                if (shouldRestoreChannels) for (const chData of catData.channels || []) {
                    const newChId = channelMap.get(chData.id);
                    if (newChId) positions.push({ channel: newChId, position: chData.position });
                }
            }
            if (shouldRestoreChannels) for (const chData of backupStandaloneChannels) {
                const newChId = channelMap.get(chData.id);
                if (newChId) positions.push({ channel: newChId, position: chData.position });
            }
            if (positions.length > 0) {
                await guild.channels.setPositions(positions).catch(err => console.error("Failed to set channel positions:", err));
            }

            // برمشنات الرومات بعد اكتمال الرولات فقط
            await rolesTaskPromise;

            if (shouldRestoreCategories) await executeParallel(backupCategories, async (catData) => {
                const newCatId = categoryMap.get(catData.id);
                if (!newCatId) return;
                const channel = guild.channels.cache.get(newCatId);
                if (!channel) return;
                await channel.permissionOverwrites.set(convertPermissions(catData.permissionOverwrites)).catch(err => console.error(`Failed to set category permission overwrites for ${catData.name}:`, err));
            }, DEFAULT_CONCURRENCY);

            if (shouldRestoreChannels) await executeParallel(allChannelsInCategories, async (chData) => {
                const newChId = channelMap.get(chData.id);
                if (!newChId) return;
                const channel = guild.channels.cache.get(newChId);
                if (!channel) return;
                await channel.permissionOverwrites.set(convertPermissions(chData.permissionOverwrites)).catch(err => console.error(`Failed to set channel permission overwrites for ${chData.name}:`, err));
            }, DEFAULT_CONCURRENCY);

            if (shouldRestoreChannels) await executeParallel(backupStandaloneChannels, async (chData) => {
                const newChId = channelMap.get(chData.id);
                if (!newChId) return;
                const channel = guild.channels.cache.get(newChId);
                if (!channel) return;
                await channel.permissionOverwrites.set(convertPermissions(chData.permissionOverwrites)).catch(err => console.error(`Failed to set channel permission overwrites for ${chData.name}:`, err));
            }, DEFAULT_CONCURRENCY);
        };

        const restoreEmojisTask = async () => {
            if (!options.includes('emojis') || !backupData.data.emojis) return;

            const existingEmojis = Array.from(guild.emojis.cache.values());
            const usedEmojiIds = new Set();
            const emojisByName = new Map();
            const emojisById = new Map(existingEmojis.map(emoji => [emoji.id, emoji]));

            for (const emoji of existingEmojis) {
                const key = (emoji.name || '').toLowerCase();
                if (!emojisByName.has(key)) emojisByName.set(key, []);
                emojisByName.get(key).push(emoji);
            }

            await executeParallel(backupData.data.emojis, async (emojiData) => {
                const queue = emojisByName.get((emojiData.name || '').toLowerCase()) || [];
                const matchedById = emojisById.get(emojiData.id);
                const matched = (matchedById && !usedEmojiIds.has(matchedById.id)) ? matchedById : queue.find(e => !usedEmojiIds.has(e.id));
                if (matched) {
                    usedEmojiIds.add(matched.id);
                    return;
                }
                try {
                    const newEmoji = await retryOperation(
                        () => guild.emojis.create({ attachment: emojiData.url, name: emojiData.name }),
                        2,
                        25,
                        `Create emoji ${emojiData.name}`
                    );
                    if (newEmoji) usedEmojiIds.add(newEmoji.id);
                } catch (err) {
                    console.error(`Failed to delete extra role ${role.id}:`, err);
                }
            }, 8);

            await executeParallel(existingEmojis, async (emoji) => {
                if (usedEmojiIds.has(emoji.id)) return;
                await emoji.delete("Smart diff restore - extra emoji").catch(err => console.error(`Failed to delete extra emoji ${emoji.id}:`, err));
            }, 5);
        };

        const restoreBansTask = async () => {
            if (!(options.includes('bans') && backupData.data.bans)) return;
            const currentBans = await guild.bans.fetch();
            const backupBanIds = new Set((backupData.data.bans || []).map(b => b.userId));
            const currentBanIds = new Set(currentBans.keys());

            await executeParallel(Array.from(currentBanIds), async (bannedUserId) => {
                if (!backupBanIds.has(bannedUserId)) {
                    try {
                        await guild.members.unban(bannedUserId, 'Backup restore');
                    } catch (err) {
                        stats.errors.push(`فشل فك حظر ${bannedUserId}: ${err.message}`);
                    }
                }
            }, 8);

            const banResults = await executeParallel(backupData.data.bans || [], async (banData) => {
                if (!currentBanIds.has(banData.userId)) {
                    try {
                        await guild.members.ban(banData.userId, { reason: `Backup restore: ${banData.reason}` });
                        return true;
                    } catch (err) {
                        stats.errors.push(`فشل حظر ${banData.username}: ${err.message}`);
                        return false;
                    }
                }
                return true;
            }, 8);

            stats.bansRestored = banResults.filter(r => r.status === 'fulfilled' && r.value).length;
        };

        const restoreMemberRolesTask = async (rolesTaskPromise) => {
            if (!(options.includes('memberroles') && backupData.data.members && backupData.data.members.length > 0)) return;

            // رولات الأعضاء لا تبدأ إلا بعد اكتمال الرولات
            await rolesTaskPromise;
            await guild.members.fetch();

            const managedRoleIds = new Set(
                Array.from(guild.roles.cache.values()).filter(r => r.managed).map(r => r.id)
            );
            const restorableRoleIds = new Set(roleMap.values());

            const memberResults = await executeParallel(backupData.data.members, async (memberData) => {
                try {
                    const member = guild.members.cache.get(memberData.userId);
                    if (!member) return { success: false };

                    const targetRoles = new Set(
                        memberData.roles
                            .map(oldRoleId => roleMap.get(oldRoleId) || oldRoleId)
                            .filter(roleId => roleId && guild.roles.cache.has(roleId) && !managedRoleIds.has(roleId) && roleId !== guild.id)
                    );

                    const currentRestorableRoles = member.roles.cache
                        .filter(role => role.id !== guild.id && !role.managed)
                        .map(role => role.id)
                        .filter(roleId => restorableRoleIds.has(roleId));

                    const rolesToAdd = Array.from(targetRoles).filter(roleId => !member.roles.cache.has(roleId));
                    const rolesToRemove = currentRestorableRoles.filter(roleId => !targetRoles.has(roleId));

                    await Promise.allSettled([
                        rolesToAdd.length > 0
                            ? retryOperation(async () => member.roles.add(rolesToAdd), 3, 0, `Add roles to ${memberData.username}`)
                            : Promise.resolve(),
                        rolesToRemove.length > 0
                            ? retryOperation(async () => member.roles.remove(rolesToRemove), 3, 0, `Remove roles from ${memberData.username}`)
                            : Promise.resolve()
                    ]);

                    if (memberData.nickname !== undefined && memberData.nickname !== member.nickname) {
                        await member.setNickname(memberData.nickname).catch(err => console.error(`Failed to set nickname for member ${member.id}:`, err));
                    }

                    return { success: true };
                } catch (err) {
                    return { success: false, error: err.message, username: memberData.username };
                }
            }, 25);

            for (const result of memberResults) {
                if (result.status === 'fulfilled' && result.value?.success) {
                    stats.memberRolesRestored++;
                } else if (result.status === 'fulfilled' && result.value?.error) {
                    stats.errors.push(`فشل استعادة رولات ${result.value.username}: ${result.value.error}`);
                }
            }
        };
        const restoreMessagesTask = async () => {
            if (!options.includes('messages')) return;
            const messageData = backupData.data.messages || {};
            await executeParallel(Object.entries(messageData), async ([oldChannelId, messages]) => {
                const newChannelId = channelMap.get(oldChannelId);
                if (!newChannelId) return;
                const channel = guild.channels.cache.get(newChannelId);
                if (!channel || channel.type !== ChannelType.GuildText) return;

                let webhook = null;
                try {
                    webhook = await channel.createWebhook({
                        name: 'Backup Restore',
                        avatar: guild.client.user.displayAvatarURL(),
                        reason: 'Restoring messages from backup'
                    });
                } catch (err) {
                    console.error(`Failed to create webhook for channel ${channel.name}:`, err);
                    return; // Cannot restore messages without a webhook
                }

                // إرسال الرسائل (آخر 50 رسالة فقط للسرعة) باستخدام Webhook
                for (const msg of messages.slice(-50)) {
                    try {
                        await webhook.send({
                            content: msg.content || '',
                            username: msg.author.username,
                            avatarURL: msg.author.avatar,
                            embeds: msg.embeds || []
                        });
                        stats.messagesRestored++;
                    } catch (err) {
                        console.error(`Failed to send message via webhook in channel ${channel.name}:`, err);
                    }
                }
                // حذف الويب هوك بعد الانتهاء
                await webhook.delete('Finished restoring messages').catch(err => console.error(`Failed to delete webhook in channel ${channel.name}:`, err));
            }, 5); // Keep concurrency at 5 for message sending to avoid rate limits
        };

        const restoreThreadsTask = async () => {
            if (!options.includes('threads')) return;
            const threadData = backupData.data.threads || {};
            await executeParallel(Object.entries(threadData), async ([oldChannelId, threads]) => {
                const newChannelId = channelMap.get(oldChannelId);
                if (!newChannelId) return;
                const channel = guild.channels.cache.get(newChannelId);
                if (!channel || channel.type !== ChannelType.GuildText) return;

                for (const tData of threads) {
                    try {
                        const thread = await channel.threads.create({
                            name: tData.name,
                            autoArchiveDuration: tData.autoArchiveDuration,
                            type: tData.type
                        });
                        stats.threadsRestored++;
                        
                        if (tData.messages && tData.messages.length > 0) {
                            for (const msg of tData.messages.slice(-10)) {
                                const embed = new EmbedBuilder()
                                    .setAuthor({ name: msg.author.username, iconURL: msg.author.avatar })
                                    .setDescription(msg.content || '*No content*')
                                    .setTimestamp(msg.timestamp);
                                await thread.send({ embeds: [embed] });
                            }
                        }
                    } catch (err) {}
                }
            }, 1); // تقليل التوازي إلى 1 لتجنب قيود إنشاء الثريدات
        };

        const hasMessages = options.includes('messages') || options.includes('threads');
        const hasBans = options.includes('bans');
        const hasMemberRoles = options.includes('memberroles') && backupData.data.members && backupData.data.members.length > 0;

        if (hasMessages || hasBans || hasMemberRoles) {
            if (progressMessage) {
                let progressText = 'Restoring: ';
                const parts = [];
                if (options.includes('messages')) parts.push('Messages');
                if (options.includes('threads')) parts.push('Threads');
                if (hasBans) parts.push('Bans');
                if (hasMemberRoles) parts.push('Member Roles');
                progressText += parts.join(' + ');
                await updateProgress(progressMessage, 'Backup Loading', ++currentStep, totalSteps, progressText);
            }
        }

        // تشغيل كل العمليات المختارة معًا
        const rolesTaskPromise = restoreRolesTask();
        const channelsTask = restoreChannelsTask(rolesTaskPromise);
        const memberRolesTask = restoreMemberRolesTask(rolesTaskPromise);

        await Promise.allSettled([
            rolesTaskPromise,
            restoreFilesTask(),
            restoreServerInfoTask(),
            channelsTask,
            restoreEmojisTask(),
            restoreBansTask(),
            memberRolesTask,
            restoreMessagesTask(),
            restoreThreadsTask()
        ]);

        // فحص نهائي للتأكد أنه لا يوجد نقص بعد الاستعادة
        const verification = {
            roles: !options.includes('roles') || roleMap.size >= (backupData.data.roles || []).length,
            categories: !options.includes('categories') || categoryMap.size >= (backupData.data.categories || []).length,
            channels: !options.includes('channels') || channelMap.size >= ((backupData.data.channels || []).length + (backupData.data.categories || []).reduce((sum, cat) => sum + (cat.channels?.length || 0), 0) + (options.includes('categories') ? (backupData.data.categories || []).length : 0)),
            bans: !options.includes('bans') || stats.bansRestored >= (backupData.data.bans || []).length,
            memberRoles: !options.includes('memberroles') || stats.memberRolesRestored >= (backupData.data.members || []).length
        };
        verification.allGood = Object.values(verification).every(Boolean);
        stats.verification = verification;



        return {
            success: true,
            stats: stats,
            backupInfo: {
                createdBy: backupData.createdBy,
                createdAt: backupData.createdAt,
                name: backupData.name,
                guildName: backupData.guildName
            }
        };
    } catch (error) {
        console.error('خطأ في استعادة النسخة:', error);
        return { success: false, error: error.message };
    }
}

async function getBackupsForGuild(guildId) {
    try {
        const backupFiles = (await fs.promises.readdir(backupsDir)).filter(file =>
            file.startsWith(guildId) && file.endsWith('.json')
        );

        const backups = [];
        for (const file of backupFiles) {
            const backupData = await readJSON(path.join(backupsDir, file));
            if (!backupData || typeof backupData !== 'object') continue;
            backups.push({
                fileName: file,
                name: backupData.name || file.replace('.json', ''),
                createdBy: backupData.createdBy || null,
                createdAt: backupData.createdAt || 0,
                stats: backupData.stats || {},
                guildName: backupData.guildName || 'Unknown Guild'
            });
        }
        return backups.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
        console.error('خطأ في قراءة النسخ:', error);
        return [];
    }
}

async function getAllBackups() {
    try {
        const backupFiles = (await fs.promises.readdir(backupsDir)).filter(file =>
            file.endsWith(".json")
        );

        const backups = [];
        for (const file of backupFiles) {
            const backupData = await readJSON(path.join(backupsDir, file));
            if (!backupData || typeof backupData !== 'object') continue;
            backups.push({
                fileName: file,
                name: backupData.name || file.replace('.json', ''),
                createdBy: backupData.createdBy || null,
                createdAt: backupData.createdAt || 0,
                stats: backupData.stats || {},
                guildName: backupData.guildName || 'Unknown Guild',
                guildId: backupData.guildId || null
            });
        }
        return backups.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
        console.error("خطأ في قراءة النسخ:", error);
        return [];
    }
}

function deleteBackup(backupFileName) {
    try {
        const backupFilePath = path.join(backupsDir, backupFileName);
        if (fs.existsSync(backupFilePath)) {
            fs.unlinkSync(backupFilePath);
            return { success: true };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}


async function handleProtectUsersSub(message, args) {
    const sub = (args[1] || 'list').toLowerCase();
    const cfg = getGuildProtectionConfig(message.guild.id) || { trustedUsers: [] };

    if (sub === 'add') {
        const user = message.mentions.users.first();
        if (!user) return message.channel.send({ embeds: [colorManager.createEmbed().setDescription('❌ منشن الشخص')] });
        cfg.trustedUsers = Array.from(new Set([...(cfg.trustedUsers || []), user.id]));
        setGuildProtectionConfig(message.guild.id, cfg);
        if (cfg.enabled) await refreshProtectionStateFast(message.guild, cfg);
        return message.channel.send({ embeds: [colorManager.createEmbed().setDescription(`✅ تمت إضافة <@${user.id}> للموثوقين`)] });
    }

    if (sub === 'remove') {
        const user = message.mentions.users.first();
        if (!user) return message.channel.send({ embeds: [colorManager.createEmbed().setDescription('❌ منشن الشخص')] });
        cfg.trustedUsers = (cfg.trustedUsers || []).filter(id => id !== user.id);
        setGuildProtectionConfig(message.guild.id, cfg);
        if (cfg.enabled) await refreshProtectionStateFast(message.guild, cfg);
        return message.channel.send({ embeds: [colorManager.createEmbed().setDescription(`✅ تمت إزالة <@${user.id}> من الموثوقين`)] });
    }

    const trusted = cfg.trustedUsers || [];
    const text = trusted.length ? trusted.map(id => `• <@${id}> (${id})`).join('\n') : 'لا يوجد موثوقين';
    return message.channel.send({ embeds: [colorManager.createEmbed().setTitle('Trusted Users').setDescription(text)] });
}

async function handleProtectSetup(message, client) {
    ensureProtectionEngine(client);
    const backups = (await getAllBackups()).filter(backup => backup.guildId === message.guild.id).slice(0, 25);
    if (!backups.length) {
        return message.channel.send({ embeds: [colorManager.createEmbed().setDescription('❌ لا توجد نسخ') ]});
    }

    const backupMenu = new StringSelectMenuBuilder()
        .setCustomId(`backup_protect_backup_${message.author.id}`)
        .setPlaceholder('اختر النسخة الأساسية')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(backups.map(b => ({ label: b.name, description: `${new Date(b.createdAt).toLocaleString('en-US')}`, value: b.fileName })));

    const typeMenu = new StringSelectMenuBuilder()
        .setCustomId(`backup_protect_types_${message.author.id}`)
        .setPlaceholder('اختر نوع الحماية')
        .setMinValues(1)
        .setMaxValues(4)
        .addOptions([
            { label: 'رومات وكاتقوري', value: 'channelsCategories', description: 'حماية القنوات والتصنيفات' },
            { label: 'رولات وبرمشنات', value: 'rolesPermissions', description: 'حماية الرولات والصلاحيات' },
            { label: 'طرد وباند', value: 'kickBan', description: 'حماية الطرد والحظر' },
            { label: 'اعدادات السيرفر', value: 'serverSettings', description: 'حماية إعدادات السيرفر' }
        ]);

    const sent = await message.channel.send({
        embeds: [colorManager.createEmbed().setTitle('Protect Setup').setDescription('اختر النسخة ثم نوع الحماية')],
        components: [new ActionRowBuilder().addComponents(backupMenu), new ActionRowBuilder().addComponents(typeMenu)]
    });

    const state = { backupFile: null, types: [] };
    const collector = sent.createMessageComponentCollector({ filter: i => i.user.id === message.author.id, time: 90000 });

    const getTypeLabel = (value) => ({
        channelsCategories: 'رومات وكاتقوري',
        rolesPermissions: 'رولات وبرمشنات',
        kickBan: 'طرد وباند',
        serverSettings: 'اعدادات السيرفر'
    }[value] || value);

    collector.on('collect', async (interaction) => {
        if (!interaction.isStringSelectMenu()) return;
        if (interaction.customId.includes('_backup_')) state.backupFile = interaction.values[0];
        if (interaction.customId.includes('_types_')) state.types = interaction.values;

        const selectedBackupName = backups.find(b => b.fileName === state.backupFile)?.name || state.backupFile || 'غير محدد';
        const selectedTypes = state.types.length ? state.types.map(getTypeLabel).join('، ') : 'غير محدد';

        if (!state.backupFile || !state.types.length) {
            await interaction.update({
                embeds: [colorManager.createEmbed().setTitle('Protect Setup').setDescription(
                    `اختر النسخة ثم نوع الحماية

` +
                    `• النسخة المختارة: **${selectedBackupName}**
` +
                    `• الأنواع المختارة: **${selectedTypes}**

` +
                    `✅ تم حفظ اختيارك الحالي، أكمل باقي الاختيارات.`
                )],
                components: [new ActionRowBuilder().addComponents(backupMenu), new ActionRowBuilder().addComponents(typeMenu)]
            }).catch(err => console.error("Interaction edit error:", err?.message || err));
            return;
        }

        const cfg = {
            enabled: true,
            backupFile: state.backupFile,
            latestBackupFile: state.backupFile,
            fallbackBackupFile: null,
            enabledBy: message.author.id,
            enabledAt: Date.now(),
            trustedUsers: getGuildProtectionConfig(message.guild.id)?.trustedUsers || [],
            protectionTypes: {
                channelsCategories: state.types.includes('channelsCategories'),
                rolesPermissions: state.types.includes('rolesPermissions'),
                kickBan: state.types.includes('kickBan'),
                serverSettings: state.types.includes('serverSettings')
            },
            expectedChannels: getCurrentChannelCount(message.guild),
            expectedRoles: getCurrentRoleCount(message.guild)
        };

        setGuildProtectionConfig(message.guild.id, cfg);

        await refreshProtectionStateFast(message.guild, cfg);

        await interaction.update({
            embeds: [colorManager.createEmbed().setDescription(`✅ تم تفعيل الحماية
النسخة: ${selectedBackupName}
الأنواع: ${selectedTypes}`)],
            components: []
        }).catch(err => console.error("Failed to restore members:", err));

        collector.stop('done');
    });

    collector.on('end', () => {
        sent.edit({ components: [] }).catch(err => console.error(`Failed to edit sent message ${sent.id}:`, err));
    });
}

module.exports = {
    name: 'backup',
    description: 'نظام النسخ الاحتياطي الشامل للسيرفر',

    async execute(message, args, { client, BOT_OWNERS }) {
        const isOwner = BOT_OWNERS.includes(message.author.id);
        const isServerOwner = message.guild.ownerId === message.author.id;

        if (!isOwner && !isServerOwner) {
            const errorEmbed = colorManager.createEmbed()
                .setDescription('❌ **من الميانه بس**');
            return message.channel.send({ embeds: [errorEmbed] });
        }

        const sub = (args[0] || '').toLowerCase();
        if (sub === 'protect') {
            return handleProtectSetup(message, client);
        }
        if (sub === 'users') {
            return handleProtectUsersSub(message, args);
        }

        const mainEmbed = colorManager.createEmbed()
            .setTitle('Backup System')
            .setDescription('**اختر ماتريد**')
            .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436852524224348160/cloud-sync.png?ex=69111cb1&is=690fcb31&hm=92bf5525fbc9000c7628d22b886e75836a249599b3dad22fcbc78089fb956a1b&');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('backup_create')
                .setLabel('Copy')
                .setEmoji('<:emoji_5:1436850367785734144>')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('backup_restore')
                .setLabel('Paste')
                .setEmoji('<:emoji_5:1436850396047081686>')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('backup_list')
                .setLabel('Your Backups')
                .setEmoji('<:emoji_8:1436850506008891632>')
                .setStyle(ButtonStyle.Secondary)
        );

        const msg = await message.channel.send({ embeds: [mainEmbed], components: [row] });

        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === message.author.id,
            time: 86400000 // 24 ساعة بدلاً من 10 دقائق
        });

        collector.on('collect', async interaction => {
            // فحص سريع وتأجيل فوري
            try {
                // تأجيل التفاعل فوراً (ماعدا المودال و backup_create)
                if (!interaction.customId.includes('modal') && interaction.customId !== 'backup_create') {
                    await interaction.deferUpdate().catch(err => console.error("Failed to defer update:", err));
                }
            } catch (error) {
                return; // تجاهل الأخطاء والخروج
            }

            if (interaction.customId === 'backup_create') {
                const modal = new ModalBuilder()
                    .setCustomId('backup_create_modal')
                    .setTitle('Backup Settings');

                const nameInput = new TextInputBuilder()
                    .setCustomId('backup_name')
                    .setLabel('اسم النسخة (اختياري)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setPlaceholder('مثال : Aa Backup');

                modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
                await interaction.showModal(modal);

            } else if (interaction.customId === 'backup_restore') {
                const allBackups = (await getAllBackups()).filter(backup => backup.guildId === message.guild.id);

                if (allBackups.length === 0) {
                    return interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription('❌ **لا توجد نسخ احتياطية متوفرة**')],
                        components: []
                    });
                }

                const options = allBackups.map(backup => ({
                    label: backup.name,
                    description: `${backup.guildName || 'سيرفر'} | ${new Date(backup.createdAt).toLocaleString('en-US')}`,
                    value: backup.fileName
                })).slice(0, 25);

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('backup_select_restore')
                    .setPlaceholder('Choose')
                    .addOptions(options);

                const selectEmbed = colorManager.createEmbed()
                    .setTitle('Choose Your Backup')
                    .setDescription(`**عدد النسخ :** ${allBackups.length}`);

                await interaction.editReply({
                    embeds: [selectEmbed],
                    components: [new ActionRowBuilder().addComponents(selectMenu)]
                });

            } else if (interaction.customId === 'backup_list') {
                const backups = (await getAllBackups()).filter(backup => backup.guildId === message.guild.id);

                if (backups.length === 0) {
                    return interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription('❌ **لا توجد نسخ احتياطية**')],
                        components: []
                    });
                }

                const currentPage = 0;
                const backup = backups[currentPage];

                if (!backup) {
                    return interaction.editReply({ 
                        embeds: [colorManager.createEmbed().setDescription('❌ خطأ في تحميل البيانات')],
                        components: []
                    });
                }

                let listText = '';
                listText += `**${backup.name}**\n\n`;
                listText += `**Server :** ${backup.guildName || 'سيرفر غير معروف'}\n\n`;
                listText += `**Time :** ${new Date(backup.createdAt).toLocaleString('en-US')}\n\n`;
                listText += `**By :** <@${backup.createdBy}>\n\n`;
                listText += `**Stats :**\n`;
                listText += `• Roles : ${backup.stats.roles}\n`;
                listText += `• Categories : ${backup.stats.categories}\n`;
                listText += `• Channels : ${backup.stats.channels}\n`;
                listText += `• Messages : ${backup.stats.messages || 0}\n`;
                listText += `• Threads : ${backup.stats.threads || 0}\n`;
                listText += `• Bans : ${backup.stats.bans || 0}\n`;
                listText += `• Members : ${backup.stats.members || 0}\n\n`;

                const listEmbed = colorManager.createEmbed()
                    .setTitle('Backup List')
                    .setDescription(listText)
                    .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436853023539466352/cloud-storage.png?ex=69111d28&is=690fcba8&hm=456ed697389164d0ac1b8abd05577c39fa2e4c09fd22af2c38a7621c75470530&')
                    .setFooter({ text: `Page ${currentPage + 1}/${backups.length} | By Ahmed.` });

                const navigationRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('backup_page_prev')
                        .setLabel('Previous')
                        .setEmoji('<:emoji_13:1436828682978332845>')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentPage === 0),
                    new ButtonBuilder()
                        .setCustomId('backup_page_next')
                        .setLabel('Next')
                        .setEmoji('<:emoji_14:1429263186539974708>')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentPage === backups.length - 1)
                );

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('backup_delete')
                        .setLabel('Delete Backup')
                        .setEmoji('<:emoji_2:1436850308780265615>')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('backup_back')
                        .setLabel('Back')
                        .setEmoji('<:emoji_31:1436828703517573283>')
                        .setStyle(ButtonStyle.Secondary)
                );

                if (!global.backupListPage) global.backupListPage = new Map();
                if (!global.backupListPageTimeouts) global.backupListPageTimeouts = new Map();
                global.backupListPage.set(interaction.user.id, currentPage);
                if (global.backupListPageTimeouts.has(interaction.user.id)) {
                    clearTimeout(global.backupListPageTimeouts.get(interaction.user.id));
                }
                global.backupListPageTimeouts.set(interaction.user.id, setTimeout(() => {
                    global.backupListPage.delete(interaction.user.id);
                    global.backupListPageTimeouts.delete(interaction.user.id);
                    console.log(`Backup list page session for user ${interaction.user.id} expired and was cleaned up.`);
                }, 15 * 60 * 1000));

                try {
                    await interaction.editReply({ 
                        embeds: [listEmbed], 
                        components: [navigationRow, actionRow] 
                    });
                } catch (error) {
                    // إذا فشل editReply، استخدم followUp
                    await interaction.followUp({ 
                        embeds: [listEmbed], 
                        components: [navigationRow, actionRow],
                        ephemeral: true
                    });
                }

            } else if (interaction.customId === 'backup_page_prev' || interaction.customId === 'backup_page_next') {
                if (!global.backupListPage) global.backupListPage = new Map();
                if (!global.backupListPageTimeouts) global.backupListPageTimeouts = new Map();

                let currentPage = global.backupListPage.get(interaction.user.id) || 0;
                const backups = (await getAllBackups()).filter(backup => backup.guildId === message.guild.id);

                if (backups.length === 0) {
                    return interaction.editReply({ 
                        embeds: [colorManager.createEmbed().setDescription('❌ لا توجد نسخ احتياطية')],                        components: []
                    });              }

                if (interaction.customId === 'backup_page_prev' && currentPage > 0) {
                    currentPage--;
                } else if (interaction.customId === 'backup_page_next' && currentPage < backups.length - 1) {
                    currentPage++;
                } else {
                    return; // لا تفعل شيء إذا في أول/آخر صفحة
                }

                global.backupListPage.set(interaction.user.id, currentPage);
                if (global.backupListPageTimeouts.has(interaction.user.id)) {
                    clearTimeout(global.backupListPageTimeouts.get(interaction.user.id));
                }
                global.backupListPageTimeouts.set(interaction.user.id, setTimeout(() => {
                    global.backupListPage.delete(interaction.user.id);
                    global.backupListPageTimeouts.delete(interaction.user.id);
                    console.log(`Backup list page session for user ${interaction.user.id} expired and was cleaned up.`);
                }, 15 * 60 * 1000));

                const backup = backups[currentPage];
                if (!backup) {
                    return interaction.editReply({ 
                        embeds: [colorManager.createEmbed().setDescription('❌ **خطأ في تحميل النسخة**')],
                        components: []
                    });
                }

                let listText = '';
                listText += `**${backup.name}**\n\n`;
                listText += `**Server :** ${backup.guildName || 'سيرفر غير معروف'}\n\n`;
                listText += `**Time :** ${new Date(backup.createdAt).toLocaleString('en-US')}\n\n`;
                listText += `**By :** <@${backup.createdBy}>\n\n`;
                listText += `**Stats :**\n`;
                listText += `• Roles : ${backup.stats.roles}\n`;
                listText += `• Categories : ${backup.stats.categories}\n`;
                listText += `• Channels : ${backup.stats.channels}\n`;
                listText += `• Messages : ${backup.stats.messages || 0}\n`;
                listText += `• Threads : ${backup.stats.threads || 0}\n`;
                listText += `• Bans : ${backup.stats.bans || 0}\n`;
                listText += `• Members : ${backup.stats.members || 0}\n\n`;

                const listEmbed = colorManager.createEmbed()
                    .setTitle('Backup List')
                    .setDescription(listText)
                    .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436853023539466352/cloud-storage.png?ex=69111d28&is=690fcba8&hm=456ed697389164d0ac1b8abd05577c39fa2e4c09fd22af2c38a7621c75470530&')
                    .setFooter({ text: `Page ${currentPage + 1}/${backups.length} | By Ahmed.` });

                const navigationRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('backup_page_prev')
                        .setLabel('Previous')
                        .setEmoji('<:emoji_13:1436828682978332845>')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentPage === 0),
                    new ButtonBuilder()
                        .setCustomId('backup_page_next')
                        .setLabel('Next')
                        .setEmoji('<:emoji_14:1429263186539974708>')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentPage === backups.length - 1)
                );

                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('backup_delete')
                        .setLabel('Delete Backup')
                        .setEmoji('<:emoji_2:1436850308780265615>')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('backup_back')
                        .setLabel('Back')
                        .setEmoji('<:emoji_31:1436828703517573283>')
                        .setStyle(ButtonStyle.Secondary)
                );

                try {
                    await interaction.editReply({ 
                        embeds: [listEmbed], 
                        components: [navigationRow, actionRow] 
                    });
                } catch (error) {
                    await interaction.followUp({ 
                        embeds: [listEmbed], 
                        components: [navigationRow, actionRow],
                        ephemeral: true
                    });
                }

            } else if (interaction.customId === 'backup_delete') {
                const backups = (await getAllBackups()).filter(backup => backup.guildId === message.guild.id);

                if (backups.length === 0) {
                    return interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription('❌ **لا توجد نسخ احتياطية للحذف**')],
                        components: []
                    });
                }

                const options = backups.map(backup => ({
                    label: backup.name,
                    description: `${backup.guildName || 'Server'} | ${new Date(backup.createdAt).toLocaleString('en-US')}`,
                    value: backup.fileName
                })).slice(0, 25);

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('backup_select_delete')
                    .setPlaceholder('اختر نسخة للحذف')
                    .addOptions(options);

                await interaction.editReply({
                    embeds: [colorManager.createEmbed().setTitle('Delete Backup').setDescription('**اختر النسخة المراد حذفها**')],
                    components: [new ActionRowBuilder().addComponents(selectMenu)]
                });

            } else if (interaction.customId === 'backup_back') {
                if (global.backupListPage) {
                    global.backupListPage.delete(interaction.user.id);
                    if (global.backupListPageTimeouts.has(interaction.user.id)) {
                        clearTimeout(global.backupListPageTimeouts.get(interaction.user.id));
                        global.backupListPageTimeouts.delete(interaction.user.id);
                    }
                }
                await interaction.editReply({ embeds: [mainEmbed], components: [row] });

            } else if (interaction.customId === 'backup_select_restore') {
                const selectedFile = interaction.values[0];
                const backupData = await readJSON(path.join(backupsDir, selectedFile));

                const optionsEmbed = colorManager.createEmbed()
                    .setTitle('Choose What You Need')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436853578731094047/data-transfer.png?ex=69111dac&is=690fcc2c&hm=af1c37b8ee32f4ec00b45aeb7adfd7df30765861ee3efae994b78b12e0377339&')
                    .setDescription('**حدد ما تريد استعادته من النسخة :**\n\n' +
                        `**Json :** ${backupData.stats.files} ملف\n` +
                        `**Roles :** ${backupData.stats.roles} رول\n` +
                        `**Categories :** ${backupData.stats.categories} كاتوقري\n` +
                        `**Channels :** ${backupData.stats.channels} روم\n` +
                        `**Bans :** ${backupData.stats.bans || 0} حظر\n` +
                        `**Members Roles :** ${backupData.stats.members || 0} عضو\n\n` +
                        '⚠️ **Current Choose Will Deleted**');

                const selectOptions = new StringSelectMenuBuilder()
                    .setCustomId(`backup_options_${selectedFile}`)
                    .setPlaceholder('Backup Options')
                    .setMinValues(1)
                    .setMaxValues(8)
                    .addOptions([
                        { label: 'Server Settings', value: 'serverinfo', description: 'الاسم ، الصورة ، البنر ' },
                        { label: 'Json', value: 'files', description: `${backupData.stats.files} ملف` },
                        { label: 'Roles', value: 'roles', description: `${backupData.stats.roles} رول` },
                        { label: 'Categories', value: 'categories', description: `${backupData.stats.categories} كاتوقري` },
                        { label: 'Channels', value: 'channels', description: `${backupData.stats.channels} روم` },
                        { label: 'Emojis', value: 'emojis', description: `${backupData.stats.emojis} إيموجي` },
                        { label: 'Bans', value: 'bans', description: `${backupData.stats.bans || 0} حظر` },
                        { label: 'Members Roles', value: 'memberroles', description: `${backupData.stats.members || 0} عضو` }
                    ]);

                await interaction.editReply({
                    embeds: [optionsEmbed],
                    components: [
                        new ActionRowBuilder().addComponents(selectOptions),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('backup_cancel')
                                .setLabel('Cancel')
                                .setEmoji('<:emoji_2:1436850308780265615>')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ]
                });

            } else if (interaction.customId.startsWith('backup_options_')) {
                const selectedFile = interaction.customId.replace('backup_options_', '');
                const selectedOptions = interaction.values;
                const backupData = await readJSON(path.join(backupsDir, selectedFile));

                const currentGuild = message.guild;
                const currentRoles = currentGuild.roles.cache.filter(r => !r.managed && r.id !== currentGuild.id).size;
                const currentCategories = currentGuild.channels.cache.filter(ch => ch.type === ChannelType.GuildCategory).size;
                const currentChannels = currentGuild.channels.cache.size;

                let statsText = '**Stats :**\n\n';

                if (selectedOptions.includes('serverinfo')) {
                    statsText += ` **Serverinfo :**سيتم تحديث الاسم والصورة والبنر\n\n`;
                }
                if (selectedOptions.includes('files')) {
                    statsText += ` **Json :** سيتم استعادة ${backupData.stats.files} ملف\n\n`;
                }
                if (selectedOptions.includes('roles')) {
                    statsText += ` **Roles:**\n- سيتم حذف : ${currentRoles} رول\n- سيتم إنشاء : ${backupData.stats.roles} رول\n\n`;
                }
                if (selectedOptions.includes('categories')) {
                    statsText += ` **Categories:**\n- سيتم حذف : ${currentCategories} كاتوقري\n- سيتم إنشاء : ${backupData.stats.categories} كاتوقري\n\n`;
                }
                if (selectedOptions.includes('channels')) {
                    statsText += ` **Channels :**\n- سيتم حذف : ${currentChannels} روم\n- سيتم إنشاء : ${backupData.stats.channels} روم\n\n`;
                }
                if (selectedOptions.includes('emojis')) {
                    statsText += ` **Emojis:** سيتم إنشاء : ${backupData.stats.emojis} إيموجي\n\n`;
                }
                if (selectedOptions.includes('bans')) {
                    statsText += ` **Bans:** سيتم حظر : ${backupData.stats.bans || 0} مستخدم\n\n`;
                }
                if (selectedOptions.includes('memberroles')) {
                    statsText += ` **Members Roles:** سيتم استعادة رولات : ${backupData.stats.members || 0} عضو\n\n`;
                }

                const confirmEmbed = colorManager.createEmbed()
                    .setTitle('Confirm Restore')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436854129791340724/hourglass_1.png?ex=69111e30&is=690fccb0&hm=81b3a4c95fc8d391b044c3b03f74874e8f2b6c741d7574e2a84827714f306241&')
                    .setDescription(statsText + '\n**هل أنت متأكد من المتابعة؟**');

                const confirmId = `conf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                if (!global.backupConfirmData) global.backupConfirmData = new Map();
                if (!global.backupConfirmDataTimeouts) global.backupConfirmDataTimeouts = new Map();
                global.backupConfirmData.set(confirmId, { fileName: selectedFile, options: selectedOptions });
                global.backupConfirmDataTimeouts.set(confirmId, setTimeout(() => {
                    global.backupConfirmData.delete(confirmId);
                    global.backupConfirmDataTimeouts.delete(confirmId);
                    console.log(`Backup confirmation session ${confirmId} expired and was cleaned up.`);
                }, 15 * 60 * 1000));

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(confirmId)
                        .setLabel('Confirm')
                    .setEmoji('<:emoji_1:1436850272734285856>')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('backup_cancel')
                        .setLabel('Cancel')
                    .setEmoji('<:emoji_1:1436850215154880553>')
                        .setStyle(ButtonStyle.Secondary)
                );

                await interaction.editReply({ embeds: [confirmEmbed], components: [confirmRow] });

            } else if (interaction.customId.startsWith('conf_')) {
                const confirmData = global.backupConfirmData?.get(interaction.customId);
                if (!confirmData) {
                    return interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription('❌ **انتهت صلاحية هذا الطلب، الرجاء المحاولة مرة أخرى**')],
                        components: []
                    });
                }

                const fileName = confirmData.fileName;
                const options = confirmData.options;

                global.backupConfirmData.delete(interaction.customId);
                clearTimeout(global.backupConfirmDataTimeouts.get(interaction.customId));
                global.backupConfirmDataTimeouts.delete(interaction.customId);

                const progressEmbed = colorManager.createEmbed()
                    .setDescription(' **جاري الاستعادة... قد يستغرق هذا عدة دقائق**')
                .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436854129791340724/hourglass_1.png?ex=69111e30&is=690fccb0&hm=81b3a4c95fc8d391b044c3b03f74874e8f2b6c741d7574e2a84827714f306241&');

                const progressMsg = await interaction.editReply({
                    embeds: [progressEmbed],
                    components: []
                });

                const result = await restoreBackup(fileName, message.guild, interaction.user.id, options, progressMsg);

                if (result.success) {
                    let successText = '✅ **Done!**\n\n';

                    if (options.includes('serverinfo')) successText += `Serveinfo Done ✅️\n`;
                    if (options.includes('files')) successText += `Json Done : ${result.stats.filesRestored}\n`;
                    if (options.includes('roles')) successText += ` Roles Deleted : ${result.stats.rolesDeleted} | Created : ${result.stats.rolesCreated}\n`;
                    if (options.includes('categories')) successText += ` Categories Deleted : ${result.stats.categoriesDeleted} | Created : ${result.stats.categoriesCreated}\n`;
                    if (options.includes('channels')) successText += ` Channel Deleted : ${result.stats.channelsDeleted} | Created : ${result.stats.channelsCreated}\n`;
                    if (options.includes('emojis')) successText += `Done Paste Emojis\n`;
                    if (options.includes('bans')) successText += ` Bans Restored : ${result.stats.bansRestored}\n`;
                    if (options.includes('memberroles')) successText += ` Members Roles Restored : ${result.stats.memberRolesRestored}\n`;

                    if (result.stats.errors.length > 0) {
                        successText += `\n⚠️ **Warns :** ${result.stats.errors.slice(0, 5).join('\n')}`;
                        if (result.stats.errors.length > 5) {
                            successText += `\n... و ${result.stats.errors.length - 5} خطأ آخر`;
                        }
                    }

                    await interaction.editReply({ embeds: [colorManager.createEmbed().setDescription(successText)] });

                    logEvent(client, message.guild, {
                        type: 'BOT_SETTINGS',
                        title: 'استعادة نسخة احتياطية',
                        description: ` Done : ${options.join(', ')}`,
                        user: interaction.user
                    });
                } else {
                    await interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription(`❌ **Failed :** ${result.error}`)]
                    });
                }

            } else if (interaction.customId === 'backup_select_delete') {
                const selectedFile = interaction.values[0];
                const result = deleteBackup(selectedFile);

                if (result.success) {
                    await interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription('✅ **Backup Deleted**')],
                        components: []
                    });
                    try {
                        await interaction.editReply({ embeds: [mainEmbed], components: [row] });
                    } catch (e) {}
                } else {
                    await interaction.editReply({
                        embeds: [colorManager.createEmbed().setDescription(`❌ ${result.error}`)],
                        components: []
                    });
                }

            } else if (interaction.customId === 'backup_cancel') {
                await interaction.editReply({ embeds: [mainEmbed], components: [row] });
            }
        });

        collector.on('end', () => {
            msg.edit({ components: [] }).catch(() => {});
        });
    }
};

module.exports.getAllBackups = getAllBackups;
module.exports.restoreBackup = restoreBackup;

// معالج مودال + أزرار الاستعادة من نقطة موحّدة لمنع تكرار listeners
const BACKUP_INTERACTION_HANDLER_KEY = Symbol.for('ress.backup.interactionHandler');

async function handleBackupModalSubmit(interaction, client) {
    if (!interaction.isModalSubmit() || interaction.customId !== 'backup_create_modal') return false;

    if (!interaction.isRepliable()) return true;
    if (interaction.replied || interaction.deferred) return true;

    const interactionAge = Date.now() - interaction.createdTimestamp;
    if (interactionAge > 180000) return true;

    try {
        await interaction.deferReply({ ephemeral: true });

        const backupName = interaction.fields.getTextInputValue('backup_name') || `backup_${Date.now()}`;

        const progressEmbed = colorManager.createEmbed()
            .setDescription('**جاري إنشاء النسخة...**')
            .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436854129791340724/hourglass_1.png?ex=69111e30&is=690fccb0&hm=81b3a4c95fc8d391b044c3b03f74874e8f2b6c741d7574e2a84827714f306241&');

        const progressMsg = await interaction.editReply({ embeds: [progressEmbed] });
        const result = await createBackup(interaction.guild, interaction.user.id, backupName, progressMsg);

        if (result.success) {
            const successEmbed = colorManager.createEmbed()
                .setTitle('✅ Complete Backup')
                .setThumbnail('https://cdn.discordapp.com/attachments/1436815242024714390/1436854853333946579/server-check.png?ex=69111edc&is=690fcd5c&hm=d0b1e25e195ca633c6251ec68c4fd080aa369be0b2e78de7c5727614cfa47d32&')
                .addFields([
                    { name: 'Settings', value: result.data.name, inline: true },
                    { name: 'Json', value: result.data.stats.files.toString(), inline: true },
                    { name: 'Roles', value: result.data.stats.roles.toString(), inline: true },
                    { name: 'Categories', value: result.data.stats.categories.toString(), inline: true },
                    { name: 'Channel', value: result.data.stats.channels.toString(), inline: true },
                    { name: 'Messages', value: (result.data.stats.messages || 0).toString(), inline: true },
                    { name: 'Threads', value: (result.data.stats.threads || 0).toString(), inline: true },
                    { name: 'Bans', value: (result.data.stats.bans || 0).toString(), inline: true },
                    { name: 'Members Roles', value: (result.data.stats.members || 0).toString(), inline: true },
                    { name: 'File', value: `${(JSON.stringify(result.data).length / 1024).toFixed(2)} Kb`, inline: true }
                ]);

            await interaction.editReply({ embeds: [successEmbed] });

            logEvent(client, interaction.guild, {
                type: 'BOT_SETTINGS',
                title: 'Create Backup',
                description: result.data.name,
                user: interaction.user
            });
        } else {
            await interaction.editReply({
                embeds: [colorManager.createEmbed().setDescription(`❌ **فشل:** ${result.error}`)]
            });
        }
    } catch (error) {
        if (error.code === 10062 || error.code === 40060 || error.code === 10008) {
            console.log('تم تجاهل خطأ معروف في backup_create_modal');
            return true;
        }

        console.error('❌ خطأ في معالجة مودال backup_create:', error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ حدث خطأ في إنشاء النسخة الاحتياطية',
                ephemeral: true
            }).catch(err => console.error("Interaction reply error:", err?.message || err));
        }
    }

    return true;
}

async function handleBackupSystemInteraction(interaction, client) {
    const handledBulk = await handleBulkRestoreAdminRoles(interaction);
    if (handledBulk) return true;

    const handledAdminRestore = await handleRestoreAdminRoles(interaction);
    if (handledAdminRestore) return true;

    return handleBackupModalSubmit(interaction, client);
}

function registerBackupModalHandler(client) {
    ensureProtectionEngine(client);

    if (client[BACKUP_INTERACTION_HANDLER_KEY]) return;

    const unifiedHandler = async (interaction) => {
        await handleBackupSystemInteraction(interaction, client);
    };

    client.on('interactionCreate', unifiedHandler);
    client[BACKUP_INTERACTION_HANDLER_KEY] = unifiedHandler;
    console.log('✅ تم تسجيل معالج backup الموحد مرة واحدة');
}

module.exports.registerBackupModalHandler = registerBackupModalHandler;
module.exports.handleInteraction = (interaction, client) => handleBackupSystemInteraction(interaction, client);
