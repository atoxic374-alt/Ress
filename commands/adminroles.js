const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const { isUserBlocked } = require('./block.js');
const fs = require('fs');
const path = require('path');

const name = 'adminroles';

// مسار ملف رولات المشرفين
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

// دالة لقراءة رولات المشرفين
function loadAdminRoles() {
  try {
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

// دالة لحفظ رولات المشرفين
function saveAdminRoles(adminRoles) {
  try {
    const finalAdminRoles = Array.isArray(adminRoles) ? adminRoles : [];
    fs.writeFileSync(adminRolesPath, JSON.stringify(finalAdminRoles, null, 2));
    console.log('✅ تم حفظ رولات المشرفين في JSON');
    return true;
  } catch (error) {
    console.error('خطأ في حفظ adminRoles:', error);
    return false;
  }
}

async function execute(message, args, { saveData, BOT_OWNERS, client }) {
  // فحص البلوك أولاً
  if (isUserBlocked(message.author.id)) {
    const blockedEmbed = colorManager.createEmbed()
      .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
      .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

    await message.channel.send({ embeds: [blockedEmbed] });
    return;
  }

  // إعادة تحميل المالكين من الملف للتأكد من أحدث البيانات
  if (global.reloadBotOwners) {
    global.reloadBotOwners();
  }
  
  // معالجات قوية للسيرفرات الكبيرة
  const MAX_CONCURRENT_OPERATIONS = 10;
  const activeOperations = new Set();
  const rateLimitMap = new Map();

  // دالة لإدارة العمليات المتزامنة
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

  // دالة للتحكم في معدل الطلبات
  function checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = rateLimitMap.get(userId);

    if (userLimit && now - userLimit < 2000) {
      return false;
    }

    rateLimitMap.set(userId, now);
    return true;
  }

  // دالة آمنة للرد
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

  if (!BOT_OWNERS.includes(message.author.id)) {
    console.log(`❌ المستخدم ${message.author.id} ليس مالك. المالكين الحاليين:`, BOT_OWNERS);
    await message.react('❌');
    return;
  }

  // تحميل رولات المشرفين من الملف مباشرة
  let ADMIN_ROLES = loadAdminRoles();

  // إنشاء الإيمبد الرئيسي
  function createMainEmbed() {
    return colorManager.createEmbed()
      .setTitle('Admin roles')
      .setDescription(`**الرولات الحالية :**\n${ADMIN_ROLES.length > 0 ? ADMIN_ROLES.map((r, i) => `${i + 1}. <@&${r}>`).join('\n') : 'No roles.'}`)
      
      .setThumbnail('https://cdn.discordapp.com/emojis/1320524597367410788.png?v=1')
      .setFooter({ text: 'By Ahmed' });
  }

  // Create buttons
  const addButton = new ButtonBuilder()
    .setCustomId('adminroles_add')
    .setLabel('Add')
    .setStyle(ButtonStyle.Success)
    .setEmoji('➕');

  const removeButton = new ButtonBuilder()
    .setCustomId('adminroles_remove')
    .setLabel('Remove')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('➖');

  const listButton = new ButtonBuilder()
    .setCustomId('adminroles_list')
    .setLabel('list')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('📋');

  const row = new ActionRowBuilder().addComponents(addButton, removeButton, listButton);

  const sentMessage = await message.channel.send({ embeds: [createMainEmbed()], components: [row] });

  // Create collector for buttons
  const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
  const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });

  collector.on('collect', async interaction => {
    const operationId = `adminroles_${interaction.user.id}_${Date.now()}`;

    try {
      // التحقق من معدل الطلبات
      if (!checkRateLimit(interaction.user.id)) {
        return await safeReply(interaction, '**يرجى الانتظار قليلاً قبل المحاولة مرة أخرى**');
      }

      await manageConcurrentOperation(operationId, async () => {
        // التحقق من صلاحية التفاعل
        if (!interaction || !interaction.isRepliable()) {
          console.log('تفاعل غير صالح في adminroles');
          return;
        }

        // منع التفاعلات المتكررة
        if (interaction.replied || interaction.deferred) {
          console.log('تم تجاهل تفاعل متكرر في adminroles');
          return;
        }

        // إعادة تحميل رولات المشرفين في كل تفاعل
        ADMIN_ROLES = loadAdminRoles();

      if (interaction.customId === 'adminroles_add') {
        // Send message asking for roles with mention or ID
        await safeReply(interaction, '**منشن الرول او الآي دي **');

        // Create message collector
        const messageFilter = m => m.author.id === interaction.user.id;
        const messageCollector = interaction.channel.createMessageCollector({
          filter: messageFilter,
          time: 60000,
          max: 1
        });

        messageCollector.on('collect', async (msg) => {
          try {
            await msg.delete().catch(() => {});

            const rolesInput = msg.content.trim();
            const roleIds = rolesInput.split(/\s+/).map(role => role.replace(/[<@&>]/g, '')).filter(id => id);

            if (roleIds.length !== 1) {
              return interaction.followUp({ content: '**منشن رول واحد فقط أو اكتب ID واحد فقط.**', ephemeral: true });
            }

            const selectedRoleId = roleIds[0];
            let selectedRole;

            try {
              selectedRole = await interaction.guild.roles.fetch(selectedRoleId);
            } catch (error) {
              selectedRole = null;
            }

            if (!selectedRole) {
              return interaction.followUp({ content: '**❌ الرول غير موجود أو غير صالح.**', ephemeral: true });
            }

            const relatedRoles = interaction.guild.roles.cache
              .filter(role => role.id !== interaction.guild.roles.everyone.id && role.position >= selectedRole.position)
              .sort((a, b) => b.position - a.position);

            const relatedRoleIds = Array.from(relatedRoles.keys());

            if (relatedRoleIds.length === 0) {
              return interaction.followUp({ content: '**لم يتم العثور على رولات أعلى/مساوية للرول المحدد.**', ephemeral: true });
            }

            const stamp = Date.now();
            const confirmId = `adminroles_confirm_${interaction.user.id}_${stamp}`;
            const cancelId = `adminroles_cancel_${interaction.user.id}_${stamp}`;

            const confirmRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(confirmId).setLabel('تأكيد').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(cancelId).setLabel('إلغاء').setStyle(ButtonStyle.Danger)
            );

            await interaction.followUp({
              content: `**تأكيد العملية**\nسيتم تطبيق Toggle على ${relatedRoleIds.length} رول (الرول المحدد + كل الرولات الأعلى).\n\n${relatedRoleIds.map(id => `<@&${id}>`).join('\n')}`,
              components: [confirmRow],
              ephemeral: true
            });

            const buttonFilter = i => i.user.id === interaction.user.id && (i.customId === confirmId || i.customId === cancelId);
            const buttonInteraction = await interaction.channel.awaitMessageComponent({ filter: buttonFilter, time: 60000 }).catch(() => null);

            if (!buttonInteraction) {
              return interaction.followUp({ content: '**انتهت مهلة التأكيد.**', ephemeral: true });
            }

            if (buttonInteraction.customId === cancelId) {
              await buttonInteraction.update({ content: '**تم إلغاء العملية.**', components: [] });
              return;
            }

            let addedRoles = [];
            let removedRoles = [];

            for (const roleId of relatedRoleIds) {
              if (ADMIN_ROLES.includes(roleId)) {
                ADMIN_ROLES = ADMIN_ROLES.filter(id => id !== roleId);
                removedRoles.push(roleId);
              } else {
                ADMIN_ROLES.push(roleId);
                addedRoles.push(roleId);
              }
            }

            ADMIN_ROLES = [...new Set(ADMIN_ROLES)];

            if (addedRoles.length > 0 || removedRoles.length > 0) {
              saveAdminRoles(ADMIN_ROLES);

              if (global.updateAdminRolesCache) {
                global.updateAdminRolesCache();
              }

              if (client.logConfig && client.logConfig.logRoles) {
                const { updateLogPermissions } = require('./logs.js');
                await updateLogPermissions(message.guild, client.logConfig.logRoles);
              }
            }

            if (addedRoles.length > 0 || removedRoles.length > 0) {
              logEvent(client, message.guild, {
                type: 'ADMIN_ACTIONS',
                title: 'تعديل رولات الادارة (تبديل)',
                description: `تم تنفيذ تبديل على ${relatedRoleIds.length} رول (المحدد وما فوقه)`,
                user: message.author,
                fields: [
                  { name: 'الرول المحدد', value: `<@&${selectedRoleId}>`, inline: false },
                  { name: 'تمت الإضافة', value: addedRoles.length ? addedRoles.map(id => `<@&${id}>`).join('\n') : 'لا يوجد', inline: false },
                  { name: 'تمت الإزالة', value: removedRoles.length ? removedRoles.map(id => `<@&${id}>`).join('\n') : 'لا يوجد', inline: false }
                ]
              });
            }

            await buttonInteraction.update({
              content:
                `**✅ تم تنفيذ العملية**\n` +
                `- الرول المحدد: <@&${selectedRoleId}>\n` +
                `- تمت الإضافة: ${addedRoles.length}\n` +
                `- تمت الإزالة: ${removedRoles.length}`,
              components: []
            });

            await sentMessage.edit({ embeds: [createMainEmbed()], components: [row] });
          } catch (error) {
            console.error('Error processing roles:', error);
            await interaction.followUp({ content: '**حدث خطأ أثناء معالجة الرولات.**', ephemeral: true });
          }
        });
        messageCollector.on('end', (collected) => {
          if (collected.size === 0) {
            interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => {});
          }
        });

      } else if (interaction.customId === 'adminroles_remove') {
        if (ADMIN_ROLES.length === 0) {
          return safeReply(interaction, '** No roles to delete it **');
        }

        // Create numbered list of roles for removal
        let rolesList = '** Choose number :**\n\n';
        for (let i = 0; i < ADMIN_ROLES.length; i++) {
          const roleId = ADMIN_ROLES[i];
          try {
            const role = await message.guild.roles.fetch(roleId);
            const roleName = role ? role.name : 'رول محذوف';
            rolesList += `**${i + 1}.** ${role ? `<@&${roleId}>` : roleName} (${roleName})\n`;
          } catch (error) {
            rolesList += `**${i + 1}.** رول غير موجود (${roleId})\n`;
          }
        }

        rolesList += '\n **تأكد من المسافات بين الارقام**';

        await safeReply(interaction, rolesList);

        // Create message collector for numbers
        const messageFilter = m => m.author.id === interaction.user.id;
        const messageCollector = interaction.channel.createMessageCollector({
          filter: messageFilter,
          time: 60000,
          max: 1
        });

        messageCollector.on('collect', async (msg) => {
          try {
            await msg.delete().catch(() => {});

            const numbersInput = msg.content.trim();
            const numbers = numbersInput.split(/\s+/).map(num => parseInt(num.trim())).filter(num => !isNaN(num) && num > 0 && num <= ADMIN_ROLES.length);

            if (numbers.length === 0) {
              return interaction.followUp({ content: '**لم يتم تحديد أرقام صحيحة.**', ephemeral: true });
            }

            // Sort numbers in descending order to avoid index shifting issues
            numbers.sort((a, b) => b - a);

            let removedRoles = [];
            for (const num of numbers) {
              const roleId = ADMIN_ROLES[num - 1];
              if (roleId) {
                removedRoles.push(roleId);
                ADMIN_ROLES.splice(num - 1, 1);
              }
            }

            // حفظ التغييرات في JSON
            if (removedRoles.length > 0) {
              saveAdminRoles(ADMIN_ROLES);

              // تحديث الكاش
              if (global.updateAdminRolesCache) {
                global.updateAdminRolesCache();
              }

              // تحديث صلاحيات اللوق
              if (client.logConfig && client.logConfig.logRoles) {
                const { updateLogPermissions } = require('./logs.js');
                await updateLogPermissions(message.guild, client.logConfig.logRoles);
              }
            }

            // Log the admin role removal
            if (removedRoles.length > 0) {
              logEvent(client, message.guild, {
                type: 'ADMIN_ACTIONS',
                title: 'تمت إزالة رولات الاداره',
                description: `تم حذف ${removedRoles.length} رول من قائمة رولات الادارة`,
                user: message.author,
                fields: [
                  { name: 'الرولات المحذوفة', value: removedRoles.map(id => `<@&${id}>`).join('\n'), inline: false }
                ]
              });
            }

            let response = '';
            if (removedRoles.length > 0) {
              response += `**✅ تمت إزالة الرولات:**\n${removedRoles.map(id => `<@&${id}>`).join('\n')}`;
            }

            await interaction.followUp({ content: response || '**لم يتم إجراء أي تغييرات.**', ephemeral: true });

            // تحديث القائمة الرئيسية
            await sentMessage.edit({ embeds: [createMainEmbed()], components: [row] });
          } catch (error) {
            console.error('Error processing role removal:', error);
            await interaction.followUp({ content: '**حدث خطأ أثناء معالجة الرولات.**', ephemeral: true });
          }
        });

        messageCollector.on('end', (collected) => {
          if (collected.size === 0) {
            interaction.followUp({ content: '**انتهت مهلة الانتظار.**', ephemeral: true }).catch(() => {});
          }
        });

      } else if (interaction.customId === 'adminroles_list') {
        if (ADMIN_ROLES.length === 0) {
          return safeReply(interaction, '**لا توجد رولات محددة حالياً**');
        }

        // Create select menu with roles
        const roleOptions = [];
        for (let i = 0; i < ADMIN_ROLES.length && i < 25; i++) { // Discord limit of 25 options
          const roleId = ADMIN_ROLES[i];
          try {
            const role = await message.guild.roles.fetch(roleId);
            roleOptions.push({
              label: role ? `${i + 1}. ${role.name}` : `${i + 1}. رول محذوف`,
              value: roleId,
              description: role ? `معرف: ${roleId}` : 'رول غير موجود'
            });
          } catch (error) {
            roleOptions.push({
              label: `${i + 1}. رول غير موجود`,
              value: roleId,
              description: 'رول غير موجود'
            });
          }
        }

        const roleSelectMenu = new StringSelectMenuBuilder()
          .setCustomId('adminroles_select_role')
          .setPlaceholder('choose role to view members')
          .addOptions(roleOptions);

        const selectRow = new ActionRowBuilder().addComponents(roleSelectMenu);

        // Back button
        const backButton = new ButtonBuilder()
          .setCustomId('adminroles_back')
          .setLabel('Main menu')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔙');

        const backRow = new ActionRowBuilder().addComponents(backButton);

        const listEmbed = colorManager.createEmbed()
          .setTitle('choose role to show list')
          .setDescription(`**عدد الرولات:** ${ADMIN_ROLES.length}`)
         
          .setFooter({ text: 'By Ahmed.' })
          .setThumbnail('https://cdn.discordapp.com/emojis/1365249109149089813.png?v=1');
        await interaction.update({ embeds: [listEmbed], components: [selectRow, backRow] });

      } else if (interaction.customId === 'adminroles_select_role') {
        const selectedRoleId = interaction.values[0];

        try {
          const role = await message.guild.roles.fetch(selectedRoleId);
          if (!role) {
            return interaction.reply({ content: '**هذا الرول غير موجود.**', ephemeral: true });
          }

          // Get members with mentions and numbers
          const membersArray = Array.from(role.members.values());
          const members = membersArray.map((member, index) => `**${index + 1}.** <@${member.id}>`);

          const memberEmbed = colorManager.createEmbed()
            .setTitle(`Members : ${role.name}`)
            .setDescription(members.length > 0 ? members.join('\n') : '**لا يوجد أعضاء في هذا الرول**')
            
            .setThumbnail('https://cdn.discordapp.com/emojis/1320524607467425924.png?v=1')
            .setFooter({ text: ` Members count : ${members.length}` });

          // Back to roles list button
          const backToListButton = new ButtonBuilder()
            .setCustomId('adminroles_list')
            .setLabel('Roles list')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋');

          // Back to main menu button
          const backToMainButton = new ButtonBuilder()
            .setCustomId('adminroles_back')
            .setLabel('main menu')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔙');

          const buttonRow = new ActionRowBuilder().addComponents(backToListButton, backToMainButton);

          await interaction.update({ embeds: [memberEmbed], components: [buttonRow] });
        } catch (error) {
          await interaction.reply({ content: '**حدث خطأ أثناء جلب معلومات الرول.**', ephemeral: true });
        }

      } else if (interaction.customId === 'adminroles_back') {
        // Return to main menu
        await interaction.update({ embeds: [createMainEmbed()], components: [row] });
      }
      });
    } catch (operationError) {
      console.error('خطأ في العملية المتزامنة:', operationError);
      await safeReply(interaction, '**السيرفر مزدحم، يرجى المحاولة لاحقاً**');
    }
  });

  collector.on('end', () => {
    // Disable buttons when collector ends
    const disabledRow = new ActionRowBuilder().addComponents(
      addButton.setDisabled(true),
      removeButton.setDisabled(true),
      listButton.setDisabled(true)
    );
    sentMessage.edit({ components: [disabledRow] }).catch(console.error);
  });
}

// معالج التفاعلات
async function handleInteraction(interaction, context) {
  const { BOT_OWNERS } = context || {};
  const ownersList = Array.isArray(BOT_OWNERS) ? BOT_OWNERS : (global.BOT_OWNERS || []);
  
  // التحقق من الصلاحيات
  if (global.reloadBotOwners) {
    global.reloadBotOwners();
  }
  
  if (!ownersList.includes(interaction.user.id)) {
    console.log(`❌ المستخدم ${interaction.user.id} ليس مالك`);
    if (interaction?.isRepliable?.() && !interaction.replied && !interaction.deferred) {
      return interaction.reply({ 
        content: '❌ ليس لديك صلاحية لاستخدام هذا الأمر', 
        flags: 64 
      }).catch(() => {});
    }
    return false;
  }
  
  // تمرير التفاعل للمعالج الرئيسي
  // يمكن إضافة منطق إضافي هنا حسب الحاجة
  console.log(`✅ معالجة تفاعل adminroles: ${interaction.customId}`);
}

module.exports = { name, execute, handleInteraction };
