const { getBotConfigPath } = require('../utils/storagePaths');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, AttachmentBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const colorManager = require('../utils/colorManager.js');
const { getResponsibilitiesSnapshot, normalizeResponsibilitiesMap } = require('../utils/responsibilitiesStore');

// نظام الكولداون
const applyCooldowns = new Map();
const DEFAULT_COOLDOWN_TIME = 30 * 60 * 1000; // 30 دقيقة بالملي ثانية

const DATA_FILES = {
    responsibilities: path.join(__dirname, '..', 'data', 'responsibilities.json'),
    respConfig: path.join(__dirname, '..', 'data', 'respConfig.json'),
    categories: path.join(__dirname, '..', 'data', 'respCategories.json')
};

function getCurrentResponsibilities() {
    return getResponsibilitiesSnapshot();
}

// دالة لقراءة ملف JSON
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

// دالة لكتابة ملف JSON
function writeJSONFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`خطأ في كتابة ${filePath}:`, error);
        return false;
    }
}

function parseDurationToMinutes(rawValue) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (!value) return { error: 'empty' };
    if (value === 'off' || value === '0') return { minutes: 0 };
    if (/^\d+$/.test(value)) return { minutes: Number(value) };

    let totalMinutes = 0;
    const regex = /(\d+)\s*(d|day|days|ي|يوم|ايام|h|hr|hrs|hour|hours|س|ساعة|ساعات|m|min|mins|minute|minutes|د|دقيقة|دقائق)/g;
    let matched = false;
    let consumed = '';
    let match;

    while ((match = regex.exec(value)) !== null) {
        matched = true;
        consumed += match[0];
        const amount = Number(match[1]);
        const unit = match[2];
        if (!Number.isFinite(amount)) continue;

        if (['d', 'day', 'days', 'ي', 'يوم', 'ايام'].includes(unit)) {
            totalMinutes += amount * 24 * 60;
        } else if (['h', 'hr', 'hrs', 'hour', 'hours', 'س', 'ساعة', 'ساعات'].includes(unit)) {
            totalMinutes += amount * 60;
        } else {
            totalMinutes += amount;
        }
    }

    if (!matched) return { error: 'invalid' };
    const cleaned = value.replace(/\s+/g, '');
    const consumedClean = consumed.replace(/\s+/g, '');
    if (cleaned !== consumedClean) return { error: 'invalid' };

    return { minutes: totalMinutes };
}

function formatMinutesArabic(totalMinutes) {
    const minutes = Math.max(0, Number(totalMinutes) || 0);
    if (minutes <= 0) return 'مغلق';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (mins) parts.push(`${mins}m`);
    return parts.join(' , ');
}

function formatRemainingTimeFromMs(durationMs) {
    const totalSeconds = Math.max(1, Math.ceil((Number(durationMs) || 0) / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds && parts.length < 2) parts.push(`${seconds}s`);
    return parts.join(' , ');
}

function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;

    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;

        // السماح بروابط الصور الشائعة حتى مع query params
        if (/\.(jpg|jpeg|png|webp|gif)$/i.test(parsed.pathname)) {
            return true;
        }

        // قبول روابط CDN/Discord حتى بدون امتداد واضح
        return parsed.hostname.includes('discord') || parsed.hostname.includes('imgur') || parsed.hostname.includes('cdn');
    } catch (_) {
        return false;
    }
}


function getGuildRespConfig(guildId) {
    const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
    if (!config.guilds) config.guilds = {};
    if (!config.guilds[guildId]) config.guilds[guildId] = {};
    return config;
}

function getFullResponsibilities(guildId) {
    const config = getGuildRespConfig(guildId);
    const fullList = config.guilds[guildId].fullResponsibilities;
    return Array.isArray(fullList) ? fullList : [];
}

function isResponsibilityFull(guildId, responsibilityName) {
    return getFullResponsibilities(guildId).includes(responsibilityName);
}

function getRespApplyCooldownMs(guildId) {
    const config = getGuildRespConfig(guildId);
    const guildConfig = config.guilds[guildId] || {};
    const rawMinutes = guildConfig.applyCooldownMinutes;

    if (rawMinutes === 0 || rawMinutes === '0' || rawMinutes === 'off' || rawMinutes === false) {
        return null;
    }

    const minutes = Number(rawMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
        return minutes * 60 * 1000;
    }

    return DEFAULT_COOLDOWN_TIME;
}

function getRespRejectCooldownMs(guildId) {
    const config = getGuildRespConfig(guildId);
    const guildConfig = config.guilds[guildId] || {};
    const rawMinutes = guildConfig.rejectApplyCooldownMinutes;

    if (rawMinutes === 0 || rawMinutes === '0' || rawMinutes === 'off' || rawMinutes === false) {
        return null;
    }

    const minutes = Number(rawMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
        return minutes * 60 * 1000;
    }

    return null;
}

function makeRejectCooldownKey(userId, respName) {
    return `${userId}:${respName}`;
}

function setRejectedApplyCooldown(guildId, userId, respName, durationMs) {
    if (!durationMs || durationMs <= 0) return;
    const config = getGuildRespConfig(guildId);
    if (!config.guilds[guildId]) config.guilds[guildId] = {};
    if (!config.guilds[guildId].rejectApplyCooldowns || typeof config.guilds[guildId].rejectApplyCooldowns !== 'object') {
        config.guilds[guildId].rejectApplyCooldowns = {};
    }
    config.guilds[guildId].rejectApplyCooldowns[makeRejectCooldownKey(userId, respName)] = Date.now() + durationMs;
    writeJSONFile(DATA_FILES.respConfig, config);
}

function getActiveRejectedApplyCooldown(guildId, userId, respName) {
    const config = getGuildRespConfig(guildId);
    const guildConfig = config.guilds[guildId] || {};
    const store = guildConfig.rejectApplyCooldowns && typeof guildConfig.rejectApplyCooldowns === 'object'
        ? guildConfig.rejectApplyCooldowns
        : {};
    const key = makeRejectCooldownKey(userId, respName);
    const until = Number(store[key] || 0);
    if (!until) return null;
    const timeLeft = until - Date.now();
    if (timeLeft <= 0) {
        delete store[key];
        config.guilds[guildId].rejectApplyCooldowns = store;
        writeJSONFile(DATA_FILES.respConfig, config);
        return null;
    }
    return { until, timeLeft };
}

function getRespRoleRestrictions(guildId) {
    const config = getGuildRespConfig(guildId);
    const restrictions = config.guilds[guildId]?.respRoleRestrictions;
    return restrictions && typeof restrictions === 'object' ? restrictions : {};
}

function setRespRoleRestriction(guildId, respName, roleIds = []) {
    const config = getGuildRespConfig(guildId);
    if (!config.guilds[guildId]) config.guilds[guildId] = {};
    if (!config.guilds[guildId].respRoleRestrictions || typeof config.guilds[guildId].respRoleRestrictions !== 'object') {
        config.guilds[guildId].respRoleRestrictions = {};
    }

    if (!Array.isArray(roleIds) || roleIds.length === 0) {
        delete config.guilds[guildId].respRoleRestrictions[respName];
    } else {
        config.guilds[guildId].respRoleRestrictions[respName] = [...new Set(roleIds)];
    }

    writeJSONFile(DATA_FILES.respConfig, config);
}

function getAllowedAdminRolesForGuild(guildId) {
    const adminRolesData = readJSONFile(path.join(__dirname, '..', 'data', 'adminRoles.json'), []);
    if (Array.isArray(adminRolesData)) return adminRolesData;
    if (adminRolesData && typeof adminRolesData === 'object') {
        const byGuild = adminRolesData[guildId];
        return Array.isArray(byGuild) ? byGuild : [];
    }
    return [];
}

function getRespManagers(guildId) {
    const config = getGuildRespConfig(guildId);
    const managers = config.guilds[guildId]?.respManagers;
    return {
        roleIds: Array.isArray(managers?.roleIds) ? [...new Set(managers.roleIds.map(String))] : [],
        userIds: Array.isArray(managers?.userIds) ? [...new Set(managers.userIds.map(String))] : []
    };
}

function setRespManagers(guildId, updates = {}) {
    const config = getGuildRespConfig(guildId);
    if (!config.guilds[guildId]) config.guilds[guildId] = {};
    const current = getRespManagers(guildId);
    config.guilds[guildId].respManagers = {
        roleIds: Array.isArray(updates.roleIds) ? [...new Set(updates.roleIds.map(String))] : current.roleIds,
        userIds: Array.isArray(updates.userIds) ? [...new Set(updates.userIds.map(String))] : current.userIds
    };
    writeJSONFile(DATA_FILES.respConfig, config);
    return config.guilds[guildId].respManagers;
}

function isRespManager(interactionLike) {
    const guild = interactionLike?.guild;
    const userId = interactionLike?.user?.id || interactionLike?.author?.id;
    if (!guild || !userId) return false;

    const botConfig = readJSONFile(getBotConfigPath(), {});
    const owners = Array.isArray(botConfig.owners) ? botConfig.owners.map(String) : [];
    if (owners.includes(String(userId)) || guild.ownerId === String(userId)) return true;

    const managers = getRespManagers(guild.id);
    if (managers.userIds.includes(String(userId))) return true;
    const memberRoleIds = interactionLike.member?.roles?.cache
        ? [...interactionLike.member.roles.cache.keys()].map(String)
        : [];
    return managers.roleIds.some((roleId) => memberRoleIds.includes(roleId));
}

function appendRespAuditLog(guildId, actorId, action, details = {}) {
    const config = getGuildRespConfig(guildId);
    if (!config.guilds[guildId]) config.guilds[guildId] = {};
    if (!Array.isArray(config.guilds[guildId].auditTrail)) config.guilds[guildId].auditTrail = [];

    config.guilds[guildId].auditTrail.unshift({
        at: Date.now(),
        actorId,
        action,
        details
    });

    config.guilds[guildId].auditTrail = config.guilds[guildId].auditTrail.slice(0, 100);
    writeJSONFile(DATA_FILES.respConfig, config);
}

function getImageNameFromUrl(url) {
    try {
        const parsed = new URL(url);
        const ext = path.extname(parsed.pathname) || '.png';
        return `resp_image${ext}`;
    } catch (_) {
        return 'resp_image.png';
    }
}

function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return url;

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const isDiscordCdn = host.includes('discordapp.com') || host.includes('discordapp.net') || host.includes('discord.com');

        if (isDiscordCdn) {
            parsed.search = '';
            parsed.hash = '';

            if (host === 'media.discordapp.net' && parsed.pathname.includes('/attachments/')) {
                parsed.hostname = 'cdn.discordapp.com';
            }
        }

        return parsed.toString();
    } catch (_) {
        return url;
    }
}

function resolveResponsibilityImageUrl(guildId, respData = null, { allowGlobalFallback = true } = {}) {
    const directImage = normalizeImageUrl(respData?.image);
    if (directImage && isValidImageUrl(directImage)) {
        return directImage;
    }

    if (!allowGlobalFallback) return null;

    const config = getGuildRespConfig(guildId);
    const globalImage = normalizeImageUrl(config.guilds?.[guildId]?.globalImageUrl);
    if (globalImage && isValidImageUrl(globalImage)) {
        return globalImage;
    }

    return null;
}

function applyEmojiSafely(button, emojiValue) {
    const normalized = typeof emojiValue === 'string' ? emojiValue.trim() : emojiValue;

    if (!normalized) return button;

    try {
        button.setEmoji(normalized);
    } catch (error) {
        console.log(`⚠️ تعذر تعيين الإيموجي ${emojiValue}: ${error.message}`);
    }

    return button;
}

function buildDisabledComponents(rows = []) {
    if (!Array.isArray(rows)) return [];
    return rows
        .filter((row) => row?.components?.length)
        .map((row) => {
            const rowData = row.toJSON ? row.toJSON() : row;
            const disabledRowData = {
                ...rowData,
                components: (rowData.components || []).map((component) => ({
                    ...component,
                    disabled: true
                }))
            };
            return ActionRowBuilder.from(disabledRowData);
        });
}

async function disableMessageComponents(messageLike) {
    if (!messageLike?.components?.length || typeof messageLike.edit !== 'function') return;
    const disabledComponents = buildDisabledComponents(messageLike.components);
    if (!disabledComponents.length) return;
    await messageLike.edit({ components: disabledComponents }).catch(() => {});
}


