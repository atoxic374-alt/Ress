const { ActionRowBuilder, RoleSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager');
const fs = require('fs');
const path = require('path');

const pendingRoleMenus = new Map();
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

async function parseTargetMember(message, args = []) {
  const mention = message.mentions.members.first();
  if (mention) return mention;
  const raw = String(args[0] || '').trim();
  if (/^\d{15,22}$/.test(raw)) {
    return message.guild.members.cache.get(raw) || await message.guild.members.fetch(raw).catch(() => null);
  }
  return null;
}

function parseRolesFromText(guild, text = '') {
  const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
  const roles = [];
  for (const part of parts) {
    const mentionMatch = part.match(/^<@&(\d{15,22})>$/);
    const id = mentionMatch ? mentionMatch[1] : (/^\d{15,22}$/.test(part) ? part : null);
    let role = id ? guild.roles.cache.get(id) : null;
    if (!role) {
      const needle = part.toLowerCase();
      role = guild.roles.cache.find((r) => r.name.toLowerCase() === needle)
        || guild.roles.cache.find((r) => r.name.toLowerCase().includes(needle));
    }
    if (role && !roles.some((x) => x.id === role.id)) roles.push(role);
  }
  return roles;
}

function canManageRole(actorMember, botMember, targetRole) {
  if (!targetRole) return false;
  if (targetRole.managed) return false;
  if (targetRole.position >= botMember.roles.highest.position) return false;
  if (actorMember.guild.ownerId !== actorMember.id && targetRole.position >= actorMember.roles.highest.position) return false;
  return true;
}

function loadAdminRoles() {
  try {
    if (!fs.existsSync(adminRolesPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(adminRolesPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasAdminRolesAccess(member) {
  if (!member) return false;
  const adminRoles = loadAdminRoles();
  if (!adminRoles.length) return false;
  return member.roles.cache.some((role) => adminRoles.includes(role.id));
}

function buildToggleSummary({ targetMember, added, removed }) {
  const lines = [`**العضو :** <@${targetMember.id}>`];
  if (added.length > 0) {
    lines.push(`**${added.length === 1 ? 'الرول المضاف' : 'الرولات المضافة'} :** ${added.map((r) => `<@&${r.id}>`).join(' ، ')}`);
  }
  if (removed.length > 0) {
    lines.push(`**${removed.length === 1 ? 'الرول المزال' : 'الرولات المزالة'} :** ${removed.map((r) => `<@&${r.id}>`).join(' ، ')}`);
  }
  if (added.length === 0 && removed.length === 0) {
    lines.push('**لا يوجد تغيير.**');
  }
  return lines.join('\n');
}

async function grantRoles({ message, actorMember, targetMember, roles }) {
  const botMember = message.guild.members.me;
  const added = [];
  const removed = [];

  for (const role of roles) {
    if (!canManageRole(actorMember, botMember, role)) {
      continue;
    }

    try {
      if (targetMember.roles.cache.has(role.id)) {
        await targetMember.roles.remove(role, `Role toggle remove by ${message.author.tag}`);
        removed.push(role);
      } else {
        await targetMember.roles.add(role, `Role toggle add by ${message.author.tag}`);
        added.push(role);
      }
    } catch {}
  }

  const embed = colorManager.createEmbed()
    .setTitle('Role Command')
    .setDescription(buildToggleSummary({ targetMember, added, removed }))
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

module.exports = {
  name: 'role',
  aliases: ['رول'],

  async execute(message, args) {
    if (!hasAdminRolesAccess(message.member)) {
      await message.react('❌').catch(() => {});
      return;
    }

    if (!message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      await message.reply('**❌ البوت يحتاج صلاحية Manage Roles.**');
      return;
    }

    const targetMember = await parseTargetMember(message, args);
    if (!targetMember) {
      await message.reply('**❌ لازم تحدد عضو بالمنشن أو الآيدي أولاً.**');
      return;
    }

    if (targetMember.id === message.guild.ownerId) {
      await message.reply('**❌ لا يمكن تعديل رولات مالك السيرفر.**');
      return;
    }

    const rest = args.slice(1).join(' ').trim();
    if (!rest) {
      const menuId = `role_pick_${message.guild.id}_${message.author.id}_${Date.now()}`;
      pendingRoleMenus.set(menuId, {
        guildId: message.guild.id,
        actorId: message.author.id,
        targetId: targetMember.id,
        expiresAt: Date.now() + 2 * 60 * 1000
      });

      const row = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(menuId)
          .setPlaceholder('ابحث واختر الرولات')
          .setMinValues(1)
          .setMaxValues(5)
      );

      await message.reply({ content: `**اختر الرولات لإعطائها إلى** <@${targetMember.id}>`, components: [row] });
      return;
    }

    const roles = parseRolesFromText(message.guild, rest);
    if (roles.length === 0) {
      await message.reply('**❌ لم يتم العثور على أي رول صالح.**');
      return;
    }

    await grantRoles({ message, actorMember: message.member, targetMember, roles });
  },

  registerInteractionHandler(client) {
    if (client.__roleCommandHandlerRegistered) return;
    client.__roleCommandHandlerRegistered = true;

    client.on('interactionCreate', async (interaction) => {
      try {
        if (!interaction.isRoleSelectMenu()) return;
        if (!String(interaction.customId || '').startsWith('role_pick_')) return;

        const data = pendingRoleMenus.get(interaction.customId);
        if (!data || data.guildId !== interaction.guildId || Date.now() > data.expiresAt) {
          pendingRoleMenus.delete(interaction.customId);
          await interaction.reply({ content: '**❌ انتهت صلاحية القائمة.**', ephemeral: true });
          return;
        }

        if (interaction.user.id !== data.actorId) {
          await interaction.reply({ content: '**❌ فقط منفذ الأمر يقدر يستخدم هذه القائمة.**', ephemeral: true });
          return;
        }

        const actor = await interaction.guild.members.fetch(data.actorId).catch(() => null);
        const target = await interaction.guild.members.fetch(data.targetId).catch(() => null);
        const botMember = interaction.guild.members.me;
        if (!actor || !target || !botMember) {
          await interaction.reply({ content: '**❌ تعذر إكمال العملية.**', ephemeral: true });
          return;
        }
        if (!hasAdminRolesAccess(actor)) {
          await interaction.reply({ content: '**❌ لا تملك صلاحية Adminroles الآن.**', ephemeral: true });
          return;
        }

        const added = [];
        const removed = [];

        for (const roleId of interaction.values) {
          const role = interaction.guild.roles.cache.get(roleId);
          if (!role || !canManageRole(actor, botMember, role)) {
            continue;
          }

          try {
            if (target.roles.cache.has(role.id)) {
              await target.roles.remove(role, `Role toggle remove by ${interaction.user.tag}`);
              removed.push(role);
            } else {
              await target.roles.add(role, `Role toggle add by ${interaction.user.tag}`);
              added.push(role);
            }
          } catch {}
        }

        pendingRoleMenus.delete(interaction.customId);
        await interaction.update({
          content: buildToggleSummary({ targetMember: target, added, removed }),
          components: []
        });
      } catch (error) {
        console.error('role command interaction error:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '**❌ حدث خطأ أثناء تنفيذ العملية.**', ephemeral: true }).catch(() => {});
        }
      }
    });
  }
};
