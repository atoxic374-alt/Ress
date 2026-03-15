const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { loadMapConfigsSync, writeMapConfigsQueued } = require('../utils/mapConfigStore');

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
    const data = loadMapConfigsSync();
    return Object.keys(data).length > 0
        ? data
        : { global: { enabled: false, imageUrl: 'https://i.ibb.co/pP9GzD7/default-map.png', welcomeMessage: '** Welcome **', buttons: [] } };
}

function saveAllConfigs(allConfigs) {
    writeMapConfigsQueued(allConfigs);
    return true;
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

function resolveButtonStyle(input, fallback = 'Secondary') {
    if (!input) return ButtonStyle[fallback];
    const key = String(input).trim().toLowerCase();
    const map = {
        primary: ButtonStyle.Primary,
        secondary: ButtonStyle.Secondary,
        success: ButtonStyle.Success,
        danger: ButtonStyle.Danger,
        'أزرق': ButtonStyle.Primary,
        'ازرق': ButtonStyle.Primary,
        'رمادي': ButtonStyle.Secondary,
        'رصاصي': ButtonStyle.Secondary,
        'اخضر': ButtonStyle.Success,
        'أخضر': ButtonStyle.Success,
        'احمر': ButtonStyle.Danger,
        'أحمر': ButtonStyle.Danger
    };
    return map[key] || ButtonStyle[fallback];
}





function styleToName(styleValue) {
    const map = {
        [ButtonStyle.Primary]: 'أزرق',
        [ButtonStyle.Secondary]: 'رمادي',
        [ButtonStyle.Success]: 'أخضر',
        [ButtonStyle.Danger]: 'أحمر'
    };
    return map[styleValue] || 'رمادي';
}

function clampText(value, maxLen, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return fallback;
    return text.slice(0, maxLen);
}

function normalizeOpenConfig(openConfig) {
    const fallback = {
        enabled: false,
        roleId: null,
        grantMessage: '✅ تم إعطاؤك رول الأوبن، الآن يمكنك رؤية الرومات.',
        removeMessage: '✅ تمت إزالة رول الأوبن، ولم يعد بإمكانك رؤية الرومات.',
        images: [],
        imageUrls: [],
        buttonImageIndex: -1,
        openButton: { label: 'اوبن', style: ButtonStyle.Success, emoji: null },
        counterButton: { mode: 'emoji_digits', label: 'المتفعّلين', style: ButtonStyle.Secondary, emoji: null }
    };

    const src = openConfig || {};
    const images = Array.isArray(src.images)
        ? src.images.filter(img => img && typeof img.imageUrl === 'string').slice(0, 20)
        : [];

    let buttonImageIndex = Number.isInteger(src.buttonImageIndex) ? src.buttonImageIndex : -1;
    if (images.length === 0) buttonImageIndex = -1;
    else if (buttonImageIndex < 0 || buttonImageIndex >= images.length) buttonImageIndex = images.length - 1;

    return {
        enabled: src.enabled === true,
        roleId: src.roleId || null,
        grantMessage: clampText(src.grantMessage, 1500, fallback.grantMessage),
        removeMessage: clampText(src.removeMessage, 1500, fallback.removeMessage),
        images,
        imageUrls: Array.isArray(src.imageUrls) ? src.imageUrls.slice(0, 20) : images.map(img => img.imageUrl),
        buttonImageIndex,
        openButton: {
            label: clampText(src.openButton?.label, 80, fallback.openButton.label),
            style: src.openButton?.style || fallback.openButton.style,
            emoji: clampText(src.openButton?.emoji || '', 100, '') || null
        },
        counterButton: {
            mode: src.counterButton?.mode === 'label_number' ? 'label_number' : 'emoji_digits',
            label: 'المتفعّلين',
            style: src.counterButton?.style || fallback.counterButton.style,
            emoji: clampText(src.counterButton?.emoji || '', 100, '') || null
        }
    };
}

function buildOpenSetupEmbed(openConfig, targetChannel) {
    const colorManager = require('../utils/colorManager.js');
    const imagesList = openConfig.images
        .map((img, idx) => {
            const isButtonImage = idx === openConfig.buttonImageIndex;
            return `${idx + 1}) ${isButtonImage ? '⭐ ' : ''}${img.imageUrl}`;
        })
        .slice(0, 10)
        .join('\n') || 'لا توجد صور محددة.';

    const embed = new EmbedBuilder()
        .setTitle(targetChannel ? `🧭 إعداد **الأوبن** للروم : ${targetChannel.name}` : '🧭 إعداد **الأوبن** العام')
        .setColor(colorManager.getColor('primary'))
        .setDescription(
            `**الحالة :** ${openConfig.enabled ? '✅ مفعل' : '❌ معطل'}

` +
            `**الرول :** ${openConfig.roleId ? `<@&${openConfig.roleId}>` : 'غير محدد'}

` +
            `**زر الأوبن :** ${openConfig.openButton.label} (${styleToName(openConfig.openButton.style)})

` +
            `**طريقة العداد :** ${openConfig.counterButton.mode === 'label_number' ? 'أرقام داخل الزر' : 'أرقام كإيموجي'}

` +
            `**لون العداد :** ${styleToName(openConfig.counterButton.style)}

` +
            `**إيموجي العداد النصي :** ${openConfig.counterButton.emoji || 'لا يوجد'}

` +
            `**عدد الصور :** ${openConfig.images.length}

` +
            `**صورة الأزرار :** ${openConfig.buttonImageIndex >= 0 ? `رقم ${openConfig.buttonImageIndex + 1}` : 'لا يوجد'}`
        )
        .addFields(
            { name: '**رسالة الإعطاء :**', value: `> ${openConfig.grantMessage.slice(0, 1000)}`, inline: false },
            { name: '**رسالة الإزالة :**', value: `> ${openConfig.removeMessage.slice(0, 1000)}`, inline: false },
            { name: '**الصور المحددة :**', value: imagesList.slice(0, 1024), inline: false }
        )
        .setFooter({ text: 'By Ahmed' });

    const previewImage = openConfig.images[openConfig.buttonImageIndex]?.imageUrl || openConfig.images[openConfig.images.length - 1]?.imageUrl;
    if (previewImage) embed.setImage(previewImage);
    return embed;
}

function buildOpenSetupRows(openConfig) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('open_setup_toggle').setLabel(openConfig.enabled ? 'تعطيل النظام' : 'تفعيل النظام').setStyle(openConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('open_setup_role').setLabel('تحديد الرول').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('open_setup_messages').setLabel('تعديل الرسائل').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('open_setup_open_btn').setLabel('تعديل زر الأوبن').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('open_setup_counter_mode').setLabel('تبديل طريقة العداد').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('open_setup_counter_style').setLabel('لون العداد').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('open_setup_counter_emoji').setLabel('إيموجي العداد النصي').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('open_setup_add_image').setLabel('إضافة صورة').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('open_setup_reorder_images').setLabel('ترتيب الصور').setStyle(ButtonStyle.Secondary).setDisabled(openConfig.images.length < 2),
            new ButtonBuilder().setCustomId('open_setup_button_image').setLabel('تحديد صورة الأزرار').setStyle(ButtonStyle.Secondary).setDisabled(openConfig.images.length === 0),
            new ButtonBuilder().setCustomId('open_setup_clear_images').setLabel('مسح الصور').setStyle(ButtonStyle.Danger).setDisabled(openConfig.images.length === 0)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('open_setup_view_settings').setLabel('عرض الإعدادات الحالي').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('open_setup_preview').setLabel('معاينة').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('open_setup_save_close').setLabel('حفظ وإغلاق').setStyle(ButtonStyle.Primary)
        )
    ];
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

            if (args[0] && args[0].toLowerCase() === 'open') {
                const targetForOpen = message.mentions.channels.first() || (args[1] && message.guild.channels.cache.get(args[1])) || null;
                const openConfigKey = targetForOpen ? `channel_${targetForOpen.id}` : 'global';

                const allConfigsForOpen = loadAllConfigs();
                const baseConfig = allConfigsForOpen[openConfigKey] || { enabled: false, imageUrl: 'https://i.ibb.co/pP9GzD7/default-map.png', welcomeMessage: '', buttons: [] };
                let openConfig = normalizeOpenConfig(baseConfig.open);

                const openEmbed = buildOpenSetupEmbed(openConfig, targetForOpen);
                const openRows = buildOpenSetupRows(openConfig);
                const openSetupMsg = await message.reply({ embeds: [openEmbed], components: openRows });

                const persistOpenConfig = () => {
                    const latest = loadAllConfigs();
                    const currentBase = latest[openConfigKey] || baseConfig;
                    currentBase.open = openConfig;
                    latest[openConfigKey] = currentBase;
                    return saveAllConfigs(latest);
                };

                const refreshOpenPanel = async (interaction = null) => {
                    const embed = buildOpenSetupEmbed(openConfig, targetForOpen);
                    const rows = buildOpenSetupRows(openConfig);
                    if (interaction) return interaction.update({ embeds: [embed], components: rows });
                    return openSetupMsg.edit({ embeds: [embed], components: rows });
                };

                const openCollector = openSetupMsg.createMessageComponentCollector({
                    filter: i => i.user.id === message.author.id,
                    time: 600000
                });

                openCollector.on('collect', async i => {
                    try {
                        if (i.customId === 'open_setup_toggle') {
                            if (!openConfig.enabled && (!openConfig.roleId || !/^\d{17,19}$/.test(openConfig.roleId))) {
                                return await i.reply({ content: '❌ لا يمكن التفعيل الآن: لازم تحدد رول صحيح أولاً من زر (تحديد الرول).', ephemeral: true });
                            }
                            openConfig.enabled = !openConfig.enabled;
                            persistOpenConfig();
                            return await refreshOpenPanel(i);
                        }

                        if (i.customId === 'open_setup_role') {
                            const roleMenu = new RoleSelectMenuBuilder().setCustomId('open_setup_role_select').setPlaceholder('اختر الرول المطلوب').setMaxValues(1).setMinValues(1);
                            const backBtn = new ButtonBuilder().setCustomId('open_setup_back').setLabel('رجوع').setStyle(ButtonStyle.Secondary);
                            return await i.update({
                                content: 'اختر الرول من القائمة:',
                                embeds: [buildOpenSetupEmbed(openConfig, targetForOpen)],
                                components: [new ActionRowBuilder().addComponents(roleMenu), new ActionRowBuilder().addComponents(backBtn)]
                            });
                        }

                        if (i.isRoleSelectMenu() && i.customId === 'open_setup_role_select') {
                            const selectedRoleId = i.values[0] || null;
                            if (!selectedRoleId || !/^\d{17,19}$/.test(selectedRoleId)) {
                                return await i.reply({ content: '❌ الرول المحدد غير صالح.', ephemeral: true });
                            }
                            openConfig.roleId = selectedRoleId;
                            persistOpenConfig();
                            return await refreshOpenPanel(i);
                        }

                        if (i.customId === 'open_setup_back') {
                            return await refreshOpenPanel(i);
                        }

                        if (i.customId === 'open_setup_messages') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_messages_${openConfigKey}`).setTitle('تعديل رسائل الأوبن');
                            const grantInput = new TextInputBuilder().setCustomId('grant_msg').setLabel('رسالة الإعطاء').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(openConfig.grantMessage);
                            const removeInput = new TextInputBuilder().setCustomId('remove_msg').setLabel('رسالة الإزالة').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(openConfig.removeMessage);
                            modal.addComponents(new ActionRowBuilder().addComponents(grantInput), new ActionRowBuilder().addComponents(removeInput));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_open_btn') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_openbtn_${openConfigKey}`).setTitle('تعديل زر الأوبن');
                            const labelInput = new TextInputBuilder().setCustomId('open_label').setLabel('اسم الزر').setStyle(TextInputStyle.Short).setRequired(true).setValue(openConfig.openButton.label);
                            const emojiInput = new TextInputBuilder().setCustomId('open_emoji').setLabel('إيموجي الزر (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setValue(openConfig.openButton.emoji || '');
                            const styleInput = new TextInputBuilder().setCustomId('open_style').setLabel('اللون : أحمر / رمادي / أخضر / أزرق').setStyle(TextInputStyle.Short).setRequired(false).setValue(styleToName(openConfig.openButton.style));
                            modal.addComponents(new ActionRowBuilder().addComponents(labelInput), new ActionRowBuilder().addComponents(emojiInput), new ActionRowBuilder().addComponents(styleInput));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_counter_mode') {
                            openConfig.counterButton.mode = openConfig.counterButton.mode === 'label_number' ? 'emoji_digits' : 'label_number';
                            persistOpenConfig();
                            return await refreshOpenPanel(i);
                        }

                        if (i.customId === 'open_setup_counter_style') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_counterstyle_${openConfigKey}`).setTitle('تعديل لون العداد');
                            const styleInput = new TextInputBuilder().setCustomId('counter_style').setLabel('اللون : أحمر / رمادي / أخضر / أزرق').setStyle(TextInputStyle.Short).setRequired(false).setValue(styleToName(openConfig.counterButton.style));
                            modal.addComponents(new ActionRowBuilder().addComponents(styleInput));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_counter_emoji') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_counteremoji_${openConfigKey}`).setTitle('تعديل إيموجي العداد النصي');
                            const emojiInput = new TextInputBuilder().setCustomId('counter_emoji').setLabel('إيموجي العداد (اختياري)').setStyle(TextInputStyle.Short).setRequired(false).setValue(openConfig.counterButton.emoji || '').setPlaceholder('مثال: ✅ أو :name:');
                            modal.addComponents(new ActionRowBuilder().addComponents(emojiInput));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_add_image') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_addimage_${openConfigKey}`).setTitle('إضافة صورة للأوبن');
                            const imgInput = new TextInputBuilder().setCustomId('image_url').setLabel('رابط الصورة').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('https://example.com/image.png');
                            modal.addComponents(new ActionRowBuilder().addComponents(imgInput));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_clear_images') {
                            openConfig.images = [];
                            openConfig.imageUrls = [];
                            openConfig.buttonImageIndex = -1;
                            persistOpenConfig();
                            return await refreshOpenPanel(i);
                        }

                        if (i.customId === 'open_setup_view_settings') {
                            const quick = `**الحالة :** ${openConfig.enabled ? '✅ مفعل' : '❌ معطل'}

**الرول :** ${openConfig.roleId ? `<@&${openConfig.roleId}>` : 'غير محدد'}

**زر الأوبن :** ${openConfig.openButton.label}

**العداد :** ${openConfig.counterButton.mode === 'label_number' ? 'نصي' : 'إيموجي'}

**عدد الصور :** ${openConfig.images.length}

**صورة الأزرار :** ${openConfig.buttonImageIndex >= 0 ? openConfig.buttonImageIndex + 1 : 'غير محددة'}`;
                            return await i.reply({ content: quick, ephemeral: true });
                        }

                        if (i.customId === 'open_setup_reorder_images') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_reorder_${openConfigKey}`).setTitle('ترتيب الصور');
                            const orderExample = openConfig.images.map((_, idx) => idx + 1).join(' ');
                            const input = new TextInputBuilder().setCustomId('images_order').setLabel('اكتب الترتيب بالأرقام (مثال)').setStyle(TextInputStyle.Short).setRequired(true).setValue(orderExample).setPlaceholder('مثال : 3 1 2');
                            modal.addComponents(new ActionRowBuilder().addComponents(input));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_button_image') {
                            const modal = new ModalBuilder().setCustomId(`open_setup_modal_buttonimage_${openConfigKey}`).setTitle('تحديد صورة الأزرار');
                            const current = openConfig.buttonImageIndex >= 0 ? String(openConfig.buttonImageIndex + 1) : '1';
                            const input = new TextInputBuilder().setCustomId('button_image_index').setLabel('رقم الصورة التي تحمل الأزرار').setStyle(TextInputStyle.Short).setRequired(true).setValue(current).setPlaceholder(`من 1 إلى ${Math.max(1, openConfig.images.length)}`);
                            modal.addComponents(new ActionRowBuilder().addComponents(input));
                            return await i.showModal(modal);
                        }

                        if (i.customId === 'open_setup_preview') {
                            const mapCommand = i.client.commands.get('map');
                            if (!mapCommand) {
                                return await i.reply({ content: '❌ تعذر العثور على أمر المعاينة.', ephemeral: true });
                            }
                            await i.deferReply({ ephemeral: true });
                            const fakeMsg = {
                                guild: i.guild,
                                channel: i.channel,
                                author: i.user,
                                client: i.client,
                                isAutomatic: true,
                                isGlobalOnly: targetForOpen ? false : true,
                                react: async () => {},
                                reply: async () => {},
                                send: null
                            };
                            await mapCommand.execute(fakeMsg, ['open'], { client: i.client, BOT_OWNERS });
                            await i.editReply({ content: '✅ تمت المعاينة في نفس القناة، وتقدر تتأكد من ترتيب الصور وصورة الأزرار.' }).catch(() => {});
                            return;
                        }

                        if (i.customId === 'open_setup_save_close') {
                            persistOpenConfig();
                            openCollector.stop('saved');
                            return await i.update({ embeds: [buildOpenSetupEmbed(openConfig, targetForOpen)], components: [] });
                        }
                    } catch (e) {
                        console.error('open setup interaction error:', e.message);
                        if (!i.replied && !i.deferred) await i.reply({ content: '❌ حدث خطأ أثناء معالجة الطلب. تأكد من طول النصوص وصحة القيم، ثم حاول مرة أخرى.', ephemeral: true }).catch(() => {});
                    }
                });

                const openModalHandler = async mi => {
                    if (!mi.isModalSubmit() || mi.user.id !== message.author.id) return;

                    try {
                        if (mi.customId === `open_setup_modal_messages_${openConfigKey}`) {
                            openConfig.grantMessage = mi.fields.getTextInputValue('grant_msg').trim() || openConfig.grantMessage;
                            openConfig.removeMessage = mi.fields.getTextInputValue('remove_msg').trim() || openConfig.removeMessage;
                            persistOpenConfig();
                            await mi.reply({ content: '✅ تم تحديث الرسائل.', ephemeral: true });
                            await refreshOpenPanel();
                            return;
                        }

                        if (mi.customId === `open_setup_modal_openbtn_${openConfigKey}`) {
                            const label = mi.fields.getTextInputValue('open_label').trim();
                            const emoji = mi.fields.getTextInputValue('open_emoji').trim();
                            const styleRaw = mi.fields.getTextInputValue('open_style').trim();
                            if (label.length > 80) {
                                return await mi.reply({ content: '❌ اسم الزر طويل جداً (الحد 80 حرف).', ephemeral: true });
                            }
                            if (emoji.length > 100) {
                                return await mi.reply({ content: '❌ الإيموجي غير صالح.', ephemeral: true });
                            }
                            openConfig.openButton.label = (label || 'اوبن').slice(0, 80);
                            openConfig.openButton.emoji = emoji || null;
                            if (styleRaw && !['primary','secondary','success','danger','ازرق','أزرق','رمادي','رصاصي','اخضر','أخضر','احمر','أحمر'].includes(styleRaw.toLowerCase())) {
                                return await mi.reply({ content: '❌ لون زر الأوبن غير صالح. مثال : أخضر / أحمر / رمادي / أزرق.', ephemeral: true });
                            }
                            openConfig.openButton.style = resolveButtonStyle(styleRaw, 'Success');
                            persistOpenConfig();
                            await mi.reply({ content: '✅ تم تحديث زر الأوبن.', ephemeral: true });
                            await refreshOpenPanel();
                            return;
                        }

                        if (mi.customId === `open_setup_modal_counterstyle_${openConfigKey}`) {
                            const styleRaw = mi.fields.getTextInputValue('counter_style').trim();
                            if (styleRaw && !['primary','secondary','success','danger','ازرق','أزرق','رمادي','رصاصي','اخضر','أخضر','احمر','أحمر'].includes(styleRaw.toLowerCase())) {
                                return await mi.reply({ content: '❌ لون غير صالح. استخدم : أخضر / أحمر / رمادي / أزرق.', ephemeral: true });
                            }
                            openConfig.counterButton.style = resolveButtonStyle(styleRaw, 'Secondary');
                            persistOpenConfig();
                            await mi.reply({ content: '✅ تم تحديث لون العداد.', ephemeral: true });
                            await refreshOpenPanel();
                            return;
                        }

                        if (mi.customId === `open_setup_modal_counteremoji_${openConfigKey}`) {
                            const emojiRaw = mi.fields.getTextInputValue('counter_emoji').trim();
                            if (emojiRaw.length > 100) {
                                return await mi.reply({ content: '❌ الإيموجي غير صالح.', ephemeral: true });
                            }
                            openConfig.counterButton.emoji = emojiRaw || null;
                            persistOpenConfig();
                            await mi.reply({ content: '✅ تم تحديث إيموجي العداد النصي.', ephemeral: true });
                            await refreshOpenPanel();
                            return;
                        }

                        if (mi.customId === `open_setup_modal_reorder_${openConfigKey}`) {
                            const raw = mi.fields.getTextInputValue('images_order').trim();
                            const parts = raw.split(/\s+/).map(v => parseInt(v, 10)).filter(n => Number.isInteger(n));
                            const size = openConfig.images.length;
                            const expected = new Set(Array.from({ length: size }, (_, i) => i + 1));
                            const provided = new Set(parts);
                            if (parts.length !== size || provided.size !== size || [...provided].some(n => !expected.has(n))) {
                                return await mi.reply({ content: `❌ الترتيب غير صالح. يجب كتابة كل الأرقام مرة واحدة من 1 إلى ${size}.`, ephemeral: true });
                            }
                            const oldImages = [...openConfig.images];
                            const oldButtonIdx = openConfig.buttonImageIndex;
                            const oldButtonImage = oldButtonIdx >= 0 ? oldImages[oldButtonIdx] : null;
                            openConfig.images = parts.map(n => oldImages[n - 1]);
                            openConfig.imageUrls = openConfig.images.map(img => img.imageUrl);
                            if (oldButtonImage) {
                                openConfig.buttonImageIndex = openConfig.images.findIndex(img => img.imageUrl === oldButtonImage.imageUrl && img.localImagePath === oldButtonImage.localImagePath);
                            }
                            if (openConfig.buttonImageIndex < 0) openConfig.buttonImageIndex = openConfig.images.length - 1;
                            persistOpenConfig();
                            await mi.reply({ content: '✅ تم ترتيب الصور بنجاح.', ephemeral: true });
                            await refreshOpenPanel();
                            return;
                        }

                        if (mi.customId === `open_setup_modal_buttonimage_${openConfigKey}`) {
                            const raw = mi.fields.getTextInputValue('button_image_index').trim();
                            const oneBased = parseInt(raw, 10);
                            if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > openConfig.images.length) {
                                return await mi.reply({ content: `❌ رقم الصورة غير صالح. اختر رقم من 1 إلى ${openConfig.images.length}.`, ephemeral: true });
                            }
                            openConfig.buttonImageIndex = oneBased - 1;
                            persistOpenConfig();
                            await mi.reply({ content: `✅ تم تحديد الصورة رقم ${oneBased} كصورة الأزرار.`, ephemeral: true });
                            await refreshOpenPanel();
                            return;
                        }

                        if (mi.customId === `open_setup_modal_addimage_${openConfigKey}`) {
                            const imageUrl = mi.fields.getTextInputValue('image_url').trim();
                            if (!/^https?:\/\//i.test(imageUrl)) {
                                return await mi.reply({ content: '❌ رابط الصورة غير صالح. استخدم رابط مباشر يبدأ بـ http أو https لصورة.', ephemeral: true });
                            }
                            if (openConfig.images.length >= 20) {
                                return await mi.reply({ content: '❌ وصلت للحد الأقصى للصور (20).', ephemeral: true });
                            }
                            if (openConfig.images.some(img => img.imageUrl === imageUrl)) {
                                return await mi.reply({ content: '⚠️ هذه الصورة مضافة مسبقاً.', ephemeral: true });
                            }
                            const ext = imageUrl.split('.').pop().split(/[?#]/)[0] || 'png';
                            const filename = `${openConfigKey}_open_${Date.now()}.${ext}`;
                            await mi.deferReply({ ephemeral: true });
                            const localPath = await downloadImage(imageUrl, filename);
                            if (!localPath) {
                                return await mi.editReply({ content: '❌ فشل تحميل الصورة. تأكد أن الرابط مباشر وأن الموقع يسمح بالتحميل.' });
                            }
                            openConfig.images.push({ imageUrl, localImagePath: filename });
                            openConfig.imageUrls = openConfig.images.map(img => img.imageUrl);
                            if (openConfig.buttonImageIndex < 0) openConfig.buttonImageIndex = openConfig.images.length - 1;
                            persistOpenConfig();
                            await mi.editReply({ content: `✅ تم إضافة الصورة رقم ${openConfig.images.length}.` });
                            await refreshOpenPanel();
                            return;
                        }
                    } catch (err) {
                        console.error('open setup modal error:', err.message);
                    }
                };

                message.client.on('interactionCreate', openModalHandler);

                openCollector.on('end', async () => {
                    message.client.off('interactionCreate', openModalHandler);
                    await openSetupMsg.edit({ components: [] }).catch(() => {});
                });

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
