const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const colorManager = require('../utils/colorManager');

const interactiveRolesPath = path.join(__dirname, '..', 'data', 'interactiveRoles.json');
const assetsDir = path.join(__dirname, '..', 'data', 'interactiveRoleAssets');

function ensureApplicationSystem(settings) {
    if (!settings.applicationSystem || typeof settings.applicationSystem !== 'object') {
        settings.applicationSystem = {};
    }

    settings.applicationSystem.enabled = Boolean(settings.applicationSystem.enabled);
    settings.applicationSystem.requestsChannelId = settings.applicationSystem.requestsChannelId || null;
    settings.applicationSystem.managersChannelId = settings.applicationSystem.managersChannelId || null;
    settings.applicationSystem.panelImagePath = settings.applicationSystem.panelImagePath || null;
    settings.applicationSystem.managersImagePath = settings.applicationSystem.managersImagePath || null;
    settings.applicationSystem.displayType = ['buttons', 'menu'].includes(settings.applicationSystem.displayType)
        ? settings.applicationSystem.displayType
        : 'buttons';
    settings.applicationSystem.defaultButtonEmoji = settings.applicationSystem.defaultButtonEmoji || null;
    settings.applicationSystem.defaultMenuEmoji = settings.applicationSystem.defaultMenuEmoji || null;
    settings.applicationSystem.roleConditions = settings.applicationSystem.roleConditions || {};
    settings.applicationSystem.panelMessageId = settings.applicationSystem.panelMessageId || null;
    settings.applicationSystem.orderMessageId = settings.applicationSystem.orderMessageId || null;
    settings.applicationSystem.rulesText = typeof settings.applicationSystem.rulesText === 'string' ? settings.applicationSystem.rulesText : '';
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
            }
            ensureApplicationSystem(data.settings);
            if (!data.pendingRequests || typeof data.pendingRequests !== 'object') data.pendingRequests = {};
            if (!data.cooldowns || typeof data.cooldowns !== 'object') data.cooldowns = {};
            if (!data.newPendingRequests || typeof data.newPendingRequests !== 'object') data.newPendingRequests = {};
            return data;
        }
    } catch (error) {
        console.error('Error loading interactive roles settings:', error);
    }
    const defaults = {
        settings: { approvers: [], interactiveRoles: [], requestChannel: null, exceptions: [] },
        pendingRequests: {},
        cooldowns: {},
        exceptionCooldowns: {},
        pendingExceptionRequests: {},
        newPendingRequests: {}
    };
    ensureApplicationSystem(defaults.settings);
    return defaults;
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

function hasPermission(member) {
    const isGuildOwner = member.guild.ownerId === member.id;
    const botConfigPath = path.join(__dirname, '..', 'data', 'botConfig.json');
    let BOT_OWNERS = global.BOT_OWNERS || [];
    if (BOT_OWNERS.length === 0) {
        try {
            if (fs.existsSync(botConfigPath)) {
                const botConfig = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
                BOT_OWNERS = botConfig.owners || [];
            }
        } catch (e) {}
    }
    return isGuildOwner || BOT_OWNERS.includes(member.id);
}

