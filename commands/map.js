const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'data', 'serverMapConfig.json');

function loadAllConfigs() {
    try {
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.imageUrl && !data.global) return { global: data };
            return data;
        }
    } catch (e) { console.error('Error loading map config:', e.message); }
    return { global: { enabled: false, imageUrl: 'https://i.ibb.co/pP9GzD7/default-map.png', welcomeMessage: 'مرحباً بك!', buttons: [] } };
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

function toDigitEmoji(num) {
    const normalized = Math.max(0, Number(num) || 0).toString();
    const map = {
        '0': '0️⃣',
        '1': '1️⃣',
        '2': '2️⃣',
        '3': '3️⃣',
        '4': '4️⃣',
        '5': '5️⃣',
        '6': '6️⃣',
        '7': '7️⃣',
        '8': '8️⃣',
        '9': '9️⃣'
    };
    return normalized.split('').map(d => map[d] || d).join('');
}

function resolveMapConfig(message, allConfigs) {
    const selectedConfigKey = (message.isGlobalOnly || !message.guild)
        ? 'global'
        : (allConfigs[`channel_${message.channel.id}`] ? `channel_${message.channel.id}` : 'global');

    return {
        configKey: selectedConfigKey,
        config: allConfigs[selectedConfigKey]
    };
}

function buildClassicRows(config, configKey) {
    const rows = [];
    if (config.buttons && config.buttons.length > 0) {
        let currentRow = new ActionRowBuilder();
        config.buttons.slice(0, 25).forEach((btn, index) => {
            if ((index > 0 && index % 5 === 0) || (btn.newline && currentRow.components.length > 0)) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
            }

            const mapScope = configKey === 'global' ? 'g' : `c${configKey.replace('channel_', '')}`;
            const button = new ButtonBuilder()
                .setCustomId(`map_btn_${mapScope}_${index}`)
                .setLabel(btn.label || 'زر بدون اسم')
                .setStyle(btn.style || ButtonStyle.Secondary);

            if (btn.emoji) {
                button.setEmoji(btn.emoji);
            }

            currentRow.addComponents(button);
        });
        if (currentRow.components.length > 0) rows.push(currentRow);
    }
    return rows;
}

module.exports = {
    name: 'map',
    description: 'عرض خريطة السيرفر التفاعلية',
    async execute(message, args, { client, BOT_OWNERS }) {
        try {
            const owners = Array.isArray(BOT_OWNERS) ? BOT_OWNERS : [];
            const isOwner = message.author ? owners.includes(message.author.id) : false;
            const isAutomatic = message.isAutomatic === true;

            if (!isOwner && !isAutomatic) {
                if (message.react) await message.react('❌').catch(() => {});
                return;
            }

            const allConfigs = loadAllConfigs();
            const { configKey, config } = resolveMapConfig(message, allConfigs);

            const isOpenMode = args[0] && args[0].toLowerCase() === 'open';
            if (isOpenMode) {
                if (!config?.open?.enabled) {
                    return message.reply('⚠️ نظام map open غير مفعل حالياً.').catch(() => {});
                }

                const openImages = Array.isArray(config.open.images) ? config.open.images : [];
                const localImages = openImages
                    .map(img => img?.localImagePath)
                    .filter(Boolean)
                    .map(localName => path.join(__dirname, '..', 'attached_assets', 'map_images', localName))
                    .filter(localPath => fs.existsSync(localPath));

                const remoteImages = Array.isArray(config.open.imageUrls)
                    ? config.open.imageUrls.filter(u => /^https?:\/\//i.test(u))
                    : [];

                const imagesToSend = localImages.length > 0
                    ? localImages
                    : (remoteImages.length > 0 ? remoteImages : [config.imageUrl].filter(Boolean));

                if (imagesToSend.length > 1) {
                    for (const url of imagesToSend.slice(0, -1)) {
                        await message.channel.send({ files: [url] }).catch(() => {});
                    }
                }

                const activeUsers = Array.isArray(config.open.activeUsers) ? config.open.activeUsers : [];
                const counterMode = config.open?.counterButton?.mode === 'label_number' ? 'label_number' : 'emoji_digits';
                const openButton = new ButtonBuilder()
                    .setCustomId(`map_open_toggle_${configKey}`)
                    .setLabel(config.open?.openButton?.label || 'Open')
                    .setStyle(config.open?.openButton?.style || ButtonStyle.Success);

                if (config.open?.openButton?.emoji) {
                    openButton.setEmoji(config.open.openButton.emoji);
                }

                const counterBaseLabel = 'المتفعّلين';
                const counterButton = new ButtonBuilder()
                    .setCustomId(`map_open_count_${configKey}`)
                    .setStyle(config.open?.counterButton?.style || ButtonStyle.Secondary)
                    .setDisabled(true);

                if (counterMode === 'label_number') {
                    counterButton.setLabel(`${counterBaseLabel}: ${activeUsers.length.toLocaleString('en-US')}`);
                } else {
                    counterButton
                        .setLabel(counterBaseLabel)
                        .setEmoji(toDigitEmoji(activeUsers.length));
                }

                const row = new ActionRowBuilder().addComponents(openButton, counterButton);
                const panelPayload = {
                    content: '🧭 **Open Panel**',
                    components: [row]
                };

                const lastImage = imagesToSend[imagesToSend.length - 1];
                if (lastImage) panelPayload.files = [lastImage];

                await message.channel.send(panelPayload);
                return;
            }

            if (!config || (!config.enabled && !args.includes('--force'))) {
                return message.reply('⚠️ نظام الخريطة معطل حالياً.').catch(() => {});
            }

            if (!isAutomatic && !message.channel.permissionsFor(client.user).has(['SendMessages', 'AttachFiles', 'EmbedLinks'])) {
                return console.log(`🚫 نقص في الصلاحيات لإرسال الخريطة في قناة: ${message.channel.name}`);
            }

            const canvas = createCanvas(1280, 720);
            const ctx = canvas.getContext('2d');

            try {
                let bg;
                if (config.localImagePath) {
                    const localPath = path.join(__dirname, '..', 'attached_assets', 'map_images', config.localImagePath);
                    if (fs.existsSync(localPath)) {
                        bg = await loadImage(localPath);
                    }
                }

                if (!bg) {
                    bg = await loadImage(config.imageUrl || 'https://i.ibb.co/pP9GzD7/default-map.png');
                }

                ctx.drawImage(bg, 0, 0, 1280, 720);
            } catch (e) {
                console.error('Error drawing map image:', e.message);
                ctx.fillStyle = '#23272a';
                ctx.fillRect(0, 0, 1280, 720);
                ctx.font = 'bold 60px Arial';
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.fillText(message.guild.name, 640, 360);
            }

            const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'server-map.png' });
            const rows = buildClassicRows(config, configKey);

            const sendOptions = {
                content: (config.welcomeMessage && config.welcomeMessage.trim() !== '') ? config.welcomeMessage : null,
                files: [attachment],
                components: rows
            };

            if (message.send) {
                await message.send(sendOptions).catch(err => console.error('Error sending map (send):', err));
            } else {
                await message.channel.send(sendOptions).catch(err => {
                    if (err.code === 50007) {
                        console.log('🚫 لا يمكن إرسال الخريطة في الخاص للمستخدم.');
                    } else {
                        console.error('Error sending map message:', err);
                    }
                });
            }
        } catch (error) {
            console.error('❌ خطأ في تنفيذ أمر الخريطة:', error.message);
        }
    },
    saveAllConfigs
};
