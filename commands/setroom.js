const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType, StringSelectMenuBuilder, AttachmentBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { createCanvas, loadImage } = require('canvas');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { ensureCairoFontsRegistered } = require('../utils/cairoFont');

const name = 'setroom';
const SETROOM_TEXT_MOVE_STEP = 20;
const SETROOM_TEXT_SCALE_STEP = 0.05;
const SETROOM_GAP_STEP = 0.15;
const SETROOM_GAP_MIN = 0.2;
const SETROOM_GAP_MAX = 6;
const DEFAULT_ROOM_DELETE_HOURS = 24;
const DEFAULT_REJECT_COOLDOWN_MINUTES = 30;
const MIN_ROOM_DELETE_HOURS = 1;
const MAX_ROOM_DELETE_HOURS = 168;
const MIN_REJECT_COOLDOWN_MINUTES = 0;
const MAX_REJECT_COOLDOWN_MINUTES = 10080;

ensureCairoFontsRegistered();

function getRoomDeletionMs(guildConfig = {}) {
    const hours = Number(guildConfig.roomDeleteAfterHours ?? DEFAULT_ROOM_DELETE_HOURS);
    if (!Number.isFinite(hours)) return DEFAULT_ROOM_DELETE_HOURS * 60 * 60 * 1000;
    const normalized = Math.min(MAX_ROOM_DELETE_HOURS, Math.max(MIN_ROOM_DELETE_HOURS, hours));
    return normalized * 60 * 60 * 1000;
}

function getRejectCooldownMs(guildConfig = {}) {
    const minutes = Number(guildConfig.rejectCooldownMinutes ?? DEFAULT_REJECT_COOLDOWN_MINUTES);
    if (!Number.isFinite(minutes)) return DEFAULT_REJECT_COOLDOWN_MINUTES * 60 * 1000;
    const normalized = Math.min(MAX_REJECT_COOLDOWN_MINUTES, Math.max(MIN_REJECT_COOLDOWN_MINUTES, minutes));
    return normalized * 60 * 1000;
}