function buildMainMenu(settings) {
    const appEnabled = settings.settings.applicationSystem.enabled;
    return new StringSelectMenuBuilder()
        .setCustomId('setactive_main_menu')
        .setPlaceholder('اختر الإعداد...')
        .addOptions([
            { label: 'تحديد المسؤولين', description: 'تحديد الرولات التي يمكنها قبول/رفض الطلبات', value: 'set_approvers' },
            { label: 'الرولات التفاعلية', description: 'إضافة أو إزالة الرولات التي يمكن طلبها', value: 'set_roles' },
            { label: 'رولات الاستثناء', description: appEnabled ? 'تحديد رولات استثناء (بدون كلمات)' : 'تحديد رول استثناء مع كلمات مرتبطة', value: 'set_exceptions' },
            { label: appEnabled ? 'تعطيل نظام التقديم الجديد' : 'تفعيل نظام التقديم الجديد', description: 'التبديل بين النظام القديم والجديد', value: 'toggle_new_system' },
            { label: 'روم الطلبات الجديد', description: appEnabled ? 'تحديد أو تعديل روم الطلبات الجديدة' : 'يحتاج تفعيل النظام أولاً', value: 'set_app_requests_channel' },
            { label: 'روم المسؤولين', description: appEnabled ? 'الروم الذي يستقبل طلبات القبول/الرفض' : 'يحتاج تفعيل النظام أولاً', value: 'set_app_managers_channel' },
            { label: 'طريقة العرض', description: appEnabled ? 'أزرار أو منيو مع الإيموجي' : 'يحتاج تفعيل النظام أولاً', value: 'set_display_type' },
            { label: 'شروط التقديم لكل رول', description: appEnabled ? 'تحديد عدد الرسائل والساعات وعمر الحساب' : 'يحتاج تفعيل النظام أولاً', value: 'set_role_conditions' },
            { label: 'قوانين التقديم (اختياري)', description: appEnabled ? 'إضافة قوانين تظهر مع ترتيب الرولات' : 'يحتاج تفعيل النظام أولاً', value: 'set_app_rules' },
            { label: 'عرض الإعدادات', description: 'عرض الإعدادات الحالية للنظام', value: 'show_settings' }
        ]);
}

function getBackRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setactive_back').setLabel('رجوع').setStyle(ButtonStyle.Primary)
    );
}

function getMainMenuRow(settings) {
    return new ActionRowBuilder().addComponents(buildMainMenu(settings));
}

function getPersistentMenuRows(settings) {
    return [getMainMenuRow(settings), getBackRow()];
}

function formatConditionsMap(conditions, guild) {
    const lines = Object.entries(conditions || {}).map(([roleId, cond]) => {
        const role = guild.roles.cache.get(roleId);
        const name = role ? role.name : roleId;
        const msg = Number(cond.messagesRequired || 0);
        const hours = Number(cond.voiceHoursRequired || 0);
        const age = Number(cond.accountAgeDays || 0);
        return `**${name}**\nالرسائل: **${msg}** | الساعات: **${hours}** | عمر الحساب: **${age > 0 ? `${age} يوم` : 'غير مطلوب'}**`;
    });
    return lines.length ? lines.slice(0, 8).join('\n\n') : '**لا توجد شروط محفوظة**';
}

function buildRolesOrderEmbed(guild, settings) {
    const sortedRoles = (settings.settings.interactiveRoles || [])
        .map((id) => guild.roles.cache.get(id))
        .filter(Boolean)
        .sort((a, b) => b.position - a.position);

    const lines = sortedRoles.length > 0
        ? sortedRoles.map((role, index) => `**#${index + 1} - ${role} : ${index === 0 ? 'اعلى رول تفاعلي' : index === 1 ? 'ثاني اعلى رول تفاعلي' : `${index + 1} رول تفاعلي`}**`)
        : ['**لا توجد رولات تفاعلية محددة**'];

    const embed = new EmbedBuilder()
        .setTitle('ترتيب الرولات التفاعلي')
        .setDescription(lines.join('\n'))
        .setColor(colorManager.getColor ? colorManager.getColor() : '#0099ff')
        .setTimestamp();

    const rulesText = (settings.settings.applicationSystem.rulesText || '').trim();
    if (rulesText) {
        embed.addFields({ name: 'Rules', value: rulesText.slice(0, 1024), inline: false });
    }

    return embed;
}

