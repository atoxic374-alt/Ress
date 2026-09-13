// masoul.js (refactor-in-place)
// يحافظ على نفس الواجهة والاعتمادات الخارجية
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const { checkCooldown, startCooldown } = require('./cooldown.js');
const { isUserBlocked } = require('./block.js');
const fs = require('fs');
const path = require('path');
const ticketState = require('./ticket.js');

// ===== إعدادات عامة =====
const DEBUG = false;
const dataDir = path.join(__dirname, '..', 'data');
const DATA_FILES = {
  points: path.join(dataDir, 'points.json'),
  botConfig: path.join(dataDir, 'botConfig.json')
};
const MAX_CONCURRENT_OPERATIONS = 5;
const CLAIM_ID_HARD_LIMIT = 95; // الهامش أقل من 100 تجنباً لأي زيادات عشوائية
const MODAL_TTL_MS = 10 * 60 * 1000; // 10 دقائق

// ===== أدوات JSON =====
function readJSONFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            if (!data || data.trim() === '') return defaultValue;
            return JSON.parse(data);
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error.message);
        return defaultValue;
    }
}

// تحسين قراءة إعدادات التقارير مع كاش بسيط
const reportsCache = new Map();
function loadCurrentReportsConfig(guildId) {
  const now = Date.now();
  if (reportsCache.has(guildId)) {
    const cached = reportsCache.get(guildId);
    if (now - cached.timestamp < 30000) return cached.data; // كاش لمدة 30 ثانية
  }

  try {
    const reportsPath = path.join(__dirname, '..', 'data', 'reports.json');
    if (!fs.existsSync(reportsPath)) return { enabled: false, requiredFor: [] };

    const allReportsConfig = JSON.parse(fs.readFileSync(reportsPath, 'utf8'));
    const config = allReportsConfig[guildId] || (allReportsConfig.enabled !== undefined ? allReportsConfig : { enabled: false, requiredFor: [] });
    
    reportsCache.set(guildId, { timestamp: now, data: config });
    return config;
  } catch (error) {
    return { enabled: false, requiredFor: [] };
  }
}
function writeJSONFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`خطأ في كتابة ${filePath}:`, error);
    return false;
  }
}

// ===== إدارة المهام النشطة =====
let activeTasks = new Map();

function loadActiveTasks() {
  try {
    const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
    if (currentBotConfig.activeTasks) {
      const savedTasks = currentBotConfig.activeTasks;
      for (const [key, value] of Object.entries(savedTasks)) {
        activeTasks.set(key, value);
      }
      console.log(`✅ تم تحميل ${activeTasks.size} مهمة نشطة من JSON في masoul.js`);
    }
  } catch (error) {
    console.error('❌ خطأ في تحميل المهام النشطة في masoul.js:', error);
  }
}
function saveActiveTasks() {
  try {
    const activeTasksObj = {};
    for (const [key, value] of activeTasks.entries()) {
      activeTasksObj[key] = value;
    }
    const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
    currentBotConfig.activeTasks = activeTasksObj;
    writeJSONFile(DATA_FILES.botConfig, currentBotConfig);
    if (DEBUG) console.log(`💾 تم حفظ ${Object.keys(activeTasksObj).length} مهمة نشطة في JSON من masoul.js`);
  } catch (error) {
    console.error('❌ خطأ في حفظ المهام النشطة في masoul.js:', error);
  }
}
loadActiveTasks();

// ===== رد آمن موحّد =====
async function safeReply(interaction, content, options = {}) {
  try {
    if (!interaction || !interaction.isRepliable()) return false;
    const replyOptions = { content, ephemeral: true, ...options };

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(replyOptions);
    } else if (interaction.deferred) {
      await interaction.editReply(replyOptions);
    } else {
      await interaction.followUp(replyOptions);
    }
    return true;
  } catch (error) {
    const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001];
    if (!ignoredCodes.includes(error?.code)) console.error('خطأ في الرد الآمن:', error);
    return false;
  }
}

// ===== أدوات داخلية =====
function createCallEmbed(responsibilityName, reason, userId) {
  return colorManager.createEmbed()
    .setTitle('استدعاء مسؤول')
    .setDescription(`**تم استدعاؤك من قِبل أحد الإداريين**\n\n**المسؤولية :** ${responsibilityName}\n**السبب :** ${reason}\n**من قِبل :** <@${userId}>`)
    .setFooter({ text: ' By Ahmed.' })
    .setThumbnail('https://cdn.discordapp.com/emojis/1303973825591115846.png?v=1')
    .setTimestamp();
}

function loadAdminRolesOnce() {
  try {
    const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
    if (fs.existsSync(adminRolesPath)) {
      const data = fs.readFileSync(adminRolesPath, 'utf8');
      const adminRoles = JSON.parse(data);
      return Array.isArray(adminRoles) ? adminRoles : [];
    }
    return [];
  } catch (error) {
    console.error('خطأ في قراءة adminRoles:', error);
    return [];
  }
}

function ensureClientMaps(client) {
  if (!client.modalData) client.modalData = new Map();
}

/** تقليم customId إذا تجاوز الحد حتى لا يفشل */
function buildClaimCustomId(responsibilityName, timestamp, requesterId, originalChannelId, originalMessageId) {
  let cid = `claim_task_${responsibilityName}_${timestamp}_${requesterId}_${originalChannelId}_${originalMessageId}`;
  if (cid.length > CLAIM_ID_HARD_LIMIT) {
    // نسقط messageId أولاً (أقل شيء يؤثر)
    cid = `claim_task_${responsibilityName}_${timestamp}_${requesterId}_${originalChannelId}_unknown`;
    if (cid.length > CLAIM_ID_HARD_LIMIT) {
      // نسقط أيضًا channelId كحل أخير
      cid = `claim_task_${responsibilityName}_${timestamp}_${requesterId}_unknown_unknown`;
    }
  }
  return cid;
}