function shouldDisableDefaultDecoration(message = '') {
    return /[#*\-]/.test(message || '');
}

function getFormattedRoomMessageBody(message = '') {
    const cleanMessage = (message || '').trim();
    if (!cleanMessage) return '';
    if (shouldDisableDefaultDecoration(cleanMessage)) return cleanMessage;
    return `** - ${cleanMessage} - **`;
}

function extractTargetUserId(forWho = '') {
    const mentionMatch = String(forWho || '').match(/<@!?(\d+)>/);
    if (mentionMatch) return mentionMatch[1];
    const idMatch = String(forWho || '').trim().match(/^(\d{16,20})$/);
    if (idMatch) return idMatch[1];
    return null;
}

function normalizeComparableText(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/<@!?\d+>/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .trim();
}

function normalizeComparableWhen(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function hasConflictingRoomRequest(requests = [], guildId, forWho, when, excludeRequestId = null) {
    const targetUserId = extractTargetUserId(forWho);
    const normalizedWhen = normalizeComparableWhen(when);
    const normalizedForWho = normalizeComparableText(forWho);

    return requests.some(request => {
        if (!request || request.guildId !== guildId) return false;
        if (excludeRequestId && request.id === excludeRequestId) return false;
        if (!['pending', 'accepted'].includes(request.status)) return false;

        const sameWhen = normalizeComparableWhen(request.when) === normalizedWhen;
        if (!sameWhen) return false;

        const requestTargetId = extractTargetUserId(request.forWho);
        if (targetUserId && requestTargetId) return targetUserId === requestTargetId;

        const requestForWhoNormalized = normalizeComparableText(request.forWho);
        if (!normalizedForWho || !requestForWhoNormalized) return false;
        return normalizedForWho === requestForWhoNormalized;
    });
}

// مسار ملف إعدادات الغرف
const roomConfigPath = path.join(__dirname, '..', 'data', 'roomConfig.json');
const roomRequestsPath = path.join(__dirname, '..', 'data', 'roomRequests.json');
const setupEmbedMessagesPath = path.join(__dirname, '..', 'data', 'setupEmbedMessages.json');
const setupImagesPath = path.join(__dirname, '..', 'data', 'setup_images');
const localEmojiAssetsPath = path.join(__dirname, '..', 'data', 'setroom_emoji_assets');
const setroomRequestsUiState = new Map();

// تخزين الجدولات النشطة
const activeSchedules = new Map();

// مسار ملف الجدولات
const schedulesPath = path.join(__dirname, '..', 'data', 'roomSchedules.json');
const activeRooms = new Map();
// مسار ملف الرومات النشطة
const activeRoomsPath = path.join(__dirname, '..', 'data', 'activeRooms.json');
// تخزين جدولات حذف الرومات
const roomDeletionJobs = new Map();
// تخزين آخر وقت تم فيه طباعة خطأ تحميل الصورة (لتقليل الرسائل المكررة)
const lastImageErrorLog = new Map();

// تخزين هاش إعدادات الألوان لكل سيرفر لمعرفة إذا تغيرت الإعدادات
const colorConfigHash = new Map();

// دالة لحساب هاش الإعدادات لمعرفة إذا تغيرت
function getColorConfigHash(guildConfig) {
    const data = JSON.stringify({
        colorRoleIds: guildConfig.colorRoleIds || [],
        colorsTitle: guildConfig.colorsTitle || '',
        textColor: guildConfig.textColor || '#ffffff',
        guildIconEnabled: guildConfig.guildIconEnabled || false,
        imageUrl: guildConfig.imageUrl || '',
        localImagePath: guildConfig.localImagePath || '',
        layoutSettings: { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) }
    });
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const char = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString();
}

  
// حفظ الجدولات
function saveSchedules() {
    try {
        const schedulesData = {};
        for (const [requestId, job] of activeSchedules.entries()) {
            if (job.nextInvocation) {
                schedulesData[requestId] = {
                    nextRun: job.nextInvocation().toISOString()
                };
            }
        }
        fs.writeFileSync(schedulesPath, JSON.stringify(schedulesData, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('خطأ في حفظ الجدولات:', error);
        return false;
        }
}
// حفظ الرومات النشطة
function saveActiveRooms() {
    try {
        const roomsData = Array.from(activeRooms.entries()).map(([channelId, data]) => ({
            channelId,
            ...data
        }));
        fs.writeFileSync(activeRoomsPath, JSON.stringify(roomsData, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('خطأ في حفظ الرومات النشطة:', error);
        return false;
    }
}
// تحميل الرومات النشطة
function loadActiveRooms() {
    try {
        if (fs.existsSync(activeRoomsPath)) {
            const roomsData = JSON.parse(fs.readFileSync(activeRoomsPath, 'utf8'));
            const roomsMap = new Map();
            roomsData.forEach(room => {
                roomsMap.set(room.channelId, {
                    guildId: room.guildId,
                    createdAt: room.createdAt,
                    emojis: room.emojis || [],
                    requestId: room.requestId,
                    deleteAfterMs: Number(room.deleteAfterMs) || (DEFAULT_ROOM_DELETE_HOURS * 60 * 60 * 1000)
                });
            });
            return roomsMap;
        }
        return new Map();
    } catch (error) {
        console.error('خطأ في تحميل الرومات النشطة:', error);
        return new Map();
    }
}

// دالة لحفظ الصورة محلياً
async function saveImageLocally(imageUrl, guildId) {
    try {
        // إنشاء المجلد إذا لم يكن موجوداً
        if (!fs.existsSync(setupImagesPath)) {
            fs.mkdirSync(setupImagesPath, { recursive: true });
        }

        // تحميل الصورة
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // تحديد امتداد الملف
        const urlParts = imageUrl.split('.');
        const extension = urlParts[urlParts.length - 1].split('?')[0] || 'png';
        
        // حفظ الصورة
        const imagePath = path.join(setupImagesPath, `setup_${guildId}.${extension}`);
        fs.writeFileSync(imagePath, buffer);
        
        console.log(`✅ تم حفظ الصورة محلياً: ${imagePath}`);
        return imagePath;
    } catch (error) {
        console.error('❌ فشل في حفظ الصورة محلياً:', error);
        return null;
    }
}

function ensureEmojiAssetsDir() {
    if (!fs.existsSync(localEmojiAssetsPath)) {
        fs.mkdirSync(localEmojiAssetsPath, { recursive: true });
    }
}

async function saveEmojiLocally(emojiUrl, guildId, sourceEmojiId, animated = false) {
    try {
        ensureEmojiAssetsDir();
        const response = await fetch(emojiUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const extension = animated ? 'gif' : 'png';
        const filePath = path.join(localEmojiAssetsPath, `emoji_${guildId}_${sourceEmojiId}.${extension}`);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    } catch (error) {
        console.error('❌ فشل حفظ الإيموجي محلياً:', error.message);
        return null;
    }
}

async function cloneExternalEmojiToGuild(guild, emojiToken) {
    const match = String(emojiToken || '').match(/^<(?<animated>a?):(?<name>[a-zA-Z0-9_]{2,32}):(?<id>\d{16,20})>$/);
    if (!match) return null;
    const { animated, name, id } = match.groups;

    const existing = guild.emojis.cache.find(e => e.name === `sr_${name}_${id}` || e.name === `sr_${id}`);
    if (existing) {
        return `<${existing.animated ? 'a' : ''}:${existing.name}:${existing.id}>`;
    }

    const emojiUrl = `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=128&quality=lossless`;
    const localPath = await saveEmojiLocally(emojiUrl, guild.id, id, animated === 'a');
    if (!localPath) return null;

    try {
        const created = await guild.emojis.create({
            attachment: localPath,
            name: `sr_${name}_${id}`.slice(0, 32),
            reason: 'SetRoom: حفظ إيموجي خارجي محلياً للاستخدام في الطلبات'
        });
        return `<${created.animated ? 'a' : ''}:${created.name}:${created.id}>`;
    } catch (error) {
        console.error('❌ فشل رفع الإيموجي للسيرفر:', error.message);
        return null;
    }
}
async function deleteRoom(channelId, client) {
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            console.log(`⚠️ الروم ${channelId} غير موجود (ربما تم حذفه مسبقاً)`);
            activeRooms.delete(channelId);
            roomEmbedMessages.delete(channelId);
            saveActiveRooms();
            return;
        }
        const roomData = activeRooms.get(channelId);
        const deleteAfterMs = Number(roomData?.deleteAfterMs) || (DEFAULT_ROOM_DELETE_HOURS * 60 * 60 * 1000);
        const deleteAfterHours = Math.round(deleteAfterMs / (60 * 60 * 1000));
        await channel.delete(`انتهت مدة الروم (${deleteAfterHours} ساعة)`);
        console.log(`🗑️ تم حذف الروم: ${channel.name}`);

        activeRooms.delete(channelId);
        roomEmbedMessages.delete(channelId);
        saveActiveRooms();
    } catch (error) {
        console.error(`❌ خطأ في حذف الروم ${channelId}:`, error);
    }
}
// جدولة حذف روم وفق الوقت المحدد
function scheduleRoomDeletion(channelId, client, deleteAfterMs = DEFAULT_ROOM_DELETE_HOURS * 60 * 60 * 1000) {
    const deletionTime = new Date(Date.now() + deleteAfterMs);
    const job = schedule.scheduleJob(deletionTime, async () => {
        console.log(`⏰ حان موعد حذف الروم: ${channelId}`);
        await deleteRoom(channelId, client);
        roomDeletionJobs.delete(channelId);
    });

    roomDeletionJobs.set(channelId, job);
    const deleteAfterHours = (deleteAfterMs / (60 * 60 * 1000)).toFixed(2);
    console.log(`✅ تم جدولة حذف الروم ${channelId} بعد ${deleteAfterHours} ساعة`);
}

// إعادة إرسال setup embed - مبسط بدون كولداون
async function resendSetupEmbed(guildId, client) {
    try {
        const config = loadRoomConfig();
        const guildConfig = config[guildId];

        if (!guildConfig || !guildConfig.embedChannelId || !guildConfig.imageUrl) {
            console.error(`❌ لا توجد بيانات setup للسيرفر ${guildId}`);
            return false;
        }

        const embedChannel = await client.channels.fetch(guildConfig.embedChannelId).catch(() => null);

        if (!embedChannel) {
            console.error(`❌ قناة الإيمبد ${guildConfig.embedChannelId} غير موجودة`);
            return false;
        }

        // إعادة الإرسال مباشرة
        console.log(`🔄 إعادة إرسال setup embed في ${embedChannel.name}`);

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            console.error(`❌ السيرفر ${guildId} غير موجود`);
            return false;
        }

        const newMessage = await sendSetupMessage(embedChannel, guild, guildConfig);

        // تحديث معلومات الرسالة
        setupEmbedMessages.set(guildId, {
            messageId: newMessage.id,
            channelId: embedChannel.id,
            imageUrl: guildConfig.imageUrl
        });

        saveSetupEmbedMessages(setupEmbedMessages);

        console.log(`✅ تم إعادة إرسال setup embed بنجاح في ${embedChannel.name}`);
        return true;
    } catch (error) {
        console.error(`❌ خطأ في إعادة إرسال setup embed:`, error.message);
        return false;
    }
}

// فحص وحذف الرومات القديمة
async function checkAndDeleteOldRooms(client) {
    const now = Date.now();
    const roomsToDelete = [];
    for (const [channelId, roomData] of activeRooms.entries()) {
        const deleteAfterMs = Number(roomData.deleteAfterMs) || (DEFAULT_ROOM_DELETE_HOURS * 60 * 60 * 1000);
        const roomAge = now - roomData.createdAt;
        const hoursSinceCreation = roomAge / (1000 * 60 * 60);

        console.log(`🔍 فحص الروم ${channelId}: عمر الروم ${hoursSinceCreation.toFixed(2)} ساعة`);

        if (roomAge >= deleteAfterMs) {
            console.log(`⚠️ الروم ${channelId} تجاوز المدة المحددة - سيتم حذفه فوراً`);
            roomsToDelete.push(channelId);
        } else {
            const remainingTime = deleteAfterMs - roomAge;
            const deletionTime = new Date(roomData.createdAt + deleteAfterMs);

            const job = schedule.scheduleJob(deletionTime, async () => {
                console.log(`⏰ حان موعد حذف الروم: ${channelId}`);
                await deleteRoom(channelId, client);
                roomDeletionJobs.delete(channelId);
            });

            roomDeletionJobs.set(channelId, job);

            const remainingHours = (remainingTime / (1000 * 60 * 60)).toFixed(2);
            const remainingMinutes = Math.round(remainingTime / (1000 * 60));
            console.log(`✅ تم إعادة جدولة حذف الروم ${channelId} - متبقي ${remainingHours} ساعة (${remainingMinutes} دقيقة)`);
            console.log(`📅 سيتم الحذف في: ${deletionTime.toLocaleString('ar-SA')}`);
        }
    }

    // حذف الرومات القديمة
    for (const channelId of roomsToDelete) {
        await deleteRoom(channelId, client);
    }

    if (roomsToDelete.length > 0) {
        console.log(`🗑️ تم حذف ${roomsToDelete.length} روم قديم`);
    } else {
        console.log(`ℹ️ لا توجد رومات قديمة تحتاج للحذف`);
    }
}
// تحميل واستعادة الجدولات
function restoreSchedules(client) {
    try {
        // استعادة جدولات إنشاء الرومات المجدولة
        if (fs.existsSync(schedulesPath)) {
            const schedulesData = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
            const requests = loadRoomRequests();

            for (const request of requests) {
                if (request.status === 'accepted' && schedulesData[request.id]) {
                    const nextRun = new Date(schedulesData[request.id].nextRun);

                    // إذا كان الموعد في المستقبل، أعد جدولته
                    if (nextRun > new Date()) {
                        scheduleRoomCreation(request, client);
                        console.log(`✅ تم استعادة جدولة الروم: ${request.roomType} - ${request.forWho}`);
                    }
                    // إذا كان الموعد قد مضى، قم بإنشاء الروم فوراً
                    else {
                        createRoom(request, client, loadRoomConfig()[request.guildId]);
                        console.log(`⚡ تم إنشاء روم متأخر: ${request.roomType} - ${request.forWho}`);
                    }
                }
            }
        }

        // استعادة جدولات حذف الرومات النشطة
        const savedRooms = loadActiveRooms();
        for (const [channelId, roomData] of savedRooms.entries()) {
            activeRooms.set(channelId, roomData);
        }

        if (activeRooms.size > 0) {
            console.log(`📂 تم تحميل ${activeRooms.size} روم نشط من الملف`);
            // استعادة جدولات الحذف والإيموجي
            setTimeout(() => {
                checkAndDeleteOldRooms(client);
                restoreRoomEmojis(client);
            }, 5000);
        }
    } catch (error) {
        console.error('خطأ في استعادة الجدولات:', error);
    }
}

// نظام فحص دوري مستمر - تم إيقافه لأن النظام يعتمد على الحذف التلقائي كل 3 دقائق
function startContinuousSetupEmbedCheck(client) {
    // تم إيقاف هذه الدالة - النظام الآن يعتمد على الحذف التلقائي كل 3 دقائق
    console.log('ℹ️ نظام الفحص الدوري المستمر معطل - يعتمد على الحذف التلقائي كل 3 دقائق');
}

// دالة الحذف والإرسال الفعلية - الحذف والإرسال بنفس الوقت (متوازي)
async function deleteAndSendEmbed(client) {
    try {
        const config = loadRoomConfig();
        
        for (const [guildId, guildConfig] of Object.entries(config)) {
            if (!guildConfig.embedChannelId) continue;
            
            try {
                const embedChannel = await client.channels.fetch(guildConfig.embedChannelId);
                if (!embedChannel) continue;
                
                // جلب الرسائل القديمة
                const messages = await embedChannel.messages.fetch({ limit: 100 });
                const guild = client.guilds.cache.get(guildId);
                
                // تنفيذ الحذف والإرسال بنفس الوقت (متوازي)
                const deletePromise = (async () => {
                    if (messages.size > 0) {
                        const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
                        const recentMessages = messages.filter(msg => msg.createdTimestamp > fourteenDaysAgo);
                        const oldMessages = messages.filter(msg => msg.createdTimestamp <= fourteenDaysAgo);
                        
                        let deletedCount = 0;
                        
                        // حذف الرسائل الحديثة دفعة واحدة
                        if (recentMessages.size > 0) {
                            try {
                                const deleted = await embedChannel.bulkDelete(recentMessages, true);
                                deletedCount += deleted.size;
                            } catch (bulkErr) {
                                for (const msg of recentMessages.values()) {
                                    try { await msg.delete(); deletedCount++; } catch (err) {}
                                }
                            }
                        }
                        
                        // حذف الرسائل القديمة فردياً
                        for (const msg of oldMessages.values()) {
                            try { await msg.delete(); deletedCount++; } catch (err) {}
                        }
                        
                        if (deletedCount > 0) {
                            console.log(`🗑️ تم حذف ${deletedCount} رسالة من قناة السيتب في ${guildId}`);
                        }
                    }
                })();
                
                const sendPromise = (async () => {
                    if (guildConfig.imageUrl && guild) {
                        const newMessage = await sendSetupMessage(embedChannel, guild, guildConfig);
                        setupEmbedMessages.set(guildId, {
                            messageId: newMessage.id,
                            channelId: embedChannel.id,
                            imageUrl: guildConfig.imageUrl
                        });
                        saveSetupEmbedMessages(setupEmbedMessages);
                        console.log(`✅ تم إرسال الإيمبد الجديد في ${guildId}`);
                    }
                })();
                
                // انتظار اكتمال العمليتين معاً
                await Promise.all([deletePromise, sendPromise]);
                
            } catch (channelError) {
                console.error(`خطأ في الوصول لقناة السيتب في ${guildId}:`, channelError.message);
            }
        }
    } catch (error) {
        console.error('❌ خطأ في نظام الحذف التلقائي:', error);
    }
}

// نظام حذف تلقائي للرسائل في قناة الإيمبد كل 3 دقائق
function startAutoMessageDeletion(client) {
    // حذف وإرسال فوري عند بدء التشغيل
    console.log('🔄 جاري الحذف والإرسال الفوري عند بدء التشغيل...');
    deleteAndSendEmbed(client);
    
    // ثم كل 3 دقائق
    setInterval(() => {
        deleteAndSendEmbed(client);
    }, 3 * 60 * 1000); // كل 3 دقائق

    console.log('✅ تم تشغيل نظام الحذف التلقائي للرسائل (كل 3 دقائق)');
}

// استعادة الإيموجي للرسائل الموجودة في الرومات النشطة
async function restoreRoomEmojis(client) {
    try {
        console.log('🔄 بدء استعادة الإيموجي للرومات النشطة...');

        let restoredCount = 0;

        for (const [channelId, roomData] of activeRooms.entries()) {
            if (!roomData.emojis || roomData.emojis.length === 0) {
                continue;
            }

            try {
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (!channel) {
                    console.log(`⚠️ القناة ${channelId} غير موجودة - تخطي`);
                    continue;
                }

                // جلب آخر 100 رسالة من القناة
                const messages = await channel.messages.fetch({ limit: 100 });

                for (const message of messages.values()) {
                    // تخطي رسائل البوتات
                    if (message.author.bot) continue;

                    // التحقق من الإيموجي الموجودة على الرسالة
                    const existingReactions = message.reactions.cache;

                    // إضافة الإيموجي المفقودة
                    for (const emoji of roomData.emojis) {
                        let hasReaction = false;

                        // التحقق من وجود الريآكشن
                        const emojiIdMatch = emoji.match(/<a?:\w+:(\d+)>/);
                        if (emojiIdMatch) {
                            hasReaction = existingReactions.has(emojiIdMatch[1]);
                        } else {
                            hasReaction = existingReactions.has(emoji);
                        }

                        // إضافة الريآكشن إذا لم يكن موجودًا
                        if (!hasReaction) {
                            try {
                                await message.react(emoji);
                                restoredCount++;
                            } catch (reactError) {
                                // محاولة استخدام آيدي الإيموجي
                                if (emojiIdMatch) {
                                    try {
                                        await message.react(emojiIdMatch[1]);
                                        restoredCount++;
                                    } catch (err) {
                                        console.error(`❌ فشل إضافة الإيموجي ${emoji}:`, err.message);
                                    }
                                }
                            }
                        }
                    }
                }

                console.log(`✅ تم فحص واستعادة الإيموجي للروم ${channel.name}`);
            } catch (channelError) {
                console.error(`❌ خطأ في معالجة القناة ${channelId}:`, channelError.message);
            }
        }

        if (restoredCount > 0) {
            console.log(`✅ تم استعادة ${restoredCount} إيموجي للرسائل`);
        } else {
            console.log(`ℹ️ لا توجد إيموجيات تحتاج للاستعادة`);
        }
    } catch (error) {
        console.error('❌ خطأ في استعادة الإيموجي:', error);
    }
}

// فحص واستعادة الإيمبد المحذوف (مبسط) - لم يعد مستخدماً، يعتمد النظام على الحذف التلقائي كل 3 دقائق
async function checkAndRestoreSetupEmbed(client) {
    // تم إيقاف هذه الدالة - النظام الآن يعتمد على الحذف التلقائي كل 3 دقائق
    return;
}

// تخزين انتظار الإيموجي
const awaitingEmojis = new Map();

// تخزين رسائل الإمبد في الغرف للحماية من الحذف
const roomEmbedMessages = new Map();

// تخزين رسائل إيمبد السيتب للحماية من الحذف - يتم تحميلها من الملف
let setupEmbedMessages = loadSetupEmbedMessages();

// دالة مساعدة لإرسال رسالة Setup حسب إعدادات الإيمبد
async function sendSetupMessage(channel, guild, guildConfig) {
    const embedEnabled = guildConfig.embedEnabled !== false; // افتراضياً مفعّل
    const texts = getSetroomTexts(guildConfig);
    
    // إنشاء صورة الألوان المدمجة
    const mergedImagePath = await createColorsImage(guild, guildConfig);
    const colorDescription = createColorDescription(guild, guildConfig);
    
    const menus = createSetupMenus(guild, guildConfig);
    
    let messageOptions;
    
    if (embedEnabled) {
        // إرسال مع Embed (مع النص/الكونتنت)
        const finalEmbed = colorManager.createEmbed()
            .setTitle(texts.setupTitle)
            .setDescription((texts.setupDescription || '') + colorDescription)
            .setImage('attachment://colors_merged.png')
            .setFooter({ text: texts.setupFooter || 'System' });
        
        messageOptions = { 
            embeds: [finalEmbed], 
            components: menus,
            files: []
        };
    } else {
        // إرسال بدون Embed (صورة فقط بدون أي نص)
        messageOptions = { 
            content: texts.setupDescription || '',
            components: menus,
            files: []
        };
    }
    
    // إضافة الصورة المدمجة كملف مرفق (في كلا الحالتين)
    if (mergedImagePath && fs.existsSync(mergedImagePath)) {
        const attachment = new AttachmentBuilder(mergedImagePath, { name: 'colors_merged.png' });
        messageOptions.files.push(attachment);
        console.log('✅ تم إرفاق الصورة المدمجة بنجاح');
    } else {
        // إذا فشلت الصورة المدمجة، حاول تحميل الصورة الأصلية
        console.warn('⚠️ فشل إنشاء الصورة المدمجة، جاري تحميل الصورة الأصلية...');
        
        try {
            let buffer = null;
            let imageName = 'setup_image.png';
            
            // محاولة استخدام الصورة المحفوظة محلياً أولاً
            if (guildConfig.localImagePath && fs.existsSync(guildConfig.localImagePath)) {
                buffer = fs.readFileSync(guildConfig.localImagePath);
                const extension = path.extname(guildConfig.localImagePath).slice(1) || 'png';
                imageName = embedEnabled ? 'colors_merged.png' : `setup_image.${extension}`;
                console.log('✅ تم تحميل الصورة من المسار المحلي');
            } 
            // في حالة عدم وجود صورة محلية، استخدام الرابط
            else if (guildConfig.imageUrl) {
                const response = await fetch(guildConfig.imageUrl);
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const arrayBuffer = await response.arrayBuffer();
                buffer = Buffer.from(arrayBuffer);
                const urlParts = guildConfig.imageUrl.split('.');
                const extension = urlParts[urlParts.length - 1].split('?')[0] || 'png';
                imageName = embedEnabled ? 'colors_merged.png' : `setup_image.${extension}`;
                console.log('✅ تم تحميل الصورة من الرابط');
            } else {
                throw new Error('لا توجد صورة في الإعدادات');
            }
            
            if (buffer) {
                const attachment = new AttachmentBuilder(buffer, { name: imageName });
                messageOptions.files.push(attachment);
                
                // تحديث الإيمبد ليستخدم الصورة الأصلية إذا كان مفعّل
                if (embedEnabled && messageOptions.embeds && messageOptions.embeds[0]) {
                    messageOptions.embeds[0].setImage(`attachment://${imageName}`);
                }
            }
        } catch (fetchError) {
            // محاولة استخدام صورة محفوظة محلياً كخطة بديلة
            let fallbackFound = false;
            const fallbackPath = path.join(setupImagesPath, `setup_${guild.id}.png`);
            const fallbackPathJpg = path.join(setupImagesPath, `setup_${guild.id}.jpg`);
            
            if (fs.existsSync(fallbackPath)) {
                try {
                    const buffer = fs.readFileSync(fallbackPath);
                    const attachment = new AttachmentBuilder(buffer, { name: 'colors_merged.png' });
                    messageOptions.files.push(attachment);
                    console.log('✅ تم استخدام الصورة المحفوظة محلياً كبديل');
                    fallbackFound = true;
                } catch (fallbackErr) {}
            } else if (fs.existsSync(fallbackPathJpg)) {
                try {
                    const buffer = fs.readFileSync(fallbackPathJpg);
                    const attachment = new AttachmentBuilder(buffer, { name: 'colors_merged.jpg' });
                    messageOptions.files.push(attachment);
                    if (embedEnabled && messageOptions.embeds && messageOptions.embeds[0]) {
                        messageOptions.embeds[0].setImage('attachment://colors_merged.jpg');
                    }
                    console.log('✅ تم استخدام الصورة المحفوظة محلياً كبديل (JPG)');
                    fallbackFound = true;
                } catch (fallbackErr) {}
            }
            
            if (!fallbackFound) {
                // تقليل الرسائل المكررة - طباعة الخطأ مرة واحدة كل ساعة فقط
                const imageKey = guildConfig.localImagePath || guildConfig.imageUrl || 'unknown';
                const now = Date.now();
                const lastLog = lastImageErrorLog.get(imageKey) || 0;
                if (now - lastLog > 3600000) { // ساعة واحدة
                    console.error('❌ فشل في تحميل الصورة:', fetchError.message);
                    console.error('💡 يرجى تحديث الصورة باستخدام أمر setroom');
                    lastImageErrorLog.set(imageKey, now);
                }
                
                // إرسال بدون صورة
                if (embedEnabled && messageOptions.embeds && messageOptions.embeds[0]) {
                    messageOptions.embeds[0].setImage(null);
                    messageOptions.embeds[0].setFooter({ text: '⚠️ فشل تحميل الصورة - يرجى تحديث الصورة' });
                }
            }
        }
    }
    
    const newMessage = await channel.send(messageOptions);
    
    // حذف الصورة المؤقتة بعد تأخير للتأكد من اكتمال الإرسال
    if (mergedImagePath && fs.existsSync(mergedImagePath)) {
        setTimeout(() => {
            try {
                if (fs.existsSync(mergedImagePath)) {
                    fs.unlinkSync(mergedImagePath);
                    console.log('🗑️ تم حذف الصورة المؤقتة بنجاح');
                }
            } catch (err) {
                console.error('خطأ في حذف الصورة المؤقتة:', err);
            }
        }, 3000); // انتظار 3 ثواني
    }
    
    return newMessage;
}

// قراءة وحفظ الإعدادات
function loadRoomConfig() {
    try {
        if (fs.existsSync(roomConfigPath)) {
            return JSON.parse(fs.readFileSync(roomConfigPath, 'utf8'));
        }
        return {};
    } catch (error) {
        console.error('خطأ في قراءة إعدادات الغرف:', error);
        return {};
    }
}

function saveRoomConfig(config) {
    try {
        fs.writeFileSync(roomConfigPath, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('خطأ في حفظ إعدادات الغرف:', error);
        return false;
    }
}

function loadRoomRequests() {
    try {
        if (fs.existsSync(roomRequestsPath)) {
            return JSON.parse(fs.readFileSync(roomRequestsPath, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('خطأ في قراءة طلبات الغرف:', error);
        return [];
    }
}

function saveRoomRequests(requests) {
    try {
        fs.writeFileSync(roomRequestsPath, JSON.stringify(requests, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('خطأ في حفظ طلبات الغرف:', error);
        return false;
    }
}

function getUserPendingRequest(requests = [], guildId, userId) {
    return requests.find(r => r.guildId === guildId && r.userId === userId && r.status === 'pending');
}

function getUserLatestRejectedRequest(requests = [], guildId, userId) {
    return requests
        .filter(r => r.guildId === guildId && r.userId === userId && r.status === 'rejected')
        .sort((a, b) => (b.reviewedAt || 0) - (a.reviewedAt || 0))[0] || null;
}

function loadSetupEmbedMessages() {
    try {
        if (fs.existsSync(setupEmbedMessagesPath)) {
            const data = JSON.parse(fs.readFileSync(setupEmbedMessagesPath, 'utf8'));
            const embedMap = new Map();
            for (const [guildId, embedData] of Object.entries(data)) {
                embedMap.set(guildId, embedData);
            }
            return embedMap;
        }
        return new Map();
    } catch (error) {
        console.error('خطأ في قراءة setupEmbedMessages:', error);
        return new Map();
    }
}

function saveSetupEmbedMessages(embedMap) {
    try {
        const data = {};
        for (const [guildId, embedData] of embedMap.entries()) {
            data[guildId] = {
                messageId: embedData.messageId,
                channelId: embedData.channelId,
                imageUrl: embedData.imageUrl
            };
        }
        fs.writeFileSync(setupEmbedMessagesPath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error('خطأ في حفظ setupEmbedMessages:', error);
        return false;
    }
}

function getDefaultSetroomTexts() {
    return {
        setupTitle: '**Rooms & Colors**',
        setupDescription: '**اختر لونك او نوع الروم التي تريد طلبها :**',
        setupFooter: 'System',
        roomMenuPlaceholder: 'Choose Your Room',
        colorMenuPlaceholder: 'Choose Your Color',
        condolenceLabel: 'Doaa',
        condolenceDescription: 'طلب روم دعاء',
        birthdayLabel: 'Birthday',
        birthdayDescription: 'طلب روم ميلاد',
        panelTitle: '**SetRoom Control Panel**',
        panelDescription: 'By Ahmed',
        roomContentPrefix: '@here',
        roomToLabel: 'لـ',
        roomByLabel: 'بواسطة',
        requestAcceptLabel: 'Accept',
        requestRejectLabel: 'Reject'
    };
}

function getSetroomTexts(guildConfig = {}) {
    return { ...getDefaultSetroomTexts(), ...(guildConfig.texts || {}) };
}

function getGuildConfigWithDefaults(config, guildId) {
    const guildConfig = ensureGuildRoomConfig(config, guildId);
    if (!guildConfig.texts) guildConfig.texts = getDefaultSetroomTexts();
    else guildConfig.texts = { ...getDefaultSetroomTexts(), ...guildConfig.texts };
    return guildConfig;
}

// دالة لإنشاء منيوهات Setup (منيو الدعاء/الميلاد + منيو الألوان)
function createSetupMenus(guild, guildConfig) {
    const menus = [];
    const texts = getSetroomTexts(guildConfig);

    const roomMenu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('room_type_menu')
            .setPlaceholder(texts.roomMenuPlaceholder || 'Choose Your Room')
            .addOptions([
                {
                    label: texts.condolenceLabel || 'Doaa',
                    description: texts.condolenceDescription || 'طلب روم دعاء',
                    emoji: '<:emoji_83:1442589607639126046>',
                    value: 'condolence',
                },
                {
                    label: texts.birthdayLabel || 'Birthday',
                    description: texts.birthdayDescription || 'طلب روم ميلاد',
                    emoji: '<:emoji_84:1442589686987227328>',
                    value: 'birthday',
                }
            ])
    );
    menus.push(roomMenu);

    // منيو الألوان (المنيو الثاني - إذا كانت الألوان مُعدة)
    if (guildConfig && guildConfig.colorRoleIds && guildConfig.colorRoleIds.length > 0) {
        const colorOptions = [
            {
                label: '0',
                description: 'إزالة جميع الألوان',
emoji: '<:emoji_60:1442587668306329733>',
                value: 'remove_all_colors',
                
            }
        ];

        let index = 1;
        for (const roleId of guildConfig.colorRoleIds) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                colorOptions.push({
                    label: `${index}`,
                    description: role.hexColor,
emoji: '<:emoji_51:1442585157516398722>',
                    value: roleId
                });
                index++;
            }
        }

        if (colorOptions.length > 1) {
            const colorMenu = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('color_selection_menu')
                    .setPlaceholder(texts.colorMenuPlaceholder || 'Choose Your Color')
                    .addOptions(colorOptions)
            );
            menus.push(colorMenu);
        }
    }

    return menus;
}

// دالة لإنشاء صورة الألوان بجودة عالية مع دمجها بالصورة الأصلية
async function createColorsImage(guild, guildConfig) {
    try {
        if (!guildConfig || !guildConfig.colorRoleIds || guildConfig.colorRoleIds.length === 0) {
            return null;
        }

        // التحقق من وجود صورة مخزنة مسبقاً (cache)
        const cachedImagePath = path.join(__dirname, '..', 'data', `colors_merged_${guild.id}.png`);
        const currentHash = getColorConfigHash(guildConfig);
        const storedHash = colorConfigHash.get(guild.id);
        
        // إذا كانت الإعدادات لم تتغير والصورة المخزنة موجودة، استخدمها مباشرة
        if (storedHash === currentHash && fs.existsSync(cachedImagePath)) {
            console.log('⚡ استخدام الصورة المدمجة المخزنة مسبقاً (cache)');
            return cachedImagePath;
        }

        // تحميل الصورة الأصلية
        let backgroundImage;
        try {
            // محاولة استخدام الصورة المحفوظة محلياً أولاً
            if (guildConfig.localImagePath && fs.existsSync(guildConfig.localImagePath)) {
                backgroundImage = await loadImage(guildConfig.localImagePath);
            } 
            // في حالة عدم وجود صورة محلية، استخدام الرابط
            else if (guildConfig.imageUrl) {
                const response = await fetch(guildConfig.imageUrl);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                backgroundImage = await loadImage(buffer);
                
                // حفظ الصورة محلياً بعد التحميل الناجح
                try {
                    const localPath = await saveImageLocally(guildConfig.imageUrl, guild.id);
                    if (localPath) {
                        const config = loadRoomConfig();
                        if (config[guild.id]) {
                            config[guild.id].localImagePath = localPath;
                            saveRoomConfig(config);
                        }
                    }
                } catch (saveErr) {
                    console.error('⚠️ تعذر حفظ الصورة محلياً:', saveErr.message);
                }
            } else {
                console.error('❌ لا توجد صورة في الإعدادات');
                return null;
            }
        } catch (imgError) {
            // محاولة استخدام صورة محفوظة محلياً كخطة بديلة
            const fallbackPath = path.join(setupImagesPath, `setup_${guild.id}.png`);
            const fallbackPathJpg = path.join(setupImagesPath, `setup_${guild.id}.jpg`);
            
            if (fs.existsSync(fallbackPath)) {
                try {
                    backgroundImage = await loadImage(fallbackPath);
                    console.log('✅ تم استخدام الصورة المحفوظة محلياً كبديل');
                } catch (fallbackErr) {
                    backgroundImage = null;
                }
            } else if (fs.existsSync(fallbackPathJpg)) {
                try {
                    backgroundImage = await loadImage(fallbackPathJpg);
                    console.log('✅ تم استخدام الصورة المحفوظة محلياً كبديل (JPG)');
                } catch (fallbackErr) {
                    backgroundImage = null;
                }
            }
            
            if (!backgroundImage) {
                // تقليل الرسائل المكررة - طباعة الخطأ مرة واحدة كل ساعة فقط
                const now = Date.now();
                const lastLog = lastImageErrorLog.get(guildConfig.imageUrl) || 0;
                if (now - lastLog > 3600000) { // ساعة واحدة
                    console.error('❌ فشل في تحميل الصورة:', imgError.message);
                    console.error('💡 يرجى رفع صورة جديدة باستخدام أمر setroom');
                    lastImageErrorLog.set(guildConfig.imageUrl, now);
                }
                return null;
            }
        }

        // استخدام أبعاد الصورة الأصلية
        const canvasWidth = backgroundImage.width;
        const canvasHeight = backgroundImage.height;

        // إعدادات المعاينة/التخصيص
        const layout = { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) };
        const scaleFactor = canvasWidth / 1024;
        const boxSize = Math.max(18, 60 * scaleFactor * layout.boxScale);
        const gap = Math.max(2, 20 * scaleFactor * layout.boxGap);
        const cornerRadius = Math.max(4, 10 * scaleFactor);

        const colorsPerRow = 10; // عدد الألوان في كل صف
        const totalColors = guildConfig.colorRoleIds.length;
        const rows = Math.ceil(totalColors / colorsPerRow);

        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');

        // رسم الصورة الأصلية كخلفية
        ctx.drawImage(backgroundImage, 0, 0, canvasWidth, canvasHeight);

        // حساب عرض المربعات للتمركز أفقياً
        const totalBoxesWidth = (boxSize * colorsPerRow) + (gap * (colorsPerRow - 1));
        const baseStartX = (canvasWidth - totalBoxesWidth) / 2;

        const totalBoxesHeight = (boxSize * rows) + (gap * (rows - 1));
        const baseStartY = rows > 1 
            ? (canvasHeight - totalBoxesHeight) / 2
            : (canvasHeight * 0.6) - (totalBoxesHeight / 2);
        const startX = baseStartX + (layout.boxOffsetX * scaleFactor);
        const startY = baseStartY + (layout.boxOffsetY * scaleFactor);
        
        // الحصول على النص المخصص من الإعدادات
        const colorsTitle = guildConfig.colorsTitle !== undefined ? guildConfig.colorsTitle : 'Colors list :';
        
        const titleFontSize = Math.max(16, Math.round(26 * scaleFactor * layout.textScale));
        const textOffsetX = (150 * scaleFactor) + (layout.textOffsetX * scaleFactor);
        const textOffsetY = (33 * scaleFactor) + (layout.textOffsetY * scaleFactor);
        const textColor = normalizeHexColor(guildConfig.textColor, '#ffffff');
        const titleX = startX - textOffsetX;
        const titleY = startY - textOffsetY;

        if (guildConfig.guildIconEnabled && guild.iconURL()) {
            try {
                const guildIconSize = Math.max(28, 64 * scaleFactor * layout.guildScale);
                const guildIconX = titleX - guildIconSize - (28 * scaleFactor) + (layout.guildOffsetX * scaleFactor);
                const guildIconY = titleY - (guildIconSize * 0.7) + (layout.guildOffsetY * scaleFactor);
                const guildIconBuffer = await fetch(guild.iconURL({ extension: 'png', size: 256 })).then(res => {
                    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                    return res.arrayBuffer();
                });
                const guildIconImage = await loadImage(Buffer.from(guildIconBuffer));
                const borderWidth = Math.max(3, 4 * scaleFactor);
                const iconCenterX = guildIconX + (guildIconSize / 2);
                const iconCenterY = guildIconY + (guildIconSize / 2);
                const iconRadius = guildIconSize / 2;

                ctx.save();
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.beginPath();
                ctx.arc(iconCenterX, iconCenterY, iconRadius, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(guildIconImage, guildIconX, guildIconY, guildIconSize, guildIconSize);
                ctx.restore();

                if (layout.guildBorderEnabled !== false) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(iconCenterX, iconCenterY, iconRadius + (borderWidth / 2), 0, Math.PI * 2);
                    ctx.strokeStyle = '#FFFFFF';
                    ctx.lineWidth = borderWidth;
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
                    ctx.shadowBlur = Math.max(2, 5 * scaleFactor);
                    ctx.stroke();
                    ctx.restore();
                }
            } catch (guildIconError) {
                console.error('⚠️ تعذر تحميل أيقونة السيرفر للمعاينة:', guildIconError.message);
            }
        }

        // رسم النص فقط إذا لم يكن فارغاً
        if (layout.showText && colorsTitle && colorsTitle.length > 0) {
            ctx.fillStyle = textColor;
            ctx.font = `bold ${titleFontSize}px Cairo`;
            ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
            ctx.shadowBlur = Math.max(6, Math.round(10 * scaleFactor));
            ctx.textAlign = 'left';
            ctx.fillText(colorsTitle, titleX, titleY);
            ctx.shadowBlur = 0;
        }
        
        // رسم المربعات
        let currentX = startX;
        let currentY = startY;
        let colorIndex = 1;
        
        for (const roleId of guildConfig.colorRoleIds) {
            const role = guild.roles.cache.get(roleId);
            if (!role) continue;
            
            const color = role.hexColor || '#ffffff';
            
            // رسم مربع بزوايا منحنية
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect(currentX, currentY, boxSize, boxSize, cornerRadius);
            ctx.fill();
            
            // إضافة رقم اللون داخل المربع
            const numberFontSize = Math.max(16, Math.round(24 * scaleFactor));
            ctx.fillStyle = getContrastColor(color);
            ctx.font = `bold ${numberFontSize}px Cairo`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(colorIndex.toString(), currentX + boxSize / 2, currentY + boxSize / 2);
            
            colorIndex++;
            
            // الانتقال للمربع التالي
            if (colorIndex % colorsPerRow === 1 && colorIndex > 1) {
                currentX = startX;
                currentY += boxSize + gap;
            } else {
                currentX += boxSize + gap;
            }
        }
        
        // حفظ الصورة المدمجة مع تحديث الـ cache
        const buffer = canvas.toBuffer('image/png');
        const imagePath = path.join(__dirname, '..', 'data', `colors_merged_${guild.id}.png`);
        fs.writeFileSync(imagePath, buffer);
        
        // تحديث الهاش المخزن
        colorConfigHash.set(guild.id, currentHash);
        console.log('✅ تم إنشاء وحفظ الصورة المدمجة الجديدة');
        
        return imagePath;
    } catch (error) {
        console.error('خطأ في إنشاء صورة الألوان:', error);
        return null;
    }
}

function normalizeHexColor(input, fallback = '#ffffff') {
    if (!input) return fallback;
    const value = input.trim();
    const shortHexMatch = /^#?([0-9a-fA-F]{3})$/;
    const fullHexMatch = /^#?([0-9a-fA-F]{6})$/;

    if (shortHexMatch.test(value)) {
        const shortHex = value.replace('#', '').toUpperCase();
        return `#${shortHex.split('').map(char => char + char).join('')}`;
    }

    if (fullHexMatch.test(value)) {
        return `#${value.replace('#', '').toUpperCase()}`;
    }

    return fallback;
}

// دالة للحصول على لون نص متباين
function getContrastColor(hexColor) {
    // تحويل HEX إلى RGB
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);

    // حساب السطوع
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;

    // إرجاع أبيض أو أسود حسب السطوع
    return brightness > 128 ? '#000000' : '#ffffff';
}

// دالة لإنشاء وصف الألوان للإمبد
function createColorDescription(guild, guildConfig) {
    // لا نضيف الألوان في وصف الإيمبد - فقط في المنيو
    return '';
}

// دالة لتحويل الآيدي أو اليوزر إلى منشن
async function formatUserMention(input, guild) {
    // تنظيف المدخل
    const cleaned = input.trim();

    // إذا كان منشن بالفعل، أرجعه كما هو
    if (cleaned.match(/^<@!?\d{17,19}>$/)) {
        return cleaned;
    }

    // إذا كان آيدي فقط (أرقام)
    if (/^\d{17,19}$/.test(cleaned)) {
        return `<@${cleaned}>`;
    }

    // محاولة البحث عن المستخدم بالاسم (username أو display name)
    try {
        // إزالة @ إذا كانت موجودة في البداية
        const searchName = cleaned.startsWith('@') ? cleaned.substring(1) : cleaned;

        // البحث في أعضاء السيرفر
        const members = await guild.members.fetch();
        const member = members.find(m => 
            m.user.username.toLowerCase() === searchName.toLowerCase() ||
            m.user.tag.toLowerCase() === searchName.toLowerCase() ||
            m.displayName.toLowerCase() === searchName.toLowerCase()
        );

        if (member) {
            return `<@${member.user.id}>`;
        }
    } catch (error) {
        console.error('خطأ في البحث عن المستخدم:', error);
    }

    // إذا كان اسم عادي، أرجعه كما هو
    return cleaned;
}

function extractEmojisFromText(rawText = '') {
    const text = String(rawText || '').trim();
    if (!text) return { emojis: [], disableEmojis: false };
    if (text === '0') return { emojis: [], disableEmojis: true };

    const customEmojiRegex = /<a?:\w+:\d+>/g;
    const customEmojis = text.match(customEmojiRegex) || [];
    const uniqueCustom = [...new Set(customEmojis)];

    let cleaned = text;
    for (const custom of uniqueCustom) {
        cleaned = cleaned.replaceAll(custom, ' ');
    }

    const unicodeEmojiRegex = /(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/gu;
    const unicodeEmojis = cleaned.match(unicodeEmojiRegex) || [];
    const uniqueUnicode = [...new Set(unicodeEmojis.map(e => e.trim()).filter(Boolean))];

    return { emojis: [...uniqueCustom, ...uniqueUnicode], disableEmojis: false };
}

async function normalizeRequestedEmojis(guild, emojis = []) {
    const normalized = [];
    for (const emoji of emojis) {
        if (!emoji) continue;
        const customMatch = String(emoji).match(/^<(?<animated>a?):(?<name>[a-zA-Z0-9_]{2,32}):(?<id>\d{16,20})>$/);
        if (!customMatch) {
            normalized.push(emoji);
            continue;
        }

        const { id } = customMatch.groups;
        const existingGuildEmoji = guild.emojis.cache.get(id);
        if (existingGuildEmoji) {
            normalized.push(`<${existingGuildEmoji.animated ? 'a' : ''}:${existingGuildEmoji.name}:${existingGuildEmoji.id}>`);
            continue;
        }

        const cloned = await cloneExternalEmojiToGuild(guild, emoji);
        normalized.push(cloned || emoji);
    }
    return normalized;
}

// معالجة طلبات الغرف (المنيو)
async function handleRoomRequestMenu(interaction, client) {
    const roomTypeEn = interaction.values[0]; // 'condolence' أو 'birthday'
    const roomType = roomTypeEn === 'condolence' ? 'دعاء' : 'ميلاد';

    // إنشاء المودال
    const modal = new ModalBuilder()
        .setCustomId(`room_modal_${roomTypeEn}_${interaction.user.id}`)
        .setTitle(`طلب روم : ${roomType}`);

    const forWhoInput = new TextInputBuilder()
        .setCustomId('for_who')
        .setLabel('الطلب لمن؟')
        .setPlaceholder('يمكنك كتابة منشن أو اسم أو آيدي')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const whenInput = new TextInputBuilder()
        .setCustomId('when')
        .setLabel('موعد إنشاء الروم')
        .setPlaceholder('، مثال: 12 صباحاً، بعد 3 ساعات، غداً الساعة 5، الحين')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const messageInput = new TextInputBuilder()
        .setCustomId('message')
        .setLabel(' اكتب رسالتك')
        .setPlaceholder('الرسالة التي سيتم إرسالها في الروم')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

    const imageInput = new TextInputBuilder()
        .setCustomId('image_url')
        .setLabel('رابط الصورة (اختياري)')
        .setPlaceholder('ضع رابط الصورة هنا إن أردت (اختياري)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const row1 = new ActionRowBuilder().addComponents(forWhoInput);
    const row2 = new ActionRowBuilder().addComponents(whenInput);
    const row3 = new ActionRowBuilder().addComponents(messageInput);
    const row4 = new ActionRowBuilder().addComponents(imageInput);

    modal.addComponents(row1, row2, row3, row4);

    await interaction.showModal(modal);

    // إعادة تعيين جميع المنيوهات (الروم + الألوان) فورًا بعد فتح المودال
    try {
        const config = loadRoomConfig();
        const guildConfig = config[interaction.guild.id];

        if (guildConfig) {
            const setupData = setupEmbedMessages.get(interaction.guild.id);

            if (setupData && setupData.messageId && setupData.channelId === guildConfig.embedChannelId) {
                const embedChannel = await client.channels.fetch(guildConfig.embedChannelId);
                const setupMessage = await embedChannel.messages.fetch(setupData.messageId);

                // إعادة بناء جميع المنيوهات (الروم + الألوان) بدون اختيار افتراضي
                const freshMenus = createSetupMenus(interaction.guild, guildConfig);

                await setupMessage.edit({ components: freshMenus });
                console.log('✅ تم إعادة تعيين جميع المنيوهات (الروم + الألوان) فورًا بعد فتح المودال');
            }
        }
    } catch (updateError) {
        console.error('❌ خطأ في إعادة تعيين المنيوهات:', updateError);
    }
}

// معالجة إرسال المودال
async function handleRoomModalSubmit(interaction, client) {
    const modalId = interaction.customId;
    const roomTypeEn = modalId.includes('condolence') ? 'condolence' : 'birthday';
    const roomType = roomTypeEn === 'condolence' ? 'دعاء' : 'ميلاد';
    const roomEmoji = roomTypeEn === 'condolence' ? '🖤' : '🎂';

    let forWho = interaction.fields.getTextInputValue('for_who').trim();
    const when = interaction.fields.getTextInputValue('when').trim();
    const message = interaction.fields.getTextInputValue('message').trim();
    let imageUrl = interaction.fields.getTextInputValue('image_url')?.trim() || null;

    // التحقق من الإدخالات
    const validationErrors = [];

    // فحص "لمن"
    if (!forWho || forWho.length < 2) {
        validationErrors.push('❌ اسم الشخص يجب أن يكون حرفين على الأقل');
    }
    if (forWho.length > 50) {
        validationErrors.push('❌ اسم الشخص طويل جداً (الحد الأقصى 50 حرف)');
    }

    // فحص "متى"
    if (!when || when.length < 2) {
        validationErrors.push('❌ موعد الإنشاء مطلوب');
    }
    if (when.length > 100) {
        validationErrors.push('❌ موعد الإنشاء طويل جداً');
    }

    // فحص الرسالة
    if (!message || message.length < 5) {
        validationErrors.push('❌ الرسالة يجب أن تكون 5 أحرف على الأقل');
    }
    if (message.length > 1000) {
        validationErrors.push('❌ الرسالة طويلة جداً (الحد الأقصى 1000 حرف)');
    }

    // فحص رابط الصورة (إذا تم إدخاله)
    if (imageUrl && imageUrl.length > 0) {
        const imageUrlPattern = /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|bmp)/i;
        if (!imageUrlPattern.test(imageUrl)) {
            validationErrors.push('❌ رابط الصورة غير صالح. يجب أن يكون رابط صورة صحيح (jpg, png, gif, webp)');
        }
    }

    // إذا كان هناك أخطاء، أرسلها
    if (validationErrors.length > 0) {
        const errorEmbed = colorManager.createEmbed()
            .setTitle('**Input Validation Errors**')
            .setDescription(`**${validationErrors.join('\n')}**`)
            .setColor('#ff0000');

        await interaction.reply({ embeds: [errorEmbed], flags: 64 });
        return;
    }

    // تحويل الآيدي أو اليوزر إلى منشن
    forWho = await formatUserMention(forWho, interaction.guild);

    const config = loadRoomConfig();
    const guildConfig = config[interaction.guild.id];

    if (!guildConfig) {
        await interaction.reply({ content: '❌ **لم يتم إعداد نظام الغرف بعد**', flags: 64 });
        return;
    }

    if (!guildConfig.requestsChannelId || !guildConfig.embedChannelId) {
        await interaction.reply({ content: '❌ **الإعدادات غير مكتملة: يجب تحديد روم الطلبات وروم السيتب أولاً**', flags: 64 });
        return;
    }

    const requests = loadRoomRequests();
    const pendingRequest = getUserPendingRequest(requests, interaction.guild.id, interaction.user.id);
    if (pendingRequest) {
        await interaction.reply({ content: '❌ **لديك طلب روم معلّق بالفعل، انتظر حتى يتم مراجعته أولاً**', flags: 64 });
        return;
    }

    const rejectCooldownMs = getRejectCooldownMs(guildConfig);
    if (rejectCooldownMs > 0) {
        const lastRejected = getUserLatestRejectedRequest(requests, interaction.guild.id, interaction.user.id);
        const lastRejectedAt = lastRejected?.reviewedAt || lastRejected?.createdAt || 0;
        const remainingMs = (lastRejectedAt + rejectCooldownMs) - Date.now();
        if (remainingMs > 0) {
            const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
            await interaction.reply({ content: `❌ **تم رفض طلبك سابقًا. يمكنك التقديم بعد ${remainingMinutes} دقيقة**`, flags: 64 });
            return;
        }
    }

    if (hasConflictingRoomRequest(requests, interaction.guild.id, forWho, when)) {
        await interaction.reply({ content: '❌ **يوجد بالفعل طلب معلّق/مقبول لنفس الشخص بنفس الوقت. يُسمح بروم واحد فقط لهذا الموعد.**', flags: 64 });
        return;
    }

    // طلب الإيموجي من المستخدم
    const emojiPrompt = colorManager.createEmbed()
        .setTitle('**Last Step**')
        .setDescription('**الرجاء إرسال الإيموجيات التي تريد إضافتها للروم**\n\nأرسل إيموجي واحد أو أكثر (يدعم المسافات). اكتب `0` إذا لا تريد إيموجي.')
        .setFooter({ text: 'لديك 60 ثانية للرد' });

    await interaction.reply({ embeds: [emojiPrompt], flags: 64 });

    // حفظ بيانات الطلب مؤقتاً في انتظار الإيموجي
    awaitingEmojis.set(interaction.user.id, {
        roomType,
        roomTypeEn,
        roomEmoji,
        forWho,
        when,
        message,
        imageUrl,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        timestamp: Date.now()
    });

    // ضبط timeout لإزالة الانتظار بعد 60 ثانية
    setTimeout(() => {
        if (awaitingEmojis.has(interaction.user.id)) {
            awaitingEmojis.delete(interaction.user.id);
        }
    }, 60000);
}

// معالج رسائل الإيموجي
async function handleEmojiMessage(message, client) {
    if (message.author.bot) return;

    const userId = message.author.id;
    if (!awaitingEmojis.has(userId)) return;

    const requestData = awaitingEmojis.get(userId);
    awaitingEmojis.delete(userId);

    const parsedEmojiInput = extractEmojisFromText(message.content);
    const disableEmojis = parsedEmojiInput.disableEmojis;
    let emojis = parsedEmojiInput.emojis;

    if (!disableEmojis && emojis.length === 0) emojis = [];

    // فحص عدد الإيموجيات
    if (emojis.length > 20) {
        await message.reply('❌ **الحد الأقصى للإيموجيات هو 20. تم إلغاء الطلب**').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 5000);
        });
        return;
    }

    const config = loadRoomConfig();
    const guildConfig = getGuildConfigWithDefaults(config, requestData.guildId);
    const texts = getSetroomTexts(guildConfig);

    if (!disableEmojis && emojis.length > 0) {
        emojis = await normalizeRequestedEmojis(message.guild, emojis);
    }

    const existingRequests = loadRoomRequests();
    if (getUserPendingRequest(existingRequests, requestData.guildId, userId)) {
        await message.reply('❌ **لديك طلب معلّق بالفعل. تم إلغاء الطلب الجديد**').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 6000);
        });
        return;
    }

    const requestsChannel = await client.channels.fetch(guildConfig.requestsChannelId).catch(() => null);
    if (!requestsChannel || requestsChannel.type !== ChannelType.GuildText) {
        await message.reply('❌ **روم الطلبات غير صالح أو غير موجود. تواصل مع الإدارة**').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 7000);
        });
        return;
    }

    // إنشاء الطلب
    const request = {
        id: `${Date.now()}_${userId}`,
        guildId: requestData.guildId,
        userId: userId,
        roomType: requestData.roomType,
        roomTypeEn: requestData.roomTypeEn,
        forWho: requestData.forWho,
        when: requestData.when,
        message: requestData.message,
        imageUrl: requestData.imageUrl,
        emojis: emojis,
        status: 'pending',
        createdAt: Date.now()
    };

    // حفظ الطلب
    const requests = existingRequests;
    requests.push(request);
    saveRoomRequests(requests);

    // إرسال الطلب لروم الطلبات
    const requestEmbed = colorManager.createEmbed()
        .setTitle(`${requestData.roomEmoji} **طلب روم : ${requestData.roomType} جديد**`)
        .setDescription(`**تم استلام طلب جديد :**`)
        .addFields([
            { name: 'صاحب الطلب', value: `<@${userId}>`, inline: true },
            { name: 'لمن؟', value: requestData.forWho, inline: true },
            { name: 'موعد الإنشاء', value: requestData.when, inline: true },
            { name: 'الرسالة', value: requestData.message, inline: false },
            { name: 'الإيموجيات', value: emojis.join(' '), inline: false },
            { name: 'معرف الطلب', value: `\`${request.id}\``, inline: false }
        ])
        .setTimestamp()
        .setFooter({ text: `طلب من : ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });

    // إضافة الصورة إذا كانت موجودة
    if (requestData.imageUrl) {
        requestEmbed.setImage(requestData.imageUrl);
    }

    const buttons = new ActionRowBuilder().addComponents([
        new ButtonBuilder()
            .setCustomId(`room_accept_${request.id}`)
            .setLabel(texts.requestAcceptLabel || 'Accept')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:emoji_41:1430334120839479449>'),
        new ButtonBuilder()
            .setCustomId(`room_reject_${request.id}`)
            .setLabel(texts.requestRejectLabel || 'Reject')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:emoji_39:1430334088924893275>')
    ]);

    await requestsChannel.send({ embeds: [requestEmbed], components: [buttons] });

    // تحديث رسالة السيتب لإعادة تعيين جميع المنيوهات (الروم + الألوان)
    try {
        const embedChannel = await client.channels.fetch(guildConfig.embedChannelId);
        const setupData = setupEmbedMessages.get(requestData.guildId);

        if (setupData && setupData.messageId && setupData.channelId === guildConfig.embedChannelId) {
            const setupMessage = await embedChannel.messages.fetch(setupData.messageId);

            // إعادة بناء جميع المنيوهات (الروم + الألوان) بدون اختيار افتراضي
            const freshMenus = createSetupMenus(message.guild, guildConfig);

            await setupMessage.edit({ components: freshMenus });
            console.log('✅ تم تحديث جميع منيوهات السيتب (الروم + الألوان) لإعادة تعيينها');
        }
    } catch (updateError) {
        console.error('❌ خطأ في تحديث منيوهات السيتب:', updateError);
    }

    // حذف رسالة الإيموجيات من المستخدم
    await message.delete().catch(() => {});

    // إرسال رد مخفي للمستخدم في الخاص
    try {
        let description = `**تم إرسال طلبك بنجاح!**\n\n${requestData.roomEmoji} نوع الروم : ${requestData.roomType}\n لـ : ${requestData.forWho}\n الموعد : ${requestData.when}\n لإيموجيات : ${emojis.join(' ')}`;

        if (requestData.imageUrl) {
            description += `\n الصورة : مضافة`;
        }

        description += `\n\nسيتم مراجعة طلبك وإبلاغك بالنتيجة قريباً`;

        const replyEmbed = colorManager.createEmbed()
            .setTitle('**تم إرسال الطلب**')
            .setDescription(description)
            .setTimestamp();

        if (requestData.imageUrl) {
            replyEmbed.setImage(requestData.imageUrl);
        }

        await message.author.send({ embeds: [replyEmbed] });
    } catch (error) {
        console.error('فشل في إرسال رسالة خاصة للمستخدم:', error);
    }
}

// معالجة قبول/رفض الطلب
async function handleRoomRequestAction(interaction, client) {
    const action = interaction.customId.startsWith('room_accept') ? 'accept' : 'reject';

    // استخراج الـ ID بشكل صحيح
    const prefix = action === 'accept' ? 'room_accept_' : 'room_reject_';
    const requestId = interaction.customId.substring(prefix.length);

    console.log(`🔍 محاولة ${action} للطلب: ${requestId}`);

    const config = loadRoomConfig();
    const guildConfig = ensureGuildRoomConfig(config, interaction.guild.id);
    const { BOT_OWNERS = [] } = interaction.client || {};

    if (!canReviewRoomRequest(interaction.member, guildConfig, action, interaction.user.id, BOT_OWNERS)) {
        await interaction.reply({ content: '❌ **ليس لديك صلاحية لهذا الإجراء**', flags: 64 });
        return;
    }

    const requests = loadRoomRequests();
    const requestIndex = requests.findIndex(r => r.id === requestId);

    console.log(`📊 عدد الطلبات: ${requests.length}, الموقع: ${requestIndex}`);

    if (requestIndex === -1) {
        console.log(`❌ لم يتم العثور على الطلب: ${requestId}`);
        console.log(`📋 الطلبات المتاحة: ${requests.map(r => r.id).join(', ')}`);
        await interaction.reply({ content: '❌ **لم يتم العثور على الطلب**', flags: 64 });
        return;
    }

    const request = requests[requestIndex];
    if (request.guildId !== interaction.guild.id) {
        await interaction.reply({ content: '❌ **هذا الطلب لا يخص هذا السيرفر**', flags: 64 });
        return;
    }

    if (request.status !== 'pending') {
        await interaction.reply({ content: `**هذا الطلب تم ${request.status === 'accepted' ? 'قبوله' : 'رفضه'} مسبقاً**`, flags: 64 });
        return;
    }

    // تحديث حالة الطلب
    requests[requestIndex].status = action === 'accept' ? 'accepted' : 'rejected';
    requests[requestIndex].reviewedBy = interaction.user.id;
    requests[requestIndex].reviewedAt = Date.now();
    saveRoomRequests(requests);

    // تحديث رسالة الطلب
    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(action === 'accept' ? '#00ff00' : '#ff0000')
        .addFields([
            { name: ' الحالة', value: action === 'accept' ? 'تم القبول' : 'تم الرفض', inline: true },
            { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
        ]);

    await interaction.update({ embeds: [updatedEmbed], components: [] });

    // إرسال إشعار لصاحب الطلب
    try {
        const requester = await client.users.fetch(request.userId);
        const roomEmoji = request.roomTypeEn === 'condolence' ? '🖤' : '🎂';

        const notificationEmbed = colorManager.createEmbed()
            .setTitle(`${action === 'accept' ? '✅' : '❌'} **${action === 'accept' ? 'تم قبول' : 'تم رفض'} طلبك**`)
            .setDescription(`**طلب روم ${request.roomType}**\n\n${roomEmoji} لـ : ${request.forWho}\n الموعد : ${request.when}\n\n${action === 'accept' ? 'سيتم إنشاء الروم في الوقت المحدد' : 'تم رفض طلبك'}`)
            .setTimestamp();

        await requester.send({ embeds: [notificationEmbed] });
    } catch (error) {
        console.error('فشل في إرسال الإشعار:', error);
    }

    // إذا تم القبول، جدولة إنشاء الروم
    if (action === 'accept') {
        await scheduleRoomCreation(request, client);
    }
}

// جدولة إنشاء الروم
async function scheduleRoomCreation(request, client) {
    const config = loadRoomConfig();
    const guildConfig = config[request.guildId];

    if (!guildConfig) {
        console.error(`❌ لم يتم العثور على إعدادات السيرفر ${request.guildId}`);
        return;
    }

    // تحليل الوقت
    const scheduleTime = parseScheduleTime(request.when);

    if (!scheduleTime) {
        console.error('❌ فشل في تحليل الوقت:', request.when);
        return;
    }

    // التحقق من أن الوقت في المستقبل
    if (scheduleTime <= new Date()) {
        console.log(`⚡ الوقت المحدد قد مضى، إنشاء الروم فوراً`);
        await createRoom(request, client, guildConfig);
        return;
    }

    // جدولة المهمة
    const job = schedule.scheduleJob(scheduleTime, async () => {
        console.log(`⏰ حان موعد إنشاء الروم: ${request.roomType} لـ ${request.forWho}`);
        await createRoom(request, client, guildConfig);
        activeSchedules.delete(request.id);
        saveSchedules(); // حفظ بعد حذف الجدولة
    });

    activeSchedules.set(request.id, job);
    saveSchedules(); // حفظ الجدولة الجديدة
    console.log(`✅ تم جدولة إنشاء روم ${request.roomType} للوقت: ${scheduleTime.toLocaleString('ar-SA')}`);
}

// إنشاء الروم
async function createRoom(request, client, guildConfig) {
    try {
        console.log(`🔄 بدء إنشاء روم: ${request.roomType} لـ ${request.forWho}`);

        const guild = await client.guilds.fetch(request.guildId);
        if (!guild) {
            console.error(`❌ السيرفر ${request.guildId} غير موجود`);
            return;
        }

        const targetUserId = extractTargetUserId(request.forWho);

        // استخراج اسم العرض (nickname) من forWho
        let displayName = request.forWho;

        // إذا كان منشن، جلب المعلومات من السيرفر
        const mentionMatch = request.forWho.match(/<@!?(\d+)>/);
        if (mentionMatch) {
            const userId = mentionMatch[1];
            try {
                const member = await guild.members.fetch(userId);
                // استخدام nickname إذا كان موجوداً، وإلا استخدام displayName
                displayName = member.nickname || member.user.displayName || member.user.username;
            } catch (err) {
                console.error('فشل في جلب معلومات المستخدم، استخدام النص الأصلي:', err);
                displayName = request.forWho.replace(/<@!?\d+>/g, '').trim() || 'مجهول';
            }
        }

        const roomName = `${request.roomTypeEn === 'condolence' ? 'دعاء' : 'hbd'}-${displayName.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '-')}`;

        // إنشاء الروم
        const channelOptions = {
            name: roomName,
            type: ChannelType.GuildText,
            reason: `طلب من ${request.userId}`
        };
        
        // إضافة الكاتيجوري إذا كان محدد
        if (guildConfig && guildConfig.roomsCategoryId) {
            const category = guild.channels.cache.get(guildConfig.roomsCategoryId) || await guild.channels.fetch(guildConfig.roomsCategoryId).catch(() => null);
            if (category && category.type === ChannelType.GuildCategory) {
                channelOptions.parent = guildConfig.roomsCategoryId;
            } else {
                console.warn(`⚠️ كاتقوري الرومات غير صالح في السيرفر ${guild.id}، سيتم إنشاء الروم بدون كاتقوري`);
            }
        }
        
        const channel = await guild.channels.create(channelOptions);

        console.log(`✅ تم إنشاء القناة: ${channel.name} (${channel.id})`);

        const latestRequests = loadRoomRequests();
        const requestIndex = latestRequests.findIndex(r => r.id === request.id && r.guildId === request.guildId);
        if (requestIndex !== -1) {
            latestRequests[requestIndex].roomCreatedAt = Date.now();
            latestRequests[requestIndex].roomChannelId = channel.id;
            saveRoomRequests(latestRequests);
        }

        const texts = getSetroomTexts(guildConfig);
        const prefix = (texts.roomContentPrefix || '@here').trim();
        const toLabel = (texts.roomToLabel || 'لـ').trim();
        const byLabel = (texts.roomByLabel || 'بواسطة').trim();
        const decoratedMessage = getFormattedRoomMessageBody(request.message);
        const roomContent = [
            prefix,
            decoratedMessage,
            `**${toLabel} : ${request.forWho}**`,
            `**${byLabel} : <@${request.userId}>**`
        ].filter(Boolean).join('\n\n');
        const sentMessage = await channel.send({ content: roomContent });
        console.log(`✅ تم إرسال رسالة عادية في الروم`);

        if (request.imageUrl) {
            await channel.send({ content: request.imageUrl }).catch((error) => {
                console.error('فشل في إرسال رابط الصورة داخل الروم:', error.message);
            });
        }

        roomEmbedMessages.set(channel.id, {
            messageId: sentMessage.id,
            channelId: channel.id,
            content: roomContent,
            emojis: request.emojis || [],
            request: request,
            imageUrl: request.imageUrl || null
        });

        // إضافة الريآكتات من الطلب
        const emojis = request.emojis || [];
        console.log(`📝 محاولة إضافة ${emojis.length} ريآكشن`);

        for (const reaction of emojis) {
            try {
                // محاولة إضافة الريآكت (يدعم Unicode والمخصص والخارجي)
                await sentMessage.react(reaction);
                console.log(`✅ تم إضافة ريآكت: ${reaction}`);
            } catch (error) {
                // إذا فشل، حاول استخراج الآيدي من الإيموجي المخصص
                const emojiIdMatch = reaction.match(/<a?:\w+:(\d+)>/);
                if (emojiIdMatch) {
                    try {
                        await sentMessage.react(emojiIdMatch[1]);
                        console.log(`✅ تم إضافة ريآكت بالآيدي: ${emojiIdMatch[1]}`);
                    } catch (err) {
                        console.error('فشل في إضافة الريآكت بالآيدي:', err.message);
                    }
                } else {
                    console.error('خطأ في إضافة الريآكت:', error.message);
                }
            }
        }

        // إعداد نظام الريآكت التلقائي
        activeRooms.set(channel.id, {
            guildId: request.guildId,
            createdAt: Date.now(),
            emojis: emojis,
            requestId: request.id,
            deleteAfterMs: getRoomDeletionMs(guildConfig)
        });
        saveActiveRooms();

        const deleteAfterMs = getRoomDeletionMs(guildConfig);
        const deleteAfterHours = (deleteAfterMs / (60 * 60 * 1000)).toFixed(2);
        scheduleRoomDeletion(channel.id, client, deleteAfterMs);
        console.log(`✅ تم إنشاء روم ${request.roomType} بنجاح: ${roomName} (سيتم حذفها تلقائياً بعد ${deleteAfterHours} ساعة)`);

        const notifyUserIds = new Set([request.userId]);
        if (targetUserId) notifyUserIds.add(targetUserId);

        for (const notifyUserId of notifyUserIds) {
            try {
                const notifyUser = await client.users.fetch(notifyUserId);
                if (!notifyUser) continue;

                const notificationEmbed = colorManager.createEmbed()
                    .setTitle('تم انشاء روم ميلاد/دعاء')
                    .setDescription(`**تم إنشاء روم خاص لك ${request.roomType}\n بواسطة <@${request.userId}>**`)
                    .addFields([
                        { name: 'الروم', value: `<#${channel.id}>`, inline: true },
                        { name: 'السيرفر', value: guild.name, inline: true }
                    ])
                    .setTimestamp();

                await notifyUser.send({ embeds: [notificationEmbed] });
                console.log(`✅ تم إرسال إشعار إنشاء الروم إلى ${notifyUserId}`);
            } catch (dmError) {
                console.error(`تعذر إرسال إشعار إنشاء الروم إلى ${notifyUserId}:`, dmError.message);
            }
        }

    } catch (error) {
        console.error('❌ خطأ في إنشاء الروم:', error);

        // محاولة إرسال إشعار بالخطأ لصاحب الطلب
        try {
            const requester = await client.users.fetch(request.userId);
            const errorEmbed = colorManager.createEmbed()
                .setTitle('❌ فشل في إنشاء الروم')
                .setDescription(`حدث خطأ أثناء إنشاء روم ${request.roomType}`)
                .addFields([
                    { name: 'السبب', value: error.message || 'خطأ غير معروف', inline: false }
                ])
                .setColor('#ff0000')
                .setTimestamp();

            await requester.send({ embeds: [errorEmbed] });
        } catch (dmError) {
            console.error('فشل في إرسال إشعار الخطأ:', dmError.message);
        }
    }
}

