const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const name = 'ticket';
const aliases = ['تكت'];
const dataPath = path.join(__dirname, '..', 'data', 'ticketConfig.json');

let handlersRegistered = false;
const pendingRequests = new Map(); // reqId -> { guildId, userId, reasonKey, sourceChannelId }

function loadStore() {
  try {
    if (!fs.existsSync(dataPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(dataPath, JSON.stringify(store, null, 2), 'utf8');
}

function baseConfig() {
  return {
    ticketNameMode: 'counter',
    ticketNamePrefix: 'ticket',
    openCategoryId: null,
    closedCategoryId: null,
    responsibleRoleIds: [],
    adminRoleIds: [],
    useGlobalAdminRoles: true,
    adminClaimLimit: 1,
    memberOpenLimit: 1,
    autoCreateOnRequest: true,
    hideOnClaim: false,
    claimFromDedicatedChannel: false,
    claimChannelId: null,
    claimChannelSeparator: '────────────────',
    keepClosedTickets: false,
    messages: {
      acceptance: '',
      beforeImage: '',
      ticketImage: '',
      afterImage: ''
    },
    reasons: {},
    displayMode: 'buttons',
    buttonRows: 2,
    counter: 1
  };
}

function getGuildData(guildId) {
  const store = loadStore();
  const existing = store[guildId] || {};
  const config = { ...baseConfig(), ...existing.config };
  config.messages = { ...baseConfig().messages, ...(existing.config?.messages || {}) };
  config.reasons = existing.config?.reasons || {};
  const tickets = existing.tickets || {};
  return { store, guild: { config, tickets } };
}

function setGuildData(guildId, config, tickets) {
  const store = loadStore();
  store[guildId] = { config, tickets };
  saveStore(store);
}

function normalizeId(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(?:<@&?|<#)?(\d{16,20})>?$/);
  return match ? match[1] : null;
}

function createMainEmbed(config, guildName) {
  return new EmbedBuilder()
    .setTitle(`**إعدادات التكت : ${guildName}**`)
    .setDescription([
      '**اكتب رقم الخيار من 1 الى 14 أو اكتب خروج.**',
      '**1** - **اسم شات التكت**',
      '**2** - **الكاتوقري عند فتح التكت**',
      '**3** - **تحديد المسؤولين**',
      '**4** - **تحديد رولات الادمن**',
      '**5** - **كولداون الاداري (حد الاستلام المفتوح)**',
      '**6** - **كولداون العضو (حد التكت المفتوح)**',
      '**7** - **انشاء التكت قبل الاستلام (toggle)**',
      '**8** - **اخفاء التكت عند الاستلام (toggle)**',
      '**9** - **الاستلام من شات مخصص (toggle + اعدادات)**',
      '**10** - **اقفال التكت والاحتفاظ به (toggle)**',
      '**11** - **اعدادات الرسائل**',
      '**12** - **تعيين الاسباب (1 - 25)**',
      '**13** - **طريقة العرض (buttons / menu)**',
      '**14** - **ارسال بانل التكت**'
    ].join('\n'))
    .addFields(
      { name: '**الاسم**', value: `**${config.ticketNamePrefix}** - **${config.ticketNameMode}**`, inline: true },
      { name: '**طريقة العرض**', value: `**${config.displayMode}**`, inline: true },
      { name: '**الاسباب**', value: `**${Object.keys(config.reasons || {}).length}**`, inline: true }
    );
}

function getAdminRoles(config, guild) {
  if (!config.useGlobalAdminRoles) return config.adminRoleIds || [];
  try {
    const fromFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'adminRoles.json'), 'utf8'));
    return Array.isArray(fromFile) ? fromFile : [];
  } catch {
    return [];
  }
}

function countOpenMemberTickets(tickets, userId) {
  return Object.values(tickets).filter(t => t.status === 'open' && t.memberId === userId).length;
}

function countClaimedByAdmin(tickets, adminId) {
  return Object.values(tickets).filter(t => t.status === 'open' && t.claimedBy === adminId).length;
}

async function createTicketChannel({ guild, member, config, reasonKey, tickets }) {
  const reason = config.reasons?.[reasonKey] || {};
  const prefix = (reason.ticketName || config.ticketNamePrefix || 'ticket').toLowerCase().replace(/\s+/g, '-');
  const suffix = config.ticketNameMode === 'user' ? member.user.username.toLowerCase().replace(/\s+/g, '-') : String(config.counter || 1);
  const channelName = `${prefix}-${suffix}`.slice(0, 90);
  const categoryId = reason.categoryId || config.openCategoryId || null;

  const adminRoles = getAdminRoles(config, guild);
  const allowedStaffRoles = [...new Set([...(config.responsibleRoleIds || []), ...adminRoles])];

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];

  for (const roleId of allowedStaffRoles) {
    permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites
  });

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim_${guild.id}_${channel.id}`).setLabel('استلام').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_close_${guild.id}_${channel.id}`).setLabel('اقفال').setStyle(ButtonStyle.Danger)
  );

  if (reason.beforeImage || config.messages.beforeImage) {
    await channel.send({ content: reason.beforeImage || config.messages.beforeImage });
  }
  if (reason.openImage || config.messages.ticketImage) {
    await channel.send({ files: [reason.openImage || config.messages.ticketImage] }).catch(() => {});
  }
  if (reason.afterImage || config.messages.afterImage) {
    await channel.send({ content: reason.afterImage || config.messages.afterImage });
  }

  await channel.send({
    content: `**التكت : تم الانشاء**\n**العضو :** <@${member.id}>`,
    components: [controls]
  });

  if (config.ticketNameMode !== 'user') config.counter = (config.counter || 1) + 1;

  tickets[channel.id] = {
    channelId: channel.id,
    memberId: member.id,
    reasonKey,
    claimedBy: null,
    status: 'open',
    createdAt: Date.now()
  };

  return channel;
}