// ===== معالج زر الاستلام =====
async function handleClaimButton(interaction, context) {
  const { client, responsibilities, points, scheduleSave, reportsConfig } = context;
  try {
    if (!interaction || !interaction.isRepliable()) return;

    // منع التكرار
    if (interaction.replied || interaction.deferred) return;

    // ✅ الرد السريع على التفاعل لتجنب انتهاء الصلاحية
    await interaction.deferUpdate().catch(() => {});

    const parts = interaction.customId.split('_');
    if (parts.length < 4) {
      return safeReply(interaction, '**خطأ في معرف المهمة!**');
    }

    const responsibilityName = parts[2];
    const timestamp = parts[3];
    const requesterId = parts[4] || '0';
    const originalChannelId = parts[5] || null;
    const originalMessageId = parts[6] || 'unknown';
    const taskId = `${responsibilityName}_${timestamp}`;

    // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
    let currentResponsibilities = {};
    try {
      const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
      if (fs.existsSync(responsibilitiesPath)) {
        const data = fs.readFileSync(responsibilitiesPath, 'utf8');
        currentResponsibilities = JSON.parse(data);
      }
    } catch (error) {
      console.error('خطأ في إعادة تحميل المسؤوليات:', error);
      currentResponsibilities = responsibilities;
    }

    if (!currentResponsibilities[responsibilityName]) {
      console.log(`❌ المسؤولية غير موجودة: ${responsibilityName}`);
      const errorEmbed = colorManager.createEmbed()
        .setDescription('**المسؤولية غير موجودة أو تم حذفها. حاول مرة أخرى.**')
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400667127089856522/1224078115479883816.png?ex=688d786a&is=688c26ea&hm=690357effa104ec0a7e2f728ed55058d79d7a50475dcf981a7e0e6ded68d2c97&');
      return safeReply(interaction, '', { embeds: [errorEmbed] });
    }

    if (activeTasks.has(taskId)) {
      const claimedBy = activeTasks.get(taskId);
      const claimedEmbed = colorManager.createEmbed()
        .setDescription(`**تم استلام هذه المهمة من قبل ${claimedBy}**`)
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400676711439273994/1320524603868712960.png?ex=688d8157&is=688c2fd7&hm=2f0fcafb0d4dd4fc905d6c5c350cfafe7d68e902b5668117f2e7903a62c8&');
      return safeReply(interaction, '', { embeds: [claimedEmbed] });
    }

    const guild = interaction.guild || client.guilds.cache.first();
    let displayName = interaction.user.username;

    try {
      if (guild) {
        const member = await guild.members.fetch(interaction.user.id);
        displayName = member.displayName || member.user.displayName || member.user.username;
      }
    } catch { /* ignore */ }

    // استبدال Array.forEach(async) بـ for...of وتحسين جلب الأعضاء
    for (const userId of responsibleIds) {
        try {
            // جلب العضو الفردي بدلاً من جلب الجميع
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) continue;
            
            // ... بقية المنطق هنا
        } catch (error) {
            console.error(`Error fetching member ${userId}:`, error);
        }
    }

    console.log(`📝 السبب المستخرج: "${reason}"`);

    // CRITICAL: Check if task is already active before proceeding
    if (activeTasks.has(taskId)) {
      const claimedBy = activeTasks.get(taskId);
      const claimedEmbed = colorManager.createEmbed()
        .setDescription(`**تم استلام هذه المهمة من قبل ${claimedBy}**`)
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400676711439273994/1320524603868712960.png?ex=688d8157&is=688c2fd7&hm=2f0fcafb0d4dd4fc905d6c5c350cfafe7d68e902b5668117f2e7903a62c8&');
      return safeReply(interaction, '', { embeds: [claimedEmbed] });
    }

    // Mark task as active immediately to prevent race conditions
    activeTasks.set(taskId, displayName);
    saveActiveTasks();

    // Cancel reminder if it exists
    const notificationsCommand = client.commands.get('notifications');
    if (notificationsCommand?.cancelTaskTracking) {
      notificationsCommand.cancelTaskTracking(taskId);
    }

    // تحقق من نظام التقارير (قراءة فقط)
    // الحصول على السيرفر الصحيح من القناة الأصلية
    let guildId = null;

    try {
      if (originalChannelId) {
        const channel = await client.channels.fetch(originalChannelId).catch(() => null);
        if (channel && channel.guild) {
          guildId = channel.guild.id;
        }
      }

      // fallback: استخدام أول سيرفر إذا لم نستطع الحصول على السيرفر من القناة
      if (!guildId) {
        guildId = client.guilds.cache.first()?.id;
      }
    } catch (error) {
      console.error('❌ خطأ في الحصول على معرف السيرفر:', error);
      guildId = client.guilds.cache.first()?.id;
    }

    if (!guildId) {
      console.error('❌ لم يتم العثور على معرف السيرفر');
      return;
    }

    console.log(`🔍 فحص نظام التقارير للمسؤولية: ${responsibilityName} في السيرفر: ${guildId}`);

    const currentReportsConfig = loadCurrentReportsConfig(guildId);
    console.log(`📋 إعدادات التقارير المحملة للسيرفر ${guildId}:`, {
      enabled: currentReportsConfig.enabled,
      pointsOnReport: currentReportsConfig.pointsOnReport,
      requiredFor: currentReportsConfig.requiredFor,
      approvalRequiredFor: currentReportsConfig.approvalRequiredFor,
      responsibilityName: responsibilityName,
      fullConfig: currentReportsConfig
    });

    const isReportRequired = currentReportsConfig &&
                           currentReportsConfig.enabled &&
                           Array.isArray(currentReportsConfig.requiredFor) &&
                           currentReportsConfig.requiredFor.includes(responsibilityName);

    if (isReportRequired) {
            const reportId = `${interaction.user.id}_${Date.now()}`;

            // إنشاء بيانات التقرير المعلق
            const pendingReportData = {
                claimerId: interaction.user.id,
                displayName: displayName,
                responsibilityName,
                requesterId,
                timestamp,
                reason: reason, // استخدام السبب المستخرج من الـ Embed
                originalChannelId: originalChannelId,
                originalMessageId: originalMessageId,
                createdAt: Date.now(),
                guildId: guildId // إضافة معرف السيرفر
            };

            // حفظ التقرير المعلق
            if (!client.pendingReports) {
                client.pendingReports = new Map();
            }
            client.pendingReports.set(reportId, pendingReportData);
            scheduleSave();

            // منح النقطة فوراً إذا كان النظام لا يتطلب تقرير للنقاط
            if (!currentReportsConfig.pointsOnReport) {
                ticketState.addPointsForResponsibility({
                  responsibilityName,
                  userId: interaction.user.id,
                  actorId: interaction.user.id,
                  source: 'masoul_claim'
                });
            }

            const reportEmbed = colorManager.createEmbed()
                .setTitle(' ✅️ Claims')
                .setDescription(`**هذه المهمة تتطلب تقريراً بعد الإنتهاء منها.**\n\n**السبب الاولي :** ${reason}\n\nيرجى الضغط على الزر أدناه لكتابة التقرير.`)
                .setFooter({text: 'By Ahmed.'});

            const writeReportButton = new ButtonBuilder()
                .setCustomId(`report_write_${reportId}`)
                .setLabel('Write')
                .setEmoji('<:emoji_35:1430331052773081181>')
                .setStyle(ButtonStyle.Secondary);

            const components = [writeReportButton];

            // إضافة رابط الرسالة الصحيح
            if (originalMessageId && originalChannelId && originalMessageId !== 'unknown' && guildId) {
                const url = `https://discord.com/channels/${guildId}/${originalChannelId}/${originalMessageId}`;
                components.push(new ButtonBuilder().setLabel('message').setEmoji('<:emoji_30:1430329732951707770>').setStyle(ButtonStyle.Link).setURL(url));
            }

            const row = new ActionRowBuilder().addComponents(components);

            await interaction.editReply({ embeds: [reportEmbed], components: [row] });
    } else {
        // --- ORIGINAL LOGIC for tasks NOT requiring a report ---
        // Award points immediately
        ticketState.addPointsForResponsibility({
          responsibilityName,
          userId: interaction.user.id,
          actorId: interaction.user.id,
          source: 'masoul_claim'
        });

        // زر رابط الرسالة (إن أمكن)
        const finalChannelId = originalChannelId || interaction.channelId;
        const finalMessageId = originalMessageId !== 'unknown' ? originalMessageId : null;
        const guildId = interaction.guild?.id || interaction.guildId || guild?.id;

        let claimedButtonRow = null;
        if (finalMessageId && guildId && finalChannelId && /^\d{17,19}$/.test(finalMessageId)) {
          const url = `https://discord.com/channels/${guildId}/${finalChannelId}/${finalMessageId}`;
          const goBtn = new ButtonBuilder().setLabel('Message Link').setEmoji('<:emoji_30:1430329732951707770>').setStyle(ButtonStyle.Link).setURL(url);
          claimedButtonRow = new ActionRowBuilder().addComponents(goBtn);
        }

        const claimedEmbed = colorManager.createEmbed()
          .setDescription(`**✅ تم استلام المهمة من قبل <@${interaction.user.id}> (${displayName})**\n\n**السبب كان :** ${reason}`)
          .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400676711439273994/1320524603868712960.png?ex=688d8157&is=688c2fd7&hm=2f0fcafb0d4dd4fc905d6c5c350cfafe7d68e902b5668117f2e7903a62c8&');

        await interaction.editReply({ embeds: [claimedEmbed], components: claimedButtonRow ? [claimedButtonRow] : [] });

        // تنبيه الطالب
        try {
          const requester = await client.users.fetch(requesterId);
          const requesterSuccessEmbed = colorManager.createEmbed()
            .setDescription(`**✅ تم استلام طلب خاص لمسؤول الـ${responsibilityName} وهو <@${interaction.user.id}> (${displayName})**`)
            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400676711439273994/1320524603868712960.png?ex=688d8157&is=688c2fd7&hm=2f0fcafb0d4dd4fc905d6c5c350cfafe7d68e902b5668117f2e7903a62c8&');

          const dmPayload = { embeds: [requesterSuccessEmbed] };
          if (claimedButtonRow) dmPayload.components = [claimedButtonRow];
          await requester.send(dmPayload);
        } catch (e) {
          if (DEBUG) console.log('تعذر إرسال DM للطالب:', e?.message);
        }

        // Log
        logEvent(client, guild, {
          type: 'TASK_LOGS',
          title: 'Task Claimed',
          description: `Responsibility: **${responsibilityName}**`,
          user: interaction.user,
          fields: [
            { name: 'Claimed By', value: `<@${interaction.user.id}> (${displayName})`, inline: true },
            { name: 'Requester', value: `<@${requesterId}>`, inline: true },
            { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true }
          ]
        });
    }
  } catch (error) {
    console.error('خطأ في معالجة زر الاستلام:', error);
    await safeReply(interaction, '**حدث خطأ أثناء استلام المهمة.**');
  }
}