// إعداد نظام الريآكت التلقائي


// تحليل الوقت
function parseScheduleTime(timeString) {
    const moment = require('moment-timezone');
    const now = moment().tz('Asia/Riyadh');

    // تنظيف المدخل
    const cleanTime = timeString.trim().toLowerCase();

    // الآن أو فوراً أو دحين أو الحين
    if (cleanTime.includes('الآن') || cleanTime.includes('فوراً') || cleanTime.includes('فورا') || 
        cleanTime.includes('دحين') || cleanTime.includes('الحين') || cleanTime.includes('حين') ||
        cleanTime.includes('توني') || cleanTime === 'الان') {
        return now.clone().add(1, 'second').toDate();
    }

    // بعد X ثانية
    const secondsMatch = cleanTime.match(/بعد\s+(\d+)\s*ثوان[يی]?|بعد\s+ثانية/);
    if (secondsMatch) {
        const seconds = parseInt(secondsMatch[1] || 1);
        return now.clone().add(seconds, 'seconds').toDate();
    }

    // بعد X دقائق
    const minutesMatch = cleanTime.match(/بعد\s+(\d+)\s*دقائق?|بعد\s+دقيقة/);
    if (minutesMatch) {
        const minutes = parseInt(minutesMatch[1] || 1);
        return now.clone().add(minutes, 'minutes').toDate();
    }

    // بعد X ساعات
    const hoursMatch = cleanTime.match(/بعد\s+(\d+)\s*ساعات?|بعد\s+ساعة/);
    if (hoursMatch) {
        const hours = parseInt(hoursMatch[1] || 1);
        return now.clone().add(hours, 'hours').toDate();
    }

    // بعد X أيام
    const daysMatch = cleanTime.match(/بعد\s+(\d+)\s*أيام?|بعد\s+يوم/);
    if (daysMatch) {
        const days = parseInt(daysMatch[1] || 1);
        return now.clone().add(days, 'days').toDate();
    }

    // بكره (غداً) أو غدوة
    if (cleanTime.includes('بكره') || cleanTime.includes('بكرة') || cleanTime.includes('غدوة')) {
        const tomorrowMatch = cleanTime.match(/(\d+)\s*(صباحاً|مساءً|ص|م)?/);
        if (tomorrowMatch) {
            const hour = parseInt(tomorrowMatch[1]);
            const isPM = tomorrowMatch[2] && (tomorrowMatch[2].includes('مساء') || tomorrowMatch[2] === 'م');
            const targetHour = isPM && hour < 12 ? hour + 12 : hour;
            return now.clone().add(1, 'day').hour(targetHour).minute(0).second(0).millisecond(0).toDate();
        }
        return now.clone().add(1, 'day').hour(12).minute(0).second(0).millisecond(0).toDate();
    }

    // غداً أو غدا
    if (cleanTime.includes('غداً') || cleanTime.includes('غدا')) {
        const tomorrowMatch = cleanTime.match(/(\d+)\s*(صباحاً|مساءً|ص|م)?/);
        if (tomorrowMatch) {
            const hour = parseInt(tomorrowMatch[1]);
            const isPM = tomorrowMatch[2] && (tomorrowMatch[2].includes('مساء') || tomorrowMatch[2] === 'م');
            const targetHour = isPM && hour < 12 ? hour + 12 : hour;
            return now.clone().add(1, 'day').hour(targetHour).minute(0).second(0).millisecond(0).toDate();
        }
        return now.clone().add(1, 'day').hour(12).minute(0).second(0).millisecond(0).toDate();
    }

    // قبل شوي (بعد ساعة - كترجمة معكوسة)
    if (cleanTime.includes('قبل شوي') || cleanTime.includes('شوي')) {
        return now.clone().add(10, 'minutes').toDate();
    }

    // الساعة X
    const hourMatch = cleanTime.match(/(\d+)\s*(صباحاً|مساءً|ص|م)?/);
    if (hourMatch) {
        const hour = parseInt(hourMatch[1]);
        const isPM = hourMatch[2] && (hourMatch[2].includes('مساء') || hourMatch[2] === 'م');
        const targetHour = isPM && hour < 12 ? hour + 12 : hour;

        const targetDate = now.clone().hour(targetHour).minute(0).second(0).millisecond(0);

        // إذا كان الوقت قد مضى، اجعله غداً
        if (targetDate.isSameOrBefore(now)) {
            targetDate.add(1, 'day');
        }

        return targetDate.toDate();
    }

    // افتراضياً: بعد ساعة
    return now.clone().add(1, 'hour').toDate();
}