async function createImageAttachment(url) {
    try {
        const normalizedUrl = normalizeImageUrl(url);
        const candidateUrls = [...new Set([normalizedUrl, url].filter(Boolean))];
        let response = null;
        let parsedUrl = null;
        let lastError = null;

        for (const candidateUrl of candidateUrls) {
            try {
                parsedUrl = new URL(candidateUrl);

                if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                    console.log('⚠️ تم رفض رابط صورة ببروتوكول غير مسموح');
                    return null;
                }

                const hostname = parsedUrl.hostname.toLowerCase();
                if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
                    console.log('⚠️ تم رفض رابط صورة يشير إلى localhost');
                    return null;
                }

                const isPrivateIp = (ip) => {
                    if (!net.isIP(ip)) return false;
                    if (ip === '127.0.0.1' || ip === '::1') return true;
                    if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
                    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
                    if (ip.startsWith('169.254.')) return true;
                    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
                    return false;
                };

                if (net.isIP(hostname) && isPrivateIp(hostname)) {
                    console.log('⚠️ تم رفض رابط صورة يشير إلى عنوان IP داخلي');
                    return null;
                }

                if (!net.isIP(hostname)) {
                    const records = await dns.lookup(hostname, { all: true }).catch(() => []);
                    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
                        console.log('⚠️ تم رفض رابط صورة بسبب DNS غير موثوق/داخلي');
                        return null;
                    }
                }

                response = await axios.get(candidateUrl, {
                    responseType: 'arraybuffer',
                    timeout: 10000,
                    maxRedirects: 5,
                    maxContentLength: 8 * 1024 * 1024,
                    maxBodyLength: 8 * 1024 * 1024,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; RespBot/1.0)',
                        'Accept': 'image/*,*/*'
                    }
                });

                if (response) break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!response || !parsedUrl) {
            throw lastError || new Error('Unable to fetch image');
        }

        const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
            console.log('⚠️ تم رفض رابط لأن المحتوى ليس صورة');
            return null;
        }

        const fileName = getImageNameFromUrl(parsedUrl.toString());
        return new AttachmentBuilder(Buffer.from(response.data), { name: fileName });
    } catch (error) {
        console.log(`⚠️ تعذر تحميل صورة المسؤوليات كرابط مرفق: ${error.message}`);
        return null;
    }
}

// متغير لتخزين رسائل الايمبد (دعم عدة سيرفرات)
let embedMessages = new Map(); // guildId -> { messageId, channelId, message }

// دالة لإنشاء الايمبد
function createResponsibilitiesEmbed(responsibilities) {
    const embed = colorManager.createEmbed()
        .setTitle('Responsibilities');
    
    const normalizedInput = normalizeResponsibilitiesMap(responsibilities);
    const currentResps = Object.keys(normalizedInput).length > 0 ? normalizedInput : getCurrentResponsibilities();
    const categories = readJSONFile(DATA_FILES.categories, {});
    
    if (Object.keys(currentResps).length === 0 && Object.keys(categories).length === 0) {
        embed.setDescription('لا توجد مسؤوليات محددة حالياً');
        return embed;
    }
    
    let description = '';
    
    if (Object.keys(categories).length > 0) {
        const sortedCategories = Object.entries(categories).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
        
        for (const [catName, catData] of sortedCategories) {
            description += `\n**# ${catName} Category**\n\n`;    
            const categoryResps = catData.responsibilities || [];
            
            if (categoryResps.length === 0) {
                description += `*No Res*\n\n`;
            } else {
                for (const respName of categoryResps) {
                    const respData = currentResps[respName];
                    if (respData) {
                        description += `** المسؤوليه : ال${respName}**\n`;
                        
                        if (respData.responsibles && respData.responsibles.length > 0) {
                            const responsiblesList = respData.responsibles.map(id => `<@${id}>`).join(' , ');
                            description += `- **المسؤولين : ${responsiblesList}**\n\n`;
                        } else {
                            description += `- ** المسؤولين : N/A **\n\n`;
                        }
                    }
                }
            }
        }
        
        const uncategorizedResps = Object.keys(currentResps).filter(respName => {
            return !sortedCategories.some(([_, catData]) => 
                catData.responsibilities && catData.responsibilities.includes(respName)
            );
        });
        
        if (uncategorizedResps.length > 0) {
            description += `\n**# No categories**\n\n`;
            
            for (const respName of uncategorizedResps) {
                const respData = currentResps[respName];
                description += `**المسؤوليه : ال${respName}**\n`;
                
                if (respData.responsibles && respData.responsibles.length > 0) {
                    const responsiblesList = respData.responsibles.map(id => `<@${id}>`).join(' , ');
                    description += `- **المسؤولين : ${responsiblesList}**\n\n`;
                } else {
                    description += `- ** المسؤولين : N/A **\n\n`;
                }
            }
        }
    } else {
        const sortedKeys = Object.keys(currentResps).sort((a, b) => (currentResps[a].order || 0) - (currentResps[b].order || 0));
        for (const respName of sortedKeys) {
            const respData = currentResps[respName];
            description += `**المسؤوليه : ال${respName}**\n`;
            
            if (respData.responsibles && respData.responsibles.length > 0) {
                const responsiblesList = respData.responsibles.map(id => `<@${id}>`).join(' , ');
                description += `- **المسؤولين : ${responsiblesList}**\n\n`;
            } else {
                description += `- ** المسؤولين : N/A **\n\n`;
            }
        }
    }
    
    embed.setDescription(description);
    return embed;
}

// دالة لإنشاء رسالة نصية للمسؤوليات
function createResponsibilitiesText(responsibilities) {
    const normalizedInput = normalizeResponsibilitiesMap(responsibilities);
    const currentResps = Object.keys(normalizedInput).length > 0 ? normalizedInput : getCurrentResponsibilities();
    const categories = readJSONFile(DATA_FILES.categories, {});
    
    if (Object.keys(currentResps).length === 0 && Object.keys(categories).length === 0) {
        return '**Responsibilities**\n\nلا توجد مسؤوليات محددة حالياً';
    }
    let text = '**Responsibilities**\n';
    
    if (Object.keys(categories).length > 0) {
        const sortedCategories = Object.entries(categories).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
        
        for (const [catName, catData] of sortedCategories) {
            text += `\n**# ${catName} Category**\n\n`;    
            const categoryResps = catData.responsibilities || [];
            
            if (categoryResps.length === 0) {
                text += `*No Res*\n\n`;
            } else {
                for (const respName of categoryResps) {
                    const respData = currentResps[respName];
                    if (respData) {
                        text += `**المسؤوليه : ال${respName}**\n`;
                        
                        if (respData.responsibles && respData.responsibles.length > 0) {
                            const responsiblesList = respData.responsibles.map(id => `<@${id}>`).join(' , ');
                            text += `- **المسؤولين : ${responsiblesList}**\n\n`;
                        } else {
                            text += `- ** المسؤولين : N/A **\n\n`;
                        }
                    }
                }
            }
        }
        
        const uncategorizedResps = Object.keys(currentResps).filter(respName => {
            return !sortedCategories.some(([_, catData]) => 
                catData.responsibilities && catData.responsibilities.includes(respName)
            );
        });
        
        if (uncategorizedResps.length > 0) {
            text += `\n**# No categories**\n\n`;
            
            for (const respName of uncategorizedResps) {
                const respData = currentResps[respName];
                text += `**المسؤوليه : ال${respName}**\n`;
                
                if (respData.responsibles && respData.responsibles.length > 0) {
                    const responsiblesList = respData.responsibles.map(id => `<@${id}>`).join(' , ');
                    text += `- **المسؤولين  : ${responsiblesList}**\n\n`;
                } else {
                    text += `- **المسؤولين : N/A **\n\n`;
                }
            }
        }
    } else {
        const sortedKeys = Object.keys(currentResps).sort((a, b) => (currentResps[a].order || 0) - (currentResps[b].order || 0));
        for (const respName of sortedKeys) {
            const respData = currentResps[respName];
            text += `**المسؤوليه : ال${respName}**\n`;
            
            if (respData.responsibles && respData.responsibles.length > 0) {
                const responsiblesList = respData.responsibles.map(id => `<@${id}>`).join('  ,  ');
                text += `- **المسؤولين : ${responsiblesList}**\n\n`;
            } else {
                text += `- ** المسؤولين : N/A **\n\n`;
            }
        }
    }
    
    return text;
}
function splitText(text, maxLength = 2000) {

    const parts = [];

    let current = '';

    for (const line of text.split('\n')) {

        if ((current + line + '\n').length > maxLength) {

            parts.push(current);

            current = '';

        }

        current += line + '\n';

    }

    if (current.trim()) parts.push(current);

    return parts;

}

// دالة لإنشاء الأزرار والمنيو
function createSuggestionComponents() {
    const currentResps = getCurrentResponsibilities();
    const components = [];
    
    // إنشاء منيو المسؤوليات إذا وجدت
    if (Object.keys(currentResps).length > 0) {
        // ترتيب المسؤوليات حسب الـ order
        const sortedResps = Object.entries(currentResps)
            .sort((a, b) => (a[1].order || 0) - (b[1].order || 0))
            .slice(0, 25); // حد أقصى 25 خيار
        
        const options = sortedResps.map(([name, data]) => ({
            label: name.length > 100 ? name.slice(0, 97) + '...' : name,
            value: name.length > 100 ? name.slice(0, 100) : name
        }));
        
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('resp_info_select')
            .setPlaceholder('اختر مسؤولية لعرض تفاصيلها')
            .addOptions(options);
        
        const menuRow = new ActionRowBuilder().addComponents(selectMenu);
        components.push(menuRow);
    }
    
    // زر الاقتراحات وطلب المسؤولية
    const buttonRow = new ActionRowBuilder()
        .addComponents(
            applyEmojiSafely(
                new ButtonBuilder()
                    .setCustomId('suggestion_button')
                    .setLabel('أقتراح')
                    .setStyle(ButtonStyle.Secondary),
                '<:emoji_72:1442588665913151619>'
            ),
            applyEmojiSafely(
                new ButtonBuilder()
                    .setCustomId('apply_resp_button')
                    .setLabel('طلب مسؤولية')
                    .setStyle(ButtonStyle.Secondary),
                '<:emoji_19:1457493164826034186>'
            )
        );
    components.push(buttonRow);
    
    return components;
}

// دالة قديمة للتوافقية
function createSuggestionButton() {
    return createSuggestionComponents();
}

// دالة لتحديث رسائل الايمبد (كل السيرفرات أو سيرفر محدد)
async function updateEmbedMessage(client, targetGuildId = null) {
    try {
        const { dbManager } = require('../utils/database.js');
        const responsibilities = await dbManager.getResponsibilities();
        if (responsibilities && Object.keys(responsibilities).length > 0) {
            global.responsibilities = normalizeResponsibilitiesMap(responsibilities);
        }
        
        const newEmbed = createResponsibilitiesEmbed(responsibilities);
        const newText = createResponsibilitiesText(responsibilities);
        const components = createSuggestionComponents();
        
        // فحص وجود صورة لنظام المسؤوليات في السيرفر
        const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });

        const entries = targetGuildId
            ? (embedMessages.has(targetGuildId) ? [[targetGuildId, embedMessages.get(targetGuildId)]] : [])
            : [...embedMessages.entries()];

        for (const [guildId, embedData] of entries) {
            try {
                const guildConfig = config.guilds?.[guildId] || {};
                const globalImageUrl = guildConfig.globalImageUrl;
                const format = guildConfig.messageFormat || embedData.format || 'embed';

                const imageAttachment = globalImageUrl ? await createImageAttachment(globalImageUrl) : null;
                const imageFiles = imageAttachment ? [imageAttachment] : [];

                let editOptions;
                if (format === 'text') {
                    editOptions = {
                        content: newText,
                        embeds: [],
                        components: components,
                        files: imageFiles
                    };
                } else {
                    const embedForGuild = EmbedBuilder.from(newEmbed);
                    if (imageAttachment) {
                        embedForGuild.setImage(`attachment://${imageAttachment.name}`);
                    } else if (globalImageUrl) {
                        embedForGuild.setImage(globalImageUrl);
                    }

                    editOptions = {
                        content: null,
                        embeds: [embedForGuild],
                        components: components,
                        files: imageFiles
                    };
                }
                
                // جلب الرسالة إذا لم تكن موجودة في الذاكرة
                let message = embedData.message;
                if (!message && embedData.messageId && embedData.channelId) {
                    const channel = await client.channels.fetch(embedData.channelId).catch(() => null);
                    if (channel) {
                        message = await channel.messages.fetch(embedData.messageId).catch(() => null);
                    }
                }

                if (message) {
                    try {
                        await message.edit(editOptions);
                        embedData.message = message;
                        console.log(`✅ تم تحديث رسالة المسؤوليات في السيرفر ${guildId} (${format})`);
                    } catch (editError) {
                        console.error(`❌ فشل تعديل الرسالة في السيرفر ${guildId}:`, editError);
                        // إذا كانت الرسالة محذوفة، يفضل إرسال واحدة جديدة أو تنبيه المالك
                    }
                } else {
                    const fallbackCandidates = [
                        config.guilds?.[guildId]?.embedChannel,
                        embedData.channelId
                    ].filter(Boolean);

                    let fallbackChannel = null;
                    for (const candidateId of fallbackCandidates) {
                        const candidate = await client.channels.fetch(candidateId).catch(() => null);
                        if (candidate && candidate.isTextBased()) {
                            fallbackChannel = candidate;
                            break;
                        }
                    }

                    if (fallbackChannel) {
                        const sendOptions = { ...editOptions };
                        if (sendOptions.content === null) delete sendOptions.content;

                        const newMessage = await fallbackChannel.send(sendOptions);
                        embedMessages.set(guildId, {
                            messageId: newMessage.id,
                            channelId: fallbackChannel.id,
                            message: newMessage,
                            format
                        });
                        updateStoredEmbedData(guildId);
                        console.log(`✅ تم إنشاء رسالة مسؤوليات جديدة تلقائياً في السيرفر ${guildId}`);
                    } else {
                        console.log(`⚠️ لم يتم العثور على رسالة المسؤوليات أو القناة الاحتياطية في السيرفر ${guildId}`);
                    }
                }
            } catch (error) {
                console.error(`خطأ في تحديث رسالة المسؤوليات للسيرفر ${guildId}:`, error);
            }
        }
    } catch (error) {
        console.error('خطأ في جلب المسؤوليات من قاعدة البيانات:', error);
    }
}