const name = 'مسؤول';

async function execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, ADMIN_ROLES, client }) {
  // بلوك
  if (isUserBlocked(message.author.id)) {
    const blockedEmbed = colorManager.createEmbed()
      .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
      .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));
    await message.channel.send({ embeds: [blockedEmbed] });
    return;
  }

  const activeOperations = new Set();
  async function manageConcurrentOperation(operationId, operation) {
    if (activeOperations.size >= MAX_CONCURRENT_OPERATIONS) {
      throw new Error('تم الوصول للحد الأقصى من العمليات المتزامنة');
    }
    activeOperations.add(operationId);
    try {
      return await operation();
    } finally {
      activeOperations.delete(operationId);
    }
  }
  async function handleInteractionError(interaction, error) {
    console.error('Error in interaction handler:', error);
    const ignored = [10008, 40060, 10062, 10003, 50013, 50001];
    if (!ignored.includes(error?.code)) await safeReply(interaction, '**حدث خطأ أثناء معالجة الطلب.**');
  }

  // تعريف الصلاحيات في البداية
  const CURRENT_ADMIN_ROLES = loadAdminRolesOnce();
  const member = await message.guild.members.fetch(message.author.id);
  const hasAdminRole = member.roles.cache.some(role => CURRENT_ADMIN_ROLES.includes(role.id));
  const hasAdministrator = member.permissions.has('Administrator');
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;

  // اختصار: مسؤوليات
  if (args[0] === 'مسؤوليات') {
    await handleResponsibilitiesCommand(message, args.slice(1), responsibilities, client, BOT_OWNERS);
    return;
  }

  // أمر sg - للأونرات فقط
  if (args[0] === 'sg') {
    if (!isOwner) {
      await message.react('❌');
      return;
    }
    await handleSgCommand(message, responsibilities, client);
    return;
  }

  // منشن مباشر = عرض مسؤولياته
  if (message.mentions.users.size > 0) {
    if (!isOwner) { await message.react('❌'); return; }
    const targetUser = message.mentions.users.first();
    await showUserResponsibilities(message, targetUser, responsibilities, client);
    return;
  }

  if (!hasAdminRole && !isOwner && !hasAdministrator) {
    await message.react('❌');
    return;
  }

  // قائمة المسؤوليات مع pagination
  const { createPaginatedResponsibilityMenu, handlePaginationInteraction } = require('../utils/responsibilityPagination.js');
  
  // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
  let currentResponsibilities = {};
  try {
    const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
    if (fs.existsSync(responsibilitiesPath)) {
      const data = fs.readFileSync(responsibilitiesPath, 'utf8');
      const allResponsibilities = JSON.parse(data);
      
      // تصفية المسؤوليات المخفية - عرض الظاهرة فقط
      currentResponsibilities = {};
      for (const [name, data] of Object.entries(allResponsibilities)) {
        if (data.hidden !== true) {
          currentResponsibilities[name] = data;
        }
      }
    } else {
      currentResponsibilities = responsibilities;
    }
  } catch (error) {
    console.error('خطأ في إعادة تحميل المسؤوليات:', error);
    currentResponsibilities = responsibilities;
  }

  if (Object.keys(currentResponsibilities).length === 0) {
    const errorEmbed = colorManager.createEmbed()
      .setDescription('**لا توجد مسؤوليات ظاهرة حتى الآن.**')
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');
    return message.channel.send({ embeds: [errorEmbed] });
  }

  const pagination = createPaginatedResponsibilityMenu(currentResponsibilities, 0, 'masoul_select_responsibility', 'اختر مسؤولية');

  const cancelButton = new ButtonBuilder()
    .setCustomId('cancel_masoul_menu')
    .setLabel('cancel')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('❌');

  const buttonRow = new ActionRowBuilder().addComponents(cancelButton);

  const sentMessage = await message.channel.send({
    content: '**اختر مسؤولية من القائمة :**',
    components: [...pagination.components, buttonRow]
  });

  const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
  const collector = message.channel.createMessageComponentCollector({ filter, time: 60000 });

  let currentPage = 0;

  collector.on('collect', async interaction => {
    try {
      if (!interaction || !interaction.isRepliable()) return;
      if (interaction.replied || interaction.deferred) return;

      // معالجة pagination
      const paginationAction = handlePaginationInteraction(interaction, 'masoul_select_responsibility');
      if (paginationAction) {
        if (paginationAction.action === 'next') currentPage++;
        else if (paginationAction.action === 'prev') currentPage--;
        
        // إعادة تحميل المسؤوليات قبل التنقل مع تصفية المخفية
        let freshResponsibilities = {};
        try {
          const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
          if (fs.existsSync(responsibilitiesPath)) {
            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
            const allResponsibilities = JSON.parse(data);
            
            // تصفية المسؤوليات المخفية
            freshResponsibilities = {};
            for (const [name, data] of Object.entries(allResponsibilities)) {
              if (data.hidden !== true) {
                freshResponsibilities[name] = data;
              }
            }
          } else {
            freshResponsibilities = responsibilities;
          }
        } catch (error) {
          console.error('خطأ في إعادة تحميل المسؤوليات للتنقل:', error);
          freshResponsibilities = responsibilities;
        }

        const newPagination = createPaginatedResponsibilityMenu(freshResponsibilities, currentPage, 'masoul_select_responsibility', 'اختر مسؤولية');
        currentPage = newPagination.currentPage;
        
        await interaction.update({ content: '**اختر مسؤولية من القائمة :**', components: [...newPagination.components, buttonRow] });
        return;
      }

      if (interaction.customId === 'cancel_masoul_menu') {
        collector.stop('cancelled');
        await interaction.update({ content: '**تم كنسلت القائمة.**', embeds: [], components: [] });
        return;
      }

      if (interaction.customId === 'masoul_select_responsibility') {
        const selected = interaction.values[0];
        
        // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
        let currentResponsibilities = {};
        try {
          const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
          if (fs.existsSync(responsibilitiesPath)) {
            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
            currentResponsibilities = JSON.parse(data);
          }
        } catch (error) {
          console.error('خطأ في إعادة تحميل المسؤوليات:', error);
          currentResponsibilities = responsibilities;
        }
        
        const responsibility = currentResponsibilities[selected];
        if (!responsibility) {
          return interaction.reply({ content: '**المسؤولية غير موجودة!**', ephemeral: true });
        }

        // بناء الأزرار
        const buttons = [];
        if (responsibility.responsibles?.length > 0) {
          const responsibilityName = selected;
          const responsibles = responsibility.responsibles;
          const maxButtons = 20; // نترك مساحة لزر "الكل" والإلغاء في صف مستقل
          const responsibleCount = Math.min(responsibles.length, maxButtons - 1);

          // استيراد vacationManager للفحص
          const vacationManager = require('../utils/vacationManager.js');

          for (let i = 0; i < responsibleCount; i++) {
            try {
              const user = await client.users.fetch(responsibles[i]);
              let displayName = user.username;
              try {
                const member = await message.guild.members.fetch(responsibles[i]);
                displayName = member.displayName || member.nickname || user.username;
              } catch { /* ignore */ }

              // فحص حالة الإجازة
              const isOnVacation = vacationManager.isUserOnVacation(responsibles[i]);
              const buttonLabel = isOnVacation ?
                `${displayName.substring(0, 15)} 🏖️` :
                `${displayName.substring(0, 20)}`;
              const buttonStyle = isOnVacation ? ButtonStyle.Secondary : ButtonStyle.Primary;

              buttons.push(
                new ButtonBuilder()
                  .setCustomId(`masoul_contact_${responsibilityName}_${responsibles[i]}_${Date.now()}`)
                  .setLabel(buttonLabel)
                  .setStyle(buttonStyle)
              );
            } catch {
              buttons.push(
                new ButtonBuilder()
                  .setCustomId(`masoul_contact_${responsibilityName}_${responsibles[i]}_${Date.now()}`)
                  .setLabel(`مسؤول ${i + 1}`)
                  .setStyle(ButtonStyle.Primary)
              );
            }
          }

          if (buttons.length > 0) {
            buttons.push(
              new ButtonBuilder()
                .setCustomId(`masoul_contact_${responsibilityName}_all_${Date.now()}`)
                .setLabel('الكل')
                .setStyle(ButtonStyle.Success)
            );
          }
        }

        // صفوف الأزرار (5 كحد أقصى)
        const rows = [];
        for (let i = 0; i < buttons.length && rows.length < 4; i += 5) {
          const slice = buttons.slice(i, i + 5);
          if (slice.length > 0) rows.push(new ActionRowBuilder().addComponents(slice));
        }

        // صف إلغاء مستقل
        const cancelRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('cancel_masoul_menu').setLabel('cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

        const desc = responsibility.description || '**No desc.**';
        const contactEmbed = colorManager.createEmbed()
          .setTitle('** Call resb **')
          .setDescription(`**Res :** __${selected}___\n**Desc :** **${desc}**`)
          .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400658571925917707/1303973825591115846.png?ex=688d7072&is=688c1ef2&hm=b7426eb45bc266fb56bd7db0095d9ee331bfcbe8d3a13d95a7b735c185662aaf&');

        await interaction.reply({
          embeds: [contactEmbed],
          components: [...rows, cancelRow],
          ephemeral: true
        });

        // تحديث القائمة الرئيسية بعد ثانيتين مع pagination
        setTimeout(async () => {
          try {
            // إعادة تحميل المسؤوليات
            let freshResponsibilities = {};
            try {
              const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
              if (fs.existsSync(responsibilitiesPath)) {
                const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                freshResponsibilities = JSON.parse(data);
              } else {
                freshResponsibilities = responsibilities;
              }
            } catch (error) {
              console.error('خطأ في إعادة تحميل المسؤوليات:', error);
              freshResponsibilities = responsibilities;
            }

            const newPagination = createPaginatedResponsibilityMenu(freshResponsibilities, currentPage, 'masoul_select_responsibility', 'اختر مسؤولية');
            await sentMessage.edit({ content: '**اختر مسؤولية من القائمة:**', components: [...newPagination.components, buttonRow] });
          } catch (error) {
            if (DEBUG) console.error('Failed to update menu:', error);
          }
        }, 2000);
      }
    } catch (error) {
      console.error('خطأ في معالج المودال:', error);
      await handleInteractionError(interaction, error);
    }
  });

  // كولجنونitor أزرار التواصل + الإلغاء
  const buttonCollector = message.channel.createMessageComponentCollector({
    filter: i => i.user.id === message.author.id && (i.customId.startsWith('masoul_contact_') || i.customId === 'cancel_masoul_menu'),
    time: 600000
  });

  buttonCollector.on('collect', async interaction => {
    const operationId = `masoul_${interaction.user.id}_${Date.now()}`;
    try {
      await manageConcurrentOperation(operationId, async () => {
        if (!interaction || !interaction.isRepliable()) return;
        if (interaction.replied || interaction.deferred) return;

        if (interaction.customId === 'cancel_masoul_menu') {
          try {
            await interaction.update({ content: '**تم إلغاء العملية.**', embeds: [], components: [] });
          } catch (error) {
            if (DEBUG) console.error('خطأ في معالجة زر الإلغاء:', error);
          }
          return;
        }

        const parts = interaction.customId.split('_');
        const responsibilityName = parts[2];
        const target = parts[3]; // userId or 'all'

        // فحص حالة الإجازة للهدف المحدد
        const vacationManager = require('../utils/vacationManager.js');
        if (target !== 'all') {
          const isOnVacation = vacationManager.isUserOnVacation(target);
          if (isOnVacation) {
            return interaction.reply({
              content: `**🏖️ المسؤول المحدد في إجازة حالياً. يرجى اختيار مسؤول آخر أو "الكل".**`,
              ephemeral: true
            });
          }
        }

        // كولداون
        const cooldownTime = checkCooldown(interaction, responsibilityName);
        if (cooldownTime > 0) {
          return interaction.reply({
            content: `**لقد استخدمت هذا الأمر مؤخرًا. يرجى الانتظار ${Math.ceil(cooldownTime / 1000)} ثانية أخرى.**`,
            ephemeral: true
          });
        }
        startCooldown(interaction.user.id, responsibilityName);

        // ربط الرسالة الأصلية
        const originalChannelId = message.channelId;
        const originalMessageId = message.id;

        // مودال السبب
        const shortId = Date.now().toString().slice(-8);
        const modal = new ModalBuilder().setCustomId(`masoul_modal_${shortId}`).setTitle('سبب الطلب');
        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('اكتب سبب طلب المساعدة')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('مثال: أحتاج مساعدة في حل مشكلة تقنية')
          .setMaxLength(1000);
        const reasonRow = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(reasonRow);

        ensureClientMaps(client);
        client.modalData.set(shortId, {
          responsibilityName,
          target,
          userId: interaction.user.id,
          timestamp: Date.now(),
          originalChannelId,
          originalMessageId,
          _expires: Date.now() + MODAL_TTL_MS
        });

        // تنظيف تلقائي بعد انتهاء المهلة
        setTimeout(() => {
          const data = client.modalData.get(shortId);
          if (data && Date.now() > data._expires) client.modalData.delete(shortId);
        }, MODAL_TTL_MS + 1000);

        await interaction.showModal(modal);

        // Log
        logEvent(client, interaction.guild, {
          type: 'TASK_LOGS',
          title: 'Contacting Responsible Member',
          description: `**اداري يتواصل مع مسؤول "__${responsibilityName}__"**`,
          user: interaction.user,
          fields: [{ name: '**الهدف**', value: target === 'all' ? '**الكل**' : `<@${target}>` }]
        });
      });
    } catch (error) {
      console.error('خطأ في معالج الأزرار:', error);
      const ignored = [10008, 40060, 10062, 10003, 50013, 50001];
      if (ignored.includes(error?.code)) return;
      await safeReply(interaction, '**حدث خطأ أثناء معالجة الطلب.**');
    }
  });

  collector.on('end', (collected, reason) => {
    if (reason === 'time') {
      try {
        sentMessage.edit({ components: [] }).catch(() => {});
      } catch (error) {
        console.error('خطأ في تعطيل المكونات:', error);
      }
    }
  });
}