async function applyHideOnClaim(channel, guild, config, claimerId, memberId) {
  const adminRoles = getAdminRoles(config, guild);
  for (const roleId of adminRoles) {
    await channel.permissionOverwrites.edit(roleId, { ViewChannel: false }).catch(() => {});
  }
  for (const roleId of (config.responsibleRoleIds || [])) {
    await channel.permissionOverwrites.edit(roleId, { ViewChannel: true }).catch(() => {});
  }
  await channel.permissionOverwrites.edit(claimerId, { ViewChannel: true, SendMessages: true }).catch(() => {});
  await channel.permissionOverwrites.edit(memberId, { ViewChannel: true, SendMessages: true }).catch(() => {});
}

async function handleOpenRequest(interaction, guildId, reasonKey) {
  const guild = interaction.guild;
  const { guild: g } = getGuildData(guildId);
  const { config, tickets } = g;

  const openCount = countOpenMemberTickets(tickets, interaction.user.id);
  if (openCount >= (config.memberOpenLimit || 1)) {
    await interaction.reply({ content: `**الحد : وصلت لاقصى تكت مفتوح (${config.memberOpenLimit}).**`, ephemeral: true });
    return;
  }

  if (config.autoCreateOnRequest) {
    const channel = await createTicketChannel({ guild, member: interaction.member, config, reasonKey, tickets });
    setGuildData(guildId, config, tickets);
    await interaction.reply({ content: `**تم انشاء التكت :** <#${channel.id}>`, ephemeral: true });
    return;
  }

  const reqId = `${guildId}_${interaction.user.id}_${Date.now()}`;
  pendingRequests.set(reqId, { guildId, userId: interaction.user.id, reasonKey, sourceChannelId: interaction.channelId });

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: '**فشل : شات الاستلام غير صالح.**', ephemeral: true });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimreq_${reqId}`).setStyle(ButtonStyle.Primary).setLabel('استلام التكت')
  );

  if (config.messages.acceptance) await targetChannel.send({ content: config.messages.acceptance });
  if (config.claimFromDedicatedChannel && config.claimChannelSeparator) await targetChannel.send({ content: config.claimChannelSeparator });

  await targetChannel.send({
    content: `**طلب تكت :** <@${interaction.user.id}>\n**السبب :** ${config.reasons?.[reasonKey]?.name || `سبب ${reasonKey}`}`,
    components: [row]
  });

  await interaction.reply({ content: '**تم ارسال طلبك لشات الاستلام.**', ephemeral: true });
}

async function handleClaimInTicket(interaction, guildId, channelId) {
  const { guild: g } = getGuildData(guildId);
  const { config, tickets } = g;
  const ticket = tickets[channelId];
  if (!ticket || ticket.status !== 'open') {
    await interaction.reply({ content: '**هذا التكت غير متاح.**', ephemeral: true });
    return;
  }

  const adminRoles = getAdminRoles(config, interaction.guild);
  const hasRole = interaction.member.roles.cache.some(r => adminRoles.includes(r.id) || (config.responsibleRoleIds || []).includes(r.id));
  if (!hasRole && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاستلام.**', ephemeral: true });
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.reply({ content: `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, ephemeral: true });
    return;
  }

  ticket.claimedBy = interaction.user.id;
  if (config.hideOnClaim) {
    const channel = interaction.channel;
    await applyHideOnClaim(channel, interaction.guild, config, interaction.user.id, ticket.memberId);
  }
  setGuildData(guildId, config, tickets);
  await interaction.reply({ content: `**تم الاستلام :** <@${interaction.user.id}>` });
}

