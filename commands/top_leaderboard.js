const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    ThumbnailBuilder
} = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { componentsV2Payload, colorToNumber } = require('../utils/structuredContainer');
const { isUserBlocked } = require('./block.js');

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../utils/storagePaths');

const name = 'top';

// مسارات الملفات
const ticketState = require('./ticket.js');
const responsibilitiesPath = path.join(getDataDir(), 'responsibilities.json');

// --- Caching Mechanism ---
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
let leaderboardCache = {};

function invalidateTopCache() {
    console.log('Leaderboard cache invalidated.');
    leaderboardCache = {};
}
// -------------------------

// دالة قراءة البيانات المحدثة
function readJSONFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error);
        return defaultValue;
    }
}

async function execute(message, args, { points, responsibilities, client }) {
    // فحص البلوك أولاً
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    // قراءة البيانات المحدثة من الملفات
    const currentResponsibilities = readJSONFile(responsibilitiesPath, {});
    let currentType = 'all';
    let currentResponsibility = null;
    let page = 0;
    const pageSize = 10;
    const guild = message.guild || message.channel.guild;
    const guildIconUrl = guild?.iconURL?.({ extension: 'png', size: 128 })
        || 'https://cdn.discordapp.com/embed/avatars/0.png';

    // التحقق من الأرغيومنت لمسؤولية معينة
    if (args.length > 0) {
        const respName = args.join(' ');
        if (currentResponsibilities[respName]) {
            currentResponsibility = respName;
        }
    }

    function getOrCalculateUserPoints(type = 'all', responsibilityName = null) {
        const cacheKey = `${type}_${responsibilityName || 'all'}`;
        const now = Date.now();

        // Check cache first
        if (leaderboardCache[cacheKey] && (now - leaderboardCache[cacheKey].timestamp < CACHE_DURATION)) {
            return leaderboardCache[cacheKey].data;
        }

        // If not in cache or expired, calculate
        const freshPoints = ticketState.loadPoints();
        const userPoints = {};
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
        const oneMonthAgo = now - (30 * 24 * 60 * 60 * 1000);

        const claims = freshPoints.__shortcutClaims;
        const audit = Array.isArray(freshPoints.__audit) ? freshPoints.__audit.filter(entry => entry?.source === 'shortcut_take') : [];
        const auditedIds = new Set(audit.map(entry => String(entry.id || '')));
        const takeEntries = claims && typeof claims === 'object' && !Array.isArray(claims) && Object.keys(claims).length > 0
            ? Object.values(claims)
                .filter(claim => claim && (claim.pointsAwarded === true ||
                    (claim.pointsAwarded !== false && auditedIds.has(String(claim.entryId || '')))))
                .map(claim => ({ targetId: claim.userId, respName: claim.responsibilityName, at: claim.at, delta: 1 }))
            : audit;
        for (const entry of takeEntries) {
            if (responsibilityName && String(entry.respName || '') !== responsibilityName) continue;
            const userId = String(entry.targetId || '');
            const delta = Number(entry.delta || 0);
            const time = Number.parseInt(String(entry.at || entry.id || ''), 10);
            if (!userId || !Number.isFinite(delta) || delta <= 0) continue;
            const inRange = type === 'all'
                || (type === 'daily' && time >= oneDayAgo)
                || (type === 'weekly' && time >= oneWeekAgo)
                || (type === 'monthly' && time >= oneMonthAgo);
            if (inRange) userPoints[userId] = (userPoints[userId] || 0) + delta;
        }

        const sortedData = Object.entries(userPoints).sort((a, b) => b[1] - a[1]);

        // Store in cache
        leaderboardCache[cacheKey] = {
            data: sortedData,
            timestamp: now
        };

        return sortedData;
    }

    const medals = ['🥇', '🥈', '🥉'];
    const badge = (points) => points >= 50 ? '🏆' : points >= 25 ? '⭐' : points >= 10 ? '🎖️' : '';

    function buildLeaderboardContainer(rows = []) {
        const sorted = getOrCalculateUserPoints(currentType, currentResponsibility);
        const current = sorted.slice(page * pageSize, (page + 1) * pageSize);
        const typeNames = { daily: 'اليومي', weekly: 'الأسبوعي', monthly: 'الشهري', all: 'الكل' };
        const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
        const filterDescription = `**الفترة :** ${typeNames[currentType]}\n**المسؤولية :** ${currentResponsibility || 'جميع المسؤوليات'}`;
        let rankingDescription;
        if (sorted.length === 0) {
            rankingDescription = '**لا توجد نقاط في هذه الفترة.**';
        } else {
            rankingDescription = current.map(([id, pts], idx) => {
                const rank = page * pageSize + idx + 1;
                const emoji = medals[rank - 1] || `${rank}.`;
                return `${emoji} <@${id}> - **${pts} نقطة** ${badge(pts)}`;
            }).join('\n');
        }

        const accentColor = colorToNumber(colorManager.getColor?.() || '#0099ff', 0x0099ff);
        const header = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Top Responsibilities'))
            .setThumbnailAccessory(new ThumbnailBuilder()
                .setURL(guildIconUrl)
                .setDescription(`شعار ${guild?.name || 'السيرفر'}`));
        const container = new ContainerBuilder()
            .setAccentColor(accentColor)
            .addSectionComponents(header)
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${filterDescription}\n\n${rankingDescription}`))
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Page ${page + 1} / ${pageCount}`));
        rows.forEach((row) => container.addActionRowComponents(row));
        return container;
    }

    function buildLeaderboardPayload(rows = []) {
        return {
            ...componentsV2Payload(buildLeaderboardContainer(rows)),
            allowedMentions: { parse: [], repliedUser: false }
        };
    }

    const typeSelect = new StringSelectMenuBuilder()
        .setCustomId('top_type_select')
        .setPlaceholder('Select ranking period...')
        .addOptions([
            { label: 'Daily Ranking', value: 'daily', description: 'النقاط المكتسبة خلال آخر 24 ساعة' },
            { label: 'Weekly Ranking', value: 'weekly', description: 'النقاط المكتسبة خلال آخر 7 أيام' },
            { label: 'Monthly Ranking', value: 'monthly', description: 'النقاط المكتسبة خلال آخر 30 يوم' },
            { label: 'All-Time Ranking', value: 'all', description: 'جميع النقاط منذ البداية' }
        ]);

    // إضافة منيو اختيار المسؤولية
    const { createPaginatedResponsibilityArray, handlePaginationInteraction } = require('../utils/responsibilityPagination.js');
    
    const respList = [{ name: 'جميع المسؤوليات', description: 'عرض ترتيب جميع المسؤولين' }];
    Object.keys(currentResponsibilities).forEach(respName => {
        respList.push({
            name: respName,
            description: `ترتيب مسؤولي ${respName} فقط`
        });
    });

    const pagination = createPaginatedResponsibilityArray(respList.map((r, i) => ({
        name: r.name,
        value: i === 0 ? 'all_responsibilities' : `resp_${r.name}`,
        description: r.description
    })), 0, 'top_resp_select', 'Select responsibility...');

    const selectRow1 = new ActionRowBuilder().addComponents(typeSelect);
    const selectRow2Components = pagination.components;

    const sorted = getOrCalculateUserPoints(currentType, currentResponsibility);
    const maxPages = Math.ceil(sorted.length / pageSize);

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('top_prev')
            .setEmoji('<:emoji_13:1429263136136888501>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId('top_next')
            .setEmoji('<:emoji_14:1429263186539974708>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= maxPages - 1 || maxPages === 0)
    );

    const sentMessage = await message.channel.send(
        buildLeaderboardPayload([selectRow1, ...selectRow2Components, buttonRow])
    );

    const filter = i => i.user.id === message.author.id && i.message.id === sentMessage.id;
    const collector = message.channel.createMessageComponentCollector({ filter, time: 600000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.customId === 'top_type_select') {
                currentType = interaction.values[0];
                page = 0;
            } else if (interaction.customId === 'top_resp_select') {
                const value = interaction.values[0];
                if (value === 'all_responsibilities') {
                    currentResponsibility = null;
                } else {
                    currentResponsibility = value.replace('resp_', '');
                }
                page = 0;
            } else if (interaction.customId === 'top_prev' && page > 0) {
                page--;
            } else if (interaction.customId === 'top_next') {
                const sorted = getOrCalculateUserPoints(currentType, currentResponsibility);
                const maxPages = Math.ceil(sorted.length / pageSize);
                if (page < maxPages - 1) {
                    page++;
                }
            }

            const sorted = getOrCalculateUserPoints(currentType, currentResponsibility);
            const maxPages = Math.ceil(sorted.length / pageSize);

            const newButtonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('top_prev')
                    .setEmoji('<:emoji_13:1429263136136888501>')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('top_next')
                    .setEmoji('<:emoji_14:1429263186539974708>')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= maxPages - 1 || maxPages === 0)
            );

            // إعادة بناء pagination للمسؤوليات
            const respList = [{ name: 'جميع المسؤوليات', description: 'عرض ترتيب جميع المسؤولين' }];
            Object.keys(currentResponsibilities).forEach(respName => {
                respList.push({
                    name: respName,
                    description: `ترتيب مسؤولي ${respName} فقط`
                });
            });

            const newPagination = createPaginatedResponsibilityArray(respList.map((r, i) => ({
                name: r.name,
                value: i === 0 ? 'all_responsibilities' : `resp_${r.name}`,
                description: r.description
            })), 0, 'top_resp_select', 'Select responsibility...');

            await interaction.update(
                buildLeaderboardPayload([selectRow1, ...newPagination.components, newButtonRow])
            );
        } catch (error) {
            console.error('Error in top leaderboard collector:', error);
        }
    });

    collector.on('end', () => {
        sentMessage.edit(buildLeaderboardPayload([])).catch(() => {});
    });
}

module.exports = { name, execute, invalidateTopCache };
