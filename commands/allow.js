const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const allowStore = require('../utils/allowStore');

const name = 'allow';
const aliases = ['السماح'];

function getLabel(guild, type, id) {
    if (type === 'roles') {
        const role = guild.roles.cache.get(id);
        return role ? `<@&${id}>` : `رول غير موجود (${id})`;
    }
    return guild.members.cache.has(id) ? `<@${id}>` : `عضو غير موجود (${id})`;
}

function buildEmbed(guild, state) {
    const config = allowStore.loadAllowConfig();
    const target = config[state.target];
    const roleText = target.roles.length
        ? target.roles.slice(0, 15).map(id => getLabel(guild, 'roles', id)).join('\n')
        : 'لا توجد رولات مضافة';
    const userText = target.users.length
        ? target.users.slice(0, 15).map(id => getLabel(guild, 'users', id)).join('\n')
        : 'لا يوجد أشخاص مضافون';
    const roleMore = target.roles.length > 15 ? `\n... و${target.roles.length - 15} أخرى` : '';
    const userMore = target.users.length > 15 ? `\n... و${target.users.length - 15} أخرى` : '';

    return colorManager.createEmbed()
        .setTitle(`Allow • ${state.target === 'rooms' ? 'Rooms' : 'Check'}`)
        .setDescription([
            `**النظام :** ${state.target === 'rooms' ? 'rooms' : 'check'}`,
            `**العملية :** ${state.action === 'add' ? 'إضافة' : 'إزالة'}`,
            '',
            `**الرولات المسموحة (${target.roles.length}) :**\n${roleText}${roleMore}`,
            '',
            `**الأشخاص المسموحون (${target.users.length}) :**\n${userText}${userMore}`
        ].join('\n'))
        .setColor(colorManager.getColor ? colorManager.getColor() : '#5865F2')
        .setFooter({ text: 'اختر النظام والعملية ثم استخدم منيو البحث المناسب' });
}

function buildComponents(userId, state) {
    const targetMenu = new StringSelectMenuBuilder()
        .setCustomId(`allow_target_${userId}`)
        .setPlaceholder('Select command: Rooms or Check')
        .addOptions([
            { label: 'Rooms', value: 'rooms', description: 'إدارة مستخدمي أمر rooms', default: state.target === 'rooms' },
            { label: 'Check', value: 'check', description: 'إدارة مستخدمي أمر check', default: state.target === 'check' }
        ]);
    const actionMenu = new StringSelectMenuBuilder()
        .setCustomId(`allow_action_${userId}`)
        .setPlaceholder('Select action: Add or Remove')
        .addOptions([
            { label: 'Add', value: 'add', description: 'إضافة رول أو شخص', default: state.action === 'add' },
            { label: 'Remove', value: 'remove', description: 'إزالة رول أو شخص', default: state.action === 'remove' }
        ]);
    const roleMenu = new RoleSelectMenuBuilder()
        .setCustomId(`allow_role_${userId}`)
        .setPlaceholder('Search and select a role');
    const userMenu = new UserSelectMenuBuilder()
        .setCustomId(`allow_user_${userId}`)
        .setPlaceholder('Search and select a user');
    const closeButton = new ButtonBuilder()
        .setCustomId(`allow_close_${userId}`)
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger);

    return [
        new ActionRowBuilder().addComponents(targetMenu),
        new ActionRowBuilder().addComponents(actionMenu),
        new ActionRowBuilder().addComponents(roleMenu),
        new ActionRowBuilder().addComponents(userMenu),
        new ActionRowBuilder().addComponents(closeButton)
    ];
}

function resultText(result, type, action) {
    const subject = type === 'roles' ? 'الرول' : 'الشخص';
    if (result.reason === 'exists') return `⚠️ هذا ${subject} مسموح له بالفعل.`;
    if (result.reason === 'missing') return `⚠️ هذا ${subject} غير موجود في القائمة.`;
    if (!result.ok) return '❌ تعذر حفظ التعديل في ملف الصلاحيات.';
    return `✅ تم ${action === 'add' ? 'إضافة' : 'إزالة'} ${subject} بنجاح.`;
}

async function execute(message, args, { BOT_OWNERS = [] }) {
    if (!message.guild || !BOT_OWNERS.map(String).includes(String(message.author.id))) {
        return message.react('❌').catch(() => {});
    }

    const state = { target: 'rooms', action: 'add' };
    const sentMessage = await message.channel.send({
        embeds: [buildEmbed(message.guild, state)],
        components: buildComponents(message.author.id, state)
    });
    const filter = interaction => interaction.user.id === message.author.id && interaction.message.id === sentMessage.id;
    const collector = sentMessage.createMessageComponentCollector({ filter, time: 10 * 60 * 1000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.isStringSelectMenu() && interaction.customId === `allow_target_${message.author.id}`) {
                state.target = interaction.values[0] === 'check' ? 'check' : 'rooms';
                return interaction.update({ embeds: [buildEmbed(message.guild, state)], components: buildComponents(message.author.id, state) });
            }
            if (interaction.isStringSelectMenu() && interaction.customId === `allow_action_${message.author.id}`) {
                state.action = interaction.values[0] === 'remove' ? 'remove' : 'add';
                return interaction.update({ embeds: [buildEmbed(message.guild, state)], components: buildComponents(message.author.id, state) });
            }
            if (interaction.isRoleSelectMenu() && interaction.customId === `allow_role_${message.author.id}`) {
                const roleId = interaction.values[0];
                const result = allowStore.updateAllow(state.target, 'roles', roleId, state.action);
                return interaction.update({
                    content: resultText(result, 'roles', state.action),
                    embeds: [buildEmbed(message.guild, state)],
                    components: buildComponents(message.author.id, state)
                });
            }
            if (interaction.isUserSelectMenu() && interaction.customId === `allow_user_${message.author.id}`) {
                const userId = interaction.values[0];
                const result = allowStore.updateAllow(state.target, 'users', userId, state.action);
                return interaction.update({
                    content: resultText(result, 'users', state.action),
                    embeds: [buildEmbed(message.guild, state)],
                    components: buildComponents(message.author.id, state)
                });
            }
            if (interaction.isButton() && interaction.customId === `allow_close_${message.author.id}`) {
                collector.stop('closed');
                return interaction.message.delete().catch(() => {});
            }
        } catch (error) {
            console.error('❌ خطأ في لوحة Allow:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ حدث خطأ أثناء تحديث صلاحيات Allow.', ephemeral: true }).catch(() => {});
            }
        }
    });

    collector.on('end', () => {
        sentMessage.edit({ components: [] }).catch(() => {});
    });
}

module.exports = { name, aliases, description: 'إدارة الأشخاص والرولات المسموح لهم باستخدام rooms وcheck', execute };
