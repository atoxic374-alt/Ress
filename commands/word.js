const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const interactionRouter = require('../utils/interactionRouter');
const colorManager = require('../utils/colorManager');
const { getDataDir } = require('../utils/storagePaths');

const pendingRoleSelections = new Map();
const pendingWordActions = new Map();

const DATA_DIR = getDataDir();
const DATA_PATH = path.join(DATA_DIR, 'wordTriggers.json');
const ADMIN_ROLES_PATH = path.join(DATA_DIR, 'adminRoles.json');

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getWordData() {
    return readJson(DATA_PATH, {});
}

function saveWordData(data) {
    writeJson(DATA_PATH, data);
}

function buildWordActionRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('word_create').setLabel('إنشاء').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('word_delete').setLabel('إزالة').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('word_edit').setLabel('تعديل').setStyle(ButtonStyle.Primary)
    );
}

function normalizeWord(input) {
    return String(input || '').trim().toLowerCase();
}

function normalizeRoleName(input) {
    return normalizeWord(input)
        .replace(/[._,،\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getModalText(interaction, customId, required = false) {
    try {
        const value = interaction.fields.getTextInputValue(customId);
        return typeof value === 'string' ? value : '';
    } catch (error) {
        if (required) throw error;
        return '';
    }
}

function parseKeywordsInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, error: '❌ **لازم تكتب كلمة واحدة على الأقل.**' };

    const byComma = raw.includes('،') || raw.includes(',');
    const splitPattern = byComma ? /[،,\n|]+/ : /\s+/;
    const parts = raw.split(splitPattern).map(p => normalizeWord(p)).filter(Boolean);
    const keywords = [...new Set(parts)];

    if (keywords.length === 0) return { ok: false, error: '❌ **لازم تكتب كلمة واحدة على الأقل.**' };
    if (keywords.length > 3) return { ok: false, error: '❌ **مسموح حتى 3 كلمات برفكس فقط.**' };

    if (keywords.some(k => k.includes(' '))) {
        return { ok: false, error: '❌ **كل برفكس لازم يكون كلمة واحدة فقط.**' };
    }

    return { ok: true, keywords };
}

function getEntryKeywords(entry) {
    if (Array.isArray(entry.keywords) && entry.keywords.length > 0) {
        return [...new Set(entry.keywords.map(normalizeWord).filter(Boolean))];
    }
    const single = normalizeWord(entry.keyword);
    return single ? [single] : [];
}

function getAdminRoles() {
    const roles = readJson(ADMIN_ROLES_PATH, []);
    return Array.isArray(roles) ? roles : [];
}

function isBotOwner(userId, BOT_OWNERS = []) {
    return BOT_OWNERS.includes(userId);
}

function getTargetRoleIds(entry) {
    if (Array.isArray(entry?.targetRoleIds) && entry.targetRoleIds.length > 0) {
        return [...new Set(entry.targetRoleIds.map(String))];
    }
    return entry?.targetRoleId ? [String(entry.targetRoleId)] : [];
}

function getAllowedRoleIds(entry) {
    if (!Array.isArray(entry?.allowedRoleIds) || entry.allowedRoleIds.length === 0) {
        return [];
    }

    return [...new Set(entry.allowedRoleIds.map(String))];
}

function canUseWord(member, entry, _BOT_OWNERS = []) {
    if (!member || !entry) return false;

    if (entry.allowedMode === 'admin') {
        const adminRoles = getAdminRoles();
        if (adminRoles.length === 0) return false;
        return member.roles.cache.some(role => adminRoles.includes(role.id));
    }

    const allowedRoleIds = getAllowedRoleIds(entry);
    if (allowedRoleIds.length === 0) return false;

    return member.roles.cache.some(role => allowedRoleIds.includes(role.id));
}

function findClosestRole(guild, rawInput) {
    const query = String(rawInput || '').trim();
    if (!query) return null;

    const mentionMatch = query.match(/^<@&(\d+)>$/);
    const idMatch = query.match(/^\d{16,20}$/);
    const roleId = mentionMatch ? mentionMatch[1] : (idMatch ? idMatch[0] : null);
    if (roleId && guild.roles.cache.has(roleId)) return guild.roles.cache.get(roleId);

    const normalized = normalizeRoleName(query);
    const exact = guild.roles.cache.find(r => normalizeRoleName(r.name) === normalized);
    if (exact) return exact;

    const compactNormalized = normalized.replace(/\s+/g, '');
    const compactExact = guild.roles.cache.find(r => normalizeRoleName(r.name).replace(/\s+/g, '') === compactNormalized);
    if (compactExact) return compactExact;

    return guild.roles.cache
        .filter(r => {
            const roleName = normalizeRoleName(r.name);
            const roleCompact = roleName.replace(/\s+/g, '');
            return roleName.includes(normalized) || roleCompact.includes(compactNormalized);
        })
        .sort((a, b) => {
            const aLen = normalizeRoleName(a.name).length;
            const bLen = normalizeRoleName(b.name).length;
            return aLen - bLen;
        })
        .first() || null;
}

function parseRolesFromMessage(guild, content) {
    const raw = String(content || '').trim();
    if (!raw) return { ok: false, error: '❌ **لازم ترسل الرولات ( منشن / ID / اسم ) أو 0.**' };
    if (raw === '0') return { ok: true, mode: 'admin', roleIds: [] };

    const mentionMatches = raw.match(/<@&\d+>/g) || [];
    const rawWithoutMentions = raw.replace(/<@&\d+>/g, ' ');
    const nameOrIdParts = rawWithoutMentions
        .split(/[،,\n]+/)
        .map(p => p.trim())
        .filter(Boolean);
    const parts = [...mentionMatches, ...nameOrIdParts];

    if (parts.length === 0) {
        return { ok: false, error: '❌ **ما تم العثور على أي رول صالح في الرسالة.**' };
    }

    const roleIds = [];
    const resolvedRoles = [];

    for (const part of parts) {
        const role = findClosestRole(guild, part);
        if (!role) return { ok: false, error: `❌ **ما قدرت أحدد الرول :** ${part}` };
        if (!roleIds.includes(role.id)) {
            roleIds.push(role.id);
            resolvedRoles.push(role);
        }
    }

    return { ok: true, mode: 'roles', roleIds, resolvedRoles };
}

function isDangerousRole(role) {
    if (!role) return true;
    const p = PermissionsBitField.Flags;
    const dangerousFlags = [
        p.Administrator,
        p.ManageGuild,
        p.ManageRoles,
        p.ManageChannels,
        p.ManageWebhooks,
        p.BanMembers,
        p.KickMembers,
        p.ModerateMembers
    ];

    return dangerousFlags.some(flag => role.permissions.has(flag));
}

function ensureSafeTargetRole(interaction, role) {
    if (!role) return '❌ **الرول غير صالح.**';
    if (isDangerousRole(role)) return '❌ **هذا رول خطير ولا يمكن ربطه بأمر word.**';

    const me = interaction.guild.members.me;
    if (!me) return '❌ **تعذر التحقق من صلاحيات البوت.**';

    if (role.position >= me.roles.highest.position) {
        return '❌ **هذا الرول أعلى / يساوي أعلى رول للبوت، ما أقدر أتعامل معه.**';
    }

    return null;
}

function upsertWord(guildId, wordEntry) {
    const all = getWordData();
    if (!all[guildId]) all[guildId] = { words: [] };
    if (!Array.isArray(all[guildId].words)) all[guildId].words = [];

    const incomingKeywords = getEntryKeywords(wordEntry);
    const idx = all[guildId].words.findIndex(w => {
        const existingKeywords = getEntryKeywords(w);
        return incomingKeywords.some(k => existingKeywords.includes(k));
    });
    if (idx >= 0) {
        all[guildId].words[idx] = { ...all[guildId].words[idx], ...wordEntry };
    } else {
        all[guildId].words.push(wordEntry);
    }

    saveWordData(all);
}

function buildWordPreview(entry, guild) {
    const keywordsText = getEntryKeywords(entry).join(' ، ') || '—';
    const allowedRoleIds = getAllowedRoleIds(entry);
    const allowedText = entry.allowedMode === 'admin'
        ? 'جميع رولات الأدمن'
        : allowedRoleIds.map(id => guild.roles.cache.get(id)?.toString() || `\`${id}\``).join(' , ') || '—';

    return colorManager.createEmbed()
        .setTitle('**Saved word**')
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .setDescription([
        ` ** `,
            `• الكلمات : ${keywordsText}`,

            `• الرولات المستهدفة : ${getTargetRoleIds(entry).map(id => guild.roles.cache.get(id)?.toString() || `<@&${id}>`).join(' , ') || '—'}`,

            `• رسالة بدون صلاحية : ${entry.noPermMessage || ' رياكشن '}`,

            `• رسالة مع صلاحية : ${entry.hasPermMessage || 'رياكشن '}`,

            `• الرولات المسموح لها : ${allowedText}**`
        ].join('\n'));
}

function buildWordSystemEmbed(guild) {
    const all = getWordData();
    const guildData = all[guild.id];
    const words = Array.isArray(guildData?.words) ? guildData.words : [];

    const listText = words.length === 0
        ? '**لا توجد كلمات مضافة حالياً.**'
        : words.map((entry, index) => {
            const prefixes = getEntryKeywords(entry).join('  ,  ') || '—';
            const allowedRoleIds = getAllowedRoleIds(entry);
            const allowedText = entry.allowedMode === 'admin'
                ? 'كل الادارة'
                : `${allowedRoleIds.length} رول`;

            return [
                `**`,
                `• #${index + 1}`,
                `• Prefix : ${prefixes}`,
                `• Roles : ${getTargetRoleIds(entry).map(id => guild.roles.cache.get(id)?.toString() || `<@&${id}>`).join(' , ') || '—'}`,
                `• Allowed : ${allowedText}**`
            ].join('\n');
        }).join('\n\n••••••••••••••••\n\n');

    return colorManager.createEmbed()
        .setTitle('**نظام word**')
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .setDescription([
            '**اختر العملية المطلوبة :**',
            '',
            '**• إنشاء**',
            '**• إزالة**',
            '**• تعديل**',
            '',
            `**• All words : ${words.length}**`,
            '',
            listText
        ].join('\n'));
}

function extractPanelMessageId(customId, baseId) {
    if (!customId.startsWith(`${baseId}:`)) return null;
    return customId.slice(baseId.length + 1) || null;
}

async function refreshWordPanelMessage(interaction, panelMessageId) {
    if (!panelMessageId || !interaction.channel) return;

    const panelMessage = await interaction.channel.messages.fetch(panelMessageId).catch(() => null);
    if (!panelMessage) return;

    await panelMessage.edit({
        embeds: [buildWordSystemEmbed(interaction.guild)],
        components: [buildWordActionRow()]
    }).catch(() => {});
}

function buildWordTargetMenu(customId, roles, targetMember, page = 0) {
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(roles.length / pageSize));
    const currentPage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
    const pageRoles = roles.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    const options = pageRoles.map(role => ({
        label: role.name.slice(0, 100),
        value: role.id,
        description: `${targetMember.roles.cache.has(role.id) ? 'Remove' : 'Give'} • ${role.name}`.slice(0, 100)
    }));
    const rows = [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(`اختر الرول المطلوب (صفحة ${currentPage + 1}/${pageCount})`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(options)
    )];
    if (pageCount > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`word_apply_page:${customId.split(':').slice(1).join(':')}:${currentPage - 1}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
            new ButtonBuilder().setCustomId(`word_apply_page:${customId.split(':').slice(1).join(':')}:${currentPage + 1}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === pageCount - 1)
        ));
    }
    return rows;
}

