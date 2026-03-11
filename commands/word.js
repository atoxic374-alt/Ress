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

function normalizeWord(input) {
    return String(input || '').trim().toLowerCase();
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
    const roleId = mentionMatch ? mentionMatch[1] : query.replace(/\D/g, '');
    if (roleId && guild.roles.cache.has(roleId)) return guild.roles.cache.get(roleId);

    const normalized = query.toLowerCase();
    const exact = guild.roles.cache.find(r => r.name.toLowerCase() === normalized);
    if (exact) return exact;

    return guild.roles.cache
        .filter(r => r.name.toLowerCase().includes(normalized) || normalized.includes(r.name.toLowerCase()))
        .sort((a, b) => a.name.length - b.name.length)
        .first() || null;
}

function parseRolesFromMessage(guild, content) {
    const raw = String(content || '').trim();
    if (!raw) return { ok: false, error: '❌ **لازم ترسل الرولات ( منشن / ID / اسم ) أو 0.**' };
    if (raw === '0') return { ok: true, mode: 'admin', roleIds: [] };

    const parts = raw.split(/[،,\n]+/).map(p => p.trim()).filter(Boolean);
    const roleIds = [];

    for (const part of parts) {
        const role = findClosestRole(guild, part);
        if (!role) return { ok: false, error: `❌ **ما قدرت أحدد الرول :** ${part}` };
        if (!roleIds.includes(role.id)) roleIds.push(role.id);
    }

    return { ok: true, mode: 'roles', roleIds };
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
        p.ModerateMembers,
        p.MentionEveryone
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

    const idx = all[guildId].words.findIndex(w => normalizeWord(w.keyword) === normalizeWord(wordEntry.keyword));
    if (idx >= 0) {
        all[guildId].words[idx] = { ...all[guildId].words[idx], ...wordEntry };
    } else {
        all[guildId].words.push(wordEntry);
    }

    saveWordData(all);
}

function buildWordPreview(entry, guild) {
    const allowedText = entry.allowedMode === 'admin'
        ? 'جميع رولات الأدمن (adminRoles.json)'
        : entry.allowedRoleIds.map(id => guild.roles.cache.get(id)?.toString() || `\`${id}\``).join(' ، ') || '—';

    return colorManager.createEmbed()
        .setTitle('**تم حفظ إعداد كلمة**')
        .setThumbnail(guild.iconURL({ size: 256 }) || null)
        .setDescription([
            `**الكلمة :** ${entry.keyword}`,
            '',
            `**الرول المربوط :** <@&${entry.targetRoleId}>`,
            '',
            `**رسالة بدون صلاحية :** ${entry.noPermMessage || 'غير محددة'}`,
            '',
            `**رسالة مع صلاحية :** ${entry.hasPermMessage || 'غير محددة'}`,
            '',
            `**الرولات المسموح لها :** ${allowedText}`
        ].join('\n'));
}