async function handleClaimFromRequest(interaction, reqId) {
  const req = pendingRequests.get(reqId);
  if (!req) {
    await interaction.reply({ content: '**انتهى الطلب.**', ephemeral: true });
    return;
  }

  const { guild: g } = getGuildData(req.guildId);
  const { config, tickets } = g;
  const adminRoles = getAdminRoles(config, interaction.guild);
  const hasRole = interaction.member.roles.cache.some(r => adminRoles.includes(r.id) || (config.responsibleRoleIds || []).includes(r.id));
  if (!hasRole && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاستلام.**', ephemeral: true });
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.reply({ content: `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(req.userId).catch(() => null);
  if (!member) {
    await interaction.reply({ content: '**لا يمكن العثور على العضو.**', ephemeral: true });
    return;
  }

  const channel = await createTicketChannel({ guild: interaction.guild, member, config, reasonKey: req.reasonKey, tickets });
  tickets[channel.id].claimedBy = interaction.user.id;
  if (config.hideOnClaim) await applyHideOnClaim(channel, interaction.guild, config, interaction.user.id, member.id);

  setGuildData(req.guildId, config, tickets);
  pendingRequests.delete(reqId);
  await interaction.reply({ content: `**تم الاستلام والانشاء :** <#${channel.id}>` });
}

async function handleClose(interaction, guildId, channelId) {
  const { guild: g } = getGuildData(guildId);
  const { config, tickets } = g;
  const ticket = tickets[channelId];
  if (!ticket) {
    await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
    return;
  }

  const canClose = interaction.user.id === ticket.memberId || interaction.user.id === ticket.claimedBy || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (!canClose) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاقفال.**', ephemeral: true });
    return;
  }

  ticket.status = 'closed';
  setGuildData(guildId, config, tickets);

  if (!config.keepClosedTickets) {
    delete tickets[channelId];
    setGuildData(guildId, config, tickets);
    await interaction.reply({ content: '**سيتم حذف التكت خلال 3 ثواني.**' });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    return;
  }

  const closePrefix = `closed-${config.ticketNamePrefix || 'ticket'}`;
  await interaction.channel.setName(`${closePrefix}-${channelId.slice(-4)}`).catch(() => {});
  if (config.closedCategoryId) await interaction.channel.setParent(config.closedCategoryId).catch(() => {});
  await interaction.reply({ content: '**تم اقفال التكت والاحتفاظ به.**' });
}

function createReasonComponents(config, guildId) {
  const reasons = Object.entries(config.reasons || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 25);
  if (config.displayMode === 'menu') {
    const options = reasons.length
      ? reasons.map(([k, v]) => ({ label: (v.name || `سبب ${k}`).slice(0, 100), value: `reason_${k}`, emoji: v.emoji || undefined }))
      : [{ label: 'فتح تكت عام', value: 'reason_0', emoji: '🎫' }];
    return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticket_open_menu_${guildId}`).setPlaceholder('اختر السبب').addOptions(options))];
  }

  const maxButtons = Math.max(1, Math.min(25, (config.buttonRows || 2) * 5));
  const entries = (reasons.length ? reasons : [['0', { name: 'فتح تكت', emoji: '🎫' }]]).slice(0, maxButtons);
  const buttons = entries.map(([k, v]) => new ButtonBuilder()
    .setCustomId(`ticket_open_btn_${guildId}_${k}`)
    .setLabel((v.name || `سبب ${k}`).slice(0, 80))
    .setStyle(ButtonStyle.Primary)
    .setEmoji(v.emoji || '🎫'));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function execute(message, args, { BOT_OWNERS = [], ADMIN_ROLES = [] }) {
  const member = await message.guild.members.fetch(message.author.id);
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  const hasAdminRole = member.roles.cache.some(r => ADMIN_ROLES.includes(r.id));
  if (!isOwner && !hasAdminRole && !member.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.react('❌');
    return;
  }

  const { guild: g } = getGuildData(message.guild.id);
  const { config, tickets } = g;

  const ask = async (prompt, timeout = 180000) => {
    await message.channel.send(prompt);
    const collected = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: timeout });
    const first = collected.first();
    return first ? first.content.trim() : null;
  };

  while (true) {
    await message.channel.send({ embeds: [createMainEmbed(config, message.guild.name)] });
    const choice = await ask('**اختر : رقم من 1 الى 14**');
    if (!choice || ['exit', 'خروج', 'انهاء'].includes(choice.toLowerCase())) break;

    if (choice === '1') {
      const mode = await ask('**اكتب : counter او user (او 0 لاعادة التعيين)**');
      if (mode === '0') { config.ticketNameMode = 'counter'; config.ticketNamePrefix = 'ticket'; }
      else if (['counter', 'user'].includes((mode || '').toLowerCase())) {
        config.ticketNameMode = mode.toLowerCase();
        const prefix = await ask('**اكتب : بادئة اسم التكت**');
        if (prefix && prefix !== '0') config.ticketNamePrefix = prefix.replace(/\s+/g, '-').toLowerCase();
      }
    } else if (choice === '2') {
      const v = await ask('**ارسل : منشن/ايدي الكاتوقري (0 لاعادة التعيين)**');
      config.openCategoryId = v === '0' ? null : normalizeId(v);
    } else if (choice === '3') {
      const v = await ask('**ارسل : رولات المسؤولين (منشن/ايدي) او file او 0**');
      if (v === '0') config.responsibleRoleIds = [];
      else if ((v || '').toLowerCase() === 'file') {
        try {
          const resp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'responsibilities.json'), 'utf8'));
          const set = new Set();
          for (const item of Object.values(resp || {})) for (const role of (item.roles || [])) set.add(role);
          config.responsibleRoleIds = [...set];
        } catch { await message.channel.send('**فشل : ملف المسؤوليات غير متاح.**'); }
      } else {
        config.responsibleRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean);
      }
    } else if (choice === '4') {
      const v = await ask('**ارسل : رولات الادمن (منشن/ايدي) او 0 لاستخدام الادمن رولز العامة**');
      if (v === '0') { config.useGlobalAdminRoles = true; config.adminRoleIds = []; }
      else { config.useGlobalAdminRoles = false; config.adminRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean); }
    } else if (choice === '5') {
      const n = Number(await ask('**اكتب : حد استلام الاداري المفتوح**'));
      if (Number.isFinite(n) && n > 0) config.adminClaimLimit = n;
    } else if (choice === '6') {
      const n = Number(await ask('**اكتب : حد فتح العضو المفتوح**'));
      if (Number.isFinite(n) && n > 0) config.memberOpenLimit = n;
    } else if (choice === '7') {
      config.autoCreateOnRequest = !config.autoCreateOnRequest;
      await message.channel.send(`**الحالة : ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}**`);
    } else if (choice === '8') {
      config.hideOnClaim = !config.hideOnClaim;
      await message.channel.send(`**الحالة : ${config.hideOnClaim ? 'مفعل' : 'مقفل'}**`);
    } else if (choice === '9') {
      config.claimFromDedicatedChannel = !config.claimFromDedicatedChannel;
      if (config.claimFromDedicatedChannel) {
        config.claimChannelId = normalizeId(await ask('**ارسل : منشن/ايدي شات الاستلام**'));
        const sep = await ask('**ارسل : فاصلة شات الاستلام (0 للتفريغ)**');
        config.claimChannelSeparator = sep === '0' ? '' : (sep || config.claimChannelSeparator);
      }
    } else if (choice === '10') {
      config.keepClosedTickets = !config.keepClosedTickets;
      if (config.keepClosedTickets) {
        const v = await ask('**ارسل : كاتوقري المقفلة (0 للبقاء بنفس المكان)**');
        config.closedCategoryId = v === '0' ? null : normalizeId(v);
      }
    } else if (choice === '11') {
      while (true) {
        await message.channel.send('**الرسائل : 1 قبول - 2 قبل الصورة - 3 صورة - 4 بعد الصورة - 5 انهاء**');
        const c = await ask('**اختر :**');
        if (!c || c === '5' || c.toLowerCase() === 'انهاء') break;
        if (c === '1') { const v = await ask('**رسالة القبول : (0 لاعادة التعيين)**'); config.messages.acceptance = v === '0' ? '' : (v || ''); }
        if (c === '2') { const v = await ask('**قبل الصورة : (0 لاعادة التعيين)**'); config.messages.beforeImage = v === '0' ? '' : (v || ''); }
        if (c === '3') { const v = await ask('**رابط الصورة : (0 لاعادة التعيين)**'); config.messages.ticketImage = v === '0' ? '' : (v || ''); }
        if (c === '4') { const v = await ask('**بعد الصورة : (0 لاعادة التعيين)**'); config.messages.afterImage = v === '0' ? '' : (v || ''); }
      }
    } else if (choice === '12') {
      const idx = Number(await ask('**اختر : رقم السبب من 1 الى 25**'));
      if (Number.isFinite(idx) && idx >= 1 && idx <= 25) {
        const key = String(idx);
        const reason = { name: `سبب ${idx}`, ticketName: '', openImage: '', emoji: '🎫', categoryId: null, claimImage: '', beforeImage: '', afterImage: '', ...(config.reasons[key] || {}) };
        while (true) {
          await message.channel.send('**السبب : 1 الاسم - 2 اسم التكت - 3 صورة فتح - 4 ايموجي - 5 كاتوقري - 6 صورة استلام - 7 قبل/بعد - 8 انهاء**');
          const c = await ask('**اختر :**');
          if (!c || c === '8' || c.toLowerCase() === 'انهاء') break;
          if (c === '1') { const v = await ask('**اسم السبب : (0 لاعادة التعيين)**'); reason.name = v === '0' ? `سبب ${idx}` : (v || reason.name); }
          if (c === '2') { const v = await ask('**اسم التكت : (0 لاعادة التعيين)**'); reason.ticketName = v === '0' ? '' : (v || reason.ticketName); }
          if (c === '3') { const v = await ask('**صورة الفتح : (0 لاعادة التعيين)**'); reason.openImage = v === '0' ? '' : (v || reason.openImage); }
          if (c === '4') { const v = await ask('**ايموجي : (0 لاعادة التعيين)**'); reason.emoji = v === '0' ? '🎫' : (v || reason.emoji); }
          if (c === '5') { const v = await ask('**كاتوقري : (0 لاعادة التعيين)**'); reason.categoryId = v === '0' ? null : normalizeId(v); }
          if (c === '6') { const v = await ask('**صورة الاستلام : (0 لاعادة التعيين)**'); reason.claimImage = v === '0' ? '' : (v || reason.claimImage); }
          if (c === '7') { const b = await ask('**قبل الصورة : (0 لاعادة التعيين)**'); const a = await ask('**بعد الصورة : (0 لاعادة التعيين)**'); reason.beforeImage = b === '0' ? '' : (b || reason.beforeImage); reason.afterImage = a === '0' ? '' : (a || reason.afterImage); }
        }
        config.reasons[key] = reason;
      }
    } else if (choice === '13') {
      const mode = await ask('**اكتب : buttons او menu**');
      if (['buttons', 'menu'].includes((mode || '').toLowerCase())) {
        config.displayMode = mode.toLowerCase();
        if (config.displayMode === 'buttons') {
          const rows = Number(await ask('**عدد الصفوف : من 1 الى 5**'));
          if (Number.isFinite(rows) && rows >= 1 && rows <= 5) config.buttonRows = rows;
        }
      }
    } else if (choice === '14') {
      const panelChannel = await message.guild.channels.fetch(normalizeId(await ask('**ارسل : الشات (منشن/ايدي)**'))).catch(() => null);
      if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
        await message.channel.send('**فشل : شات غير صالح.**');
      } else {
        const mode = (await ask('**طريقة الارسال : text / image / both**')) || 'both';
        const text = mode === 'image' ? '' : await ask('**النص : (0 لتخطي)**');
        const image = mode === 'text' ? '' : await ask('**الصورة : رابط مباشر (0 لتخطي)**');

        await panelChannel.send({
          content: text && text !== '0' ? text : null,
          files: image && image !== '0' ? [image] : [],
          components: createReasonComponents(config, message.guild.id)
        });
        await message.channel.send('**تم ارسال البانل بنجاح.**');
      }
    }

    setGuildData(message.guild.id, config, tickets);
  }

  setGuildData(message.guild.id, config, tickets);
  await message.channel.send('**تم حفظ اعدادات التكت.**');
}

function registerHandlers(client) {
  if (handlersRegistered) return;
  handlersRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!(interaction.isButton() || interaction.isStringSelectMenu())) return;
      const id = interaction.customId || '';

      if (id.startsWith('ticket_open_btn_')) {
        const [, , , guildId, reasonKey] = id.split('_');
        await handleOpenRequest(interaction, guildId, reasonKey);
        return;
      }

      if (interaction.isStringSelectMenu() && id.startsWith('ticket_open_menu_')) {
        const guildId = id.replace('ticket_open_menu_', '');
        const value = interaction.values?.[0] || 'reason_0';
        const reasonKey = value.replace('reason_', '');
        await handleOpenRequest(interaction, guildId, reasonKey);
        return;
      }

      if (id.startsWith('ticket_claimreq_')) {
        const reqId = id.replace('ticket_claimreq_', '');
        await handleClaimFromRequest(interaction, reqId);
        return;
      }

      if (id.startsWith('ticket_claim_')) {
        const [, , guildId, channelId] = id.split('_');
        await handleClaimInTicket(interaction, guildId, channelId);
        return;
      }

      if (id.startsWith('ticket_close_')) {
        const [, , guildId, channelId] = id.split('_');
        await handleClose(interaction, guildId, channelId);
        return;
      }
    } catch (e) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '**حدث خطأ أثناء معالجة التكت.**', ephemeral: true }).catch(() => {});
      }
    }
  });
}

module.exports = { name, aliases, execute, registerHandlers };