async function getTargetRolesForMessage(message, entry) {
    const roles = await Promise.all(getTargetRoleIds(entry).map(async id => {
        return message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id).catch(() => null);
    }));
    return roles.filter(Boolean);
}

async function applyWordRoleAction(message, targetMember, roleId, entry) {
    const role = message.guild.roles.cache.get(String(roleId));
    if (!role) {
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return;
    }
    if (role.managed) {
        await message.reply('❌ **هذا الرول مُدار من Discord ولا يمكن إضافته أو إزالته يدويًا.**').catch(() => {});
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return;
    }
    const botMember = message.guild.members.me;
    if (!botMember || role.position >= botMember.roles.highest.position) {
        await message.reply('❌ **لا يستطيع البوت التعامل مع هذا الرول لأنه أعلى أو يساوي أعلى رول لديه.**').catch(() => {});
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return;
    }
    const hasRole = targetMember.roles.cache.has(role.id);
    const action = hasRole ? 'remove' : 'add';
    const result = action === 'remove'
        ? await targetMember.roles.remove(role.id).then(() => true).catch(() => false)
        : await targetMember.roles.add(role.id).then(() => true).catch(() => false);
    if (!result) {
        await message.reply(`❌ **فشل ${action === 'remove' ? 'إزالة' : 'إضافة'} الرول للهدف (تحقق من صلاحيات البوت وترتيب الرول).**`).catch(() => {});
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return;
    }
    if (action === 'add' && entry?.hasPermMessage) {
        await message.reply(entry.hasPermMessage).catch(() => {});
    } else {
        await message.react(action === 'remove' ? '<:emoji_42:1481252567227826388>' : '<:emoji_43:1481252608361365701>').catch(() => {});
    }
}