function buildPanelComponents(guild, settings) {
    const roles = (settings.settings.interactiveRoles || [])
        .filter((id) => guild.roles.cache.has(id))
        .sort((a, b) => {
            const roleA = guild.roles.cache.get(a);
            const roleB = guild.roles.cache.get(b);
            return (roleB?.position || 0) - (roleA?.position || 0);
        });
    const app = settings.settings.applicationSystem;
    const rows = [];

    if (app.displayType === 'menu') {
        const menu = new StringSelectMenuBuilder()
            .setCustomId('int_new_apply_menu')
            .setPlaceholder('اختر الرول المطلوب')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(roles.slice(0, 25).map((roleId) => {
                const role = guild.roles.cache.get(roleId);
                const option = {
                    label: (role?.name || roleId).slice(0, 100),
                    description: `${guild.name} - Active Role`.slice(0, 100),
                    value: roleId
                };
                if (app.defaultMenuEmoji) option.emoji = app.defaultMenuEmoji;
                return option;
            }));
        rows.push(new ActionRowBuilder().addComponents(menu));
    } else {
        const chunks = [];
        for (let i = 0; i < roles.length; i += 5) chunks.push(roles.slice(i, i + 5));
        for (const chunk of chunks.slice(0, 5)) {
            const row = new ActionRowBuilder();
            for (const roleId of chunk) {
                const button = new ButtonBuilder()
                    .setCustomId(`int_new_apply_role_${roleId}`)
                    .setLabel((guild.roles.cache.get(roleId)?.name || roleId).slice(0, 80))
                    .setStyle(ButtonStyle.Secondary);
                if (app.defaultButtonEmoji) button.setEmoji(app.defaultButtonEmoji);
                row.addComponents(button);
            }
            rows.push(row);
        }
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('int_new_show_conditions')
                .setLabel('الشروط لكل رول')
            .setEmoji('<:emoji_33:1465383582292771025>')
                .setStyle(ButtonStyle.Secondary)
        )
    );

    return rows;
}

async function awaitImageAndSave(channel, userId, guildId, namePrefix) {
    const prompt = await channel.send('**ارسل الصورة الآن خلال 90 ثانية**');
    const collected = await channel.awaitMessages({
        filter: (m) => m.author.id === userId && m.attachments.size > 0,
        max: 1,
        time: 90000
    });
    prompt.delete().catch(() => {});

    if (!collected.size) return null;

    const msg = collected.first();
    const attachment = msg.attachments.first();
    if (!attachment?.url) return null;

    try {
        const parsed = new URL(attachment.url);
        if (!['https:', 'http:'].includes(parsed.protocol)) return null;

        const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
        const ext = (path.extname(parsed.pathname) || '').toLowerCase();
        if (!allowedExt.has(ext)) {
            await channel.send('**امتداد الصورة غير مسموح. الصيغ المسموحة: png, jpg, jpeg, webp, gif**').catch(() => {});
            return null;
        }

        const hostname = parsed.hostname.toLowerCase();
        const isPrivateIp = (ip) => {
            if (!net.isIP(ip)) return false;
            if (ip === '127.0.0.1' || ip === '::1') return true;
            if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
            if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
            if (ip.startsWith('169.254.')) return true;
            if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
            return false;
        };

        if (net.isIP(hostname) && isPrivateIp(hostname)) return null;
        if (!net.isIP(hostname)) {
            const records = await dns.lookup(hostname, { all: true }).catch(() => []);
            if (!records.length || records.some((record) => isPrivateIp(record.address))) return null;
        }

        fs.mkdirSync(assetsDir, { recursive: true });
        const filePath = path.join(assetsDir, `${namePrefix}_${guildId}${ext}`);
        const res = await axios.get(attachment.url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxRedirects: 5,
            maxContentLength: 8 * 1024 * 1024,
            maxBodyLength: 8 * 1024 * 1024,
            headers: { 'Accept': 'image/*,*/*' }
        });

        const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
            await channel.send('**الملف المرفوع ليس صورة صالحة**').catch(() => {});
            return null;
        }

        const buffer = Buffer.from(res.data);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    } catch (error) {
        console.error('Error saving interactive image:', error);
        return null;
    }
}

