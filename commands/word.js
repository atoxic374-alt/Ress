const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const interactionRouter = require('../utils/interactionRouter');
const colorManager = require('../utils/colorManager');

const DATA_PATH = path.join(__dirname, '..', 'data', 'wordTriggers.json');
const ADMIN_ROLES_PATH = path.join(__dirname, '..', 'data', 'adminRoles.json');

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

function canUseWord(member, entry, BOT_OWNERS = []) {
    if (!member) return false;

    if (isBotOwner(member.id, BOT_OWNERS)) return true;
    if (member.guild.ownerId === member.id) return true;

    if (entry.allowedMode === 'admin') {
        const adminRoles = getAdminRoles();
        return member.roles.cache.some(role => adminRoles.includes(role.id));
    }

    return member.roles.cache.some(role => (entry.allowedRoleIds || []).includes(role.id));
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
    const allowedText = entry.allowedMode === 'admin'
        ? 'جميع رولات الأدمن '
        : entry.allowedRoleIds.map(id => guild.roles.cache.get(id)?.toString() || `\`${id}\``).join(' , ') || '—';

    return colorManager.createEmbed()
        .setTitle('**Saved word**')
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .setDescription([
        ` ** `,
            `• الكلمات : ${keywordsText}`,
            
            `• الرول : <@&${entry.targetRoleId}>`,
            
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
            const allowedText = entry.allowedMode === 'admin'
                ? 'كل الادارة'
                : `${(entry.allowedRoleIds || []).length} رول`;

            return [
                `**`,
                `• #${index + 1}`,
                `• Prefix : ${prefixes}`,
                `• Role : <@&${entry.targetRoleId}>`,
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

    if (!isBotOwner(interaction.user.id, BOT_OWNERS)) {
        await interaction.reply({ content: '❌ **أمر word مخصص فقط لأونر البوت.**', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (interaction.isButton() && interaction.customId === 'word_create') {
        const modal = new ModalBuilder().setCustomId(`word_create_modal:${interaction.message?.id || ''}`).setTitle('إنشاء كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('keyword').setLabel('اكتب حتى 3 كلمات Prefix لنفس الرول').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('targetRole').setLabel('ضع ID أو اسم الرول').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('noPermMessage').setLabel('رسالة للي ما يملكون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hasPermMessage').setLabel('رسالة للي يملكون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('word_create_modal')) {
        const panelMessageId = extractPanelMessageId(interaction.customId, 'word_create_modal');
        const keywordValidation = parseKeywordsInput(interaction.fields.getTextInputValue('keyword'));
        const targetRoleInput = interaction.fields.getTextInputValue('targetRole');
        const noPermMessage = interaction.fields.getTextInputValue('noPermMessage')?.trim() || '';
        const hasPermMessage = interaction.fields.getTextInputValue('hasPermMessage')?.trim() || '';

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

        const targetRole = findClosestRole(interaction.guild, targetRoleInput);
        const safetyError = ensureSafeTargetRole(interaction, targetRole);
        if (safetyError) {
            await interaction.reply({ content: safetyError, flags: MessageFlags.Ephemeral });
            return true;
        }

        await interaction.reply({ content: '⏳ **جاري انتظار رسالة الرولات المسموح لها...**', flags: MessageFlags.Ephemeral });
        const allowed = await promptAllowedRolesByMessage(interaction);
        if (!allowed.ok) {
            await interaction.editReply({ content: allowed.error, components: [] });
            return true;
        }

        const payload = {
            keyword: keywords[0],
            keywords,
            targetRoleId: targetRole.id,
            noPermMessage,
            hasPermMessage,
            allowedMode: allowed.mode,
            allowedRoleIds: allowed.roleIds,
            createdBy: interaction.user.id,
            updatedAt: Date.now()
        };

        upsertWord(interaction.guild.id, payload);
        await interaction.editReply({ content: '', embeds: [buildWordPreview(payload, interaction.guild)], components: [] });
        await refreshWordPanelMessage(interaction, panelMessageId);
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
        const keyword = normalizeWord(interaction.fields.getTextInputValue('keyword'));
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
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newTargetRole').setLabel('الرول الجديد (اختياري)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newNoPermMessage').setLabel('رسالة بدون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newHasPermMessage').setLabel('رسالة مع صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('word_edit_modal')) {
        const panelMessageId = extractPanelMessageId(interaction.customId, 'word_edit_modal');
        const currentKeyword = normalizeWord(interaction.fields.getTextInputValue('currentKeyword'));
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

        const newKeywordInput = interaction.fields.getTextInputValue('newKeyword');
        const newTargetRoleRaw = interaction.fields.getTextInputValue('newTargetRole')?.trim();
        const newNoPerm = interaction.fields.getTextInputValue('newNoPermMessage')?.trim();
        const newHasPerm = interaction.fields.getTextInputValue('newHasPermMessage')?.trim();

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

        if (newTargetRoleRaw) {
            const role = findClosestRole(interaction.guild, newTargetRoleRaw);
            const safetyError = ensureSafeTargetRole(interaction, role);
            if (safetyError) {
                await interaction.reply({ content: safetyError, flags: MessageFlags.Ephemeral });
                return true;
            }
            existing.targetRoleId = role.id;
        }

        if (newNoPerm) existing.noPermMessage = newNoPerm;
        if (newHasPerm) existing.hasPermMessage = newHasPerm;

        existing.updatedAt = Date.now();

        await interaction.reply({
            content: '⏳ **تم تطبيق التعديلات المبدئية.**\n**أرسل الآن رسالة بالرولات المسموح لها ( منشن / ID / اسم ) أو `0` لكل adminRoles.**\n**أو اكتب `-` للإبقاء عليها كما هي.**',
            embeds: [buildWordPreview(existing, interaction.guild)],
            flags: MessageFlags.Ephemeral
        });

        const collected = await interaction.channel.awaitMessages({
            filter: m => m.author.id === interaction.user.id,
            max: 1,
            time: 60000,
            errors: ['time']
        }).catch(() => null);

        if (!collected || !collected.first()) {
            await interaction.editReply({
                content: '⚠️ **انتهى الوقت، تم حفظ التعديلات الأخرى بدون تغيير رولات الاستخدام.**',
                embeds: [buildWordPreview(existing, interaction.guild)]
            });
            saveWordData(all);
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
                    embeds: [buildWordPreview(existing, interaction.guild)]
                });
                saveWordData(all);
                return true;
            }
            existing.allowedMode = parsedAllowed.mode;
            existing.allowedRoleIds = parsedAllowed.roleIds;
        }

        saveWordData(all);
        await interaction.editReply({ content: '', embeds: [buildWordPreview(existing, interaction.guild)] });
        await refreshWordPanelMessage(interaction, panelMessageId);
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
            await message.react('❌').catch(() => {});
        }
        return true;
    }

    const targetMember = await resolveTargetMember(message);
    if (!targetMember) {
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return true;
    }

    if (targetMember.roles.cache.has(entry.targetRoleId)) {
        const removeResult = await targetMember.roles.remove(entry.targetRoleId).then(() => true).catch(() => false);
        if (!removeResult) {
            await message.reply('❌ **فشل إزالة الرول من الهدف (تحقق من صلاحيات البوت وترتيب الرولات).**').catch(() => {});
            await message.react('❌').catch(() => {});
            return true;
        }
        await message.react('<:emoji_42:1481252567227826388>').catch(() => {});
        return true;
    }

    const addResult = await targetMember.roles.add(entry.targetRoleId).then(() => true).catch(() => false);
    if (!addResult) {
        await message.reply('❌ **فشل إضافة الرول للهدف (تحقق من صلاحيات البوت وترتيب الرولات).**').catch(() => {});
        await message.react('<:emoji_44:1481252878604697692>').catch(() => {});
        return true;
    }

    if (entry.hasPermMessage) {
        await message.reply(entry.hasPermMessage).catch(() => {});
    } else {
        await message.react('<:emoji_43:1481252608361365701>').catch(() => {});
    }

    return true;
}

function registerInteractionHandler() {
    interactionRouter.register('word_', async (interaction, context) => handleInteraction(interaction, context), {
        name: 'word-system',
        match: 'prefix',
        priority: 30,
        types: ['button', 'modal']
    });
}

module.exports = {
    name: 'word',
    aliases: ['كلمة'],
    execute,
    handleMessage,
    registerInteractionHandler
};
