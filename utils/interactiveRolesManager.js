const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { collectUserStats, createUserStatsEmbed } = require('./userStatsCollector');
const colorManager = require('./colorManager');
const { getDatabase } = require('./database');
const { isUserBlocked } = require('../commands/block');

const interactiveRolesPath = path.join(__dirname, '..', 'data', 'interactiveRoles.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
const REJECTION_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

function getConfiguredAdminRoles() {
    try {
        if (!fs.existsSync(adminRolesPath)) return [];
        const data = JSON.parse(fs.readFileSync(adminRolesPath, 'utf8'));
        return Array.isArray(data) ? data.filter((roleId) => typeof roleId === 'string' && roleId.length > 0) : [];
    } catch (error) {
        console.error('Error loading admin roles for interactive applications:', error);
        return [];
    }
}

function loadSettings() {
    try {
        if (fs.existsSync(interactiveRolesPath)) {
            const data = JSON.parse(fs.readFileSync(interactiveRolesPath, 'utf8'));
            if (!data.settings) {
                data.settings = { approvers: [], interactiveRoles: [], requestChannel: null, exceptions: [] };
            }
            if (!Array.isArray(data.settings.exceptions)) {
                data.settings.exceptions = [];
            } else {
                data.settings.exceptions = data.settings.exceptions.map((entry) => {
                    if (entry && Array.isArray(entry.keywords)) {
                        return { roleId: entry.roleId, keywords: entry.keywords.map(keyword => keyword.toLowerCase()) };
                    }
                    if (entry && typeof entry.keyword === 'string') {
                        return { roleId: entry.roleId, keywords: [entry.keyword.toLowerCase()] };
                    }
                    return entry;
                }).filter(entry => entry && entry.roleId && Array.isArray(entry.keywords));
            }
            if (!data.exceptionCooldowns || typeof data.exceptionCooldowns !== 'object') {
                data.exceptionCooldowns = {};
            }
            if (!data.pendingExceptionRequests || typeof data.pendingExceptionRequests !== 'object' || Array.isArray(data.pendingExceptionRequests)) {
                data.pendingExceptionRequests = {};
            }
            if (!data.newPendingRequests || typeof data.newPendingRequests !== 'object' || Array.isArray(data.newPendingRequests)) {
                data.newPendingRequests = {};
            }
            if (!data.newRoleCooldowns || typeof data.newRoleCooldowns !== 'object' || Array.isArray(data.newRoleCooldowns)) {
                data.newRoleCooldowns = {};
            }
            if (!data.settings.applicationSystem || typeof data.settings.applicationSystem !== 'object') {
                data.settings.applicationSystem = {};
            }
            data.settings.applicationSystem.enabled = Boolean(data.settings.applicationSystem.enabled);
            data.settings.applicationSystem.requestsChannelId = data.settings.applicationSystem.requestsChannelId || null;
            data.settings.applicationSystem.managersChannelId = data.settings.applicationSystem.managersChannelId || null;
            data.settings.applicationSystem.roleConditions = data.settings.applicationSystem.roleConditions || {};
            data.settings.applicationSystem.managersImagePath = data.settings.applicationSystem.managersImagePath || null;
            return data;
        }
    } catch (error) {
        console.error('Error loading interactive roles settings:', error);
    }
    return {
        settings: { approvers: [], interactiveRoles: [], requestChannel: null, exceptions: [] },
        pendingRequests: {},
        cooldowns: {},
        exceptionCooldowns: {},
        pendingExceptionRequests: {},
        newPendingRequests: {},
        newRoleCooldowns: {}
    };
}

function saveSettings(data) {
    try {
        fs.writeFileSync(interactiveRolesPath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving interactive roles settings:', error);
        return false;
    }
}

async function hasRecentPendingRequestMessage(guild, requestChannelId, targetId, limit = 50) {
    if (!requestChannelId) return false;

    const requestChannel = guild.channels.cache.get(requestChannelId);
    if (!requestChannel || typeof requestChannel.messages?.fetch !== 'function') return false;

    try {
        const recentMessages = await requestChannel.messages.fetch({ limit });
        return recentMessages.some((msg) => {
            const hasTargetInContent = typeof msg.content === 'string' && msg.content.includes(`<@${targetId}>`);
            const hasInteractiveRequestEmbed = msg.embeds?.some((embed) => {
                const title = (embed.title || '').toLowerCase();
                return title.includes('طلب رول تفاعلي');
            });
            const hasReviewComponents = Array.isArray(msg.components)
                && msg.components.some((row) => Array.isArray(row.components)
                    && row.components.some((component) => {
                        const customId = component?.customId || '';
                        return customId.startsWith('int_approve_') || customId.startsWith('int_reject_trigger_');
                    }));

            return hasTargetInContent && hasInteractiveRequestEmbed && hasReviewComponents;
        });
    } catch (error) {
        console.error('Error while scanning recent interactive request messages:', error);
        return false;
    }
}

async function hasValidPendingRequest(settings, guild, targetId) {
    const pendingRequest = settings.pendingRequests?.[targetId];
    if (!pendingRequest) return false;

    const requestChannelId = settings.settings?.requestChannel;
    const requestChannel = requestChannelId ? guild.channels.cache.get(requestChannelId) : null;

    if (requestChannel && pendingRequest.messageId) {
        try {
            const pendingMessage = await requestChannel.messages.fetch(pendingRequest.messageId);
            if (pendingMessage) return true;
        } catch (error) {
            // Request message no longer exists, continue to fallback checks.
        }
    }

    const foundRecentRequest = await hasRecentPendingRequestMessage(guild, requestChannelId, targetId, 50);
    if (foundRecentRequest) return true;

    // The pending entry is stale and should be cleaned up.
    delete settings.pendingRequests[targetId];
    saveSettings(settings);
    return false;
}

async function handleMessage(message) {
    if (message.author.bot) return;
    
    const settings = loadSettings();
    if (settings.settings?.applicationSystem?.enabled) return;
    if (!settings.settings.requestChannel || message.channel.id !== settings.settings.requestChannel) return;

    // Avoid processing the same message more than once. Sometimes bots may receive multiple events
    // for the same user message (e.g., due to edits or other discord.js internals). Keep track of
    // processed messages using a global set. This prevents duplicate request embeds being sent for
    // a single mention. Entries are cleared automatically after a delay to free memory.
    if (!global.processedInteractiveMessages) global.processedInteractiveMessages = new Set();
    if (global.processedInteractiveMessages.has(message.id)) return;
    global.processedInteractiveMessages.add(message.id);

    // Check if message contains a mention or ID (anywhere in the content)
    const mentionMatch = message.content.match(/<@!?(\d+)>|(?<=\s|^)(\d{17,19})(?=\s|$)/);
    if (!mentionMatch) {
        // Delete message if it doesn't contain a mention/ID in the request channel
        try { await message.delete(); } catch (e) {}
        return;
    }

    const targetId = mentionMatch[1] || mentionMatch[2];
    // Use a lock to prevent concurrent requests for the same target. If the lock exists, delete
    // the triggering message and abort processing. The lock is cleared in a finally block below.
    if (!global.activeInteractiveRequests) global.activeInteractiveRequests = new Set();
    if (global.activeInteractiveRequests.has(targetId)) {
        try { await message.delete(); } catch (e) {}
        return;
    }
    global.activeInteractiveRequests.add(targetId);

    // Wrap the main logic in a try/finally so that the lock is always released, even if
    // exceptions occur or early returns happen. This avoids leaving the target locked,
    // which would block future requests and appear as if nothing is accepted.
    try {
        const targetMember = await message.guild.members.fetch(targetId).catch(() => null);

        // Always delete the original message in the request channel
        try { await message.delete(); } catch (e) {}

        if (!targetMember) {
            return;
        }

        if (isUserBlocked(targetId)) {
            const reply = await message.channel.send(`❌ <@${targetId}> محظور من استخدام النظام حالياً.`);
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        if (isUserBlocked(message.author.id)) {
            const reply = await message.channel.send('❌ أنت محظور من استخدام نظام الرولات التفاعلية.');
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        const normalizedContent = message.content.toLowerCase();
        const exceptions = settings.settings.exceptions || [];
        const exceptionRoleIds = new Set(
            exceptions
                .map((entry) => entry?.roleId)
                .filter((roleId) => typeof roleId === 'string' && roleId.length > 0)
        );
        const matchedException = exceptions
            .map((entry) => {
                if (!entry || !entry.roleId || !Array.isArray(entry.keywords)) return null;
                const matchedKeyword = entry.keywords.find((keyword) => keyword && normalizedContent.includes(keyword.toLowerCase()));
                if (!matchedKeyword) return null;
                return { roleId: entry.roleId, keyword: matchedKeyword.toLowerCase() };
            })
            .find(Boolean);
        const isExceptionAllowed = matchedException && !targetMember.roles.cache.has(matchedException.roleId);

        // Check if member already has any *non-exception* interactive role.
        // Exception roles are allowed to coexist and should not block normal requests.
        const hasNonExceptionInteractiveRole = targetMember.roles.cache.some(
            (r) => settings.settings.interactiveRoles.includes(r.id) && !exceptionRoleIds.has(r.id)
        );
        if (hasNonExceptionInteractiveRole && !isExceptionAllowed) {
            const reply = await message.channel.send(`⚠️ <@${targetId}> لديه بالفعل رولات تفاعلية.`);
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        if (matchedException && !settings.settings.interactiveRoles.includes(matchedException.roleId)) {
            const reply = await message.channel.send(`⚠️ رول الاستثناء لم يعد ضمن الرولات التفاعلية.`);
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        if (matchedException && targetMember.roles.cache.has(matchedException.roleId)) {
            const reply = await message.channel.send(`⚠️ <@${targetId}> لديه بالفعل رول الاستثناء.`);
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        if (isExceptionAllowed) {
            const exceptionCooldown = settings.exceptionCooldowns?.[targetId]?.[matchedException.roleId]?.[matchedException.keyword];
            if (exceptionCooldown && Date.now() < exceptionCooldown) {
                const timeLeft = Math.ceil((exceptionCooldown - Date.now()) / (1000 * 60 * 60));
                const reply = await message.channel.send(`❌ <@${targetId}> لديه كولداون لاستثناء هذه الكلمة. المتبقي: ${timeLeft} ساعة.`);
                setTimeout(() => reply.delete().catch(() => {}), 5000);
                return;
            }

            if (!settings.pendingExceptionRequests || typeof settings.pendingExceptionRequests !== 'object' || Array.isArray(settings.pendingExceptionRequests)) {
                settings.pendingExceptionRequests = {};
            }

            const hasPendingException = Object.values(settings.pendingExceptionRequests).some((req) => req.targetId === targetId);
            if (hasPendingException) {
                const reply = await message.channel.send(`⚠️ <@${targetId}> لديه طلب مستثنى معلق بالفعل.`);
                setTimeout(() => reply.delete().catch(() => {}), 5000);
                return;
            }

            let sentMessage = null;
            const userStats = await collectUserStats(targetMember);
            const statsEmbed = await createUserStatsEmbed(userStats, colorManager, true, message.member?.displayName ?? null, `<@${message.author.id}>`);
            statsEmbed.setTitle(' طلب رول تفاعلي (استثناء)')
                .setDescription(`**Admin :** <@${message.author.id}>\n**Member :** <@${targetId}>\n** الرول المستثنى :** <@&${matchedException.roleId}>\n**الكلمه:** ${matchedException.keyword}\n\n${message.content}`);

            const respConfigPath = path.join(__dirname, '..', 'data', 'respConfig.json');
            let globalImageUrl = null;
            try {
                if (fs.existsSync(respConfigPath)) {
                    const config = JSON.parse(fs.readFileSync(respConfigPath, 'utf8'));
                    globalImageUrl = config.guilds?.[message.guild.id]?.globalImageUrl;
                }
            } catch (e) {}

            const applicationId = `${Date.now()}_${targetId}`;
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`int_ex_approve_${applicationId}`)
                    .setLabel('Approve')
                    .setEmoji('<:emoji_1:1436850272734285856>')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`int_ex_reject_trigger_${applicationId}`)
                    .setLabel('Reject')
                    .setEmoji('<:emoji_1:1436850215154880553>')
                    .setStyle(ButtonStyle.Secondary)
            );

            const detailsMenu = new StringSelectMenuBuilder()
                .setCustomId(`int_ex_details_${applicationId}`)
                .setPlaceholder('تفاصيل عن العضو')
                .addOptions([
                    { label: 'Dates', description: 'عرض تواريخ الانضمام وإنشاء الحساب', value: 'dates' },
                    { label: 'Evaluation', description: 'عرض تقييم العضو والمعايير', value: 'evaluation' },
                    { label: 'Roles', description: 'عرض جميع الرولات للعضو', value: 'roles' },
                    { label: 'Stats', description: 'عرض تفاصيل النشاط', value: 'advanced_stats' },
                    { label: 'first ep', description: 'العودة للعرض الأساسي', value: 'simple_view' }
                ]);

            const row2 = new ActionRowBuilder().addComponents(detailsMenu);
            if (globalImageUrl) {
                statsEmbed.setImage(globalImageUrl);
            }

            const messageOptions = {
                content: `**طلب مستثنى من <@${message.author.id}> بخصوص <@${targetId}>**`,
                embeds: [statsEmbed],
                components: [row1, row2]
            };

            try {
                sentMessage = await message.channel.send(messageOptions);
            } catch (error) {
                console.error('Error sending exception request message:', error);
                return;
            }

            settings.pendingExceptionRequests = settings.pendingExceptionRequests || {};
            settings.pendingExceptionRequests[applicationId] = {
                applicationId,
                messageId: sentMessage?.id,
                requesterId: message.author.id,
                targetId,
                originalContent: message.content,
                userStats,
                roleId: matchedException.roleId,
                keyword: matchedException.keyword,
                timestamp: Date.now()
            }
            saveSettings(settings);

            return;
        }

        // Check cooldown
        const cooldown = settings.cooldowns[targetId];
        if (cooldown && Date.now() < cooldown) {
            const timeLeft = Math.ceil((cooldown - Date.now()) / (1000 * 60 * 60));
            const reply = await message.channel.send(`❌ <@${targetId}> لديه كولداون حالياً. المتبقي: ${timeLeft} ساعة.`);
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        // Check if already pending (In JSON + channel validation to avoid stale entries)
        if (await hasValidPendingRequest(settings, message.guild, targetId)) {
            const reply = await message.channel.send(`⚠️ <@${targetId}> لديه طلب معلق بالفعل.`);
            setTimeout(() => reply.delete().catch(() => {}), 5000);
            return;
        }

        // Collect stats and create embed using the admin-apply style
        const userStats = await collectUserStats(targetMember);
        // Use simpleView = true for the initial embed as in admin-apply
        const statsEmbed = await createUserStatsEmbed(userStats, colorManager, true, message.member?.displayName ?? null, `<@${message.author.id}>`);
        
        //Customize title for interactive roles
        statsEmbed.setTitle(`🎭 طلب رول تفاعلي`)
                  .setDescription(`**Admin :** <@${message.author.id}>\n**Member :** <@${targetId}>\n\n${message.content}`);

        // جلب الصورة العامة المحفوظة عبر resp img all
        const respConfigPath = path.join(__dirname, '..', 'data', 'respConfig.json');
        let globalImageUrl = null;
        try {
            if (fs.existsSync(respConfigPath)) {
                const config = JSON.parse(fs.readFileSync(respConfigPath, 'utf8'));
                globalImageUrl = config.guilds?.[message.guild.id]?.globalImageUrl;
            }
        } catch (e) {}

        const applicationId = `${Date.now()}_${targetId}`;

        // Buttons using the admin-apply style (ButtonStyle.Secondary and specific emojis)
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`int_approve_${applicationId}`)
                .setLabel('Approve')
                .setEmoji('<:emoji_1:1436850272734285856>')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`int_reject_trigger_${applicationId}`)
                .setLabel('Reject')
                .setEmoji('<:emoji_1:1436850215154880553>')
                .setStyle(ButtonStyle.Secondary)
        );

        // Details menu using the admin-apply style
        const detailsMenu = new StringSelectMenuBuilder()
            .setCustomId(`int_details_${applicationId}`)
            .setPlaceholder('تفاصيل عن العضو')
            .addOptions([
                { label: 'Dates', description: 'عرض تواريخ الانضمام وإنشاء الحساب', value: 'dates' },
                { label: 'Evaluation', description: 'عرض تقييم العضو والمعايير', value: 'evaluation' },
                { label: 'Roles', description: 'عرض جميع الرولات للعضو', value: 'roles' },
                { label: 'Stats', description: 'عرض تفاصيل النشاط', value: 'advanced_stats' },
                { label: 'first ep', description: 'العودة للعرض الأساسي', value: 'simple_view' }
            ]);

        const row2 = new ActionRowBuilder().addComponents(detailsMenu);

        if (globalImageUrl) {
            statsEmbed.setImage(globalImageUrl);
        }

        const messageOptions = {
            content: `**طلب جديد من <@${message.author.id}> بخصوص <@${targetId}>**`,
            embeds: [statsEmbed],
            components: [row1, row2]
        };

        const sentMessage = await message.channel.send(messageOptions);

        // Save pending request
        settings.pendingRequests[targetId] = {
            applicationId: applicationId,
            messageId: sentMessage.id,
            requesterId: message.author.id,
            targetId: targetId,
            timestamp: Date.now(),
            originalContent: message.content,
            userStats: userStats
        };
        saveSettings(settings);
    } finally {
        // Always release the lock for this target to ensure new requests can be processed
        if (global.activeInteractiveRequests) {
            global.activeInteractiveRequests.delete(targetId);
        }
        // Remove message from processed set after a timeout to free memory and allow future edits
        setTimeout(() => {
            if (global.processedInteractiveMessages) {
                global.processedInteractiveMessages.delete(message.id);
            }
        }, 5 * 60 * 1000);
    }
}



function getInteractiveRoleSets(settings) {
    const interactiveRoles = Array.isArray(settings?.settings?.interactiveRoles)
        ? settings.settings.interactiveRoles.filter((roleId) => typeof roleId === 'string' && roleId.length > 0)
        : [];
    const exceptionRoleIds = new Set(
        (settings?.settings?.exceptions || [])
            .map((entry) => entry?.roleId)
            .filter((roleId) => typeof roleId === 'string' && roleId.length > 0)
    );

    return {
        interactiveRoles,
        interactiveRoleSet: new Set(interactiveRoles),
        exceptionRoleIds
    };
}

function getMemberInteractiveRoles(member, interactiveRoleSet, exceptionRoleIds) {
    const allInteractive = member.roles.cache.filter((role) => interactiveRoleSet.has(role.id));
    const nonExceptionRoles = allInteractive.filter((role) => !exceptionRoleIds.has(role.id));
    const exceptionRoles = allInteractive.filter((role) => exceptionRoleIds.has(role.id));

    return {
        allInteractive,
        nonExceptionRoles,
        exceptionRoles,
        highestNonExceptionRole: nonExceptionRoles.sort((a, b) => b.position - a.position).first() || null
    };
}

function getUserPendingInteractiveRequests(settings, userId) {
    return Object.values(settings?.newPendingRequests || {}).filter((request) => request?.userId === userId);
}

async function resolveRoleDisplayInfo(guild, roleId, roleFromContext = null, fallbackName = null) {
    let role = roleFromContext || guild.roles.cache.get(roleId) || null;

    if (!role && roleId) {
        role = await guild.roles.fetch(roleId).catch(() => null);
    }

    const safeName = role?.name || fallbackName || 'رول غير معروف';
    const safeId = role?.id || roleId || 'N/A';

    return {
        role,
        name: safeName,
        id: safeId,
        label: `${safeName} (${safeId})`
    };
}

function formatHoursFromMs(ms) {
    if (!ms || ms <= 0) return 0;
    return Math.floor(ms / (1000 * 60 * 60));
}

function buildConditionsDetails(condition, stats, memberCreatedAt) {
    if (!condition) {
        return { passed: true, text: 'لا يملك الرول شروط' };
    }

    const requiredMessages = Number(condition.messagesRequired || 0);
    const requiredHours = Number(condition.voiceHoursRequired || 0);
    const requiredAge = Number(condition.accountAgeDays || 0);

    const currentMessages = Number(stats?.messages || 0);
    const currentHours = formatHoursFromMs(Number(stats?.voiceTime || 0));
    const accountAgeDays = memberCreatedAt ? Math.floor((Date.now() - memberCreatedAt.getTime()) / (1000 * 60 * 60 * 24)) : 0;

    const missingMessages = Math.max(0, requiredMessages - currentMessages);
    const missingHours = Math.max(0, requiredHours - currentHours);
    const missingAge = Math.max(0, requiredAge - accountAgeDays);

    const passed = missingMessages === 0 && missingHours === 0 && missingAge === 0;

    const text = `**عدد الرسائل : ${currentMessages}/${requiredMessages}${missingMessages > 0 ? ` (المتبقي ${missingMessages})` : ''}**\n` +
        `**عدد الساعات : ${currentHours}/${requiredHours}${missingHours > 0 ? ` (المتبقي ${missingHours})` : ''}**\n` +
        `**عمر الحساب : ${accountAgeDays}/${requiredAge || 0}${requiredAge > 0 && missingAge > 0 ? ` (المتبقي ${missingAge})` : requiredAge === 0 ? ' (غير مطلوب)' : ''}**`;

    return { passed, text };
}

async function handleInteraction(interaction) {
    const settings = loadSettings();
    const customId = interaction.customId;

    if (!customId.startsWith('int_')) return;

    const appSystem = settings.settings?.applicationSystem || {};
    const isNewSystemEnabled = Boolean(appSystem.enabled);

    if (isNewSystemEnabled && customId === 'int_new_show_conditions') {
        const conditions = appSystem.roleConditions || {};
        const roleIds = settings.settings.interactiveRoles || [];
        const lines = roleIds.map((roleId) => {
            const role = interaction.guild.roles.cache.get(roleId);
            const cond = conditions[roleId];
            if (!cond) return `**${role ? role.name : roleId}**\nلا يملك الرول شروط`;
            return `**${role ? role.name : roleId}\nالرسائل : ${cond.messagesRequired || 0} | الساعات : ${cond.voiceHoursRequired || 0} | عمر الحساب : ${(cond.accountAgeDays || 0) > 0 ? `${cond.accountAgeDays} يوم` : 'غير مطلوب'}**`;
        });
        return interaction.reply({ content: lines.join('\n\n') || 'لا توجد شروط', ephemeral: true }).catch(() => {});
    }

    if (isNewSystemEnabled && (customId.startsWith('int_new_apply_role_') || customId === 'int_new_apply_menu')) {
        const roleId = customId === 'int_new_apply_menu' ? interaction.values?.[0] : customId.replace('int_new_apply_role_', '');
        if (!roleId) return interaction.reply({ content: '**تعذر تحديد الرول المطلوب.**', ephemeral: true }).catch(() => {});

        const { interactiveRoleSet, exceptionRoleIds } = getInteractiveRoleSets(settings);
        if (!interactiveRoleSet.has(roleId)) {
            return interaction.reply({ content: '**هذا الرول غير متاح في نظام التقديم التفاعلي.**', ephemeral: true }).catch(() => {});
        }

        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) return interaction.reply({ content: '**الرول غير موجود حالياً.**', ephemeral: true }).catch(() => {});

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'تعذر جلب بياناتك.', ephemeral: true }).catch(() => {});

        const configuredAdminRoles = getConfiguredAdminRoles();
        const isAdminRoleMember = configuredAdminRoles.some((adminRoleId) => member.roles.cache.has(adminRoleId));
        const isAdministratorMember = member.permissions.has('Administrator');
        const isInteractiveApprover = member.roles.cache.some((memberRole) => (settings.settings.approvers || []).includes(memberRole.id));

        if (isAdminRoleMember || isAdministratorMember || isInteractiveApprover || member.id === interaction.guild.ownerId) {
            return interaction.reply({ content: '**الرولات الإدارية لا يمكنها التقديم على الرولات التفاعلية من الأزرار أو منيو التقديم.**', ephemeral: true }).catch(() => {});
        }

        if (member.roles.cache.has(roleId)) {
            return interaction.reply({ content: '**لديك هذا الرول بالفعل.**', ephemeral: true }).catch(() => {});
        }

        const isExceptionRole = exceptionRoleIds.has(roleId);
        const memberInteractive = getMemberInteractiveRoles(member, interactiveRoleSet, exceptionRoleIds);

        if (!isExceptionRole && memberInteractive.highestNonExceptionRole && role.position <= memberInteractive.highestNonExceptionRole.position) {
            return interaction.reply({
                content: `**لديك بالفعل رول تفاعلي أعلى أو مساوي (${memberInteractive.highestNonExceptionRole}). لا يمكنك التقديم إلا على رول أعلى منه**.`,
                ephemeral: true
            }).catch(() => {});
        }

        const pendingKey = `${interaction.user.id}:${roleId}`;
        if (settings.newPendingRequests[pendingKey]) {
            return interaction.reply({ content: '**لديك طلب معلق لهذا الرول بالفعل.**', ephemeral: true }).catch(() => {});
        }

        const pendingRequests = getUserPendingInteractiveRequests(settings, interaction.user.id);
        const hasPendingException = pendingRequests.some((request) => exceptionRoleIds.has(request.roleId));
        const hasPendingNormal = pendingRequests.some((request) => !exceptionRoleIds.has(request.roleId));

        if (isExceptionRole && hasPendingException) {
            return interaction.reply({ content: '**لديك طلب معلق بالفعل**.', ephemeral: true }).catch(() => {});
        }
        if (!isExceptionRole && hasPendingNormal) {
            return interaction.reply({ content: '**يمكنك تقديم طلب واحد فقط للرولات التفاعلية.**', ephemeral: true }).catch(() => {});
        }

        if (isUserBlocked(interaction.user.id)) {
            return interaction.reply({ content: '**أنت محظور من استخدام نظام الرولات التفاعلية**.', ephemeral: true }).catch(() => {});
        }

        const newRoleCooldown = settings.newRoleCooldowns?.[pendingKey];
        if (newRoleCooldown && Date.now() < newRoleCooldown) {
            const timeLeftHours = Math.ceil((newRoleCooldown - Date.now()) / (1000 * 60 * 60));
            return interaction.reply({ content: `**تم رفض طلبك لهذا الرول سابقاً. يمكنك التقديم مرة أخرى بعد ${timeLeftHours} ساعة.**`, ephemeral: true }).catch(() => {});
        }

        const db = getDatabase();
        const stats = db && db.isInitialized ? await db.getMonthlyStats(interaction.user.id) : { messages: 0, voiceTime: 0 };
        const condition = appSystem.roleConditions?.[roleId] || null;
        const evaluation = buildConditionsDetails(condition, stats, member.user.createdAt);

        if (!evaluation.passed) {
            return interaction.reply({
                content: `- شروط هذا الرول غير مكتملة لديك\n\n${evaluation.text}`,
                ephemeral: true
            }).catch(() => {});
        }

        if (!appSystem.managersChannelId) {
            return interaction.reply({ content: 'روم المسؤولين غير محدد حالياً.', ephemeral: true }).catch(() => {});
        }

        const managersChannel = interaction.guild.channels.cache.get(appSystem.managersChannelId) || await interaction.guild.channels.fetch(appSystem.managersChannelId).catch(() => null);
        if (!managersChannel) {
            return interaction.reply({ content: 'تعذر الوصول إلى روم المسؤولين.', ephemeral: true }).catch(() => {});
        }

        const requestId = `${Date.now()}_${interaction.user.id}_${roleId}`;
        const embed = colorManager.createEmbed()
            .setTitle('Active request')
            .setDescription(`العضو : <@${interaction.user.id}>\nالرول : <@&${roleId}>`)
            .setThumbnail(interaction.user.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }))
            .addFields(
                { name: 'المقدم', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'التاريخ', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true },
                { name: 'هل حقق الشروط؟', value: condition ? 'نعم' : 'لا يملك الرول شروط', inline: false },
                { name: 'تفاصيل الشروط', value: evaluation.text, inline: false }
            )
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`int_new_approve_${requestId}`).setLabel('Accept?').setEmoji('<:emoji_42:1430334150057001042>').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`int_new_reject_trigger_${requestId}`).setLabel('Reject?').setEmoji('<:emoji_44:1430334506371645593>').setStyle(ButtonStyle.Danger)
        );

        const messagePayload = { embeds: [embed], components: [row] };
        const sent = await managersChannel.send(messagePayload).catch(() => null);
        if (sent && appSystem.managersImagePath && fs.existsSync(appSystem.managersImagePath)) {
            await managersChannel.send({ files: [appSystem.managersImagePath] }).catch(() => {});
        }
        if (!sent) {
            return interaction.reply({ content: 'تعذر إرسال الطلب إلى روم المسؤولين.', ephemeral: true }).catch(() => {});
        }

        settings.newPendingRequests[pendingKey] = {
            requestId,
            userId: interaction.user.id,
            roleId,
            roleNameSnapshot: role.name,
            managerMessageId: sent.id,
            managerChannelId: managersChannel.id,
            createdAt: Date.now(),
            conditionMet: true,
            conditionText: evaluation.text
        };
        saveSettings(settings);

        return interaction.reply({ content: '**تم إرسال طلبك إلى المسؤولين بنجاح.**', ephemeral: true }).catch(() => {});
    }

    if (isNewSystemEnabled && customId.startsWith('int_new_reject_trigger_')) {
        const requestId = customId.replace('int_new_reject_trigger_', '');
        const modal = new ModalBuilder().setCustomId(`int_new_reject_modal_${requestId}`).setTitle('سبب الرفض');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reject_reason').setLabel('سبب الرفض').setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return interaction.showModal(modal).catch(() => {});
    }

    if (isNewSystemEnabled && customId.startsWith('int_new_approve_')) {
        const isApproverNew = interaction.member.roles.cache.some(r => settings.settings.approvers.includes(r.id)) || interaction.guild.ownerId === interaction.user.id;
        if (!isApproverNew) return interaction.reply({ content: '** شوف لك مسؤول يوافق **.', ephemeral: true }).catch(() => {});
        const requestId = customId.replace('int_new_approve_', '');
        const request = Object.values(settings.newPendingRequests || {}).find((r) => r.requestId === requestId);
        if (!request) return interaction.reply({ content: 'الطلب غير موجود.', ephemeral: true }).catch(() => {});

        const targetMember = await interaction.guild.members.fetch(request.userId).catch(() => null);
        const roleDisplay = await resolveRoleDisplayInfo(interaction.guild, request.roleId, null, request.roleNameSnapshot);
        const role = roleDisplay.role;
        if (!targetMember || !role) return interaction.reply({ content: 'تعذر جلب العضو أو الرول.', ephemeral: true }).catch(() => {});

        const { interactiveRoleSet, exceptionRoleIds } = getInteractiveRoleSets(settings);
        const isExceptionRole = exceptionRoleIds.has(role.id);
        const memberInteractive = getMemberInteractiveRoles(targetMember, interactiveRoleSet, exceptionRoleIds);
        let removedRoleMentions = [];

        if (!isExceptionRole) {
            const rolesToRemove = memberInteractive.nonExceptionRoles.filter((existingRole) => existingRole.id !== role.id);
            const higherOrEqualRole = rolesToRemove.find((existingRole) => existingRole.position >= role.position);
            if (higherOrEqualRole) {
                return interaction.reply({
                    content: `**لا يمكن القبول لأن العضو يملك رول تفاعلي أعلى أو مساوي بالفعل (${higherOrEqualRole}).**`,
                    ephemeral: true
                }).catch(() => {});
            }

            if (rolesToRemove.size > 0) {
                removedRoleMentions = rolesToRemove.map((existingRole) => `<@&${existingRole.id}>`);
                await targetMember.roles.remove(rolesToRemove).catch(() => {});
            }
        }

        if (typeof global.markInteractiveRoleGrant === 'function') global.markInteractiveRoleGrant(interaction.guild.id, targetMember.id, role.id);
        await targetMember.roles.add(role).catch(() => {});

        const approvedDmEmbed = colorManager.createEmbed()
            .setTitle('Accepted')
            .setDescription(`**تم قبول طلبك للرول التفاعلي: ${roleDisplay.label} في سيرفر ${interaction.guild.name}**`)
            .setThumbnail(interaction.user.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }))
            .addFields(
                { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setTimestamp();

        if (removedRoleMentions.length > 0) {
            approvedDmEmbed.addFields({
                name: 'تنبيه',
                value: `تم سحب الرول التفاعلي السابق تلقائياً: ${removedRoleMentions.join(' , ')}`
            });
        }

        await targetMember.send({ embeds: [approvedDmEmbed] }).catch(() => {});

        const updated = EmbedBuilder.from(interaction.message.embeds[0])
            .setThumbnail(interaction.user.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }))
            .addFields({
                name: 'الحالة',
                value: removedRoleMentions.length > 0
                    ? `*تم القبول بواسطة <@${interaction.user.id}>
تم سحب الرولات السابقة : ${removedRoleMentions.join(' , ')}*`
                    : `*تم القبول بواسطة <@${interaction.user.id}>*`
            });
        await interaction.update({ embeds: [updated], components: [] }).catch(() => {});

        delete settings.newPendingRequests[`${request.userId}:${request.roleId}`];

        Object.keys(settings.newPendingRequests || {}).forEach((key) => {
            const pendingRequest = settings.newPendingRequests[key];
            if (!pendingRequest || pendingRequest.userId !== request.userId) return;

            const pendingIsException = exceptionRoleIds.has(pendingRequest.roleId);
            if (pendingRequest.roleId !== request.roleId && pendingIsException === isExceptionRole) {
                delete settings.newPendingRequests[key];
            }
        });

        saveSettings(settings);
        return;
    }

    if (isNewSystemEnabled && customId.startsWith('int_new_reject_modal_')) {
        const isApproverNew = interaction.member.roles.cache.some(r => settings.settings.approvers.includes(r.id)) || interaction.guild.ownerId === interaction.user.id;
        if (!isApproverNew) return interaction.reply({ content: '**لا تسوي  خوي **.', ephemeral: true }).catch(() => {});
        const requestId = customId.replace('int_new_reject_modal_', '');
        const reason = interaction.fields.getTextInputValue('reject_reason');
        const request = Object.values(settings.newPendingRequests || {}).find((r) => r.requestId === requestId);
        if (!request) return interaction.reply({ content: 'الطلب غير موجود.', ephemeral: true }).catch(() => {});

        const roleDisplay = await resolveRoleDisplayInfo(interaction.guild, request.roleId, null, request.roleNameSnapshot);
        const targetMember = await interaction.guild.members.fetch(request.userId).catch(() => null);
        if (targetMember) {
            const rejectedDmEmbed = colorManager.createEmbed()
                .setTitle('Rejected')
                .setDescription(`**تم رفض طلبك للرول التفاعلي: ${roleDisplay.label} في سيرفر ${interaction.guild.name}**`)
                .setThumbnail(interaction.user.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }))
                .addFields(
                    { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'السبب', value: reason.slice(0, 1000), inline: false },
                    { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                )
                .setTimestamp();
            await targetMember.send({ embeds: [rejectedDmEmbed] }).catch(() => {});
        }

        const updated = EmbedBuilder.from(interaction.message.embeds[0])
            .setThumbnail(interaction.user.displayAvatarURL({ size: 128, extension: 'png', forceStatic: false }))
            .addFields({ name: 'الحالة', value: `*تم الرفض بواسطة <@${interaction.user.id}>\nالسبب : ${reason}*` });
        await interaction.reply({ content: '**تم رفض الطلب.**', ephemeral: true }).catch(() => {});
        await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => {});

        if (!settings.newRoleCooldowns || typeof settings.newRoleCooldowns !== 'object' || Array.isArray(settings.newRoleCooldowns)) {
            settings.newRoleCooldowns = {};
        }
        settings.newRoleCooldowns[`${request.userId}:${request.roleId}`] = Date.now() + REJECTION_COOLDOWN_MS;

        delete settings.newPendingRequests[`${request.userId}:${request.roleId}`];
        saveSettings(settings);
        return;
    }

    // Check if user is an approver
    const isApprover = interaction.member.roles.cache.some(r => settings.settings.approvers.includes(r.id)) || 
                       interaction.guild.ownerId === interaction.user.id;

    const getExceptionRequest = (applicationId) => {
        const requests = settings.pendingExceptionRequests || {};
        return requests[applicationId] || null;
    };

    const setExceptionCooldown = (targetId, roleId, keyword, durationMs) => {
        if (!settings.exceptionCooldowns) settings.exceptionCooldowns = {};
        if (!settings.exceptionCooldowns[targetId]) settings.exceptionCooldowns[targetId] = {};
        if (!settings.exceptionCooldowns[targetId][roleId]) settings.exceptionCooldowns[targetId][roleId] = {};
        settings.exceptionCooldowns[targetId][roleId][keyword] = Date.now() + durationMs;
    };

    if (customId.startsWith('int_ex_details_')) {
        if (interaction.replied || interaction.deferred) return;
        if (!isApprover) {
            return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});
        }

        await interaction.deferUpdate().catch(err => {
            if (err.code !== 10062) console.error('Error deferring update:', err);
        });

        if (!interaction.deferred && !interaction.replied) return;

        const applicationId = customId.replace('int_ex_details_', '');
        const request = getExceptionRequest(applicationId);

        if (!request) {
            return interaction.followUp({ content: '❌ لم يتم العثور على بيانات الطلب المستثنى.', ephemeral: true }).catch(() => {});
        }

        const value = interaction.values[0];
        const userStats = request.userStats;

        let updatedEmbed;
        try {
            if (value === 'simple_view') {
                updatedEmbed = await createUserStatsEmbed(userStats, colorManager, true, null, `<@${request.requesterId}>`);
                updatedEmbed.setTitle('🎭 طلب رول تفاعلي (استثناء)').setDescription(`**Admin :** <@${request.requesterId}>\n**Member :** <@${request.targetId}>\n**الرول المستثنى :** <@&${request.roleId}>\n**الكلمة :** ${request.keyword}\n\n${request.originalContent}`);
            } else {
                updatedEmbed = await createUserStatsEmbed(userStats, colorManager, false, null, `<@${request.requesterId}>`, value);
                const targetMember = await interaction.guild.members.fetch(request.targetId).catch(() => null);
                updatedEmbed.setTitle(` تفاصيل العضو: ${targetMember ? targetMember.user.username : request.targetId}`);

                if (updatedEmbed.data && updatedEmbed.data.fields && !updatedEmbed.data.fields.some(f => f.name && f.name.includes('بواسطة'))) {
                    updatedEmbed.addFields({ name: 'بواسطة', value: `<@${request.requesterId}>`, inline: true });
                }
            }

            await interaction.editReply({ embeds: [updatedEmbed] }).catch(err => {
                if (err.code !== 10062) console.error('Error in editReply (details):', err);
            });
        } catch (error) {
            console.error('Error updating read-only interaction embed:', error);
        }
        return;
    }

    if (customId.startsWith('int_ex_approve_')) {
        if (interaction.replied || interaction.deferred) return;
        if (!isApprover) return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});

        const applicationId = customId.replace('int_ex_approve_', '');
        const request = getExceptionRequest(applicationId);
        if (!request) {
            return interaction.reply({ content: '❌ لم يتم العثور على هذا الطلب المستثنى.', ephemeral: true }).catch(() => {});
        }

        const targetMember = await interaction.guild.members.fetch(request.targetId).catch(() => null);
        const role = interaction.guild.roles.cache.get(request.roleId);
        if (!targetMember || !role) {
            return interaction.reply({ content: '❌ تعذر العثور على العضو أو الرول.', ephemeral: true }).catch(() => {});
        }

        if (targetMember.roles.cache.has(role.id)) {
            setExceptionCooldown(request.targetId, request.roleId, request.keyword, 24 * 60 * 60 * 1000);
            delete settings.pendingExceptionRequests[applicationId];
            saveSettings(settings);
            return interaction.reply({ content: `⚠️ <@${request.targetId}> لديه بالفعل الرول المستثنى.`, ephemeral: true }).catch(() => {});
        }