// دالة للتعامل مع زر الاقتراحات
async function handleSuggestionButton(interaction, client) {
    try {
        const modal = new ModalBuilder()
            .setCustomId('suggestion_modal')
            .setTitle('اقتراح جديد');

        const suggestionInput = new TextInputBuilder()
            .setCustomId('suggestion_text')
            .setLabel('اقتراحك')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('اكتب اقتراحك هنا...')
            .setRequired(true);

        const actionRow = new ActionRowBuilder().addComponents(suggestionInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
    } catch (error) {
        console.error('خطأ في عرض مودال الاقتراح:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'حدث خطأ في عرض نموذج الاقتراح',
                ephemeral: true
            });
        }
    }
}

// دالة للتعامل مع مودال الاقتراح
async function handleSuggestionModal(interaction, client) {
    try {
        const suggestionText = interaction.fields.getTextInputValue('suggestion_text');
        const guildId = interaction.guild.id;
        
        // قراءة الكونفيغ مباشرة من الملف
        const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
        
        if (!config.guilds[guildId] || !config.guilds[guildId].suggestionsChannel) {
            await interaction.reply({
                content: 'لم يتم تحديد روم الاقتراحات بعد',
                ephemeral: true
            });
            return;
        }
        
        const channel = await client.channels.fetch(config.guilds[guildId].suggestionsChannel);
        
        // تأكيد أن القناة تنتمي لنفس السيرفر
        if (!channel || channel.guild.id !== guildId) {
            await interaction.reply({
                content: 'روم الاقتراحات غير موجود أو غير صحيح',
                ephemeral: true
            });
            return;
        }
        
        // إنشاء إيمبد الاقتراح بتنسيق محسن
        const suggestionEmbed = colorManager.createEmbed()
            .setTitle('Suggest')
            .setDescription(`**اقتراح من :** <@${interaction.user.id}>\n\n**الاقتراح :**\n${suggestionText}`)
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp()
            .setFooter({ text: `اي دي المقترح : ${interaction.user.id}` });
        
        await channel.send({ embeds: [suggestionEmbed] });
        
        await interaction.reply({
            content: 'Done ✅️',
            ephemeral: true
        });
        
    } catch (error) {
        console.error('خطأ في إرسال الاقتراح:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'حدث خطأ في إرسال الاقتراح',
                ephemeral: true
            });
        }
    }
}

// دالة للتعامل مع اختيار مسؤولية من المنيو
async function handleResponsibilitySelect(interaction, client) {
    try {
        // فحص حالة التفاعل قبل البدء
        if (interaction.replied || interaction.deferred) return;

        // Defer immediately to prevent "Unknown Interaction" error
        await interaction.deferReply({ ephemeral: true });
        
        const selectedResp = interaction.values[0];
        const currentResps = getCurrentResponsibilities();
        const rejectedCooldown = getActiveRejectedApplyCooldown(interaction.guild.id, interaction.user.id, selectedResp);
        if (rejectedCooldown) {
            return await interaction.editReply({
                content: `⏳ **تم رفضك سابقًا على "${selectedResp}". يمكنك التقديم مرة أخرى بعد ${formatRemainingTimeFromMs(rejectedCooldown.timeLeft)}.**`
            });
        }
        
        if (!currentResps[selectedResp]) {
            await interaction.editReply({
                content: '**المسؤولية غير موجودة!**'
            });
            return;
        }
        
        const respData = currentResps[selectedResp];
        
        // إنشاء إيمبد منظم
        const embed = colorManager.createEmbed()
            .setTitle(`معلومات المسؤولية : ${selectedResp}`)
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 128 }))
            .setTimestamp()
            .setFooter({ text: `طلب بواسطة : ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) });

        // إضافة الصورة للمسؤولية إذا وجدت
        const resolvedImageUrl = resolveResponsibilityImageUrl(interaction.guild.id, respData);
        if (resolvedImageUrl) {
            embed.setImage(resolvedImageUrl);
        }
        
        // إضافة الحقول
        let fields = [];
        
        // حقل الاختصار
        if (respData.mentShortcut) {
            const prefix = respData.mentPrefix || '-';
            fields.push({
                name: ' الاختصار',
                value: `\`${prefix}${respData.mentShortcut}\``,
                inline: true
            });
        }
        
        // حقل للأدمن فقط
        if (respData.mentShortcut) {
            fields.push({
                name: 'الاختصار للادمن بس؟',
                value: respData.mentAdminOnly ? 'نعم' : 'لا',
                inline: true
            });
        }
        
        // حقل الشرح - مع دعم الأوصاف الطويلة
        if (respData.description && respData.description.trim()) {
            const desc = respData.description;
            const maxFieldLength = 1024;
            
            if (desc.length > maxFieldLength) {
                // تقسيم الشرح الطويل إلى عدة حقول
                let descriptionParts = [];
                let currentPart = '';
                const words = desc.split(' ');
                
                for (const word of words) {
                    if ((currentPart + ' ' + word).length > maxFieldLength) {
                        if (currentPart) descriptionParts.push(currentPart);
                        currentPart = word;
                    } else {
                        currentPart += (currentPart ? ' ' : '') + word;
                    }
                }
                if (currentPart) descriptionParts.push(currentPart);
                
                // إضافة كل جزء كـ field منفصل
                descriptionParts.forEach((part, index) => {
                    fields.push({
                        name: index === 0 ? 'شرح المسؤوليه' : `شرح المسؤوليه (${index + 1})`,
                        value: part,
                        inline: false
                    });
                });
            } else {
                fields.push({
                    name: 'شرح المسؤوليه',
                    value: desc,
                    inline: false
                });
            }
        }
        
        // حقل المسؤولين - مع تحسين التعامل مع الأعداد الكبيرة
        if (respData.responsibles && respData.responsibles.length > 0) {
            // عرض أول 10 مسؤولين فقط إذا كان العدد كبير
            const maxResponsibles = 10;
            const responsibleSlice = respData.responsibles.slice(0, maxResponsibles);
            let responsiblesList = responsibleSlice.map((id, index) => `${index + 1}. <@${id}>`).join('\n');
            
            // إذا كان هناك أكثر من 10، أضف ملاحظة
            if (respData.responsibles.length > maxResponsibles) {
                responsiblesList += `\n\n**+${respData.responsibles.length - maxResponsibles} آخرين**`;
            }
            
            // تأكد من أن الـ value لا يتجاوز 1024 حرف
            if (responsiblesList.length > 1024) {
                responsiblesList = responsiblesList.slice(0, 1000) + '\n**...(انظر المزيد)**';
            }
            
            fields.push({
                name: ` المسؤولين : (${respData.responsibles.length})`,
                value: responsiblesList,
                inline: false
            });
        } else {
            fields.push({
                name: ' المسؤولين',
                value: 'لا يوجد مسؤولين معينين',
                inline: false
            });
        }
        
        // إضافة الحقول للإيمبد
        if (fields.length > 0) {
            embed.addFields(fields);
        }
        
        await interaction.editReply({
            embeds: [embed]
        });
        
    } catch (error) {
        console.error('خطأ في عرض معلومات المسؤولية:', error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: 'حدث خطأ في عرض معلومات المسؤولية',
                    ephemeral: true
                });
            } else {
                await interaction.editReply({
                    content: 'حدث خطأ في عرض معلومات المسؤولية'
                });
            }
        } catch (replyError) {
            console.error('فشل في الرد على الـ interaction:', replyError);
        }
    }
}

// دالة للتعامل مع زر طلب المسؤولية
async function handleApplyRespButton(interaction, client) {
    try {
        if (interaction.replied || interaction.deferred) return;

        // التحقق من الكولداون
        const cooldownMs = getRespApplyCooldownMs(interaction.guild.id);
        const cooldownKey = `${interaction.guild.id}:${interaction.user.id}`;
        const lastApply = applyCooldowns.get(cooldownKey);
        if (cooldownMs && lastApply) {
            const timeLeft = lastApply + cooldownMs - Date.now();
            if (timeLeft > 0) {
                return await interaction.reply({
                    content: `⏳ **يجب عليك الانتظار ${formatRemainingTimeFromMs(timeLeft)} قبل تقديم طلب آخر أو اختيار مسؤولية أخرى.**`,
                    ephemeral: true
                });
            }
        }

        const currentResps = getCurrentResponsibilities();
        
        if (Object.keys(currentResps).length === 0) {
            return await interaction.reply({
                content: '**لا توجد مسؤوليات متاحة للتقديم عليها حالياً**',
                ephemeral: true
            });
        }

        const sortedResps = Object.entries(currentResps)
            .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
        const fullResponsibilities = getFullResponsibilities(interaction.guild.id);

        let page = 0;
        const pageSize = 25;
        const totalPages = Math.max(1, Math.ceil(sortedResps.length / pageSize));
        const token = `apply_picker_${interaction.user.id}_${Date.now()}`;

        const buildPayload = () => {
            const pageItems = sortedResps.slice(page * pageSize, page * pageSize + pageSize);
            const options = pageItems.map(([name, data]) => {
                const isAlreadyResponsible = data.responsibles && data.responsibles.includes(interaction.user.id);
                const isFull = fullResponsibilities.includes(name);
                return {
                    label: name.substring(0, 100),
                    value: name.substring(0, 100),
                    description: isAlreadyResponsible
                        ? 'أنت بالفعل مسؤول في هذه المسؤولية'
                        : isFull
                            ? 'مكتملة، لا يمكن التقديم حالياً'
                            : `عدد المسؤولين : ${data.responsibles ? data.responsibles.length : 0}`.substring(0, 100)
                };
            });

            return {
                content: `يرجى اختيار المسؤولية من القائمة أدناه :\n**صفحة ${page + 1}/${totalPages}**`,
                components: [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`apply_resp_select_${token}`)
                            .setPlaceholder('اختر المسؤولية التي تود التقديم عليها')
                            .addOptions(options)
                    ),
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`apply_resp_prev_${token}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                        new ButtonBuilder().setCustomId(`apply_resp_next_${token}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
                    )
                ]
            };
        };

        const pickerMessage = interaction.replied || interaction.deferred
            ? await interaction.editReply(buildPayload())
            : await interaction.reply({ ...buildPayload(), ephemeral: true, fetchReply: true });

        const targetMessage = pickerMessage?.awaitMessageComponent ? pickerMessage : await interaction.fetchReply();
        const pickerCollector = targetMessage.createMessageComponentCollector({
            filter: (i) => i.user.id === interaction.user.id && i.customId.includes(token),
            time: 10 * 60 * 1000
        });

        pickerCollector.on('collect', async (pickInteraction) => {
            if (pickInteraction.customId === `apply_resp_select_${token}`) {
                const selectedResp = pickInteraction.values[0];
                pickerCollector.stop('selected');
                await pickInteraction.showModal(
                    new ModalBuilder()
                        .setCustomId(`apply_resp_modal_${selectedResp}`)
                        .setTitle(`تقديم طلب مسؤولية : ${selectedResp}`)
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('apply_reason')
                                    .setLabel('لماذا تود الحصول على هذه المسؤولية؟')
                                    .setStyle(TextInputStyle.Paragraph)
                                    .setPlaceholder('اكتب أسبابك وخبراتك هنا...')
                                    .setRequired(true)
                            )
                        )
                );
                return;
            }

            if (pickInteraction.customId === `apply_resp_prev_${token}`) {
                page = Math.max(0, page - 1);
                await pickInteraction.update(buildPayload()).catch(() => {});
                return;
            }
            if (pickInteraction.customId === `apply_resp_next_${token}`) {
                page = Math.min(totalPages - 1, page + 1);
                await pickInteraction.update(buildPayload()).catch(() => {});
            }
        });

        pickerCollector.on('end', async () => {
            const disabledComponents = buildDisabledComponents(targetMessage.components || []);
            if (!disabledComponents.length) return;
            await targetMessage.edit({
                components: disabledComponents
            }).catch(() => {});
        });
    } catch (error) {
        console.error('Error in handleApplyRespButton:', error);
    }
}