async function handleResponsibilitiesCommand(message, args, responsibilities, client, BOT_OWNERS) {
  const CURRENT_ADMIN_ROLES = loadAdminRolesOnce();
  const member = await message.guild.members.fetch(message.author.id);
  const hasAdminRole = member.roles.cache.some(role => CURRENT_ADMIN_ROLES.includes(role.id));
  const hasAdministrator = member.permissions.has('Administrator');
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;

  if (!hasAdminRole && !isOwner && !hasAdministrator) {
    await message.react('❌');
    return;
  }

  if (args.length === 0) {
    const helpEmbed = colorManager.createEmbed()
      .setTitle('مسؤوليات Command')
      .setDescription('**استخدم الأمر لفحص مسؤوليات شخص معين**')
      .addFields([
        { name: '**الاستخدام**', value: '**`مسؤوليات @user`**', inline: false },
        { name: '**مثال**', value: '**`مسؤوليات @احمد`**', inline: false }
      ])
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400637278900191312/images__7_-removebg-preview.png?ex=688d5c9d&is=688c0b1d&hm=8d5c6d761dcf9bda65af44b9de09a2817cbc273f061eb1e39cc8ac20de37cfc0&');
    await message.channel.send({ embeds: [helpEmbed] });
    return;
  }

  let targetUser = null;
  if (message.mentions.users.size > 0) {
    targetUser = message.mentions.users.first();
  } else {
    const userId = args[0].replace(/[<@!>]/g, '');
    try {
      targetUser = await client.users.fetch(userId);
    } catch {
      const errorEmbed = colorManager.createEmbed()
        .setDescription('**لم يتم العثور على المستخدم. تأكد من منشنته أو كتابة ايديه صحيح.**')
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');
      await message.channel.send({ embeds: [errorEmbed] });
      return;
    }
  }

  await showUserResponsibilities(message, targetUser, responsibilities, client);
}

