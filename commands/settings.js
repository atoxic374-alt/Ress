const { getBotConfigPath } = require('../utils/storagePaths');
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder } = require('discord.js');
const { logEvent } = require('../utils/logs_system.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const fs = require('fs');
const path = require('path');

const name = 'settings';

const activeCommandCollectors = new Map();

const responsibleRolesPath = path.join(__dirname, '..', 'data', 'responsibleRoles.json');

function loadResponsibleRoles() {
  try {
    if (fs.existsSync(responsibleRolesPath)) {
      const data = fs.readFileSync(responsibleRolesPath, 'utf8');
      const roles = JSON.parse(data);
      return Array.isArray(roles) ? roles : [];
    }
    return [];
  } catch (error) {
    console.error('خطأ في قراءة responsibleRoles:', error);
    return [];
  }
}

function saveResponsibleRoles(roles) {
  try {
    const finalRoles = Array.isArray(roles) ? roles : [];
    fs.writeFileSync(responsibleRolesPath, JSON.stringify(finalRoles, null, 2));
    console.log('✅ تم حفظ رولات المسؤولين في JSON');
    return true;
  } catch (error) {
    console.error('خطأ في حفظ responsibleRoles:', error);
    return false;
  }
}

async function execute(message, args, { responsibilities, client, scheduleSave, BOT_OWNERS }) {
  if (activeCommandCollectors.has(message.author.id)) {
    const oldCollector = activeCommandCollectors.get(message.author.id);
    oldCollector.stop('new_command');
  }

  // فحص البلوك أولاً
  if (isUserBlocked(message.author.id)) {
    const blockedEmbed = colorManager.createEmbed()
      .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
      .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

    await message.channel.send({ embeds: [blockedEmbed] });
    return;
  }

  // إعداد قناة ولون توب البونس من مسار settings الحالي؛ ويتولى أمر البونس
  // فحص مسؤولي النظام المحددين لكل سيرفر.
  if (args[0] && ['bonus', 'بونس'].includes(args[0].toLowerCase())) {
    const bonusCommand = require('./bonus.js');
    await bonusCommand.execute(message, args.slice(1), { client, BOT_OWNERS });
    return;
  }

  // تحويل إدارة الرولات الخاصة إذا تم استدعاء settings roles
  if (args[0] && ['roles', 'رولات', 'رول', 'role'].includes(args[0].toLowerCase())) {
    const rolesSettings = require('./roles-settings.js');
    await rolesSettings.executeRolesSettings(message, args.slice(1), { client, BOT_OWNERS });
    return;
  }

  if (global.reloadBotOwners) {
    global.reloadBotOwners();
  }
  const liveBotOwners = Array.isArray(global.BOT_OWNERS) ? global.BOT_OWNERS : BOT_OWNERS;
  const isOwner = liveBotOwners.map(String).includes(String(message.author.id)) || message.guild.ownerId === message.author.id;
  if (!isOwner) {
    await message.react('❌');
    return;
  }

  // === معالجة الأمر الفرعي settings chat ===
  if (args[0] && args[0].toLowerCase() === 'chat') {
    const errorEmbed = colorManager.createEmbed()
      .setDescription('**❌ هذا النظام ملغي، يتم الاستدعاء عبر الخاص حالياً.**');
    await message.channel.send({ embeds: [errorEmbed] });
    return;
  }

  // === معالجة إزالة قناة الاستدعاء ===
  if (args[0] && args[0].toLowerCase() === 'chat' && args[1] && args[1].toLowerCase() === 'remove') {
    const errorEmbed = colorManager.createEmbed()
      .setDescription('**❌ هذا النظام ملغي.**');
    await message.channel.send({ embeds: [errorEmbed] });
    return;
  }

  // دالة لمزامنة الرولات لجميع المسؤولين
  async function syncResponsibilityRoles(responsibilityName, guild) {
    try {
      const responsibility = responsibilities[responsibilityName];
      if (!responsibility || !responsibility.roles || responsibility.roles.length === 0) return;

      const roles = responsibility.roles;
      const responsibleIds = responsibility.responsibles || [];

      // جلب جميع أعضاء السيرفر لضمان دقة الفحص (تحسين: جلب فردي عند الحاجة)
      for (const userId of responsibleIds) {
        try {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (!member) continue;

          for (const roleId of roles) {
            if (!member.roles.cache.has(roleId)) {
              await member.roles.add(roleId, `مزامنة رولات المسؤولية: ${responsibilityName}`).catch(() => {});
            }
          }
        } catch (err) {
          console.error(`خطأ في إضافة رول لمستخدم ${userId}:`, err);
        }
      }
    } catch (error) {
      console.error('خطأ في مزامنة الرولات:', error);
    }
  }

  // مزامنة المسؤوليات مع كائن البوت العالمي أو قاعدة البيانات
  const { dbManager } = require('../utils/database.js');
  if (!global.responsibilities || Object.keys(global.responsibilities).length === 0) {
      const dbResps = await dbManager.getResponsibilities();
      global.responsibilities = dbResps;
  }
  const currentResponsibilities = global.responsibilities;
  
  async function saveResponsibilities() {
    try {
      const { dbManager } = require('../utils/database.js');
      // Update all responsibilities in DB
      for (const [name, config] of Object.entries(responsibilities)) {
        await dbManager.updateResponsibility(name, config);
      }
      global.responsibilities = responsibilities; // مزامنة التحديث العالمي فوراً
      console.log('✅ [SETTINGS] تم حفظ المسؤوليات في قاعدة البيانات وتحديث الكائن العالمي');
      
      // التحديثات اللاحقة
      if (global.client) {
          global.client.emit('responsibilityUpdate');
      }
      return true;
    } catch (error) {
      console.error('❌ [SETTINGS] خطأ في حفظ المسؤوليات:', error.message);
      return false;
    }
  }

  // دالة مساعدة لتحديث الإيمبدات بتأخير
  let updateTimeout = null;
  function updateRespEmbeds(client) {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = setTimeout(() => {
      const respCommand = client.commands.get('resp');
      if (respCommand && respCommand.updateEmbedMessage) {
          respCommand.updateEmbedMessage(client);
      }
      const setupCommand = client.commands.get('setup');
      if (setupCommand && setupCommand.updateAllSetupMenus) {
          setupCommand.updateAllSetupMenus(client);
      }
      console.log('✅ [DEBOUNCED] تم تحديث الإيمبدات');
    }, 3000);
  }

  // دالة لترتيب المسؤوليات حسب خاصية order أو أبجدياً
  function getOrderedResponsibilities() {
    const keys = Object.keys(responsibilities);
    
    // فرز حسب خاصية order إذا كانت موجودة، وإلا أبجدياً
    return keys.sort((a, b) => {
      const orderA = responsibilities[a].order ?? 999999;
      const orderB = responsibilities[b].order ?? 999999;
      
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      
      // إذا كان الترتيب متساوي، فرز أبجدياً
      return a.localeCompare(b, 'ar');
    });
  }
  
  // دالة لإعادة ترقيم المسؤوليات بعد التعديل
  function reorderResponsibilities() {
    const orderedKeys = getOrderedResponsibilities();
    orderedKeys.forEach((key, index) => {
      responsibilities[key].order = index;
    });
  }

  // دالة لإنشاء منيو مقسم إلى صفحات
  function createPaginatedMenu(page = 0) {
    const orderedKeys = getOrderedResponsibilities();
    const ITEMS_PER_PAGE = 24; // ترك مساحة لخيار "الإضافة والإدارة" (المجموع 25)
    const totalPages = Math.ceil(orderedKeys.length / ITEMS_PER_PAGE);
    
    // التأكد من أن رقم الصفحة صحيح
    if (page < 0) page = 0;
    if (page >= totalPages && totalPages > 0) page = totalPages - 1;
    
    const startIndex = page * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, orderedKeys.length);
    const pageKeys = orderedKeys.slice(startIndex, endIndex);
    
    const options = pageKeys.map(key => ({
      label: key,
      description: responsibilities[key].description ? responsibilities[key].description.substring(0, 50) : 'لا يوجد شرح',
      value: key
    }));

    // إضافة خيار إنشاء مسؤولية جديدة
    options.push({
      label: '➕ إضافة مسؤولية جديدة',
      description: 'إنشاء نظام مسؤولية جديد في السيرفر',
      value: 'add_new'
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('settings_select_responsibility')
      .setPlaceholder('اختر مسؤولية')
      .addOptions(options);

    const components = [new ActionRowBuilder().addComponents(selectMenu)];
    
    // إضافة زر مركز رولات المسؤوليات في صف مستقل
    const managementButtonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('responsibility_roles_center_btn')
        .setLabel('Resp Roles')
        .setEmoji('🛠️')
        .setStyle(ButtonStyle.Secondary)
    );
    components.push(managementButtonRow);
    
    // إضافة أزرار التنقل إذا كان هناك أكثر من صفحة
    if (totalPages > 1) {
      const navButtons = [];
      
      if (page > 0) {
        navButtons.push(
          new ButtonBuilder()
            .setCustomId(`page_prev_${page}`)
            .setLabel('◀ السابق')
            .setStyle(ButtonStyle.Primary)
        );
      }
      
      navButtons.push(
        new ButtonBuilder()
          .setCustomId(`page_info_${page}`)
          .setLabel(`صفحة ${page + 1}/${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );
      
      if (page < totalPages - 1) {
        navButtons.push(
          new ButtonBuilder()
            .setCustomId(`page_next_${page}`)
            .setLabel('التالي ▶')
            .setStyle(ButtonStyle.Primary)
        );
      }
      
      components.push(new ActionRowBuilder().addComponents(navButtons));
    }
    
    return { components, currentPage: page, totalPages };
  }

  // تتبع الصفحة الحالية لكل مستخدم
  const userPages = new Map();
  // تتبع جلسة إنشاء رولات المسؤوليات
  const responsibilityRolesSession = new Map();

  function buildResponsibilityRolesModal(step = 0, selectedResponsibilities = []) {
    const startIndex = step * 5;
    const chunk = selectedResponsibilities.slice(startIndex, startIndex + 5);

    const modal = new ModalBuilder()
      .setCustomId(`settings_responsibility_roles_names_modal_${step}`)
      .setTitle(`أسماء رولات المسؤوليات (${step + 1})`);

    chunk.forEach((respName, index) => {
      const absoluteIndex = startIndex + index;
      const roleNameInput = new TextInputBuilder()
        .setCustomId(`resp_role_name_${absoluteIndex}`)
        .setLabel(respName.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(`اسم رول ${respName}`);

      modal.addComponents(new ActionRowBuilder().addComponents(roleNameInput));
    });

    return modal;
  }

  async function finalizeResponsibilityRolesCreation(interaction, { allowPartial = false } = {}) {
    if (!interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply({ content: '**Waiting... جاري إنشاء الرولات وربطها، انتظر قليلاً**' });
      } catch (deferError) {
        console.error('تعذر عمل defer لعملية إنشاء رولات المسؤوليات:', deferError);
      }
    }

    const currentSession = responsibilityRolesSession.get(interaction.user.id);
    if (!currentSession || !currentSession.anchorRoleId || !Array.isArray(currentSession.selectedResponsibilities) || currentSession.selectedResponsibilities.length === 0) {
      await safeReply(interaction, '**انتهت جلسة إنشاء الرولات. أعد المحاولة من القائمة.**');
      return false;
    }

    const selectedResponsibilities = currentSession.selectedResponsibilities.slice(0, 24);
    const anchorRole = await interaction.guild.roles.fetch(currentSession.anchorRoleId).catch(() => null);
    if (!anchorRole) {
      await safeReply(interaction, '**رول المركز غير صالح أو محذوف.**');
      return false;
    }

    const me = await interaction.guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has('ManageRoles')) {
      await safeReply(interaction, '**لا أملك صلاحية إدارة الرولات ( Manage Roles ).**');
      return false;
    }

    const botHighestRole = me.roles.highest;
    if (!botHighestRole || anchorRole.position >= botHighestRole.position) {
      await safeReply(interaction, '**لا يمكن الإنشاء تحت هذا الرول لأن ترتيبه أعلى أو مساوي لرولي الأعلى.**');
      return false;
    }

    const rawNames = selectedResponsibilities.map((respName) => (currentSession.roleNamesByResponsibility?.[respName] || '').trim());
    const fillable = selectedResponsibilities
      .map((respName, index) => ({ respName, roleName: rawNames[index] }))
      .filter((item) => item.roleName.length > 0);

    if (!allowPartial && fillable.length !== selectedResponsibilities.length) {
      await safeReply(interaction, '**يجب إدخال اسم لكل رول.**');
      return false;
    }

    if (fillable.length === 0) {
      await safeReply(interaction, '**لا يوجد أسماء رولات صالحة للإنشاء.**');
      return false;
    }

    const lowerNames = fillable.map((item) => item.roleName.toLowerCase());
    if (new Set(lowerNames).size !== lowerNames.length) {
      await safeReply(interaction, '**يوجد تكرار في أسماء الرولات المدخلة.**');
      return false;
    }

    for (const { respName } of fillable) {
      const respData = responsibilities[respName];
      if (!respData || (Array.isArray(respData.roles) && respData.roles.length > 0)) {
        await safeReply(interaction, `**تم إيقاف العملية لأن المسؤولية "${respName}" مرتبطة مسبقاً.**`);
        return false;
      }
    }

    for (const { roleName } of fillable) {
      const existingRoleByName = interaction.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
      if (existingRoleByName) {
        await safeReply(interaction, `**اسم الرول "${roleName}" مستخدم مسبقاً في السيرفر.**`);
        return false;
      }
    }

    const createdRoles = [];
    try {
      const targetPosition = Math.max(1, anchorRole.position);
      for (const { respName, roleName } of fillable) {
        const createdRole = await interaction.guild.roles.create({
          name: roleName,
          reason: `إنشاء رول مسؤولية للمسؤولية ${respName} بواسطة ${interaction.user.tag}`,
          permissions: []
        });

        await createdRole.setPosition(targetPosition);
        await createdRole.setPermissions([]);

        if (!Array.isArray(responsibilities[respName].roles)) {
          responsibilities[respName].roles = [];
        }
        responsibilities[respName].roles = [createdRole.id];
        createdRoles.push(createdRole);
      }

      const saved = await saveResponsibilities();
      if (!saved) throw new Error('SAVE_FAILED');

      currentSession.selectedResponsibilities = [];
      currentSession.roleNamesByResponsibility = {};
      responsibilityRolesSession.set(interaction.user.id, currentSession);

      updateRespEmbeds(client);
      await safeReply(interaction, `**✅ تم إنشاء ${createdRoles.length} رول وربطها بالمسؤوليات بنجاح.**`);
      await openResponsibilityRolesCenter(interaction);
      return true;
    } catch (error) {
      for (const role of createdRoles) {
        await role.delete('Rollback after creation failure').catch(() => {});
      }
      console.error('خطأ في إنشاء رولات المسؤوليات:', error);
      await safeReply(interaction, '**حدث خطأ أثناء إنشاء الرولات.**');
      return false;
    }
  }

  async function openResponsibilityRolesCenter(interaction) {
    const rows = [];
    const sortedResponsibilities = getOrderedResponsibilities();
    const options = [];

    for (const name of sortedResponsibilities.slice(0, 25)) {
      const respData = responsibilities[name] || {};
      const linkedRoleId = Array.isArray(respData.roles) && respData.roles.length > 0 ? respData.roles[0] : null;
      let linkedRoleName = 'لا يوجد';
      if (linkedRoleId) {
        const role = interaction.guild.roles.cache.get(linkedRoleId);
        linkedRoleName = role ? role.name : 'رول محذوف';
      }

      options.push({
        label: name.length > 90 ? `${name.slice(0, 87)}...` : name,
        value: name,
        description: `رول : ${linkedRoleName}`
      });
    }

    const sessionData = responsibilityRolesSession.get(interaction.user.id) || {
      anchorRoleId: null,
      selectedResponsibilities: []
    };

    const withRoleCount = getOrderedResponsibilities().filter((name) => {
      const respData = responsibilities[name] || {};
      return Array.isArray(respData.roles) && respData.roles.length > 0;
    }).length;

    const statusThumbnail = sessionData.anchorRoleId
      ? (interaction.guild?.iconURL({ dynamic: true, size: 128 }) || client.user.displayAvatarURL({ dynamic: true, size: 128 }))
      : client.user.displayAvatarURL({ dynamic: true, size: 128 });

    let descriptionText = [
      '**إجمالي المسؤوليات**',
      `**${getOrderedResponsibilities().length}**`,
      '',
      '**المسؤوليات المربوطة برول**',
      `**${withRoleCount}**`,
      '',
      '**المسؤوليات بدون رول**',
      `**${Math.max(0, getOrderedResponsibilities().length - withRoleCount)}**`,
      '',
      '**حالة الربط الحالية**'
    ].join('\n');

    const linkingStatus = getOrderedResponsibilities().map((name, idx) => {
      const respData = responsibilities[name] || {};
      const linkedRoleId = Array.isArray(respData.roles) && respData.roles.length > 0 ? respData.roles[0] : null;
      return `**${idx + 1}. ${name}** : ${linkedRoleId ? `<@&${linkedRoleId}>` : '**لا يوجد**'}`;
    });

    // إضافة حالة الربط مع التأكد من عدم تجاوز 1000 حرف
    let statusAdded = 0;
    for (const status of linkingStatus) {
      if ((descriptionText + '\n' + status).length > 800) break;
      descriptionText += '\n' + status;
      statusAdded++;
    }

    if (statusAdded < linkingStatus.length) {
      descriptionText += `\n**+ ${linkingStatus.length - statusAdded} مسؤوليات أخرى**`;
    }

    descriptionText += [
      '',
      '',
      '**رول المركز المحدد**',
      `**${sessionData.anchorRoleId ? `<@&${sessionData.anchorRoleId}>` : '**غير محدد**'}**`,
      '',
      '**سيتم فتح نافذة الأسماء فور اختيار المسؤوليات من القائمة **'
    ].join('\n');

    const embed = colorManager.createEmbed()
      .setTitle('**Resp Roles Settings**')
      .setThumbnail(statusThumbnail)
      .setDescription(descriptionText);

    const anchorRoleMenu = new RoleSelectMenuBuilder()
      .setCustomId('settings_responsibility_roles_anchor_select')
      .setPlaceholder('اختر رول المركز (تنشأ الرولات تحته)')
      .setMinValues(1)
      .setMaxValues(1);

    rows.push(new ActionRowBuilder().addComponents(anchorRoleMenu));

    if (options.length > 0) {
      const responsibilitiesSelect = new StringSelectMenuBuilder()
        .setCustomId('settings_responsibility_roles_multi_select')
        .setPlaceholder('اختر المسؤوليات')
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 24))
        .addOptions(options);

      rows.push(new ActionRowBuilder().addComponents(responsibilitiesSelect));

      const editSelect = new StringSelectMenuBuilder()
        .setCustomId('settings_responsibility_roles_edit_select')
        .setPlaceholder('اختر مسؤولية للتعديل')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options.map((opt) => ({
          label: opt.label,
          value: opt.value,
          description: `تعديل المسؤولية : ${opt.label}`
        })));

      rows.push(new ActionRowBuilder().addComponents(editSelect));
    }

    const deleteBtn = new ButtonBuilder()
      .setCustomId('settings_responsibility_roles_delete_all_btn')
      .setLabel('Remove All Roles')
      .setStyle(ButtonStyle.Danger);

    const backBtn = new ButtonBuilder()
      .setCustomId('back_to_menu')
      .setLabel('الرجوع للقائمة الرئيسية')
      .setStyle(ButtonStyle.Secondary);

    rows.push(new ActionRowBuilder().addComponents(deleteBtn, backBtn));

    if (!interaction.replied && !interaction.deferred) {
      await interaction.update({ embeds: [embed], components: rows });
    } else {
      await interaction.editReply({ embeds: [embed], components: rows });
    }
  }

  async function sendSettingsMenu(page = 0) {
    userPages.set(message.author.id, page);
    
    const embed = colorManager.createEmbed()
      .setTitle('**Res sys**')
      .setDescription('Choose res or edit it')
      .setFooter({ text: 'By Ahmed.' })
      .setThumbnail('https://cdn.discordapp.com/emojis/1186585722401063032.png?v=1');

    const menuData = createPaginatedMenu(page);
    
    const response = await message.channel.send({ embeds: [embed], components: menuData.components });
    return response;
  }

  const sentMessage = await sendSettingsMenu();

  // Collector with a 5-minute timeout
  // لا تلتقط هذه الجلسة أزرار لوحات settings أخرى أو لوحات أوامر مختلفة
  // حتى لا يرد معالج آخر برسالة صلاحيات غير صحيحة.
  const filter = i => i.user.id === message.author.id && (
    i.message?.id === sentMessage.id
    || i.customId?.startsWith('settings_responsibility_roles_open_modal_')
    || i.customId === 'settings_responsibility_roles_finish_create'
  );
  const collector = message.channel.createMessageComponentCollector({ filter, time: 600000 }); // 10 minutes

  activeCommandCollectors.set(message.author.id, collector);

  const refreshInterval = null; // تعطيل التحديث التلقائي لتقليل استهلاك CPU

  collector.on('end', (collected, reason) => {
    collector.removeAllListeners();
    activeCommandCollectors.delete(message.author.id);
    console.log(`Settings collector for ${message.author.id} ended. Reason: ${reason}`);
    if (reason !== 'new_command') {
      sentMessage.edit({ content: '**انتهت صلاحية هذه القائمة.**', components: [] }).catch(() => {});
    }
  });

  async function updateMainMenu(page = null) {
    try {
      // استخدام الصفحة المحفوظة للمستخدم إذا لم يتم تحديد صفحة
      if (page === null) {
        page = userPages.get(message.author.id) || 0;
      } else {
        userPages.set(message.author.id, page);
      }
      
      const embed = colorManager.createEmbed()
        .setTitle('**Res sys**')
        .setDescription('Choose res or edit it')
        .setFooter({ text: 'By Ahmed.' })
        .setThumbnail('https://cdn.discordapp.com/emojis/1186585722401063032.png?v=1');

      const menuData = createPaginatedMenu(page);
      
      await sentMessage.edit({ embeds: [embed], components: menuData.components });
    } catch (error) {
      console.error('خطأ في تحديث المنيو الرئيسي:', error);
    }
  }

  // دالة للعودة إلى صفحة المسؤولية بعد التعديل
  async function updateResponsibilityView(responsibilityName, sourceInteraction = null) {
    try {
      const responsibility = responsibilities[responsibilityName];
      if (!responsibility) {
        await updateMainMenu();
        return;
      }

      const editButton = new ButtonBuilder()
        .setCustomId(`edit_${responsibilityName}`)
        .setLabel('الشرح')
.setEmoji('<:emoji_16:1448570798380945539>')
        .setStyle(ButtonStyle.Secondary);

      const renameButton = new ButtonBuilder()
        .setCustomId(`rename_${responsibilityName}`)
        .setLabel('الأسم')
.setEmoji('<:emoji_14:1448570732652003398>')
        .setStyle(ButtonStyle.Secondary);

      const manageButton = new ButtonBuilder()
        .setCustomId(`manage_${responsibilityName}`)
        .setLabel('المسؤولين')
.setEmoji('<:emoji_17:1448570976097931406>')
        .setStyle(ButtonStyle.Secondary);

      const roleButton = new ButtonBuilder()
        .setCustomId(`role_${responsibilityName}`)
        .setLabel('رول المسؤولية')
.setEmoji('<:emoji_14:1448570758849757285>')
        .setStyle(ButtonStyle.Secondary);

      const mentButton = new ButtonBuilder()
        .setCustomId(`ment_${responsibilityName}`)
        .setLabel('اختصار')
.setEmoji('<:emoji_18:1448572201610776730>')
        .setStyle(ButtonStyle.Secondary);

const deleteButton = new ButtonBuilder()
        .setCustomId(`delete_${responsibilityName}`)
        .setLabel('حذف')
.setEmoji('<:emoji_13:1448570702176452660>')
        .setStyle(ButtonStyle.Danger);

      const orderedKeys = getOrderedResponsibilities();
      const currentIndex = orderedKeys.indexOf(responsibilityName);
      
      const backButton = new ButtonBuilder()
        .setCustomId('back_to_menu')
        .setLabel('main menu')
        .setStyle(ButtonStyle.Secondary);

      const buttonsRow1 = new ActionRowBuilder().addComponents(editButton, renameButton, deleteButton, manageButton, roleButton);
      const buttonsRowMent = new ActionRowBuilder().addComponents(mentButton);
      
      // إنشاء select menu للترتيب (محدود بـ 25 عنصر)
      let positionOptions = orderedKeys.map((key, index) => ({
        label: `${index + 1}. ${key}`,
        value: index.toString(),
        default: index === currentIndex,
        description: index === currentIndex ? '(الموضع الحالي)' : `نقل إلى الموضع ${index + 1}`
      }));

      // إذا كان هناك أكثر من 25 مسؤولية، نحد الخيارات
      if (positionOptions.length > 25) {
        const start = Math.max(0, currentIndex - 12);
        const end = Math.min(orderedKeys.length, currentIndex + 13);
        positionOptions = positionOptions.slice(start, end);
      }

      const components = [buttonsRow1, buttonsRowMent];
      
      if (positionOptions.length > 1) {
        const positionSelect = new StringSelectMenuBuilder()
          .setCustomId(`reorder_${responsibilityName}`)
          .setPlaceholder(' اختر الموضع الجديد للمسؤولية')
          .addOptions(positionOptions);
        const selectRow = new ActionRowBuilder().addComponents(positionSelect);
        components.push(selectRow);
      }

      const buttonsRow2 = new ActionRowBuilder().addComponents(backButton);
      components.push(buttonsRow2);

      const respList = responsibility.responsibles && responsibility.responsibles.length > 0
        ? responsibility.responsibles.map(r => `<@${r}>`).join(', ')
        : '**لا يوجد مسؤولين معينين**';

      const desc = responsibility.description && responsibility.description.toLowerCase() !== 'لا'
        ? responsibility.description
        : '**لا يوجد شرح**';

      const embedEdit = colorManager.createEmbed()
        .setTitle(`**تعديل المسؤولية : ${responsibilityName}**`)
        .setDescription(`**المسؤولون :** ${respList}\n**الشرح :** ${desc}\n**الترتيب :** ${currentIndex + 1} من ${orderedKeys.length}`);

      const payload = { embeds: [embedEdit], components };
      if (sourceInteraction && !sourceInteraction.replied && !sourceInteraction.deferred) {
        await sourceInteraction.update(payload);
      } else {
        await sentMessage.edit(payload);
      }
    } catch (error) {
      console.error('خطأ في تحديث صفحة المسؤولية:', error);
      await updateMainMenu();
    }
  }

  // إدارة الـ collectors النشطة لكل مسؤولية
  const activeCollectors = new Map();

  async function generateManagementContent(responsibilityName) {
    const responsibility = responsibilities[responsibilityName];
    const responsiblesList = responsibility.responsibles || [];
    let responsiblesText = '';

    if (responsiblesList.length > 0) {
      for (let i = 0; i < responsiblesList.length; i++) {
        try {
          const member = await message.guild.members.fetch(responsiblesList[i]);
          responsiblesText += `**${i + 1}.** ${member.displayName || member.user.username} (<@${responsiblesList[i]}>)\n`;
        } catch (error) {
          responsiblesText += `**${i + 1}.** مستخدم محذوف (${responsiblesList[i]})\n`;
        }
      }
    } else {
      responsiblesText = '**لا يوجد مسؤولين معينين**';
    }

    const embed = colorManager.createEmbed()
      .setTitle(`**Manage resb : ${responsibilityName}**`)
      .setDescription(`**المسؤولون الحاليون :**\n${responsiblesText}\n\n**للاضافة منشن وللحذف حط رقم المسؤول وعند الانتهاء اكتب تم**`)
      .setFooter({ text: 'By Ahmed.' });

    const backButton = new ButtonBuilder()
      .setCustomId(`back_to_main_${responsibilityName}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(backButton);
    return { embeds: [embed], components: [row] };
  }

  async function sendResponsibilityMemberDM(targetMember, interaction, responsibilityName, actionType = 'added') {
    try {
      if (!targetMember) return;

      const isAdded = actionType === 'added';
      const actorAvatar = interaction.user.displayAvatarURL({ extension: 'png', size: 128 });

      const notifyEmbed = colorManager.createEmbed()
        .setTitle(isAdded ? '**Responsibility Assignment**' : '**Responsibility Removal**')
        .setDescription(isAdded ? '**تم تحديث صلاحياتك داخل نظام المسؤوليات.**' : '**تم تحديث حالتك داخل نظام المسؤوليات.**')
        .setThumbnail(actorAvatar)
        .addFields(
          { name: 'Action', value: isAdded ? 'تمت إضافتك كمسؤول.' : 'تمت إزالتك من المسؤولية.' },
          { name: 'Responsibility', value: `المسؤولية: **${responsibilityName}**` },
          { name: 'By', value: `تمت العملية بواسطة: <@${interaction.user.id}>` },
          { name: 'Server', value: `داخل سيرفر: **${interaction.guild.name}**` }
        );

      await targetMember.send({ embeds: [notifyEmbed] }).catch(() => {});
    } catch (dmError) {
      console.error('خطأ في إرسال رسالة الخاص للمسؤول:', dmError);
    }
  }

  async function showResponsibleManagement(interaction, responsibilityName) {
    try {
      const responsibility = responsibilities[responsibilityName];
      if (!responsibility) {
        return await safeReply(interaction, '**المسؤولية غير موجودة!**');
      }

      const existingCollector = activeCollectors.get(responsibilityName);
      if (existingCollector) {
        existingCollector.stop('new_session');
        activeCollectors.delete(responsibilityName);
      }

      const content = await generateManagementContent(responsibilityName);
      
      // إضافة زر البحث بعد زر Back
      const searchButton = new ButtonBuilder()
        .setCustomId(`search_${responsibilityName}`)
        .setLabel('🔍 بحث وإضافة')
        .setStyle(ButtonStyle.Success);

      content.components[0].addComponents(searchButton);

      // We need to reply to the interaction first, then we can edit that reply later.
      if (!interaction.replied && !interaction.deferred) {
        await interaction.update(content);
      }

      const messageFilter = m => m.author.id === interaction.user.id && m.channel.id === message.channel.id;
      const messageCollector = message.channel.createMessageCollector({
        filter: messageFilter,
        time: 3600000 // ساعة واحدة
      });

      activeCollectors.set(responsibilityName, messageCollector);

      // إضافة collector للأزرار في صفحة إدارة المسؤولين
      const buttonFilter = i => i.user.id === interaction.user.id && i.customId.startsWith('search_');
      const buttonCollector = message.channel.createMessageComponentCollector({ 
        filter: buttonFilter,
        time: 3600000 // ساعة واحدة
      });

      buttonCollector.on('collect', async (buttonInt) => {
        try {
          if (buttonInt.customId === `search_${responsibilityName}`) {
            // إظهار نافذة البحث عن الأعضاء
            const modal = new ModalBuilder()
              .setCustomId(`search_members_modal_${responsibilityName}`)
              .setTitle('بحث عن أعضاء');

            const searchInput = new TextInputBuilder()
              .setCustomId('search_query')
              .setLabel('اكتب اسم العضو للبحث')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('مثال: Ahmed, محمد, Ali');

            const actionRow = new ActionRowBuilder().addComponents(searchInput);
            modal.addComponents(actionRow);
            await buttonInt.showModal(modal);
          }
        } catch (error) {
          console.error('خطأ في معالج أزرار إدارة المسؤولين:', error);
        }
      });

      messageCollector.on('end', () => {
        buttonCollector.stop();
      });

      messageCollector.on('collect', async (msg) => {
        try {
          await msg.delete().catch(() => {});

          const content = msg.content.trim();
          const lowerContent = content.toLowerCase();

          if (lowerContent === 'تم' || lowerContent === 'done') {
            messageCollector.stop('user_done');
            await updateResponsibilityView(responsibilityName);
            return;
          }

          // محاولة استخراج ID المستخدم من المنشن أو النص
          const mentionMatch = content.match(/^<@!?(\d+)>$/);
          const userId = mentionMatch ? mentionMatch[1] : (content.length >= 17 && /^\d+$/.test(content) ? content : null);

              if (userId) {
                try {
                  const member = await message.guild.members.fetch(userId).catch(() => null);
                  if (!member) {
                    const errorMsg = await message.channel.send(`**❌ المستخدم <@${userId}> غير موجود في السيرفر!**`);
                    setTimeout(() => errorMsg.delete().catch(() => {}), 3000);
                    return;
                  }

                  if (!responsibility.responsibles) responsibility.responsibles = [];
                  
                  if (responsibility.responsibles.includes(userId)) {
                    const errorMsg = await message.channel.send(`**⚠️ <@${userId}> موجود بالفعل في هذه المسؤولية!**`);
                    setTimeout(() => errorMsg.delete().catch(() => {}), 3000);
                    return;
                  }

                  responsibility.responsibles.push(userId);
                  const { dbManager } = require('../utils/database.js');
                  await dbManager.updateResponsibility(responsibilityName, responsibility);
                  
                  await syncResponsibilityRoles(responsibilityName, message.guild);
                  updateRespEmbeds(client);

                  await sendResponsibilityMemberDM(member, interaction, responsibilityName, 'added');

                  const updatedContent = await generateManagementContent(responsibilityName);
                  await sentMessage.edit(updatedContent);
                } catch (error) {
                  console.error('خطأ في إضافة مسؤول:', error);
                }
                return;
              }

          if (/^\d+$/.test(content)) {
            const index = parseInt(content) - 1;
            const currentResponsibles = responsibility.responsibles || [];

            if (index >= 0 && index < currentResponsibles.length) {
              const removedUserId = currentResponsibles[index];

              let removedMember = null;
              try {
                removedMember = await message.guild.members.fetch(removedUserId);
              } catch (error) {
                console.log(`لا يمكن جلب معلومات المستخدم ${removedUserId}`);
              }

      responsibility.responsibles.splice(index, 1);
      const { dbManager } = require('../utils/database.js');
      await dbManager.updateResponsibility(responsibilityName, responsibility);
      
      // مزامنة الرولات
      await syncResponsibilityRoles(responsibilityName, message.guild);

              // تحديث إيمبد Resp
              try {
                const respCommand = client.commands.get('resp');
                if (respCommand && respCommand.updateEmbedMessage) {
                  await respCommand.updateEmbedMessage(client);
                  console.log('✅ [SETTINGS] تم تحديث إيمبد Resp بعد حذف مسؤول');
                }
              } catch (error) {
                console.error('خطأ في تحديث إيمبد Resp:', error);
              }

              // إزالة جميع رولات المسؤولية من المسؤول المحذوف
              if (removedMember && responsibility.roles && responsibility.roles.length > 0) {
                for (const roleId of responsibility.roles) {
                  try {
                    const role = message.guild.roles.cache.get(roleId);
                    if (role && removedMember.roles.cache.has(roleId)) {
                      await removedMember.roles.remove(roleId);
                      console.log(`✅ تم إزالة رول ${role.name} من ${removedMember.displayName}`);
                    }
                  } catch (error) {
                    console.log(`لا يمكن إزالة رول ${roleId} من ${removedUserId}: ${error.message}`);
                  }
                }
              }

              await safeFollowUp(interaction, `**✅ تم حذف المسؤول رقم ${content} بنجاح**`);

              await sendResponsibilityMemberDM(removedMember, interaction, responsibilityName, 'removed');

              logEvent(client, message.guild, {
                type: 'RESPONSIBILITY_MANAGEMENT',
                title: 'تم إزالة مسؤول',
                description: `تم إزالة ${removedMember ? removedMember.displayName : 'مستخدم'} من مسؤولية ${responsibilityName}`,
                user: interaction.user,
                fields: [
                  { name: 'المسؤولية', value: responsibilityName, inline: true },
                  { name: 'المسؤول المُزال', value: `<@${removedUserId}>`, inline: true }
                ]
              });

              // Regenerate and edit the message
              const newContent = await generateManagementContent(responsibilityName);
              await interaction.editReply(newContent);

            } else {
              await safeFollowUp(interaction, '**رقم غير صحيح. يرجى اختيار رقم من القائمة.**');
            }
          } else {
            let userIds = [];

            // جمع جميع المنشنات
            if (msg.mentions.users.size > 0) {
              userIds = [...msg.mentions.users.keys()];
            } else {
              // البحث عن جميع الآي ديات في النص
              const idMatches = content.match(/\d{17,19}/g);
              if (idMatches) {
                userIds = idMatches;
              }
            }

            if (userIds.length > 0) {
              let addedCount = 0;
              let alreadyExistsCount = 0;
              let notFoundCount = 0;
              let addedNames = [];

              for (const userId of userIds) {
                try {
                  const member = await message.guild.members.fetch(userId);
                  const currentResponsibles = responsibility.responsibles || [];

                  if (currentResponsibles.includes(userId)) {
                    alreadyExistsCount++;
                  } else {
                    responsibility.responsibles.push(userId);
                    addedCount++;
                    addedNames.push(member.displayName || member.user.username);

                    // إعطاء المسؤول جميع رولات المسؤولية تلقائياً
                    if (responsibility.roles && responsibility.roles.length > 0) {
                      for (const roleId of responsibility.roles) {
                        try {
                          const role = await message.guild.roles.fetch(roleId);
                          if (role && !member.roles.cache.has(roleId)) {
                            await member.roles.add(roleId, `إضافة رول المسؤولية: ${responsibilityName}`);
                            console.log(`✅ تم إعطاء ${member.displayName} رول ${role.name}`);
                          }
                        } catch (error) {
                          console.log(`❌ لا يمكن إضافة رول ${roleId} لـ ${userId}: ${error.message}`);
                        }
                      }
                    }

                    await sendResponsibilityMemberDM(member, interaction, responsibilityName, 'added');

                    logEvent(client, message.guild, {
                      type: 'RESPONSIBILITY_MANAGEMENT',
                      title: 'تم إضافة مسؤول جديد',
                      description: `تم إضافة ${member.displayName || member.user.username} كمسؤول عن ${responsibilityName}`,
                      user: interaction.user,
                      fields: [
                        { name: 'المسؤولية', value: responsibilityName, inline: true },
                        { name: 'المسؤول الجديد', value: `<@${userId}>`, inline: true }
                      ]
                    });
                  }
                } catch (error) {
                  notFoundCount++;
                }
              }

              // حفظ التغييرات مرة واحدة بعد إضافة الجميع
              if (addedCount > 0) {
                await saveResponsibilities();

                // مزامنة الرولات
                await syncResponsibilityRoles(responsibilityName, message.guild);

                // تحديث إيمبد Resp
                try {
                  const respCommand = client.commands.get('resp');
                  if (respCommand && respCommand.updateEmbedMessage) {
                    await respCommand.updateEmbedMessage(client);
                    console.log('✅ [SETTINGS] تم تحديث إيمبد Resp بعد إضافة مسؤولين');
                  }
                } catch (error) {
                  console.error('خطأ في تحديث إيمبد Resp:', error);
                }
              }

              // إنشاء رسالة النتيجة
              let resultMessage = '';
              if (addedCount > 0) {
                resultMessage += `**✅ تم إضافة ${addedCount} مسؤول:** ${addedNames.join('، ')}\n`;
              }
              if (alreadyExistsCount > 0) {
                resultMessage += `**⚠️ ${alreadyExistsCount} مسؤول موجود بالفعل**\n`;
              }
              if (notFoundCount > 0) {
                resultMessage += `**❌ ${notFoundCount} مستخدم غير موجود**`;
              }

              await safeFollowUp(interaction, resultMessage || '**لم يتم إضافة أي مسؤول**');

              // Regenerate and edit the message
              const newContent = await generateManagementContent(responsibilityName);
              await interaction.editReply(newContent);
            } else {
              await safeFollowUp(interaction, '**يرجى منشن المستخدم أو كتابة الآي دي الصحيح**');
            }
          }
        } catch (error) {
          console.error('خطأ في معالجة رسالة إدارة المسؤولين:', error);
          await safeFollowUp(interaction, '**حدث خطأ أثناء المعالجة**');
        }
      });

      messageCollector.on('end', (collected, reason) => {
        console.log(`انتهى collector إدارة المسؤولين للمسؤولية ${responsibilityName} - السبب: ${reason}`);
        activeCollectors.delete(responsibilityName);
        if (reason !== 'user_done' && reason !== 'new_session') {
            interaction.editReply({ content: '**انتهت مهلة هذا الإجراء.**', embeds:[], components: [] }).catch(()=>{});
        }
      });

    } catch (error) {
      console.error('خطأ في عرض إدارة المسؤولين:', error);
      await safeReply(interaction, '**حدث خطأ في عرض إدارة المسؤولين**');
    }
  }

  async function showRoleManagement(interaction, responsibilityName) {
    try {
      const responsibility = responsibilities[responsibilityName];
      if (!responsibility) {
        return await safeReply(interaction, '**المسؤولية غير موجودة!**');
      }

      // تهيئة حقل roles إن لم يكن موجوداً
      if (!responsibility.roles) {
        responsibility.roles = [];
      }

      const existingCollector = activeCollectors.get(`role_${responsibilityName}`);
      if (existingCollector) {
        existingCollector.stop('new_session');
        activeCollectors.delete(`role_${responsibilityName}`);
      }

      const rolesList = responsibility.roles || [];
      let rolesText = '';

      if (rolesList.length > 0) {
        for (let i = 0; i < rolesList.length; i++) {
          try {
            const role = message.guild.roles.cache.get(rolesList[i]);
            if (role) {
              rolesText += `**${i + 1}.** ${role.name} (<@&${rolesList[i]}>)\n`;
            } else {
              rolesText += `**${i + 1}.** رول محذوف (${rolesList[i]})\n`;
            }
          } catch (error) {
            rolesText += `**${i + 1}.** رول محذوف (${rolesList[i]})\n`;
          }
        }
      } else {
        rolesText = '**لا توجد رولات مضافة**';
      }

      const embed = colorManager.createEmbed()
        .setTitle(`**إدارة رولات: ${responsibilityName}**`)
        .setDescription(`**الرولات الحالية:**\n${rolesText}\n\n**للإضافة منشن رول أو اكتب الآي دي\nللحذف اكتب رقم الرول\nعند الانتهاء اكتب تم**`)
        .setFooter({ text: 'By Ahmed.' });

      const backButton = new ButtonBuilder()
        .setCustomId(`back_to_main_${responsibilityName}`)
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(backButton);
      
      await interaction.update({ embeds: [embed], components: [row] });

      const messageFilter = m => m.author.id === interaction.user.id && m.channel.id === message.channel.id;
      const messageCollector = message.channel.createMessageCollector({
        filter: messageFilter,
        time: 3600000 // ساعة واحدة
      });

      activeCollectors.set(`role_${responsibilityName}`, messageCollector);

      messageCollector.on('collect', async (msg) => {
        try {
          await msg.delete().catch(() => {});

          const content = msg.content.trim();
          const lowerContent = content.toLowerCase();

          if (lowerContent === 'تم' || lowerContent === 'done') {
            messageCollector.stop('user_done');
            await updateResponsibilityView(responsibilityName);
            return;
          }

          // التحقق من حذف رول بالرقم
          if (/^\d+$/.test(content)) {
            const index = parseInt(content) - 1;
            const currentRoles = responsibility.roles || [];

            if (index >= 0 && index < currentRoles.length) {
              const removedRoleId = currentRoles[index];
              const role = message.guild.roles.cache.get(removedRoleId);

              responsibility.roles.splice(index, 1);
              await saveResponsibilities();

              // إزالة الرول من جميع المسؤولين الحاليين
              let removedCount = 0;
              if (role) {
                for (const responsibleId of (responsibility.responsibles || [])) {
                  try {
                    const member = await message.guild.members.fetch(responsibleId);
                    if (member.roles.cache.has(removedRoleId)) {
                      await member.roles.remove(removedRoleId);
                      removedCount++;
                      console.log(`✅ تم إزالة رول ${role.name} من ${member.displayName}`);
                    }
                  } catch (error) {
                    console.log(`لا يمكن إزالة الرول من ${responsibleId}: ${error.message}`);
                  }
                }
              }

              await safeFollowUp(interaction, `**✅ تم حذف الرول رقم ${content} بنجاح**${removedCount > 0 ? `\n**تم إزالة الرول من ${removedCount} مسؤول**` : ''}`);

              logEvent(client, message.guild, {
                type: 'RESPONSIBILITY_MANAGEMENT',
                title: 'تم حذف رول من مسؤولية',
                description: `تم حذف رول ${role ? role.name : removedRoleId} من مسؤولية ${responsibilityName}${removedCount > 0 ? ` وإزالته من ${removedCount} مسؤول` : ''}`,
                user: interaction.user,
                fields: [
                  { name: 'المسؤولية', value: responsibilityName, inline: true },
                  { name: 'الرول المحذوف', value: role ? `<@&${removedRoleId}>` : removedRoleId, inline: true },
                  { name: 'تمت الإزالة من', value: `${removedCount} مسؤول`, inline: true }
                ]
              });

              // تحديث العرض
              await updateRoleDisplay();
            } else {
              await safeFollowUp(interaction, '**رقم غير صحيح. يرجى اختيار رقم من القائمة.**');
            }
          } else {
            // إضافة رول جديد
            let roleId = null;

            if (msg.mentions.roles.size > 0) {
              roleId = msg.mentions.roles.first().id;
            } else {
              const idMatch = content.match(/\d{17,19}/);
              if (idMatch) {
                roleId = idMatch[0];
              }
            }

            if (roleId) {
              try {
                const role = await message.guild.roles.fetch(roleId);
                if (!role) {
                  return await safeFollowUp(interaction, '**الرول غير موجود!**');
                }

                // التحقق من عدم وجود الرول في مسؤولية أخرى
                for (const [respName, resp] of Object.entries(responsibilities)) {
                  if (respName !== responsibilityName && resp.roles && resp.roles.includes(roleId)) {
                    return await safeFollowUp(interaction, `**⚠️ هذا الرول موجود بالفعل في مسؤولية: ${respName}**\n**لا يمكن استخدام نفس الرول في مسؤوليتين مختلفتين!**`);
                  }
                }

                const currentRoles = responsibility.roles || [];
                if (currentRoles.includes(roleId)) {
                  await safeFollowUp(interaction, '**هذا الرول موجود بالفعل!**');
                } else {
                  responsibility.roles.push(roleId);
                  await saveResponsibilities();

                  // إعطاء الرول لجميع المسؤولين الحاليين
                  for (const responsibleId of (responsibility.responsibles || [])) {
                    try {
                      const member = await message.guild.members.fetch(responsibleId);
                      if (!member.roles.cache.has(roleId)) {
                        await member.roles.add(roleId);
                      }
                    } catch (error) {
                      console.log(`لا يمكن إضافة الرول لـ ${responsibleId}: ${error.message}`);
                    }
                  }

                  await safeFollowUp(interaction, `**✅ تم إضافة الرول ${role.name} بنجاح**`);

                  logEvent(client, message.guild, {
                    type: 'RESPONSIBILITY_MANAGEMENT',
                    title: 'تم إضافة رول لمسؤولية',
                    description: `تم إضافة رول ${role.name} لمسؤولية ${responsibilityName}`,
                    user: interaction.user,
                    fields: [
                      { name: 'المسؤولية', value: responsibilityName, inline: true },
                      { name: 'الرول الجديد', value: `<@&${roleId}>`, inline: true }
                    ]
                  });

                  // تحديث العرض
                  await updateRoleDisplay();
                }
              } catch (error) {
                await safeFollowUp(interaction, '**لم يتم العثور على الرول!**');
              }
            } else {
              await safeFollowUp(interaction, '**يرجى منشن الرول أو كتابة الآي دي الصحيح**');
            }
          }

          async function updateRoleDisplay() {
            const rolesList = responsibility.roles || [];
            let rolesText = '';

            if (rolesList.length > 0) {
              for (let i = 0; i < rolesList.length; i++) {
                try {
                  const role = message.guild.roles.cache.get(rolesList[i]);
                  if (role) {
                    rolesText += `**${i + 1}.** ${role.name} (<@&${rolesList[i]}>)\n`;
                  } else {
                    rolesText += `**${i + 1}.** رول محذوف (${rolesList[i]})\n`;
                  }
                } catch (error) {
                  rolesText += `**${i + 1}.** رول محذوف (${rolesList[i]})\n`;
                }
              }
            } else {
              rolesText = '**لا توجد رولات مضافة**';
            }

            const embed = colorManager.createEmbed()
              .setTitle(`**إدارة رولات: ${responsibilityName}**`)
              .setDescription(`**الرولات الحالية:**\n${rolesText}\n\n**للإضافة منشن رول أو اكتب الآي دي\nللحذف اكتب رقم الرول\nعند الانتهاء اكتب تم**`)
              .setFooter({ text: 'By Ahmed.' });

            const backButton = new ButtonBuilder()
              .setCustomId(`back_to_main_${responsibilityName}`)
              .setLabel('Back')
              .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(backButton);
            
            await interaction.editReply({ embeds: [embed], components: [row] });
          }
        } catch (error) {
          console.error('خطأ في معالجة رسالة إدارة الرولات:', error);
          await safeFollowUp(interaction, '**حدث خطأ أثناء المعالجة**');
        }
      });

      messageCollector.on('end', (collected, reason) => {
        console.log(`انتهى collector إدارة الرولات للمسؤولية ${responsibilityName} - السبب: ${reason}`);
        activeCollectors.delete(`role_${responsibilityName}`);
        if (reason !== 'user_done' && reason !== 'new_session') {
          interaction.editReply({ content: '**انتهت مهلة هذا الإجراء.**', embeds: [], components: [] }).catch(() => {});
        }
      });

    } catch (error) {
      console.error('خطأ في عرض إدارة الرولات:', error);
      await safeReply(interaction, '**حدث خطأ في عرض إدارة الرولات**');
    }
  }

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
      if (!ignoredCodes.includes(error.code)) {
        console.error('خطأ في الرد الآمن:', error);
      }
      return false;
    }
  }

  async function safeFollowUp(interaction, content, options = {}) {
    try {
      const replyOptions = { content, ephemeral: true, ...options };
      await interaction.followUp(replyOptions);
      return true;
    } catch (error) {
      console.error('خطأ في المتابعة الآمنة:', error);
      return false;
    }
  }

  function getCurrentBotOwners() {
    const owners = Array.isArray(global.BOT_OWNERS) && global.BOT_OWNERS.length > 0
      ? global.BOT_OWNERS
      : BOT_OWNERS;
    return [...new Set((Array.isArray(owners) ? owners : []).map(String))];
  }

  function canManageOwners(userId) {
    return getCurrentBotOwners().includes(String(userId)) || message.guild.ownerId === String(userId);
  }

  function saveBotOwners(ownerIds) {
    const botConfigPath = getBotConfigPath();
    const currentConfig = fs.existsSync(botConfigPath)
      ? JSON.parse(fs.readFileSync(botConfigPath, 'utf8'))
      : {};
    currentConfig.owners = [...new Set(ownerIds.map(String))];
    fs.writeFileSync(botConfigPath, JSON.stringify(currentConfig, null, 2));
    if (global.updateBotOwners) global.updateBotOwners(currentConfig.owners);
    else global.BOT_OWNERS = currentConfig.owners;
    return currentConfig.owners;
  }

  collector.on('collect', async interaction => {
    try {
      // معالجة التفاعلات

      // التحقق من صلاحية التفاعل مع معالجة محسنة
      if (!interaction || !interaction.isRepliable()) {
        console.log('تفاعل غير صالح في السيتنقس');
        return;
      }

      // التحقق من عمر التفاعل
      const now = Date.now();
      const interactionTime = interaction.createdTimestamp;
      const timeDiff = now - interactionTime;

      if (timeDiff > 14 * 60 * 1000) {
        console.log('تم تجاهل تفاعل منتهي الصلاحية في السيتنقس');
        return;
      }

      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في السيتنقس');
        return;
      }

      // معالجة أزرار التنقل بين الصفحات
      if (interaction.customId && (interaction.customId.startsWith('page_prev_') || interaction.customId.startsWith('page_next_'))) {
        const currentPage = parseInt(interaction.customId.split('_')[2]);
        let newPage = currentPage;
        
        if (interaction.customId.startsWith('page_prev_')) {
          newPage = currentPage - 1;
        } else if (interaction.customId.startsWith('page_next_')) {
          newPage = currentPage + 1;
        }
        
        await updateMainMenu(newPage);
        await safeReply(interaction, `**تم الانتقال إلى الصفحة ${newPage + 1}**`);
        return;
      }
      
      if (interaction.customId === 'responsibility_roles_center_btn') {
        responsibilityRolesSession.set(interaction.user.id, {
          anchorRoleId: null,
          selectedResponsibilities: [],
          roleNamesByResponsibility: {}
        });
        await openResponsibilityRolesCenter(interaction);
        return;
      }

      if (interaction.customId === 'settings_responsibility_roles_edit_select' && interaction.isStringSelectMenu()) {
        const selectedResponsibility = interaction.values[0];
        if (!responsibilities[selectedResponsibility]) {
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }
        await updateResponsibilityView(selectedResponsibility, interaction);
        return;
      }

      if (interaction.customId === 'settings_select_responsibility') {
        const selected = interaction.values[0];

        if (selected === 'add_new') {
          const modal = new ModalBuilder()
            .setCustomId('add_responsibility_modal')
            .setTitle('**Add res**');

          const nameInput = new TextInputBuilder()
            .setCustomId('responsibility_name')
            .setLabel('Res name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('أدخل اسم المسؤولية');

          const descInput = new TextInputBuilder()
            .setCustomId('responsibility_desc')
            .setLabel('Res desc')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setPlaceholder('أدخل شرح المسؤولية أو ضع لا');

          const firstActionRow = new ActionRowBuilder().addComponents(nameInput);
          const secondActionRow = new ActionRowBuilder().addComponents(descInput);

          modal.addComponents(firstActionRow, secondActionRow);
          await interaction.showModal(modal);
        } else {
          const responsibility = responsibilities[selected];
          if (!responsibility) {
            await updateMainMenu();
            return await safeReply(interaction, '**المسؤولية غير موجودة!**');
          }

          const editButton = new ButtonBuilder()
        .setCustomId(`edit_${selected}`)
        .setLabel('الشرح')
.setEmoji('<:emoji_16:1448570798380945539>')
        .setStyle(ButtonStyle.Secondary);

      const renameButton = new ButtonBuilder()
        .setCustomId(`rename_${selected}`)
        .setLabel('الأسم')
.setEmoji('<:emoji_14:1448570732652003398>')
        .setStyle(ButtonStyle.Secondary);

      const manageButton = new ButtonBuilder()
        .setCustomId(`manage_${selected}`)
        .setLabel('المسؤولين')
.setEmoji('<:emoji_17:1448570976097931406>')
        .setStyle(ButtonStyle.Secondary);

      const roleButton = new ButtonBuilder()
        .setCustomId(`role_${selected}`)
        .setLabel('رول المسؤولية')
.setEmoji('<:emoji_14:1448570758849757285>')
        .setStyle(ButtonStyle.Secondary);

      const mentButton = new ButtonBuilder()
        .setCustomId(`ment_${selected}`)
        .setLabel('اختصار')
.setEmoji('<:emoji_18:1448572201610776730>')
        .setStyle(ButtonStyle.Secondary);

const deleteButton = new ButtonBuilder()
        .setCustomId(`delete_${selected}`)
        .setLabel('حذف')
.setEmoji('<:emoji_13:1448570702176452660>')
        .setStyle(ButtonStyle.Danger);

          const orderedKeys = getOrderedResponsibilities();
          const currentIndex = orderedKeys.indexOf(selected);
          
          const backButton = new ButtonBuilder()
            .setCustomId('back_to_menu')
            .setLabel('main menu')
            .setStyle(ButtonStyle.Secondary);

          const buttonsRow1 = new ActionRowBuilder().addComponents(editButton, renameButton, deleteButton, manageButton, roleButton);
          const buttonsRowMent = new ActionRowBuilder().addComponents(mentButton);
          
          // إنشاء select menu للترتيب (محدود بـ 25 عنصر)
          let positionOptions = orderedKeys.map((key, index) => ({
            label: `${index + 1}. ${key}`,
            value: index.toString(),
            default: index === currentIndex,
            description: index === currentIndex ? '(الموضع الحالي)' : `نقل إلى الموضع ${index + 1}`
          }));

          // إذا كان هناك أكثر من 25 مسؤولية، نحد الخيارات
          if (positionOptions.length > 25) {
            // نعرض 12 عنصر قبل العنصر الحالي و 12 بعده
            const start = Math.max(0, currentIndex - 12);
            const end = Math.min(orderedKeys.length, currentIndex + 13);
            positionOptions = positionOptions.slice(start, end);
          }

          const components = [buttonsRow1, buttonsRowMent];
          
          if (positionOptions.length > 1) {
            const positionSelect = new StringSelectMenuBuilder()
              .setCustomId(`reorder_${selected}`)
              .setPlaceholder(' اختر الموضع الجديد للمسؤولية')
              .addOptions(positionOptions);
            const selectRow = new ActionRowBuilder().addComponents(positionSelect);
            components.push(selectRow);
          }

          const buttonsRow2 = new ActionRowBuilder().addComponents(backButton);
          components.push(buttonsRow2);

          const respList = responsibility.responsibles && responsibility.responsibles.length > 0
            ? responsibility.responsibles.map(r => `<@${r}>`).join(', ')
            : '**لا يوجد مسؤولين معينين**';

          const desc = responsibility.description && responsibility.description.toLowerCase() !== 'لا'
            ? responsibility.description
            : '**لا يوجد شرح**';

          const embedEdit = colorManager.createEmbed()
            .setTitle(`**تعديل المسؤولية : ${selected}**`)
            .setDescription(`**المسؤولون :** ${respList}\n**الشرح :** ${desc}\n**الترتيب :** ${currentIndex + 1} من ${orderedKeys.length}`);

          await interaction.update({ embeds: [embedEdit], components });
        }
      } else if (interaction.customId === 'settings_owners_list' || interaction.customId === 'settings_owners_add' || interaction.customId === 'settings_owners_remove') {
        if (!canManageOwners(interaction.user.id)) {
          return await safeReply(interaction, '**Owners only: لا تملك صلاحية إدارة مالكي البوت.**');
        }

        const owners = getCurrentBotOwners();
        if (interaction.customId === 'settings_owners_list') {
          return await safeReply(interaction, `**مالكو البوت الحاليون:**\n${owners.length ? owners.map((id, index) => `${index + 1}. <@${id}>`).join('\n') : 'لا يوجد'}`);
        }

        await safeReply(interaction, interaction.customId === 'settings_owners_add'
          ? '**أرسل منشن أو آيدي المستخدم لإضافته كمالك.**'
          : '**أرسل رقم المالك من القائمة لحذفه.**');
        const ownerCollector = interaction.channel.createMessageCollector({
          filter: msg => msg.author.id === interaction.user.id,
          time: 60000,
          max: 1
        });
        ownerCollector.on('collect', async msg => {
          await msg.delete().catch(() => {});
          const currentOwners = getCurrentBotOwners();
          if (interaction.customId === 'settings_owners_add') {
            const userId = msg.mentions.users.first()?.id || msg.content.trim().replace(/[<@!>]/g, '');
            if (!/^\d{17,19}$/.test(userId)) return interaction.followUp({ content: '**آيدي أو منشن غير صحيح.**', ephemeral: true });
            if (currentOwners.includes(userId)) return interaction.followUp({ content: '**هذا المستخدم مالك بالفعل.**', ephemeral: true });
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) return interaction.followUp({ content: '**لم يتم العثور على المستخدم.**', ephemeral: true });
            try {
              saveBotOwners([...currentOwners, userId]);
            } catch (error) {
              console.error('خطأ في حفظ مالكي البوت:', error);
              return interaction.followUp({ content: '**تعذر حفظ المالك الجديد.**', ephemeral: true });
            }
            await interaction.followUp({ content: `**✅ تمت إضافة <@${userId}> كمالك.**`, ephemeral: true });
          } else {
            const index = Number.parseInt(msg.content.trim(), 10) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= currentOwners.length) {
              return interaction.followUp({ content: '**رقم مالك غير صحيح.**', ephemeral: true });
            }
            if (currentOwners[index] === interaction.user.id && currentOwners.length === 1) {
              return interaction.followUp({ content: '**لا يمكن حذف المالك الوحيد.**', ephemeral: true });
            }
            const removed = currentOwners[index];
            try {
              saveBotOwners(currentOwners.filter((_, i) => i !== index));
            } catch (error) {
              console.error('خطأ في حفظ إزالة مالك البوت:', error);
              return interaction.followUp({ content: '**تعذر حفظ إزالة المالك.**', ephemeral: true });
            }
            await interaction.followUp({ content: `**✅ تمت إزالة <@${removed}> من المالكين.**`, ephemeral: true });
          }
        });
        ownerCollector.on('end', collected => {
          if (!collected.size) interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => {});
        });
        return;
      } else if (interaction.customId === 'back_to_menu' || interaction.customId === 'settings_owners_back' || interaction.customId.startsWith('back_to_main_')) {
        // إيقاف الـ collector النشط لهذه المسؤولية عند العودة
        const potentialRespName = interaction.customId.replace('back_to_main_', '');
        if (potentialRespName !== 'back_to_menu') {
            const collectorsToStop = [
                activeCollectors.get(potentialRespName),
                activeCollectors.get(`role_${potentialRespName}`)
            ];
            collectorsToStop.forEach(col => { if(col) col.stop('user_back'); });
            activeCollectors.delete(potentialRespName);
            activeCollectors.delete(`role_${potentialRespName}`);
        }
        
        // إذا كان الضغط من داخل مسؤولية معينة، رجع لنفس المسؤولية بدلاً من القائمة الأولى
        if (interaction.customId.startsWith('back_to_main_')) {
          const responsibilityName = interaction.customId.replace('back_to_main_', '');
          if (responsibilities[responsibilityName]) {
            // أعد عرض نفس المسؤولية
            const responsibility = responsibilities[responsibilityName];
            
            // بناء الأزرار
            const editButton = new ButtonBuilder()
              .setCustomId(`edit_${responsibilityName}`)
              .setLabel('الشرح')
              .setEmoji('<:emoji_16:1448570798380945539>')
              .setStyle(ButtonStyle.Secondary);

            const renameButton = new ButtonBuilder()
              .setCustomId(`rename_${responsibilityName}`)
              .setLabel('الأسم')
              .setEmoji('<:emoji_14:1448570732652003398>')
              .setStyle(ButtonStyle.Secondary);

            const deleteButton = new ButtonBuilder()
              .setCustomId(`delete_${responsibilityName}`)
              .setLabel('حذف')
              .setEmoji('<:emoji_13:1448570702176452660>')
              .setStyle(ButtonStyle.Danger);

            const manageButton = new ButtonBuilder()
              .setCustomId(`manage_${responsibilityName}`)
              .setLabel('المسؤولين')
              .setEmoji('<:emoji_17:1448570976097931406>')
              .setStyle(ButtonStyle.Secondary);

            const roleButton = new ButtonBuilder()
              .setCustomId(`role_${responsibilityName}`)
              .setLabel('رول المسؤولية')
              .setEmoji('<:emoji_14:1448570758849757285>')
              .setStyle(ButtonStyle.Secondary);

            const mentButton = new ButtonBuilder()
              .setCustomId(`ment_${responsibilityName}`)
              .setLabel('اختصار')
              .setEmoji('<:emoji_18:1448572201610776730>')
              .setStyle(ButtonStyle.Secondary);

            const backButton = new ButtonBuilder()
              .setCustomId('back_to_menu')
              .setLabel('main menu')
              .setStyle(ButtonStyle.Secondary);

            const respList = responsibility.responsibles && responsibility.responsibles.length > 0
              ? responsibility.responsibles.map(r => `<@${r}>`).join(', ')
              : '**لا يوجد مسؤولين معينين**';

            const desc = responsibility.description && responsibility.description.toLowerCase() !== 'لا'
              ? responsibility.description
              : '**لا يوجد شرح**';

            const embed = colorManager.createEmbed()
              .setTitle(`📋 المسؤولية : ${responsibilityName}`)
              .setDescription(`**👥 المسؤولون :** ${respList}\n**📝 الشرح :** ${desc}`);

            const components = [
              new ActionRowBuilder().addComponents(editButton, renameButton, deleteButton, manageButton, roleButton),
              new ActionRowBuilder().addComponents(mentButton),
              new ActionRowBuilder().addComponents(backButton)
            ];

            await interaction.update({ embeds: [embed], components });
            return;
          }
        }
        
        // وإلا، عد للقائمة الرئيسية
        await updateMainMenu();
      } else if (interaction.customId === 'settings_responsibility_roles_anchor_select' && interaction.isRoleSelectMenu()) {
        const selectedRoleId = interaction.values[0];
        const currentSession = responsibilityRolesSession.get(interaction.user.id) || {
          anchorRoleId: null,
          selectedResponsibilities: [],
          roleNamesByResponsibility: {}
        };
        currentSession.anchorRoleId = selectedRoleId;
        responsibilityRolesSession.set(interaction.user.id, currentSession);
        await openResponsibilityRolesCenter(interaction);
      } else if (interaction.customId === 'settings_responsibility_roles_multi_select' && interaction.isStringSelectMenu()) {
        const selected = interaction.values;
        const currentSession = responsibilityRolesSession.get(interaction.user.id) || {
          anchorRoleId: null,
          selectedResponsibilities: [],
          roleNamesByResponsibility: {}
        };
        
        if (!currentSession.anchorRoleId) {
          return await safeReply(interaction, '**يرجى اختيار رول المركز أولاً**');
        }

        // فحص إذا كانت أي من المسؤوليات المختارة لديها رول مربوط بالفعل
        const alreadyLinked = selected.filter(name => {
          const resp = responsibilities[name];
          return resp && Array.isArray(resp.roles) && resp.roles.length > 0;
        });

        if (alreadyLinked.length > 0) {
          const linkedList = alreadyLinked.map(name => `**${name}**`).join(' , ');
          return await safeReply(interaction, `**لا يمكن اختيار مسؤوليات مربوطة بالفعل**\n**المسؤوليات المربوطة : ${linkedList}**\n**قم بحذف الرولات أولاً إذا أردت إعادة ربطها**`);
        }
        
        currentSession.selectedResponsibilities = selected;
        responsibilityRolesSession.set(interaction.user.id, currentSession);
        
        const modal = buildResponsibilityRolesModal(0, selected);
        await interaction.showModal(modal);
      } else if (interaction.customId === 'settings_responsibility_roles_delete_all_btn') {
        const deleteEmbed = colorManager.createEmbed()
          .setTitle('**تأكيد عملية الحذف**')
          .setDescription([
            '**كيف تريد حذف الرولات المتصلة بالمسؤوليات**',
            '',
            '**حذف نهائي** : سيتم حذف الرولات تماماً من السيرفر',
            '**إزالة فقط** : سيتم إزالة الرولات من إعدادات المسؤوليات فقط مع بقائها في السيرفر'
          ].join('\n'));

        const deleteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('settings_responsibility_roles_delete_confirm_hard')
            .setLabel('حذف نهائي')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('settings_responsibility_roles_delete_confirm_soft')
            .setLabel('إزالة فقط')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('back_to_roles_center')
            .setLabel('إلغاء')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [deleteEmbed], components: [deleteRow] });
      } else if (interaction.customId === 'back_to_roles_center') {
        await openResponsibilityRolesCenter(interaction);
      } else if (interaction.customId === 'settings_responsibility_roles_delete_confirm_hard' || interaction.customId === 'settings_responsibility_roles_delete_confirm_soft') {
        const isHardDelete = interaction.customId === 'settings_responsibility_roles_delete_confirm_hard';
        let count = 0;
        
        for (const [name, config] of Object.entries(responsibilities)) {
          if (config.roles && config.roles.length > 0) {
            if (isHardDelete) {
              for (const roleId of config.roles) {
                const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
                if (role) await role.delete('حذف رولات المسؤوليات نهائياً').catch(() => {});
              }
            }
            config.roles = [];
            count++;
          }
        }
        
        await saveResponsibilities();
        await updateRespEmbeds(client);
        
        const resultEmbed = colorManager.createEmbed()
          .setTitle('**تمت العملية بنجاح**')
          .setDescription(`**تمت إزالة الرولات من ${count} مسؤولية**${isHardDelete ? '\n**تم حذف الرولات نهائياً من السيرفر**' : ''}`);
          
        const backBtn = new ButtonBuilder()
          .setCustomId('back_to_roles_center')
          .setLabel('الرجوع للمركز')
          .setStyle(ButtonStyle.Secondary);
          
        await interaction.update({ embeds: [resultEmbed], components: [new ActionRowBuilder().addComponents(backBtn)] });
      } else if (interaction.customId === 'settings_responsibility_roles_create' && interaction.isButton()) {
        const currentSession = responsibilityRolesSession.get(interaction.user.id);
        if (!currentSession || !currentSession.anchorRoleId) {
          return await safeReply(interaction, '**حدد رول المركز أولاً.**');
        }

        if (!Array.isArray(currentSession.selectedResponsibilities) || currentSession.selectedResponsibilities.length === 0) {
          return await safeReply(interaction, '**حدد المسؤوليات أولاً.**');
        }

        const blockedResponsibilities = currentSession.selectedResponsibilities.filter((name) => {
          const respData = responsibilities[name];
          return respData && Array.isArray(respData.roles) && respData.roles.length > 0;
        });

        if (blockedResponsibilities.length > 0) {
          return await safeReply(interaction, `**لا يمكن الإنشاء. المسؤوليات التالية مرتبطة مسبقاً برول:**\n${blockedResponsibilities.join('\n')}`);
        }

        currentSession.roleNamesByResponsibility = {};
        responsibilityRolesSession.set(interaction.user.id, currentSession);
        const modal = buildResponsibilityRolesModal(0, currentSession.selectedResponsibilities);
        await interaction.showModal(modal);
      } else if (interaction.customId.startsWith('settings_responsibility_roles_open_modal_') && interaction.isButton()) {
        const currentSession = responsibilityRolesSession.get(interaction.user.id);
        if (!currentSession || !Array.isArray(currentSession.selectedResponsibilities) || currentSession.selectedResponsibilities.length === 0) {
          return await safeReply(interaction, '**انتهت جلسة إنشاء الرولات. أعد المحاولة من القائمة.**');
        }

        const step = parseInt(interaction.customId.replace('settings_responsibility_roles_open_modal_', ''), 10) || 0;
        const modal = buildResponsibilityRolesModal(step, currentSession.selectedResponsibilities.slice(0, 24));
        await interaction.showModal(modal);
      } else if (interaction.customId === 'settings_responsibility_roles_finish_create' && interaction.isButton()) {
        await finalizeResponsibilityRolesCreation(interaction, { allowPartial: true });
      } else if (interaction.isButton()) {
        const [action, responsibilityName] = interaction.customId.split('_');

        if (!responsibilityName || !responsibilities[responsibilityName]) {
          await updateMainMenu();
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }

        if (action === 'delete') {
          try {
            const { dbManager } = require('../utils/database.js');
            const deletedResponsibility = { ...responsibilities[responsibilityName] };
            
            // حذف من قاعدة البيانات أولاً
            await dbManager.deleteResponsibility(responsibilityName);
            
            // حذف من الكائن المحلي والعالمي
            delete responsibilities[responsibilityName];
            if (global.responsibilities) delete global.responsibilities[responsibilityName];

            logEvent(client, message.guild, {
              type: 'RESPONSIBILITY_MANAGEMENT',
              title: 'Responsibility Deleted',
              description: `The responsibility "${responsibilityName}" has been deleted.`,
              user: message.author,
              fields: [
                { name: 'Description', value: deletedResponsibility.description || 'N/A' }
              ]
            });

            await safeReply(interaction, `**✅ تم حذف المسؤولية: ${responsibilityName}**`);

            setTimeout(async () => {
              await updateMainMenu();
            }, 1500);

          } catch (error) {
            console.error('خطأ في حذف المسؤولية:', error);
            await safeReply(interaction, '**حدث خطأ أثناء حذف المسؤولية**');
          }
        } else if (action === 'edit') {
          const modal = new ModalBuilder()
            .setCustomId(`edit_desc_modal_${responsibilityName}`)
            .setTitle(`**تعديل شرح المسؤولية: ${responsibilityName}**`);

          const descInput = new TextInputBuilder()
            .setCustomId('responsibility_desc')
            .setLabel('شرح المسؤولية (أرسل "لا" لعدم الشرح)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setPlaceholder('أدخل شرح المسؤولية أو اتركه فارغ')
            .setValue(responsibilities[responsibilityName].description || '');

          const actionRow = new ActionRowBuilder().addComponents(descInput);
          modal.addComponents(actionRow);
          await interaction.showModal(modal);
        } else if (action === 'rename') {
          const modal = new ModalBuilder()
            .setCustomId(`rename_modal_${responsibilityName}`)
            .setTitle(`**تغيير اسم المسؤولية**`);

          const nameInput = new TextInputBuilder()
            .setCustomId('new_responsibility_name')
            .setLabel('الاسم الجديد للمسؤولية')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('أدخل الاسم الجديد')
            .setValue(responsibilityName);

          const actionRow = new ActionRowBuilder().addComponents(nameInput);
          modal.addComponents(actionRow);
          await interaction.showModal(modal);
        } else if (action === 'manage') {
          await showResponsibleManagement(interaction, responsibilityName);
        } else if (action === 'role') {
          await showRoleManagement(interaction, responsibilityName);
        } else if (action === 'ment') {
          // إعداد اختصار المنشن للمسؤولية
          const modal = new ModalBuilder()
            .setCustomId(`ment_modal_${responsibilityName}`)
            .setTitle(`اختصار منشن: ${responsibilityName}`);

          const prefixInput = new TextInputBuilder()
            .setCustomId('ment_prefix')
            .setLabel('اترك فارغ للبريفكس الافتراضي (-)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('اتركه فارغ = -')
            .setMaxLength(5);

          // جلب البريفكس الحالي إن وجد (لا نضعه إذا كان الافتراضي)
          const currentPrefix = responsibilities[responsibilityName].mentPrefix;
          if (currentPrefix && currentPrefix !== '-') {
            prefixInput.setValue(currentPrefix);
          }

          const shortcutInput = new TextInputBuilder()
            .setCustomId('ment_shortcut')
            .setLabel('ضع كلمة الاختصار')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('مثال : الدعم ، باند ، تكت');

          // جلب الاختصار الحالي إن وجد
          const currentShortcut = responsibilities[responsibilityName].mentShortcut || '';
          if (currentShortcut) {
            shortcutInput.setValue(currentShortcut);
          }

          const adminOnlyInput = new TextInputBuilder()
            .setCustomId('ment_admin_only')
            .setLabel('للأدمن فقط؟ (اكتب لا لإتاحته للجميع)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('اتركه فارغ = للأدمن فقط، اكتب لا = للجميع')
            .setMaxLength(10);

          // جلب الإعداد الحالي إن وجد
          const currentAdminOnly = responsibilities[responsibilityName].mentAdminOnly;
          if (currentAdminOnly === false) {
            adminOnlyInput.setValue('لا');
          }

          const prefixRow = new ActionRowBuilder().addComponents(prefixInput);
          const shortcutRow = new ActionRowBuilder().addComponents(shortcutInput);
          const adminOnlyRow = new ActionRowBuilder().addComponents(adminOnlyInput);
          modal.addComponents(prefixRow, shortcutRow, adminOnlyRow);
          await interaction.showModal(modal);
        } else if (action === 'search') {
          // إظهار نافذة البحث عن الأعضاء
          const modal = new ModalBuilder()
            .setCustomId(`search_members_modal_${responsibilityName}`)
            .setTitle('بحث عن أعضاء');

          const searchInput = new TextInputBuilder()
            .setCustomId('search_query')
            .setLabel('اكتب اسم العضو للبحث')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('مثال: Ahmed, محمد, Ali');

          const actionRow = new ActionRowBuilder().addComponents(searchInput);
          modal.addComponents(actionRow);
          await interaction.showModal(modal);
        }
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('reorder_')) {
        // معالجة إعادة الترتيب من select menu
        const responsibilityName = interaction.customId.replace('reorder_', '');
        const newPosition = parseInt(interaction.values[0]);
        
        if (!responsibilities[responsibilityName]) {
          await updateMainMenu();
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }
        
        const orderedKeys = getOrderedResponsibilities();
        const currentPosition = orderedKeys.indexOf(responsibilityName);
        
        if (currentPosition === newPosition) {
          return await safeReply(interaction, '**المسؤولية في نفس الموضع بالفعل!**');
        }
        
        // إزالة المسؤولية من موضعها الحالي
        orderedKeys.splice(currentPosition, 1);
        // إدراجها في الموضع الجديد
        orderedKeys.splice(newPosition, 0, responsibilityName);
        
        // إعادة ترقيم جميع المسؤوليات
        orderedKeys.forEach((key, index) => {
          responsibilities[key].order = index;
        });
        
        await saveResponsibilities();
        await safeReply(interaction, `**✅ تم نقل "${responsibilityName}" إلى الموضع ${newPosition + 1}**`);
        
        logEvent(client, message.guild, {
          type: 'RESPONSIBILITY_MANAGEMENT',
          title: 'تم إعادة ترتيب مسؤولية',
          description: `تم نقل "${responsibilityName}" من الموضع ${currentPosition + 1} إلى ${newPosition + 1}`,
          user: interaction.user,
          fields: [
            { name: 'المسؤولية', value: responsibilityName, inline: true },
            { name: 'الموضع القديم', value: (currentPosition + 1).toString(), inline: true },
            { name: 'الموضع الجديد', value: (newPosition + 1).toString(), inline: true }
          ]
        });
        
        // تحديث المنيو مباشرة بالمسؤوليات والمواقع الجديدة
        setTimeout(async () => {
          const responsibility = responsibilities[responsibilityName];
          if (!responsibility) {
            await updateMainMenu();
            return;
          }

const editButton = new ButtonBuilder()
        .setCustomId(`edit_${responsibilityName}`)
        .setLabel('الشرح')
.setEmoji('<:emoji_16:1448570798380945539>')
        .setStyle(ButtonStyle.Secondary);

      const renameButton = new ButtonBuilder()
        .setCustomId(`rename_${responsibilityName}`)
        .setLabel('الأسم')
.setEmoji('<:emoji_14:1448570732652003398>')
        .setStyle(ButtonStyle.Secondary);

      const manageButton = new ButtonBuilder()
        .setCustomId(`manage_${responsibilityName}`)
        .setLabel('المسؤولين')
.setEmoji('<:emoji_17:1448570976097931406>')
        .setStyle(ButtonStyle.Secondary);

      const roleButton = new ButtonBuilder()
        .setCustomId(`role_${responsibilityName}`)
        .setLabel('رول المسؤولية')
.setEmoji('<:emoji_14:1448570758849757285>')
        .setStyle(ButtonStyle.Secondary);

      const mentButton = new ButtonBuilder()
        .setCustomId(`ment_${responsibilityName}`)
        .setLabel('اختصار')
.setEmoji('<:emoji_18:1448572201610776730>')
        .setStyle(ButtonStyle.Secondary);

const deleteButton = new ButtonBuilder()
        .setCustomId(`delete_${responsibilityName}`)
        .setLabel('حذف')
.setEmoji('<:emoji_13:1448570702176452660>')
        .setStyle(ButtonStyle.Danger);
;

          const updatedOrderedKeys = getOrderedResponsibilities();
          const updatedIndex = updatedOrderedKeys.indexOf(responsibilityName);
          
          const backButton = new ButtonBuilder()
            .setCustomId('back_to_menu')
            .setLabel('main menu')
            .setStyle(ButtonStyle.Secondary);

          const buttonsRow1 = new ActionRowBuilder().addComponents(editButton, renameButton, deleteButton, manageButton, roleButton);
          
          // إنشاء select menu للترتيب بالمواقع المحدثة
          let positionOptions = updatedOrderedKeys.map((key, index) => ({
            label: `${index + 1}. ${key}`,
            value: index.toString(),
            default: index === updatedIndex,
            description: index === updatedIndex ? '(الموضع الحالي)' : `نقل إلى الموضع ${index + 1}`
          }));

          // Discord يسمح بحد أقصى 25 خيار فقط
          if (positionOptions.length > 25) {
            const start = Math.max(0, updatedIndex - 12);
            const end = Math.min(updatedOrderedKeys.length, start + 25);
            positionOptions = positionOptions.slice(start, end);
          }

          const positionSelect = new StringSelectMenuBuilder()
            .setCustomId(`reorder_${responsibilityName}`)
            .setPlaceholder('اختر الموضع الجديد للمسؤولية')
            .addOptions(positionOptions);

          const buttonsRow2 = new ActionRowBuilder().addComponents(backButton);
          const selectRow = new ActionRowBuilder().addComponents(positionSelect);

          const respList = responsibility.responsibles && responsibility.responsibles.length > 0
            ? responsibility.responsibles.map(r => `<@${r}>`).join(', ')
            : '**لا يوجد مسؤولين معينين**';

          const desc = responsibility.description && responsibility.description.toLowerCase() !== 'لا'
            ? responsibility.description
            : '**لا يوجد شرح**';

          const embedEdit = colorManager.createEmbed()
            .setTitle(`**تعديل المسؤولية : ${responsibilityName}**`)
            .setDescription(`**المسؤولون :** ${respList}\n**الشرح :** ${desc}\n**الترتيب :** ${updatedIndex + 1} من ${updatedOrderedKeys.length}`);

          await interaction.message.edit({ embeds: [embedEdit], components: [buttonsRow1, selectRow, buttonsRow2] });
        }, 1000);
      } else if (interaction.customId && interaction.customId.startsWith('settings_manage_')) {
            const action = interaction.customId.replace('settings_manage_', '');

            if (action === 'add') {
                // التأكد من وجود responsibilities
                if (!responsibilities) {
                    await interaction.reply({ content: '**خطأ في تحميل المسؤوليات!**', ephemeral: true });
                    return;
                }

                // إنشاء Select Menu لاختيار الأعضاء
                const members = await message.guild.members.fetch();
                const memberOptions = members
                    .filter(m => !m.user.bot)
                    .map(m => ({
                        label: m.displayName || m.user.username,
                        value: m.id
                    }))
                    .slice(0, 25);

                if (memberOptions.length === 0) {
                    await interaction.reply({ content: '**لا يوجد أعضاء متاحين!**', ephemeral: true });
                    return;
                }

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('settings_select_members')
                    .setPlaceholder('اختر الأعضاء')
                    .addOptions(memberOptions)
                    .setMinValues(1)
                    .setMaxValues(Math.min(memberOptions.length, 25));

                const row = new ActionRowBuilder().addComponents(selectMenu);
                const embed = colorManager.createEmbed()
                    .setTitle('**إضافة مسؤولين**')
                    .setDescription('**اختر الأعضاء الذين تريد تعيينهم كمسؤولين**')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400676711439273994/1320524603868712960.png?ex=688d8157&is=688c2fd7&hm=2f0fcafb0d4dd4fc905d6c5c350cfafe7d68e902b5668117f2e7903a62c8&');

                await interaction.update({ embeds: [embed], components: [row] });
            } else if (action === 'owners') {
                // التحقق من أن المستخدم هو مالك السيرفر أو مالك البوت
                if (!canManageOwners(interaction.user.id)) {
                    await interaction.reply({ content: '**ليس لديك صلاحية للوصول لهذا الخيار!**', ephemeral: true });
                    return;
                }

                // عرض خيارات إدارة المالكين
                const addButton = new ButtonBuilder()
                    .setCustomId('settings_owners_add')
                    .setLabel('إضافة مالك')
                    .setStyle(ButtonStyle.Success);

                const removeButton = new ButtonBuilder()
                    .setCustomId('settings_owners_remove')
                    .setLabel('إزالة مالك')
                    .setStyle(ButtonStyle.Danger);

                const listButton = new ButtonBuilder()
                    .setCustomId('settings_owners_list')
                    .setLabel('عرض المالكين')
                    .setStyle(ButtonStyle.Primary);

                const backButton = new ButtonBuilder()
                    .setCustomId('settings_owners_back')
                    .setLabel('رجوع')
                    .setStyle(ButtonStyle.Secondary);

                const row = new ActionRowBuilder().addComponents(addButton, removeButton, listButton, backButton);
                const embed = colorManager.createEmbed()
                    .setTitle('**إدارة مالكي البوت**')
                    .setDescription('**اختر الإجراء المطلوب**')
                    .setThumbnail('https://cdn.discordapp.com/emojis/1186585722401063032.png?v=1');

                await interaction.update({ embeds: [embed], components: [row] });
            }
        } else if (interaction.customId === 'settings_select_members') {
            try {
                const selectedMembers = interaction.values;

                // البحث عن اسم المسؤولية من العنوان
                let responsibilityName = null;
                if (interaction.message && interaction.message.embeds && interaction.message.embeds[0]) {
                    const embedTitle = interaction.message.embeds[0].title;
                    if (embedTitle && embedTitle.includes(': ')) {
                        responsibilityName = embedTitle.split(': ')[1];
                    }
                }

                if (!responsibilityName) {
                    await interaction.reply({ content: '**خطأ في تحديد اسم المسؤولية!**', ephemeral: true });
                    return;
                }

                // التأكد من وجود responsibilities
                if (!responsibilities) {
                    responsibilities = {};
                }

                if (!responsibilities[responsibilityName]) {
                    responsibilities[responsibilityName] = {
                        description: 'لا يوجد وصف',
                        responsibles: []
                    };
                }

                responsibilities[responsibilityName].responsibles = selectedMembers;
                await saveResponsibilities();

                const updatedEmbed = colorManager.createEmbed()
                    .setTitle(`تم تحديث المسؤولية: ${responsibilityName}`)
                    .setDescription(`**تم تعيين ${selectedMembers.length} عضو للمسؤولية**`)
                    .addFields([
                        { name: 'المسؤولون', value: selectedMembers.map(id => `<@${id}>`).join('\n') || 'لا يوجد', inline: false }
                    ])
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400676711439273994/1320524603868712960.png?ex=688d8157&is=688c2fd7&hm=2f0fcafb0d4dd4fc905d6c5c350cfafe7d68e902b5668117f2e7903a62c8&');

                await interaction.update({ embeds: [updatedEmbed], components: [] });

                logEvent(client, interaction.guild, {
                    type: 'RESPONSIBILITY_MANAGEMENT',
                    title: 'Members Updated for Responsibility',
                    description: `Updated members for responsibility: **${responsibilityName}**`,
                    user: interaction.user,
                    fields: [
                        { name: 'Members Count', value: selectedMembers.length.toString(), inline: true },
                        { name: 'Members', value: selectedMembers.map(id => `<@${id}>`).join(', ') || 'None', inline: false }
                    ]
                });
            } catch (error) {
                console.error('خطأ في معالجة اختيار الأعضاء:', error);
                await safeReply(interaction, '**حدث خطأ أثناء تحديث المسؤولية.**');
            }
            return;
        } else if (interaction.customId.startsWith('add_searched_members_')) {
        const responsibilityName = interaction.customId.replace('add_searched_members_', '');
        const selectedMemberIds = interaction.values;

        if (!responsibilities[responsibilityName]) {
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }

        const currentResponsibles = responsibilities[responsibilityName].responsibles || [];
        let addedCount = 0;
        let alreadyExistsCount = 0;

        for (const memberId of selectedMemberIds) {
          if (!currentResponsibles.includes(memberId)) {
            currentResponsibles.push(memberId);
            addedCount++;

            // إرسال رسالة ترحيب للمسؤول الجديد
            try {
              const member = await message.guild.members.fetch(memberId);
              const welcomeEmbed = colorManager.createEmbed()
                .setTitle('**تهانينا! تم تعيينك كمسؤول جديد**')
                .setDescription(`\nتم اضافتك مسؤول لمسؤوليه الـ **${responsibilityName}**\n\nبواسطه مسؤول المسؤوليات <@${interaction.user.id}>\n\nفي سيرفر : **${interaction.guild.name}**\n`)
                .setThumbnail(message.guild.iconURL({ dynamic: true }));

              await member.send({ embeds: [welcomeEmbed] });
            } catch (error) {
              console.log(`لا يمكن إرسال رسالة للمستخدم ${memberId}: ${error.message}`);
            }
          } else {
            alreadyExistsCount++;
          }
        }

        responsibilities[responsibilityName].responsibles = currentResponsibles;
        const saved = await saveResponsibilities();

        if (!saved) {
          return await safeReply(interaction, '**فشل في حفظ المسؤولين!**');
        }

        let resultMessage = '';
        if (addedCount > 0) {
          resultMessage += `**✅ تم إضافة ${addedCount} مسؤول بنجاح**\n`;
        }
        if (alreadyExistsCount > 0) {
          resultMessage += `**ℹ️ ${alreadyExistsCount} عضو مضاف بالفعل**`;
        }

        await safeReply(interaction, resultMessage || '**تم تحديث المسؤولين**');

        logEvent(client, message.guild, {
          type: 'RESPONSIBILITY_MANAGEMENT',
          title: 'تم إضافة مسؤولين جدد',
          description: `تم إضافة ${addedCount} مسؤول للمسؤولية: ${responsibilityName}`,
          user: interaction.user,
          fields: [
            { name: 'المسؤولية', value: responsibilityName, inline: true },
            { name: 'عدد المضافين', value: addedCount.toString(), inline: true }
          ]
        });
      }
    } catch (error) {
      console.error('خطأ في معالج إعدادات المسؤوليات:', error);
      await safeReply(interaction, '**حدث خطأ أثناء معالجة الطلب.**');
    }
  });

  // Handle modal submissions - استخدام once بدلاً من on لتجنب التكرار
  const modalHandler = async (interaction) => {
    try {
      if (!interaction.isModalSubmit()) return;
      if (interaction.user.id !== message.author.id) return;

      // تحديث وقت المجمع الرئيسي لمنع الانتهاء أثناء استخدام المودال
      if (collector && !collector.ended) {
        collector.resetTimer({ time: 3600000 });
      }

      // معالج إضافة مسؤولية جديدة
      if (interaction.customId === 'add_responsibility_modal') {
        const name = interaction.fields.getTextInputValue('responsibility_name').trim();
        const desc = interaction.fields.getTextInputValue('responsibility_desc')?.trim() || '';

        if (!name) {
          await safeReply(interaction, '**يجب إدخال اسم المسؤولية!**');
          return;
        }

        // إعادة تحميل المسؤوليات من SQLite
        const { dbManager } = require('../utils/database.js');
        let currentResponsibilities = {};
        try {
          currentResponsibilities = await dbManager.getResponsibilities();
        } catch (error) {
          console.error('خطأ في جلب المسؤوليات من SQLite:', error);
          currentResponsibilities = {};
        }

        // التحقق من وجود المسؤولية بشكل غير حساس لحالة الأحرف
        const existingResponsibility = Object.keys(currentResponsibilities).find(
          key => key.toLowerCase() === name.toLowerCase()
        );

        if (existingResponsibility) {
          await safeReply(interaction, `**المسؤولية "${existingResponsibility}" موجودة بالفعل!**\n**يرجى اختيار اسم آخر.**`);
          return;
        }

        // إضافة المسؤولية الجديدة للكائن المحمّل والكائن الرئيسي
        const maxOrder = Math.max(-1, ...Object.values(currentResponsibilities).map(r => r.order ?? -1));
        
        const newRespConfig = {
          description: (!desc || desc.toLowerCase() === 'لا') ? '' : desc,
          responsibles: [],
          order: maxOrder + 1
        };
        
        currentResponsibilities[name] = newRespConfig;
        responsibilities[name] = newRespConfig;

        // حفظ المسؤولية الجديدة في SQLite
        try {
          await dbManager.updateResponsibility(name, newRespConfig);
          console.log('✅ [SETTINGS] تم حفظ المسؤولية الجديدة في SQLite بنجاح');
        } catch (error) {
          console.error('❌ [SETTINGS] خطأ في حفظ المسؤولية في SQLite:', error);
          return await safeReply(interaction, '**فشل في إنشاء المسؤولية في قاعدة البيانات!**');
        }
        
        // تحديث setup menus
        try {
          const setupCommand = client.commands.get('setup');
          if (setupCommand && setupCommand.updateAllSetupMenus) {
            setupCommand.updateAllSetupMenus(client);
          }
        } catch (error) {
          console.error('خطأ في تحديث منيو السيتب:', error);
        }

        // تحديث إيمبد Resp
        try {
          const respCommand = client.commands.get('resp');
          if (respCommand && respCommand.updateEmbedMessage) {
            await respCommand.updateEmbedMessage(client);
            console.log('✅ [SETTINGS] تم تحديث إيمبد Resp بعد إنشاء مسؤولية جديدة');
          }
        } catch (error) {
          console.error('خطأ في تحديث إيمبد Resp:', error);
        }

        logEvent(client, message.guild, {
          type: 'RESPONSIBILITY_MANAGEMENT',
          title: 'Responsibility Created',
          description: `A new responsibility "${name}" has been created.`,
          user: message.author,
          fields: [
            { name: 'Description', value: desc || 'N/A' }
          ]
        });

        await safeReply(interaction, `**✅ تم إنشاء المسؤولية: ${name}**\n\n**يمكنك الآن اختيارها من القائمة الرئيسية لإضافة المسؤولين**`);

        setTimeout(async () => {
          await updateMainMenu();
        }, 2000);

      } else if (interaction.customId.startsWith('edit_desc_modal_')) {
        const responsibilityName = interaction.customId.replace('edit_desc_modal_', '');
        const desc = interaction.fields.getTextInputValue('responsibility_desc').trim();

        if (!responsibilities[responsibilityName]) {
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }

        const oldDesc = responsibilities[responsibilityName].description;
        responsibilities[responsibilityName].description = (!desc || desc.toLowerCase() === 'لا') ? '' : desc;

        const saved = await saveResponsibilities();
        if (!saved) {
          return await safeReply(interaction, '**فشل في تعديل المسؤولية!**');
        }

        // تحديث إيمبد Resp
        try {
          const respCommand = client.commands.get('resp');
          if (respCommand && respCommand.updateEmbedMessage) {
            await respCommand.updateEmbedMessage(client);
            console.log('✅ [SETTINGS] تم تحديث إيمبد Resp بعد تعديل الشرح');
          }
        } catch (error) {
          console.error('خطأ في تحديث إيمبد Resp:', error);
        }

        logEvent(client, message.guild, {
          type: 'RESPONSIBILITY_MANAGEMENT',
          title: 'Responsibility Description Updated',
          description: `The description for "${responsibilityName}" has been updated.`,
          user: message.author,
          fields: [
            { name: 'Old Description', value: oldDesc || 'N/A' },
            { name: 'New Description', value: responsibilities[responsibilityName].description || 'N/A' }
          ]
        });

        await safeReply(interaction, `**✅ تم تعديل شرح المسؤولية: ${responsibilityName}**`);

        setTimeout(async () => {
          await updateResponsibilityView(responsibilityName);
        }, 1500);
      } else if (interaction.customId.startsWith('rename_modal_')) {
        const oldName = interaction.customId.replace('rename_modal_', '');
        const newName = interaction.fields.getTextInputValue('new_responsibility_name').trim();

        if (!newName) {
          await safeReply(interaction, '**يجب إدخال اسم جديد!**');
          return;
        }

        if (!responsibilities[oldName]) {
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }

        // إعادة تحميل المسؤوليات من الملف للتأكد من البيانات الحديثة
        const fs = require('fs');
        const path = require('path');
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        
        let currentResponsibilities = {};
        try {
          if (fs.existsSync(responsibilitiesPath)) {
            const data = fs.readFileSync(responsibilitiesPath, 'utf8');
            currentResponsibilities = JSON.parse(data);
          }
        } catch (error) {
          console.error('خطأ في قراءة المسؤوليات:', error);
          currentResponsibilities = {};
        }

        // التحقق من أن الاسم الجديد غير موجود (ما لم يكن نفس الاسم القديم)
        const existingResponsibility = Object.keys(currentResponsibilities).find(
          key => key.toLowerCase() === newName.toLowerCase() && key !== oldName
        );

        if (existingResponsibility) {
          await safeReply(interaction, `**المسؤولية "${existingResponsibility}" موجودة بالفعل!**\n**يرجى اختيار اسم آخر.**`);
          return;
        }

        // نسخ البيانات القديمة
        const responsibilityData = { ...responsibilities[oldName] };
        
        // حذف المسؤولية القديمة
        delete responsibilities[oldName];
        
        // إضافة المسؤولية بالاسم الجديد
        responsibilities[newName] = responsibilityData;

        const saved = await saveResponsibilities();
        if (!saved) {
          // استرجاع التغيير في حالة الفشل
          responsibilities[oldName] = responsibilityData;
          delete responsibilities[newName];
          return await safeReply(interaction, '**فشل في تغيير اسم المسؤولية!**');
        }

        // تحديث إيمبد Resp
        try {
          const respCommand = client.commands.get('resp');
          if (respCommand && respCommand.updateEmbedMessage) {
            await respCommand.updateEmbedMessage(client);
            console.log('✅ [SETTINGS] تم تحديث إيمبد Resp بعد تغيير الاسم');
          }
        } catch (error) {
          console.error('خطأ في تحديث إيمبد Resp:', error);
        }

        logEvent(client, message.guild, {
          type: 'RESPONSIBILITY_MANAGEMENT',
          title: 'Responsibility Renamed',
          description: `Responsibility "${oldName}" has been renamed to "${newName}".`,
          user: message.author,
          fields: [
            { name: 'Old Name', value: oldName },
            { name: 'New Name', value: newName }
          ]
        });

        await safeReply(interaction, `**✅ تم تغيير اسم المسؤولية من "${oldName}" إلى "${newName}"**`);

        setTimeout(async () => {
          await updateResponsibilityView(newName);
        }, 1500);
      } else if (interaction.customId.startsWith('ment_modal_')) {
        const responsibilityName = interaction.customId.replace('ment_modal_', '');
        const mentPrefixInput = interaction.fields.getTextInputValue('ment_prefix').trim();
        const mentShortcut = interaction.fields.getTextInputValue('ment_shortcut').trim();
        const mentAdminOnlyInput = interaction.fields.getTextInputValue('ment_admin_only').trim().toLowerCase();

        if (!responsibilities[responsibilityName]) {
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }

        if (!mentShortcut) {
          return await safeReply(interaction, '**يجب إدخال كلمة الاختصار!**');
        }

        // استخدام البريفكس الافتراضي (-) إذا كان الحقل فارغ
        const mentPrefix = mentPrefixInput || '-';

        // تحديد إذا كان للأدمن فقط (إذا كتب لا = false، إذا تركه فارغ أو كتب نعم = true)
        const noValues = ['لا', 'no', 'false', '0', 'لأ'];
        const mentAdminOnly = !noValues.includes(mentAdminOnlyInput);

        responsibilities[responsibilityName].mentPrefix = mentPrefix;
        responsibilities[responsibilityName].mentShortcut = mentShortcut;
        responsibilities[responsibilityName].mentAdminOnly = mentAdminOnly;

        const saved = await saveResponsibilities();
        if (!saved) {
          return await safeReply(interaction, '**فشل في حفظ إعدادات المنشن!**');
        }

        // تحديث إيمبد Resp
        try {
          const respCommand = client.commands.get('resp');
          if (respCommand && respCommand.updateEmbedMessage) {
            await respCommand.updateEmbedMessage(client);
            console.log('✅ [SETTINGS] تم تحديث إيمبد Resp بعد تعديل الاختصار');
          }
        } catch (error) {
          console.error('خطأ في تحديث إيمبد Resp:', error);
        }

        logEvent(client, message.guild, {
          type: 'RESPONSIBILITY_MANAGEMENT',
          title: 'تم تحديث اختصار المنشن',
          description: `تم تحديث اختصار المنشن للمسؤولية: ${responsibilityName}`,
          user: message.author,
          fields: [
            { name: 'البريفكس', value: mentPrefix, inline: true },
            { name: 'الاختصار', value: mentShortcut, inline: true },
            { name: 'للأدمن فقط', value: mentAdminOnly ? 'نعم' : 'لا', inline: true }
          ]
        });

        const adminOnlyText = mentAdminOnly ? '\n**🔒 للأدمن فقط:** نعم' : '';
        await safeReply(interaction, `**✅ تم حفظ إعدادات المنشن للمسؤولية: ${responsibilityName}**\n\n**البريفكس:** \`${mentPrefix}\`\n**الاختصار:** \`${mentShortcut}\`${adminOnlyText}\n\n**الاستخدام:** \`${mentPrefix}${mentShortcut}\``);

        setTimeout(async () => {
          await updateResponsibilityView(responsibilityName);
        }, 1500);
      } else if (interaction.customId.startsWith('search_members_modal_')) {
        const responsibilityName = interaction.customId.replace('search_members_modal_', '');
        const searchQuery = interaction.fields.getTextInputValue('search_query').trim().toLowerCase();

        if (!searchQuery) {
          await safeReply(interaction, '**يجب إدخال نص للبحث!**');
          return;
        }

        if (!responsibilities[responsibilityName]) {
          return await safeReply(interaction, '**المسؤولية غير موجودة!**');
        }

        // البحث عن الأعضاء
        const allMembers = await message.guild.members.fetch();
        const matchedMembers = allMembers.filter(member => 
          !member.user.bot && (
            member.user.username.toLowerCase().includes(searchQuery) ||
            member.user.displayName?.toLowerCase().includes(searchQuery) ||
            member.displayName?.toLowerCase().includes(searchQuery) ||
            member.user.tag.toLowerCase().includes(searchQuery)
          )
        );

        if (matchedMembers.size === 0) {
          await safeReply(interaction, `**لم يتم العثور على أي أعضاء تطابق البحث: "${searchQuery}"**`);
          return;
        }

        // إنشاء Select Menu للأعضاء الذين تم العثور عليهم
        const memberOptions = matchedMembers.map(member => ({
          label: member.displayName || member.user.username,
          description: `@${member.user.username}`,
          value: member.id
        })).slice(0, 25); // Discord limit

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`add_searched_members_${responsibilityName}`)
          .setPlaceholder('اختر الأعضاء لإضافتهم')
          .setMinValues(1)
          .setMaxValues(Math.min(memberOptions.length, 25))
          .addOptions(memberOptions);

        const row = new ActionRowBuilder().addComponents(selectMenu);
        const embed = colorManager.createEmbed()
          .setTitle(`**نتائج البحث: ${matchedMembers.size} عضو**`)
          .setDescription(`**تم العثور على ${matchedMembers.size} عضو يطابق البحث "${searchQuery}"**\n\n**اختر الأعضاء الذين تريد إضافتهم للمسؤولية: ${responsibilityName}**`);

        await safeReply(interaction, '', { embeds: [embed], components: [row] });

        // إضافة collector لـ select menu الخاص بالبحث
        const searchSelectFilter = i => i.user.id === interaction.user.id && i.customId === `add_searched_members_${responsibilityName}`;
        const searchSelectCollector = interaction.channel.createMessageComponentCollector({
          filter: searchSelectFilter,
          time: 60000,
          max: 1
        });

        searchSelectCollector.on('collect', async (selectInt) => {
          try {
            const selectedUserIds = selectInt.values;
            let addedCount = 0;
            let addedNames = [];

            for (const userId of selectedUserIds) {
              if (!responsibilities[responsibilityName].responsibles.includes(userId)) {
                responsibilities[responsibilityName].responsibles.push(userId);
                addedCount++;
                const member = await message.guild.members.fetch(userId).catch(() => null);
                if (member) {
                  addedNames.push(member.displayName || member.user.username);
                  
                  // إعطاء الرولات
                  if (responsibility.roles && responsibility.roles.length > 0) {
                    for (const roleId of responsibility.roles) {
                      await member.roles.add(roleId).catch(() => {});
                    }
                  }
                }
              }
            }

            if (addedCount > 0) {
              await saveResponsibilities();
              
              // مزامنة الرولات
              await syncResponsibilityRoles(responsibilityName, message.guild);
              
              // تحديث الإيمبد
              const respCommand = client.commands.get('resp');
              if (respCommand && respCommand.updateEmbedMessage) {
                await respCommand.updateEmbedMessage(client);
              }
            }

            await selectInt.update({ 
              content: `**✅ تم إضافة ${addedCount} مسؤول بنجاح: ${addedNames.join(', ')}**`,
              embeds: [],
              components: [] 
            });

            // تحديث واجهة الإدارة
            const newContent = await generateManagementContent(responsibilityName);
            await interaction.editReply(newContent);

          } catch (error) {
            console.error('خطأ في إضافة الأعضاء المبحوث عنهم:', error);
          }
        });
      } else if (interaction.customId.startsWith('settings_responsibility_roles_names_modal_')) {
        const currentSession = responsibilityRolesSession.get(interaction.user.id);
        if (!currentSession || !currentSession.anchorRoleId || !Array.isArray(currentSession.selectedResponsibilities) || currentSession.selectedResponsibilities.length === 0) {
          return await safeReply(interaction, '**انتهت جلسة إنشاء الرولات. أعد المحاولة من القائمة.**');
        }

        const step = parseInt(interaction.customId.replace('settings_responsibility_roles_names_modal_', ''), 10) || 0;
        const selectedResponsibilities = currentSession.selectedResponsibilities.slice(0, 24);
        const startIndex = step * 5;
        const currentChunk = selectedResponsibilities.slice(startIndex, startIndex + 5);

        if (!currentSession.roleNamesByResponsibility || typeof currentSession.roleNamesByResponsibility !== 'object') {
          currentSession.roleNamesByResponsibility = {};
        }

        for (let idx = 0; idx < currentChunk.length; idx++) {
          const absoluteIndex = startIndex + idx;
          const respName = selectedResponsibilities[absoluteIndex];
          const value = interaction.fields.getTextInputValue(`resp_role_name_${absoluteIndex}`)?.trim() || '';
          currentSession.roleNamesByResponsibility[respName] = value;
        }

        const requestedRoleNames = selectedResponsibilities.map((respName) => currentSession.roleNamesByResponsibility[respName] || '');
        if (requestedRoleNames.some((name) => !name)) {
          const nextStepToFill = Math.floor(requestedRoleNames.findIndex((name) => !name) / 5);
          if (nextStepToFill > step) {
            responsibilityRolesSession.set(interaction.user.id, currentSession);
            return await interaction.reply({
              content: `**✅ تم حفظ الجزء الحالي.**\n**اضغط \"إكمال\" لفتح الجزء التالي (${nextStepToFill + 1}).**`,
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`settings_responsibility_roles_open_modal_${nextStepToFill}`)
                    .setLabel('إكمال')
                    .setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder()
                    .setCustomId('settings_responsibility_roles_finish_create')
                    .setLabel('إنهاء وإنشاء')
                    .setStyle(ButtonStyle.Success)
                )
              ],
              ephemeral: true
            });
          }
          return await safeReply(interaction, '**يجب إدخال اسم لكل رول.**');
        }
        await finalizeResponsibilityRolesCreation(interaction, { allowPartial: false });
      }
    } catch (error) {
      console.error('خطأ في معالج المودال:', error);
      await safeReply(interaction, '**حدث خطأ أثناء معالجة النموذج**');
    }
  };

  // إضافة المعالج
  client.on('interactionCreate', modalHandler);

  // إزالة المعالج عند انتهاء الـ collector
  collector.on('end', () => {
    client.removeListener('interactionCreate', modalHandler);
    clearInterval(refreshInterval);
  });
}

module.exports = { name, execute };
