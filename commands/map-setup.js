const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const configPath = path.join(__dirname, '..', 'data', 'serverMapConfig.json');
const imagesDir = path.join(__dirname, '..', 'attached_assets', 'map_images');

// التأكد من وجود مجلد الصور
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
}

async function downloadImage(url, filename) {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        const filePath = path.join(imagesDir, filename);
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(filePath));
            writer.on('error', reject);
        });
    } catch (e) {
        console.error('Error downloading image:', e.message);
        return null;
    }
}

function loadAllConfigs() {
    try {
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            // تحويل التنسيق القديم (object واحد) إلى الجديد (multi-config) إذا لزم الأمر
            if (data.imageUrl && !data.global) {
                return { global: data };
            }
            return data;
        }
    } catch (e) {
        console.error('Error loading map config in setup:', e.message);
    }
    return { global: { enabled: false, imageUrl: 'https://i.ibb.co/pP9GzD7/default-map.png', welcomeMessage: '** Welcome **', buttons: [] } };
}

function saveAllConfigs(allConfigs) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(allConfigs, null, 2));
        return true;
    } catch (e) {
        console.error('Error saving map config:', e.message);
        return false;
    }
}

function loadConfig() {
    const all = loadAllConfigs();
    return all.global;
}

function saveConfig(config) {
    const all = loadAllConfigs();
    all.global = config;
    return saveAllConfigs(all);
}