async function handleSgCommand(message, responsibilities, client) {
  // قراءة المسؤوليات من الملف
  let currentResponsibilities = {};
  try {
    const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
    if (fs.existsSync(responsibilitiesPath)) {
      const data = fs.readFileSync(responsibilitiesPath, 'utf8');
      currentResponsibilities = JSON.parse(data);
    }
  } catch (error) {
    console.error('خطأ في تحميل المسؤوليات:', error);
    currentResponsibilities = responsibilities;
  }

  if (Object.keys(currentResponsibilities).length === 0) {
    const errorEmbed = colorManager.createEmbed()
      .setDescription('**لا توجد مسؤوليات معرفة حتى الآن.**')
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');
    return message.channel.send({ embeds: [errorEmbed] });
  }

  // إنشاء select menu متعدد الاختيارات
  const respEntries = Object.entries(currentResponsibilities);
  const visibleResponsibilities = respEntries.filter(([_, data]) => data.hidden !== true).map(([name]) => name);
  
  const options = respEntries.map(([name, data]) => ({
    label: name.substring(0, 100),
    value: name,
    description: (data.hidden ? '❌ مخفية' : '✅ ظاهرة'),
    default: data.hidden !== true
  }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('sg_multi_select')
    .setPlaceholder('✅️ = ظاهرة')
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(options);

  const saveButton = new ButtonBuilder()
    .setCustomId('sg_save_changes')
    .setLabel('Save')
    .setStyle(ButtonStyle.Success);

  const cancelButton = new ButtonBuilder()
    .setCustomId('sg_cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Danger);

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);
  const buttonRow = new ActionRowBuilder().addComponents(saveButton, cancelButton);

  const instructionEmbed = colorManager.createEmbed()
    .setTitle('Hide res system')
    .setDescription('**اختر المسؤوليات التي تريد إظهارها في أمر مسؤول**\n\n✅ = المسؤوليات المحددة ستظهر\n❌ = غير المحددة ستختفي\n\n**اضغط على "save" بعد الانتهاء**')
    .setThumbnail('https://cdn.discordapp.com/emojis/1303973825591115846.png?v=1')
    .addFields({
      name: 'المسؤوليات الظاهرة حالياً',
      value: visibleResponsibilities.length > 0 ? visibleResponsibilities.join(', ') : 'لا يوجد'
    });

  const sentMessage = await message.channel.send({
    embeds: [instructionEmbed],
    components: [selectRow, buttonRow]
  });

  const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
  const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });

  let selectedResponsibilities = [...visibleResponsibilities];

  collector.on('collect', async interaction => {
    try {
      if (!interaction || !interaction.isRepliable()) return;
      if (interaction.replied || interaction.deferred) return;

      if (interaction.customId === 'sg_multi_select') {
        selectedResponsibilities = interaction.values;
        
        const updateEmbed = colorManager.createEmbed()
          .setTitle(' Hide res system')
          .setDescription('**اختر المسؤوليات التي تريد إظهارها في أمر مسؤول**\n\n✅ = المسؤوليات المحددة ستظهر\n❌ = غير المحددة ستختفي\n\n**اضغط على "save" بعد الانتهاء**')
          .setThumbnail('https://cdn.discordapp.com/emojis/1303973825591115846.png?v=1')
          .addFields({
            name: 'المسؤوليات المختارة للظهور',
            value: selectedResponsibilities.length > 0 ? selectedResponsibilities.join(', ') : 'لا يوجد'
          });

        await interaction.update({ embeds: [updateEmbed] });
        return;
      }

      if (interaction.customId === 'sg_save_changes') {
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        const data = fs.readFileSync(responsibilitiesPath, 'utf8');
        const allResponsibilities = JSON.parse(data);

        // تحديث حالة كل المسؤوليات
        for (const [name, respData] of Object.entries(allResponsibilities)) {
          if (selectedResponsibilities.includes(name)) {
            respData.hidden = false;
          } else {
            respData.hidden = true;
          }
        }

        // حفظ التغييرات
        fs.writeFileSync(responsibilitiesPath, JSON.stringify(allResponsibilities, null, 2));

        const visibleCount = selectedResponsibilities.length;
        const hiddenCount = Object.keys(allResponsibilities).length - visibleCount;

        const confirmEmbed = colorManager.createEmbed()
          .setDescription(`**✅ تم حفظ التغييرات بنجاح**\n\n المسؤوليات الظاهرة : ${visibleCount}\n المسؤوليات المخفية : ${hiddenCount}`)
          .setThumbnail('https://cdn.discordapp.com/emojis/1303973825591115846.png?v=1')
          .addFields({
            name: 'المسؤوليات الظاهرة',
            value: selectedResponsibilities.length > 0 ? selectedResponsibilities.join(', ') : 'لا يوجد'
          });

        await interaction.update({ embeds: [confirmEmbed], components: [] });
        collector.stop();
        return;
      }

      if (interaction.customId === 'sg_cancel') {
        await interaction.update({ content: '**تم إلغاء العملية.**', embeds: [], components: [] });
        collector.stop();
        return;
      }
    } catch (error) {
      console.error('خطأ في معالج sg:', error);
    }
  });

  collector.on('end', (collected, reason) => {
    if (reason === 'time') {
      sentMessage.edit({ components: [] }).catch(() => {});
    }
  });
}