if (typeof global.markInteractiveRoleGrant === 'function') {

            global.markInteractiveRoleGrant(interaction.guild.id, targetMember.id, role.id);

        }
        await targetMember.roles.add(role).catch(() => {});
        try {
            await targetMember.send(`✅ ** تم قبول طلبك للرول التفاعلي  وحصلت على رول : ${role.name}في سيرفر ${interaction.guild.name}**.`);
        } catch (e) {}

        const channel = interaction.guild.channels.cache.get(settings.settings.requestChannel);
        if (channel && request.messageId) {
            const msg = await channel.messages.fetch(request.messageId).catch(() => null);
            if (msg) {
                const embed = EmbedBuilder.from(msg.embeds[0])
                    .setColor(colorManager.getColor ? colorManager.getColor() : '#00ff00')
                    .addFields({ name: 'الحالة', value: `✅ تم القبول بواسطة <@${interaction.user.id}>\nالرول الممنوح: <@&${request.roleId}>\nنوع الطلب: مستثنى` });
                await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
            }
        }

        setExceptionCooldown(request.targetId, request.roleId, request.keyword, 24 * 60 * 60 * 1000);
        delete settings.pendingExceptionRequests[applicationId];
        saveSettings(settings);

        await interaction.reply({ content: `✅ تم منح الرول <@&${request.roleId}> لـ <@${request.targetId}> بنجاح (استثناء).`, ephemeral: true }).catch(() => {});
        return;
    }

    if (customId.startsWith('int_ex_reject_trigger_')) {
        if (interaction.replied || interaction.deferred) return;
        if (!isApprover) return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});

        const applicationId = customId.replace('int_ex_reject_trigger_', '');
        const request = getExceptionRequest(applicationId);
        if (!request) {
            return interaction.reply({ content: '❌ لم يتم العثور على هذا الطلب المستثنى.', ephemeral: true }).catch(() => {});
        }

        const modal = new ModalBuilder()
            .setCustomId(`int_ex_reject_modal_${applicationId}`)
            .setTitle('سبب الرفض');

        const reasonInput = new TextInputBuilder()
            .setCustomId('reject_reason')
            .setLabel('السبب')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('اذكر سبب الرفض هنا...');

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal).catch(() => {});
        return;
    }

    if (customId.startsWith('int_ex_reject_modal_')) {
        if (interaction.replied || interaction.deferred) return;
        const applicationId = customId.replace('int_ex_reject_modal_', '');
        const reason = interaction.fields.getTextInputValue('reject_reason');
        const request = getExceptionRequest(applicationId);
        if (!request) {
            return interaction.reply({ content: '❌ لم يتم العثور على هذا الطلب المستثنى.', ephemeral: true }).catch(() => {});
        }

        const targetMember = await interaction.guild.members.fetch(request.targetId).catch(() => null);
        if (targetMember) {
            try {
                await targetMember.send(`❌ **للأسف!** تم رفض طلبك للرول التفاعلي  في سيرفر **${interaction.guild.name}**.\n**السبب:** ${reason}`);
            } catch (e) {}
        }

        const channel = interaction.guild.channels.cache.get(settings.settings.requestChannel);
        if (channel && request.messageId) {
            const msg = await channel.messages.fetch(request.messageId).catch(() => null);
            if (msg) {
                const embed = EmbedBuilder.from(msg.embeds[0])
                    .setColor(colorManager.getColor ? colorManager.getColor() : '#ff0000')
                    .addFields({ name: 'الحالة', value: `❌ تم الرفض بواسطة <@${interaction.user.id}>\n**السبب:** ${reason}\nنوع الطلب: مستثنى` });
                await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
            }
        }

        setExceptionCooldown(request.targetId, request.roleId, request.keyword, REJECTION_COOLDOWN_MS);
        delete settings.pendingExceptionRequests[applicationId];
        saveSettings(settings);
        await interaction.reply({ content: `✅ تم رفض الطلب ووضع كولداون لاستثناء <@${request.targetId}>.`, ephemeral: true }).catch(() => {});
        return;
    }

    // Handle Details Menu (Same as admin-apply)
    if (customId.startsWith('int_details_')) {
        // التحقق من حالة التفاعل فوراً لمنع التكرار
        if (interaction.replied || interaction.deferred) return;
        
        // التحقق من صلاحية المستخدم فوراً
        if (!isApprover) {
            return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});
        }

        // إرجاء الرد لتجنب خطأ انتهاء وقت التفاعل (Unknown Interaction)
        await interaction.deferUpdate().catch(err => {
            if (err.code !== 10062) console.error('Error deferring update:', err);
        });
        
        // التحقق من حالة التفاعل بعد التأجيل
        if (!interaction.deferred && !interaction.replied) return;

        const applicationId = customId.replace('int_details_', '');
        const targetId = applicationId.split('_')[1];
        const request = settings.pendingRequests[targetId];
        
        if (!request) {
            return interaction.followUp({ content: '❌ لم يتم العثور على بيانات الطلب.', ephemeral: true }).catch(() => {});
        }

        const value = interaction.values[0];
        const userStats = request.userStats;
        
        let updatedEmbed;
        try {
            if (value === 'simple_view') {
                updatedEmbed = await createUserStatsEmbed(userStats, colorManager, true, null, `<@${request.requesterId}>`);
                updatedEmbed.setTitle(`🎭 طلب رول تفاعلي`).setDescription(`**Admin :** <@${request.requesterId}>\n**Member :** <@${targetId}>\n\n${request.originalContent}`);
            } else {
                // Full view with specific category matching admin-apply logic
                updatedEmbed = await createUserStatsEmbed(userStats, colorManager, false, null, `<@${request.requesterId}>`, value);
                
                // Re-apply title and correct styling after createUserStatsEmbed
                const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
                updatedEmbed.setTitle(` تفاصيل العضو: ${targetMember ? targetMember.user.username : targetId}`);
                
                // Add requester field if it's missing in some views
                if (updatedEmbed.data && updatedEmbed.data.fields && !updatedEmbed.data.fields.some(f => f.name && f.name.includes('بواسطة'))) {
                    updatedEmbed.addFields({ name: 'بواسطة', value: `<@${request.requesterId}>`, inline: true });
                }
            }

            await interaction.editReply({ embeds: [updatedEmbed] }).catch(err => {
                if (err.code !== 10062) console.error('Error in editReply (details):', err);
            });
        } catch (error) {
            console.error('Error updating interaction embed:', error);
        }
        return;
    }

    if (customId.startsWith('int_approve_')) {
        if (interaction.replied || interaction.deferred) return;
        if (!isApprover) return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});
        
        const applicationId = customId.replace('int_approve_', '');
        const targetId = applicationId.split('_')[1];
        const request = settings.pendingRequests[targetId];
        if (!request) return interaction.reply({ content: '❌ لم يتم العثور على هذا الطلب.', ephemeral: true }).catch(() => {});

        const roles = settings.settings.interactiveRoles;
        if (roles.length === 0) return interaction.reply({ content: '❌ لم يتم تحديد رولات تفاعلية في الإعدادات.', ephemeral: true }).catch(() => {});

        const nonAdminRoles = roles.filter((id) => {
            const role = interaction.guild.roles.cache.get(id);
            return role && !role.permissions.has('Administrator');
        });
        if (nonAdminRoles.length === 0) {
            return interaction.reply({ content: '❌ لا يمكن استخدام رولات إدارية داخل نظام الرولات التفاعلية.', ephemeral: true }).catch(() => {});
        }

        const menu = new StringSelectMenuBuilder()
            .setCustomId(`int_select_role_${targetId}`)
            .setPlaceholder('اختر الرول المراد إعطاؤه...')
            .addOptions(nonAdminRoles.map(id => {
                const role = interaction.guild.roles.cache.get(id);
                return { label: role ? role.name : id, value: id };
            }));

        await interaction.reply({ content: '✅ اختر الرول المناسب للعضو بناءً على تفاعله:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true }).catch(() => {});

    } else if (customId.startsWith('int_select_role_')) {
        if (interaction.replied || interaction.deferred) return;
        if (!isApprover) return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});
        const targetId = customId.split('_')[3];
        const roleId = interaction.values[0];
        const request = settings.pendingRequests[targetId];

        // If no pending request exists for this target, inform the approver and abort.
        if (!request) {
            return interaction.reply({ content: '❌ لم يتم العثور على هذا الطلب.', ephemeral: true }).catch(() => {});
        }

        const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
        const role = interaction.guild.roles.cache.get(roleId);
        if (role && role.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ لا يمكن منح رول إداري من نظام الرولات التفاعلية.', ephemeral: true }).catch(() => {});
        }

        if (targetMember && role) {
            // Assign the role to the member
            if (typeof global.markInteractiveRoleGrant === 'function') {

                global.markInteractiveRoleGrant(interaction.guild.id, targetMember.id, role.id);

            }
            await targetMember.roles.add(role).catch(() => {});
            try {
                await targetMember.send(`✅ ** تم قبول طلبك للرول التفاعلي وحصلت على رول : ${role.name} في سيرفر ${interaction.guild.name}**.`);
            } catch (e) {}

            // Update the original request message to reflect approval
            const channel = interaction.guild.channels.cache.get(settings.settings.requestChannel);
            if (channel) {
                const msg = await channel.messages.fetch(request.messageId).catch(() => null);
                if (msg) {
                    const embed = EmbedBuilder.from(msg.embeds[0])
                        .setColor(colorManager.getColor ? colorManager.getColor() : '#00ff00')
                        .addFields({ name: 'الحالة', value: `✅ تم القبول بواسطة <@${interaction.user.id}>\nالرول الممنوح: <@&${roleId}>` });
                    await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
                }
            }

            // Remove pending request and persist
            delete settings.pendingRequests[targetId];
            saveSettings(settings);

            await interaction.update({ content: `✅ تم منح الرول <@&${roleId}> لـ <@${targetId}> بنجاح.`, components: [] }).catch(() => {});
        }

    } else if (customId.startsWith('int_reject_trigger_')) {
        if (interaction.replied || interaction.deferred) return;
        if (!isApprover) return interaction.reply({ content: '❌ **مب مسؤول؟ والله ماوريك.**', ephemeral: true }).catch(() => {});
        
        const applicationId = customId.replace('int_reject_trigger_', '');
        const targetId = applicationId.split('_')[1];
        
        const modal = new ModalBuilder()
            .setCustomId(`int_reject_modal_${targetId}`)
            .setTitle('سبب الرفض');
        
        const reasonInput = new TextInputBuilder()
            .setCustomId('reject_reason')
            .setLabel('السبب')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('اذكر سبب الرفض هنا...');
        
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal).catch(() => {});

    } else if (customId.startsWith('int_reject_modal_')) {
        if (interaction.replied || interaction.deferred) return;
        const targetId = customId.split('_')[3];
        const reason = interaction.fields.getTextInputValue('reject_reason');
        const request = settings.pendingRequests[targetId];
        // If there is no matching pending request, inform the moderator
        if (!request) {
            return interaction.reply({ content: '❌ لم يتم العثور على هذا الطلب.', ephemeral: true }).catch(() => {});
        }

        const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
        if (targetMember) {
            try {
                await targetMember.send(`❌ **للأسف!** تم رفض طلبك للرول التفاعلي في سيرفر **${interaction.guild.name}**.\n**السبب:** ${reason}\nيمكنك التقديم مرة أخرى بعد 48 ساعة.`);
            } catch (e) {}
        }

        // Apply a 48 hour cooldown to prevent immediate re-application
        settings.cooldowns[targetId] = Date.now() + REJECTION_COOLDOWN_MS;

        // Update the original request message to reflect rejection
        const channel = interaction.guild.channels.cache.get(settings.settings.requestChannel);
        if (channel) {
            const msg = await channel.messages.fetch(request.messageId).catch(() => null);
            if (msg) {
                const embed = EmbedBuilder.from(msg.embeds[0])
                    .setColor(colorManager.getColor ? colorManager.getColor() : '#ff0000')
                    .addFields({ name: 'الحالة', value: `❌ تم الرفض بواسطة <@${interaction.user.id}>\n**السبب :** ${reason}` });
                await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
            }
        }

        // Remove the pending request and persist
        delete settings.pendingRequests[targetId];
        saveSettings(settings);
        await interaction.reply({ content: `✅ تم رفض الطلب ووضع كولداون لـ <@${targetId}>.`, ephemeral: true }).catch(() => {});
    }
}

module.exports = { handleMessage, handleInteraction };