async function sendOrUpdateApplicationPanel(guild, settings) {
    const app = settings.settings.applicationSystem;
    if (!app.requestsChannelId) return false;

    const channel = guild.channels.cache.get(app.requestsChannelId) || await guild.channels.fetch(app.requestsChannelId).catch(() => null);
    if (!channel) return false;

    const orderEmbed = buildRolesOrderEmbed(guild, settings);
    const components = buildPanelComponents(guild, settings);

    let orderMessage = null;
    if (app.orderMessageId) {
        orderMessage = await channel.messages.fetch(app.orderMessageId).catch(() => null);
    }

    if (orderMessage) {
        await orderMessage.edit({ embeds: [orderEmbed], components: [] }).catch(() => {});
    } else {
        const sentOrder = await channel.send({ embeds: [orderEmbed] });
        app.orderMessageId = sentOrder.id;
    }

    const payload = {
        content: '** Choose Your Active role**',
        components
    };

    if (app.panelImagePath && fs.existsSync(app.panelImagePath)) {
        payload.content = null;
        payload.files = [new AttachmentBuilder(app.panelImagePath)];
    }

    let panelMessage = null;
    if (app.panelMessageId) {
        panelMessage = await channel.messages.fetch(app.panelMessageId).catch(() => null);
    }

    if (panelMessage) {
        await panelMessage.edit(payload).catch(async () => {
            const sent = await channel.send(payload);
            app.panelMessageId = sent.id;
        });
    } else {
        const sent = await channel.send(payload);
        app.panelMessageId = sent.id;
    }

    saveSettings(settings);
    return true;
}

module.exports = {
    name: 'setactive',
    description: 'إعداد نظام الرولات التفاعلية',
    async execute(interaction) {
        if (!hasPermission(interaction.member)) {
            return interaction.reply({ content: '**لا تملك صلاحية لاستخدام هذا الأمر.**', ephemeral: true });
        }

        const settings = loadSettings();
        const embed = new EmbedBuilder()
            .setTitle('إعدادات الرولات التفاعلية')
            .setDescription('**اختر الإعداد المطلوب من القائمة**')
            .setColor(colorManager.getColor ? colorManager.getColor() : '#0099ff')
            .setTimestamp();

        await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(buildMainMenu(settings))] });
    }
};

