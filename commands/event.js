const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const interactionRouter = require('../utils/interactionRouter');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');

const name = 'event';
const dataPath = path.join(__dirname, '..', 'data', 'eventsSystem.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

const runtime = {
  initedClients: new Set(),
  eventEndTimers: new Map(),
  reminderTimers: new Map(),
  startTimers: new Map(),
  answerLocks: new Set(),
  rejectCooldown: new Map(),
  createCooldown: new Map()
};

const TIMEZONE = 'Asia/Riyadh';
const MAX_EVENT_ANSWERS = 25;

function now() { return Date.now(); }
function readData() {
  try {
    if (!fs.existsSync(dataPath)) return { guilds: {}, top: {} };
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    return { guilds: {}, top: {} };
  }
}
function writeData(data) {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dataPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dataPath);
}

function persistSettings(data, guildId) {
  const g = getGuild(data, guildId);
  g.settingsUpdatedAt = Date.now();
  writeData(data);
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
function getGuild(data, guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      settings: {
        applyChannelId: null,
        requestChannelId: null,
        publicChannelId: null,
        adminChannelId: null,
        topChannelId: null,
        approvalRoleIds: [],
        font: 'https://example.com/separator.png',
        emoji: '✅',
        imageUrl: null,
        mentionHere: false,
        mentionMembers: false,
        embedEnabled: false,
        lineText: '',
        topImageUrl: '',
        publicText: ''
      },
      activeEvent: null,
      pendingEvent: null,
      history: []
    };
  }
  const s = data.guilds[guildId].settings;
  if (!Array.isArray(s.approvalRoleIds)) s.approvalRoleIds = [];
  if (!Object.prototype.hasOwnProperty.call(s, 'requestChannelId')) s.requestChannelId = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'publicChannelId')) s.publicChannelId = null;
  if (!Object.prototype.hasOwnProperty.call(s, 'publicText')) s.publicText = '';
  if (!Object.prototype.hasOwnProperty.call(s, 'topImageUrl')) s.topImageUrl = '';
  if (!Object.prototype.hasOwnProperty.call(s, 'mentionMembers')) s.mentionMembers = false;
  return data.guilds[guildId];
}

function parseScheduleTime(timeString) {
  if (!timeString) return null;
  const cleanTime = String(timeString).trim().toLowerCase();
  const nowMoment = moment().tz(TIMEZONE);

  if (cleanTime.includes('الآن') || cleanTime.includes('فوراً') || cleanTime.includes('فورا') || cleanTime.includes('دحين') || cleanTime.includes('الحين') || cleanTime.includes('حين') || cleanTime.includes('توني') || cleanTime.includes('now') || cleanTime.includes('immediately')) {
    return nowMoment.toDate();
  }

  const secondsMatch = cleanTime.match(/بعد\s+(\d+)\s*ثوان[يی]?|بعد\s+ثانية/);
  if (secondsMatch) return nowMoment.clone().add(parseInt(secondsMatch[1] || 1, 10), 'seconds').toDate();

  const minutesMatch = cleanTime.match(/بعد\s+(\d+)\s*دقائق?|بعد\s+دقيقة/);
  if (minutesMatch) return nowMoment.clone().add(parseInt(minutesMatch[1] || 1, 10), 'minutes').toDate();

  const hoursMatch = cleanTime.match(/بعد\s+(\d+)\s*ساعات?|بعد\s+ساعة/);
  if (hoursMatch) return nowMoment.clone().add(parseInt(hoursMatch[1] || 1, 10), 'hours').toDate();

  const daysMatch = cleanTime.match(/بعد\s+(\d+)\s*أيام?|بعد\s+يوم/);
  if (daysMatch) return nowMoment.clone().add(parseInt(daysMatch[1] || 1, 10), 'days').toDate();

  if (cleanTime.includes('غداً') || cleanTime.includes('غدا') || cleanTime.includes('بكره') || cleanTime.includes('بكرة') || cleanTime.includes('غدوة')) {
    const tomorrowMatch = cleanTime.match(/(?:الساعة\s*)?(\d{1,2})(?:\s*(صباحاً|ص|am|مساءً|م|pm))?/i);
    const t = nowMoment.clone().add(1, 'day');
    if (tomorrowMatch) {
      let h = parseInt(tomorrowMatch[1], 10);
      const period = (tomorrowMatch[2] || '').toLowerCase();
      if (period.includes('مس') || period.includes('pm')) { if (h < 12) h += 12; }
      else if (period.includes('ص') || period.includes('am')) { if (h === 12) h = 0; }
      t.hour(h).minute(0).second(0).millisecond(0);
    }
    return t.toDate();
  }

  if (cleanTime.includes('شوي')) return nowMoment.clone().add(10, 'minutes').toDate();

  const hourMatch = cleanTime.match(/(?:الساعة\s*)?(\d{1,2})(?:\s*(صباحاً|ص|am|مساءً|م|pm))?/i);
  if (hourMatch && !cleanTime.includes('بعد')) {
    let hour = parseInt(hourMatch[1], 10);
    const period = (hourMatch[2] || '').toLowerCase();
    if (period.includes('مس') || period.includes('pm')) { if (hour < 12) hour += 12; }
    else if (period.includes('ص') || period.includes('am')) { if (hour === 12) hour = 0; }

    const target = nowMoment.clone().hour(hour).minute(0).second(0).millisecond(0);
    if (target.isBefore(nowMoment)) target.add(1, 'day');
    return target.toDate();
  }

  const date = new Date(timeString);
  if (!Number.isNaN(date.getTime())) return date;

  return nowMoment.clone().add(1, 'hour').toDate();
}