async function promptAllowedRolesByMessage(interaction) {
    await interaction.editReply({
        content: '✅ **المدخلات صحيحة.**\n**أرسل الآن رسالة في نفس الشات تحتوي الرولات المسموح لها ( منشن / ID / اسم ) أو اكتب `0` لكل adminRoles.**',
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

    const embed = colorManager.createEmbed()
        .setTitle('**نظام word**')
        .setThumbnail(message.guild.iconURL({ size: 256 }) || null)
        .setDescription('**اختر العملية المطلوبة :**\n\n**• إنشاء**\n**• إزالة**\n**• تعديل**');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('word_create').setLabel('إنشاء').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('word_delete').setLabel('إزالة').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('word_edit').setLabel('تعديل').setStyle(ButtonStyle.Primary)
    );

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
        const modal = new ModalBuilder().setCustomId('word_create_modal').setTitle('إنشاء كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('keyword').setLabel('ضع الكلمة').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('targetRole').setLabel('ضع ID أو اسم الرول').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('noPermMessage').setLabel('رسالة للي ما يملكون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hasPermMessage').setLabel('رسالة للي يملكون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'word_create_modal') {
        const keyword = normalizeWord(interaction.fields.getTextInputValue('keyword'));
        const targetRoleInput = interaction.fields.getTextInputValue('targetRole');
        const noPermMessage = interaction.fields.getTextInputValue('noPermMessage')?.trim() || '';
        const hasPermMessage = interaction.fields.getTextInputValue('hasPermMessage')?.trim() || '';

        if (!keyword) {
            await interaction.reply({ content: '❌ **الكلمة مطلوبة.**', flags: MessageFlags.Ephemeral });
            return true;
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
            keyword,
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
        return true;
    }

    if (interaction.isButton() && interaction.customId === 'word_delete') {
        const modal = new ModalBuilder().setCustomId('word_delete_modal').setTitle('حذف كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('keyword').setLabel('اكتب الكلمة المراد حذفها').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'word_delete_modal') {
        const keyword = normalizeWord(interaction.fields.getTextInputValue('keyword'));
        const all = getWordData();
        const guildData = all[interaction.guild.id];

        if (!guildData || !Array.isArray(guildData.words)) {
            await interaction.reply({ content: '❌ **لا يوجد كلمات محفوظة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        const before = guildData.words.length;
        guildData.words = guildData.words.filter(w => normalizeWord(w.keyword) !== keyword);

        if (before === guildData.words.length) {
            await interaction.reply({ content: '❌ **الكلمة غير موجودة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        saveWordData(all);
        await interaction.reply({ content: '✅ **تم حذف الكلمة بنجاح.**', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (interaction.isButton() && interaction.customId === 'word_edit') {
        const modal = new ModalBuilder().setCustomId('word_edit_modal').setTitle('تعديل كلمة');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('currentKeyword').setLabel('الكلمة الحالية').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newKeyword').setLabel('الكلمة الجديدة (اختياري)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newTargetRole').setLabel('الرول الجديد (اختياري)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newNoPermMessage').setLabel('رسالة بدون صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newHasPermMessage').setLabel('رسالة مع صلاحية (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'word_edit_modal') {
        const currentKeyword = normalizeWord(interaction.fields.getTextInputValue('currentKeyword'));
        const all = getWordData();
        const guildData = all[interaction.guild.id];

        if (!guildData || !Array.isArray(guildData.words)) {
            await interaction.reply({ content: '❌ **لا يوجد كلمات محفوظة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        const existing = guildData.words.find(w => normalizeWord(w.keyword) === currentKeyword);
        if (!existing) {
            await interaction.reply({ content: '❌ **الكلمة الحالية غير موجودة.**', flags: MessageFlags.Ephemeral });
            return true;
        }

        const newKeywordRaw = normalizeWord(interaction.fields.getTextInputValue('newKeyword'));
        const newTargetRoleRaw = interaction.fields.getTextInputValue('newTargetRole')?.trim();
        const newNoPerm = interaction.fields.getTextInputValue('newNoPermMessage')?.trim();
        const newHasPerm = interaction.fields.getTextInputValue('newHasPermMessage')?.trim();

        if (newKeywordRaw) {
            const hasCollision = guildData.words.some(w =>
                w !== existing && normalizeWord(w.keyword) === newKeywordRaw
            );
            if (hasCollision) {
                await interaction.reply({ content: '❌ **الكلمة الجديدة مستخدمة مسبقًا، اختر كلمة مختلفة.**', flags: MessageFlags.Ephemeral });
                return true;
            }
            existing.keyword = newKeywordRaw;
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

        await interaction.reply({ content: '⏳ **أرسل الآن رسالة بالرولات المسموح لها ( منشن / ID / اسم ) أو `0` لكل adminRoles.**\n**أو اكتب `-` للإبقاء عليها كما هي.**', flags: MessageFlags.Ephemeral });

        const collected = await interaction.channel.awaitMessages({
            filter: m => m.author.id === interaction.user.id,
            max: 1,
            time: 60000,
            errors: ['time']
        }).catch(() => null);

        if (!collected || !collected.first()) {
            await interaction.editReply({ content: '⚠️ **انتهى الوقت، تم حفظ التعديلات الأخرى بدون تغيير رولات الاستخدام.**' });
            saveWordData(all);
            return true;
        }

        const response = collected.first();
        const content = response.content.trim();
        await response.delete().catch(() => {});

        if (content !== '-') {
            const parsedAllowed = parseRolesFromMessage(interaction.guild, content);
            if (!parsedAllowed.ok) {
                await interaction.editReply({ content: `${parsedAllowed.error}\n**تم حفظ بقية التعديلات بدون تحديث رولات الاستخدام.**` });
                saveWordData(all);
                return true;
            }
            existing.allowedMode = parsedAllowed.mode;
            existing.allowedRoleIds = parsedAllowed.roleIds;
        }

        saveWordData(all);
        await interaction.editReply({ content: '', embeds: [buildWordPreview(existing, interaction.guild)] });
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
    const trimmed = String(content || '').trim();
    if (!trimmed) return '';
    return normalizeWord(trimmed.split(/\s+/)[0]);
}

async function handleMessage(message, context) {
    if (!message.guild || message.author.bot) return false;

    const all = getWordData();
    const guildData = all[message.guild.id];
    if (!guildData || !Array.isArray(guildData.words) || guildData.words.length === 0) return false;

    const invokedWord = extractInvokedWord(message.content);
    const entry = guildData.words.find(w => normalizeWord(w.keyword) === invokedWord);
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
        await message.react('❌').catch(() => {});
        return true;
    }

    if (targetMember.roles.cache.has(entry.targetRoleId)) {
        const removeResult = await targetMember.roles.remove(entry.targetRoleId).then(() => true).catch(() => false);
        if (!removeResult) {
            await message.reply('❌ **فشل إزالة الرول من الهدف (تحقق من صلاحيات البوت وترتيب الرولات).**').catch(() => {});
            await message.react('❌').catch(() => {});
            return true;
        }
        await message.react('☑️').catch(() => {});
        return true;
    }

    const addResult = await targetMember.roles.add(entry.targetRoleId).then(() => true).catch(() => false);
    if (!addResult) {
        await message.reply('❌ **فشل إضافة الرول للهدف (تحقق من صلاحيات البوت وترتيب الرولات).**').catch(() => {});
        await message.react('❌').catch(() => {});
        return true;
    }

    if (entry.hasPermMessage) {
        await message.reply(entry.hasPermMessage).catch(() => {});
    } else {
        await message.react('✅').catch(() => {});
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