async function showUserResponsibilities(message, targetUser, responsibilities, client) {
  const userResponsibilities = [];
  for (const [respName, respData] of Object.entries(responsibilities)) {
    if (respData.responsibles && respData.responsibles.includes(targetUser.id)) {
      userResponsibilities.push({ name: respName });
    }
  }

  if (userResponsibilities.length === 0) {
    const noRespEmbed = colorManager.createEmbed()
      .setDescription(`**${targetUser.username} ليس لديه أي مسؤوليات**`)
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png?ex=688d1f34&is=688bcdb4&hm=40da8d91a92062c95eb9d48f307697ec0010860aca64dd3f8c3c045f3c2aa13a&');
    await message.channel.send({ embeds: [noRespEmbed] });
  } else {
    let responsibilitiesList = '';
    userResponsibilities.forEach((resp, index) => {
      responsibilitiesList += `**${index + 1}.** ${resp.name}\n`;
    });

    const respEmbed = colorManager.createEmbed()
      .setTitle(`مسؤوليات ${targetUser.username}`)
      .setDescription(responsibilitiesList)
      .setColor('#000000')
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
      .addFields([
        { name: 'Total Res', value: `${userResponsibilities.length}`, inline: true },
        { name: 'User', value: `<@${targetUser.id}>`, inline: true }
      ])
      .setFooter({ text: 'By Ahmed.' })
      .setTimestamp();

    await message.channel.send({ embeds: [respEmbed] });
  }
}

// ===== معالج call_reason_modal (من bot.js) =====
async function handleCallReasonModal(interaction, context) {
  const { client, responsibilities } = context;

  if (!interaction || !interaction.isModalSubmit()) {
    console.log('تفاعل مودال غير صالح');
    return;
  }

  const now = Date.now();
  const interactionTime = interaction.createdTimestamp;
  const timeDiff = now - interactionTime;

  if (timeDiff > 13 * 60 * 1000) {
    console.log('تم تجاهل مودال منتهي الصلاحية');
    return;
  }

  if (interaction.replied || interaction.deferred) {
    console.log('تم تجاهل تفاعل متكرر في نموذج الاستدعاء');
    return;
  }

  const customIdParts = interaction.customId.replace('call_reason_modal_', '').split('_');
  const responsibilityName = customIdParts[0];
  const target = customIdParts[1];
  const reason = interaction.fields.getTextInputValue('reason').trim() || 'لا يوجد سبب محدد';

  // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
  let currentResponsibilities = {};
  try {
    const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
    if (fs.existsSync(responsibilitiesPath)) {
      const data = fs.readFileSync(responsibilitiesPath, 'utf8');
      currentResponsibilities = JSON.parse(data);
    } else {
      currentResponsibilities = responsibilities;
    }
  } catch (error) {
    console.error('خطأ في إعادة تحميل المسؤوليات:', error);
    currentResponsibilities = responsibilities;
  }

  if (!currentResponsibilities[responsibilityName]) {
    return interaction.reply({ content: '**المسؤولية غير موجودة!**', ephemeral: true });
  }

  const responsibility = currentResponsibilities[responsibilityName];
  const responsibles = responsibility.responsibles || [];

  if (responsibles.length === 0) {
    return interaction.reply({ content: '**لا يوجد مسؤولين معينين لهذه المسؤولية.**', ephemeral: true });
  }

  const originalChannelId = interaction.channelId;
  const originalMessageId = interaction.message?.id;

  const embed = colorManager.createEmbed()
    .setTitle(`Call from owner.`)
    .setDescription(`**المسؤولية:** ${responsibilityName}\n**السبب:** ${reason}\n**المستدعي:** <@${interaction.user.id}>`)
    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
    .setFooter({ text: 'يُرجى الضغط على زر للوصول للاستدعاء  '});

  const goButton = new ButtonBuilder()
    .setCustomId(`go_to_call_${originalChannelId}_${originalMessageId}_${interaction.user.id}`)
    .setLabel('🔗 الذهاب للرسالة')
    .setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${interaction.guildId || '@me'}/${originalChannelId}/${originalMessageId}`);

  const buttonRow = new ActionRowBuilder().addComponents(goButton);

  if (target === 'all') {
    let sentCount = 0, failedCount = 0;
    for (const userId of responsibles) {
      try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [embed], components: [buttonRow] });
        sentCount++;
      } catch (error) {
        failedCount++;
        console.error(`Failed to send DM to user ${userId}:`, error);
      }
    }

    await interaction.reply({ content: `** تم إرسال الاستدعاء  لـ ${sentCount} من المسؤولين.**${failedCount > 0 ? `\n**⚠️ فشل الإرسال لـ ${failedCount} مسؤول (قد تكون الرسائل الخاصة مغلقة).**` : ''}`, ephemeral: true });
  } else {
    try {
      const user = await client.users.fetch(target);
      await user.send({ embeds: [embed], components: [buttonRow] });

      await interaction.reply({ content: `** تم إرسال الاستدعاء  إلى <@${target}>.**`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: '**فشل في إرسال الرسالة الخاصة.**', ephemeral: true });
    }
  }

  logEvent(client, interaction.guild, {
    type: 'ADMIN_CALLS',
    title: 'Admin Call Requested',
    description: `Admin called responsibility: **${responsibilityName}**`,
    user: interaction.user,
    fields: [
      { name: 'Reason', value: reason, inline: false },
      { name: 'Target', value: target === 'all' ? 'All' : `<@${target}>`, inline: true }
    ]
  });
}

// ===== معالج masoul_modal (من bot.js) =====
async function handleMasoulModal(interaction, context) {
  const { client, responsibilities, scheduleSave } = context;

  try {
    const shortId = interaction.customId.replace('masoul_modal_', '');
    console.log(`[MASOUL] shortId: ${shortId}`);
    const modalData = client.modalData?.get(shortId);
    console.log(`[MASOUL] modalData:`, modalData);

    if (!modalData) {
      return await safeReply(interaction, '**❌ انتهت صلاحية هذا النموذج. حاول مرة أخرى.**');
    }

    const { responsibilityName, target, userId, timestamp, originalChannelId, originalMessageId } = modalData;

    if (interaction.replied || interaction.deferred) return;

    try {
      const reason = interaction.fields.getTextInputValue('reason').trim() || 'لا يوجد سبب محدد';

      // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
      let currentResponsibilities = {};
      try {
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        if (fs.existsSync(responsibilitiesPath)) {
          const data = fs.readFileSync(responsibilitiesPath, 'utf8');
          currentResponsibilities = JSON.parse(data);
        }
      } catch (error) {
        console.error('خطأ في إعادة تحميل المسؤوليات:', error);
        currentResponsibilities = responsibilities;
      }

      if (!currentResponsibilities[responsibilityName]) {
        return await safeReply(interaction, '**❌ المسؤولية غير موجودة!**');
      }

      const responsibility = currentResponsibilities[responsibilityName];
      const responsibles = responsibility.responsibles || [];

      if (responsibles.length === 0) {
        return await safeReply(interaction, '**❌ لا يوجد مسؤولين معينين لهذه المسؤولية.**');
      }

      const embed = createCallEmbed(responsibilityName, reason, userId);

      const claimCustomId = buildClaimCustomId(
        responsibilityName,
        timestamp,
        userId,
        originalChannelId,
        originalMessageId || 'unknown'
      );

      const claimButton = new ButtonBuilder().setCustomId(claimCustomId).setLabel('Claim').setEmoji('<:emoji_7:1431072296709390388>').setStyle(ButtonStyle.Secondary);

      const guildId = interaction.guildId;
      let goToMessageButton = null;
      if (
        originalMessageId && originalMessageId !== 'unknown' &&
        guildId && originalChannelId && /^\d{17,19}$/.test(originalMessageId)
      ) {
        const messageUrl = `https://discord.com/channels/${guildId}/${originalChannelId}/${originalMessageId}`;
        goToMessageButton = new ButtonBuilder().setLabel('Message Link').setEmoji('<:emoji_7:1431072267068244180>').setStyle(ButtonStyle.Link).setURL(messageUrl);
      }

      const buttonRow = new ActionRowBuilder().addComponents(
        claimButton,
        ...(goToMessageButton ? [goToMessageButton] : [])
      );

      if (target === 'all') {
        let sentCount = 0, failedCount = 0, onVacationCount = 0;
        const vacationManager = require('../utils/vacationManager.js');

        for (const uid of responsibles) {
          try {
            // فحص حالة الإجازة
            if (vacationManager.isUserOnVacation(uid)) {
              onVacationCount++;
              continue;
            }

            const user = await client.users.fetch(uid);
            await user.send({ embeds: [embed], components: [buttonRow] });
            sentCount++;
          } catch (err) {
            failedCount++;
            if (DEBUG) console.log(`فشل إرسال DM لـ ${uid}:`, err.message);
          }
        }

        const taskId = `${responsibilityName}_${timestamp}`;
        const notificationsCommand = client.commands.get('notifications');
        if (notificationsCommand?.trackTask) {
          notificationsCommand.trackTask(taskId, responsibilityName, responsibles, client);
        }

        let replyMessage = `**✅ تم إرسال الطلب لـ ${sentCount} من المسؤولين.**`;
        if (failedCount > 0) replyMessage += `\n**⚠️ فشل الإرسال لـ ${failedCount} مسؤول (رسائل خاصة مغلقة).**`;
        if (onVacationCount > 0) replyMessage += `\n**🏖️ تم تخطي ${onVacationCount} مسؤول في إجازة.**`;

        await safeReply(interaction, replyMessage);

      } else {
        try {
          const user = await client.users.fetch(target);
          let displayName = user.username;

          try {
            const member = await interaction.guild.members.fetch(target);
            displayName = member.displayName || member.nickname || user.username;
          } catch { /* ignore */ }

          await user.send({ embeds: [embed], components: [buttonRow] });

          const taskId = `${responsibilityName}_${timestamp}`;
          const notificationsCommand = client.commands.get('notifications');
          if (notificationsCommand?.trackTask) {
            notificationsCommand.trackTask(taskId, responsibilityName, [target], client);
          }

          await safeReply(interaction, `**✅ تم إرسال طلب خاص لمسؤول ${displayName}.**`);

        } catch (error) {
          console.error('خطأ في إرسال DM للمسؤول:', error);

          let errorMessage = '**❌ فشل في إرسال الرسالة الخاصة.**';
          if (error?.code === 50007) {
            errorMessage = '**❌ لا يمكن إرسال رسالة خاصة للمستخدم. الرسائل الخاصة مغلقة.**';
          } else if (error?.code === 10013) {
            errorMessage = '**❌ المستخدم غير موجود أو غير متاح.**';
          } else if (error?.code === 50001) {
            errorMessage = '**❌ البوت لا يملك صلاحية لإرسال رسائل خاصة.**';
          } else if (error?.code === 10062) {
            errorMessage = '**❌ انتهت صلاحية التفاعل. حاول مرة أخرى.**';
          }

          await safeReply(interaction, errorMessage);
        }
      }

      // Log
      try {
        logEvent(client, interaction.guild, {
          type: 'TASK_LOGS',
          title: 'Task Requested',
          description: `Responsibility: **${responsibilityName}**`,
          user: interaction.user,
          fields: [
            { name: 'Reason', value: reason, inline: false },
            { name: 'Target', value: target === 'all' ? 'All' : `<@${target}>`, inline: true }
          ]
        });
      } catch (logError) {
        if (DEBUG) console.error('خطأ في تسجيل اللوق:', logError);
      }

      client.modalData?.delete(shortId);

    } catch (error) {
      console.error('خطأ في معالجة مودال masoul:', error);
      await safeReply(interaction, '**❌ حدث خطأ أثناء معالجة الطلب. حاول مرة أخرى.**');
      client.modalData?.delete(shortId);
    }

  } catch (error) {
    console.error('خطأ في معالج masoul_modal:', error);
    await safeReply(interaction, '**❌ حدث خطأ أثناء معالجة الطلب.**');
  }
}