module.exports = {
    name: 'map-setup',
    description: 'إعدادات خريطة السيرفر',
    async execute(message, args, { BOT_OWNERS }) {
        try {
            const isOwner = BOT_OWNERS.includes(message.author.id);
            if (!isOwner) {
                await message.react('❌').catch(() => {});
                return;
            }

            // تحديد القناة المستهدفة (من المنشن أو الأيدي أو القناة الحالية)
            const targetChannel = message.mentions.channels.first() || 
                                 (args[0] && message.guild.channels.cache.get(args[0])) || 
                                 null;
            
            const configKey = targetChannel ? `channel_${targetChannel.id}` : 'global';
            
            // نظام منع التداخل: استخدام كوليكتور واحد لكل مفتاح إعدادات
            if (!client.mapSetupCollectors) client.mapSetupCollectors = new Map();
            const sessionKey = `${message.guild.id}_${configKey}`;
            
            if (client.mapSetupCollectors.has(sessionKey)) {
                const oldCollector = client.mapSetupCollectors.get(sessionKey);
                oldCollector.stop('new_session');
            }

            const allConfigs = loadAllConfigs();
            let config = allConfigs[configKey] || { enabled: false, imageUrl: 'https://i.ibb.co/pP9GzD7/default-map.png', welcomeMessage: '', buttons: [] };

            const sendMainEmbed = async (msgOrInteraction) => {
                const colorManager = require('../utils/colorManager.js');
                const embed = new EmbedBuilder()
                    .setTitle(targetChannel ? `⚙️ إعدادات خريطة روم : ${targetChannel.name}` : '⚙️ إعدادات خريطة السيرفر العامة')
                    .setDescription(`**الحالة :** ${config.enabled ? '✅ مفعل' : '❌ معطل'}\n**الرسالة :** ${config.welcomeMessage || 'لا يوجد نص'}\n**عدد الأزرار :** ${config.buttons.length}/25\n\n*ملاحظة: هذه الإعدادات ${targetChannel ? 'خاصة بهذا الروم فقط' : 'عامة (تُستخدم في الخاص)'}.*`)
                    .setImage(config.imageUrl)
                    .setColor(colorManager.getColor('primary'))
                    .setFooter({ text: 'نظام الخريطة التفاعلي • Ress Bot' });

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('toggle_map').setLabel(config.enabled ? 'تعطيل' : 'تفعيل').setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('add_button').setLabel('إضافة زر').setStyle(ButtonStyle.Secondary).setDisabled(config.buttons.length >= 25),
                    new ButtonBuilder().setCustomId('reorder_buttons').setLabel('ترتيب الأزرار').setStyle(ButtonStyle.Secondary).setDisabled(config.buttons.length < 2)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('manage_emojis').setLabel(' الإيموجيات').setStyle(ButtonStyle.Secondary).setDisabled(config.buttons.length === 0),
                    new ButtonBuilder().setCustomId('edit_button').setLabel('تعديل زر').setStyle(ButtonStyle.Secondary).setDisabled(config.buttons.length === 0),
                    new ButtonBuilder().setCustomId('edit_image').setLabel(' الصورة').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('edit_msg').setLabel(' الرسالة').setStyle(ButtonStyle.Secondary)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('clear_buttons').setLabel('مسح زر').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('preview_map').setLabel('معاينة').setStyle(ButtonStyle.Success)
                );

                const options = { embeds: [embed], components: [row1, row2, row3] };
                
                try {
                    // إذا كان لدينا تفاعل (Interaction)
                    if (msgOrInteraction.isRepliable && msgOrInteraction.isRepliable()) {
                        if (msgOrInteraction.replied || msgOrInteraction.deferred) {
                            return await msgOrInteraction.editReply(options);
                        } else {
                            return await msgOrInteraction.update(options).catch(async () => {
                                return await msgOrInteraction.reply(options);
                            });
                        }
                    } 
                    
                    // إذا كان لدينا كائن رسالة (Message)
                    if (msgOrInteraction.edit && msgOrInteraction.author?.id === message.client.user.id) {
                        return await msgOrInteraction.edit(options);
                    }

                    // كخيار أخير: إرسال رسالة جديدة (فقط في المرة الأولى)
                    return await message.channel.send(options);
                } catch (err) {
                    console.error('Error updating setup menu:', err.message);
                }
            };

            const mainMsg = await sendMainEmbed(message);
            if (!mainMsg) return;

            const collector = mainMsg.createMessageComponentCollector({ 
                filter: i => i.user.id === message.author.id,
                time: 600000 
            });

            client.mapSetupCollectors.set(sessionKey, collector);

            collector.on('end', () => {
                if (client.mapSetupCollectors.get(sessionKey) === collector) {
                    client.mapSetupCollectors.delete(sessionKey);
                }
            });

            collector.on('collect', async i => {
                try {
                    // التحقق من صلاحية التفاعل قبل البدء
                    if (i.replied || i.deferred) return;

                    const allConfigs = loadAllConfigs();
                    if (i.isStringSelectMenu() && i.customId === 'delete_buttons_emoji') {
                        const selectedIndices = i.values.map(v => parseInt(v));
                        config.buttons.forEach((btn, idx) => {
                            if (selectedIndices.includes(idx)) {
                                btn.emoji = null;
                            }
                        });
                        allConfigs[configKey] = config;
                        saveAllConfigs(allConfigs);
                        
                        const embed = EmbedBuilder.from(i.message.embeds[0] || new EmbedBuilder())
                            .setDescription(`✅ تم حذف الإيموجيات المختارة (${selectedIndices.length} أزرار).`);
                        
                        await i.update({ embeds: [embed] });
                        return;
                    }

                    if (i.isStringSelectMenu() && i.customId === 'select_buttons_emoji') {
                        const selectedIndices = i.values.map(v => parseInt(v));
                        
                        // طلب الإيموجي عبر رسالة جديدة بدلاً من مسح الإيمبد
                        const promptMsg = await i.reply({ content: `📝 أرسل الإيموجي الذي تريد وضعه لـ ${selectedIndices.length} أزرار مختارة الآن :`, fetchReply: true });

                        const msgFilter = m => m.author.id === message.author.id;
                        try {
                            const collected = await i.channel.awaitMessages({ filter: msgFilter, time: 30000, max: 1, errors: ['time'] });
                            const emojiStr = collected.first().content.trim();
                            
                            config.buttons.forEach((btn, idx) => {
                                if (selectedIndices.includes(idx)) {
                                    btn.emoji = emojiStr;
                                }
                            });

                            const latestConfigs = loadAllConfigs();
                            latestConfigs[configKey] = config;
                            saveAllConfigs(latestConfigs);

                            await collected.first().delete().catch(() => {});
                            await promptMsg.delete().catch(() => {});

                            const embed = EmbedBuilder.from(i.message.embeds[0] || new EmbedBuilder())
                                .setDescription(`✅ تم وضع الإيموجي (${emojiStr}) لـ ${selectedIndices.length} أزرار.`);
                            
                            await i.editReply({ content: '', embeds: [embed], components: i.message.components });
                        } catch (e) {
                            await promptMsg.edit({ content: '⌛ انتهى الوقت، لم يتم إرسال إيموجي.', components: [] }).catch(() => {});
                        }
                        return;
                    }

                    if (i.customId === 'toggle_map') {
                        config.enabled = !config.enabled;
                        allConfigs[configKey] = config;
                        saveAllConfigs(allConfigs);
                        await sendMainEmbed(i);
                    } else if (i.customId === 'edit_button') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لتعديلها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: `تعديل : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_button_to_edit')
                            .setPlaceholder('اختر الزر الذي تريد تعديله')
                            .addOptions(options);

                        await i.update({
                            content: '📝 اختر الزر الذي تريد تعديل بياناته:',
                            embeds: [],
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.isStringSelectMenu() && i.customId === 'select_button_to_edit') {
                        const idx = parseInt(i.values[0]);
                        const btn = config.buttons[idx];
                        
                        const modal = new ModalBuilder().setCustomId(`modal_edit_btn_${configKey}_${idx}`).setTitle(`تعديل زر: ${btn.label}`);
                        const labelInput = new TextInputBuilder().setCustomId('btn_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setMaxLength(80).setValue(btn.label || '').setRequired(true);
                        const emojiInput = new TextInputBuilder().setCustomId('btn_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.emoji || '').setPlaceholder('مثال: 📍 أو :emoji_name:').setRequired(false);
                        const descInput = new TextInputBuilder().setCustomId('btn_desc').setLabel('شرح الزر (يظهر عند الضغط)').setStyle(TextInputStyle.Paragraph).setValue(btn.description || '').setRequired(true);
                        const roleInput = new TextInputBuilder().setCustomId('btn_role').setLabel('ID الرول (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.roleId || '').setRequired(false);
                        
                        // معالجة الروابط لتحويلها من array إلى string للعرض في المودال
                        let linksStr = '';
                        if (btn.links && Array.isArray(btn.links)) {
                            linksStr = btn.links.map(l => `${l.label},${l.url}`).join('\n');
                        }
                        const linksInput = new TextInputBuilder().setCustomId('btn_links').setLabel('الروابط (اسم1,رابط1 | اسم2,رابط2)').setStyle(TextInputStyle.Paragraph).setValue(linksStr).setPlaceholder('مثال:\nروم الفعاليات,https://...\nروم القوانين,https://...').setRequired(false);
                        
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(labelInput),
                            new ActionRowBuilder().addComponents(emojiInput),
                            new ActionRowBuilder().addComponents(descInput),
                            new ActionRowBuilder().addComponents(roleInput),
                            new ActionRowBuilder().addComponents(linksInput)
                        );
                        await i.showModal(modal);
                    } else if (i.customId === 'edit_button') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لتعديلها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: `تعديل : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_button_to_edit')
                            .setPlaceholder('اختر الزر الذي تريد تعديله')
                            .addOptions(options);

                        await i.update({
                            content: '📝 اختر الزر الذي تريد تعديل بياناته:',
                            embeds: [],
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.isStringSelectMenu() && i.customId === 'select_button_to_edit') {
                        const idx = parseInt(i.values[0]);
                        const btn = config.buttons[idx];
                        
                        const modal = new ModalBuilder().setCustomId(`modal_edit_btn_${configKey}_${idx}`).setTitle(`تعديل زر: ${btn.label}`);
                        const labelInput = new TextInputBuilder().setCustomId('btn_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setMaxLength(80).setValue(btn.label || '').setRequired(true);
                        const emojiInput = new TextInputBuilder().setCustomId('btn_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.emoji || '').setPlaceholder('مثال: 📍 أو :emoji_name:').setRequired(false);
                        const descInput = new TextInputBuilder().setCustomId('btn_desc').setLabel('شرح الزر (يظهر عند الضغط)').setStyle(TextInputStyle.Paragraph).setValue(btn.description || '').setRequired(true);
                        const roleInput = new TextInputBuilder().setCustomId('btn_role').setLabel('ID الرول (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.roleId || '').setRequired(false);
                        
                        let linksStr = '';
                        if (btn.links && Array.isArray(btn.links)) {
                            linksStr = btn.links.map(l => `${l.label},${l.url}`).join('\n');
                        }
                        const linksInput = new TextInputBuilder().setCustomId('btn_links').setLabel('الروابط (اسم1,رابط1 | اسم2,رابط2)').setStyle(TextInputStyle.Paragraph).setValue(linksStr).setPlaceholder('مثال:\nروم الفعاليات,https://...\nروم القوانين,https://...').setRequired(false);
                        
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(labelInput),
                            new ActionRowBuilder().addComponents(emojiInput),
                            new ActionRowBuilder().addComponents(descInput),
                            new ActionRowBuilder().addComponents(roleInput),
                            new ActionRowBuilder().addComponents(linksInput)
                        );
                        await i.showModal(modal);
                    } else if (i.customId === 'edit_image') {
                        const modal = new ModalBuilder().setCustomId(`modal_image_${configKey}`).setTitle('تغيير صورة الخريطة');
                        const input = new TextInputBuilder().setCustomId('img_url').setLabel('رابط الصورة (URL)').setStyle(TextInputStyle.Short).setValue(config.imageUrl).setRequired(true);
                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        await i.showModal(modal);
                    } else if (i.customId === 'edit_msg') {
                        const modal = new ModalBuilder().setCustomId(`modal_msg_${configKey}`).setTitle('تعديل رسالة الترحيب');
                        const input = new TextInputBuilder().setCustomId('welcome_text').setLabel('النص').setStyle(TextInputStyle.Paragraph).setValue(config.welcomeMessage || '').setRequired(false);
                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        await i.showModal(modal);
                    } else if (i.customId === 'add_button') {
                        const modal = new ModalBuilder().setCustomId(`modal_add_btn_${configKey}`).setTitle('إضافة زر جديد');
                        const labelInput = new TextInputBuilder().setCustomId('btn_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
                        const emojiInput = new TextInputBuilder().setCustomId('btn_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setPlaceholder('مثال: 📍 أو :emoji_name:').setRequired(false);
                        const descInput = new TextInputBuilder().setCustomId('btn_desc').setLabel('شرح الزر (يظهر عند الضغط)').setStyle(TextInputStyle.Paragraph).setRequired(true);
                        const roleInput = new TextInputBuilder().setCustomId('btn_role').setLabel('ID الرول (اختياري - للإعطاء/الإزالة)').setStyle(TextInputStyle.Short).setRequired(false);
                        const linksInput = new TextInputBuilder().setCustomId('btn_links').setLabel('الروابط (اسم1,رابط1 | اسم2,رابط2)').setStyle(TextInputStyle.Paragraph).setPlaceholder('مثال:\nروم الفعاليات,https://...\nروم القوانين,https://...').setRequired(false);
                        
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(labelInput),
                            new ActionRowBuilder().addComponents(emojiInput),
                            new ActionRowBuilder().addComponents(descInput),
                            new ActionRowBuilder().addComponents(roleInput),
                            new ActionRowBuilder().addComponents(linksInput)
                        );
                        await i.showModal(modal);
                    } else if (i.customId === 'edit_button') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لتعديلها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: `تعديل : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_button_to_edit')
                            .setPlaceholder('اختر الزر الذي تريد تعديله')
                            .addOptions(options);

                        await i.update({
                            content: '📝 اختر الزر الذي تريد تعديل بياناته:',
                            embeds: [],
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.isStringSelectMenu() && i.customId === 'select_button_to_edit') {
                        const idx = parseInt(i.values[0]);
                        const btn = config.buttons[idx];
                        
                        const modal = new ModalBuilder().setCustomId(`modal_edit_btn_${configKey}_${idx}`).setTitle(`تعديل زر: ${btn.label}`);
                        const labelInput = new TextInputBuilder().setCustomId('btn_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setMaxLength(80).setValue(btn.label || '').setRequired(true);
                        const emojiInput = new TextInputBuilder().setCustomId('btn_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.emoji || '').setPlaceholder('مثال: 📍 أو :emoji_name:').setRequired(false);
                        const descInput = new TextInputBuilder().setCustomId('btn_desc').setLabel('شرح الزر (يظهر عند الضغط)').setStyle(TextInputStyle.Paragraph).setValue(btn.description || '').setRequired(true);
                        const roleInput = new TextInputBuilder().setCustomId('btn_role').setLabel('ID الرول (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.roleId || '').setRequired(false);
                        
                        // معالجة الروابط لتحويلها من array إلى string للعرض في المودال
                        let linksStr = '';
                        if (btn.links && Array.isArray(btn.links)) {
                            linksStr = btn.links.map(l => `${l.label},${l.url}`).join('\n');
                        }
                        const linksInput = new TextInputBuilder().setCustomId('btn_links').setLabel('الروابط (اسم1,رابط1 | اسم2,رابط2)').setStyle(TextInputStyle.Paragraph).setValue(linksStr).setPlaceholder('مثال:\nروم الفعاليات,https://...\nروم القوانين,https://...').setRequired(false);
                        
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(labelInput),
                            new ActionRowBuilder().addComponents(emojiInput),
                            new ActionRowBuilder().addComponents(descInput),
                            new ActionRowBuilder().addComponents(roleInput),
                            new ActionRowBuilder().addComponents(linksInput)
                        );
                        await i.showModal(modal);
                    } else if (i.customId === 'edit_button') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لتعديلها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: `تعديل : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_button_to_edit')
                            .setPlaceholder('اختر الزر الذي تريد تعديله')
                            .addOptions(options);

                        await i.update({
                            content: '📝 اختر الزر الذي تريد تعديل بياناته:',
                            embeds: [],
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.isStringSelectMenu() && i.customId === 'select_button_to_edit') {
                        const idx = parseInt(i.values[0]);
                        const btn = config.buttons[idx];
                        
                        const modal = new ModalBuilder().setCustomId(`modal_edit_btn_${configKey}_${idx}`).setTitle(`تعديل زر: ${btn.label}`);
                        const labelInput = new TextInputBuilder().setCustomId('btn_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setMaxLength(80).setValue(btn.label || '').setRequired(true);
                        const emojiInput = new TextInputBuilder().setCustomId('btn_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.emoji || '').setPlaceholder('مثال: 📍 أو :emoji_name:').setRequired(false);
                        const descInput = new TextInputBuilder().setCustomId('btn_desc').setLabel('شرح الزر (يظهر عند الضغط)').setStyle(TextInputStyle.Paragraph).setValue(btn.description || '').setRequired(true);
                        const roleInput = new TextInputBuilder().setCustomId('btn_role').setLabel('ID الرول (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.roleId || '').setRequired(false);
                        
                        let linksStr = '';
                        if (btn.links && Array.isArray(btn.links)) {
                            linksStr = btn.links.map(l => `${l.label},${l.url}`).join('\n');
                        }
                        const linksInput = new TextInputBuilder().setCustomId('btn_links').setLabel('الروابط (اسم1,رابط1 | اسم2,رابط2)').setStyle(TextInputStyle.Paragraph).setValue(linksStr).setPlaceholder('مثال:\nروم الفعاليات,https://...\nروم القوانين,https://...').setRequired(false);
                        
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(labelInput),
                            new ActionRowBuilder().addComponents(emojiInput),
                            new ActionRowBuilder().addComponents(descInput),
                            new ActionRowBuilder().addComponents(roleInput),
                            new ActionRowBuilder().addComponents(linksInput)
                        );
                        await i.showModal(modal);
                    } else if (i.customId === 'edit_button') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لتعديلها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: `تعديل : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_button_to_edit')
                            .setPlaceholder('اختر الزر الذي تريد تعديله')
                            .addOptions(options);

                        await i.update({
                            content: '📝 اختر الزر الذي تريد تعديل بياناته:',
                            embeds: [],
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.isStringSelectMenu() && i.customId === 'select_button_to_edit') {
                        const idx = parseInt(i.values[0]);
                        const btn = config.buttons[idx];
                        
                        const modal = new ModalBuilder().setCustomId(`modal_edit_btn_${configKey}_${idx}`).setTitle(`تعديل زر: ${btn.label}`);
                        const labelInput = new TextInputBuilder().setCustomId('btn_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setMaxLength(80).setValue(btn.label || '').setRequired(true);
                        const emojiInput = new TextInputBuilder().setCustomId('btn_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.emoji || '').setPlaceholder('مثال: 📍 أو :emoji_name:').setRequired(false);
                        const descInput = new TextInputBuilder().setCustomId('btn_desc').setLabel('شرح الزر (يظهر عند الضغط)').setStyle(TextInputStyle.Paragraph).setValue(btn.description || '').setRequired(true);
                        const roleInput = new TextInputBuilder().setCustomId('btn_role').setLabel('ID الرول (اختياري)').setStyle(TextInputStyle.Short).setValue(btn.roleId || '').setRequired(false);
                        
                        let linksStr = '';
                        if (btn.links && Array.isArray(btn.links)) {
                            linksStr = btn.links.map(l => `${l.label},${l.url}`).join('\n');
                        }
                        const linksInput = new TextInputBuilder().setCustomId('btn_links').setLabel('الروابط (اسم1,رابط1 | اسم2,رابط2)').setStyle(TextInputStyle.Paragraph).setValue(linksStr).setPlaceholder('مثال:\nروم الفعاليات,https://...\nروم القوانين,https://...').setRequired(false);
                        
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(labelInput),
                            new ActionRowBuilder().addComponents(emojiInput),
                            new ActionRowBuilder().addComponents(descInput),
                            new ActionRowBuilder().addComponents(roleInput),
                            new ActionRowBuilder().addComponents(linksInput)
                        );
                        await i.showModal(modal);
                    } else if (i.customId === 'manage_emojis') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لإدارة إيموجياتها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: btn.emoji ? `الإيموجي الحالي : ${btn.emoji}` : 'لا يوجد إيموجي'
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_buttons_emoji')
                            .setPlaceholder('اختر الأزرار لتعديل أو إضافة إيموجياتها')
                            .setMinValues(1)
                            .setMaxValues(config.buttons.length)
                            .addOptions(options);

                        const row = new ActionRowBuilder().addComponents(selectMenu);

                        const removeRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('remove_emojis_select')
                                .setLabel('حذف إيموجيات أزرار معينة')
                                .setStyle(ButtonStyle.Danger),
                            new ButtonBuilder()
                                .setCustomId('back_to_main')
                                .setLabel('رجوع')
                                .setStyle(ButtonStyle.Secondary)
                        );
                        
                        await i.update({ 
                            content: '📌 اختر الأزرار التي تريد وضع إيموجي لها، أو اختر حذف الإيموجيات:',
                            embeds: [], 
                            components: [row, removeRow] 
                        });
                    } else if (i.customId === 'remove_emojis_select') {
                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: btn.emoji ? `الإيموجي الحالي: ${btn.emoji}` : 'لا يوجد إيموجي'
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('delete_buttons_emoji')
                            .setPlaceholder('اختر الأزرار التي تريد حذف إيموجيها')
                            .setMinValues(1)
                            .setMaxValues(config.buttons.length)
                            .addOptions(options);

                        const row = new ActionRowBuilder().addComponents(selectMenu);
                        await i.update({ content: '🗑️ اختر الأزرار التي تريد مسح إيموجياتها:', components: [row] });
                    } else if (i.customId === 'back_to_main') {
                        await sendMainEmbed(i);
                    } else if (i.customId === 'preview_map') {
                        // إرسال رد مؤقت فوراً لتجنب خطأ InteractionNotReplied
                        await i.deferReply({ ephemeral: true });
                        
                        const mapCommand = i.client.commands.get('map');
                        if (mapCommand) {
                            const fakeMsg = {
                                guild: i.guild,
                                channel: targetChannel || i.channel,
                                author: i.user,
                                client: i.client,
                                isAutomatic: true,
                                isGlobalOnly: targetChannel ? false : true,
                                send: async (opts) => {
                                    opts.ephemeral = true;
                                    // التأكد من عدم تجاوز حد الصفوف المسموح به في ديسكورد (5 صفوف)
                                    if (opts.components && opts.components.length > 5) {
                                        opts.components = opts.components.slice(0, 5);
                                    }
                                    return await i.editReply(opts);
                                },
                                reply: async (opts) => {
                                    opts.ephemeral = true;
                                    if (opts.components && opts.components.length > 5) {
                                        opts.components = opts.components.slice(0, 5);
                                    }
                                    return await i.editReply(opts);
                                },
                                react: async () => {},
                                permissionsFor: () => ({ has: () => true })
                            };
                            await mapCommand.execute(fakeMsg, [], { client: i.client, BOT_OWNERS });
                        } else {
                            await i.editReply({ content: '❌ تعذر العثور على أمر المعاينة.', ephemeral: true });
                        }
                    } else if (i.customId === 'reorder_buttons') {
                        const options = config.buttons.map((btn, idx) => ({
                            label: `${idx + 1}. ${btn.label}`,
                            value: idx.toString(),
                            description: `نقل الزر : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('select_reorder_btn')
                            .setPlaceholder('اختر الزر الذي تريد تحريكه')
                            .addOptions(options);

                        await i.update({
                            content: '🔄 اختر الزر الذي تريد تغيير مكانه:',
                            embeds: [],
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.customId === 'clear_buttons') {
                        if (config.buttons.length === 0) {
                            return await i.reply({ content: '❌ لا يوجد أزرار لحذفها.', ephemeral: true });
                        }

                        const options = config.buttons.map((btn, idx) => ({
                            label: btn.label,
                            value: idx.toString(),
                            description: `حذف الزر : ${btn.label}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId('delete_buttons_select')
                            .setPlaceholder('اختر الأزرار التي تريد حذفها')
                            .setMinValues(1)
                            .setMaxValues(config.buttons.length)
                            .addOptions(options);

                        const row1 = new ActionRowBuilder().addComponents(selectMenu);
                        const row2 = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('clear_all_confirm').setLabel('حذف الكل').setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
                        );

                        await i.update({
                            content: '🗑️ اختر الأزرار التي تريد حذفها (يمكنك اختيار أكثر من زر)، أو اختر "حذف الكل":',
                            embeds: [],
                            components: [row1, row2]
                        });
                    } else if (i.isStringSelectMenu() && i.customId === 'delete_buttons_select') {
                        const selectedIndices = i.values.map(v => parseInt(v));
                        config.buttons = config.buttons.filter((_, idx) => !selectedIndices.includes(idx));
                        
                        const all = loadAllConfigs();
                        all[configKey] = config;
                        saveAllConfigs(all);

                        const embed = new EmbedBuilder()
                            .setDescription(`✅ تم حذف ${selectedIndices.length} أزرار بنجاح.`)
                            .setColor('#ff0000');
                        
                        await i.update({ content: '', embeds: [embed], components: [] });
                        // إعادة استخدام نفس التفاعل لتحديث المنيو لضمان استمرار الكوليكتور
                        setTimeout(() => {
                            sendMainEmbed(i);
                        }, 1500);
                        return;
                    } else if (i.customId === 'clear_all_confirm') {
                        config.buttons = [];
                        const all = loadAllConfigs();
                        all[configKey] = config;
                        saveAllConfigs(all);

                        const embed = new EmbedBuilder()
                            .setDescription('✅ تم مسح جميع الأزرار بنجاح.')
                            .setColor('#ff0000');

                        await i.update({ content: '', embeds: [embed], components: [] });
                        setTimeout(() => {
                            sendMainEmbed(i);
                        }, 1500);
                        return;
                    } else if (i.isStringSelectMenu() && i.customId === 'select_reorder_btn') {
                        const idx = parseInt(i.values[0]);
                        const btn = config.buttons[idx];
                        
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`move_up_${idx}`).setLabel('⬆️ للأعلى').setStyle(ButtonStyle.Primary).setDisabled(idx === 0),
                            new ButtonBuilder().setCustomId(`move_down_${idx}`).setLabel('⬇️ للأسفل').setStyle(ButtonStyle.Primary).setDisabled(idx === config.buttons.length - 1),
                            new ButtonBuilder().setCustomId(`toggle_newline_${idx}`).setLabel(btn.newline ? ' إلغاء سطر جديد' : ' سطر جديد').setStyle(btn.newline ? ButtonStyle.Danger : ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`change_color_${idx}`).setLabel(' تغيير اللون').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('back_to_reorder').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
                        );

                        await i.update({
                            content: `🔄 إدارة الزر : **${btn.label}** (المكان الحالي : ${idx + 1})\nاللون الحالي : ${btn.style === ButtonStyle.Success ? 'أخضر' : (btn.style === ButtonStyle.Danger ? 'أحمر' : (btn.style === ButtonStyle.Primary ? 'أزرق' : 'رمادي'))}\nالحالة: ${btn.newline ? 'هذا الزر يبدأ في سطر جديد' : 'هذا الزر بجانب ما قبله'}`,
                            components: [row]
                        });
                    } else if (i.customId.startsWith('toggle_newline_')) {
                        const idx = parseInt(i.customId.split('_').pop());
                        config.buttons[idx].newline = !config.buttons[idx].newline;
                        
                        const all = loadAllConfigs();
                        all[configKey] = config;
                        saveAllConfigs(all);

                        const btn = config.buttons[idx];
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`move_up_${idx}`).setLabel('⬆️ للأعلى').setStyle(ButtonStyle.Primary).setDisabled(idx === 0),
                            new ButtonBuilder().setCustomId(`move_down_${idx}`).setLabel('⬇️ للأسفل').setStyle(ButtonStyle.Primary).setDisabled(idx === config.buttons.length - 1),
                            new ButtonBuilder().setCustomId(`toggle_newline_${idx}`).setLabel(btn.newline ? ' إلغاء سطر جديد' :'سطر جديد').setStyle(btn.newline ? ButtonStyle.Danger : ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`change_color_${idx}`).setLabel('🎨 تغيير اللون').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('back_to_reorder').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
                        );
                        await i.update({
                            content: `✅ تم ${btn.newline ? 'تفعيل' : 'إلغاء'} السطر الجديد للزر.\n🔄 إدارة الزر : **${btn.label}**`,
                            components: [row]
                        });
                    } else if (i.customId.startsWith('change_color_')) {
                        const idx = parseInt(i.customId.split('_').pop());
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`set_color_${idx}_${ButtonStyle.Primary}`).setLabel('أزرق (Primary)').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`set_color_${idx}_${ButtonStyle.Success}`).setLabel('أخضر (Success)').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`set_color_${idx}_${ButtonStyle.Danger}`).setLabel('أحمر (Danger)').setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId(`set_color_${idx}_${ButtonStyle.Secondary}`).setLabel('رمادي (Secondary)').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`select_reorder_btn_back_${idx}`).setLabel('رجوع').setStyle(ButtonStyle.Secondary)
                        );
                        await i.update({ content: '🎨 اختر لون الزر الجديد:', components: [row] });
                    } else if (i.customId.startsWith('set_color_')) {
                        const parts = i.customId.split('_');
                        const idx = parseInt(parts[2]);
                        const style = parseInt(parts[3]);
                        
                        config.buttons[idx].style = style;
                        const all = loadAllConfigs();
                        all[configKey] = config;
                        saveAllConfigs(all);

                        // العودة لصفحة إدارة الزر
                        const btn = config.buttons[idx];
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`move_up_${idx}`).setLabel('⬆️ للأعلى').setStyle(ButtonStyle.Primary).setDisabled(idx === 0),
                            new ButtonBuilder().setCustomId(`move_down_${idx}`).setLabel('⬇️ للأسفل').setStyle(ButtonStyle.Primary).setDisabled(idx === config.buttons.length - 1),
                            new ButtonBuilder().setCustomId(`change_color_${idx}`).setLabel('🎨 تغيير اللون').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('back_to_reorder').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
                        );
                        await i.update({
                            content: `✅ تم تغيير لون الزر إلى ${style === ButtonStyle.Success ? 'الأخضر' : (style === ButtonStyle.Danger ? 'الأحمر' : (style === ButtonStyle.Primary ? 'الأزرق' : 'الرمادي'))}.\n🔄 إدارة الزر: **${btn.label}**`,
                            components: [row]
                        });
                    } else if (i.customId.startsWith('select_reorder_btn_back_')) {
                        const idx = parseInt(i.customId.split('_').pop());
                        const btn = config.buttons[idx];
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`move_up_${idx}`).setLabel('⬆️ للأعلى').setStyle(ButtonStyle.Primary).setDisabled(idx === 0),
                            new ButtonBuilder().setCustomId(`move_down_${idx}`).setLabel('⬇️ للأسفل').setStyle(ButtonStyle.Primary).setDisabled(idx === config.buttons.length - 1),
                            new ButtonBuilder().setCustomId(`change_color_${idx}`).setLabel('🎨 تغيير اللون').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId('back_to_reorder').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
                        );
                        await i.update({ content: `🔄 إدارة الزر: **${btn.label}**`, components: [row] });
                    } else if (i.customId.startsWith('move_up_') || i.customId.startsWith('move_down_')) {
                        const isUp = i.customId.startsWith('move_up_');
                        const idx = parseInt(i.customId.split('_').pop());
                        const newIdx = isUp ? idx - 1 : idx + 1;

                        // تبديل الأماكن
                        const temp = config.buttons[idx];
                        config.buttons[idx] = config.buttons[newIdx];
                        config.buttons[newIdx] = temp;

                        const all = loadAllConfigs();
                        all[configKey] = config;
                        saveAllConfigs(all);

                        // إعادة تحديث قائمة الترتيب
                        const options = config.buttons.map((btn, idx) => ({
                            label: `${idx + 1}. ${btn.label}`,
                            value: idx.toString(),
                            description: `نقل الزر : ${btn.label}`
                        }));
                        const selectMenu = new StringSelectMenuBuilder().setCustomId('select_reorder_btn').setPlaceholder('اختر الزر الذي تريد تحريكه').addOptions(options);
                        await i.update({
                            content: `✅ تم تحريك الزر ${isUp ? 'للأعلى' : 'للأسفل'}. يمكنك اختيار زر آخر للترتيب:`,
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.customId === 'back_to_reorder') {
                        const options = config.buttons.map((btn, idx) => ({
                            label: `${idx + 1}. ${btn.label}`,
                            value: idx.toString(),
                            description: `نقل الزر : ${btn.label}`
                        }));
                        const selectMenu = new StringSelectMenuBuilder().setCustomId('select_reorder_btn').setPlaceholder('اختر الزر الذي تريد تحريكه').addOptions(options);
                        await i.update({
                            content: '🔄 اختر الزر الذي تريد تغيير مكانه:',
                            components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('back_to_main').setLabel('رجوع').setStyle(ButtonStyle.Secondary))]
                        });
                    } else if (i.customId === 'clear_buttons') {
                        const confirmRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('confirm_clear_buttons').setLabel('نعم، احذف الكل').setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId('back_to_main').setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
                        );
                        await i.update({
                            content: '⚠️ **هل أنت متأكد من رغبتك في مسح كافة الأزرار؟** لا يمكن التراجع عن هذا الإجراء.',
                            embeds: [],
                            components: [confirmRow]
                        });
                    } else if (i.customId === 'confirm_clear_buttons') {
                        config.buttons = [];
                        const currentAll = loadAllConfigs();
                        currentAll[configKey] = config;
                        saveAllConfigs(currentAll);
                        await sendMainEmbed(i);
                    }
                } catch (err) {
                    console.error('Collector interaction error:', err.message);
                }
            });

            collector.on('end', () => {
                mainMsg.edit({ components: [] }).catch(() => {});
            });

            const modalHandler = async mi => {
                if (!mi.isModalSubmit() || mi.user.id !== message.author.id) return;

                try {
                    const currentAll = loadAllConfigs();
                    const imageModalMatch = mi.customId.match(/^modal_image_(global|channel_\d+)$/);
                    const msgModalMatch = mi.customId.match(/^modal_msg_(global|channel_\d+)$/);
                    const addBtnModalMatch = mi.customId.match(/^modal_add_btn_(global|channel_\d+)$/);
                    const bulkEmojiModalMatch = mi.customId.match(/^modal_bulk_emojis_(global|channel_\d+)$/);

                    // تجاهل مودالات خرائط أخرى لنفس المستخدم لتفادي أي تداخل
                    if (
                        (imageModalMatch && imageModalMatch[1] !== configKey) ||
                        (msgModalMatch && msgModalMatch[1] !== configKey) ||
                        (addBtnModalMatch && addBtnModalMatch[1] !== configKey) ||
                        (bulkEmojiModalMatch && bulkEmojiModalMatch[1] !== configKey)
                    ) {
                        return;
                    }

                    if (mi.customId === 'modal_image' || (imageModalMatch && imageModalMatch[1] === configKey)) {
                        const newUrl = mi.fields.getTextInputValue('img_url').trim();
                        if (!newUrl.startsWith('http')) {
                            return await mi.reply({ content: '❌ فشل: رابط الصورة غير صالح. يجب أن يبدأ بـ http أو https.', ephemeral: true });
                        }
                        
                        const ext = newUrl.split('.').pop().split(/[?#]/)[0] || 'png';
                        const filename = `${configKey}_${Date.now()}.${ext}`;
                        
                        await mi.deferReply({ ephemeral: true });
                        const localPath = await downloadImage(newUrl, filename);
                        
                        if (localPath) {
                            config.imageUrl = newUrl;
                            config.localImagePath = filename;
                            currentAll[configKey] = config;
                            saveAllConfigs(currentAll);
                            await sendMainEmbed(mi);
                            await mi.editReply({ content: '✅ تم تحديث وتحميل صورة الخريطة بنجاح.' });
                        } else {
                            await mi.editReply({ content: '❌ فشل تحميل الصورة، يرجى التأكد من الرابط.' });
                        }
                    } else if (mi.customId === 'modal_msg' || (msgModalMatch && msgModalMatch[1] === configKey)) {
                        const newMsg = mi.fields.getTextInputValue('welcome_text').trim();
                        
                        config.welcomeMessage = newMsg || null;
                        currentAll[configKey] = config;
                        if (saveAllConfigs(currentAll)) {
                            await sendMainEmbed(mi);
                            const feedback = { content: '✅ تم تحديث رسالة الترحيب بنجاح.', ephemeral: true };
                            if (mi.replied || mi.deferred) await mi.followUp(feedback).catch(() => {});
                            else await mi.reply(feedback).catch(() => {});
                        } else {
                            await mi.reply({ content: '❌ فشل في حفظ البيانات.', ephemeral: true });
                        }
                    } else if (mi.customId === 'modal_bulk_emojis' || (bulkEmojiModalMatch && bulkEmojiModalMatch[1] === configKey)) {
                        const list = mi.fields.getTextInputValue('emojis_list').trim();
                        const lines = list.split('\n');
                        
                        if (lines[0]?.toLowerCase() === 'clear') {
                            config.buttons.forEach(b => b.emoji = null);
                        } else {
                            config.buttons.forEach((btn, idx) => {
                                if (lines[idx] !== undefined) {
                                    const emoji = lines[idx].trim();
                                    btn.emoji = emoji !== '' ? emoji : null;
                                }
                            });
                        }
                        
                        currentAll[configKey] = config;
                        if (saveAllConfigs(currentAll)) {
                            await sendMainEmbed(mi);
                            const feedback = { content: '✅ تم تحديث إيموجيات الأزرار بنجاح.', ephemeral: true };
                            if (mi.replied || mi.deferred) await mi.followUp(feedback).catch(() => {});
                            else await mi.reply(feedback).catch(() => {});
                        } else {
                            await mi.reply({ content: '❌ فشل في حفظ البيانات.', ephemeral: true });
                        }
                    } else if (mi.customId === 'modal_add_btn' || (addBtnModalMatch && addBtnModalMatch[1] === configKey)) {
                        const label = mi.fields.getTextInputValue('btn_label').trim();
                        const emoji = mi.fields.getTextInputValue('btn_emoji').trim();
                        const description = mi.fields.getTextInputValue('btn_desc').trim();
                        const roleId = mi.fields.getTextInputValue('btn_role').trim();
                        const linksRaw = mi.fields.getTextInputValue('btn_links').trim();
                        
                        // فحص المدخلات الأساسية
                        if (label.length < 1) return await mi.reply({ content: '❌ اسم الزر مطلوب.', ephemeral: true });
                        
                        // فحص الروابط الداخلية في الشرح
                        const internalLinkRegex = /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/\d+\/\d+/g;
                        const hasInternalLinks = internalLinkRegex.test(description);
                        if (hasInternalLinks) {
                            // يمكنك إضافة منطق تنبيه أو منع هنا إذا أردت
                            console.log('Internal Discord link detected in button description');
                        }

                        // فحص الرول إذا تم وضعه
                        if (roleId && !/^\d{17,19}$/.test(roleId)) {
                            return await mi.reply({ content: '❌ ID الرول غير صالح. يجب أن يكون رقماً مكوناً من 17-19 خانة.', ephemeral: true });
                        }

                        const links = [];
                        if (linksRaw) {
                            const lines = linksRaw.split(/[\n|]/);
                            for (let line of lines) {
                                const parts = line.split(',');
                                if (parts.length >= 2) {
                                    const l = parts[0].trim();
                                    const url = parts.slice(1).join(',').trim();
                                    if (url.startsWith('http')) {
                                        links.push({ label: l, url });
                                    }
                                }
                            }
                        }

                        config.buttons.push({
                            label: label,
                            emoji: emoji !== '' ? emoji : null,
                            description: description,
                            roleId: roleId !== '' ? roleId : null,
                            links: links.length > 0 ? links : null
                        });
                        
                        currentAll[configKey] = config;
                        if (saveAllConfigs(currentAll)) {
                            await sendMainEmbed(mi);
                            const feedback = { content: `✅ تم إضافة الزر "${label}" بنجاح.`, ephemeral: true };
                            if (mi.replied || mi.deferred) await mi.followUp(feedback).catch(() => {});
                            else await mi.reply(feedback).catch(() => {});
                        } else {
                            await mi.reply({ content: '❌ فشل في حفظ البيانات.', ephemeral: true });
                        }
                    }
                } catch (err) {
                    console.error('Modal submission error:', err.message);
                    try {
                        if (!mi.replied && !mi.deferred) await mi.reply({ content: '❌ حدث خطأ غير متوقع أثناء معالجة البيانات.', ephemeral: true });
                        else await mi.followUp({ content: '❌ حدث خطأ غير متوقع أثناء معالجة البيانات.', ephemeral: true });
                    } catch (e) {}
                }
            };

            message.client.on('interactionCreate', modalHandler);
            setTimeout(() => message.client.off('interactionCreate', modalHandler), 600000);

        } catch (error) {
            console.error('❌ خطأ في تنفيذ إعدادات الخريطة:', error.message);
        }
    }
};