function buildTargetRoleSelect(customId, defaultRoleIds = []) {
    const menu = new RoleSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('اختر رول أو أكثر للكلمة')
        .setMinValues(1)
        .setMaxValues(25);
    if (defaultRoleIds.length && typeof menu.setDefaultRoles === 'function') {
        menu.setDefaultRoles(defaultRoleIds);
    }
    return new ActionRowBuilder().addComponents(menu);
}

function getSafeTargetRoles(interaction, roleIds) {
    const roles = [...new Set((roleIds || []).map(String))]
        .map(id => interaction.guild.roles.cache.get(id))
        .filter(Boolean);
    if (!roles.length) return { ok: false, error: '❌ **لازم تختار رول واحد على الأقل.**' };
    for (const role of roles) {
        const error = ensureSafeTargetRole(interaction, role);
        if (error) return { ok: false, error };
    }
    return { ok: true, roles };
}

async function promptAllowedRolesByMessage(interaction) {
    await interaction.editReply({
        content: '✅ **المدخلات صحيحة.**\n**أرسل الآن رسالة في نفس الشات تحتوي الرولات المسموح لها ( منشن / ID / اسم ) أو اكتب `0` لكل الادمن.**',
        components: []
    });

    const collected = await interaction.channel.awaitMessages({
        filter: m => m.author.id === interaction.user.id,
        max: 1,
        time: 60000,
        errors: ['time']
    }).catch(() => null);

    if (!collected || !collected.first()) {
        return { ok: false, error: '❌ **انتهى الوقت. أعد إنشاء الكلمة من جديد.**' };
    }

    const response = collected.first();
    const parsed = parseRolesFromMessage(interaction.guild, response.content);

    await response.delete().catch(() => {});

    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, ...parsed };
}