// ===== معالج go_to_call (من bot.js) =====
async function handleGoToCall(interaction, context) {
  const { client } = context;

  try {
    if (interaction.replied || interaction.deferred) {
      console.log('تم تجاهل تفاعل متكرر في زر الذهاب');
      return;
    }

    const parts = interaction.customId.replace('go_to_call_', '').split('_');
    const channelId = parts[0];
    const messageId = parts[1];
    const adminId = parts[2];

    const disabledButton = new ButtonBuilder()
      .setCustomId(`go_to_call_${channelId}_${messageId}_${adminId}_disabled`)
      .setLabel('تم الاستجابة')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const disabledRow = new ActionRowBuilder().addComponents(disabledButton);

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      return interaction.reply({ content: '**لم يتم العثور على القناة!**', ephemeral: true });
    }

    const jumpLink = `https://discord.com/channels/${interaction.guild?.id || '@me'}/${channelId}/${messageId}`;

    const responseEmbed = colorManager.createEmbed()
      .setDescription(`**✅ تم استلام الاستدعاء من <@${adminId}>**`)
      .addFields([{ name: '\u200B', value: `[**اضغط هنا للذهاب للرسالة**](${jumpLink})`}])
      .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&');

    await interaction.update({
      embeds: [interaction.message.embeds[0]],
      components: [disabledRow]
    });

    await interaction.followUp({ embeds: [responseEmbed], ephemeral: true });

    try {
      const admin = await client.users.fetch(adminId);
      const notificationEmbed = colorManager.createEmbed()
        .setDescription(`**تم الرد على استدعائك من قبل <@${interaction.user.id}>**`)
        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&');

      await admin.send({ embeds: [notificationEmbed] });

      logEvent(client, interaction.guild, {
        type: 'ADMIN_CALLS',
        title: 'Admin Call Response',
        description: `Response to admin call received`,
        user: interaction.user,
        fields: [
          { name: 'Admin', value: `<@${adminId}>`, inline: true },
          { name: 'Channel', value: `<#${channelId}>`, inline: true }
        ]
      });
    } catch (error) {
      console.log(`لا يمكن إرسال إشعار للمشرف ${adminId}: ${error.message}`);
    }

  } catch (error) {
    console.error('خطأ في معالجة زر الذهاب:', error);
    await safeReply(interaction, '**حدث خطأ أثناء معالجة الطلب.**');
  }
}

