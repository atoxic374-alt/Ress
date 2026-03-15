const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const { loadMapConfigsSync, writeMapConfigsQueued } = require('../utils/mapConfigStore');

function loadAllConfigs() {
    const data = loadMapConfigsSync();
    return Object.keys(data).length > 0
        ? data
        : { global: { enabled: false, imageUrl: 'https://i.ibb.co/pP9GzD7/default-map.png', welcomeMessage: 'مرحباً بك!', buttons: [] } };
}

async function saveAllConfigs(allConfigs) {
    return await writeMapConfigsQueued(allConfigs);
}

function toDigitEmoji(num) {
    const normalized = Math.max(0, Number(num) || 0).toString();
    const map = {
        '0': '<:emoji_27:1482578058199302195>',
        '1': '<:emoji_27:1482578008542937159>',
        '2': '<:emoji_28:1482578088511672320>',
        '3': '<:emoji_29:1482578116374433833>',
        '4': '<:emoji_29:1482578165485277295>',
        '5': '<:emoji_31:1482578227611435079>',
        '6': '<:emoji_32:1482578278966366208>',
        '7': '<:emoji_33:1482578299426177115>',
        '8': '<:emoji_35:1482578353771905157>',
        '9': '<:emoji_35:1482578379185324124>'
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


async function syncOpenActiveUsers(config, guild) {
    if (!config?.open) return [];

    const stored = Array.isArray(config.open.activeUsers)
        ? [...new Set(config.open.activeUsers.filter(id => /^\d{17,19}$/.test(String(id))))]
        : [];

    // لا نُصفّر العداد خارج السيرفر، نحافظ على القيمة المخزنة
    if (!guild) {
        config.open.activeUsers = stored;
        return stored;
    }

    // مزامنة خفيفة بدون جلب كل الأعضاء (أداء أعلى)
    const roleId = config.open.roleId;
    if (!roleId || !/^\d{17,19}$/.test(roleId)) {
        config.open.activeUsers = [];
        return [];
    }

    const role = guild.roles.cache.get(roleId);
    if (role) {
        const cachedRoleMembers = role.members.map(m => m.id);
        if (cachedRoleMembers.length > 0) {
            config.open.activeUsers = cachedRoleMembers;
            return cachedRoleMembers;
        }
    }

    config.open.activeUsers = stored;
    return stored;
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
                .setLabel(btn.label || 'Button')
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
                    return message.reply('⚠️ نظام **الخريطة - الأوبن** غير مفعل حالياً.').catch(() => {});
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

                let buttonImageIndex = Number.isInteger(config.open?.buttonImageIndex) ? config.open.buttonImageIndex : (imagesToSend.length - 1);
                if (buttonImageIndex < 0 || buttonImageIndex >= imagesToSend.length) buttonImageIndex = imagesToSend.length - 1;

                const imagesBeforeButtons = imagesToSend.filter((_, idx) => idx !== buttonImageIndex);
                for (const url of imagesBeforeButtons) {
                    await message.channel.send({ files: [url] }).catch(() => {});
                }

                const previousActive = Array.isArray(config.open.activeUsers) ? [...new Set(config.open.activeUsers)] : [];
                const activeUsers = await syncOpenActiveUsers(config, message.guild);
                const prevKey = previousActive.slice().sort().join(',');
                const nextKey = [...new Set(activeUsers)].slice().sort().join(',');
                if (prevKey !== nextKey) {
                    allConfigs[configKey] = config;
                    await saveAllConfigs(allConfigs);
                }

                const counterMode = config.open?.counterButton?.mode === 'label_number' ? 'label_number' : 'emoji_digits';
                const openButton = new ButtonBuilder()
                    .setCustomId(`map_open_toggle_${configKey}`)
                    .setLabel((config.open?.openButton?.label || 'اوبن').slice(0, 80))
                    .setStyle(config.open?.openButton?.style || ButtonStyle.Success)
                    .setDisabled(!config.open?.roleId || !/^\d{17,19}$/.test(config.open.roleId));

                if (config.open?.openButton?.emoji) {
                    openButton.setEmoji(config.open.openButton.emoji);
                }

                const counterBaseLabel = 'المفّعليين';
                const counterButton = new ButtonBuilder()
                    .setCustomId(`map_open_count_${configKey}`)
                    .setStyle(config.open?.counterButton?.style || ButtonStyle.Secondary)
                    .setDisabled(true);

                if (counterMode === 'label_number') {
                    counterButton.setLabel(`${counterBaseLabel} : ${activeUsers.length.toLocaleString('en-US')}`);
                    if (config.open?.counterButton?.emoji) {
                        counterButton.setEmoji(config.open.counterButton.emoji);
                    }
                } else {
                    counterButton
                        .setEmoji(toDigitEmoji(activeUsers.length));
                }

                const row = new ActionRowBuilder().addComponents(openButton, counterButton);
                const panelPayload = {
                    components: [row]
                };

                const buttonsImage = imagesToSend[buttonImageIndex] || imagesToSend[imagesToSend.length - 1];

                if (buttonsImage) panelPayload.files = [buttonsImage];

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