function parseDurationMinutes(input) {
  if (!input) return 30;
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(m|min|minute|minutes|د|دقيقة|دقائق|h|hr|hour|hours|س|ساعة|ساعات)?$/i);
  if (!m) return 30;
  const n = Number(m[1]);
  if (/(h|hr|hour|hours|س|ساعة|ساعات)/i.test(m[2] || '')) return n * 60;
  return n;
}

function isOwner(member, owners) {
  if (!member) return false;
  return member.id === member.guild.ownerId || (owners || []).includes(member.id);
}
function hasAnyAdminRole(member) {
  return loadAdminRoles().some((r) => member.roles.cache.has(r));
}
function isApprover(member, gState, owners) {
  if (!member) return false;
  if (isOwner(member, owners)) return true;
  return (gState.settings.approvalRoleIds || []).some((r) => member.roles.cache.has(r));
}
function isEventManager(member, guildState, owners) {
  if (isOwner(member, owners)) return true;
  if (!member) return false;
  const ev = guildState.activeEvent || guildState.pendingEvent;
  if (!ev) return false;
  return [ev.creatorId, ev.organizerId].filter(Boolean).includes(member.id);
}

function canManageSettings(member, owners) {
  return isOwner(member, owners);
}

function canManageEventFlow(member, gState, owners) {
  return isEventManager(member, gState, owners) || isApprover(member, gState, owners);
}

function eventBoard(ev) {
  return Object.entries(ev.points || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, pts], i) => `#${i + 1} - <@${id}> : **${pts}**`).join('\n') || 'لا يوجد نقاط حتى الآن.';
}

function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function fitTextInputLabel(label) {
  return String(label || '').trim().slice(0, 45);
}
function clearGuildTimers(guildId) {
  for (const map of [runtime.eventEndTimers, runtime.reminderTimers, runtime.startTimers]) {
    const timer = map.get(guildId);
    if (timer) clearTimeout(timer);
    map.delete(guildId);
  }
}

function buildMentionPrefix(s) {
  const chunks = [];
  if (s.mentionHere) chunks.push('@here');
  if (s.mentionMembers) chunks.push('@everyone');
  return chunks.join(' ').trim() || null;
}

async function postTopBoard(guild, data) {
  const g = getGuild(data, guild.id);
  if (!g.settings.topChannelId) return;
  const channel = await guild.channels.fetch(g.settings.topChannelId).catch(() => null);
  if (!channel) return;
  const top = data.top[guild.id] || {};
  const sorted = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const desc = sorted.length ? sorted.map(([u, p], i) => `#${i + 1} - <@${u}> : **${p}**`).join('\n') : 'لا يوجد نقاط تراكمية بعد.';
  const embed = colorManager.createEmbed().setTitle(`${guild.name} points`).setDescription(desc).setThumbnail(guild.iconURL()).setTimestamp();
  if (isValidHttpUrl(g.settings.topImageUrl)) embed.setImage(g.settings.topImageUrl);
  await channel.send({ content: buildMentionPrefix(g.settings) || undefined, embeds: [embed] }).catch(() => {});
}

async function publishEventBoard(guild, gState, ev, triggerUserId) {
  if (!gState.settings.publicChannelId) return;
  const publicChannel = await guild.channels.fetch(gState.settings.publicChannelId).catch(() => null);
  if (!publicChannel) return;

  const winnerLine = triggerUserId ? `✅ أول إجابة صحيحة: <@${triggerUserId}>` : null;
  const board = eventBoard(ev);
  const mentionPrefix = buildMentionPrefix(gState.settings);
  const optionalText = (ev.correctAnswerText || '').trim();

  if (gState.settings.embedEnabled) {
    const body = [winnerLine, optionalText || null, board].filter(Boolean).join('\n');
    const emb = colorManager.createEmbed().setTitle(`${guild.name} points`).setDescription(body);
    await publicChannel.send({
      content: `${mentionPrefix ? `${mentionPrefix}\n` : ''}${gState.settings.publicText || ''}`.trim() || undefined,
      embeds: [emb]
    }).catch(() => {});
  } else if (optionalText) {
    await publicChannel.send([
      mentionPrefix || '',
      gState.settings.publicText || '',
      winnerLine || '',
      optionalText,
      board
    ].filter(Boolean).join('\n')).catch(() => {});
  }
}

async function finalizeEvent(guild, reason = 'time-ended') {
  const data = readData();
  const g = getGuild(data, guild.id);
  const ev = g.activeEvent;
  if (!ev) return;

  ev.status = reason === 'cancelled' ? 'cancelled' : 'ended';
  ev.endedAt = now();
  const ranking = Object.entries(ev.points || {}).sort((a, b) => b[1] - a[1]);
  const winnerId = ranking[0]?.[0] || null;

  if (!data.top[guild.id]) data.top[guild.id] = {};
  for (const [uid, pts] of ranking) data.top[guild.id][uid] = (data.top[guild.id][uid] || 0) + pts;

  g.history.unshift({
    id: ev.id,
    name: ev.name,
    type: ev.type,
    creatorId: ev.creatorId,
    organizerId: ev.organizerId,
    startAt: ev.startAt,
    endAt: ev.endAt,
    winnerId,
    status: ev.status,
    rejectReason: ev.rejectReason || null
  });
  g.history = g.history.slice(0, 50);

  const publicCh = g.settings.publicChannelId ? await guild.channels.fetch(g.settings.publicChannelId).catch(() => null) : null;
  if (publicCh) {
    const endEmbed = colorManager.createEmbed()
      .setTitle('تم الانتهاء من الفعالية')
      .setDescription(`**شكراً لكم 🌟**\n**شكراً للمقدمين للفعالية.**\n**الفائز:** ${winnerId ? `<@${winnerId}>` : '**لا يوجد**'}\n**الحالة:** **${ev.status === 'cancelled' ? 'تم الإلغاء' : 'تم الإنهاء'}**`)
      .setImage(guild.bannerURL({ size: 1024 }) || null)
      .setThumbnail(guild.iconURL())
      .setColor(ev.status === 'cancelled' ? 0xED4245 : 0x57F287);
    await publicCh.send({ content: g.settings.publicText || undefined, embeds: [endEmbed] }).catch(() => {});
  }

  g.activeEvent = null;
  g.settings.mentionHere = false;
  g.settings.mentionMembers = false;
  g.settings.embedEnabled = false;
  writeData(data);
  clearGuildTimers(guild.id);
  await postTopBoard(guild, data);
}