// معالجة اختيار الألوان
async function handleColorSelection(interaction, client) {
    try {
        // Acknowledge the interaction immediately to prevent "Unknown interaction" errors
        // by deferring the reply. Using an initial deferred reply ensures the interaction
        // does not time out while we perform potentially long-running role operations.
        if (!interaction.deferred && !interaction.replied) {
            try {
                await interaction.deferReply({ephemeral: true});
            } catch (deferErr) {
                // If defer fails (unlikely), log and continue; we'll attempt to reply directly later.
                console.error('فشل في deferReply عند اختيار اللون:', deferErr.message);
            }
        }
        const selectedValue = interaction.values[0];
        const guild = interaction.guild;
        const member = interaction.member;

        const config = loadRoomConfig();
        const guildConfig = config[guild.id];

        if (!guildConfig || !guildConfig.colorRoleIds) {
            // System not configured; update the deferred reply
            await interaction.editReply({ content: '❌ **النظام غير مُعد بعد!**' });
            return;
        }

        // إزالة جميع الألوان
        if (selectedValue === 'remove_all_colors') {
            const currentColorRoles = member.roles.cache.filter(role => 
                guildConfig.colorRoleIds.includes(role.id)
            );

            if (currentColorRoles.size === 0) {
                await interaction.editReply({ 
                    content: '✅ **ليس لديك أي رولات ألوان حالياً**'
                });
                return;
            }

            let removedCount = 0;
            for (const role of currentColorRoles.values()) {
                try {
                    await member.roles.remove(role);
                    removedCount++;
                } catch (error) {
                    console.error(`فشل إزالة الدور ${role.name}:`, error.message);
                }
            }

            const successEmbed = colorManager.createEmbed()
                .setTitle('✅ Done')
                .setDescription(`تم إزالة ${removedCount} رول لون من حسابك`);
            // Update the deferred reply with the removal confirmation embed
            await interaction.editReply({ embeds: [successEmbed] });

            // تحديث منيو الألوان بعد إزالة جميع الألوان
            try {
                const setupData = setupEmbedMessages.get(guild.id);
                if (setupData && setupData.messageId && setupData.channelId === guildConfig.embedChannelId) {
                    const embedChannel = await client.channels.fetch(guildConfig.embedChannelId);
                    const setupMessage = await embedChannel.messages.fetch(setupData.messageId);

                    const freshMenus = createSetupMenus(guild, guildConfig);
                    await setupMessage.edit({ components: freshMenus });
                    console.log(`✅ تم تحديث منيو الألوان بعد إزالة جميع الألوان`);
                }
            } catch (updateError) {
                console.error('❌ خطأ في تحديث منيو الألوان:', updateError.message);
            }

            return;
        }

        // اختيار لون جديد
        const selectedRole = guild.roles.cache.get(selectedValue);
        if (!selectedRole) {
            // Selected role not found
            await interaction.editReply({ content: '❌ **الدور غير موجود!**' });
            return;
        }

        const currentColorRoles = member.roles.cache.filter(role => 
            guildConfig.colorRoleIds.includes(role.id)
        );

        if (currentColorRoles.has(selectedValue)) {
            await interaction.editReply({ 
                content: `✅ **لديك هذا اللون بالفعل : ${selectedRole.name}**`
            });
            return;
        }

        // إزالة الأدوار القديمة
        for (const role of currentColorRoles.values()) {
            try {
                await member.roles.remove(role);
                console.log(`🗑️ تم إزالة الدور القديم: ${role.name} من ${member.user.tag}`);
            } catch (error) {
                console.error(`فشل إزالة الدور ${role.name}:`, error.message);
            }
        }

        // إضافة الدور الجديد
        try {
            await member.roles.add(selectedRole);

            const successEmbed = colorManager.createEmbed()
                .setTitle('✅ Done')
                .setDescription(`**اللون الجديد :** ${selectedRole.name}\n**الكود :** ${selectedRole.hexColor}`)
                .setColor(selectedRole.color);
            // Update the deferred reply with the success embed
            await interaction.editReply({ embeds: [successEmbed] });
            console.log(`✅ تم إضافة الدور ${selectedRole.name} لـ ${member.user.tag}`);

            // تحديث منيو الألوان في رسالة السيتب ليعود لحالته الافتراضية
            try {
                const setupData = setupEmbedMessages.get(guild.id);
                if (setupData && setupData.messageId && setupData.channelId === guildConfig.embedChannelId) {
                    const embedChannel = await client.channels.fetch(guildConfig.embedChannelId);
                    const setupMessage = await embedChannel.messages.fetch(setupData.messageId);

                    // إعادة بناء جميع المنيوهات (الروم + الألوان)
                    const freshMenus = createSetupMenus(guild, guildConfig);

                    await setupMessage.edit({ components: freshMenus });
                    console.log(`✅ تم تحديث منيو الألوان تلقائياً بعد الاختيار`);
                }
            } catch (updateError) {
                console.error('❌ خطأ في تحديث منيو الألوان:', updateError.message);
            }

        } catch (error) {
            console.error(`فشل إضافة الدور ${selectedRole.name}:`, error.message);
            await interaction.editReply({ 
                content: '❌ **فشل تغيير اللون! تأكد من أن البوت لديه الصلاحيات المناسبة.**'
            });
        }

    } catch (error) {
        console.error('خطأ في معالجة اختيار اللون:', error);
        // If something goes wrong after deferring, attempt to edit the reply with a generic error
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: '❌ **حدث خطأ!**' });
            } else {
                await interaction.reply({ content: '❌ **حدث خطأ!**', flags: 64 });
            }
        } catch (_) {
            // ignore additional errors
        }
    }
}

