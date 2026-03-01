const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');

module.exports = {
  name: 'help',
  description: 'Help commands',
  async execute(message, args, { responsibilities, points, saveData, BOT_OWNERS, ADMIN_ROLES, client }) {
    const member = await message.guild.members.fetch(message.author.id);
    const hasAdminRole = member.roles.cache.some(role => ADMIN_ROLES.includes(role.id));
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    const hasAdministrator = member.permissions.has('Administrator');

    const canUseAdminCommands = hasAdminRole || isOwner || hasAdministrator;
    const canUseOwnerCommands = isOwner;

    const fs = require('fs');
    const path = require('path');
    const botConfigFile = path.join(__dirname, '..', 'data', 'botConfig.json');
    const botConfig = JSON.parse(fs.readFileSync(botConfigFile, 'utf8'));
    
    // قراءة البريفكس الفعلي من الملف
    let PREFIX = botConfig.prefix;
    
    // إزالة علامات التنصيص إذا كانت موجودة
    if (PREFIX && typeof PREFIX === 'string' && PREFIX.startsWith('"') && PREFIX.endsWith('"')) {
        PREFIX = PREFIX.slice(1, -1);
    }
    
    // استخدام قيمة افتراضية فقط إذا كان undefined (ليس null)
    if (PREFIX === undefined) {
        PREFIX = '.';
    }

    const ownerCommands = [
      {
        name: 'vip',
        description: '**Bot Setup**',
        usage: PREFIX === null ? 'vip' : `${PREFIX}vip`,
        details: '**- تغيير البرفكس والاسم والافتار والبنر واعادة تشغيل البوت مع إعدادات متقدمة**'
      },
      {
        name: 'adminroles',
        description: '**Admin setup**',
        usage: PREFIX === null ? 'adminroles' : `${PREFIX}adminroles`,
        details: '**- يضيف أو يحذف رتب الإدارة المسموح لها لاستخدام أوامر الإدارة**'
      },
      {
        name: 'block',
        description: '**Block System**',
        usage: PREFIX === null ? 'block [منشن/آي دي]' : `${PREFIX}block [منشن/آي دي]`,
        details: '**- نظام حظر لاعضاء من استخدام أوامر البوت**'
      },
      {
        name: 'blocklist',
        description: '**Block List**',
        usage: PREFIX === null ? 'blocklist' : `${PREFIX}blocklist`,
        details: '**- عرض قائمة المستخدمين المحظورين مع إمكانية إلغاء الحظر**'
      },
      {
        name: 'call',
        description: '**Res call**',
        usage: PREFIX === null ? 'call [اسم المسؤولية]' : `${PREFIX}call [اسم المسؤولية]`,
        details: '**- استدعاء مسؤول لمسؤولية محددة (للأونرز فقط)**'
      },
      {
        name: 'reset',
        description: '**Reset Points**',
        usage: PREFIX === null ? 'reset' : `${PREFIX}reset`,
        details: '**- يعيد تعيين نقاط لمسؤولية معينة او مسؤول معين او اعادة تعين شهرية - يومية - اسبوعية**'
      },
      {
        name: 'check',
        description: '**Check System**',
        usage: PREFIX === null ? 'check' : `${PREFIX}check`,
        details: '**- فحص عضو او رول من ناحية التفاعل والرومات**'
      },
      {
        name: 'setadmin',
        description: '**Set Admin**',
        usage: PREFIX === null ? 'setadmin' : `${PREFIX}setadmin`,
        details: '**-  تعين نظام التقديم الاداري**'
      },
      {
        name: 'promote',
        description: '**Promotion System**',
        usage: PREFIX === null ? 'promote' : `${PREFIX}promote`,
        details: '**- تعين نظام ترقية الاعضاء **'
      },
      {
        name: 'settings',
        description: '**Res Settings**',
        usage: PREFIX === null ? 'settings' : `${PREFIX}settings`,
        details: '**- اضافة وازالة مسؤوليات وتعديل المسؤولين والشرح لكل مسؤولية**'
      },    
      {
        name: 'log',
        description: '**Log Setup**',
        usage: PREFIX === null ? 'log' : `${PREFIX}log`,
        details: '**-  تعيين اللوقز تلقائياً او تعيين حسب الرغبة بروم معين او تعطيلها وتعين الرولات لرؤيتها**'
      },
      {
        name: 'cooldown',
        description: '**Cooldown Setup**',
        usage: PREFIX === null ? 'cooldown' : `${PREFIX}cooldown`,
        details: '**- يحدد فترات الانتظار لاستدعاء المسؤولين لعدم الازعاج والسبام**'
      },
      {
        name: 'notifications',
        description: '**Notification Setup**',
        usage: PREFIX === null ? 'notifications' : `${PREFIX}notifications`,
        details: '**- نظام تنبيه وتذكير بالمسؤوليات والطلبات المعلقة**'
      },
      {
        name: 'down',
        description: '**Down System**',
        usage: PREFIX === null ? 'down' : `${PREFIX}down`,
        details: '**- تعيين نظام الداون  **'
      },
      {
        name: 'resp',
        description: '**Response System**',
        usage: PREFIX === null ? 'resp' : `${PREFIX}resp`,
        details: '**- رساله المسؤوليات والاقتراحات**'
      },
      {
        name: 'set-vacation',
        description: '**Set Vacation**',
        usage: PREFIX === null ? 'set-vacation' : `${PREFIX}set-vacation`,
        details: '**- تعيين نظام الاجازات**'
      },
      {
        name: 'report',
        description: '**Report System**',
        usage: PREFIX === null ? 'report' : `${PREFIX}report`,
        details: '**- نظام التقارير للمسؤوليات**'
      },
          {

        name: 'stats',

        description: '**Res stats**',

        usage: PREFIX === null ? 'stats [اسم المسؤولية]' : `${PREFIX}stats [اسم المسؤولية]`,

        details: '**- يعرض إحصائيات شاملة عن المسؤوليات وتفاعلهم**'
         },
    ];

    const adminCommands = [
      {
        name: 'ادارة',
        description: '**Admin Applications**',
        usage: PREFIX === null ? 'admin-apply' : `${PREFIX}ادارة`,
        details: '**- ترشيح عضو للإدارة والموافقة عليها من المسؤولين**'
      },
      {
        name: 'مسؤول',
        description: '**Res help**',
        usage: PREFIX === null ? 'مسؤول' : `${PREFIX}مسؤول`,
        details: '**- يرسل طلب مساعدة للمسؤولين في مسؤولية معينة من الاداريين**'
      },
      {
        name: 'اجازه',
        description: '**Vacation Management**',
        usage: PREFIX === null ? 'اجازه' : `${PREFIX}اجازه`,
        details: '**- إدارة طلبات الإجازات والموافقة عليها**'
      },
      {
        name: 'مسؤولياتي',
        description: '**My Responsibilities**',
        usage: PREFIX === null ? 'مسؤولياتي' : `${PREFIX}مسؤولياتي`,
        details: '**- يعرض مسؤولياتك وشرحها**'
      },
      {
        name: 'اجازتي',
        description: '**My Vacation**',
        usage: PREFIX === null ? 'اجازتي' : `${PREFIX}اجازتي`,
        details: '**- عرض إجازاتك وطلب انهاء اجازتك**'
      },
      {
        name: 'top',
        description: '**Top Points**',
        usage: PREFIX === null ? 'top [اسم المسؤولية]' : `${PREFIX}top [اسم المسؤولية]`,
        details: '**- يعرض ترتيب الأعضاء حسب النقاط في الشهر - اليوم - الاسبوع**'
      },
    
    ];

    const generalCommands = [
      {
        name: 'help',
        description: '**Commands information**',
        usage: PREFIX === null ? 'help' : `${PREFIX}help`,
        details: '**- يعرض جميع الاوامر وتفاصيلها مع واجهة تفاعلية محسنة**'
      },
      {
        name: 'تفاعلي',
        description: '**Activity Stats**',
        usage: PREFIX === null ? 'تفاعلي' : `${PREFIX}تفاعلي`,
        details: '**- يعرض إحصائيات التفاعل من رسائل وفويس وتفاعلات**'
      },
      {
        name: 'توب',
        description: '**All Leaderboards**',
        usage: PREFIX === null ? 'tops' : `${PREFIX}tops`,
        details: '**- عرض جميع التوبات والترتيبات**'
      }
    ];

    function createCategoryEmbed(category, commands) {
      let categoryTitle = '';
      
      if (category === 'owner') {
        categoryTitle = '**Owners**';
      } else if (category === 'admin') {
        categoryTitle = '**Admins**';
      } else {
        categoryTitle = '**General**';
      }

      const embed = colorManager.createEmbed()
        .setTitle(categoryTitle)
        .setDescription(`**اختر أمراً من القائمة أدناه لعرض تفاصيله**\n\n**عدد الأوامر :** ${commands.length}`)
        .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398096852456574996/images__2_-removebg-preview_2.png?ex=68841ea9&is=6882cd29&hm=0dd6d1378c1aa15cc1edb77c9bc67e46ec78ba811268d90ca90ed6c8121ae3f2&')
        .setFooter({ text: 'By Ahmed.' })
        .setTimestamp();

      return embed;
    }

    let currentCategory = 'general';
    let currentCommands = generalCommands;

    if (canUseOwnerCommands) {
      currentCategory = 'owner';
      currentCommands = ownerCommands;
    } else if (canUseAdminCommands) {
      currentCategory = 'admin';
      currentCommands = adminCommands;
    }

    function createComponents(category) {
      let commands = generalCommands;
      if (category === 'owner') commands = ownerCommands;
      if (category === 'admin') commands = adminCommands;

      const menuOptions = commands.map(cmd => ({
        label: cmd.name,
        description: cmd.description.replace(/\*/g, '').substring(0, 100),
        value: `${category}_${cmd.name}`
      }));

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('help_command_select')
        .setPlaceholder('اختر أمراً لعرض تفاصيله...')
        .addOptions(menuOptions);

      const navigationButtons = new ActionRowBuilder();

      navigationButtons.addComponents(
        new ButtonBuilder()
          .setCustomId('help_category_owner')
          .setLabel('أوامر الأونرز')
          .setStyle(category === 'owner' ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

      navigationButtons.addComponents(
        new ButtonBuilder()
          .setCustomId('help_category_admin')
          .setLabel('أوامر الإدارة')
          .setStyle(category === 'admin' ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

      navigationButtons.addComponents(
        new ButtonBuilder()
          .setCustomId('help_category_general')
          .setLabel('أوامر عامة')
          .setStyle(category === 'general' ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

      const cancelButton = new ButtonBuilder()
        .setCustomId('help_cancel')
        .setLabel('إلغاء')
        .setStyle(ButtonStyle.Danger);

      const row1 = new ActionRowBuilder().addComponents(selectMenu);
      const row2 = navigationButtons;
      const row3 = new ActionRowBuilder().addComponents(cancelButton);

      return [row1, row2, row3];
    }

    const initialEmbed = createCategoryEmbed(currentCategory, currentCommands);
    const initialComponents = createComponents(currentCategory);

    const sentMessage = await message.channel.send({ 
      embeds: [initialEmbed],
      components: initialComponents
    });

    const filter = i => i.user.id === message.author.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 300000 });
    
    collector.on('collect', async interaction => {
      try {
        const now = Date.now();
        const interactionAge = now - interaction.createdTimestamp;
        
        if (interactionAge > 14 * 60 * 1000) {
          console.log('تم تجاهل تفاعل منتهي الصلاحية');
          return;
        }

        if (!interaction || !interaction.isRepliable()) {
          console.log('تم تجاهل تفاعل غير صالح');
          return;
        }

        if (interaction.replied || interaction.deferred) {
          console.log('تم تجاهل تفاعل تم الرد عليه مسبقاً');
          return;
        }

        if (interaction.customId === 'help_cancel') {
          try {
            await interaction.update({ 
              content: '**تم إلغاء قائمة المساعدة**', 
              embeds: [], 
              components: [] 
            });
            setTimeout(() => {
              interaction.message.delete().catch(() => {});
            }, 2000);
          } catch (error) {
            console.error('خطأ في إلغاء المساعدة:', error);
          }
          return;
        }

        if (interaction.customId.startsWith('help_category_')) {
          const category = interaction.customId.replace('help_category_', '');

          currentCategory = category;
          if (category === 'owner') currentCommands = ownerCommands;
          else if (category === 'admin') currentCommands = adminCommands;
          else currentCommands = generalCommands;

          const newEmbed = createCategoryEmbed(category, currentCommands);
          const newComponents = createComponents(category);

          await interaction.update({ 
            embeds: [newEmbed], 
            components: newComponents 
          });
          return;
        }

        if (interaction.customId === 'help_command_select') {
          const selectedValue = interaction.values[0];
          const [category, commandName] = selectedValue.split('_');
          
          let commands = generalCommands;
          if (category === 'owner') commands = ownerCommands;
          if (category === 'admin') commands = adminCommands;

          const commandInfo = commands.find(cmd => cmd.name === commandName);

          if (commandInfo) {
            const detailEmbed = colorManager.createEmbed()
              .setTitle(`**Command : ${commandInfo.name}**`)
              .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398096852456574996/images__2_-removebg-preview_2.png?ex=68841ea9&is=6882cd29&hm=0dd6d1378c1aa15cc1edb77c9bc67e46ec78ba811268d90ca90ed6c8121ae3f2&')
              .addFields(
                { name: '** - Description**', value: commandInfo.description, inline: false },
                { name: '** - Usage**', value: commandInfo.usage, inline: false },
                { name: '** - Details**', value: commandInfo.details, inline: false }
              )
              .setFooter({ text: 'By Ahmed.' })
              .setTimestamp();

            const backButton = new ButtonBuilder()
              .setCustomId(`help_back_${category}`)
              .setLabel('العودة')
              .setStyle(ButtonStyle.Primary);

            const cancelButton = new ButtonBuilder()
              .setCustomId('help_cancel')
              .setLabel('إلغاء')
              .setStyle(ButtonStyle.Danger);

            const backRow = new ActionRowBuilder().addComponents(backButton, cancelButton);

            await interaction.update({ 
              embeds: [detailEmbed], 
              components: [backRow] 
            });
          }
          return;
        }

        if (interaction.customId.startsWith('help_back_')) {
          const category = interaction.customId.replace('help_back_', '');
          
          let commands = generalCommands;
          if (category === 'owner') commands = ownerCommands;
          else if (category === 'admin') commands = adminCommands;

          const newEmbed = createCategoryEmbed(category, commands);
          const newComponents = createComponents(category);

          await interaction.update({ 
            embeds: [newEmbed], 
            components: newComponents 
          });
          return;
        }

      } catch (error) {
        console.error('خطأ في معالجة تفاعل المساعدة:', error);
        
        if (interaction && interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ 
              content: '**- حدث خطأ أثناء معالجة طلبك**', 
              flags: 64
            });
          } catch (replyError) {
            console.error('فشل في الرد على خطأ التفاعل:', replyError);
          }
        }
      }
    });

    collector.on('end', () => {
      const disabledComponents = createComponents(currentCategory).map(row => {
        const newRow = new ActionRowBuilder();
        row.components.forEach(component => {
          if (component instanceof StringSelectMenuBuilder) {
            newRow.addComponents(StringSelectMenuBuilder.from(component).setDisabled(true));
          } else if (component instanceof ButtonBuilder) {
            newRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
          }
        });
        return newRow;
      });

      sentMessage.edit({ components: disabledComponents }).catch(() => {});
    });
  }
     }