async function handleSetActiveInteraction(interaction) {
    if (!interaction.customId?.startsWith('setactive_')) return;
    if (!hasPermission(interaction.member)) return interaction.reply({ content: '**لا تملك صلاحية.**', ephemeral: true });

    const settings = loadSettings();
    const app = settings.settings.applicationSystem;
    const customId = interaction.customId;

    if (customId === 'setactive_main_menu') {
        const value = interaction.values[0];

        if (value === 'toggle_new_system') {
            app.enabled = !app.enabled;
            if (app.enabled) {
                settings.settings.requestChannel = null;
            }
            saveSettings(settings);
            const txt = app.enabled
                ? '**تم تفعيل نظام التقديم الجديد. تم تعطيل منطق روم الطلبات والاستثناءات القديم بالكامل.**'
                : '**تم تعطيل نظام التقديم الجديد والرجوع للنظام القديم.**';
            return interaction.update({ content: txt, components: getPersistentMenuRows(settings), embeds: [] });
        }

        if (value === 'set_approvers') {
            const roleMenu = new RoleSelectMenuBuilder().setCustomId('setactive_select_approvers').setPlaceholder('اختر رولات المسؤولين').setMinValues(1).setMaxValues(10);
            return interaction.update({ content: '**اختر رولات المسؤولين الذين يحق لهم قبول/رفض الطلبات**', components: [new ActionRowBuilder().addComponents(roleMenu)], embeds: [] });
        }

        if (value === 'set_exceptions') {
            if (app.enabled) {
                const roleMenu = new RoleSelectMenuBuilder()
                    .setCustomId('setactive_select_exception_roles_new')
                    .setPlaceholder('اختر رولات الاستثناء (النظام الجديد)')
                    .setMinValues(1)
                    .setMaxValues(10);
                return interaction.update({ content: '**اختر رولات الاستثناء (في النظام الجديد لا تحتاج كلمات).**', components: [new ActionRowBuilder().addComponents(roleMenu), getBackRow()], embeds: [] });
            }

            const roleMenu = new RoleSelectMenuBuilder()
                .setCustomId('setactive_select_exception_role_old')
                .setPlaceholder('اختر رول الاستثناء (النظام القديم)')
                .setMinValues(1)
                .setMaxValues(1);
            return interaction.update({ content: '**اختر رول الاستثناء ثم ستكتب الكلمات المرتبطة به (النظام القديم).**', components: [new ActionRowBuilder().addComponents(roleMenu), getBackRow()], embeds: [] });
        }

        if (value === 'set_roles') {
            const roleMenu = new RoleSelectMenuBuilder().setCustomId('setactive_select_interactive_roles').setPlaceholder('اختر الرولات التفاعلية').setMinValues(1).setMaxValues(25);
            return interaction.update({ content: '**اختر الرولات التفاعلية**', components: [new ActionRowBuilder().addComponents(roleMenu)], embeds: [] });
        }

        if (value === 'set_app_requests_channel') {
            if (!app.enabled) return interaction.update({ content: '**يجب تفعيل نظام التقديم الجديد أولاً**', components: [getBackRow()], embeds: [] });
            const channelMenu = new ChannelSelectMenuBuilder().setCustomId('setactive_select_app_requests_channel').setPlaceholder('اختر روم الطلبات').addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
            return interaction.update({ content: '**اختر روم الطلبات الجديد**', components: [new ActionRowBuilder().addComponents(channelMenu)], embeds: [] });
        }

        if (value === 'set_app_managers_channel') {
            if (!app.enabled) return interaction.update({ content: '**يجب تفعيل نظام التقديم الجديد أولاً**', components: [getBackRow()], embeds: [] });
            const channelMenu = new ChannelSelectMenuBuilder().setCustomId('setactive_select_app_managers_channel').setPlaceholder('اختر روم المسؤولين').addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
            return interaction.update({ content: '**اختر روم المسؤولين لاستقبال الطلبات**', components: [new ActionRowBuilder().addComponents(channelMenu)], embeds: [] });
        }

        if (value === 'set_display_type') {
            if (!app.enabled) return interaction.update({ content: '**يجب تفعيل نظام التقديم الجديد أولاً**', components: [getBackRow()], embeds: [] });
            const menu = new StringSelectMenuBuilder().setCustomId('setactive_select_display_type').setPlaceholder('اختر طريقة العرض').addOptions([
                { label: 'أزرار', value: 'buttons' },
                { label: 'منيو', value: 'menu' }
            ]);
            return interaction.update({ content: '**اختر طريقة عرض الرولات في روم الطلبات**', components: [new ActionRowBuilder().addComponents(menu)], embeds: [] });
        }

        if (value === 'set_role_conditions') {
            if (!app.enabled) return interaction.update({ content: '**يجب تفعيل نظام التقديم الجديد أولاً**', components: [getBackRow()], embeds: [] });
            const filteredRoles = (settings.settings.interactiveRoles || [])
                .map((roleId) => interaction.guild.roles.cache.get(roleId))
                .filter(Boolean)
                .sort((a, b) => b.position - a.position)
                .slice(0, 25);

            if (!filteredRoles.length) {
                return interaction.update({ content: '**لا توجد رولات تفاعلية محددة حالياً. قم بتحديدها أولاً من خيار الرولات التفاعلية.**', components: getPersistentMenuRows(settings), embeds: [] });
            }

            const roleMenu = new StringSelectMenuBuilder()
                .setCustomId('setactive_pick_condition_role')
                .setPlaceholder('اختر رول تفاعلي لتحديد شروطه')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(filteredRoles.map((role) => ({
                    label: role.name.slice(0, 100),
                    value: role.id,
                    description: `تحديد شروط ${role.name}`.slice(0, 100)
                })));
            return interaction.update({ content: '**اختر الرول التفاعلي الذي تريد تعيين شروطه**', components: [new ActionRowBuilder().addComponents(roleMenu), ...getPersistentMenuRows(settings)], embeds: [] });
        }


        if (value === 'set_app_rules') {
            if (!app.enabled) return interaction.update({ content: '**يجب تفعيل نظام التقديم الجديد أولاً**', components: [getBackRow()], embeds: [] });
            const modal = new ModalBuilder().setCustomId('setactive_app_rules_modal').setTitle('قوانين التقديم (اختياري)');
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('rules_text')
                        .setLabel('اكتب القوانين (اتركه فارغًا للحذف)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setPlaceholder('مثال: 1- يمنع التقديم المتكرر خلال 24 ساعة | 2- احترام المسؤولين أثناء المراجعة')
                        .setValue((app.rulesText || '').slice(0, 4000))
                )
            );
            return interaction.showModal(modal);
        }

        if (value === 'show_settings') {
            const embed = new EmbedBuilder()
                .setTitle('الإعدادات الحالية')
                .setColor(colorManager.getColor ? colorManager.getColor() : '#00ff00')
                .addFields(
                    { name: 'المسؤولون', value: (settings.settings.approvers || []).map((id) => `<@&${id}>`).join('\n') || '**لا يوجد**', inline: false },
                    { name: 'الرولات التفاعلية', value: (settings.settings.interactiveRoles || []).map((id) => `<@&${id}>`).join('\n') || '**لا يوجد**', inline: false },
                    { name: 'رولات الاستثناء', value: (settings.settings.exceptions || []).map((entry) => `<@&${entry.roleId}>`).join('\n') || '**لا يوجد**', inline: false },
                    { name: 'نظام التقديم الجديد', value: app.enabled ? '**مفعل**' : '**معطل**', inline: true },
                    { name: 'روم الطلبات الجديد', value: app.requestsChannelId ? `<#${app.requestsChannelId}>` : '**غير محدد**', inline: true },
                    { name: 'روم المسؤولين', value: app.managersChannelId ? `<#${app.managersChannelId}>` : '**غير محدد**', inline: true },
                    { name: 'طريقة العرض', value: `**${app.displayType === 'menu' ? 'منيو' : 'أزرار'}**`, inline: true },
                    { name: 'الشروط', value: formatConditionsMap(app.roleConditions, interaction.guild), inline: false },
                    { name: 'قوانين التقديم', value: (app.rulesText || '').trim() || '**لا توجد قوانين**', inline: false }
                );
            return interaction.update({ embeds: [embed], components: [getBackRow()], content: null });
        }
    }

    if (customId === 'setactive_select_approvers') {
        settings.settings.approvers = interaction.values;
        saveSettings(settings);
        return interaction.update({ content: '**تم تحديث رولات المسؤولين بنجاح**', components: getPersistentMenuRows(settings), embeds: [] });
    }

    if (customId === 'setactive_select_interactive_roles') {
        const exceptionRoleIds = new Set(
            (settings.settings.exceptions || [])
                .map((entry) => entry?.roleId)
                .filter((roleId) => typeof roleId === 'string' && roleId.length > 0)
        );

        // لا يمكن أن يكون الرول تفاعلي ومستثنى بنفس الوقت
        const selectedSet = new Set(interaction.values.filter((roleId) => !exceptionRoleIds.has(roleId)));

        settings.settings.interactiveRoles = Array.from(selectedSet).sort((a, b) => {
            const roleA = interaction.guild.roles.cache.get(a);
            const roleB = interaction.guild.roles.cache.get(b);
            return (roleB?.position || 0) - (roleA?.position || 0);
        });
        saveSettings(settings);
        if (app.enabled && app.requestsChannelId) {
            await sendOrUpdateApplicationPanel(interaction.guild, settings).catch(() => {});
        }
        const removedOverlapCount = interaction.values.length - selectedSet.size;
        const overlapNotice = removedOverlapCount > 0 ? `\n**تم استبعاد ${removedOverlapCount} رول لأنه مستثنى (لا يمكن الجمع بين تفاعلي ومستثنى).**` : '';
        return interaction.update({ content: `**تم تحديث الرولات التفاعلية بنجاح**${overlapNotice}`, components: getPersistentMenuRows(settings), embeds: [] });
    }

    if (customId === 'setactive_select_exception_roles_new') {
        const selectedRoleIds = interaction.values;
        settings.settings.exceptions = selectedRoleIds.map((roleId) => ({ roleId, keywords: [] }));

        const exceptionSet = new Set(selectedRoleIds);
        settings.settings.interactiveRoles = (settings.settings.interactiveRoles || []).filter((roleId) => !exceptionSet.has(roleId));

        saveSettings(settings);
        if (app.requestsChannelId) {
            await sendOrUpdateApplicationPanel(interaction.guild, settings).catch(() => {});
        }
        return interaction.update({ content: '**تم تحديث رولات الاستثناء للنظام الجديد (بدون كلمات) مع إزالة أي تداخل من الرولات التفاعلية.**', components: getPersistentMenuRows(settings), embeds: [] });
    }

    if (customId === 'setactive_select_exception_role_old') {
        const roleId = interaction.values[0];
        const modal = new ModalBuilder().setCustomId(`setactive_exception_keywords_modal_${roleId}`).setTitle('كلمات رول الاستثناء');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('exception_keywords')
                    .setLabel('الكلمات المرتبطة (افصل بينها بـ ,)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setPlaceholder('مثال: شات, ادارة, دعم')
            )
        );
        return interaction.showModal(modal);
    }

    if (customId === 'setactive_select_app_requests_channel') {
        app.requestsChannelId = interaction.values[0];
        saveSettings(settings);
        await interaction.update({ content: `**تم تحديد روم الطلبات: <#${app.requestsChannelId}>**\n**الخطوة التالية: ارفع صورة بانل الطلبات الآن**`, components: getPersistentMenuRows(settings), embeds: [] });
        const imagePath = await awaitImageAndSave(interaction.channel, interaction.user.id, interaction.guild.id, 'request_panel');
        if (imagePath) {
            app.panelImagePath = imagePath;
            saveSettings(settings);
        }
        await sendOrUpdateApplicationPanel(interaction.guild, settings).catch(() => {});
        return;
    }

    if (customId === 'setactive_select_app_managers_channel') {
        app.managersChannelId = interaction.values[0];
        saveSettings(settings);
        await interaction.update({ content: `**تم تحديد روم المسؤولين: <#${app.managersChannelId}>**\n**الخطوة التالية: ارفع صورة خط روم المسؤولين الآن**`, components: getPersistentMenuRows(settings), embeds: [] });
        const imagePath = await awaitImageAndSave(interaction.channel, interaction.user.id, interaction.guild.id, 'managers_panel');
        if (imagePath) {
            app.managersImagePath = imagePath;
            saveSettings(settings);
            const managersChannel = interaction.guild.channels.cache.get(app.managersChannelId);
            if (managersChannel) {
                const embed = new EmbedBuilder().setTitle('تهيئة روم المسؤولين').setDescription('**تم حفظ صورة الخط الخاصة بطلبات الرولات التفاعلية**').setColor(colorManager.getColor ? colorManager.getColor() : '#0099ff');
                await managersChannel.send({ embeds: [embed], files: [new AttachmentBuilder(imagePath)] }).catch(() => {});
            }
        }
        return;
    }

    if (customId === 'setactive_select_display_type') {
        app.displayType = interaction.values[0] === 'menu' ? 'menu' : 'buttons';
        const modal = new ModalBuilder().setCustomId('setactive_display_emoji_modal').setTitle('إيموجي العرض');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('button_emoji').setLabel('إيموجي الأزرار (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setValue((app.defaultButtonEmoji || '').slice(0, 100))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('menu_emoji').setLabel('إيموجي المنيو (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setValue((app.defaultMenuEmoji || '').slice(0, 100))
            )
        );
        saveSettings(settings);
        return interaction.showModal(modal);
    }

    if (customId === 'setactive_pick_condition_role') {
        const roleId = interaction.values[0];
        const current = app.roleConditions?.[roleId] || {};
        const modal = new ModalBuilder().setCustomId(`setactive_role_cond_modal_${roleId}`).setTitle('شروط التقديم للرول');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('messages_required').setLabel('عدد الرسائل المطلوبة (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('مثال: 100').setValue(String(current.messagesRequired || ''))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('hours_required').setLabel('عدد ساعات الفويس المطلوبة (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('مثال: 20').setValue(String(current.voiceHoursRequired || ''))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('account_age_days').setLabel('عمر الحساب بالأيام (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('مثال: 30').setValue(String(current.accountAgeDays || '')))
        );
        return interaction.showModal(modal);
    }

    if (customId === 'setactive_back') {
        const embed = new EmbedBuilder()
            .setTitle('إعدادات الرولات التفاعلية')
            .setDescription('**اختر الإعداد المطلوب من القائمة**')
            .setColor(colorManager.getColor ? colorManager.getColor() : '#0099ff');
        return interaction.update({ embeds: [embed], components: [getMainMenuRow(settings)], content: null });
    }

    if (interaction.isModalSubmit() && customId === 'setactive_display_emoji_modal') {
        app.defaultButtonEmoji = interaction.fields.getTextInputValue('button_emoji').trim() || null;
        app.defaultMenuEmoji = interaction.fields.getTextInputValue('menu_emoji').trim() || null;
        saveSettings(settings);
        if (app.enabled && app.requestsChannelId) {
            await sendOrUpdateApplicationPanel(interaction.guild, settings).catch(() => {});
        }
        return interaction.reply({ content: '**تم تحديث طريقة العرض والإيموجي وإرسال/تحديث بانل الطلبات**', components: getPersistentMenuRows(settings), ephemeral: true });
    }


    if (interaction.isModalSubmit() && customId === 'setactive_app_rules_modal') {
        const rulesText = interaction.fields.getTextInputValue('rules_text').trim();
        app.rulesText = rulesText;
        saveSettings(settings);
        if (app.enabled && app.requestsChannelId) {
            await sendOrUpdateApplicationPanel(interaction.guild, settings).catch(() => {});
        }
        return interaction.reply({
            content: rulesText ? '**تم حفظ قوانين التقديم وتحديث رسالة ترتيب الرولات**' : '**تم حذف قوانين التقديم وتحديث رسالة ترتيب الرولات**',
            components: getPersistentMenuRows(settings),
            ephemeral: true
        });
    }

    if (interaction.isModalSubmit() && customId.startsWith('setactive_exception_keywords_modal_')) {
        const roleId = customId.replace('setactive_exception_keywords_modal_', '');
        const raw = interaction.fields.getTextInputValue('exception_keywords') || '';
        const keywords = raw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (!keywords.length) {
            return interaction.reply({ content: '**يجب كتابة كلمة واحدة على الأقل.**', ephemeral: true });
        }

        settings.settings.exceptions = [{ roleId, keywords: [...new Set(keywords)] }];
        settings.settings.interactiveRoles = (settings.settings.interactiveRoles || []).filter((id) => id !== roleId);
        saveSettings(settings);
        return interaction.reply({ content: '**تم حفظ رول الاستثناء والكلمات المرتبطة له (النظام القديم) وإزالة أي تداخل مع الرولات التفاعلية.**', ephemeral: true });
    }

    if (interaction.isModalSubmit() && customId.startsWith('setactive_role_cond_modal_')) {
        const roleId = customId.replace('setactive_role_cond_modal_', '');
        const messagesRequired = Math.max(0, parseInt(interaction.fields.getTextInputValue('messages_required'), 10) || 0);
        const hoursRequired = Math.max(0, parseInt(interaction.fields.getTextInputValue('hours_required'), 10) || 0);
        const accountAgeDays = Math.max(0, parseInt(interaction.fields.getTextInputValue('account_age_days') || '0', 10) || 0);

        app.roleConditions[roleId] = {
            messagesRequired,
            voiceHoursRequired: hoursRequired,
            accountAgeDays
        };
        saveSettings(settings);
        return interaction.reply({ content: `**تم حفظ شروط الرول <@&${roleId}>**\nالرسائل: **${messagesRequired}**\nالساعات: **${hoursRequired}**\nعمر الحساب: **${accountAgeDays > 0 ? `${accountAgeDays} يوم` : 'غير مطلوب'}**`, components: getPersistentMenuRows(settings), ephemeral: true });
    }
}

module.exports.handleSetActiveInteraction = handleSetActiveInteraction;