// دالة للتعامل مع اختيار المسؤولية للتقديم
async function handleApplyRespSelect(interaction, client) {
    try {
        if (interaction.replied || interaction.deferred) return;

        // التحقق من الكولداون
        const cooldownMs = getRespApplyCooldownMs(interaction.guild.id);
        const cooldownKey = `${interaction.guild.id}:${interaction.user.id}`;
        const lastApply = applyCooldowns.get(cooldownKey);
        if (cooldownMs && lastApply) {
            const timeLeft = lastApply + cooldownMs - Date.now();
            if (timeLeft > 0) {
                return await interaction.reply({
                    content: `⏳ **يجب عليك الانتظار ${formatRemainingTimeFromMs(timeLeft)} قبل تقديم طلب آخر أو اختيار مسؤولية أخرى.**`,
                    ephemeral: true
                });
            }
        }

        const selectedResp = interaction.values[0];
        const currentResps = getCurrentResponsibilities();
        const rejectedCooldown = getActiveRejectedApplyCooldown(interaction.guild.id, interaction.user.id, selectedResp);
        if (rejectedCooldown) {
            return await interaction.reply({
                content: `⏳ **تم رفضك سابقًا على "${selectedResp}". يمكنك التقديم مرة أخرى بعد ${formatRemainingTimeFromMs(rejectedCooldown.timeLeft)}.**`,
                ephemeral: true
            });
        }

        if (isResponsibilityFull(interaction.guild.id, selectedResp)) {
            return await interaction.reply({
                content: `❌ **عدد المسؤولين مكتمل في "${selectedResp}"، لا يمكنك التقديم على هذه المسؤولية حالياً.**`,
                ephemeral: true
            });
        }

        const restrictions = getRespRoleRestrictions(interaction.guild.id);
        const requiredRoleIds = Array.isArray(restrictions[selectedResp]) ? restrictions[selectedResp] : [];
        if (requiredRoleIds.length > 0) {
            const hasAccessRole = interaction.member?.roles?.cache
                ? requiredRoleIds.some((roleId) => interaction.member.roles.cache.has(roleId))
                : false;
            if (!hasAccessRole) {
                return await interaction.reply({
                    content: `❌ **لا يمكنك التقديم على "${selectedResp}" إلا إذا كنت تحمل أحد الرولات المسموحة.**`,
                    ephemeral: true
                });
            }
        }

        // التحقق من أن العضو ليس مسؤولاً بالفعل في هذه المسؤولية
        if (currentResps[selectedResp] && currentResps[selectedResp].responsibles && currentResps[selectedResp].responsibles.includes(interaction.user.id)) {
            return await interaction.reply({
                content: `❌ **أنت بالفعل مسؤول في "${selectedResp}" ولا يمكنك التقديم عليها مرة أخرى.**`,
                ephemeral: true
            });
        }
        
        const modal = new ModalBuilder()
            .setCustomId(`apply_resp_modal_${selectedResp}`)
            .setTitle(`تقديم طلب مسؤولية : ${selectedResp}`);

        const reasonInput = new TextInputBuilder()
            .setCustomId('apply_reason')
            .setLabel('لماذا تود الحصول على هذه المسؤولية؟')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('اكتب أسبابك وخبراتك هنا...')
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
    } catch (error) {
        console.error('Error in handleApplyRespSelect:', error);
    }
}

// دالة للتعامل مع مودال التقديم
async function handleApplyRespModal(interaction, client) {
    try {
        if (interaction.replied || interaction.deferred) return;

        // استخدام deferReply لتجنب خطأ Unknown Interaction
        await interaction.deferReply({ ephemeral: true });

        // التحقق من الكولداون
        const guildId = interaction.guild.id;
        const cooldownMs = getRespApplyCooldownMs(guildId);
        const cooldownKey = `${guildId}:${interaction.user.id}`;
        const lastApply = applyCooldowns.get(cooldownKey);
        if (cooldownMs && lastApply) {
            const timeLeft = lastApply + cooldownMs - Date.now();
            if (timeLeft > 0) {
                return await interaction.editReply({
                    content: `⏳ **يجب عليك الانتظار ${formatRemainingTimeFromMs(timeLeft)} قبل تقديم طلب آخر أو اختيار مسؤولية أخرى.**`
                });
            }
        }

        const respName = interaction.customId.replace('apply_resp_modal_', '');
        const reason = interaction.fields.getTextInputValue('apply_reason');
        const rejectedCooldown = getActiveRejectedApplyCooldown(guildId, interaction.user.id, respName);
        if (rejectedCooldown) {
            return await interaction.editReply({
                content: `⏳ **تم رفض طلبك سابقًا على "${respName}". انتظر ${formatRemainingTimeFromMs(rejectedCooldown.timeLeft)} قبل إعادة التقديم على نفس المسؤولية.**`
            });
        }
        
      
        const currentResps = getCurrentResponsibilities();

        if (isResponsibilityFull(guildId, respName)) {
            return await interaction.editReply({
                content: `❌ **عدد المسؤولين مكتمل في "${respName}"، لا يمكنك التقديم على هذه المسؤولية حالياً.**`
            });
        }

        const restrictions = getRespRoleRestrictions(guildId);
        const requiredRoleIds = Array.isArray(restrictions[respName]) ? restrictions[respName] : [];
        if (requiredRoleIds.length > 0) {
            const hasAccessRole = interaction.member?.roles?.cache
                ? requiredRoleIds.some((roleId) => interaction.member.roles.cache.has(roleId))
                : false;
            if (!hasAccessRole) {
                return await interaction.editReply({
                    content: `❌ **هذه المسؤولية مخصصة لرولات إدارية محددة فقط.**`
                });
            }
        }
        
        // التحقق من أن العضو ليس مسؤولاً بالفعل في هذه المسؤولية
        if (currentResps[respName] && currentResps[respName].responsibles && currentResps[respName].responsibles.includes(interaction.user.id)) {
            return await interaction.editReply({
                content: `❌ **أنت بالفعل مسؤول في "${respName}" ولا يمكنك التقديم عليها مرة أخرى.**`
            });
        }

        // التحقق من وجود طلب معلق لنفس المسؤولية
        const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
        const applyChannelId = config.guilds[guildId]?.applyChannel;
        
        if (applyChannelId) {
            try {
                const channel = await client.channels.fetch(applyChannelId).catch(() => null);
                if (channel) {
                    const messages = await channel.messages.fetch({ limit: 50 });
                    const pendingApply = messages.find(m => 
                        m.embeds.length > 0 && 
                        m.embeds[0].title === 'Apply Resp' &&
                        m.embeds[0].fields.some(f => f.name === 'المقدم' && f.value.includes(interaction.user.id)) &&
                        m.embeds[0].fields.some(f => f.name === 'المسؤولية' && f.value === respName) &&
                        m.components.length > 0 // الطلب لا يزال يحتاج قرار (أزرار موجودة)
                    );

                    if (pendingApply) {
                        return await interaction.editReply({
                            content: `⚠️ **لديك طلب معلق بالفعل لمسؤولية "${respName}"، يرجى انتظار رد الإدارة.**`
                        });
                    }
                }
            } catch (error) {
                console.error('Error checking for pending applications:', error);
            }
        }

        if (!applyChannelId) {
            return await interaction.editReply({
                content: 'نظام الطلبات غير مفعل حالياً (لم يتم تحديد روم الطلبات)'
            });
        }

        const channel = await client.channels.fetch(applyChannelId).catch(() => null);
        if (!channel) {
            return await interaction.editReply({
                content: 'روم الطلبات غير موجود، يرجى التواصل مع الإدارة'
            });
        }

        const respData = currentResps[respName];
        const applyEmbed = colorManager.createEmbed()
            .setTitle('Apply Resp')
            .addFields([
                { name: 'المقدم', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'المسؤولية', value: respName, inline: true },
                { name: 'السبب/الخبرة', value: reason }
            ])
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            applyEmojiSafely(
                new ButtonBuilder()
                    .setCustomId(`approve_apply_${interaction.user.id}_${respName}`)
                    .setLabel('Accept?')
                    .setStyle(ButtonStyle.Secondary),
                '<:emoji_7:1465221394966253768>'
            ),
            applyEmojiSafely(
                new ButtonBuilder()
                    .setCustomId(`reject_apply_${interaction.user.id}_${respName}`)
                    .setLabel('Reject?')
                    .setStyle(ButtonStyle.Secondary),
                '<:emoji_7:1465221361839505622>'
            )
        );

        await channel.send({ embeds: [applyEmbed], components: [row] });

        // إرسال صورة المسؤولية بعد الإيمبد كمرفق فعلي (وليس رابط نصي)
        const defaultSeparator = 'https://cdn.discordapp.com/attachments/1446184605056106690/1447086623954173972/colors-5.png?ex=693657f0&is=69350670&hm=126e0ab559dc0a642e9672d1c0d1a3e62d10a704b14fa25c46460870b67d9682&';
        const separatorImageUrl = resolveResponsibilityImageUrl(guildId, respData) || defaultSeparator;
        const separatorAttachment = await createImageAttachment(separatorImageUrl);

        if (separatorAttachment) {
            await channel.send({ files: [separatorAttachment] }).catch(err => console.error('Failed to send separator image attachment:', err));
        } else {
            // fallback آمن: إذا تعذر جلب الصورة كمرفق نحاول إرسال الرابط مباشرة
            await channel.send({ content: separatorImageUrl }).catch(err => console.error('Failed to send separator image fallback URL:', err));
        }

        // تعيين الكولداون للمستخدم بعد إرسال الطلب بنجاح
        applyCooldowns.set(`${guildId}:${interaction.user.id}`, Date.now());
        
        await interaction.editReply({
            content: '*تم إرسال طلبك بنجاح، سيتم الرد عليك قريباً*'
        });
    } catch (error) {
        console.error('Error in handleApplyRespModal:', error);
    }
}

// دالة للتعامل مع أزرار القبول والرفض
async function handleApplyAction(interaction, client) {
    try {
        const isAllowed = isRespManager(interaction);

        if (!isAllowed) {
            return await interaction.reply({
                content: '❌ **مب مسؤول؟ شتبي اجل.**',
                ephemeral: true
            });
        }

        const [action, , userId, respName] = interaction.customId.split('_');
        const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
        
        if (action === 'approve') {
            if (interaction.replied || interaction.deferred) return;
            await interaction.deferUpdate();

            const currentResps = getCurrentResponsibilities();
            if (!currentResps[respName]) {
                return interaction.followUp({ content: 'المسؤولية لم تعد موجودة', ephemeral: true });
            }
            
            if (!currentResps[respName].responsibles) currentResps[respName].responsibles = [];
            if (!currentResps[respName].responsibles.includes(userId)) {
                currentResps[respName].responsibles.push(userId);
                const { dbManager } = require('../utils/database.js');
                await dbManager.updateResponsibility(respName, currentResps[respName]);
                
                // إضافة الرولات تلقائياً
                if (targetMember && currentResps[respName].roles) {
                    for (const roleId of currentResps[respName].roles) {
                        const role = interaction.guild.roles.cache.get(roleId);
                        if (role) {
                            await targetMember.roles.add(role).catch(err => console.error(`Failed to add responsibility role ${roleId}:`, err));
                        }
                    }
                }
                
                // إخطار المستخدم
                if (targetMember) {
                    const currentResps = getCurrentResponsibilities();
                    const respData = currentResps[respName];
                    
                    const approveEmbed = colorManager.createEmbed()
                        .setTitle('Accepted')
                        .setDescription(`** تم قبول طلبك لمسؤولية ال${respName}**\n\n ** في سيرفر ${interaction.guild.name}**`)
                        .setThumbnail(interaction.guild.iconURL({ dynamic: true }));
                    
                    const resolvedApproveImageUrl = resolveResponsibilityImageUrl(interaction.guild.id, respData);
                    if (resolvedApproveImageUrl) {
                        approveEmbed.setImage(resolvedApproveImageUrl);
                    }
                    
                    await targetMember.send({ embeds: [approveEmbed] }).catch(() => {});
                }
                
                // تحديث المتغير العالمي وإرسال إشارة التحديث
                // تحديث المتغير العالمي وإرسال إشارة التحديث
                if (global.client) {
                    global.client.emit('responsibilityUpdate');
                }
                
                const approvalEmbed = colorManager.createEmbed()
                    .setTitle('✅ Accepted')
                           .setDescription(`**المسؤول الجديد : <@${userId}>\nعلى مسؤولية : ال${respName}\n من مسؤول المسؤوليات : <@${interaction.user.id}>**`)
                    .setThumbnail(targetMember?.user.displayAvatarURL({ size: 128 }) || null)
                    .setTimestamp();

                await interaction.editReply({ 
                    content: '**R Sys;**',
                    embeds: [approvalEmbed],
                    files: [],
                    components: [] 
                });

                // تحديث رسالة المسؤوليات (resp setup) بجميع الأحوال
                try {
                    await updateEmbedMessage(client);
                } catch (updateError) {
                    console.error('Error updating embed message after approval:', updateError);
                }
            } else {
                await interaction.editReply({
                    content: `**⚠️ <@${userId}> مسؤول بالفعل في مسؤولية ال${respName}**`,
                    components: []
                });
            }
        } else if (action === 'reject') {
            const modal = new ModalBuilder()
                .setCustomId(`reject_reason_modal_${userId}_${respName}`)
                .setTitle('سبب الرفض');
            
            const reasonInput = new TextInputBuilder()
                .setCustomId('reject_reason')
                .setLabel('اذكر سبب الرفض')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);
            
            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
        }
    } catch (error) {
        console.error('Error in handleApplyAction:', error);
    }
}