// ===== نقطة دخول التفاعلات =====
async function handleInteraction(interaction, context) {
  const { client, responsibilities, points, scheduleSave, reportsConfig } = context;
  try {
    console.log(`[MASOUL] معالجة تفاعل: ${interaction.customId}`);

    if (interaction.isButton() && interaction.customId.startsWith('claim_task_')) {
      console.log('[MASOUL] معالجة claim_task');
      await handleClaimButton(interaction, context);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('call_reason_modal_')) {
      console.log('[MASOUL] معالجة call_reason_modal');
      await handleCallReasonModal(interaction, context);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('go_to_call_')) {
      console.log('[MASOUL] معالجة go_to_call');
      await handleGoToCall(interaction, context);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('masoul_modal_')) {
      console.log('[MASOUL] معالجة masoul_modal');
      const shortId = interaction.customId.replace('masoul_modal_', '');
      console.log(`[MASOUL] shortId: ${shortId}`);
      const modalData = client.modalData?.get(shortId);
      console.log(`[MASOUL] modalData:`, modalData);

      if (!modalData) {
        return await safeReply(interaction, '**❌ انتهت صلاحية هذا النموذج. حاول مرة أخرى.**');
      }

      const { responsibilityName, target, userId, timestamp, originalChannelId, originalMessageId } = modalData;

      if (interaction.replied || interaction.deferred) return;

      try {
        let reason = 'لا يوجد سبب محدد';
        try {
          reason = interaction.fields.getTextInputValue('reason').trim();
          if (!reason) reason = 'لا يوجد سبب محدد';
        } catch (fieldError) {
          console.error('خطأ في قراءة حقل السبب:', fieldError);
        }
        console.log(`📝 السبب من الـ Modal: "${reason}"`);

        // إعادة تحميل المسؤوليات من الملف للتأكد من أحدث البيانات
        let currentResponsibilities = {};
        try {
          const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
          if (fs.existsSync(responsibilitiesPath)) {
            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
            currentResponsibilities = JSON.parse(data);
          }
        } catch (error) {
          console.error('خطأ في إعادة تحميل المسؤوليات:', error);
          currentResponsibilities = responsibilities;
        }

        if (!currentResponsibilities[responsibilityName]) {
          return await safeReply(interaction, '**❌ المسؤولية غير موجودة!**');
        }

        const responsibility = currentResponsibilities[responsibilityName];
        const responsibles = responsibility.responsibles || [];

        if (responsibles.length === 0) {
          return await safeReply(interaction, '**❌ لا يوجد مسؤولين معينين لهذه المسؤولية.**');
        }

        const embed = createCallEmbed(responsibilityName, reason, userId);

        const claimCustomId = buildClaimCustomId(
          responsibilityName,
          timestamp,
          userId,
          originalChannelId,
          originalMessageId || 'unknown'
        );

        const claimButton = new ButtonBuilder().setCustomId(claimCustomId).setLabel('Claim').setStyle(ButtonStyle.Success);

        const guildId = interaction.guildId;
        let goToMessageButton = null;
        if (
          originalMessageId && originalMessageId !== 'unknown' &&
          guildId && originalChannelId && /^\d{17,19}$/.test(originalMessageId)
        ) {
          const messageUrl = `https://discord.com/channels/${guildId}/${originalChannelId}/${originalMessageId}`;
          goToMessageButton = new ButtonBuilder().setLabel('🔗 Message Link').setStyle(ButtonStyle.Link).setURL(messageUrl);
        }

        const buttonRow = new ActionRowBuilder().addComponents(
          claimButton,
          ...(goToMessageButton ? [goToMessageButton] : [])
        );

        if (target === 'all') {
          let sentCount = 0, failedCount = 0, onVacationCount = 0;
          const vacationManager = require('../utils/vacationManager.js');

          for (const uid of responsibles) {
            try {
              // فحص حالة الإجازة
              if (vacationManager.isUserOnVacation(uid)) {
                onVacationCount++;
                continue;
              }

              const user = await client.users.fetch(uid);
              await user.send({ embeds: [embed], components: [buttonRow] });
              sentCount++;
            } catch (err) {
              failedCount++;
              if (DEBUG) console.log(`فشل إرسال DM لـ ${uid}:`, err.message);
            }
          }

          const taskId = `${responsibilityName}_${timestamp}`;
          const notificationsCommand = client.commands.get('notifications');
          if (notificationsCommand?.trackTask) {
            notificationsCommand.trackTask(taskId, responsibilityName, responsibles, client);
          }

          let replyMessage = `**✅ تم إرسال الطلب لـ ${sentCount} من المسؤولين.**`;
          if (failedCount > 0) replyMessage += `\n**⚠️ فشل الإرسال لـ ${failedCount} مسؤول (رسائل خاصة مغلقة).**`;
          if (onVacationCount > 0) replyMessage += `\n**🏖️ تم تخطي ${onVacationCount} مسؤول في إجازة.**`;

          await safeReply(interaction, replyMessage);

        } else {
          try {
            const user = await client.users.fetch(target);
            let displayName = user.username;

            try {
              const member = await interaction.guild.members.fetch(target);
              displayName = member.displayName || member.nickname || user.username;
            } catch { /* ignore */ }

            await user.send({ embeds: [embed], components: [buttonRow] });

            const taskId = `${responsibilityName}_${timestamp}`;
            const notificationsCommand = client.commands.get('notifications');
            if (notificationsCommand?.trackTask) {
              notificationsCommand.trackTask(taskId, responsibilityName, [target], client);
            }

            await safeReply(interaction, `**✅ تم إرسال طلب خاص لمسؤول ${displayName}.**`);

          } catch (error) {
            console.error('خطأ في إرسال DM للمسؤول:', error);

            let errorMessage = '**❌ فشل في إرسال الرسالة الخاصة.**';
            if (error?.code === 50007) {
              errorMessage = '**❌ لا يمكن إرسال رسالة خاصة للمستخدم. الرسائل الخاصة مغلقة.**';
            } else if (error?.code === 10013) {
              errorMessage = '**❌ المستخدم غير موجود أو غير متاح.**';
            } else if (error?.code === 50001) {
              errorMessage = '**❌ البوت لا يملك صلاحية لإرسال رسائل خاصة.**';
            } else if (error?.code === 10062) {
              errorMessage = '**❌ انتهت صلاحية التفاعل. حاول مرة أخرى.**';
            }

            await safeReply(interaction, errorMessage);
          }
        }

        // Log
        try {
          logEvent(client, interaction.guild, {
            type: 'TASK_LOGS',
            title: 'Task Requested',
            description: `Responsibility: **${responsibilityName}**`,
            user: interaction.user,
            fields: [
              { name: 'Reason', value: reason, inline: false },
              { name: 'Target', value: target === 'all' ? 'All' : `<@${target}>`, inline: true }
            ]
          });
        } catch (logError) {
          if (DEBUG) console.error('خطأ في تسجيل اللوق:', logError);
        }

        client.modalData?.delete(shortId);

      } catch (error) {
        console.error('خطأ في معالجة مودال masoul:', error);
        await safeReply(interaction, '**❌ حدث خطأ أثناء معالجة الطلب. حاول مرة أخرى.**');
        client.modalData?.delete(shortId);
      }

      return;
    }
  } catch (error) {
    console.error('خطأ في معالج التفاعلات:', error);
    await safeReply(interaction, '**حدث خطأ أثناء معالجة الطلب.**');
  }
}

module.exports = {
  name,
  execute,
  loadActiveTasks,
  saveActiveTasks,
  handleInteraction,
  activeTasks
};