async function execute(message, _args, { BOT_OWNERS }) {
    if (!isBotOwner(message.author.id, BOT_OWNERS)) {
        return message.reply('❌ **أمر word مخصص فقط لأونر البوت.**');
    }

    const embed = buildWordSystemEmbed(message.guild);
    const row = buildWordActionRow();

    await message.reply({ embeds: [embed], components: [row] });
}

async function handleInteraction(interaction, context) {
    const { BOT_OWNERS } = context;
    if (!interaction.guild) return false;

    const isWordUsageSelection = (interaction.isStringSelectMenu() && interaction.customId.startsWith('word_apply_role:')) || (interaction.isButton() && interaction.customId.startsWith('word_apply_page:'));
    if (!isWordUsageSelection && !isBotOwner(interaction.user.id, BOT_OWNERS)) {
        await interaction.reply({ content: '❌ **أمر word مخصص فقط لأونر البوت.**', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (interaction.isButton() && interaction.customId.startsWith('word_apply_page:')) {
        const parts = interaction.customId.split(':');
        const actionKey = parts.slice(1, -1).join(':');
        const page = Number(parts.at(-1));
        const pending = pendingWordActions.get(actionKey);
        if (!pending || pending.authorId !== interaction.user.id) {
            await interaction.reply({ content: '❌ **هذا المنيو مخصص للشخص الذي استخدم الكلمة.**', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.update({ components: buildWordTargetMenu(`word_apply_role:${actionKey}`, pending.targetRoles, pending.targetMember, page) });
        return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('word_apply_role:')) {
        const actionKey = interaction.customId.slice('word_apply_role:'.length);
        const pending = pendingWordActions.get(actionKey);
        if (!pending || pending.authorId !== interaction.user.id) {
            await interaction.reply({ content: '❌ **هذا المنيو مخصص للشخص الذي استخدم الكلمة.**', flags: MessageFlags.Ephemeral });
            return true;
        }
        const selectedRoleId = interaction.values[0];
        if (!pending.targetRoles.some(role => role.id === selectedRoleId)) {
            await interaction.reply({ content: '❌ **الرول المختار غير متاح لهذه الكلمة.**', flags: MessageFlags.Ephemeral });
            return true;
        }
        pendingWordActions.delete(actionKey);
        const [deleteResult] = await Promise.allSettled([
            interaction.message.delete(),
            interaction.deferUpdate()
        ]);
        if (deleteResult.status === 'rejected') {
            await interaction.message.edit({ content: '', components: [] }).catch(() => {});
        }
        await applyWordRoleAction(pending.message, pending.targetMember, selectedRoleId, pending.entry);
        return true;
    }

    if (interaction.isButton() && interaction.customId === 'word_create') {
        const modal = new ModalBuilder().setCustomId(`word_create_modal:${interaction.message?.id || ''}`).setTitle('إنشاء كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('keyword').setLabel('اكتب حتى 3 كلمات Prefix لنفس الرولات').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('noPermMessage').setLabel('رسالة للي ما يملكون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hasPermMessage').setLabel('رسالة للي يملكون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('word_create_modal')) {
        const panelMessageId = extractPanelMessageId(interaction.customId, 'word_create_modal');
        const keywordValidation = parseKeywordsInput(getModalText(interaction, 'keyword', true));
        const noPermMessage = getModalText(interaction, 'noPermMessage').trim();
        const hasPermMessage = getModalText(interaction, 'hasPermMessage').trim();

        if (!keywordValidation.ok) {
            await interaction.reply({ content: keywordValidation.error, flags: MessageFlags.Ephemeral });
            return true;
        }
        const keywords = keywordValidation.keywords;

        const all = getWordData();
        const guildData = all[interaction.guild.id];
        if (guildData?.words?.length) {
            const collisionKeyword = keywords.find(k =>
                guildData.words.some(w => getEntryKeywords(w).includes(k))
            );
            if (collisionKeyword) {
                await interaction.reply({ content: `❌ **الكلمة \`${collisionKeyword}\` مستخدمة مسبقًا.**`, flags: MessageFlags.Ephemeral });
                return true;
            }
        }

        const pendingKey = `${interaction.guild.id}:${interaction.user.id}:${Date.now()}`;
        pendingRoleSelections.set(pendingKey, { panelMessageId, keywords, noPermMessage, hasPermMessage });
        await interaction.reply({
            content: '✅ **تم حفظ بيانات الكلمة. اختر الآن رولًا أو أكثر ليتم التبديل عليها عند استخدام الكلمة.**',
            components: [buildTargetRoleSelect(`word_target_roles_create:${pendingKey}`)],
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('word_target_roles_create:')) {
        const pendingKey = interaction.customId.slice('word_target_roles_create:'.length);
        const pending = pendingRoleSelections.get(pendingKey);
        pendingRoleSelections.delete(pendingKey);
        if (!pending) {
            await interaction.update({ content: '❌ **انتهت جلسة الإنشاء، أعد المحاولة.**', components: [] });
            return true;
        }
        const selected = getSafeTargetRoles(interaction, interaction.values);
        if (!selected.ok) {
            await interaction.update({ content: selected.error, components: [] });
            return true;
        }
        await interaction.update({ content: '⏳ **جاري انتظار رسالة الرولات المسموح لها...**', components: [] });
        const allowed = await promptAllowedRolesByMessage(interaction);
        if (!allowed.ok) {
            await interaction.editReply({ content: allowed.error, components: [] });
            return true;
        }

        const payload = {
            keyword: pending.keywords[0],
            keywords: pending.keywords,
            targetRoleId: selected.roles[0].id,
            targetRoleIds: selected.roles.map(role => role.id),
            noPermMessage: pending.noPermMessage,
            hasPermMessage: pending.hasPermMessage,
            allowedMode: allowed.mode,
            allowedRoleIds: allowed.roleIds,
            createdBy: interaction.user.id,
            updatedAt: Date.now()
        };

        upsertWord(interaction.guild.id, payload);
        await interaction.editReply({ content: '', embeds: [buildWordPreview(payload, interaction.guild)], components: [] });
        await refreshWordPanelMessage(interaction, pending.panelMessageId);
        return true;
    }

    if (interaction.isButton() && interaction.customId === 'word_delete') {
        const modal = new ModalBuilder().setCustomId(`word_delete_modal:${interaction.message?.id || ''}`).setTitle('حذف كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('keyword').setLabel('اكتب أي كلمة من كلمات البرفكس').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('word_delete_modal')) {
        const panelMessageId = extractPanelMessageId(interaction.customId, 'word_delete_modal');
        const keyword = normalizeWord(getModalText(interaction, 'keyword', true));
        const all = getWordData();
        const guildData = all[interaction.guild.id];

        if (!guildData || !Array.isArray(guildData.words)) {
            await interaction.reply({ content: '❌ **لا يوجد كلمات محفوظة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        const before = guildData.words.length;
        guildData.words = guildData.words.filter(w => !getEntryKeywords(w).includes(keyword));

        if (before === guildData.words.length) {
            await interaction.reply({ content: '❌ **الكلمة غير موجودة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        saveWordData(all);
        await interaction.reply({ content: '✅ **تم حذف الكلمة بنجاح.**', flags: MessageFlags.Ephemeral });
        await refreshWordPanelMessage(interaction, panelMessageId);
        return true;
    }

    if (interaction.isButton() && interaction.customId === 'word_edit') {
        const modal = new ModalBuilder().setCustomId(`word_edit_modal:${interaction.message?.id || ''}`).setTitle('تعديل كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('currentKeyword').setLabel('كلمة حالية من كلمات البرفكس').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newKeyword').setLabel('كلمات Prefix جديدة (حتى 3 - اختياري)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newNoPermMessage').setLabel('رسالة بدون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newHasPermMessage').setLabel('رسالة مع صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('word_edit_modal')) {
        const panelMessageId = extractPanelMessageId(interaction.customId, 'word_edit_modal');
        const currentKeyword = normalizeWord(getModalText(interaction, 'currentKeyword', true));
        const all = getWordData();
        const guildData = all[interaction.guild.id];

        if (!guildData || !Array.isArray(guildData.words)) {
            await interaction.reply({ content: '❌ **لا يوجد كلمات محفوظة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        const existing = guildData.words.find(w => getEntryKeywords(w).includes(currentKeyword));
        if (!existing) {
            await interaction.reply({ content: '❌ **الكلمة الحالية غير موجودة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        const newKeywordInput = getModalText(interaction, 'newKeyword');
        const newNoPerm = getModalText(interaction, 'newNoPermMessage').trim();
        const newHasPerm = getModalText(interaction, 'newHasPermMessage').trim();

        const newKeywordValidation = parseKeywordsInput(newKeywordInput);
        const newKeywords = newKeywordValidation.ok ? newKeywordValidation.keywords : [];

        if (newKeywordInput?.trim() && !newKeywordValidation.ok) {
            await interaction.reply({ content: newKeywordValidation.error, flags: MessageFlags.Ephemeral });
            return true;
        }

        if (newKeywords.length > 0) {
            const hasCollisionKeyword = newKeywords.find(k =>
                guildData.words.some(w => w !== existing && getEntryKeywords(w).includes(k))
            );
            if (hasCollisionKeyword) {
                await interaction.reply({ content: `❌ **الكلمة \`${hasCollisionKeyword}\` مستخدمة مسبقًا، اختر كلمة مختلفة.**`, flags: MessageFlags.Ephemeral });
                return true;
            }
            existing.keywords = newKeywords;
            existing.keyword = newKeywords[0];
        }

        if (newNoPerm) existing.noPermMessage = newNoPerm;
        if (newHasPerm) existing.hasPermMessage = newHasPerm;

        existing.updatedAt = Date.now();

        const pendingKey = `${interaction.guild.id}:${interaction.user.id}:${Date.now()}`;
        pendingRoleSelections.set(pendingKey, { panelMessageId, existing, all });
        await interaction.reply({
            content: '✅ **تم تطبيق تعديلات النص. اختر الآن رولًا أو أكثر للكلمة.**',
            embeds: [buildWordPreview(pending.existing, interaction.guild)],
            components: [buildTargetRoleSelect(`word_target_roles_edit:${pendingKey}`, getTargetRoleIds(existing))],
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('word_target_roles_edit:')) {
        const pendingKey = interaction.customId.slice('word_target_roles_edit:'.length);
        const pending = pendingRoleSelections.get(pendingKey);
        pendingRoleSelections.delete(pendingKey);
        if (!pending) {
            await interaction.update({ content: '❌ **انتهت جلسة التعديل، أعد المحاولة.**', components: [] });
            return true;
        }
        const selected = getSafeTargetRoles(interaction, interaction.values);
        if (!selected.ok) {
            await interaction.update({ content: selected.error, components: [] });
            return true;
        }
        pending.existing.targetRoleIds = selected.roles.map(role => role.id);
        pending.existing.targetRoleId = selected.roles[0].id;
        await interaction.update({ content: '⏳ **تم تحديث الرولات. أرسل الآن رسالة بالرولات المسموح لها ( منشن / ID / اسم ) أو `0`، أو `-` للإبقاء عليها.**', components: [] });

        const collected = await interaction.channel.awaitMessages({
            filter: m => m.author.id === interaction.user.id,
            max: 1,
            time: 60000,
            errors: ['time']
        }).catch(() => null);

        if (!collected || !collected.first()) {
            await interaction.editReply({
                content: '⚠️ **انتهى الوقت، تم حفظ التعديلات الأخرى بدون تغيير رولات الاستخدام.**',
                embeds: [buildWordPreview(pending.existing, interaction.guild)]
            });
            saveWordData(pending.all);
            return true;
        }

        const response = collected.first();
        const content = response.content.trim();
        await response.delete().catch(() => {});

        if (content !== '-') {
            const parsedAllowed = parseRolesFromMessage(interaction.guild, content);
            if (!parsedAllowed.ok) {
                await interaction.editReply({
                    content: `${parsedAllowed.error}\n**تم حفظ بقية التعديلات بدون تحديث رولات الاستخدام.**`,
                    embeds: [buildWordPreview(pending.existing, interaction.guild)]
                });
                saveWordData(pending.all);
                return true;
            }
            pending.existing.allowedMode = parsedAllowed.mode;
            pending.existing.allowedRoleIds = parsedAllowed.roleIds;
        }

        saveWordData(pending.all);
        await interaction.editReply({ content: '', embeds: [buildWordPreview(pending.existing, interaction.guild)] });
        await refreshWordPanelMessage(interaction, pending.panelMessageId);
        return true;
    }

    return false;
}

async function resolveTargetMember(message) {
    if (message.mentions.members?.first()) return message.mentions.members.first();

    if (message.reference?.messageId) {
        const refMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (refMessage?.member) return refMessage.member;
    }

    const idMatch = message.content.match(/\b(\d{16,20})\b/);
    if (idMatch) return message.guild.members.fetch(idMatch[1]).catch(() => null);

    return null;
}

function extractInvokedWord(content) {
    const trimmed = normalizeWord(content);
    if (!trimmed) return '';
    return trimmed.split(/\s+/)[0] || '';
}

function findInvokedEntry(entries, content) {
    const invokedWord = extractInvokedWord(content);
    if (!invokedWord) return null;

    return entries.find(entry => getEntryKeywords(entry).includes(invokedWord)) || null;
}

async function handleMessage(message, context) {
    if (!message.guild || message.author.bot) return false;

    const all = getWordData();
    const guildData = all[message.guild.id];
    if (!guildData || !Array.isArray(guildData.words) || guildData.words.length === 0) return false;

    const entry = findInvokedEntry(guildData.words, message.content);
    if (!entry) return false;

    const member = message.member;
    const allowed = canUseWord(member, entry, context.BOT_OWNERS || []);

    if (!allowed) {
        if (entry.noPermMessage) {
            await message.reply(entry.noPermMessage).catch(() => {});
        } else {
            await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        }
        return true;
    }

    const targetMember = await resolveTargetMember(message);
    if (!targetMember) {
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return true;
    }
    await message.guild.roles.fetch().catch(() => null);
    const targetRoles = await getTargetRolesForMessage(message, entry);
    if (targetRoles.length === 0) {
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return true;
    }
    const missingRoleIds = getTargetRoleIds(entry).filter(id => !targetRoles.some(role => role.id === id));
    if (missingRoleIds.length > 0) {
        await message.reply(`❌ **تعذر العثور على ${missingRoleIds.length} من الرولات المحفوظة لهذه الكلمة. أعد تعديل الكلمة واختر الرولات من جديد.**`).catch(() => {});
        return true;
    }

    if (targetRoles.length === 1) {
        await applyWordRoleAction(message, targetMember, targetRoles[0].id, entry);
        return true;
    }

    const actionKey = `${message.id}:${message.author.id}:${Date.now()}`;
    pendingWordActions.set(actionKey, { message, targetMember, targetRoles, entry, authorId: message.author.id });
    const timeout = setTimeout(() => pendingWordActions.delete(actionKey), 60000);
    timeout.unref?.();
    await message.reply({
        content: '**Choose One of roles**',
        components: buildWordTargetMenu(`word_apply_role:${actionKey}`, targetRoles, targetMember, 0)
    }).catch(() => pendingWordActions.delete(actionKey));

    return true;
}

function registerInteractionHandler() {
    if (global.__wordInteractionHandlerRegistered) return;
    global.__wordInteractionHandlerRegistered = true;
    interactionRouter.register('word_', async (interaction, context) => handleInteraction(interaction, context), {
        name: 'word-system',
        match: 'prefix',
        priority: 30,
        types: ['button', 'modal', 'roleSelect', 'stringSelect']
    });
}

module.exports = {
    name: 'word',
    aliases: ['كلمة'],
    execute,
    handleInteraction,
    handleMessage,
    registerInteractionHandler
};