// دالة للتعامل مع مودال سبب الرفض
async function handleRejectReasonModal(interaction, client) {
    try {
        const isAllowed = isRespManager(interaction);

        if (!isAllowed) {
            return await interaction.reply({
                content: '❌ **مب مسؤول؟ اجل دز.**',
                ephemeral: true
            });
        }

        const [, , , userId, respName] = interaction.customId.split('_');
        const reason = interaction.fields.getTextInputValue('reject_reason');
        const rejectCooldownMs = getRespRejectCooldownMs(interaction.guild.id);
        
        if (interaction.replied || interaction.deferred) return;
        await interaction.deferReply({ ephemeral: true });

        const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
        
        if (targetMember) {
            const currentResps = getCurrentResponsibilities();
            const respData = currentResps[respName];
            
            const rejectEmbed = colorManager.createEmbed()
                .setTitle('Rejected')
                .setDescription(`**تم رفض طلبك لمسؤولية ال${respName}**\n\n ** في سيرفر ${interaction.guild.name}**\n\n**السبب للرفض :** ${reason}`)
                .setThumbnail(interaction.guild.iconURL({ dynamic: true }));
            
            const resolvedRejectImageUrl = resolveResponsibilityImageUrl(interaction.guild.id, respData);
            if (resolvedRejectImageUrl) {
                rejectEmbed.setImage(resolvedRejectImageUrl);
            }
            
            await targetMember.send({ embeds: [rejectEmbed] }).catch(() => {});
        }

        if (rejectCooldownMs && userId && respName) {
            setRejectedApplyCooldown(interaction.guild.id, userId, respName, rejectCooldownMs);
        }
        
        const rejectResponseEmbed = colorManager.createEmbed()
            .setTitle('❌ Rejected')
            .setDescription(`**الإداري المقدم : <@${userId}>\n المسؤوليه :  ال${respName}\n من مسؤول المسؤوليات : <@${interaction.user.id}>\nالسبب : ${reason}**`)
            .setThumbnail(targetMember?.user.displayAvatarURL({ size: 128 }) || null)
            .setTimestamp();

        await interaction.editReply({ 
            content: '**R Sys;**',
            embeds: [rejectResponseEmbed],
            files: []
        });
        // محاولة تعديل الرسالة الأصلية في قناة الطلبات
        if (interaction.message) {
            const rejectPublicEmbed = colorManager.createEmbed()
                .setTitle('❌ Rejected')
                .setDescription(`**الإداري المقدم : <@${userId}>\n المسؤوليه :  ال${respName}\n من مسؤول المسؤوليات : <@${interaction.user.id}>\nالسبب : ${reason}**`)
                .setThumbnail(targetMember?.user.displayAvatarURL({ size: 128 }) || null)
                .setTimestamp();

            await interaction.message.edit({ 
                content: '',
                embeds: [rejectPublicEmbed],
                files: [],
                components: [] 
            }).catch(() => {});
        }
    } catch (error) {
        console.error('Error in handleRejectReasonModal:', error);
    }
}