function getDefaultLayoutSettings() {
    return {
        boxOffsetX: 0,
        boxOffsetY: 0,
        boxScale: 1,
        boxGap: 1,
        textOffsetX: 0,
        textOffsetY: 0,
        textScale: 1,
        guildOffsetX: 0,
        guildOffsetY: 0,
        guildScale: 1,
        showText: true,
        guildBorderEnabled: true
    };
}


const SETROOM_PREVIEW_PRESETS = {
    very_small: { label: 'صغير جدًا', boxScale: 0.7, textScale: 0.75, boxGap: 0.85 },
    small: { label: 'صغير', boxScale: 0.85, textScale: 0.9, boxGap: 0.95 },
    large: { label: 'كبير', boxScale: 1.15, textScale: 1.1, boxGap: 1.05 },
    very_large: { label: 'كبير جدًا', boxScale: 1.35, textScale: 1.25, boxGap: 1.15 }
};

async function getSetroomDynamicLayoutSettings(guild, guildConfig = {}) {
    const defaultLayout = getDefaultLayoutSettings();
    const totalColors = guildConfig.colorRoleIds?.length || 0;
    const rows = Math.max(1, Math.ceil(totalColors / 10));

    let imageWidth = 1024;
    let imageHeight = 1024;

    try {
        let backgroundImage = null;

        if (guildConfig.localImagePath && fs.existsSync(guildConfig.localImagePath)) {
            backgroundImage = await loadImage(guildConfig.localImagePath);
        } else if (guildConfig.imageUrl) {
            const response = await fetch(guildConfig.imageUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            backgroundImage = await loadImage(Buffer.from(arrayBuffer));
        }

        if (backgroundImage) {
            imageWidth = backgroundImage.width || imageWidth;
            imageHeight = backgroundImage.height || imageHeight;
        }
    } catch (error) {
        console.error('⚠️ تعذر حساب المقاس الديناميكي، سيتم استخدام الوضع الافتراضي:', error.message);
    }

    const scaleFactor = imageWidth / 1024;
    const widthTarget = imageWidth * 0.82;
    const heightTarget = imageHeight * (rows > 1 ? 0.3 : 0.18);
    const widthBase = scaleFactor * ((60 * 10) + (12 * 9));
    const heightBase = scaleFactor * ((60 * rows) + (12 * Math.max(0, rows - 1)));

    const widthScale = widthBase > 0 ? widthTarget / widthBase : 1;
    const heightScale = heightBase > 0 ? heightTarget / heightBase : 1;
    const dynamicScale = Math.min(1.6, Math.max(0.85, Math.min(widthScale, heightScale)));

    return {
        ...defaultLayout,
        boxScale: Number(dynamicScale.toFixed(2)),
        boxGap: Number(Math.min(1.25, Math.max(0.85, dynamicScale * 0.92)).toFixed(2)),
        textScale: Number(Math.min(1.3, Math.max(0.9, dynamicScale * 0.95)).toFixed(2)),
        guildScale: Number(Math.min(1.35, Math.max(0.9, dynamicScale * 0.95)).toFixed(2))
    };
}

function applySetroomPreviewPreset(layout, presetKey) {
    const preset = SETROOM_PREVIEW_PRESETS[presetKey];
    if (!preset) return layout;
    return {
        ...layout,
        boxScale: preset.boxScale,
        textScale: preset.textScale,
        boxGap: preset.boxGap
    };
}

function ensureGuildRoomConfig(config, guildId) {
    if (!config[guildId]) config[guildId] = {};
    if (!config[guildId].layoutSettings) {
        config[guildId].layoutSettings = getDefaultLayoutSettings();
    }
    if (!Array.isArray(config[guildId].reviewAcceptRoleIds)) config[guildId].reviewAcceptRoleIds = [];
    if (!Array.isArray(config[guildId].reviewRejectRoleIds)) config[guildId].reviewRejectRoleIds = [];
    if (!Number.isFinite(Number(config[guildId].roomDeleteAfterHours))) config[guildId].roomDeleteAfterHours = DEFAULT_ROOM_DELETE_HOURS;
    if (!Number.isFinite(Number(config[guildId].rejectCooldownMinutes))) config[guildId].rejectCooldownMinutes = DEFAULT_REJECT_COOLDOWN_MINUTES;
    config[guildId].texts = { ...getDefaultSetroomTexts(), ...(config[guildId].texts || {}) };
    return config[guildId];
}

function getSetroomSummaryEmbed(guild, guildConfig = {}, actor = null) {
    const acceptRoles = guildConfig.reviewAcceptRoleIds?.length ? guildConfig.reviewAcceptRoleIds.map(id => `<@&${id}>`).join(', ') : 'Admins فقط';
    const rejectRoles = guildConfig.reviewRejectRoleIds?.length ? guildConfig.reviewRejectRoleIds.map(id => `<@&${id}>`).join(', ') : 'Admins فقط';
    const layout = { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) };
    const texts = getSetroomTexts(guildConfig);
    const deleteAfterHours = Number(guildConfig.roomDeleteAfterHours ?? DEFAULT_ROOM_DELETE_HOURS);
    const rejectCooldownMinutes = Number(guildConfig.rejectCooldownMinutes ?? DEFAULT_REJECT_COOLDOWN_MINUTES);

    const embed = colorManager.createEmbed()
        .setTitle(texts.panelTitle || '**SetRoom Control Panel**')
        .setDescription(texts.panelDescription || 'By Ahmed')
        .addFields(
            { name: 'روم الطلبات', value: guildConfig.requestsChannelId ? `<#${guildConfig.requestsChannelId}>` : 'غير محدد', inline: true },
            { name: 'روم السيتب', value: guildConfig.embedChannelId ? `<#${guildConfig.embedChannelId}>` : 'غير محدد', inline: true },
            { name: 'كاتقوري الرومات', value: guildConfig.roomsCategoryId ? `<#${guildConfig.roomsCategoryId}>` : 'بدون', inline: true },
            { name: 'الصورة', value: guildConfig.imageUrl ? 'محددة' : 'غير محددة', inline: true },
            { name: 'وضع الإيمبد', value: guildConfig.embedEnabled !== false ? 'مفعّل' : 'رسالة عادية', inline: true },
            { name: 'عدد رولات الألوان', value: `${guildConfig.colorRoleIds?.length || 0}`, inline: true },
            { name: 'رولات القبول', value: acceptRoles, inline: false },
            { name: 'رولات الرفض', value: rejectRoles, inline: false },
            { name: 'حذف الروم', value: `${deleteAfterHours} ساعة`, inline: true },
            { name: 'كولداون بعد الرفض', value: `${rejectCooldownMinutes} دقيقة`, inline: true },
            { name: 'نص الألوان', value: guildConfig.colorsTitle === '' ? 'مخفي' : `${guildConfig.colorsTitle || 'Colors list :'}
اللون: ${normalizeHexColor(guildConfig.textColor, '#ffffff')}`, inline: false },
            { name: 'افتار السيرفر', value: `الافتار: ${guildConfig.guildIconEnabled ? 'مفعّل' : 'مقفّل'}\nالإطار: ${layout.guildBorderEnabled === false ? 'مقفّل' : 'مفعّل'}`, inline: true },
            { name: 'تخصيص النصوص', value: `Room Menu: ${texts.roomMenuPlaceholder}\nColor Menu: ${texts.colorMenuPlaceholder}\nRoom Msg Prefix: ${texts.roomContentPrefix}`, inline: false },
            { name: 'المعاينة الحالية', value: `مربعات: X ${layout.boxOffsetX}, Y ${layout.boxOffsetY}, Scale ${layout.boxScale.toFixed(2)}, Gap ${layout.boxGap.toFixed(2)}\nالنص: X ${layout.textOffsetX}, Y ${layout.textOffsetY}, Scale ${layout.textScale.toFixed(2)}, ${layout.showText ? 'ظاهر' : 'مخفي'}\nالافتار: X ${layout.guildOffsetX}, Y ${layout.guildOffsetY}, Scale ${layout.guildScale.toFixed(2)}, إطار ${layout.guildBorderEnabled === false ? 'مقفّل' : 'مفعّل'}`, inline: false }
        )
        .setFooter({ text: 'SetRoom System' });

    if (actor) {
        embed.setAuthor({ name: actor.tag || actor.username, iconURL: actor.displayAvatarURL?.() || null });
    }

    return embed;
}

function createSetroomMainRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_panel_channels').setLabel('الرومات').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_roles').setLabel('رولات القبول/الرفض').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_safety').setLabel('كولداون').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_setup_texts').setLabel('نصوص السيتب').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_room_output').setLabel('رسالة الروم').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_panel_image').setLabel('الصورة').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_text').setLabel('نص الألوان').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_toggle_embed').setLabel('تبديل الإيمبد').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_refresh_colors').setLabel('تحديث الألوان').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_panel_preview').setLabel('معاينة').setStyle(ButtonStyle.Primary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_panel_publish').setLabel('حفظ وتعيين').setStyle(ButtonStyle.Success)
        )
    ];
}

function createSetroomPreviewRows(guildConfig = {}) {
    const layout = { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) };
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_preview_box_left').setLabel('مربعات ←').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_box_right').setLabel('مربعات →').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_box_up').setLabel('مربعات ↑').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_box_down').setLabel('مربعات ↓').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_box_scale_less').setLabel('مربعات -').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_preview_box_scale_more').setLabel('مربعات +').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_gap_less').setLabel('Gap - تقليل').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_gap_more').setLabel('Gap + زيادة').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_text_size_less').setLabel('نص -').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_text_size_more').setLabel('نص +').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_preview_text_left').setLabel('نص ←').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_text_right').setLabel('نص →').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_text_up').setLabel('نص ↑').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_text_down').setLabel('نص ↓').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_text_toggle').setLabel('إظهار/إخفاء النص').setStyle(ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_preview_guild_left').setLabel('افتار ←').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_guild_right').setLabel('افتار →').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_guild_up').setLabel('افتار ↑').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_guild_down').setLabel('افتار ↓').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_guild_scale_less').setLabel('افتار -').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setroom_preview_guild_scale_more').setLabel('افتار +').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setroom_preview_save').setLabel('حفظ').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setroom_preview_publish').setLabel('تعيين').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setroom_preview_back').setLabel('رجوع').setStyle(ButtonStyle.Secondary)
        )
    ];
}

function memberHasAnyRole(member, roleIds = []) {
    if (!member || !roleIds.length) return false;
    return roleIds.some(roleId => member.roles.cache.has(roleId));
}

function canManageSetroom(member, userId, botOwners = []) {
    return member?.permissions?.has(PermissionFlagsBits.Administrator) || botOwners.includes(userId);
}

function canReviewRoomRequest(member, guildConfig, action, userId, botOwners = []) {
    if (canManageSetroom(member, userId, botOwners)) return true;
    const roleIds = action === 'accept' ? (guildConfig.reviewAcceptRoleIds || []) : (guildConfig.reviewRejectRoleIds || []);
    return memberHasAnyRole(member, roleIds);
}

function getRoomRequestStatusLabel(status = 'pending') {
    if (status === 'accepted') return '✅ مقبول';
    if (status === 'rejected') return '❌ مرفوض';
    return '🕒 معلّق';
}

function clampEmbedText(text, maxLength = 1024) {
    const value = String(text || '');
    if (value.length <= maxLength) return value;
    if (maxLength <= 1) return '…';
    return `${value.slice(0, maxLength - 1)}…`;
}

function isRequestRoomCreated(request) {
    if (!request) return false;
    if (request.roomCreatedAt || request.roomChannelId) return true;
    for (const roomData of activeRooms.values()) {
        if (roomData?.requestId === request.id) return true;
    }
    return false;
}

function buildRequestFieldValue(request) {
    const messagePreviewRaw = (request.message || 'بدون').length > 180 ? `${request.message.slice(0, 180)}...` : (request.message || 'بدون');
    const emojisPreviewRaw = Array.isArray(request.emojis) && request.emojis.length ? request.emojis.join(' ') : 'None';
    const lines = [
        `**Status :** ${getRoomRequestStatusLabel(request.status)}`,
        `**Type :** ${String(request.roomType || 'غير محدد')}`,
        `**For :** ${String(request.forWho || 'غير محدد')}`,
        `**When :** ${String(request.when || 'غير محدد')}`,
        `**By :** <@${request.userId}>`,
        `**Message :** ${messagePreviewRaw}`,
        `**Emojis :** ${emojisPreviewRaw}`
    ];
    return clampEmbedText(lines.join('\n'), 1024);
}

function getSetroomRequestsManagerData(guildId) {
    const allRequests = loadRoomRequests()
        .filter(r => r.guildId === guildId)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pendingRequests = allRequests.filter(r => r.status === 'pending');
    return { allRequests, pendingRequests };
}

function buildSetroomRequestsManagerPayload(guildId, token, state = null) {
    const { allRequests, pendingRequests } = getSetroomRequestsManagerData(guildId);
    const deletableRequests = allRequests.filter(r => ['pending', 'accepted'].includes(r.status) && !isRequestRoomCreated(r));
    const acceptedCount = allRequests.filter(r => r.status === 'accepted').length;
    const rejectedCount = allRequests.filter(r => r.status === 'rejected').length;
    const latest = allRequests.slice(0, 6);
    const selectedDeleteCount = state?.selectedDeleteIds?.length || 0;
    const selectedEditId = state?.selectedEditId || null;

    const embed = colorManager.createEmbed()
        .setTitle('🧭 SetRoom Requests')
        .setDescription(clampEmbedText([
            `**Total : ${allRequests.length}**`,
            `**Pending : ${pendingRequests.length}**`,
            `**Accepted : ${acceptedCount}**`,
            `**Rejected : ${rejectedCount}**`,
            '',
            `**Can Delete : ${deletableRequests.length}**`,
            `**Selected for delete : ${selectedDeleteCount}**`,
            `**Selected for edit : ${selectedEditId ? `\`${selectedEditId}\`` : 'None'}**`,
            '',
            '**Use the selectors below, then run Delete or Edit.**'
        ].join('\n'), 4096))
        .setFooter({ text: 'SetRoom Requests Control' })
        .setTimestamp();

    if (!latest.length) {
        embed.addFields([{ name: 'No Requests', value: '**There are no requests in this server right now.**', inline: false }]);
    } else {
        for (const request of latest) {
            embed.addFields([{ name: `Request #${request.id}`, value: buildRequestFieldValue(request), inline: false }]);
        }
    }

    const deletableOptions = deletableRequests.slice(0, 25).map(req => ({
        label: clampEmbedText(`${req.roomType || 'روم'} • ${String(req.forWho || 'غير محدد').slice(0, 70)}`, 100),
        description: `ID: ${req.id}`.slice(0, 100),
        value: req.id
    }));
    const allOptions = allRequests.slice(0, 25).map(req => ({
        label: `${getRoomRequestStatusLabel(req.status)} • ${String(req.forWho || 'غير محدد').slice(0, 60)}`.slice(0, 100),
        description: `ID: ${req.id}`.slice(0, 100),
        value: req.id
    }));

    const deleteSelect = new StringSelectMenuBuilder()
        .setCustomId(`setroom_requests_delete_select_${token}`)
        .setPlaceholder('اختر طلبات (معلّقة/مقبولة غير منشأة) للحذف')
        .setMinValues(deletableOptions.length ? 1 : 0)
        .setMaxValues(Math.max(1, Math.min(25, deletableOptions.length || 1)))
        .setDisabled(!deletableOptions.length)
        .addOptions(deletableOptions.length ? deletableOptions : [{ label: 'لا توجد طلبات قابلة للحذف', value: 'none', description: 'المعلّق أو المقبول غير المنشأ فقط' }]);

    const editSelect = new StringSelectMenuBuilder()
        .setCustomId(`setroom_requests_edit_select_${token}`)
        .setPlaceholder('اختر طلبًا واحدًا للتعديل')
        .setMinValues(allOptions.length ? 1 : 0)
        .setMaxValues(1)
        .setDisabled(!allOptions.length)
        .addOptions(allOptions.length ? allOptions : [{ label: 'لا توجد طلبات', value: 'none', description: 'لا يوجد شيء للتعديل حالياً' }]);

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`setroom_requests_delete_${token}`).setLabel('Delete Selected').setStyle(ButtonStyle.Danger).setDisabled(!deletableOptions.length),
                new ButtonBuilder().setCustomId(`setroom_requests_edit_${token}`).setLabel('Edit Selected').setStyle(ButtonStyle.Primary).setDisabled(!allOptions.length),
                new ButtonBuilder().setCustomId(`setroom_requests_close_${token}`).setLabel('Close').setStyle(ButtonStyle.Secondary)
            ),
            new ActionRowBuilder().addComponents(deleteSelect),
            new ActionRowBuilder().addComponents(editSelect)
        ]
    };
}

async function openSetroomRequestsManager(message) {
    const token = `${message.author.id}_${Date.now().toString(36)}`;
    const state = {
        guildId: message.guild.id,
        ownerId: message.author.id,
        selectedDeleteIds: [],
        selectedEditId: null,
        createdAt: Date.now()
    };
    const payload = buildSetroomRequestsManagerPayload(message.guild.id, token, state);
    const panelMessage = await message.reply(payload);
    state.panelChannelId = panelMessage.channel.id;
    state.panelMessageId = panelMessage.id;
    setroomRequestsUiState.set(token, state);
    setTimeout(() => setroomRequestsUiState.delete(token), 15 * 60 * 1000);
}

async function handleSetroomListRequests(message, guildConfig) {
    const allRequests = loadRoomRequests().filter(r => r.guildId === message.guild.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (allRequests.length === 0) {
        await message.reply({ embeds: [colorManager.createEmbed().setTitle('📭 قائمة الطلبات').setDescription('لا توجد طلبات حالياً في هذا السيرفر.')] });
        return;
    }

    const pendingCount = allRequests.filter(r => r.status === 'pending').length;
    const acceptedCount = allRequests.filter(r => r.status === 'accepted').length;
    const rejectedCount = allRequests.filter(r => r.status === 'rejected').length;
    const latest = allRequests.slice(0, 8);

    const embed = colorManager.createEmbed()
        .setTitle('📋 قائمة طلبات SetRoom')
        .setDescription(clampEmbedText(`إجمالي الطلبات: **${allRequests.length}**\nمعلّق: **${pendingCount}** | مقبول: **${acceptedCount}** | مرفوض: **${rejectedCount}**`, 4096))
        .setFooter({ text: 'استخدم setroom delete لإزالة الطلبات المعلّقة أو setroom edit <id> للتعديل.' })
        .setTimestamp();

    for (const request of latest) {
        embed.addFields([{ name: `طلب #${request.id}`, value: buildRequestFieldValue(request), inline: false }]);
    }

    await message.reply({ embeds: [embed] });
}

async function handleSetroomDeleteRequests(message) {
    const requests = loadRoomRequests();
    const deletable = requests.filter(r => r.guildId === message.guild.id && ['pending', 'accepted'].includes(r.status) && !isRequestRoomCreated(r));
    if (!deletable.length) {
        await message.reply('✅ لا توجد طلبات قابلة للحذف حالياً (المتاح: معلّق أو مقبول غير منشأ).');
        return;
    }

    const options = deletable.slice(0, 25).map(req => ({
        label: clampEmbedText(`${req.roomType} • ${req.forWho}`, 100),
        description: `ID: ${req.id}`.slice(0, 100),
        value: req.id
    }));

    const select = new StringSelectMenuBuilder()
        .setCustomId(`setroom_delete_requests_${message.id}`)
        .setPlaceholder('اختر الطلبات المطلوب حذفها')
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 25))
        .addOptions(options);

    const confirmBtn = new ButtonBuilder()
        .setCustomId(`setroom_delete_confirm_${message.id}`)
        .setLabel('Delete Selected')
        .setStyle(ButtonStyle.Danger);

    const cancelBtn = new ButtonBuilder()
        .setCustomId(`setroom_delete_cancel_${message.id}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    const payload = await message.reply({
        embeds: [colorManager.createEmbed().setTitle('🗑️ حذف طلبات').setDescription('يمكنك حذف الطلبات المعلّقة أو المقبولة غير المنشأة فقط.')],
        components: [
            new ActionRowBuilder().addComponents(select),
            new ActionRowBuilder().addComponents(confirmBtn, cancelBtn)
        ]
    });

    const selected = new Set();
    const collector = payload.createMessageComponentCollector({ time: 120000 });

    collector.on('collect', async interaction => {
        if (interaction.user.id !== message.author.id) {
            await interaction.reply({ content: '❌ هذه الواجهة لصاحب الأمر فقط.', flags: 64 });
            return;
        }

        if (interaction.customId === `setroom_delete_requests_${message.id}`) {
            selected.clear();
            interaction.values.forEach(v => selected.add(v));
            await interaction.reply({ content: `✅ تم تحديد ${selected.size} طلب للحذف.`, flags: 64 });
            return;
        }

        if (interaction.customId === `setroom_delete_cancel_${message.id}`) {
            collector.stop('cancelled');
            await interaction.update({ content: 'تم إلغاء عملية الحذف.', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === `setroom_delete_confirm_${message.id}`) {
            if (!selected.size) {
                await interaction.reply({ content: '❌ اختر طلباً واحداً على الأقل قبل الحذف.', flags: 64 });
                return;
            }
            const latestRequests = loadRoomRequests();
            const selectedIds = [...selected];
            const toDelete = latestRequests.filter(r => r.guildId === message.guild.id && ['pending', 'accepted'].includes(r.status) && !isRequestRoomCreated(r) && selectedIds.includes(r.id));
            const updated = latestRequests.filter(r => !toDelete.some(d => d.id === r.id));
            saveRoomRequests(updated);
            collector.stop('done');
            await interaction.update({ content: `✅ تم حذف ${toDelete.length} طلب/طلبات بنجاح.`, embeds: [], components: [] });
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'time') {
            await payload.edit({ content: '⏳ انتهى وقت اختيار الطلبات.', embeds: [], components: [] }).catch(() => null);
        }
    });
}

async function handleSetroomEditRequest(message, requestId, guildConfig) {
    if (!requestId) {
        await message.reply('❌ استخدم: `setroom edit <requestId>`');
        return;
    }

    const requests = loadRoomRequests();
    const requestIndex = requests.findIndex(r => r.id === requestId && r.guildId === message.guild.id);
    if (requestIndex === -1) {
        await message.reply('❌ لم يتم العثور على الطلب بهذا المعرّف.');
        return;
    }

    const request = requests[requestIndex];
    const { BOT_OWNERS = [] } = message.client || {};
    const canEditAccepted = canReviewRoomRequest(message.member, guildConfig, 'accept', message.author.id, BOT_OWNERS);
    const canEditRejected = canReviewRoomRequest(message.member, guildConfig, 'reject', message.author.id, BOT_OWNERS);
    if (!canEditAccepted && !canEditRejected) {
        await message.reply('❌ ليس لديك صلاحية تعديل الطلبات.');
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`setroom_edit_modal_${request.id}_${message.author.id}`)
        .setTitle('تعديل طلب SetRoom');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('for_who').setLabel('الطلب لمن؟').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(request.forWho || '').slice(0, 100))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('when').setLabel('موعد الإنشاء').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(request.when || '').slice(0, 100))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('الرسالة').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(String(request.message || '').slice(0, 1000))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('رابط الصورة (اختياري - 0 للإزالة)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(request.imageUrl || '').slice(0, 200))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emojis').setLabel('الإيموجيات (0 = بدون)').setStyle(TextInputStyle.Short).setRequired(false).setValue(Array.isArray(request.emojis) && request.emojis.length ? request.emojis.join(' ') : '0').setMaxLength(200))
    );

    await message.reply({ content: 'ℹ️ افتح نافذة التعديل من الزر التالي.', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setroom_edit_open_${request.id}_${message.author.id}`).setLabel('Edit Request').setStyle(ButtonStyle.Primary))] });

    const channelCollector = message.channel.createMessageComponentCollector({ time: 60000 });
    channelCollector.on('collect', async interaction => {
        if (interaction.customId !== `setroom_edit_open_${request.id}_${message.author.id}`) return;
        if (interaction.user.id !== message.author.id) {
            await interaction.reply({ content: '❌ هذا الزر لصاحب الأمر فقط.', flags: 64 });
            return;
        }
        channelCollector.stop('opened');
        await interaction.showModal(modal);
    });
}

async function buildSetroomPanelPayload(guild, guildConfig, actor, extra = {}) {
    const embed = getSetroomSummaryEmbed(guild, guildConfig, actor);
    const components = extra.preview ? createSetroomPreviewRows(guildConfig) : createSetroomMainRows();
    const payload = { embeds: [embed], components };

    if (extra.preview) {
        const previewPath = await createColorsImage(guild, guildConfig);
        if (previewPath && fs.existsSync(previewPath)) {
            const attachment = new AttachmentBuilder(previewPath, { name: 'setroom_preview.png' });
            embed.setImage('attachment://setroom_preview.png');
            payload.files = [attachment];
        } else {
            embed.setImage(null);
        }
    }

    if (extra.payload) Object.assign(payload, extra.payload);
    return payload;
}

async function refreshSetroomPanelMessage(interaction, guildConfig, extra = {}) {
    const payload = await buildSetroomPanelPayload(interaction.guild, guildConfig, interaction.user, extra);
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
    }
    if (interaction.isButton() || interaction.isAnySelectMenu?.()) {
        return interaction.update(payload);
    }
    return interaction.reply({ ...payload, flags: 64 });
}

async function refreshSetroomPanelIfPossible(interaction, guildConfig, extra = {}) {
    try {
        if (interaction.message && interaction.message.id) {
            const payload = await buildSetroomPanelPayload(interaction.guild, guildConfig, interaction.user, extra);
            await interaction.message.edit(payload).catch(() => null);
        }
    } catch (error) {
        console.error('⚠️ تعذر تحديث رسالة لوحة setroom تلقائيًا:', error.message);
    }
}

async function syncSetupMessageForGuild(guild, client) {
    const config = loadRoomConfig();
    const guildConfig = ensureGuildRoomConfig(config, guild.id);
    saveRoomConfig(config);
    if (!guildConfig.embedChannelId) return false;
    return resendSetupEmbed(guild.id, client);
}