async function sendSetPanel(target, guildState, eventState) {
  const options = Array.from({ length: MAX_EVENT_ANSWERS }).map((_, i) => ({
    label: `الإجابة ${i + 1}`,
    value: String(i),
    description: eventState.answers?.[i] ? `مضبوطة: ${eventState.answers[i]}` : 'فارغة'
  }));
  const row1 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('event_set_answer_select').setPlaceholder('اختر رقم الإجابة').addOptions(options));
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('event_set_toggle_here').setLabel(`منشن here: ${guildState.settings.mentionHere ? 'ON' : 'OFF'}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('event_set_toggle_members').setLabel(`منشن everyone: ${guildState.settings.mentionMembers ? 'ON' : 'OFF'}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('event_set_toggle_embed').setLabel(`الإيمبد: ${guildState.settings.embedEnabled ? 'ON' : 'OFF'}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('event_set_start').setLabel('بدء').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('event_set_correct_text').setLabel('نص الإجابة الصحيحة').setStyle(ButtonStyle.Primary)
  );
  const emb = colorManager.createEmbed()
    .setTitle('لوحة Set للفعالية')
    .setDescription(`الكلمة الافتتاحية: **${eventState.starterWord || 'غير محددة'}**\nالإيموجي: ${eventState.reactEmoji || guildState.settings.emoji || '✅'}\nنص الفوز: ${eventState.correctAnswerText ? 'مفعل' : 'غير مفعل'}`)
    .setFooter({ text: 'Pause/Resume عبر الأوامر: event pause | event resume' });

  await target.send({ embeds: [emb], components: [row1, row2] }).catch(async (dmError) => {
    console.error(`❌ Failed to send event set panel to user ${target.id}:`, dmError);
    if (target.channel) {
      await target.channel.send({ embeds: [emb], components: [row1, row2] }).catch((channelError) => {
        console.error(`❌ Failed to send event set panel to channel ${target.channel.id}:`, channelError);
      });
    }
  });
}

async function publishApplyPanel(guild, gState) {
  if (!gState.settings.applyChannelId || !gState.settings.imageUrl) return;
  const channel = await guild.channels.fetch(gState.settings.applyChannelId).catch(() => null);
  if (!channel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('event_create_from_panel').setLabel('إنشاء فعالية').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('event_log_from_panel').setLabel('سجل الفعاليات').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('event_top_from_panel').setLabel('التوب').setStyle(ButtonStyle.Primary)
  );
  await channel.send({ content: gState.settings.imageUrl, components: [row] }).catch(() => {});
}

async function scheduleEventLifecycle(client, guildId) {
  clearGuildTimers(guildId);
  const data = readData();
  const g = getGuild(data, guildId);
  const ev = g.activeEvent;
  if (!ev) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  runtime.reminderTimers.set(guildId, setTimeout(async () => {
    const fresh = readData();
    const gs = getGuild(fresh, guildId);
    if (!gs.activeEvent || gs.activeEvent.status === 'cancelled') return;
    const notify = `<@${gs.activeEvent.creatorId}> ${gs.activeEvent.organizerId ? `<@${gs.activeEvent.organizerId}>` : ''}`;
    const adminCh = gs.settings.adminChannelId ? await guild.channels.fetch(gs.settings.adminChannelId).catch(() => null) : null;
    if (!adminCh) return;
    await adminCh.send(`**⏰ تبقى 10 دقائق على الفعالية**
${notify}
**وقت البداية:** **<t:${Math.floor(gs.activeEvent.startAt / 1000)}:F>** • **<t:${Math.floor(gs.activeEvent.startAt / 1000)}:R>**`).catch(() => {});
    await adminCh.send({
      content: `${notify} هل أنت مستعد لبدء الفعالية؟`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('event_ready_yes').setLabel('✅ مستعد').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('event_ready_no').setLabel('❌ إلغاء').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('event_open_set').setLabel('فتح Set').setStyle(ButtonStyle.Secondary)
      )]
    }).catch(() => {});
  }, Math.max(0, ev.startAt - now() - 10 * 60000)));

  runtime.startTimers.set(guildId, setTimeout(async () => {
    const fresh = readData();
    const gs = getGuild(fresh, guildId);
    if (!gs.activeEvent || gs.activeEvent.status === 'cancelled') return;
    gs.activeEvent.paused = true;
    writeData(fresh);
  }, Math.max(0, ev.startAt - now())));

  runtime.eventEndTimers.set(guildId, setTimeout(async () => {
    const fresh = readData();
    const gs = getGuild(fresh, guildId);
    if (!gs.activeEvent || gs.activeEvent.status === 'cancelled') return;
    await finalizeEvent(guild, 'time-ended');
  }, Math.max(0, ev.endAt - now())));
}

function ensureEventMessageListener(client) {
  if (runtime.initedClients.has(`msg:${client.user?.id || 'bot'}`)) return;
  client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    if (message.content.trim().toLowerCase() === 'event pause') {
      const data = readData();
      const g = getGuild(data, message.guild.id);
      const ev = g.activeEvent;
      if (!ev) return;
      if (!isEventManager(message.member, g, global.BOT_OWNERS || [])) return;
      ev.paused = true;
      writeData(data);
      await message.reply('⏸️ تم إيقاف الفعالية مؤقتًا.').catch(() => {});
      return;
    }
    if (message.content.trim().toLowerCase() === 'event resume') {
      const data = readData();
      const g = getGuild(data, message.guild.id);
      const ev = g.activeEvent;
      if (!ev) return;
      if (!isEventManager(message.member, g, global.BOT_OWNERS || [])) return;
      ev.paused = false;
      ev.status = 'running';
      writeData(data);
      await message.reply('▶️ تم استكمال الفعالية.').catch(() => {});
      return;
    }

    const guildId = message.guild.id;
    if (runtime.answerLocks.has(guildId)) return;
    runtime.answerLocks.add(guildId);
    try {
      const data = readData();
      const g = getGuild(data, guildId);
      const ev = g.activeEvent;
      if (!ev || ev.status !== 'running' || ev.paused) return;
      if (message.channel.id !== g.settings.publicChannelId) return;

      const starter = (ev.starterWord || '').trim();
      if (!starter || !message.content.startsWith(starter)) return;

      const body = message.content.slice(starter.length).trim().toLowerCase();
      const nextAnswer = (ev.answers?.[ev.currentIndex] || '').trim().toLowerCase();
      if (!nextAnswer || body !== nextAnswer) return;

      ev.points[message.author.id] = (ev.points[message.author.id] || 0) + 1;
      ev.currentIndex += 1;
      ev.lastAnswerAt = now();
      writeData(data);

      await message.react(ev.reactEmoji || g.settings.emoji || '✅').catch(() => {});
      await publishEventBoard(message.guild, g, ev, message.author.id);

      if (ev.currentIndex >= MAX_EVENT_ANSWERS || ev.currentIndex >= ev.answers.filter(Boolean).length) {
        await finalizeEvent(message.guild, 'answers-finished');
      }
    } finally {
      runtime.answerLocks.delete(guildId);
    }
  });
  runtime.initedClients.add(`msg:${client.user?.id || 'bot'}`);
}

function ensureRouterRegistered() {
  if (global.__event_router_registered) return;
  interactionRouter.register('event_', async (interaction, ctx = {}) => handleInteraction(interaction, ctx), { name: 'event-system', priority: 40 });
  global.__event_router_registered = true;
}

async function initialize(client) {
  ensureRouterRegistered();
  ensureEventMessageListener(client);
  const mark = `init:${client.user?.id || 'bot'}`;
  if (runtime.initedClients.has(mark)) return;
  runtime.initedClients.add(mark);
  const data = readData();
  for (const guildId of Object.keys(data.guilds || {})) {
    const g = getGuild(data, guildId);
    if (g.activeEvent) await scheduleEventLifecycle(client, guildId);
  }
}

async function execute(message, args, context) {
  const { BOT_OWNERS, client } = context;
  await initialize(client);
  const data = readData();
  const g = getGuild(data, message.guild.id);

  if (isUserBlocked(message.author.id)) return message.react('❌').catch(() => {});
  if (isChannelBlocked(message.channel.id)) return message.react('❌').catch(() => {});

  if ((args[0] || '').toLowerCase() === 'set') {
    if (!isEventManager(message.member, g, BOT_OWNERS) && !isApprover(message.member, g, BOT_OWNERS)) return message.reply('❌ هذا الأمر متاح فقط لصاحب/منظم الفعالية.');
    const ev = g.activeEvent || g.pendingEvent;
    if (!ev) return message.reply('❌ لا توجد فعالية جارية أو معلقة.');
    await sendSetPanel(message.author, g, ev);
    return message.reply('**✅ تم إرسال لوحة Set في الخاص.**');
  }

  if ((args[0] || '').toLowerCase() === 'pause') {
    const ev = g.activeEvent;
    if (!ev) return message.reply('❌ لا توجد فعالية شغالة.');
    if (!isEventManager(message.member, g, BOT_OWNERS) && !isApprover(message.member, g, BOT_OWNERS)) return message.reply('❌ لا تملك صلاحية.');
    ev.paused = true; writeData(data);
    return message.reply('**⏸️ تم إيقاف الفعالية مؤقتًا.**');
  }

  if ((args[0] || '').toLowerCase() === 'resume') {
    const ev = g.activeEvent;
    if (!ev) return message.reply('❌ لا توجد فعالية شغالة.');
    if (!isEventManager(message.member, g, BOT_OWNERS) && !isApprover(message.member, g, BOT_OWNERS)) return message.reply('❌ لا تملك صلاحية.');
    ev.paused = false; ev.status = 'running'; writeData(data);
    return message.reply('**▶️ تم استكمال الفعالية.**');
  }

  if (!isOwner(message.member, BOT_OWNERS)) return message.reply('❌ هذا الأمر للأونرز فقط.');

  const settingsEmbed = colorManager.createEmbed()
    .setTitle('إعدادات نظام الفعاليات')
    .setDescription('التحكم الكامل من هنا.\nأزرار **إنشاء/سجل/توب** تظهر فقط في روم التقديم.');

  const rows = [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_request_channel').setPlaceholder('حدد روم الطلبات (يروح له طلب الانشاء)').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_admin_channel').setPlaceholder('حدد روم المسؤولين').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_apply_channel').setPlaceholder('حدد روم التقديم (طلبات فقط)').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_public_channel').setPlaceholder('حدد الروم العام للفعالية').setChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_top_channel').setPlaceholder('حدد روم التوب').setChannelTypes(ChannelType.GuildText))
  ];
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('event_settings_misc').setLabel('ايموجي/خط/نص').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('event_settings_approvers').setLabel('تحديد المعتمدين').setStyle(ButtonStyle.Secondary)
  );

  const firstMessage = await message.reply({ embeds: [settingsEmbed], components: rows });
  await message.channel.send({ content: `${message.author}`, components: [rowButtons] }).catch(() => firstMessage.channel.send({ components: [rowButtons] }).catch(() => {}));
}

async function handleInteraction(interaction, context = {}) {
  if (!interaction.guild) return false;

  if (isUserBlocked(interaction.user.id)) {
    await interaction.reply({ content: '❌ أنت محظور من استخدام البوت.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  if (interaction.channelId && isChannelBlocked(interaction.channelId)) {
    await interaction.reply({ content: '❌ هذا الشات محظور لاستخدام البوت.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  const { BOT_OWNERS, client } = context;
  const data = readData();
  const g = getGuild(data, interaction.guild.id);

  if (interaction.customId === 'event_settings_open') {
    if (!isOwner(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    const rows = [
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_request_channel').setPlaceholder('حدد روم الطلبات (يروح له طلب الانشاء)').setChannelTypes(ChannelType.GuildText)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_admin_channel').setPlaceholder('حدد روم المسؤولين').setChannelTypes(ChannelType.GuildText)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_apply_channel').setPlaceholder('حدد روم التقديم (طلبات فقط)').setChannelTypes(ChannelType.GuildText)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_public_channel').setPlaceholder('حدد الروم العام للفعالية').setChannelTypes(ChannelType.GuildText)),
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('event_settings_top_channel').setPlaceholder('حدد روم التوب').setChannelTypes(ChannelType.GuildText))
    ];
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('event_settings_misc').setLabel('ايموجي/خط/نص').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('event_settings_approvers').setLabel('تحديد المعتمدين').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ content: 'إعدادات الفعاليات (1/2):', components: rows, flags: MessageFlags.Ephemeral });
    await interaction.followUp({ content: 'إعدادات الفعاليات (2/2):', components: [row2], flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === 'event_settings_request_channel') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.requestChannelId = interaction.values[0]; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: '✅ تم تعيين روم الطلبات.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_settings_approvers') {
    if (!isOwner(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    const row = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('event_settings_approvers_select').setPlaceholder('اختر رتب المعتمدين').setMinValues(1).setMaxValues(10));
    return interaction.reply({ content: 'حدد الرتب المعتمدة للموافقة/الرفض:', components: [row], flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_settings_approvers_select') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.approvalRoleIds = interaction.values; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: `✅ تم حفظ المعتمدين (${interaction.values.length}).`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_settings_misc') {
    const modal = new ModalBuilder().setCustomId('event_settings_misc_modal').setTitle('إعدادات الايموجي/الخط (صورة فاصلة)/النص');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel(fitTextInputLabel('ايموجي الريأكشن')).setStyle(TextInputStyle.Short).setRequired(true).setValue(g.settings.emoji || '✅')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('font').setLabel(fitTextInputLabel('رابط صورة الفاصل (الخط)')).setStyle(TextInputStyle.Short).setRequired(false).setValue(g.settings.font || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('publicText').setLabel(fitTextInputLabel('نص الروم العام')).setStyle(TextInputStyle.Short).setRequired(false).setValue(g.settings.publicText || ''))
    );
    return interaction.showModal(modal);
  }
  if (interaction.customId === 'event_settings_misc_modal') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.emoji = interaction.fields.getTextInputValue('emoji') || '✅';
    const fontUrl = sanitizeText(interaction.fields.getTextInputValue('font'), 500);
    const publicText = sanitizeText(interaction.fields.getTextInputValue('publicText'), 500);
    if (fontUrl && !isValidHttpUrl(fontUrl)) {
      return interaction.reply({ content: '❌ رابط صورة الفاصل غير صالح (http/https).', flags: MessageFlags.Ephemeral });
    }
    g.settings.font = fontUrl || '';
    g.settings.publicText = publicText;
    persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: '**✅ تم حفظ الإعدادات.**', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_settings_admin_channel') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.adminChannelId = interaction.values[0]; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: '✅ تم حفظ روم المسؤولين.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_settings_apply_channel') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.applyChannelId = interaction.values[0]; persistSettings(data, interaction.guild.id);
    const modal = new ModalBuilder().setCustomId('event_settings_apply_image_modal').setTitle('صورة روم التقديم');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel(fitTextInputLabel('رابط الصورة')).setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (interaction.customId === 'event_settings_apply_image_modal') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    const imageUrl = sanitizeText(interaction.fields.getTextInputValue('image'), 500);
    if (!isValidHttpUrl(imageUrl)) {
      return interaction.reply({ content: '❌ رابط الصورة غير صالح (http/https).', flags: MessageFlags.Ephemeral });
    }
    g.settings.imageUrl = imageUrl;
    persistSettings(data, interaction.guild.id);
    await interaction.reply({ content: '✅ تم حفظ الصورة ونشر أزرار التقديم.', flags: MessageFlags.Ephemeral });
    await publishApplyPanel(interaction.guild, g);
    return;
  }
  if (interaction.customId === 'event_settings_public_channel') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.publicChannelId = interaction.values[0]; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: '✅ تم حفظ الروم العام للفعالية.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_settings_top_channel') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    g.settings.topChannelId = interaction.values[0]; persistSettings(data, interaction.guild.id);
    const modal = new ModalBuilder().setCustomId('event_settings_top_image_modal').setTitle('صورة التوب');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('topImage').setLabel(fitTextInputLabel('رابط صورة التوب داخل الإيمبد')).setStyle(TextInputStyle.Short).setRequired(false).setValue(g.settings.topImageUrl || '')));
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'event_settings_top_image_modal') {
    if (!canManageSettings(interaction.member, BOT_OWNERS)) return interaction.reply({ content: '❌ للأونرز فقط', flags: MessageFlags.Ephemeral });
    const topImage = sanitizeText(interaction.fields.getTextInputValue('topImage'), 500);
    if (topImage && !isValidHttpUrl(topImage)) {
      return interaction.reply({ content: '❌ رابط صورة التوب غير صالح (http/https).', flags: MessageFlags.Ephemeral });
    }
    g.settings.topImageUrl = topImage || '';
    persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: '**✅ تم حفظ روم التوب وصورته.**', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_create_from_panel') {
    try {
      if (!interaction.member) {
        return interaction.reply({ content: '❌ تعذر التحقق من العضو، أعد المحاولة.', flags: MessageFlags.Ephemeral });
      }
      if (!hasAnyAdminRole(interaction.member)) return interaction.reply({ content: '❌ التقديم للفعاليات متاح فقط لرولات Adminroles.', flags: MessageFlags.Ephemeral });
      if (g.settings.applyChannelId && interaction.channelId !== g.settings.applyChannelId) return interaction.reply({ content: '❌ التقديم يكون من روم التقديم فقط.', flags: MessageFlags.Ephemeral });
      if (g.activeEvent || g.pendingEvent) return interaction.reply({ content: '❌ يوجد طلب/فعالية حالية. لا يمكن التقديم الآن.', flags: MessageFlags.Ephemeral });

      const key = `${interaction.guild.id}:${interaction.user.id}`;
      const cooldownUntil = runtime.createCooldown.get(key) || 0;
      if (cooldownUntil > now()) return interaction.reply({ content: `⏳ انتظر ${Math.ceil((cooldownUntil - now()) / 1000)} ثانية.`, flags: MessageFlags.Ephemeral });

      const modal = new ModalBuilder().setCustomId('event_create_modal').setTitle('إنشاء فعالية');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('organizer').setLabel(fitTextInputLabel('المنظم معك (اختياري: منشن/ID)')).setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel(fitTextInputLabel('اسم الفعالية')).setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel(fitTextInputLabel('مدة الفعالية (مثال 30m)')).setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('type').setLabel(fitTextInputLabel('نوع الفعالية')).setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel(fitTextInputLabel('وقت البداية (مثال: الحين / بعد ساعة)')).setStyle(TextInputStyle.Short).setRequired(true))
      );
      return interaction.showModal(modal);
    } catch (err) {
      console.error('event_create_from_panel error:', err);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: '❌ حدث خطأ أثناء معالجة التفاعل، حاول مرة أخرى.', flags: MessageFlags.Ephemeral });
      }
      return true;
    }
  }

  if (interaction.customId === 'event_create_modal') {
    if (!hasAnyAdminRole(interaction.member)) return interaction.reply({ content: '❌ التقديم متاح فقط لرولات Adminroles.', flags: MessageFlags.Ephemeral });
    if (g.activeEvent || g.pendingEvent) return interaction.reply({ content: '❌ يوجد طلب/فعالية حالية بالفعل.', flags: MessageFlags.Ephemeral });

    const organizerRaw = sanitizeText(interaction.fields.getTextInputValue('organizer'), 100);
    const organizerId = organizerRaw?.match(/\d{16,20}/)?.[0] || null;
    const nameVal = sanitizeText(interaction.fields.getTextInputValue('name'), 100) || `فعالية ${interaction.user.username}`;
    const typeVal = sanitizeText(interaction.fields.getTextInputValue('type'), 100);
    const startInput = sanitizeText(interaction.fields.getTextInputValue('start'), 120);
    const durationInput = sanitizeText(interaction.fields.getTextInputValue('duration'), 30);
    if (!typeVal) return interaction.reply({ content: '❌ نوع الفعالية مطلوب.', flags: MessageFlags.Ephemeral });
    const startDate = parseScheduleTime(startInput);
    const mins = parseDurationMinutes(durationInput);
    if (!Number.isFinite(mins) || mins < 1 || mins > 600) return interaction.reply({ content: '❌ مدة الفعالية يجب أن تكون بين 1 و 600 دقيقة.', flags: MessageFlags.Ephemeral });
    if (!startDate || startDate.getTime() < now()) return interaction.reply({ content: '❌ وقت البداية غير صحيح.', flags: MessageFlags.Ephemeral });

    g.pendingEvent = {
      id: `ev_${Date.now()}`,
      creatorId: interaction.user.id,
      organizerId,
      name: nameVal,
      type: typeVal,
      startAt: startDate.getTime(),
      endAt: startDate.getTime() + mins * 60000,
      durationMinutes: mins,
      status: 'pending-approval',
      answers: Array(MAX_EVENT_ANSWERS).fill(''),
      currentIndex: 0,
      points: {},
      starterWord: '',
      reactEmoji: g.settings.emoji || '✅',
      correctAnswerText: '',
      paused: true,
      createdAt: now()
    };
    writeData(data);
    runtime.createCooldown.set(`${interaction.guild.id}:${interaction.user.id}`, now() + 45_000);

    const requestChannel = g.settings.requestChannelId ? await interaction.guild.channels.fetch(g.settings.requestChannelId).catch(() => null) : null;
    if (requestChannel) {
      const emb = colorManager.createEmbed()
        .setTitle('طلب فعالية جديد')
        .setDescription(`**الاسم:** **${nameVal}**\n**النوع:** **${g.pendingEvent.type}**\n**المدة:** **${mins} دقيقة**\n**البداية:** **<t:${Math.floor(startDate.getTime() / 1000)}:F>** • **<t:${Math.floor(startDate.getTime() / 1000)}:R>**\n**صاحب الفعالية:** <@${interaction.user.id}>\n**المنظم:** ${organizerId ? `<@${organizerId}>` : '**غير محدد**'}`)
        .setThumbnail(interaction.user.displayAvatarURL())
        .setFooter({ text: 'طلب فعالية جديد' });
      if (isValidHttpUrl(g.settings.font)) emb.setImage(g.settings.font);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('event_approve').setLabel('موافقة').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('event_reject_open').setLabel('رفض').setStyle(ButtonStyle.Danger)
      );
      await requestChannel.send({ embeds: [emb], components: [row] }).catch(() => {});
    }

    return interaction.reply({ content: '**✅ تم إرسال الطلب إلى روم الطلبات.**', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_approve') {
    if (!isApprover(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية الموافقة.', flags: MessageFlags.Ephemeral });
    if (!g.pendingEvent) return interaction.reply({ content: '❌ لا يوجد طلب معلق.', flags: MessageFlags.Ephemeral });
    g.pendingEvent.status = 'approved';
    g.pendingEvent.approvedBy = interaction.user.id;
    g.pendingEvent.approvedAt = now();
    g.activeEvent = g.pendingEvent;
    g.pendingEvent = null;
    writeData(data);
    await scheduleEventLifecycle(client || interaction.client, interaction.guild.id);
    return interaction.reply({ content: `**✅ تمت الموافقة بواسطة <@${interaction.user.id}>.**`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_reject_open') {
    if (!isApprover(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية الرفض.', flags: MessageFlags.Ephemeral });
    const key = `${interaction.guild.id}:${interaction.user.id}`;
    const until = runtime.rejectCooldown.get(key) || 0;
    if (until > now()) return interaction.reply({ content: `⏳ كولداون الرفض: ${Math.ceil((until - now()) / 1000)} ثانية.`, flags: MessageFlags.Ephemeral });
    if (!g.pendingEvent) return interaction.reply({ content: '❌ لا يوجد طلب معلق.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId('event_reject_reason_modal').setTitle('سبب رفض الفعالية');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(fitTextInputLabel('اكتب سبب الرفض')).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(600)));
    return interaction.showModal(modal);
  }

  if (interaction.customId === 'event_reject_reason_modal') {
    if (!isApprover(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية الرفض.', flags: MessageFlags.Ephemeral });
    if (!g.pendingEvent) return interaction.reply({ content: '❌ لا يوجد طلب معلق.', flags: MessageFlags.Ephemeral });
    const reason = interaction.fields.getTextInputValue('reason').trim();
    const rejected = g.pendingEvent;
    g.history.unshift({ id: rejected.id, name: rejected.name, type: rejected.type, creatorId: rejected.creatorId, organizerId: rejected.organizerId, startAt: rejected.startAt, endAt: rejected.endAt, winnerId: null, status: 'rejected', rejectReason: reason });
    g.history = g.history.slice(0, 50);
    g.pendingEvent = null;
    writeData(data);
    runtime.rejectCooldown.set(`${interaction.guild.id}:${interaction.user.id}`, now() + 15_000);
    return interaction.reply({ content: `**❌ تم رفض الطلب.**\n**السبب:** **${reason}**`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_ready_no') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    if (!g.activeEvent) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    g.activeEvent.status = 'cancelled'; writeData(data);
    await finalizeEvent(interaction.guild, 'cancelled');
    return interaction.reply({ content: '❌ تم إلغاء الفعالية.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_ready_yes') {
    const ev = g.activeEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    if (![ev.creatorId, ev.organizerId].includes(interaction.user.id) && !isApprover(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ فقط الصاحب/المنظم/المعتمد.', flags: MessageFlags.Ephemeral });
    ev.paused = true; ev.status = 'ready'; writeData(data);
    if (ev.organizerId) {
      const member = await interaction.guild.members.fetch(ev.organizerId).catch(() => null);
      if (member) await member.send(`**✅ تم الاستعداد بنجاح.**\n**وقت البداية:** **<t:${Math.floor(ev.startAt / 1000)}:F>** • **<t:${Math.floor(ev.startAt / 1000)}:R>**`).catch(() => {});
    }
    return interaction.reply({ content: '✅ تم تأكيد الاستعداد. افتح Set ثم اضغط بدء.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_open_set') {
    const ev = g.activeEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    if (![ev.creatorId, ev.organizerId].includes(interaction.user.id) && !isApprover(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ فقط المنظم وصاحب الفعالية.', flags: MessageFlags.Ephemeral });
    await sendSetPanel(interaction.user, g, ev);
    return interaction.reply({ content: '✅ تم فتح لوحة Set في الخاص.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_set_answer_select') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    const ev = g.activeEvent || g.pendingEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    const idx = Number(interaction.values[0]);
    const modal = new ModalBuilder().setCustomId(`event_set_answer_modal_${idx}`).setTitle(`ضبط الإجابة ${idx + 1}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ans').setLabel(fitTextInputLabel(`ضع الإجابة ${idx + 1}`)).setStyle(TextInputStyle.Short).setRequired(true).setValue(ev.answers[idx] || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('starter').setLabel(fitTextInputLabel('الجملة الافتتاحية (ثابتة)')).setStyle(TextInputStyle.Short).setRequired(true).setValue(ev.starterWord || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel(fitTextInputLabel('الإيموجي')).setStyle(TextInputStyle.Short).setRequired(true).setValue(ev.reactEmoji || g.settings.emoji || '✅'))
    );
    return interaction.showModal(modal);
  }
  if (interaction.customId.startsWith('event_set_answer_modal_')) {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    const idx = Number(interaction.customId.split('_').pop());
    const ev = g.activeEvent || g.pendingEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    ev.answers[idx] = interaction.fields.getTextInputValue('ans').trim();
    ev.starterWord = interaction.fields.getTextInputValue('starter').trim();
    ev.reactEmoji = interaction.fields.getTextInputValue('emoji').trim();
    writeData(data);
    return interaction.reply({ content: `✅ تم حفظ الإجابة ${idx + 1}.`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_set_correct_text') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    const ev = g.activeEvent || g.pendingEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId('event_set_correct_text_modal').setTitle('نص الإجابة الصحيحة');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel(fitTextInputLabel('اتركه فارغًا للإلغاء')).setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(ev.correctAnswerText || '')));
    return interaction.showModal(modal);
  }
  if (interaction.customId === 'event_set_correct_text_modal') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    const ev = g.activeEvent || g.pendingEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    ev.correctAnswerText = interaction.fields.getTextInputValue('text').trim();
    writeData(data);
    return interaction.reply({ content: ev.correctAnswerText ? '✅ تم تفعيل نص الإجابة الصحيحة.' : '✅ تم إيقاف نص الإجابة الصحيحة (سيبقى الرياكت فقط).', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_set_toggle_here') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    g.settings.mentionHere = !g.settings.mentionHere; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: `✅ منشن here: ${g.settings.mentionHere ? 'مفعل' : 'مغلق'}`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_set_toggle_members') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    g.settings.mentionMembers = !g.settings.mentionMembers; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: `✅ منشن everyone: ${g.settings.mentionMembers ? 'مفعل' : 'مغلق'}`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_set_toggle_embed') {
    if (!canManageEventFlow(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ لا تملك صلاحية.', flags: MessageFlags.Ephemeral });
    g.settings.embedEnabled = !g.settings.embedEnabled; persistSettings(data, interaction.guild.id);
    return interaction.reply({ content: `✅ الإيمبد: ${g.settings.embedEnabled ? 'مفعل' : 'مغلق'}`, flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_set_start') {
    const ev = g.activeEvent;
    if (!ev) return interaction.reply({ content: '❌ لا توجد فعالية.', flags: MessageFlags.Ephemeral });
    if (![ev.creatorId, ev.organizerId].includes(interaction.user.id) && !isApprover(interaction.member, g, BOT_OWNERS)) return interaction.reply({ content: '❌ فقط المنظم/الصاحب/المعتمد.', flags: MessageFlags.Ephemeral });
    ev.paused = false; ev.status = 'running'; ev.startedBy = interaction.user.id; ev.startedAt = now();
    writeData(data);
    await scheduleEventLifecycle(client || interaction.client, interaction.guild.id);
    return interaction.reply({ content: `**🚀 بدأت الفعالية!**\n**تنتهي عند:** **<t:${Math.floor(ev.endAt / 1000)}:F>** • **<t:${Math.floor(ev.endAt / 1000)}:R>**`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'event_log_from_panel') {
    const items = g.history.slice(0, 10);
    const desc = items.length ? items.map((h, i) => `#${i + 1} **${h.name}** | ${h.type}\nالوقت: <t:${Math.floor(h.startAt / 1000)}:F>\nالصاحب: <@${h.creatorId}> | المنظم: ${h.organizerId ? `<@${h.organizerId}>` : 'لا يوجد'}\nالفائز: ${h.winnerId ? `<@${h.winnerId}>` : 'لا يوجد'}\nالحالة: ${h.status}${h.rejectReason ? `\nسبب الرفض: ${h.rejectReason}` : ''}`).join('\n\n') : 'لا يوجد سجل حالياً.';
    return interaction.reply({ embeds: [colorManager.createEmbed().setTitle('سجل الفعاليات').setDescription(desc)], flags: MessageFlags.Ephemeral });
  }
  if (interaction.customId === 'event_top_from_panel') {
    const top = data.top[interaction.guild.id] || {};
    const sorted = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const desc = sorted.length ? sorted.map(([u, p], i) => `#${i + 1} - <@${u}> : **${p}**`).join('\n') : 'لا يوجد نقاط بعد.';
    return interaction.reply({ embeds: [colorManager.createEmbed().setTitle('التوب الكامل لكل الفعاليات').setDescription(desc)], flags: MessageFlags.Ephemeral });
  }

  return false;
}

ensureRouterRegistered();
module.exports = { name, execute, handleInteraction, initialize };