module.exports = {
    name: 'resp',
    description: 'عرض المسؤوليات وإعداد نظام الاقتراحات والطلبات',
    handleApplyRespButton,
    handleApplyRespSelect,
    handleApplyRespModal,
    handleApplyAction,
    handleRejectReasonModal,
    
    // تهيئة النظام عند بدء التشغيل
    initialize(client) {
        loadEmbedData(client);
    },
    
    async execute(message, args, context) {
        const { client } = context;

        const botConfig = readJSONFile(getBotConfigPath(), {});
        const BOT_OWNERS = botConfig.owners || [];
        const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;

        if (!isOwner) {
            await message.react('❌');
            return;
        }

        const guildId = message.guild.id;
        const createPanelEmbed = () => {
            const guildRespConfig = getGuildRespConfig(guildId);
            const guildCfg = guildRespConfig.guilds[guildId] || {};
            const currentResps = getCurrentResponsibilities();
            const currentRestrictions = getRespRoleRestrictions(guildId);
            const currentManagers = getRespManagers(guildId);
            const currentFull = Array.isArray(guildCfg.fullResponsibilities) ? guildCfg.fullResponsibilities : [];
            const cooldownMsNow = getRespApplyCooldownMs(guildId);
            const cooldownText = cooldownMsNow ? formatMinutesArabic(Math.round(cooldownMsNow / 60000)) : 'مغلق';
            const rejectCooldownMsNow = getRespRejectCooldownMs(guildId);
            const rejectCooldownText = rejectCooldownMsNow ? formatMinutesArabic(Math.round(rejectCooldownMsNow / 60000)) : 'مغلق';
            const formatText = guildCfg.messageFormat || 'embed';
            const suggestionsChannelText = guildCfg.suggestionsChannel ? `<#${guildCfg.suggestionsChannel}>` : 'غير محدد';
            const embedChannelText = guildCfg.embedChannel ? `<#${guildCfg.embedChannel}>` : 'غير محدد';
            const applyChannelText = guildCfg.applyChannel ? `<#${guildCfg.applyChannel}>` : 'غير محدد';
            const globalImageText = guildCfg.globalImageUrl ? 'موجودة ✅' : 'غير محددة';

            return colorManager.createEmbed()
                .setTitle('**Resp Control Panel**')
                .setThumbnail(message.guild.iconURL({ dynamic: true }))
                .setDescription([
                    '* *Responsibilities Setup*',
                    '',
                    '**⚙️ Setup** — إعداد الرومات + نوع الرسالة',
                    `> **Suggestions : ${suggestionsChannelText}**`,
                    `> **Embed Room : ${embedChannelText}**`,
                    `> **Format : ${formatText}**`,
                    '',
                    '**💬 Apply Room** — تحديد روم التقديم',
                    `> **Current : ${applyChannelText}**`,
                    '',
                    '**🖼️ Image** — صورة مسؤولية أو الجميع',
                    `> **Global Image : ${globalImageText}**`,
                    `> **Responsibilities with image : ${Object.values(currentResps).filter((r) => r?.image).length}/${Object.keys(currentResps).length}**`,
                    '',
                    '**✅ Full Slots** — المسؤوليات المكتملة',
                    `> **Count : ${currentFull.length}**`,
                    '',
                    '**🔐 Access Roles** — رولات مسموح لها بالتقديم على مسؤولية',
                    `> **Restricted responsibilities : ${Object.keys(currentRestrictions).length}**`,
                    '',
                    '**👥 Resp Managers** — من يستطيع تشغيل Resp وقبول/رفض الطلبات',
                    `> **Roles : ${currentManagers.roleIds.length} | Users : ${currentManagers.userIds.length}**`,
                    '',
                    '**⏱️ Cooldown** — تخصيص/إيقاف كولداون التقديم + كولداون الرفض',
                    `> **Current : ${cooldownText}**`,
                    '',
                    '**🚫 Reject Cooldown** — كولداون إعادة التقديم بعد الرفض (نفس المسؤولية)',
                    `> **Current : ${rejectCooldownText}**`,
                    '',
                    '**🧹 Clear Resps** —  ازالة جميع المسؤولين'
                ].join('\n'));
        };

        const panelRow1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`resp_panel_setup_${message.id}`).setLabel('Setup').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`resp_panel_chat_${message.id}`).setLabel('Apply Room').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`resp_panel_img_${message.id}`).setLabel('Image').setStyle(ButtonStyle.Secondary)
        );

        const panelRow2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`resp_panel_full_${message.id}`).setLabel('Full Slots').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`resp_panel_access_${message.id}`).setLabel('Access Roles').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`resp_panel_cooldown_${message.id}`).setLabel('Cooldown').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`resp_panel_managers_${message.id}`).setLabel('Resp Managers').setStyle(ButtonStyle.Primary).setDisabled(!isOwner)
        );

        const panelRow3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`resp_panel_clear_${message.id}`).setLabel('Clear Resps').setStyle(ButtonStyle.Danger)
        );

        const panelMessage = await message.reply({ embeds: [createPanelEmbed()], components: [panelRow1, panelRow2, panelRow3] });
        const refreshPanelMessage = async () => {
            await panelMessage.edit({ embeds: [createPanelEmbed()], components: [panelRow1, panelRow2, panelRow3] }).catch(() => {});
        };

        const buildRestrictionsPreview = () => {
            const restrictions = getRespRoleRestrictions(guildId);
            const entries = Object.entries(restrictions);
            if (!entries.length) return '**لا توجد تقييدات حالياً.**';

            return entries
                .slice(0, 15)
                .map(([respName, roleIds]) => {
                    const rolesText = Array.isArray(roleIds) && roleIds.length
                        ? roleIds.map((id) => `<@&${id}>`).join(' ')
                        : '**غير محدد**';
                    return `• **${respName}** → ${rolesText}`;
                })
                .join('\n');
        };

        const requireNonEmptyResponsibilities = async (interactionLike) => {
            const currentResps = getCurrentResponsibilities();
            if (!Object.keys(currentResps).length) {
                await interactionLike.reply({ content: '**❌ لا توجد مسؤوليات حالياً.**', ephemeral: true }).catch(() => {});
                return null;
            }
            return currentResps;
        };

        const createSessionToken = (prefix = 'resp') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

        const confirmEphemeralAction = async (interaction, summaryText) => {
            const token = createSessionToken('confirm');
            const payload = {
                content: `${summaryText}\n\n**هل تريد التأكيد؟**`,
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`resp_confirm_yes_${token}`).setLabel('تأكيد').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`resp_confirm_no_${token}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
                    )
                ],
                ephemeral: true,
                fetchReply: true
            };

            const replyMsg = interaction.replied || interaction.deferred
                ? await interaction.followUp(payload)
                : await interaction.reply(payload);

            const picked = await replyMsg.awaitMessageComponent({
                filter: (i) => i.user.id === message.author.id && [
                    `resp_confirm_yes_${token}`,
                    `resp_confirm_no_${token}`
                ].includes(i.customId),
                time: 120000
            }).catch(() => null);

            if (!picked) return false;
            if (picked.customId.endsWith(`no_${token}`)) {
                await picked.update({ content: '**❌ تم إلغاء العملية.**', components: [] }).catch(() => {});
                return false;
            }

            await picked.update({ content: '**✅ تم التأكيد. جاري التنفيذ...**', components: [] }).catch(() => {});
            return true;
        };

        const pickResponsibilityWithPagination = async (interaction, titleText, includeAll = false, acknowledgeOnSelect = true) => {
            const currentResps = await requireNonEmptyResponsibilities(interaction);
            if (!currentResps) return null;

            const names = Object.keys(currentResps);
            let page = 0;
            const pageSize = 25;
            const totalPages = Math.max(1, Math.ceil(names.length / pageSize));
            const token = createSessionToken('resp_pick');

            const buildPayload = () => {
                const start = page * pageSize;
                const options = names.slice(start, start + pageSize).map((name) => ({
                    label: name.substring(0, 100),
                    value: name.substring(0, 100)
                }));

                if (includeAll && page === 0) {
                    options.unshift({ label: 'All responsibilities', value: '__all__', description: 'تطبيق على الجميع' });
                }

                return {
                    content: `${titleText}\n**صفحة ${page + 1}/${totalPages}**`,
                    components: [
                        new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`resp_pick_select_${token}`)
                                .setPlaceholder('Search responsibility')
                                .addOptions(options.slice(0, 25))
                        ),
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`resp_pick_prev_${token}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                            new ButtonBuilder().setCustomId(`resp_pick_next_${token}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
                        )
                    ]
                };
            };

            let pickerMessage = await interaction.reply({ ...buildPayload(), ephemeral: true, fetchReply: true });

            while (true) {
                const picked = await pickerMessage.awaitMessageComponent({
                    filter: (i) => i.user.id === message.author.id && i.customId.includes(token),
                    time: 120000
                }).catch(() => null);
                if (!picked) return null;

                if (picked.customId === `resp_pick_select_${token}`) {
                    const selectedValue = picked.values[0];
                    if (acknowledgeOnSelect) {
                        await picked.update({ content: `**✅ تم اختيار :** ${selectedValue === '__all__' ? 'all' : selectedValue}`, components: [] }).catch(() => {});
                    } else {
                        await picked.update({ components: [] }).catch(() => {});
                    }
                    return {
                        value: selectedValue === '__all__' ? 'all' : selectedValue,
                        sourceInteraction: picked
                    };
                }

                if (picked.customId === `resp_pick_prev_${token}`) {
                    page = Math.max(0, page - 1);
                    await picked.update(buildPayload()).catch(() => {});
                    continue;
                }
                if (picked.customId === `resp_pick_next_${token}`) {
                    page = Math.min(totalPages - 1, page + 1);
                    await picked.update(buildPayload()).catch(() => {});
                }
            }
        };

        const panelCollector = panelMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 10 * 60 * 1000,
            filter: (i) => i.user.id === message.author.id && i.customId.endsWith(message.id)
        });

        panelCollector.on('collect', async (interaction) => {
            try {
                if (interaction.customId.startsWith('resp_panel_managers_')) {
                    if (!isOwner) {
                        await interaction.reply({ content: '**❌ إعداد مسؤولي Resp للمالك فقط.**', ephemeral: true });
                        return;
                    }

                    const managerMessage = await interaction.reply({
                        content: '**حدد الرتب أو الأشخاص المسموح لهم بتشغيل Resp وقبول/رفض الطلبات.**\nيمكنك اختيار كل نوع بشكل مستقل، والتغييرات تحفظ فوراً.',
                        components: [
                            new ActionRowBuilder().addComponents(
                                new RoleSelectMenuBuilder()
                                    .setCustomId(`resp_manager_roles_${message.id}`)
                                    .setPlaceholder('اختر رتب المسؤولين')
                                    .setMinValues(0)
                                    .setMaxValues(10)
                            ),
                            new ActionRowBuilder().addComponents(
                                new UserSelectMenuBuilder()
                                    .setCustomId(`resp_manager_users_${message.id}`)
                                    .setPlaceholder('اختر أشخاص المسؤولين')
                                    .setMinValues(0)
                                    .setMaxValues(25)
                            ),
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`resp_manager_clear_${message.id}`).setLabel('مسح الكل').setStyle(ButtonStyle.Danger),
                                new ButtonBuilder().setCustomId(`resp_manager_done_${message.id}`).setLabel('تم').setStyle(ButtonStyle.Success)
                            )
                        ],
                        ephemeral: true,
                        fetchReply: true
                    });

                    const managerFilter = (i) => i.user.id === message.author.id && i.customId.endsWith(message.id) && (
                        i.customId.startsWith('resp_manager_roles_') ||
                        i.customId.startsWith('resp_manager_users_') ||
                        i.customId.startsWith('resp_manager_clear_') ||
                        i.customId.startsWith('resp_manager_done_')
                    );
                    while (true) {
                        const managerPick = await managerMessage.awaitMessageComponent({ filter: managerFilter, time: 120000 }).catch(() => null);
                        if (!managerPick) return;

                        if (managerPick.customId.startsWith('resp_manager_roles_')) {
                            const managers = setRespManagers(guildId, { roleIds: managerPick.values, userIds: getRespManagers(guildId).userIds });
                            await managerPick.update({ content: `**✅ تم حفظ الرتب.**\nالرتب: ${managers.roleIds.length}\nالأشخاص: ${managers.userIds.length}`, components: managerMessage.components });
                        } else if (managerPick.customId.startsWith('resp_manager_users_')) {
                            const managers = setRespManagers(guildId, { roleIds: getRespManagers(guildId).roleIds, userIds: managerPick.values });
                            await managerPick.update({ content: `**✅ تم حفظ الأشخاص.**\nالرتب: ${managers.roleIds.length}\nالأشخاص: ${managers.userIds.length}`, components: managerMessage.components });
                        } else if (managerPick.customId.startsWith('resp_manager_clear_')) {
                            setRespManagers(guildId, { roleIds: [], userIds: [] });
                            await managerPick.update({ content: '**✅ تم مسح جميع مسؤولي Resp.**', components: [] });
                            break;
                        } else {
                            await managerPick.update({ content: '**✅ تم إنهاء إعداد مسؤولي Resp.**', components: [] });
                            break;
                        }
                    }
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_setup_')) {
                    const roomMsg = await interaction.reply({
                        content: '**اختر روم الاقتراحات ثم روم عرض المسؤوليات).**',
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ChannelSelectMenuBuilder()
                                    .setCustomId(`resp_setup_suggestions_${message.id}`)
                                    .setChannelTypes(ChannelType.GuildText)
                                    .setPlaceholder('اختر روم الاقتراحات')
                            ),
                            new ActionRowBuilder().addComponents(
                                new ChannelSelectMenuBuilder()
                                    .setCustomId(`resp_setup_embed_${message.id}`)
                                    .setChannelTypes(ChannelType.GuildText)
                                    .setPlaceholder('اختر روم عرض المسؤوليات')
                            )
                        ],
                        ephemeral: true,
                        fetchReply: true
                    });

                    let suggestionsChannel = null;
                    let embedChannel = null;
                    const setupIds = [
                        `resp_setup_suggestions_${message.id}`,
                        `resp_setup_embed_${message.id}`
                    ];

                    while (!suggestionsChannel || !embedChannel) {
                        const pick = await roomMsg.awaitMessageComponent({
                            filter: (i) => i.user.id === message.author.id && setupIds.includes(i.customId),
                            time: 120000
                        }).catch(() => null);
                        if (!pick) return;

                        const channel = pick.channels.first();
                        if (!channel || channel.guildId !== guildId) {
                            await pick.reply({ content: '**❌ اختر روم من نفس السيرفر.**', ephemeral: true }).catch(() => {});
                            return;
                        }

                        if (pick.customId === `resp_setup_suggestions_${message.id}`) {
                            suggestionsChannel = channel;
                        } else if (pick.customId === `resp_setup_embed_${message.id}`) {
                            embedChannel = channel;
                        }

                        const statusLines = [
                            `**روم الاقتراحات :** ${suggestionsChannel ? `<#${suggestionsChannel.id}>` : 'لم يتم التحديد بعد'}`,
                            `**روم عرض المسؤوليات :** ${embedChannel ? `<#${embedChannel.id}>` : 'لم يتم التحديد بعد'}`,
                            '',
                            suggestionsChannel && embedChannel
                                ? '**✅ تم اختيار الرومين، تابع لاختيار نوع الرسالة.**'
                                : '**اختر الروم المتبقي لإكمال الإعداد.**'
                        ];

                        await pick.update({ content: statusLines.join('\n') }).catch(() => {});
                    }

                    setGuildConfig(guildId, { suggestionsChannel: suggestionsChannel.id, embedChannel: embedChannel.id });

                    // الرسالة مؤقتة (ephemeral)، لذلك يجب تعديل رد التفاعل الأصلي
                    // عبر editReply بدل Message#edit حتى تظهر أزرار نوع الرسالة.
                    await interaction.editReply({
                        content: '**اختر نوع رسالة المسؤوليات :**',
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`resp_setup_fmt_embed_${message.id}`).setLabel('Embed').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`resp_setup_fmt_text_${message.id}`).setLabel('Text').setStyle(ButtonStyle.Secondary)
                            )
                        ]
                    });

                    const fmtPick = await roomMsg.awaitMessageComponent({
                        filter: (i) => i.user.id === message.author.id && [
                            `resp_setup_fmt_embed_${message.id}`,
                            `resp_setup_fmt_text_${message.id}`
                        ].includes(i.customId),
                        time: 120000
                    }).catch(() => null);
                    if (!fmtPick) return;

                    const format = fmtPick.customId.includes('_embed_') ? 'embed' : 'text';
                    setGuildConfig(guildId, { messageFormat: format });
                    await sendResponsibilitiesMessage(embedChannel, client, format);
                    appendRespAuditLog(guildId, message.author.id, 'resp.setup', {
                        suggestionsChannel: suggestionsChannel.id,
                        embedChannel: embedChannel.id,
                        format
                    });
                    await fmtPick.update({ content: `**✅ تم الإعداد بنجاح.**\n**نوع الرسالة :** ${format}`, components: [] });
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_chat_')) {
                    const selectMsg = await interaction.reply({
                        content: '**اختر روم طلبات المسؤولية :**',
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ChannelSelectMenuBuilder()
                                    .setCustomId(`resp_apply_room_${message.id}`)
                                    .setChannelTypes(ChannelType.GuildText)
                                    .setPlaceholder('Search/Select Apply Room')
                            )
                        ],
                        ephemeral: true,
                        fetchReply: true
                    });

                    const picked = await selectMsg.awaitMessageComponent({
                        filter: (i) => i.user.id === message.author.id && i.customId === `resp_apply_room_${message.id}`,
                        time: 120000
                    }).catch(() => null);
                    if (!picked) return;

                    const channel = picked.channels.first();
                    if (!channel || channel.guildId !== guildId) {
                        await picked.reply({ content: '**❌ اختر روم من نفس السيرفر.**', ephemeral: true }).catch(() => {});
                        return;
                    }
                    const configData = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
                    if (!configData.guilds[guildId]) configData.guilds[guildId] = {};
                    const previousApplyChannel = configData.guilds[guildId].applyChannel || null;
                    configData.guilds[guildId].applyChannel = channel.id;
                    writeJSONFile(DATA_FILES.respConfig, configData);
                    appendRespAuditLog(guildId, message.author.id, 'resp.applyChannel.update', {
                        before: previousApplyChannel,
                        after: channel.id
                    });
                    await picked.update({ content: `**✅ تم تحديد روم طلبات المسؤولية :** <#${channel.id}>`, components: [] });
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_img_')) {
                    const currentResps = await requireNonEmptyResponsibilities(interaction);
                    if (!currentResps) return;
                    const pickedResp = await pickResponsibilityWithPagination(interaction, '**اختر المسؤولية لتعيين الصورة :**', true, false);
                    if (!pickedResp) return;
                    const respName = pickedResp.value;
                    const latestConfig = getGuildRespConfig(guildId);
                    const guildImageConfig = latestConfig.guilds[guildId] || {};
                    const currentImageUrl = respName === 'all'
                        ? (normalizeImageUrl(guildImageConfig.globalImageUrl) || null)
                        : (resolveResponsibilityImageUrl(guildId, currentResps[respName]) || null);
                    const imageSession = createSessionToken('img_action');

                    const previewEmbed = colorManager.createEmbed()
                        .setTitle(`**Image Settings : ${respName === 'all' ? 'All responsibilities' : respName}**`)
                        .setDescription([
                            `**الصورة الحالية :** ${currentImageUrl || 'غير محددة'}`,
                            '',
                            '**اختر الإجراء:**',
                            '- **معاينة** : عرض الصورة الحالية فقط',
                            '- **تعديل** : إدخال رابط صورة جديدة'
                        ].join('\n'))
                        .setThumbnail(message.guild.iconURL({ dynamic: true }));

                    if (currentImageUrl && isValidImageUrl(currentImageUrl)) {
                        previewEmbed.setImage(currentImageUrl);
                    }

                    const actionMessage = await pickedResp.sourceInteraction.followUp({
                        embeds: [previewEmbed],
                        components: [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`resp_img_preview_${imageSession}`).setLabel('معاينة').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`resp_img_edit_${imageSession}`).setLabel('تعديل').setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder().setCustomId(`resp_img_cancel_${imageSession}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
                            )
                        ],
                        ephemeral: true,
                        fetchReply: true
                    });

                    const actionPick = await actionMessage.awaitMessageComponent({
                        filter: (i) => i.user.id === message.author.id && i.customId.includes(imageSession),
                        time: 120000
                    }).catch(() => null);
                    if (!actionPick) return;

                    if (actionPick.customId === `resp_img_cancel_${imageSession}`) {
                        await actionPick.update({ content: '**❌ تم إلغاء عملية الصورة.**', embeds: [], components: [] }).catch(() => {});
                        return;
                    }

                    if (actionPick.customId === `resp_img_preview_${imageSession}`) {
                        await actionPick.update({
                            content: currentImageUrl ? `**✅ هذه الصورة الحالية لـ ${respName === 'all' ? 'الكل' : respName}.**` : '**⚠️ لا توجد صورة حالية.**',
                            embeds: [previewEmbed],
                            components: []
                        }).catch(() => {});
                        return;
                    }

                    const imageEditSession = createSessionToken('img');
                    const modal = new ModalBuilder().setCustomId(`resp_img_modal_${imageEditSession}`).setTitle('تعيين صورة المسؤولية');
                    modal.addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('image_url').setLabel('رابط الصورة المباشر').setStyle(TextInputStyle.Short).setRequired(true)
                    ));
                    await actionPick.showModal(modal);

                    const submit = await actionPick.awaitModalSubmit({
                        filter: (i) => i.user.id === message.author.id && i.customId === `resp_img_modal_${imageEditSession}`,
                        time: 120000
                    }).catch(() => null);
                    if (!submit) return;
                    await disableMessageComponents(actionMessage);

                    const safeImageUrl = normalizeImageUrl(submit.fields.getTextInputValue('image_url').trim());
                    if (!isValidImageUrl(safeImageUrl)) {
                        await submit.reply({ content: '**❌ رابط صورة غير صالح.**', ephemeral: true });
                        return;
                    }

                    const { dbManager } = require('../utils/database.js');
                    if (respName === 'all') {
                        const confirmed = await confirmEphemeralAction(
                            submit,
                            `**سيتم تطبيق الصورة على جميع المسؤوليات (${Object.keys(currentResps).length}).**`
                        );
                        if (!confirmed) return;
                        for (const name of Object.keys(currentResps)) currentResps[name].image = safeImageUrl;
                        const configData = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
                        if (!configData.guilds[guildId]) configData.guilds[guildId] = {};
                        configData.guilds[guildId].globalImageUrl = safeImageUrl;
                        writeJSONFile(DATA_FILES.respConfig, configData);
                        writeJSONFile(DATA_FILES.responsibilities, currentResps);
                        global.responsibilities = currentResps;
                        try {
                            const tableInfo = await dbManager.all('PRAGMA table_info(responsibilities)');
                            if (!tableInfo.some(col => col.name === 'image')) await dbManager.run('ALTER TABLE responsibilities ADD COLUMN image TEXT').catch(() => {});
                            for (const name of Object.keys(currentResps)) {
                                await dbManager.updateResponsibility(name, currentResps[name]);
                            }
                        } catch (_) {}
                        await updateEmbedMessage(message.client, guildId);
                        appendRespAuditLog(guildId, message.author.id, 'resp.image.all', { imageUrl: safeImageUrl });
                        await submit.followUp({ content: '**✅ تم تعيين صورة لجميع المسؤوليات.**', ephemeral: true });
                        return;
                    }

                    if (!currentResps[respName]) {
                        await submit.reply({ content: '**❌ المسؤولية غير موجودة.**', ephemeral: true });
                        return;
                    }

                    currentResps[respName].image = safeImageUrl;
                    writeJSONFile(DATA_FILES.responsibilities, currentResps);
                    global.responsibilities = currentResps;
                    try {
                        const tableInfo = await dbManager.all('PRAGMA table_info(responsibilities)');
                        if (!tableInfo.some(col => col.name === 'image')) await dbManager.run('ALTER TABLE responsibilities ADD COLUMN image TEXT').catch(() => {});
                        await dbManager.updateResponsibility(respName, currentResps[respName]);
                    } catch (_) {}
                    await updateEmbedMessage(message.client, guildId);
                    appendRespAuditLog(guildId, message.author.id, 'resp.image.single', { respName, imageUrl: safeImageUrl });
                    await submit.followUp({ content: `**✅ تم تعيين صورة مسؤولية "${respName}".**`, ephemeral: true });
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_full_')) {
                    const currentResps = await requireNonEmptyResponsibilities(interaction);
                    if (!currentResps) return;
                    const allNames = Object.keys(currentResps);
                    const token = createSessionToken('full');
                    const pageSize = 25;
                    const totalPages = Math.max(1, Math.ceil(allNames.length / pageSize));
                    let page = 0;

                    const configSnapshot = getGuildRespConfig(guildId);
                    const previous = Array.isArray(configSnapshot.guilds[guildId]?.fullResponsibilities)
                        ? [...configSnapshot.guilds[guildId].fullResponsibilities]
                        : [];
                    const selected = new Set(previous);

                    const buildFullPayload = () => {
                        const pageItems = allNames.slice(page * pageSize, page * pageSize + pageSize);
                        const options = pageItems.map((name) => ({
                            label: name.substring(0, 100),
                            value: name.substring(0, 100),
                            default: selected.has(name)
                        }));

                        return {
                            content: [
                                '**إدارة Full Slots**',
                                `**صفحة :** ${page + 1}/${totalPages}`,
                                `**المحدد حالياً :** ${selected.size}`,
                                `**المحفوظ مسبقاً :** ${previous.length ? previous.join(' ، ') : 'لا يوجد'}`
                            ].join('\n'),
                            components: [
                                new ActionRowBuilder().addComponents(
                                    new StringSelectMenuBuilder()
                                        .setCustomId(`resp_full_select_${token}`)
                                        .setPlaceholder('Search & select full responsibilities')
                                        .setMinValues(0)
                                        .setMaxValues(options.length)
                                        .addOptions(options)
                                ),
                                new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`resp_full_prev_${token}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                                    new ButtonBuilder().setCustomId(`resp_full_next_${token}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
                                    new ButtonBuilder().setCustomId(`resp_full_save_${token}`).setLabel('حفظ').setStyle(ButtonStyle.Secondary)
                                )
                            ]
                        };
                    };

                    const fullMsg = await interaction.reply({ ...buildFullPayload(), ephemeral: true, fetchReply: true });

                    while (true) {
                        const picked = await fullMsg.awaitMessageComponent({
                            filter: (i) => i.user.id === message.author.id && i.customId.includes(token),
                            time: 120000
                        }).catch(() => null);
                        if (!picked) return;

                        if (picked.customId === `resp_full_select_${token}`) {
                            const pageItems = allNames.slice(page * pageSize, page * pageSize + pageSize);
                            for (const item of pageItems) selected.delete(item);
                            for (const item of picked.values) selected.add(item);
                            await picked.update(buildFullPayload()).catch(() => {});
                            continue;
                        }
                        if (picked.customId === `resp_full_prev_${token}`) {
                            page = Math.max(0, page - 1);
                            await picked.update(buildFullPayload()).catch(() => {});
                            continue;
                        }
                        if (picked.customId === `resp_full_next_${token}`) {
                            page = Math.min(totalPages - 1, page + 1);
                            await picked.update(buildFullPayload()).catch(() => {});
                            continue;
                        }
                        if (picked.customId === `resp_full_save_${token}`) {
                            const nextValues = [...selected];
                            const confirmed = await confirmEphemeralAction(
                                picked,
                                `**التغيير المقترح للمسؤوليات المكتملة :**\n**قبل :** ${previous.join(' , ') || 'لا يوجد'}\n**بعد :** ${nextValues.join(' , ') || 'لا يوجد'}`
                            );
                            if (!confirmed) return;

                            const updatedConfig = getGuildRespConfig(guildId);
                            updatedConfig.guilds[guildId].fullResponsibilities = nextValues;
                            writeJSONFile(DATA_FILES.respConfig, updatedConfig);
                            appendRespAuditLog(guildId, message.author.id, 'resp.full.update', { before: previous, after: nextValues });
                            await picked.update({ content: `**✅ تم حفظ المسؤوليات المكتملة (${nextValues.length}).**`, components: [] }).catch(() => {});
                            return;
                        }
                    }
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_access_')) {
                    const currentResps = await requireNonEmptyResponsibilities(interaction);
                    if (!currentResps) return;
                    const accessSession = createSessionToken('access');
                    const allRespNames = Object.keys(currentResps);
                    const pageSize = 25;
                    const totalPages = Math.max(1, Math.ceil(allRespNames.length / pageSize));
                    let page = 0;
                    const selectedResponsibilities = new Set();

                    const buildAccessResponsibilitiesPayload = () => {
                        const pageItems = allRespNames.slice(page * pageSize, page * pageSize + pageSize);
                        const options = pageItems.map((resp) => ({
                            label: resp.substring(0, 100),
                            value: resp.substring(0, 100),
                            default: selectedResponsibilities.has(resp)
                        }));

                        return {
                            content: [
                                '**التقييدات الحالية :**',
                                buildRestrictionsPreview(),
                                '',
                                '**اختر المسؤوليات المطلوب تطبيق نفس التقييد عليها :**',
                                `**Page :** ${page + 1}/${totalPages}`,
                                `**المحدد حالياً :** ${selectedResponsibilities.size}`
                            ].join('\n'),
                            components: [
                                new ActionRowBuilder().addComponents(
                                    new StringSelectMenuBuilder()
                                        .setCustomId(`resp_access_resp_select_${accessSession}`)
                                        .setPlaceholder('Search responsibilities')
                                        .setMinValues(0)
                                        .setMaxValues(options.length)
                                        .addOptions(options)
                                ),
                                new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`resp_access_prev_${accessSession}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                                    new ButtonBuilder().setCustomId(`resp_access_next_${accessSession}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
                                    new ButtonBuilder().setCustomId(`resp_access_continue_${accessSession}`).setLabel('متابعة').setStyle(ButtonStyle.Secondary),
                                    new ButtonBuilder().setCustomId(`resp_access_cancel_${accessSession}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
                                )
                            ]
                        };
                    };

                    const respPickerMessage = await interaction.reply({
                        ...buildAccessResponsibilitiesPayload(),
                        ephemeral: true,
                        fetchReply: true
                    });

                    while (true) {
                        const respPick = await respPickerMessage.awaitMessageComponent({
                            filter: (i) => i.user.id === message.author.id && i.customId.includes(accessSession),
                            time: 120000
                        }).catch(() => null);
                        if (!respPick) return;

                        if (respPick.customId === `resp_access_cancel_${accessSession}`) {
                            await respPick.update({ content: '**❌ تم إلغاء العملية.**', components: [] }).catch(() => {});
                            return;
                        }

                        if (respPick.customId === `resp_access_resp_select_${accessSession}`) {
                            const pageItems = allRespNames.slice(page * pageSize, page * pageSize + pageSize);
                            for (const resp of pageItems) selectedResponsibilities.delete(resp);
                            for (const resp of respPick.values) selectedResponsibilities.add(resp);
                            await respPick.update(buildAccessResponsibilitiesPayload()).catch(() => {});
                            continue;
                        }

                        if (respPick.customId === `resp_access_prev_${accessSession}`) {
                            page = Math.max(0, page - 1);
                            await respPick.update(buildAccessResponsibilitiesPayload()).catch(() => {});
                            continue;
                        }

                        if (respPick.customId === `resp_access_next_${accessSession}`) {
                            page = Math.min(totalPages - 1, page + 1);
                            await respPick.update(buildAccessResponsibilitiesPayload()).catch(() => {});
                            continue;
                        }

                        if (respPick.customId === `resp_access_continue_${accessSession}`) {
                            if (!selectedResponsibilities.size) {
                                await respPick.reply({ content: '**❌ لازم تحدد مسؤولية واحدة على الأقل.**', ephemeral: true }).catch(() => {});
                                continue;
                            }
                            await respPick.update({ content: `**✅ تم تحديد ${selectedResponsibilities.size} مسؤولية.**`, components: [] }).catch(() => {});
                            break;
                        }
                    }

                    const selectedList = [...selectedResponsibilities];
                    const accessMsg = await interaction.followUp({
                        content: [
                            `**إدارة Access Roles : ${selectedList.join(' ، ')}**`,
                            `**عدد المسؤوليات المحددة :** ${selectedList.length}`,
                            '',
                            '**اختر الرولات الجديدة أو اضغط إزالة التقييد.**'
                        ].join('\n'),
                        components: [
                            new ActionRowBuilder().addComponents(
                                new RoleSelectMenuBuilder().setCustomId(`resp_access_roles_${accessSession}`).setMinValues(1).setMaxValues(10).setPlaceholder('Search roles')
                            ),
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`resp_access_off_${accessSession}`).setLabel('إزالة التقييد').setStyle(ButtonStyle.Secondary)
                            )
                        ],
                        ephemeral: true,
                        fetchReply: true
                    });

                    const followPick = await accessMsg.awaitMessageComponent({
                        filter: (i) => i.user.id === message.author.id && (
                            i.customId === `resp_access_roles_${accessSession}` ||
                            i.customId === `resp_access_off_${accessSession}`
                        ),
                        time: 120000
                    }).catch(() => null);
                    if (!followPick) return;

                    if (followPick.customId.includes('resp_access_off_')) {
                        const previousMap = {};
                        for (const respName of selectedList) {
                            previousMap[respName] = getRespRoleRestrictions(guildId)[respName] || [];
                        }
                        const confirmed = await confirmEphemeralAction(
                            followPick,
                            `**إلغاء التقييد عن المسؤوليات المحددة (${selectedList.length}).**`
                        );
                        if (!confirmed) return;
                        for (const respName of selectedList) {
                            setRespRoleRestriction(guildId, respName, []);
                        }
                        appendRespAuditLog(guildId, message.author.id, 'resp.access.clear', {
                            responsibilities: selectedList,
                            before: previousMap
                        });
                        await followPick.update({
                            content: `**✅ تم إلغاء التقييد عن ${selectedList.length} مسؤولية.**\n\n**التقييدات الحالية :**\n${buildRestrictionsPreview()}`,
                            components: []
                        }).catch(() => {});
                        return;
                    }

                    const adminRoles = getAllowedAdminRolesForGuild(guildId);
                    const roleIds = [...followPick.values];
                    const invalidAdminRoles = adminRoles.length
                        ? roleIds.filter((roleId) => !adminRoles.includes(roleId))
                        : [];
                    if (invalidAdminRoles.length) {
                        await followPick.reply({ content: '**❌ بعض الرولات ليست ضمن adminRoles المسموحة.**', ephemeral: true });
                        return;
                    }

                    const previousMap = {};
                    for (const respName of selectedList) {
                        previousMap[respName] = getRespRoleRestrictions(guildId)[respName] || [];
                    }
                    const confirmed = await confirmEphemeralAction(
                        followPick,
                        `**تحديث التقييد على ${selectedList.length} مسؤولية.**\n**الرولات الجديدة :** ${roleIds.map((id) => `<@&${id}>`).join(' ')}`
                    );
                    if (!confirmed) return;

                    for (const respName of selectedList) {
                        setRespRoleRestriction(guildId, respName, roleIds);
                    }
                    appendRespAuditLog(guildId, message.author.id, 'resp.access.update', {
                        responsibilities: selectedList,
                        before: previousMap,
                        after: roleIds
                    });
                    await followPick.update({
                        content: `**✅ تم حفظ التقييد لـ ${selectedList.length} مسؤولية.**\n\n**التقييدات الحالية :**\n${buildRestrictionsPreview()}`,
                        components: []
                    }).catch(() => {});
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_cooldown_')) {
                    const modal = new ModalBuilder().setCustomId(`resp_cd_modal_${message.id}`).setTitle('تخصيص الكولداون');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('cooldown_value')
                                .setLabel('كولداون التقديم (مثال: 30m أو 2h أو 1d)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('reject_cooldown_value')
                                .setLabel('كولداون الرفض (مثال: 1d 2h 30m أو off)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        )
                    );
                    await interaction.showModal(modal);

                    const submit = await interaction.awaitModalSubmit({
                        filter: (i) => i.user.id === message.author.id && i.customId === `resp_cd_modal_${message.id}`,
                        time: 120000
                    }).catch(() => null);
                    if (!submit) return;

                    const rawApplyValue = submit.fields.getTextInputValue('cooldown_value').trim().toLowerCase();
                    const rawRejectValue = submit.fields.getTextInputValue('reject_cooldown_value').trim().toLowerCase();
                    const configData = getGuildRespConfig(guildId);
                    if (!configData.guilds[guildId]) configData.guilds[guildId] = {};

                    const applyParsed = parseDurationToMinutes(rawApplyValue);
                    const rejectParsed = parseDurationToMinutes(rawRejectValue);

                    if (applyParsed.error || rejectParsed.error) {
                        await submit.reply({
                            content: '**❌ قيمة غير صالحة.**\nاكتب مثل: `30m` أو `2h` أو `1d 3h 15m` أو `off`.',
                            ephemeral: true
                        });
                        return;
                    }

                    const applyMinutes = applyParsed.minutes;
                    const rejectMinutes = rejectParsed.minutes;
                    if (!Number.isFinite(applyMinutes) || applyMinutes < 0 || applyMinutes > 43200) {
                        await submit.reply({ content: '**❌ كولداون التقديم غير صالح.**\nالحد الأقصى: **30 يوم**.', ephemeral: true });
                        return;
                    }
                    if (!Number.isFinite(rejectMinutes) || rejectMinutes < 0 || rejectMinutes > 43200) {
                        await submit.reply({ content: '**❌ كولداون الرفض غير صالح.**\nالحد الأقصى: **30 يوم**.', ephemeral: true });
                        return;
                    }

                    const confirmed = await confirmEphemeralAction(
                        submit,
                        `**سيتم ضبط كولداون التقديم على ${formatMinutesArabic(applyMinutes)}**\n` +
                        `**وسيتم ضبط كولداون الرفض على ${formatMinutesArabic(rejectMinutes)}**`
                    );
                    if (!confirmed) return;

                    configData.guilds[guildId].applyCooldownMinutes = applyMinutes;
                    configData.guilds[guildId].rejectApplyCooldownMinutes = rejectMinutes;
                    if (!rejectMinutes) {
                        configData.guilds[guildId].rejectApplyCooldowns = {};
                    }
                    writeJSONFile(DATA_FILES.respConfig, configData);
                    appendRespAuditLog(guildId, message.author.id, 'resp.cooldown.update', { value: applyMinutes });
                    appendRespAuditLog(guildId, message.author.id, 'resp.rejectCooldown.update', { value: rejectMinutes });
                    await submit.followUp({
                        content:
                            `**✅ تم تحديث الكولداون.**\n` +
                            `• كولداون التقديم: **${formatMinutesArabic(applyMinutes)}**\n` +
                            `• كولداون الرفض: **${formatMinutesArabic(rejectMinutes)}**`,
                        ephemeral: true
                    });
                    return;
                }

                if (interaction.customId.startsWith('resp_panel_clear_')) {
                    await interaction.reply({
                        content: '**تأكيد :** هل تريد تفريغ جميع المسؤولين؟',
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`resp_clear_yes_${message.id}`).setLabel('تأكيد').setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder().setCustomId(`resp_clear_no_${message.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
                        )],
                        ephemeral: true,
                        fetchReply: true
                    });

                    const confirm = await interaction.fetchReply().then((m) => m.awaitMessageComponent({
                        filter: (i) => i.user.id === message.author.id && [
                            `resp_clear_yes_${message.id}`,
                            `resp_clear_no_${message.id}`
                        ].includes(i.customId),
                        time: 120000
                    })).catch(() => null);
                    if (!confirm) return;
                    if (confirm.customId.includes('_no_')) {
                        await confirm.update({ content: '**❌ تم إلغاء العملية.**', components: [] });
                        return;
                    }
                    await confirm.deferUpdate().catch(() => {});

                    const currentResps = getCurrentResponsibilities();
                    let totalRemoved = 0;
                    let totalRolesRemoved = 0;
                    let skippedMissingMembers = 0;
                    const { dbManager } = require('../utils/database.js');

                    for (const respName in currentResps) {
                        const resp = currentResps[respName];
                        const roleIds = Array.isArray(resp.roles) ? resp.roles.filter(Boolean) : (resp.roleId ? [resp.roleId] : []);
                        const members = [...new Set(resp.responsibles || resp.members || [])];
                        const fetchedMembers = members.length > 0
                            ? await message.guild.members.fetch({ user: members }).catch(() => null)
                            : null;

                        for (const userId of members) {
                            totalRemoved++;
                            const member = fetchedMembers?.get(userId) || message.guild.members.cache.get(userId) || null;
                            if (!member) {
                                skippedMissingMembers++;
                                continue;
                            }
                            for (const roleId of roleIds) {
                                if (member.roles.cache.has(roleId)) {
                                    await member.roles.remove(roleId).catch(() => {});
                                    totalRolesRemoved++;
                                }
                            }
                        }

                        resp.members = [];
                        resp.responsibles = [];
                        if (dbManager?.updateResponsibility) await dbManager.updateResponsibility(respName, resp);
                    }

                    writeJSONFile(DATA_FILES.responsibilities, currentResps);
                    global.responsibilities = currentResps;
                    await updateEmbedMessage(message.client, guildId).catch(() => {});
                    appendRespAuditLog(guildId, message.author.id, 'resp.clearMembers', {
                        removedMembers: totalRemoved,
                        removedRoles: totalRolesRemoved,
                        skippedMissingMembers
                    });
                    const skippedLine = skippedMissingMembers > 0
                        ? `\n**⚠️ لم يتم سحب رولات : ${skippedMissingMembers} (طالعين من السيرفر).**`
                        : '';
                    await interaction.editReply({
                        content: `**✅ تم تفريغ المسؤولين (${totalRemoved}) وسحب الرولات (${totalRolesRemoved}).**${skippedLine}`,
                        components: []
                    });
                }
            } catch (error) {
                console.error('Error in resp control panel:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '**❌ حدث خطأ أثناء تنفيذ الإجراء.**', ephemeral: true }).catch(() => {});
                }
            } finally {
                await refreshPanelMessage();
            }
        });

        panelCollector.on('end', async () => {
            await panelMessage.edit({ components: [] }).catch(() => {});
        });

        return;
    },

    // دوال مساعدة
    updateEmbedMessage,
    handleSuggestionButton,
    handleSuggestionModal,
    handleResponsibilitySelect,
    isRespManager
};

// دوال إدارة الإعدادات لكل سيرفر
function getGuildConfig(guildId) {
    const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
    if (!config.guilds) config.guilds = {};
    if (!config.guilds[guildId]) {
        config.guilds[guildId] = {
            suggestionsChannel: null,
            embedChannel: null,
            embedData: null,
            messageFormat: 'embed' // 'embed' or 'text'
        };
    }
    return config;
}

function setGuildConfig(guildId, updates) {
    const config = getGuildConfig(guildId);
    Object.assign(config.guilds[guildId], updates);
    writeJSONFile(DATA_FILES.respConfig, config);
    return config;
}

// دالة لحفظ بيانات الايمبد في الكونفيغ
function updateStoredEmbedData(targetGuildId = null) {
    const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
    if (!config.guilds) config.guilds = {};

    const entries = targetGuildId
        ? (embedMessages.has(targetGuildId) ? [[targetGuildId, embedMessages.get(targetGuildId)]] : [])
        : [...embedMessages.entries()];

    for (const [guildId, embedData] of entries) {
        if (!config.guilds[guildId]) config.guilds[guildId] = {};
        config.guilds[guildId].embedData = {
            messageId: embedData.messageId,
            channelId: embedData.channelId
        };
    }

    writeJSONFile(DATA_FILES.respConfig, config);
}

// دالة لتحميل بيانات الايمبد عند بدء التشغيل
function loadEmbedData(client) {
    try {
        embedMessages.clear();
        const config = readJSONFile(DATA_FILES.respConfig, { guilds: {} });
        if (config.guilds) {
            for (const [guildId, guildConfig] of Object.entries(config.guilds)) {
                if (guildConfig.embedData) {
                    embedMessages.set(guildId, {
                        messageId: guildConfig.embedData.messageId,
                        channelId: guildConfig.embedData.channelId,
                        message: null // سيتم إعادة بنائه عند الحاجة
                    });
                }
            }
            console.log(`تم تحميل ${embedMessages.size} رسالة ايمبد مسؤوليات`);
        }
    } catch (error) {
        console.error('خطأ في تحميل بيانات الايمبد:', error);
    }
}

// دالة لإرسال ايمبد المسؤوليات
async function sendResponsibilitiesEmbed(channel, client) {
    try {
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const embed = createResponsibilitiesEmbed(responsibilities);
        const components = createSuggestionComponents();
        
        const message = await channel.send({
            embeds: [embed],
            components: components
        });
        
        // حفظ مرجع للرسالة
        const guildId = channel.guild.id;
        embedMessages.set(guildId, {
            messageId: message.id,
            channelId: channel.id,
            message: message
        });
        
        // حفظ البيانات في الكونفيغ
        updateStoredEmbedData();
        
        console.log('تم إرسال ايمبد المسؤوليات بنجاح');
        
    } catch (error) {
        console.error('خطأ في إرسال ايمبد المسؤوليات:', error);
    }
}

// دالة لإرسال رسالة المسؤوليات (إيمبد أو نص)
async function sendResponsibilitiesMessage(channel, client, format = 'embed') {
    try {
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const components = createSuggestionComponents();
        let message;
        
if (format === 'text') {

    const textContent = createResponsibilitiesText(responsibilities);

    const parts = splitText(textContent);

    for (let i = 0; i < parts.length; i++) {

        const sentMessage = await channel.send({

            content: parts[i],

            components: i === parts.length - 1 ? components : []

        });

        // حفظ آخر رسالة فقط (عشان التحديث لاحقًا)

        if (i === parts.length - 1) {

            const guildId = channel.guild.id;

            embedMessages.set(guildId, {

                messageId: sentMessage.id,

                channelId: channel.id,

                message: sentMessage,

                format: 'text'

            });

            updateStoredEmbedData();

        }

    }

    console.log('تم إرسال رسالة المسؤوليات بنجاح (text - multi messages)');

    return;

}


            else {
            const embed = createResponsibilitiesEmbed(responsibilities);
            message = await channel.send({
                embeds: [embed],
                components: components
            });
        }
        
        // حفظ مرجع للرسالة
        const guildId = channel.guild.id;
        embedMessages.set(guildId, {
            messageId: message.id,
            channelId: channel.id,
            message: message,
            format: format
        });
        
        // حفظ البيانات في الكونفيغ
        updateStoredEmbedData();
        
        console.log(`تم إرسال رسالة المسؤوليات بنجاح (${format})`);
        
    } catch (error) {
        console.error('خطأ في إرسال رسالة المسؤوليات:', error);
    }
}
