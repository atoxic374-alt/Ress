const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { logEvent } = require('../utils/logs_system.js');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { createCanvas, registerFont, loadImage } = require('canvas');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const name = 'setroom';

// مسار ملف إعدادات الغرف
const roomConfigPath = path.join(__dirname, '..', 'data', 'roomConfig.json');
const roomRequestsPath = path.join(__dirname, '..', 'data', 'roomRequests.json');
const setupEmbedMessagesPath = path.join(__dirname, '..', 'data', 'setupEmbedMessages.json');
const setupImagesPath = path.join(__dirname, '..', 'data', 'setup_images');

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
        imageUrl: guildConfig.imageUrl || '',
        localImagePath: guildConfig.localImagePath || ''
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
                    requestId: room.requestId
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
        await channel.delete('انتهت مدة الروم (24 ساعة)');
        console.log(`🗑️ تم حذف الروم: ${channel.name}`);

        activeRooms.delete(channelId);
        roomEmbedMessages.delete(channelId);
        saveActiveRooms();
    } catch (error) {
        console.error(`❌ خطأ في حذف الروم ${channelId}:`, error);
    }
}
// جدولة حذف روم بعد 12 ساعة
function scheduleRoomDeletion(channelId, client) {
    const deletionTime = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 ساعة
    const job = schedule.scheduleJob(deletionTime, async () => {
        console.log(`⏰ حان موعد حذف الروم: ${channelId}`);
        await deleteRoom(channelId, client);
        roomDeletionJobs.delete(channelId);
    });

    roomDeletionJobs.set(channelId, job);
    console.log(`✅ تم جدولة حذف الروم ${channelId} بعد 12 ساعة`);
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
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; // 24 ساعة

    for (const [channelId, roomData] of activeRooms.entries()) {
        const roomAge = now - roomData.createdAt;
        const hoursSinceCreation = roomAge / (1000 * 60 * 60);

        console.log(`🔍 فحص الروم ${channelId}: عمر الروم ${hoursSinceCreation.toFixed(2)} ساعة`);

        if (hoursSinceCreation >= 24) {
            console.log(`⚠️ الروم ${channelId} تجاوز 12 ساعة - سيتم حذفه فوراً`);
            roomsToDelete.push(channelId);
        } else {
            const remainingTime = TWENTY_FOUR_HOURS - roomAge;
            const deletionTime = new Date(roomData.createdAt + TWENTY_FOUR_HOURS);

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
    
    // إنشاء صورة الألوان المدمجة
    const mergedImagePath = await createColorsImage(guild, guildConfig);
    const colorDescription = createColorDescription(guild, guildConfig);
    
    const menus = createSetupMenus(guild, guildConfig);
    
    let messageOptions;
    
    if (embedEnabled) {
        // إرسال مع Embed (مع النص/الكونتنت)
        const finalEmbed = colorManager.createEmbed()
            .setTitle('**Rooms & Colors**')
            .setDescription('**اختر لونك او نوع الروم التي تريد طلبها :**' + colorDescription)
            .setImage('attachment://colors_merged.png')
            .setFooter({ text: 'System' });
        
        messageOptions = { 
            embeds: [finalEmbed], 
            components: menus,
            files: []
        };
    } else {
        // إرسال بدون Embed (صورة فقط بدون أي نص)
        messageOptions = { 
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

// دالة لإنشاء منيوهات Setup (منيو الدعاء/الميلاد + منيو الألوان)
function createSetupMenus(guild, guildConfig) {
    const menus = [];

    // منيو الدعاء والميلاد (المنيو الأول - موجود دائماً)
    const roomMenu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('room_type_menu')
            .setPlaceholder('Choose Your Room')
            .addOptions([
                {
                    label: 'Doaa',
                    description: 'طلب روم دعاء',
                    emoji: '<:emoji_83:1442589607639126046>',
                    value: 'condolence',
                },
                {
                    label: 'Birthday ',
                    description: 'طلب روم ميلاد',
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
                    .setPlaceholder('Choose Your Color')
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

        // إعدادات مربعات الألوان - متناسبة مع عرض + طول الصورة
        // نستخدم معامل مبني على البعدين لتفادي التضخم في الصور العريضة القصيرة
        const widthScaleFactor = canvasWidth / 1024;  // مرجع العرض
        const heightScaleFactor = canvasHeight / 576; // مرجع الطول
        const scaleFactor = Math.min(widthScaleFactor, heightScaleFactor);

        const boxSize = Math.max(32, Math.round(60 * scaleFactor)); // حجم كل مربع
        const gap = Math.max(6, Math.round(12 * scaleFactor)); // المسافة بين المربعات
        const padding = Math.max(12, Math.round(30 * scaleFactor)); // المسافة من الحواف
        const cornerRadius = Math.max(5, Math.round(10 * scaleFactor)); // انحناء زوايا المربعات

        const colorsPerRow = 10; // عدد الألوان في كل صف
        const totalColors = guildConfig.colorRoleIds.length;
        const rows = Math.ceil(totalColors / colorsPerRow);

        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');

        // رسم الصورة الأصلية كخلفية
        ctx.drawImage(backgroundImage, 0, 0, canvasWidth, canvasHeight);

        // حساب عرض المربعات للتمركز أفقياً
        const totalBoxesWidth = (boxSize * colorsPerRow) + (gap * (colorsPerRow - 1));
        const startX = Math.max(padding, (canvasWidth - totalBoxesWidth) / 2);

        // حساب ارتفاع المربعات لتحديد موقع البداية عمودياً (مع حساب الصفوف)
        const totalBoxesHeight = (boxSize * rows) + (gap * (rows - 1));
        // تحسين التمركز الرأسي - نضع المربعات في النصف السفلي من الصورة
        const startY = rows > 1
            ? Math.max(padding, (canvasHeight - totalBoxesHeight) / 2) // تمركز مرن للصفوف المتعددة
            : Math.max(padding, (canvasHeight * 0.6) - (totalBoxesHeight / 2)); // صف واحد - في النصف السفلي
        
        // الحصول على النص المخصص من الإعدادات
        const colorsTitle = guildConfig.colorsTitle !== undefined ? guildConfig.colorsTitle : 'Colors list :';
        
        // رسم النص فقط إذا لم يكن فارغاً
        if (colorsTitle && colorsTitle.length > 0) {
            const titleFontSize = Math.max(18, Math.round(26 * scaleFactor));
            const textOffsetX = Math.max(100, Math.round(150 * scaleFactor));
            const textOffsetY = Math.max(22, Math.round(33 * scaleFactor));
            
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${titleFontSize}px Arial`;
            ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
            ctx.shadowBlur = Math.max(6, Math.round(10 * scaleFactor));
            ctx.textAlign = 'left';
            ctx.fillText(colorsTitle, startX - textOffsetX, startY - textOffsetY);
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
            ctx.font = `bold ${numberFontSize}px Arial`;
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
            .setTitle('**أخطاء في الإدخال**')
            .setDescription(validationErrors.join('\n'))
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

    // طلب الإيموجي من المستخدم
    const emojiPrompt = colorManager.createEmbed()
        .setTitle('**خطوة أخيرة**')
        .setDescription('**الرجاء إرسال الإيموجيات التي تريد إضافتها للروم**\n\nأرسل الإيموجيات (لازم من السيرفر)')
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

    // استخراج الإيموجيات المخصصة (عادية ومتحركة)
    const customEmojiRegex = /<a?:\w+:\d+>/g;
    const customEmojis = message.content.match(customEmojiRegex) || [];

    // استخراج الإيموجيات Unicode
    const unicodeEmojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Emoji})/gu;
    const unicodeEmojis = [];

    // إزالة الإيموجيات المخصصة من النص للحصول على Unicode فقط
    let cleanContent = message.content;
    for (const customEmoji of customEmojis) {
        cleanContent = cleanContent.replace(customEmoji, '');
    }

    // استخراج Unicode
    const unicodeMatches = cleanContent.match(unicodeEmojiRegex) || [];
    for (const emoji of unicodeMatches) {
        if (emoji.trim()) {
            unicodeEmojis.push(emoji);
        }
    }

    // دمج جميع الإيموجيات
    const emojis = [...customEmojis, ...unicodeEmojis];

    if (emojis.length === 0) {
        await message.reply('❌ **لم يتم العثور على إيموجيات. تم إلغاء الطلب**').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 5000);
        });
        return;
    }

    // فحص عدد الإيموجيات
    if (emojis.length > 20) {
        await message.reply('❌ **الحد الأقصى للإيموجيات هو 20. تم إلغاء الطلب**').then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 5000);
        });
        return;
    }

    const config = loadRoomConfig();
    const guildConfig = config[requestData.guildId];

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
    const requests = loadRoomRequests();
    requests.push(request);
    saveRoomRequests(requests);

    // إرسال الطلب لروم الطلبات
    const requestsChannel = await client.channels.fetch(guildConfig.requestsChannelId);

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
            .setLabel('Accept')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:emoji_41:1430334120839479449>'),
        new ButtonBuilder()
            .setCustomId(`room_reject_${request.id}`)
            .setLabel('Rejec')
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

    // التحقق من الصلاحيات
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
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
            channelOptions.parent = guildConfig.roomsCategoryId;
        }
        
        const channel = await guild.channels.create(channelOptions);

        console.log(`✅ تم إنشاء القناة: ${channel.name} (${channel.id})`);

        // إرسال الرسالة
        const roomEmbed = colorManager.createEmbed()
            .setTitle(`${request.roomTypeEn === 'condolence' ? 'دعاء' : 'hbd'} : **Room**`)
            .setDescription(`# ${request.message}`)
            .addFields([
                { name: 'لـ', value: request.forWho, inline: true },
                { name: 'بطلب من', value: `<@${request.userId}>`, inline: true }
            ])
            .setTimestamp();

        // إضافة الصورة إذا كانت موجودة
        if (request.imageUrl) {
            roomEmbed.setImage(request.imageUrl);
        }

        const sentMessage = await channel.send({ content: '@here', embeds: [roomEmbed] });
        console.log(`✅ تم إرسال رسالة الإمبد في الروم`);

        // حفظ معلومات الرسالة للحماية من الحذف
        roomEmbedMessages.set(channel.id, {
            messageId: sentMessage.id,
            channelId: channel.id,
            embed: roomEmbed,
            emojis: request.emojis || [],
            request: request
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
            requestId: request.id
        });
        saveActiveRooms();

        // جدولة حذف الروم بعد 12 ساعة
        scheduleRoomDeletion(channel.id, client);
        console.log(`✅ تم إنشاء روم ${request.roomType} بنجاح: ${roomName} (سيتم حذفها تلقائياً بعد 12 ساعة)`);

        // إرسال إشعار لصاحب الطلب
        try {
            const requester = await client.users.fetch(request.userId);
            const notificationEmbed = colorManager.createEmbed()
                .setTitle('✅ تم إنشاء الروم')
                .setDescription(`تم إنشاء روم ${request.roomType} الذي طلبته`)
                .addFields([
                    { name: 'اسم الروم', value: roomName, inline: true },
                    { name: 'رابط الروم', value: `<#${channel.id}>`, inline: true }
                ])
                .setTimestamp();

            await requester.send({ embeds: [notificationEmbed] });
            console.log(`✅ تم إرسال إشعار لصاحب الطلب`);
        } catch (dmError) {
            console.error('فشل في إرسال إشعار لصاحب الطلب:', dmError.message);
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

// تسجيل معالجات التفاعلات
function registerHandlers(client) {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu() && !interaction.isModalSubmit() && !interaction.isButton()) return;

        try {
            // معالجة منيو طلبات الغرف
            if (interaction.isStringSelectMenu() && interaction.customId === 'room_type_menu') {
                await handleRoomRequestMenu(interaction, client);
                return;
            }

            // معالجة منيو اختيار الألوان
            if (interaction.isStringSelectMenu() && interaction.customId === 'color_selection_menu') {
                await handleColorSelection(interaction, client);
                return;
            }

            // معالجة مودالات طلبات الغرف
            if (interaction.isModalSubmit() && interaction.customId.startsWith('room_modal_')) {
                await handleRoomModalSubmit(interaction, client);
                return;
            }

            // معالجة قبول/رفض طلبات الغرف
            if (interaction.isButton() && (interaction.customId.startsWith('room_accept_') || interaction.customId.startsWith('room_reject_'))) {
                await handleRoomRequestAction(interaction, client);
                return;
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة تفاعل setroom:', error);
        }
    });

    // معالج رسائل الإيموجي
    client.on('messageCreate', async (message) => {
        await handleEmojiMessage(message, client);
        if (message.author.bot) return;

        const roomData = activeRooms.get(message.channel.id);
        if (roomData && roomData.emojis && roomData.emojis.length > 0) {
            for (const reaction of roomData.emojis) {
                try {
                    await message.react(reaction);
                } catch (error) {
                    // محاولة استخدام آيدي الإيموجي إذا فشل
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

    // معالج حذف الرسائل - لإعادة إرسال الإمبد فوراً
    client.on('messageDelete', async (message) => {
        try {
            // التحقق من أن الرسالة في روم محمي
            if (roomEmbedMessages.has(message.channel.id)) {
                const roomData = roomEmbedMessages.get(message.channel.id);

                // التحقق من أن الرسالة المحذوفة هي رسالة الإمبد
                if (message.id === roomData.messageId) {
                    console.log(`⚠️ تم حذف رسالة الإمبد في ${message.channel.name} - إعادة الإرسال فوراً`);

                    try {
                        const channel = await client.channels.fetch(roomData.channelId);
                        if (!channel) return;

                        const newMessage = await channel.send({ 
                            content: '@here', 
                            embeds: [roomData.embed] 
                        });

                        console.log(`✅ تم إعادة إرسال رسالة الإمبد في ${channel.name}`);

                        // تحديث معلومات الرسالة
                        roomEmbedMessages.set(channel.id, {
                            ...roomData,
                            messageId: newMessage.id
                        });

                        // إعادة إضافة الريآكتات
                        for (const reaction of roomData.emojis) {
                            try {
                                await newMessage.react(reaction);
                            } catch (error) {
                                const emojiIdMatch = reaction.match(/<a?:\w+:(\d+)>/);
                                if (emojiIdMatch) {
                                    try {
                                        await newMessage.react(emojiIdMatch[1]);
                                    } catch (err) {
                                        console.error('فشل في إضافة الريآكت:', err.message);
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error('❌ فشل في إعادة إرسال الإمبد:', error);
                    }
                }
            }

            // تم إزالة التحقق اليدوي لرسائل سيتب روم - سيتم إعادة الإرسال تلقائياً كل 3 دقائق

        } catch (error) {
            console.error('❌ خطأ في معالج حذف الرسائل:', error);
        }
    });

    console.log('✅ تم تسجيل معالجات setroom بنجاح');
}

async function execute(message, args, { BOT_OWNERS, client }) {
    // التحقق من الصلاحيات
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator) && 
        !BOT_OWNERS.includes(message.author.id)) {
        await message.reply('❌ **هذا الأمر متاح للمسؤولين فقط**');
        return;
    }

    const guildId = message.guild.id;
    
    // فحص sub-command
    const subCommand = args[0]?.toLowerCase();
    
    // معالجة sub-command "category"
    if (subCommand === 'ctg') {
        const config = loadRoomConfig();
        
        if (!config[guildId]) {
            config[guildId] = {};
        }
        
        const categoryId = args[1];
        
        // إذا لم يتم تحديد ID، أظهر الحالة الحالية
        if (!categoryId) {
            const currentCategory = config[guildId].roomsCategoryId;
            if (currentCategory) {
                const category = message.guild.channels.cache.get(currentCategory);
                const categoryName = category ? category.name : 'غير موجود';
                await message.reply(`📁 **الكاتيقوري الحالي :** ${categoryName} (\`${currentCategory}\`)\n\n**للتغيير :** \`setroom ctg <ID>\`\n**للإزالة :** \`setroom ctg remove\``);
            } else {
                await message.reply('📁 **لم يتم تحديد كاتوقري للرومات**\n\n**للتحديد :** \`setroom ctg <ID>\`');
            }
            return;
        }
        
        // إزالة الكاتيجوري
        if (categoryId.toLowerCase() === 'remove' || categoryId.toLowerCase() === 'delete') {
            delete config[guildId].roomsCategoryId;
            saveRoomConfig(config);
            await message.reply('✅ **تم إزالة الكاتيقوري - الرومات الجديدة ستنشأ بدون كاتيثوري**');
            return;
        }
        
        // التحقق من وجود الكاتيجوري
        const category = message.guild.channels.cache.get(categoryId);
        if (!category || category.type !== ChannelType.GuildCategory) {
            await message.reply('❌ **الكاتوقري غير موجود أو ID غير صحيح**\n\n**طريقة الحصول على ID :**\n1. فعّل وضع الديفوليبر في Discord\n2. اضغط كليك يمين على الكاتيقوري\n3. اختر "Copy ID"');
            return;
        }
        
        // حفظ الكاتيجوري
        config[guildId].roomsCategoryId = categoryId;
        saveRoomConfig(config);
        
        await message.reply(`✅ **تم تحديد الكاتيجوري بنجاح**\n\n📁 ** الكاتيجوري :** ${category.name}\n🆔 **ID :** \`${categoryId}\`\n\n**الآن رومات الميلاد والدعاء ستنشأ في هذا الكاتيجوري**`);
        return;
    }
    
    // معالجة sub-command "embed"
    if (subCommand === 'embed') {
        const config = loadRoomConfig();
        const guildConfig = config[guildId];
        
        if (!guildConfig) {
            await message.reply('❌ **لم يتم إعداد نظام الرومات بعد. استخدم `/setroom` لإعداد النظام أولاً**');
            return;
        }
        
        // تبديل حالة الإيمبد
        const currentState = guildConfig.embedEnabled !== false; // افتراضياً مفعّل
        const newState = !currentState;
        
        config[guildId].embedEnabled = newState;
        saveRoomConfig(config);
        
        // إرسال رسالة التأكيد
        const statusEmoji = newState ? '✅' : '☑️';
        const statusText = newState ? 'مفعّل' : 'ملغي';
        const statusDesc = newState 
            ? '**سيتم إرسال الصورة داخل Embed**' 
            : '**سيتم إرسال الصورة عادية فقط (بدون Embed)**';
        
        const toggleEmbed = colorManager.createEmbed()
            .setTitle(`${statusEmoji} **تم ${newState ? 'تفعيل' : 'إلغاء'} وضع Embed**`)
            .setDescription(`${statusDesc}\n\nالحالة: **${statusText}**`)
            .setFooter({ text: 'سيتم تطبيق التغيير في الإيمبد التالي' });
        
        const sentMsg = await message.reply({ embeds: [toggleEmbed] });
        
        // إضافة الرياكشن
        await sentMsg.react(statusEmoji);
        
        // إعادة إرسال الإيمبد بالإعدادات الجديدة
        if (guildConfig.embedChannelId) {
            try {
                await resendSetupEmbed(guildId, client);
                await message.channel.send('✅ **تم تحديث الإيمبد بنجاح**');
            } catch (error) {
                console.error('خطأ في إعادة إرسال الإيمبد:', error);
                await message.channel.send('⚠️ **تم حفظ الإعدادات، لكن فشل تحديث الإيمبد. سيتم تحديثه تلقائياً قريباً**');
            }
        }
        
        return;
    }
    
    // معالجة sub-command "t" أو "text" لتغيير نص الألوان
    if (subCommand === 't' || subCommand === 'text') {
        const config = loadRoomConfig();
        
        if (!config[guildId]) {
            config[guildId] = {};
        }
        
        const newText = args.slice(1).join(' ');
        
        // إذا لم يتم تحديد نص، أظهر الحالة الحالية
        if (!newText) {
            const currentText = config[guildId].colorsTitle;
            if (currentText === '') {
                await message.reply('📝 **نص الألوان :** محذوف (لا يوجد نص)\n\n**للتغيير :** `setroom t <النص الجديد>`\n**للإزالة :** `setroom t remove`\n**للافتراضي :** `setroom t default`');
            } else if (currentText) {
                await message.reply(`📝 **نص الألوان الحالي :** ${currentText}\n\n**للتغيير :** \`setroom t <النص الجديد>\`\n**للإزالة :** \`setroom t remove\`\n**للافتراضي :** \`setroom t default\``);
            } else {
                await message.reply('📝 **نص الألوان :** Colors list : (الافتراضي)\n\n**للتغيير :** `setroom t <النص الجديد>`\n**للإزالة :** `setroom t remove`');
            }
            return;
        }
        
        // إزالة النص
        if (newText.toLowerCase() === 'remove' || newText.toLowerCase() === 'delete' || newText === 'حذف' || newText === 'ازالة') {
            config[guildId].colorsTitle = '';
            saveRoomConfig(config);
            await message.reply('✅ **تم إزالة نص الألوان - لن يظهر أي نص فوق المربعات**');
            
            // إعادة إرسال الإيمبد
            if (config[guildId].embedChannelId) {
                try {
                    await resendSetupEmbed(guildId, client);
                } catch (error) {
                    console.error('خطأ في إعادة إرسال الإيمبد:', error);
                }
            }
            return;
        }
        
        // إعادة للافتراضي
        if (newText.toLowerCase() === 'default' || newText === 'افتراضي') {
            delete config[guildId].colorsTitle;
            saveRoomConfig(config);
            await message.reply('✅ **تم إعادة نص الألوان للافتراضي :** Colors list :');
            
            // إعادة إرسال الإيمبد
            if (config[guildId].embedChannelId) {
                try {
                    await resendSetupEmbed(guildId, client);
                } catch (error) {
                    console.error('خطأ في إعادة إرسال الإيمبد:', error);
                }
            }
            return;
        }
        
        // تحديد نص جديد
        if (newText.length > 50) {
            await message.reply('❌ **النص طويل جداً - الحد الأقصى 50 حرف**');
            return;
        }
        
        config[guildId].colorsTitle = newText;
        saveRoomConfig(config);
        
        await message.reply(`✅ **تم تغيير نص الألوان إلى :** ${newText}`);
        
        // إعادة إرسال الإيمبد
        if (config[guildId].embedChannelId) {
            try {
                await resendSetupEmbed(guildId, client);
                await message.channel.send('✅ **تم تحديث الإيمبد بنجاح**');
            } catch (error) {
                console.error('خطأ في إعادة إرسال الإيمبد:', error);
            }
        }
        
        return;
    }

    // الخطوة 1: طلب روم الطلبات
    const step1Embed = colorManager.createEmbed()
        .setTitle('**إعداد نظام الرومات**')
        .setDescription('**الخطوة 1/3: منشن روم الطلبات**\n\nقم بعمل منشن للروم الذي سيتم إرسال الطلبات فيه\n\n**📌 دليل صيغ الوقت المدعومة:**\n```\n⏰ فوري:\n• الآن / فوراً / دحين / الحين / توني\n\n⏱️ ثواني/دقائق:\n• بعد 30 ثانية / بعد ثانية\n• بعد دقيقة / بعد 5 دقائق / دقيقتين\n\n🕐 ساعات:\n• بعد ساعة / بعد ساعتين / بعد 3 ساعات\n• 12 صباحاً / 5 مساءً / الساعة 8\n\n📅 أيام:\n• غداً / غدا / بكره / بكرة / غدوة\n• بكره الساعة 10 / غداً 5 مساءً\n• بعد يوم / بعد 3 أيام\n\n⏳ أخرى:\n• شوي (بعد 10 دقائق)```')
        .setFooter({ text: 'لديك 60 ثانية للرد' });

    await message.channel.send({ embeds: [step1Embed] });

    const filter = m => m.author.id === message.author.id;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (msg1) => {
        const requestsChannel = msg1.mentions.channels.first();
        if (!requestsChannel) {
            await message.channel.send('❌ **لم يتم العثور على الروم. حاول مرة أخرى**');
            return;
        }

        // الخطوة 2: طلب روم الإيمبد
        const step2Embed = colorManager.createEmbed()
            .setTitle('**إعداد نظام الرومات**')
            .setDescription('**الخطوة 2/3: منشن روم الإيمبد**\n\nقم بعمل منشن للروم الذي سيتم إرسال الإيمبد فيه')
            .setFooter({ text: 'لديك 60 ثانية للرد' });

        await message.channel.send({ embeds: [step2Embed] });

        const collector2 = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector2.on('collect', async (msg2) => {
            const embedChannel = msg2.mentions.channels.first();
            if (!embedChannel) {
                await message.channel.send('❌ **لم يتم العثور على الروم. حاول مرة أخرى**');
                return;
            }

            // الخطوة 3: طلب الصورة
            const step3Embed = colorManager.createEmbed()
                .setTitle('**إعداد نظام الرومات**')
                .setDescription('**الخطوة 3/3: أرسل الصورة**\n\nأرسل الصورة (إرفاق أو رابط)\n\n**ملاحظة:** سيتم إضافة جميع الرولات الملونة من السيرفر تلقائياً في منيو الألوان')
                .setFooter({ text: 'لديك 120 ثانية للرد' });

            await message.channel.send({ embeds: [step3Embed] });

            const collector3 = message.channel.createMessageCollector({ filter, time: 120000, max: 1 });

            collector3.on('collect', async (msg3) => {
                let imageUrl = null;

                // التحقق من المرفقات
                if (msg3.attachments.size > 0) {
                    const attachment = msg3.attachments.first();
                    if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                        imageUrl = attachment.url;
                    }
                } 
                // التحقق من الرابط
                else if (msg3.content.match(/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)/i)) {
                    imageUrl = msg3.content;
                }

                if (!imageUrl) {
                    await message.channel.send('❌ **لم يتم العثور على صورة صحيحة. حاول مرة أخرى**');
                    return;
                }

                // جلب جميع الأدوار التي أسماؤها أرقام صافية فقط من السيرفر
                const allRoles = message.guild.roles.cache;
                let colorRoleData = [];

                // جمع الأدوار التي أسماؤها أرقام صافية فقط (مثل "1", "2", "3")
                const usedNumbers = new Set();
                const tempRoleData = [];
                
                allRoles.forEach(role => {
                    // التحقق من أن الاسم بالكامل رقم فقط (لا يحتوي على أحرف أو مسافات)
                    const trimmedName = role.name.trim();
                    const isNumberOnly = /^\d+$/.test(trimmedName);

                    if (isNumberOnly && !role.managed && role.id !== message.guild.id) {
                        const roleNumber = parseInt(trimmedName);
                        
                        // تجاهل الرول إذا كان الرقم مستخدم بالفعل (رول مكرر)
                        if (!usedNumbers.has(roleNumber)) {
                            tempRoleData.push({
                                id: role.id,
                                number: roleNumber
                            });
                            usedNumbers.add(roleNumber);
                        }
                    }
                });

                // ترتيب الأرقام تصاعدياً
                tempRoleData.sort((a, b) => a.number - b.number);

                // فلترة الأرقام البعيدة (الحد الأقصى: 10 أرقام عن آخر رقم مقبول)
                const MAX_GAP = 10;
                if (tempRoleData.length > 0) {
                    let lastAcceptedNumber = tempRoleData[0].number;
                    colorRoleData.push(tempRoleData[0]);
                    console.log(`✅ تم إضافة رول اللون: ${tempRoleData[0].number} (${tempRoleData[0].id})`);

                    for (let i = 1; i < tempRoleData.length; i++) {
                        const currentNumber = tempRoleData[i].number;
                        const gap = currentNumber - lastAcceptedNumber;

                        if (gap <= MAX_GAP) {
                            colorRoleData.push(tempRoleData[i]);
                            lastAcceptedNumber = currentNumber;
                            console.log(`✅ تم إضافة رول اللون: ${currentNumber} (${tempRoleData[i].id})`);
                        } else {
                            console.warn(`⚠️ تم تجاهل رول بعيد: ${currentNumber} - الفرق ${gap} أرقام عن آخر رقم مقبول (${lastAcceptedNumber})`);
                        }
                    }
                }

                // إذا لم يكن هناك رولات ألوان، قم بإنشاء 7 ألوان عشوائية
                if (colorRoleData.length === 0) {
                    const loadingMsg = await message.channel.send('⏳ **لا توجد رولات ألوان... جاري إنشاء 7 ألوان تلقائياً...**');

                    // ألوان عشوائية جميلة
                    const randomColors = [
                        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
                        '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
                        '#A29BFE', '#FD79A8', '#FDCB6E', '#6C5CE7',
                        '#00B894', '#E17055', '#74B9FF', '#A29BFE'
                    ];

                    // خلط الألوان عشوائياً
                    const shuffledColors = randomColors.sort(() => Math.random() - 0.5);

                    // إنشاء 7 رولات
                    for (let i = 1; i <= 7; i++) {
                        try {
                            const color = shuffledColors[i - 1];
                            const newRole = await message.guild.roles.create({
                                name: i.toString(),
                                color: color,
                                reason: 'تم إنشاء رول لون تلقائياً بواسطة نظام setroom'
                            });

                            colorRoleData.push({
                                id: newRole.id,
                                number: i
                            });

                            console.log(`✅ تم إنشاء رول لون: ${i} - ${color}`);
                        } catch (roleError) {
                            console.error(`❌ فشل في إنشاء رول اللون ${i}:`, roleError);
                        }
                    }

                    await loadingMsg.edit(`✅ **تم إنشاء ${colorRoleData.length} رول لون بنجاح!**`);

                    // انتظار ثانيتين قبل المتابعة
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                // ترتيب الأدوار حسب الرقم
                colorRoleData.sort((a, b) => a.number - b.number);

                const colorRoleIds = colorRoleData.map(r => r.id);

                // حفظ الصورة محلياً
                const savingMsg = await message.channel.send('⏳ **جاري حفظ الصورة...**');
                const localImagePath = await saveImageLocally(imageUrl, guildId);
                
                if (!localImagePath) {
                    await savingMsg.edit('❌ **فشل في حفظ الصورة محلياً. حاول مرة أخرى**');
                    return;
                }
                
                await savingMsg.delete().catch(() => {});

                // حفظ الإعدادات
                const config = loadRoomConfig();
                config[guildId] = {
                    requestsChannelId: requestsChannel.id,
                    embedChannelId: embedChannel.id,
                    imageUrl: imageUrl,
                    localImagePath: localImagePath,
                    colorRoleIds: colorRoleIds,
                    setupBy: message.author.id,
                    setupAt: Date.now()
                };

                if (saveRoomConfig(config)) {
                        const setupMessage = await sendSetupMessage(embedChannel, message.guild, config[guildId]);
                        console.log(`📤 تم إرسال setup embed للمرة الأولى - جاري التحقق...`);

                        // حفظ رسالة السيتب للحماية من الحذف
                        setupEmbedMessages.set(guildId, {
                            messageId: setupMessage.id,
                            channelId: embedChannel.id,
                            imageUrl: imageUrl
                        });

                        saveSetupEmbedMessages(setupEmbedMessages);

                        console.log(`✅ تم إرسال setup embed بنجاح - سيتم تحديثه تلقائياً كل 3 دقائق`);

                        // رسالة نجاح
                        const successEmbed = colorManager.createEmbed()
                            .setTitle('✅ **تم الإعداد بنجاح**')
                            .setDescription(`**تم إعداد نظام الرومات بنجاح مع نظام الفحص المتقدم!**\n\n روم الطلبات : ${requestsChannel}\nروم الإيمبد : ${embedChannel}\n عدد الرولات الملونة : ${colorRoleIds.length}`)
                            .setTimestamp();

                        await message.channel.send({ embeds: [successEmbed] });

                        // تسجيل الحدث
                        logEvent(client, message.guild, {
                            type: 'SETUP_ACTIONS',
                            title: 'إعداد نظام الغرف',
                            description: `تم إعداد نظام طلبات الغرف`,
                            user: message.author,
                            fields: [
                                { name: 'روم الطلبات', value: requestsChannel.name, inline: true },
                                { name: 'روم الإيمبد', value: embedChannel.name, inline: true },
                                { name: 'عدد الألوان', value: colorRoleIds.length.toString(), inline: true }
                            ]
                        });
                    } else {
                        await message.channel.send('❌ **فشل في حفظ الإعدادات**');
                    }
            });
        });
    });
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