// تسجيل معالجات التفاعلات
function registerHandlers(client) {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu() && !interaction.isModalSubmit() && !interaction.isButton() && !interaction.isChannelSelectMenu() && !interaction.isRoleSelectMenu()) return;

        try {
            if (interaction.isStringSelectMenu() && interaction.customId === 'room_type_menu') {
                await handleRoomRequestMenu(interaction, client);
                return;
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'color_selection_menu') {
                await handleColorSelection(interaction, client);
                return;
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('room_modal_')) {
                await handleRoomModalSubmit(interaction, client);
                return;
            }

            if (interaction.isButton() && (interaction.customId.startsWith('room_accept_') || interaction.customId.startsWith('room_reject_'))) {
                await handleRoomRequestAction(interaction, client);
                return;
            }

            if (!interaction.customId.startsWith('setroom_')) return;

            const { BOT_OWNERS = [] } = interaction.client || {};
            if (!canManageSetroom(interaction.member, interaction.user.id, BOT_OWNERS)) {
                await interaction.reply({ content: '❌ ليس لديك صلاحية تعديل إعدادات setroom.', flags: 64 });
                return;
            }

            const config = loadRoomConfig();
            const guildConfig = getGuildConfigWithDefaults(config, interaction.guild.id);

            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('setroom_requests_')) {
                const token = interaction.customId.split('_').slice(-2).join('_');
                const state = setroomRequestsUiState.get(token);
                if (!state || state.guildId !== interaction.guild.id) {
                    await interaction.reply({ content: '❌ **انتهت صلاحية واجهة الطلبات. نفذ الأمر مرة أخرى.**', flags: 64 });
                    return;
                }
                if (interaction.user.id !== state.ownerId) {
                    await interaction.reply({ content: '❌ **واجهة الطلبات هذه مخصصة لصاحب الأمر فقط.**', flags: 64 });
                    return;
                }

                if (interaction.customId.startsWith('setroom_requests_delete_select_')) {
                    state.selectedDeleteIds = interaction.values.filter(v => v !== 'none');
                    setroomRequestsUiState.set(token, state);
                    await interaction.update(buildSetroomRequestsManagerPayload(interaction.guild.id, token, state));
                    await interaction.followUp({ content: `✅ **تم تحديث الاختيار : ${state.selectedDeleteIds.length} طلب/طلبات للحذف.**`, flags: 64 });
                    return;
                }

                if (interaction.customId.startsWith('setroom_requests_edit_select_')) {
                    state.selectedEditId = interaction.values[0] === 'none' ? null : interaction.values[0];
                    setroomRequestsUiState.set(token, state);
                    await interaction.update(buildSetroomRequestsManagerPayload(interaction.guild.id, token, state));
                    await interaction.followUp({ content: state.selectedEditId ? `✅ **تم اختيار الطلب \`${state.selectedEditId}\` للتعديل.**` : 'ℹ️ **لا يوجد طلب محدد للتعديل.**', flags: 64 });
                    return;
                }
            }

            if (interaction.isButton()) {
                const customId = interaction.customId;

                if (customId.startsWith('setroom_requests_')) {
                    const token = customId.split('_').slice(-2).join('_');
                    const state = setroomRequestsUiState.get(token);
                    if (!state || state.guildId !== interaction.guild.id) {
                        await interaction.reply({ content: '❌ **انتهت صلاحية واجهة الطلبات. نفذ الأمر مرة أخرى.**', flags: 64 });
                        return;
                    }
                    if (interaction.user.id !== state.ownerId) {
                        await interaction.reply({ content: '❌ **واجهة الطلبات هذه مخصصة لصاحب الأمر فقط.**', flags: 64 });
                        return;
                    }

                    if (customId.startsWith('setroom_requests_delete_')) {
                        if (!state.selectedDeleteIds.length) {
                            await interaction.reply({ content: '❌ **اختر الطلبات المعلّقة أولًا من قائمة الحذف.**', flags: 64 });
                            return;
                        }

                        const latestRequests = loadRoomRequests();
                        const toDelete = latestRequests.filter(r => r.guildId === interaction.guild.id && ['pending', 'accepted'].includes(r.status) && !isRequestRoomCreated(r) && state.selectedDeleteIds.includes(r.id));
                        if (!toDelete.length) {
                            state.selectedDeleteIds = [];
                            setroomRequestsUiState.set(token, state);
                            await interaction.update(buildSetroomRequestsManagerPayload(interaction.guild.id, token, state));
                            await interaction.followUp({ content: '⚠️ **لم يتم حذف أي طلب لأن العناصر المحددة لم تعد قابلة للحذف أو غير موجودة.**', flags: 64 });
                            return;
                        }
                        const updated = latestRequests.filter(r => !toDelete.some(d => d.id === r.id));
                        const saved = saveRoomRequests(updated);
                        if (!saved) {
                            await interaction.reply({ content: '❌ **فشل حفظ التغييرات أثناء الحذف. حاول مرة أخرى.**', flags: 64 });
                            return;
                        }
                        state.selectedDeleteIds = [];
                        setroomRequestsUiState.set(token, state);

                        await interaction.update(buildSetroomRequestsManagerPayload(interaction.guild.id, token, state));
                        await interaction.followUp({ content: `✅ **تم حذف ${toDelete.length} طلب/طلبات بنجاح.**`, flags: 64 });
                        return;
                    }

                    if (customId.startsWith('setroom_requests_edit_')) {
                        if (!state.selectedEditId) {
                            await interaction.reply({ content: '❌ **اختر الطلب المطلوب تعديله أولًا من قائمة التعديل.**', flags: 64 });
                            return;
                        }
                        const requests = loadRoomRequests();
                        const request = requests.find(r => r.id === state.selectedEditId && r.guildId === interaction.guild.id);
                        if (!request) {
                            await interaction.reply({ content: '❌ **الطلب المختار غير موجود.**', flags: 64 });
                            return;
                        }

                        const modal = new ModalBuilder()
                            .setCustomId(`setroom_edit_modal_${request.id}_${interaction.user.id}`)
                            .setTitle('تعديل طلب SetRoom');
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('for_who').setLabel('الطلب لمن؟').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(request.forWho || '').slice(0, 100))),
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('when').setLabel('موعد الإنشاء').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(request.when || '').slice(0, 100))),
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('الرسالة').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(String(request.message || '').slice(0, 1000))),
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('رابط الصورة (اختياري - 0 للإزالة)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(request.imageUrl || '').slice(0, 200))),
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emojis').setLabel('الإيموجيات (0 = بدون)').setStyle(TextInputStyle.Short).setRequired(false).setValue(Array.isArray(request.emojis) && request.emojis.length ? request.emojis.join(' ') : '0').setMaxLength(200))
                        );
                        await interaction.showModal(modal);
                        return;
                    }

                    if (customId.startsWith('setroom_requests_close_')) {
                        setroomRequestsUiState.delete(token);
                        await interaction.update({
                            embeds: [colorManager.createEmbed().setTitle('✅ SetRoom Requests Closed').setDescription('**The requests manager has been closed. Run `setroom requests` to open it again.**')],
                            components: []
                        });
                        return;
                    }
                }

                if (customId === 'setroom_panel_channels') {
                    const rows = [
                        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setroom_select_requests_channel').setPlaceholder('اختر روم الطلبات').setChannelTypes(ChannelType.GuildText).setMaxValues(1)),
                        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setroom_select_embed_channel').setPlaceholder('اختر روم السيتب').setChannelTypes(ChannelType.GuildText).setMaxValues(1)),
                        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('setroom_select_category').setPlaceholder('اختر كاتقوري الرومات').setChannelTypes(ChannelType.GuildCategory).setMaxValues(1))
                    ];
                    await interaction.reply({ content: 'حدّد القنوات من القوائم التالية.', components: rows, flags: 64 });
                    return;
                }

                if (customId === 'setroom_panel_roles') {
                    const rows = [
                        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setroom_select_accept_roles').setPlaceholder('رولات مسؤولة عن القبول').setMinValues(0).setMaxValues(10)),
                        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setroom_select_reject_roles').setPlaceholder('رولات مسؤولة عن الرفض').setMinValues(0).setMaxValues(10))
                    ];
                    await interaction.reply({ content: 'اختر الرولات المسؤولة عن القبول والرفض. تركها فارغة يعني Admins فقط.', components: rows, flags: 64 });
                    return;
                }

                if (customId === 'setroom_panel_safety') {
                    const modal = new ModalBuilder().setCustomId('setroom_modal_safety').setTitle('أمان وكولداون الطلبات');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('delete_after_hours')
                                .setLabel('حذف الروم بعد كم ساعة؟')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                                .setPlaceholder(`من ${MIN_ROOM_DELETE_HOURS} إلى ${MAX_ROOM_DELETE_HOURS}`)
                                .setValue(String(guildConfig.roomDeleteAfterHours ?? DEFAULT_ROOM_DELETE_HOURS))
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('reject_cooldown_minutes')
                                .setLabel('كولداون بعد الرفض (دقيقة)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                                .setPlaceholder(`من ${MIN_REJECT_COOLDOWN_MINUTES} إلى ${MAX_REJECT_COOLDOWN_MINUTES}`)
                                .setValue(String(guildConfig.rejectCooldownMinutes ?? DEFAULT_REJECT_COOLDOWN_MINUTES))
                        )
                    );
                    await interaction.showModal(modal);
                    return;
                }

                if (customId === 'setroom_panel_image') {
                    const modal = new ModalBuilder().setCustomId('setroom_modal_image').setTitle('تحديث صورة setroom');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('رابط الصورة').setStyle(TextInputStyle.Short).setRequired(true).setValue(guildConfig.imageUrl || '')));
                    await interaction.showModal(modal);
                    return;
                }

                if (customId === 'setroom_panel_text') {
                    const modal = new ModalBuilder().setCustomId('setroom_modal_text').setTitle('تحديث نص الألوان');
                    const layout = { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) };
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('colors_title').setLabel('نص الألوان').setStyle(TextInputStyle.Short).setRequired(false).setValue(guildConfig.colorsTitle || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text_color').setLabel('لون النص HEX').setStyle(TextInputStyle.Short).setRequired(false).setValue(normalizeHexColor(guildConfig.textColor, '#ffffff')).setPlaceholder('#FFFFFF')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('guild_toggle').setLabel('تفعيل افتار السيرفر').setStyle(TextInputStyle.Short).setRequired(false).setValue(guildConfig.guildIconEnabled ? 'on' : 'off').setPlaceholder('on / off')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('guild_border_toggle').setLabel('إطار افتار السيرفر').setStyle(TextInputStyle.Short).setRequired(false).setValue(layout.guildBorderEnabled === false ? 'off' : 'on').setPlaceholder('on / off'))
                    );
                    await interaction.showModal(modal);
                    return;
                }

                if (customId === 'setroom_panel_setup_texts') {
                    const texts = getSetroomTexts(guildConfig);
                    const modal = new ModalBuilder().setCustomId('setroom_modal_setup_texts').setTitle('تخصيص نصوص السيتب');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('setup_title').setLabel('عنوان السيتب').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.setupTitle || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('setup_description').setLabel('وصف السيتب').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(texts.setupDescription || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('room_placeholder').setLabel('Placeholder منيو الروم').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.roomMenuPlaceholder || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color_placeholder').setLabel('Placeholder منيو الألوان').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.colorMenuPlaceholder || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('setup_footer').setLabel('فوتر السيتب').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.setupFooter || ''))
                    );
                    await interaction.showModal(modal);
                    return;
                }

                if (customId === 'setroom_panel_room_output') {
                    const texts = getSetroomTexts(guildConfig);
                    const modal = new ModalBuilder().setCustomId('setroom_modal_room_output').setTitle('تخصيص رسالة الروم');
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('room_prefix').setLabel('مقدمة الرسالة').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.roomContentPrefix || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('room_to_label').setLabel('وسم لمن').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.roomToLabel || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('room_by_label').setLabel('وسم بواسطة').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.roomByLabel || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('accept_label').setLabel('نص زر القبول').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.requestAcceptLabel || '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reject_label').setLabel('نص زر الرفض').setStyle(TextInputStyle.Short).setRequired(false).setValue(texts.requestRejectLabel || ''))
                    );
                    await interaction.showModal(modal);
                    return;
                }

                if (customId === 'setroom_panel_toggle_embed') {
                    guildConfig.embedEnabled = guildConfig.embedEnabled === false;
                    saveRoomConfig(config);
                    await refreshSetroomPanelMessage(interaction, guildConfig);
                    return;
                }

                if (customId === 'setroom_panel_refresh_colors') {
                    saveRoomConfig(config);
                    await updateSetupEmbed(interaction.guild.id, client);
                    await refreshSetroomPanelMessage(interaction, guildConfig);
                    return;
                }

                if (customId === 'setroom_panel_publish') {
                    saveRoomConfig(config);
                    await syncSetupMessageForGuild(interaction.guild, client).catch(() => false);
                    await interaction.reply({ content: '✅ تم حفظ الإعدادات وتعيين/تحديث رسالة السيتب.', flags: 64 });
                    return;
                }

                if (customId === 'setroom_panel_preview') {
                    await refreshSetroomPanelMessage(interaction, guildConfig, { preview: true });
                    return;
                }

                if (customId === 'setroom_preview_back') {
                    await refreshSetroomPanelMessage(interaction, guildConfig);
                    return;
                }


                if (customId === 'setroom_preview_save') {
                    saveRoomConfig(config);
                    await interaction.reply({ content: '✅ تم حفظ إعدادات المعاينة.', flags: 64 });
                    return;
                }

                if (customId === 'setroom_preview_publish') {
                    saveRoomConfig(config);
                    await syncSetupMessageForGuild(interaction.guild, client).catch(() => false);
                    await interaction.reply({ content: '✅ تم حفظ المعاينة وتعيينها على رسالة السيتب.', flags: 64 });
                    return;
                }
                if (customId.startsWith('setroom_preview_')) {
                    const layout = { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) };
                    switch (customId) {
                        case 'setroom_preview_box_left': layout.boxOffsetX -= 10; break;
                        case 'setroom_preview_box_right': layout.boxOffsetX += 10; break;
                        case 'setroom_preview_box_up': layout.boxOffsetY -= 10; break;
                        case 'setroom_preview_box_down': layout.boxOffsetY += 10; break;
                        case 'setroom_preview_box_scale_less': layout.boxScale = Math.max(0.3, Number((layout.boxScale - 0.02).toFixed(2))); break;
                        case 'setroom_preview_box_scale_more': layout.boxScale = Math.min(3, Number((layout.boxScale + 0.02).toFixed(2))); break;
                        case 'setroom_preview_gap_less': layout.boxGap = Math.max(SETROOM_GAP_MIN, Number((layout.boxGap - SETROOM_GAP_STEP).toFixed(2))); break;
                        case 'setroom_preview_gap_more': layout.boxGap = Math.min(SETROOM_GAP_MAX, Number((layout.boxGap + SETROOM_GAP_STEP).toFixed(2))); break;
                        case 'setroom_preview_text_size_less':
                            layout.textScale = Math.max(0.3, Number((layout.textScale - SETROOM_TEXT_SCALE_STEP).toFixed(2)));
                            break;
                        case 'setroom_preview_text_size_more':
                            layout.textScale = Math.min(3, Number((layout.textScale + SETROOM_TEXT_SCALE_STEP).toFixed(2)));
                            break;
                        case 'setroom_preview_text_left': layout.textOffsetX += SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_text_right': layout.textOffsetX -= SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_text_up': layout.textOffsetY += SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_text_down': layout.textOffsetY -= SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_text_toggle': layout.showText = !layout.showText; break;
                        case 'setroom_preview_guild_left': layout.guildOffsetX -= SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_guild_right': layout.guildOffsetX += SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_guild_up': layout.guildOffsetY -= SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_guild_down': layout.guildOffsetY += SETROOM_TEXT_MOVE_STEP; break;
                        case 'setroom_preview_guild_scale_less': layout.guildScale = Math.max(0.3, Number((layout.guildScale - SETROOM_TEXT_SCALE_STEP).toFixed(2))); break;
                        case 'setroom_preview_guild_scale_more': layout.guildScale = Math.min(3, Number((layout.guildScale + SETROOM_TEXT_SCALE_STEP).toFixed(2))); break;
                    }
                    guildConfig.layoutSettings = layout;
                    saveRoomConfig(config);
                    await refreshSetroomPanelMessage(interaction, guildConfig, { preview: true });
                    return;
                }
            }

            if (interaction.isChannelSelectMenu()) {
                if (interaction.customId === 'setroom_select_requests_channel') guildConfig.requestsChannelId = interaction.values[0] || null;
                if (interaction.customId === 'setroom_select_embed_channel') guildConfig.embedChannelId = interaction.values[0] || null;
                if (interaction.customId === 'setroom_select_category') guildConfig.roomsCategoryId = interaction.values[0] || null;
                saveRoomConfig(config);
                await refreshSetroomPanelIfPossible(interaction, guildConfig);
                await interaction.reply({ content: '✅ تم حفظ القناة المطلوبة.', flags: 64 });
                return;
            }

            if (interaction.isRoleSelectMenu()) {
                if (interaction.customId === 'setroom_select_accept_roles') guildConfig.reviewAcceptRoleIds = interaction.values;
                if (interaction.customId === 'setroom_select_reject_roles') guildConfig.reviewRejectRoleIds = interaction.values;
                saveRoomConfig(config);
                await refreshSetroomPanelIfPossible(interaction, guildConfig);
                await interaction.reply({ content: '✅ تم حفظ الرولات المسؤولة.', flags: 64 });
                return;
            }

            if (interaction.isModalSubmit()) {
                if (interaction.customId.startsWith('setroom_edit_modal_')) {
                    const match = interaction.customId.match(/^setroom_edit_modal_(.+)_(\d{16,20})$/);
                    if (!match) {
                        await interaction.reply({ content: '❌ معرف تعديل الطلب غير صالح.', flags: 64 });
                        return;
                    }

                    const requestId = match[1];
                    const ownerId = match[2];
                    if (interaction.user.id !== ownerId) {
                        await interaction.reply({ content: '❌ هذا النموذج ليس لك.', flags: 64 });
                        return;
                    }

                    const requests = loadRoomRequests();
                    const requestIndex = requests.findIndex(r => r.id === requestId && r.guildId === interaction.guild.id);
                    if (requestIndex === -1) {
                        await interaction.reply({ content: '❌ الطلب غير موجود أو تم حذفه.', flags: 64 });
                        return;
                    }

                    const editedForWho = interaction.fields.getTextInputValue('for_who').trim();
                    const editedWhen = interaction.fields.getTextInputValue('when').trim();
                    const editedMessage = interaction.fields.getTextInputValue('message').trim();
                    const editedImageUrlInput = interaction.fields.getTextInputValue('image_url').trim();
                    const editedEmojisInput = interaction.fields.getTextInputValue('emojis').trim();
                    const shouldClearImage = ['0', 'remove', 'none', 'null'].includes(editedImageUrlInput.toLowerCase());
                    const finalImageUrl = shouldClearImage ? '' : editedImageUrlInput;

                    const errors = [];
                    if (editedForWho.length < 2 || editedForWho.length > 50) errors.push('حقل "لمن" يجب أن يكون بين 2 و 50 حرف.');
                    if (editedWhen.length < 2 || editedWhen.length > 100) errors.push('حقل "الوقت" يجب أن يكون بين 2 و 100 حرف.');
                    if (editedMessage.length < 5 || editedMessage.length > 1000) errors.push('حقل "الرسالة" يجب أن يكون بين 5 و 1000 حرف.');
                    if (finalImageUrl) {
                        const imageUrlPattern = /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|bmp)/i;
                        if (!imageUrlPattern.test(finalImageUrl)) errors.push('رابط الصورة غير صالح.');
                    }

                    const parsed = extractEmojisFromText(editedEmojisInput || '0');
                    if (!parsed.disableEmojis && parsed.emojis.length > 20) errors.push('الحد الأقصى للإيموجيات هو 20.');

                    if (errors.length) {
                        await interaction.reply({ content: `❌ **Unable to save edit :**\n**- ${errors.join('\n- ')}**`, flags: 64 });
                        return;
                    }

                    const normalizedMention = await formatUserMention(editedForWho, interaction.guild);
                    if (hasConflictingRoomRequest(requests, interaction.guild.id, normalizedMention, editedWhen, requestId)) {
                        await interaction.reply({ content: '❌ **يوجد طلب معلّق/مقبول بنفس الشخص ونفس الوقت. عدّل الوقت أو الشخص أولاً.**', flags: 64 });
                        return;
                    }
                    const normalizedEmojis = parsed.disableEmojis ? [] : await normalizeRequestedEmojis(interaction.guild, parsed.emojis);
                    requests[requestIndex] = {
                        ...requests[requestIndex],
                        forWho: normalizedMention,
                        when: editedWhen,
                        message: editedMessage,
                        imageUrl: finalImageUrl || null,
                        emojis: normalizedEmojis,
                        updatedAt: Date.now(),
                        updatedBy: interaction.user.id
                    };
                    const saved = saveRoomRequests(requests);
                    if (!saved) {
                        await interaction.reply({ content: '❌ **فشل حفظ التعديل في قاعدة الطلبات. حاول مرة أخرى.**', flags: 64 });
                        return;
                    }

                    const matchingStateEntry = [...setroomRequestsUiState.entries()].find(([, value]) =>
                        value.guildId === interaction.guild.id &&
                        value.ownerId === interaction.user.id
                    );
                    if (matchingStateEntry) {
                        const [token, state] = matchingStateEntry;
                        state.selectedEditId = requestId;
                        setroomRequestsUiState.set(token, state);
                        if (state.panelChannelId && state.panelMessageId) {
                            const panelChannel = await interaction.client.channels.fetch(state.panelChannelId).catch(() => null);
                            if (panelChannel?.messages?.fetch) {
                                const panelMessage = await panelChannel.messages.fetch(state.panelMessageId).catch(() => null);
                                if (panelMessage) {
                                    await panelMessage.edit(buildSetroomRequestsManagerPayload(interaction.guild.id, token, state)).catch(() => null);
                                }
                            }
                        }
                    }
                    await interaction.reply({ content: `✅ **تم تحديث الطلب \`${requestId}\` بنجاح.**`, flags: 64 });
                    return;
                }

                if (interaction.customId === 'setroom_modal_image') {
                    const imageUrl = interaction.fields.getTextInputValue('image_url').trim();
                    guildConfig.imageUrl = imageUrl;
                    const localPath = await saveImageLocally(imageUrl, interaction.guild.id);
                    if (localPath) guildConfig.localImagePath = localPath;
                    saveRoomConfig(config);
                    await refreshSetroomPanelIfPossible(interaction, guildConfig);
                    await interaction.reply({ content: '✅ تم تحديث الصورة.', flags: 64 });
                    return;
                }
                if (interaction.customId === 'setroom_modal_text') {
                    guildConfig.colorsTitle = interaction.fields.getTextInputValue('colors_title').trim();
                    const requestedTextColor = interaction.fields.getTextInputValue('text_color').trim();
                    const guildToggleValue = interaction.fields.getTextInputValue('guild_toggle').trim().toLowerCase();
                    const guildBorderToggleValue = interaction.fields.getTextInputValue('guild_border_toggle').trim().toLowerCase();
                    const normalizedTextColor = normalizeHexColor(requestedTextColor || guildConfig.textColor || '#ffffff', null);
                    if (!normalizedTextColor) {
                        await interaction.reply({ content: '❌ لون النص غير صحيح. استخدم صيغة HEX مثل #FFFFFF', flags: 64 });
                        return;
                    }
                    if (guildToggleValue && !['on', 'off'].includes(guildToggleValue)) {
                        await interaction.reply({ content: '❌ حقل تفعيل افتار السيرفر يقبل فقط on أو off.', flags: 64 });
                        return;
                    }
                    if (guildBorderToggleValue && !['on', 'off'].includes(guildBorderToggleValue)) {
                        await interaction.reply({ content: '❌ حقل إطار افتار السيرفر يقبل فقط on أو off.', flags: 64 });
                        return;
                    }
                    const layout = { ...getDefaultLayoutSettings(), ...(guildConfig.layoutSettings || {}) };
                    guildConfig.layoutSettings = layout;
                    guildConfig.textColor = normalizedTextColor;
                    if (guildToggleValue) guildConfig.guildIconEnabled = guildToggleValue === 'on';
                    if (guildBorderToggleValue) guildConfig.layoutSettings.guildBorderEnabled = guildBorderToggleValue === 'on';
                    saveRoomConfig(config);
                    await refreshSetroomPanelIfPossible(interaction, guildConfig);
                    await interaction.reply({ content: `✅ تم تحديث نص الألوان ولونه إلى ${normalizedTextColor} مع إعدادات افتار السيرفر.`, flags: 64 });
                    return;
                }
                if (interaction.customId === 'setroom_modal_setup_texts') {
                    guildConfig.texts = {
                        ...getSetroomTexts(guildConfig),
                        setupTitle: interaction.fields.getTextInputValue('setup_title').trim(),
                        setupDescription: interaction.fields.getTextInputValue('setup_description').trim(),
                        roomMenuPlaceholder: interaction.fields.getTextInputValue('room_placeholder').trim(),
                        colorMenuPlaceholder: interaction.fields.getTextInputValue('color_placeholder').trim(),
                        setupFooter: interaction.fields.getTextInputValue('setup_footer').trim()
                    };
                    saveRoomConfig(config);
                    await refreshSetroomPanelIfPossible(interaction, guildConfig);
                    await interaction.reply({ content: '✅ تم تحديث نصوص السيتب.', flags: 64 });
                    return;
                }
                if (interaction.customId === 'setroom_modal_room_output') {
                    guildConfig.texts = {
                        ...getSetroomTexts(guildConfig),
                        roomContentPrefix: interaction.fields.getTextInputValue('room_prefix').trim(),
                        roomToLabel: interaction.fields.getTextInputValue('room_to_label').trim(),
                        roomByLabel: interaction.fields.getTextInputValue('room_by_label').trim(),
                        requestAcceptLabel: interaction.fields.getTextInputValue('accept_label').trim(),
                        requestRejectLabel: interaction.fields.getTextInputValue('reject_label').trim()
                    };
                    saveRoomConfig(config);
                    await refreshSetroomPanelIfPossible(interaction, guildConfig);
                    await interaction.reply({ content: '✅ تم تحديث نصوص رسالة الروم والأزرار.', flags: 64 });
                    return;
                }
                if (interaction.customId === 'setroom_modal_safety') {
                    const deleteAfterHoursInput = interaction.fields.getTextInputValue('delete_after_hours').trim();
                    const rejectCooldownInput = interaction.fields.getTextInputValue('reject_cooldown_minutes').trim();
                    const deleteAfterHours = Number(deleteAfterHoursInput || guildConfig.roomDeleteAfterHours || DEFAULT_ROOM_DELETE_HOURS);
                    const rejectCooldownMinutes = Number(rejectCooldownInput || guildConfig.rejectCooldownMinutes || DEFAULT_REJECT_COOLDOWN_MINUTES);

                    if (!Number.isFinite(deleteAfterHours) || deleteAfterHours < MIN_ROOM_DELETE_HOURS || deleteAfterHours > MAX_ROOM_DELETE_HOURS) {
                        await interaction.reply({ content: `❌ مدة حذف الروم يجب أن تكون بين ${MIN_ROOM_DELETE_HOURS} و ${MAX_ROOM_DELETE_HOURS} ساعة.`, flags: 64 });
                        return;
                    }
                    if (!Number.isFinite(rejectCooldownMinutes) || rejectCooldownMinutes < MIN_REJECT_COOLDOWN_MINUTES || rejectCooldownMinutes > MAX_REJECT_COOLDOWN_MINUTES) {
                        await interaction.reply({ content: `❌ كولداون الرفض يجب أن يكون بين ${MIN_REJECT_COOLDOWN_MINUTES} و ${MAX_REJECT_COOLDOWN_MINUTES} دقيقة.`, flags: 64 });
                        return;
                    }

                    guildConfig.roomDeleteAfterHours = deleteAfterHours;
                    guildConfig.rejectCooldownMinutes = rejectCooldownMinutes;
                    saveRoomConfig(config);
                    await refreshSetroomPanelIfPossible(interaction, guildConfig);
                    await interaction.reply({ content: `✅ تم حفظ الأمان: حذف الروم بعد ${deleteAfterHours} ساعة وكولداون رفض ${rejectCooldownMinutes} دقيقة.`, flags: 64 });
                    return;
                }
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة تفاعل setroom:', error);
        }
    });

    client.on('messageCreate', async (message) => {
        await handleEmojiMessage(message, client);
        if (message.author.bot) return;

        const roomData = activeRooms.get(message.channel.id);
        if (roomData && roomData.emojis && roomData.emojis.length > 0) {
            for (const reaction of roomData.emojis) {
                try {
                    await message.react(reaction);
                } catch (error) {
                    const emojiIdMatch = reaction.match(/<a?:\w+:(\d+)>/);
                    if (emojiIdMatch) {
                        try {
                            await message.react(emojiIdMatch[1]);
                        } catch (err) {
                            console.error('فشل في إضافة الريآكت التلقائي:', err.message);
                        }
                    }
                }
            }
        }
    });

    client.on('messageDelete', async (message) => {
        try {
            if (roomEmbedMessages.has(message.channel.id)) {
                const roomData = roomEmbedMessages.get(message.channel.id);
                if (message.id === roomData.messageId) {
                    const channel = await client.channels.fetch(roomData.channelId).catch(() => null);
                    if (!channel) return;

                    const newMessage = await channel.send({ content: roomData.content });
                    if (roomData.imageUrl) {
                        await channel.send({ content: roomData.imageUrl }).catch(() => {});
                    }

                    roomEmbedMessages.set(channel.id, { ...roomData, messageId: newMessage.id });

                    for (const reaction of roomData.emojis) {
                        try {
                            await newMessage.react(reaction);
                        } catch (error) {
                            const emojiIdMatch = reaction.match(/<a?:\w+:(\d+)>/);
                            if (emojiIdMatch) {
                                try { await newMessage.react(emojiIdMatch[1]); } catch (err) {}
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('❌ خطأ في معالج حذف الرسائل:', error);
        }
    });

    console.log('✅ تم تسجيل معالجات setroom بنجاح');
}

async function execute(message, args, { BOT_OWNERS, client }) {
    if (!canManageSetroom(message.member, message.author.id, BOT_OWNERS)) {
        await message.reply('❌ **هذا الأمر متاح للمسؤولين فقط**');
        return;
    }

    const config = loadRoomConfig();
    const guildConfig = getGuildConfigWithDefaults(config, message.guild.id);
    saveRoomConfig(config);

    const subCommand = String(args[0] || '').toLowerCase();
    if (subCommand === 'requests' || subCommand === 'request' || subCommand === 'طلبات') {
        await openSetroomRequestsManager(message);
        return;
    }
    if (subCommand === 'list' || subCommand === 'delete' || subCommand === 'edit') {
        await message.reply('ℹ️ تم توحيد إدارة الطلبات. استخدم: **setroom requests**');
        return;
    }

    const statusEmbed = getSetroomSummaryEmbed(message.guild, guildConfig, message.author);
    await message.reply({ embeds: [statusEmbed], components: createSetroomMainRows() });
}

async function handleRoleUpdate(oldRole, newRole, client) {
    try {
        const guildId = newRole.guild.id;
        const config = loadRoomConfig();
        const guildConfig = config[guildId];

        if (!guildConfig || !guildConfig.colorRoleIds || guildConfig.colorRoleIds.length === 0) {
            return;
        }

        const roleId = newRole.id;
        const wasColorRole = guildConfig.colorRoleIds.includes(roleId);
        
        const oldName = oldRole.name.trim();
        const newName = newRole.name.trim();
        const oldColor = oldRole.hexColor;
        const newColor = newRole.hexColor;

        const isOldNumber = /^\d+$/.test(oldName);
        const isNewNumber = /^\d+$/.test(newName);

        let needsUpdate = false;

        if (wasColorRole && isOldNumber && !isNewNumber) {
            console.log(`⚠️ رول ${oldName} تم تغيير اسمه إلى نص (${newName}) - سيتم إزالته من النظام`);
            guildConfig.colorRoleIds = guildConfig.colorRoleIds.filter(id => id !== roleId);
            config[guildId] = guildConfig;
            saveRoomConfig(config);
            needsUpdate = true;
        }
        else if (wasColorRole && isNewNumber) {
            if (oldName !== newName) {
                console.log(`🔄 رول ${oldName} تم تغيير رقمه إلى ${newName} - سيتم إعادة الترتيب والفحص`);
                needsUpdate = true;
            }
            if (oldColor !== newColor) {
                console.log(`🎨 رول ${newName} تم تغيير لونه من ${oldColor} إلى ${newColor}`);
                needsUpdate = true;
            }
        }
        else if (!wasColorRole && isNewNumber) {
            console.log(`➕ رول جديد برقم ${newName} - سيتم التحقق منه وإضافته إذا كان ضمن النطاق`);
            needsUpdate = true;
        }

        if (needsUpdate) {
            await updateSetupEmbed(guildId, client);
        }

    } catch (error) {
        console.error('❌ خطأ في معالجة تحديث الرول:', error);
    }
}

async function updateSetupEmbed(guildId, client) {
    try {
        const config = loadRoomConfig();
        const guildConfig = config[guildId];

        if (!guildConfig || !guildConfig.embedChannelId || !guildConfig.imageUrl) {
            return;
        }

        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            console.error(`❌ السيرفر ${guildId} غير موجود`);
            return;
        }

        const allRoles = guild.roles.cache;
        let colorRoleData = [];

        const usedNumbers = new Set();
        const tempRoleData = [];
        
        allRoles.forEach(role => {
            const trimmedName = role.name.trim();
            const isNumberOnly = /^\d+$/.test(trimmedName);

            if (isNumberOnly && !role.managed && role.id !== guild.id) {
                const roleNumber = parseInt(trimmedName);
                
                if (!usedNumbers.has(roleNumber)) {
                    tempRoleData.push({
                        id: role.id,
                        number: roleNumber
                    });
                    usedNumbers.add(roleNumber);
                }
            }
        });

        tempRoleData.sort((a, b) => a.number - b.number);

        const MAX_GAP = 10;
        if (tempRoleData.length > 0) {
            let lastAcceptedNumber = tempRoleData[0].number;
            colorRoleData.push(tempRoleData[0]);

            for (let i = 1; i < tempRoleData.length; i++) {
                const currentNumber = tempRoleData[i].number;
                const gap = currentNumber - lastAcceptedNumber;

                if (gap <= MAX_GAP) {
                    colorRoleData.push(tempRoleData[i]);
                    lastAcceptedNumber = currentNumber;
                } else {
                    console.log(`⚠️ تم تجاهل رول بعيد: ${currentNumber} (الفرق: ${gap})`);
                }
            }
        }

        colorRoleData.sort((a, b) => a.number - b.number);
        const colorRoleIds = colorRoleData.map(r => r.id);

        guildConfig.colorRoleIds = colorRoleIds;
        config[guildId] = guildConfig;
        saveRoomConfig(config);

        const setupData = setupEmbedMessages.get(guildId);
        if (!setupData) {
            console.log(`⚠️ لا توجد رسالة setup للسيرفر ${guildId}`);
            return;
        }

        const embedChannel = await client.channels.fetch(guildConfig.embedChannelId).catch(() => null);
        if (!embedChannel) {
            console.error(`❌ قناة الإيمبد ${guildConfig.embedChannelId} غير موجودة`);
            return;
        }

        const existingMessage = await embedChannel.messages.fetch(setupData.messageId).catch(() => null);
        if (!existingMessage) {
            console.log(`⚠️ رسالة الإيمبد ${setupData.messageId} غير موجودة - سيتم إعادة الإرسال`);
            await resendSetupEmbed(guildId, client);
            return;
        }

        // حذف الرسالة القديمة وإرسال رسالة جديدة (لأن edit لا يمكنه تغيير بين embed وصورة عادية)
        await existingMessage.delete().catch(() => {});
        
        const newMessage = await sendSetupMessage(embedChannel, guild, guildConfig);
        
        // تحديث معلومات الرسالة
        setupEmbedMessages.set(guildId, {
            messageId: newMessage.id,
            channelId: embedChannel.id,
            imageUrl: guildConfig.imageUrl
        });
        saveSetupEmbedMessages(setupEmbedMessages);

        console.log(`✅ تم تحديث setup embed تلقائياً للسيرفر ${guildId} (${colorRoleIds.length} رول)`);

    } catch (error) {
        console.error('❌ خطأ في تحديث setup embed:', error);
    }
}

module.exports = { 
    name,
    execute,
    loadRoomConfig,
    saveRoomConfig,
    loadRoomRequests,
    saveRoomRequests,
    registerHandlers,
    restoreSchedules,
    checkAndRestoreSetupEmbed,
    startContinuousSetupEmbedCheck,
    startAutoMessageDeletion,
    handleRoleUpdate
};
