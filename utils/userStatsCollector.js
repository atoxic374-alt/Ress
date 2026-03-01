const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { EmbedBuilder } = require('discord.js');

// مسارات ملفات البيانات
const vacationsPath = path.join(__dirname, '..', 'data', 'vacations.json');
const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
const userActivityPath = path.join(__dirname, '..', 'data', 'userActivity.json');

// دالة لقراءة ملف JSON مع معالجة الأخطاء
function readJsonFile(filePath, defaultValue = {}) {
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
function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`خطأ في كتابة ${filePath}:`, error);
        return false;
    }
}

// دالة لتنسيق الوقت بدقة أكبر
function formatDuration(value) {
    if (!value || value <= 0) return '**0ms**';

    const totalSeconds = Math.floor(value / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;
    const seconds = totalSeconds % 60;
    const ms = value % 1000;

    const parts = [];
    if (days > 0) parts.push(`**${days}**d`);
    if (hours > 0) parts.push(`**${hours}**h`);
    if (minutes > 0) parts.push(`**${minutes}**m`);
    if (seconds > 0) parts.push(`**${seconds}**s`);
    if (ms > 0 || parts.length === 0) parts.push(`**${ms}**ms`);

    return parts.join(' and ');
}

// دالة لحساب الوقت الصوتي لهذا الأسبوع فقط من قاعدة البيانات
async function calculateWeeklyVoiceTime(userId) {
    try {
        const { getDatabase } = require('./database');
        const dbManager = getDatabase();

        const weeklyStats = await dbManager.getWeeklyStats(userId);
        return weeklyStats.weeklyTime || 0;
    } catch (error) {
        console.error('خطأ في حساب الوقت الصوتي الأسبوعي:', error);
        return 0;
    }
}

// دالة لتسجيل نشاط المستخدم باستخدام قاعدة البيانات
async function trackUserActivity(userId, activityType, data = {}) {
    try {
        const { getDatabase } = require('./database');
        const dbManager = getDatabase();

        // تحديث آخر نشاط (استخدام توقيت الرياض)
        const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');

        // معالجة نوع النشاط
        switch (activityType) {
            case 'message':
                await dbManager.updateUserTotals(userId, { messages: 1 });
                await dbManager.updateDailyActivity(today, userId, { messages: 1 });

                // تتبع القناة التي كتبت فيها الرسالة
                if (data.channelId && data.channelName) {
                    await dbManager.updateMessageChannel(userId, data.channelId, data.channelName);
                }
                break;

            case 'voice_join':
                await dbManager.updateUserTotals(userId, { voiceJoins: 1 });
                await dbManager.updateDailyActivity(today, userId, { voiceJoins: 1 });
                break;

            case 'voice_time':
                const duration = data.duration || 0;
                const channelId = data.channelId || 'unknown';
                const channelName = data.channelName || 'روم غير معروفة';
                const startTime = data.startTime || (Date.now() - duration);
                const endTime = data.endTime || Date.now();

                // حفظ الجلسة الصوتية المفصلة
                try {
                    const { saveVoiceSession } = require('./voiceTimeManager');
                    await saveVoiceSession(userId, channelId, channelName, duration, startTime, endTime);
                } catch (error) {
                    console.error('❌ خطأ في حفظ الجلسة الصوتية:', error.message);
                    // حفظ بيانات مبسطة على الأقل
                    try {
                        await dbManager.updateUserTotals(userId, { voiceTime: duration });
                        await dbManager.updateDailyActivity(today, userId, { voiceTime: duration });
                    } catch (fallbackError) {
                        console.error('❌ فشل الحفظ البديل:', fallbackError.message);
                    }
                }
                break;

            case 'reaction':
                try {

                    // تحديث إجماليات المستخدم
                    await dbManager.updateUserTotals(userId, { reactions: 1 });

                    // تحديث النشاط اليومي
                    await dbManager.updateDailyActivity(today, userId, { reactions: 1 });

                    console.log(`✅ تم تسجيل تفاعل للمستخدم ${userId} - ${data.emoji || 'تفاعل'}`);

                } catch (reactionError) {
                    console.error(`❌ خطأ في معالجة تفاعل المستخدم ${userId}:`, reactionError);

                    // محاولة إعادة المحاولة مرة واحدة
                    try {
                        console.log(`🔄 محاولة إعادة تسجيل التفاعل للمستخدم ${userId}`);
                        await dbManager.updateUserTotals(userId, { reactions: 1 });
                        console.log(`✅ نجحت إعادة المحاولة - تم تسجيل تفاعل للمستخدم ${userId}`);
                    } catch (retryError) {
                        console.error(`❌ فشلت إعادة المحاولة للمستخدم ${userId}:`, retryError);
                        throw retryError;
                    }
                }
                break;
        }

        // تم تبسيط رسائل الكونسول
        return true;

    } catch (error) {
        console.error('خطأ في تسجيل نشاط المستخدم:', error);
        return false;
    }
}

// دالة للحصول على إحصائيات المستخدم الفعلية من قاعدة البيانات
async function getRealUserStats(userId) {
    try {
        const { getDatabase } = require('./database');
        const dbManager = getDatabase();

        const stats = await dbManager.getUserStats(userId);

        if (!stats) {
            console.log(`⚠️ لم يتم العثور على بيانات المستخدم ${userId} في قاعدة البيانات`);
            return {
                messages: 0,
                voiceTime: 0,
                lastActivity: 'غير معروف',
                joinedChannels: 0,
                reactionsGiven: 0,
                activeDays: 0,
                accountAge: 0
            };
        }

        console.log(`✅ تم جلب بيانات المستخدم ${userId} من قاعدة البيانات:`, {
            messages: stats.totalMessages,
            voiceTime: stats.totalVoiceTime,
            sessions: stats.totalSessions,
            voiceJoins: stats.totalVoiceJoins,
            reactions: stats.totalReactions
        });

        return {
            messages: stats.totalMessages || 0,
            voiceTime: stats.totalVoiceTime || 0,
            lastActivity: stats.lastActivity ? moment(stats.lastActivity).tz('Asia/Riyadh').format('YYYY-MM-DD') : 'غير معروف',
            joinedChannels: stats.totalVoiceJoins || 0,
            reactionsGiven: stats.totalReactions || 0,
            activeDays: stats.activeDays || 0, // أيام النشاط الفعلية من قاعدة البيانات
            weeklyActiveDays: stats.weeklyActiveDays || 0, // أيام النشاط الأسبوعية
            accountAge: stats.firstSeen ? Date.now() - (stats.firstSeen * 1000) : 0
        };
    } catch (error) {
        console.error('❌ خطأ في الحصول على إحصائيات المستخدم:', error);
        return {
            messages: 0,
            voiceTime: 0,
            lastActivity: 'خطأ',
            joinedChannels: 0,
            reactionsGiven: 0,
            activeDays: 0,
            accountAge: 0
        };
    }
}

// دالة للتحقق من حالة الإجازة
function getVacationStatus(userId) {
    try {
        const vacations = readJsonFile(vacationsPath, { active: {} });
        const activeVacation = vacations.active?.[userId];

        if (activeVacation) {
            const endDate = new Date(activeVacation.endDate);
            return {
                hasVacation: true,
                endDate: endDate,
                reason: activeVacation.reason || 'غير محدد',
                startDate: new Date(activeVacation.startDate),
                approvedBy: activeVacation.approvedBy
            };
        }

        return { hasVacation: false };
    } catch (error) {
        console.error('خطأ في فحص حالة الإجازة:', error);
        return { hasVacation: false };
    }
}

// دالة للتحقق من حالة الداون
function getDownStatus(userId) {
    try {
        const activeDowns = readJsonFile(activeDownsPath, {});

        for (const [downId, downData] of Object.entries(activeDowns)) {
            if (downData.userId === userId) {
                return {
                    hasDown: true,
                    reason: downData.reason || 'غير محدد',
                    endTime: downData.endTime ? new Date(downData.endTime) : null,
                    roleId: downData.roleId,
                    startTime: downData.startTime ? new Date(downData.startTime) : null,
                    byUserId: downData.byUserId
                };
            }
        }

        return { hasDown: false };
    } catch (error) {
        console.error('خطأ في فحص حالة الداون:', error);
        return { hasDown: false };
    }
}

// دالة لجمع آخر نشاط بدقة أكبر
function getLastActivity(member) {
    try {
        const realStats = getRealUserStats(member.id);

        if (realStats.lastActivity && realStats.lastActivity !== 'غير معروف') {
            return `آخر نشاط : ${realStats.lastActivity}`;
        }

        // التحقق من الحالة الحالية للمستخدم
        if (member.presence) {
            const status = member.presence.status;
            if (status === 'online') {
                return 'Online';
            } else if (status === 'idle') {
                return 'Idle';
            } else if (status === 'dnd') {
                return 'Dnd';
            } else {
                return 'Offline';
            }
        } else {
            return 'غير متصل';
        }
    } catch (error) {
        console.error('خطأ في جمع آخر نشاط:', error);
        return 'غير معروف';
    }
}

// الدالة الرئيسية لجمع جميع الإحصائيات
async function collectUserStats(member) {
    try {
        const userId = member.id;
        const user = member.user;

        // معلومات أساسية
        const joinedAt = member.joinedTimestamp;
        const createdAt = user.createdTimestamp;
        const now = Date.now();

        // حساب الأوقات
        const timeInServerMs = now - joinedAt; // Renamed from timeInServer to timeInServerMs for clarity
        const accountAgeMs = now - createdAt; // Renamed from accountAge to accountAgeMs for clarity

        // تنسيق المدة في السيرفر
        const timeInServerFormatted = formatTimeInServer(timeInServerMs);

        function formatTimeInServer(ms) {
            const totalSeconds = Math.floor(ms / 1000);
            const totalMinutes = Math.floor(totalSeconds / 60);
            const totalHours = Math.floor(totalMinutes / 60);
            const days = Math.floor(totalHours / 24);

            const hours = totalHours % 24;
            const minutes = totalMinutes % 60;

            const parts = [];
            if (days > 0) parts.push(`**${days}d**`);
            if (hours > 0) parts.push(`**${hours}h**`);
            if (minutes > 0) parts.push(`**${minutes}m**`);

            return parts.length > 0 ? parts.join(' , ') : '**أقل من دقيقة**';
        }

        // تنسيق عمر الحساب
        const accountAgeFormatted = formatAccountAge(createdAt);

        function formatAccountAge(createdTimestamp) {
            const ms = Date.now() - createdTimestamp;
            const totalSeconds = Math.floor(ms / 1000);
            const totalMinutes = Math.floor(totalSeconds / 60);
            const totalHours = Math.floor(totalMinutes / 60);
            const days = Math.floor(totalHours / 24);

            const hours = totalHours % 24;
            const minutes = totalMinutes % 60;

            const parts = [];
            if (days > 0) parts.push(`**${days}d**`);
            if (hours > 0) parts.push(`**${hours}h**`);
            if (minutes > 0) parts.push(`**${minutes}m**`);

            return parts.length > 0 ? parts.join(' , ') : '**أقل من دقيقة**';
        }


        // جمع الإحصائيات الفعلية
        const realStats = await getRealUserStats(userId);
        const lastActivity = getLastActivity(member);

        // فحص الحالات الخاصة
        const vacationStatus = getVacationStatus(userId);
        const downStatus = getDownStatus(userId);

        // تحديد حالة الحساب
        let accountStatus = 'Human';
        let statusDetails = '';

        if (vacationStatus.hasVacation) {
            accountStatus = 'في إجازة';
            statusDetails = `إجازة تنتهي : ${vacationStatus.endDate.toLocaleDateString('en-US')}`;
        } else if (downStatus.hasDown) {
            accountStatus = 'On Down';
            const guild = member.guild;
            const role = guild.roles.cache.get(downStatus.roleId);
            statusDetails = `داون على رول : ${role ? role.name : 'دور محذوف'}`;
        }

        // جلب البيانات الأسبوعية
        const { getDatabase } = require('./database');
        const dbManager = getDatabase();
        const weeklyStats = await dbManager.getWeeklyStats(userId);

        return {
            // معلومات أساسية
            userId: userId,
            username: user.username,
            mention: `<@${userId}>`,
            displayName: member.displayName,
            avatar: user.displayAvatarURL({ dynamic: true }),

            // إحصائيات التفاعل الفعلية
            realMessages: realStats.messages || 0,
            realVoiceTime: realStats.voiceTime || 0,
            formattedVoiceTime: formatDuration(realStats.voiceTime || 0),
            joinedChannels: realStats.joinedChannels || 0,
            reactionsGiven: realStats.reactionsGiven || 0,
            activeDays: realStats.activeDays || 0,

            // البيانات الأسبوعية
            weeklyMessages: weeklyStats.weeklyMessages || 0,
            weeklyVoiceTime: weeklyStats.weeklyTime || 0,
            formattedWeeklyVoiceTime: formatDuration(weeklyStats.weeklyTime || 0),
            weeklyReactions: weeklyStats.weeklyReactions || 0,
            weeklyVoiceJoins: weeklyStats.weeklyVoiceJoins || 0,

            // تواريخ مهمة مع تنسيق محسن
            joinedServer: joinedAt,
            joinedServerFormatted: new Date(joinedAt).toLocaleDateString('en-US', {
                timeZone: 'Asia/Riyadh',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long'
            }),
            accountCreated: createdAt,
            accountCreatedFormatted: new Date(createdAt).toLocaleDateString('en-US', {
                timeZone: 'Asia/Riyadh',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long'
            }),

            // مدد زمنية
            timeInServerMs: timeInServerMs,
            timeInServerFormatted: timeInServerFormatted,
            accountAgeMs: accountAgeMs,
            accountAgeFormatted: accountAgeFormatted,

            // نشاط ووضع
            lastActivity: lastActivity,
            accountStatus: accountStatus,
            statusDetails: statusDetails,

            // أدوار حالية
            roleCount: member.roles.cache.size - 1, // عدا @everyone
            roles: member.roles.cache
                .filter(role => role.id !== member.guild.id) // عدا @everyone
                .map(role => ({ id: role.id, name: role.name })),

            // معلومات إضافية
            isBot: user.bot,
            hasAdminRoles: await checkIfHasAdminRoles(member),

            // timestamps للحسابات
            collectedAt: now
        };

    } catch (error) {
        console.error('خطأ في جمع إحصائيات المستخدم:', error);
        throw error;
    }
}

// دالة للتحقق من وجود أدوار إدارية
async function checkIfHasAdminRoles(member) {
    try {
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJsonFile(adminRolesPath, []);

        if (!Array.isArray(adminRoles) || adminRoles.length === 0) {
            return false;
        }

        return member.roles.cache.some(role => adminRoles.includes(role.id));
    } catch (error) {
        console.error('خطأ في فحص الأدوار الإدارية:', error);
        return false;
    }
}

// دالة تحديد نوع التقييم مع دعم الإعدادات المخصصة والتفاعل الصوتي
function getEvaluationType(totalMessages, weeklyMessages, totalVoiceTime, weeklyVoiceTime, totalReactions, weeklyReactions, activeDays, daysInServer) {
    // تحميل الإعدادات المخصصة
    const customSettings = loadEvaluationSettings();

    // اختيار القيم المناسبة بناءً على إعدادات resetWeekly
    const messageCount = customSettings.minMessages.resetWeekly ? weeklyMessages : totalMessages;
    const voiceTime = customSettings.minVoiceTime.resetWeekly ? weeklyVoiceTime : totalVoiceTime;
    const reactionCount = customSettings.minReactions.resetWeekly ? weeklyReactions : totalReactions;

    // معايير التقييم من الإعدادات أو القيم الافتراضية
    const EXCELLENT_THRESHOLD = {
        messages: customSettings.minMessages.excellent,
        voiceTime: customSettings.minVoiceTime.excellent,
        reactions: customSettings.minReactions.excellent,
        activeDays: Math.ceil(customSettings.activeDaysPerWeek.minimum * 2), // ضعف الحد الأدنى للنشاط الأسبوعي
        daysInServer: customSettings.timeInServerDays.excellent
    };

    const GOOD_THRESHOLD = {
        messages: customSettings.minMessages.good,
        voiceTime: customSettings.minVoiceTime.good,
        reactions: customSettings.minReactions.good,
        activeDays: customSettings.activeDaysPerWeek.minimum,
        daysInServer: customSettings.timeInServerDays.minimum
    };

    const WEAK_THRESHOLD = {
        messages: customSettings.minMessages.weak,
        voiceTime: customSettings.minVoiceTime.weak,
        reactions: customSettings.minReactions.weak
    };

    // حساب التقييم بناءً على المعايير المخصصة (يجب تحقيق جميع الشروط)
    if (messageCount >= EXCELLENT_THRESHOLD.messages &&
        voiceTime >= EXCELLENT_THRESHOLD.voiceTime &&
        reactionCount >= EXCELLENT_THRESHOLD.reactions &&
        activeDays >= EXCELLENT_THRESHOLD.activeDays &&
        daysInServer >= EXCELLENT_THRESHOLD.daysInServer) {
        return { type: 'ممتاز', emoji: '🌟', color: '#00ff00' };
    } else if (messageCount >= GOOD_THRESHOLD.messages &&
               voiceTime >= GOOD_THRESHOLD.voiceTime &&
               reactionCount >= GOOD_THRESHOLD.reactions &&
               activeDays >= GOOD_THRESHOLD.activeDays &&
               daysInServer >= GOOD_THRESHOLD.daysInServer) {
        return { type: 'جيد', emoji: '✅', color: '#ffaa00' };
    } else {
        return { type: 'ضعيف', emoji: '⚠️', color: '#ff6600' };
    }
}

// دالة تحميل إعدادات التقييم المخصصة
function loadEvaluationSettings() {
    try {
        const adminApplicationsPath = path.join(__dirname, '..', 'data', 'adminApplications.json');
        if (fs.existsSync(adminApplicationsPath)) {
            const data = JSON.parse(fs.readFileSync(adminApplicationsPath, 'utf8'));
            const evaluation = data.settings?.evaluation;

            if (evaluation) {
                return {
                    minMessages: evaluation.minMessages || { weak: 20, good: 50, excellent: 100, resetWeekly: false },
                    minVoiceTime: evaluation.minVoiceTime || {
                        weak: 2 * 60 * 60 * 1000,
                        good: 5 * 60 * 60 * 1000,
                        excellent: 10 * 60 * 60 * 1000,
                        resetWeekly: false
                    },
                    minReactions: evaluation.minReactions || { weak: 10, good: 25, excellent: 50, resetWeekly: false },
                    activeDaysPerWeek: evaluation.activeDaysPerWeek || { minimum: 3, resetWeekly: true },
                    timeInServerDays: evaluation.timeInServerDays || { minimum: 7, excellent: 30 }
                };
            }
        }
    } catch (error) {
        console.error('خطأ في تحميل إعدادات التقييم:', error);
    }

    // القيم الافتراضية
    return {
        minMessages: { weak: 20, good: 50, excellent: 100, resetWeekly: false },
        minVoiceTime: {
            weak: 2 * 60 * 60 * 1000,
            good: 5 * 60 * 60 * 1000,
            excellent: 10 * 60 * 60 * 1000,
            resetWeekly: false
        },
        minReactions: { weak: 10, good: 25, excellent: 50, resetWeekly: false },
        activeDaysPerWeek: { minimum: 3, resetWeekly: true },
        timeInServerDays: { minimum: 7, excellent: 30 }
    };
}

// دالة لحساب أيام النشاط مع دعم الإعدادات المخصصة واستخدام قاعدة البيانات
async function calculateWeeklyActivity(stats) {
    try {
        const { getDatabase } = require('./database');
        const dbManager = getDatabase();

        const customSettings = loadEvaluationSettings();
        const activitySettings = customSettings.activeDaysPerWeek;

        let activeDays = 0;

        if (activitySettings.resetWeekly) {
            // استخدام أيام النشاط الأسبوعية من قاعدة البيانات
            activeDays = stats.weeklyActiveDays || await dbManager.getWeeklyActiveDays(stats.userId);
        } else {
            // استخدام أيام النشاط الشهرية من قاعدة البيانات
            activeDays = stats.activeDays || await dbManager.getActiveDaysCount(stats.userId, 30);
        }

        console.log(`📊 تم حساب أيام النشاط للمستخدم ${stats.userId}: ${activeDays} أيام (${activitySettings.resetWeekly ? 'أسبوعي' : 'شهري'})`);
        return activeDays;

    } catch (error) {
        console.error('❌ خطأ في حساب أيام النشاط:', error);
        // العودة للحساب التقديري في حالة الخطأ
        return Math.min(
            Math.floor((stats.realMessages || 0) / 10) + Math.floor((stats.joinedChannels || 0) / 2),
            7
        );
    }
}

// دالة للتحقق من حالة الإجازة المخصصة
function getCustomVacationStatus(userId) {
    try {
        const vacations = readJsonFile(vacationsPath, { active: {} });
        const activeVacation = vacations.active?.[userId];

        if (activeVacation) {
            const endDate = new Date(activeVacation.endDate);
            return {
                hasVacation: true,
                endDate: endDate,
                reason: activeVacation.reason || 'غير محدد',
                startDate: new Date(activeVacation.startDate),
                approvedBy: activeVacation.approvedBy
            };
        }

        return { hasVacation: false };
    } catch (error) {
        console.error('خطأ في فحص حالة الإجازة المخصصة:', error);
        return { hasVacation: false };
    }
}

// دالة للتحقق من حالة الداون المخصصة
function getCustomDownStatus(userId) {
    try {
        const activeDowns = readJsonFile(activeDownsPath, {});

        for (const [downId, downData] of Object.entries(activeDowns)) {
            if (downData.userId === userId) {
                return {
                    hasDown: true,
                    reason: downData.reason || 'غير محدد',
                    endTime: downData.endTime ? new Date(downData.endTime) : null,
                    roleId: downData.roleId,
                    startTime: downData.startTime ? new Date(downData.startTime) : null,
                    byUserId: downData.byUserId
                };
            }
        }

        return { hasDown: false };
    } catch (error) {
        console.error('خطأ في فحص حالة الداون المخصصة:', error);
        return { hasDown: false };
    }
}

// دالة لإنشاء embed المعلومات المحسن
async function createUserStatsEmbed(userStats, colorManager, simpleView = false, requesterName = null, requesterMention = null) {
    // تحميل إعدادات التقييم في البداية
    const evaluationSettings = loadEvaluationSettings();

    const embed = colorManager.createEmbed()
        .setTitle(simpleView ? ` تقديم إداري` : ` ${userStats.mention}`)
        .setThumbnail(userStats.avatar);

    if (simpleView && requesterMention) {
        // عرض مبسط ومختصر للآيفون
        embed.setDescription(`**Admin :** ${requesterMention}\n**Member :** ${userStats.mention}`);
    }

    if (simpleView) {
        // عرض مبسط ومختصر للآيفون - حد أقصى 3 حقول

        const messageCount = evaluationSettings.minMessages.resetWeekly ? userStats.weeklyMessages || 0 : userStats.realMessages;

        const messageLabel = evaluationSettings.minMessages.resetWeekly ? "<:emoji_21:1429266842345672746> Chat " : "<:emoji_21:1429266842345672746> Chat ";
        const voiceLabel = evaluationSettings.minVoiceTime.resetWeekly ? "<:emoji_25:1429267527111938118> Voice" : "<:emoji_25:1429267527111938118> Voice";

        const formattedVoiceTime = evaluationSettings.minVoiceTime.resetWeekly
            ? userStats.formattedWeeklyVoiceTime || 'No Data'
            : userStats.formattedVoiceTime || 'No Data';

        // فقط 3 حقول أساسية للآيفون
        embed.addFields([
            {
                name: messageLabel,
                value: `**${messageCount.toLocaleString()}**`,
                inline: true
            },
            {
                name: voiceLabel,
                value: `${formattedVoiceTime}`,
                inline: true
            },
            {
                name: '<:emoji_73:1442588719201648811> Time in server',
                value: `${userStats.timeInServerFormatted}`,
                inline: true
            }
        ]);

        // معلومات إضافية في سطر واحد
        embed.setFooter({
            text: `Active day : ${userStats.activeDays}d  • Roles : ${userStats.roleCount}`
        });
    } else {
        // العرض الكامل والمفصل
        const weeklyActivity = await calculateWeeklyActivity(userStats);
        const timeInServerDays = Math.floor(userStats.timeInServerMs / (24 * 60 * 60 * 1000));

        // تحديد مستوى الرسائل
        const messagesUsed = evaluationSettings.minMessages.resetWeekly ? (userStats.weeklyMessages || 0) : userStats.realMessages;
        let messageLevel = 'Not active';
        if (messagesUsed >= evaluationSettings.minMessages.excellent) {
            messageLevel = 'Active ';
        } else if (messagesUsed >= evaluationSettings.minMessages.good) {
            messageLevel = 'Not bad';
        }

        // تحديد مستوى النشاط الأسبوعي
        const isActiveWeekly = weeklyActivity >= evaluationSettings.activeDaysPerWeek.minimum;
        let activityStatus = '';
        if (evaluationSettings.activeDaysPerWeek.resetWeekly) {
            activityStatus = `${weeklyActivity}/${evaluationSettings.activeDaysPerWeek.minimum} Days in week`;
        } else {
            activityStatus = `${userStats.activeDays} All days`;
        }

        // تحديد مستوى الخبرة في السيرفر
        let timeLevel = 'جديد';
        if (timeInServerDays >= evaluationSettings.timeInServerDays.excellent) {
            timeLevel = 'خبرة ممتازة';
        } else if (timeInServerDays >= evaluationSettings.timeInServerDays.minimum) {
            timeLevel = 'خبرة جيدة';
        }

        // تحديد مستوى التفاعل الصوتي
        const voiceTimeUsed = evaluationSettings.minVoiceTime.resetWeekly ? (userStats.weeklyVoiceTime || 0) : userStats.realVoiceTime;
        let voiceLevel = 'ضعيف';
        if (voiceTimeUsed >= evaluationSettings.minVoiceTime.excellent) {
            voiceLevel = 'ممتاز';
        } else if (voiceTimeUsed >= evaluationSettings.minVoiceTime.good) {
            voiceLevel = 'جيد';
        }

        // تحديد التقييم العام
        let evaluation = '';
        if (messagesUsed >= evaluationSettings.minMessages.excellent &&
            voiceTimeUsed >= evaluationSettings.minVoiceTime.excellent &&
            isActiveWeekly &&
            timeInServerDays >= evaluationSettings.timeInServerDays.excellent) {
            evaluation = '🟢 **Perfect member to be admin **';
        } else if (messagesUsed >= evaluationSettings.minMessages.good &&
                   voiceTimeUsed >= evaluationSettings.minVoiceTime.good &&
                   isActiveWeekly &&
                   timeInServerDays >= evaluationSettings.timeInServerDays.minimum) {
            evaluation = '🟡 **Not Bad member **';
        } else {
            evaluation = '🔴 **Not Active member **';
        }

        // تحديد التسميات والقيم المستخدمة في الحقول
        const messagesLabel = evaluationSettings.minMessages.resetWeekly ? "<:emoji:1443616698996359380> Weekly message" : "<:emoji:1443616698996359380> All messages";
        const messageValue = messagesUsed;
        const voiceLabel = evaluationSettings.minVoiceTime.resetWeekly ? "<:emoji:1443616700707635343> Weekly Voice" : "<:emoji:1443616700707635343> All voice";
        const voiceValue = evaluationSettings.minVoiceTime.resetWeekly
            ? userStats.formattedWeeklyVoiceTime || 'No Data'
            : userStats.formattedVoiceTime || 'No Data';
        const reactionsLabel = "Reactions";
        const reactionValue = userStats.reactions || 0;

        const embed = new EmbedBuilder()
            .setTitle(`**Admins**`)
            .setThumbnail(userStats.avatar)
            .setColor(colorManager.getColor() || '#3498db')
            .addFields([
                {
                    name: '**information**',
                    value: `\n **العضو :** ${userStats.mention}\n**الاي دي :** \`${userStats.userId}\`\n **حالة الحساب :** ${userStats.accountStatus}\n`,
                    inline: false
                },
                {
                    name: ' **Actives**',
                    value: ` **${messagesLabel}:** \`${messageValue.toLocaleString()}\`\n **${voiceLabel} :** ${voiceValue}\n** انضمام فويس :** \`${userStats.joinedChannels || 0}\`\n **${reactionsLabel} :** \`${reactionValue.toLocaleString()}\``,
                    inline: true
                },
                {
                    name: ' **times **',
                    value: ` ** inter server :** \`___${userStats.joinedServerFormatted}___\`\n ** create account :** \`___${userStats.accountCreatedFormatted}___\`\n ** in server :** ___${userStats.timeInServerFormatted}___`,
                    inline: true
                },
                {
                    name: ' **Status**',
                    value: ` **active :** ${activityStatus}\n ${userStats.lastActivity}`,
                    inline: true
                },
                {

                        name: ' **Roles**',

                        value: `** عدد الرولات :** \`${userStats.roleCount || 0}\`\n ** إداري حالياً :** ${userStats.hasAdminRoles ? '✅ **نعم**' : '❌ **لا**'}`,

                        inline: true
                }
            ])
            .setFooter({
                text: `By Ahmed `,
                iconURL: userStats.avatar
            })
            .setTimestamp();

        // إضافة تفاصيل الحالة إذا كانت موجودة
        if (userStats.statusDetails) {
            embed.addFields([{ name: '⚠️ تفاصيل الحالة الخاصة', value: userStats.statusDetails, inline: false }]);
        }

        // إضافة تفاصيل التقييم
        embed.addFields([
            {
                name: 'Rate',
                value: `**${messagesLabel}:** ${messageLevel} (${messageValue.toLocaleString()})\n**${voiceLabel}:** ${voiceLevel} (${voiceValue})\n**النشاط :** ${isActiveWeekly ? '✅' : '❌'} ${activityStatus}\n**الخبرة :** ${timeLevel} (${timeInServerDays} يوم)`,
                inline: true
            },
            {
                name: 'Rating',
                value: evaluation,
                inline: false
            }
        ]);
    }


    return embed;
}

// دالة لتهيئة نظام تتبع النشاط
async function initializeActivityTracking(client) {
    console.log('🔄 تهيئة نظام تتبع النشاط...');

    try {
        // التأكد من تهيئة قاعدة البيانات
        const { getDatabase } = require('./database');
        const dbManager = getDatabase();

        // ملاحظة: تتبع الرسائل يتم في bot.js المعالج الرئيسي لتجنب التكرار
        // ملاحظة: تتبع التفاعلات يتم في bot.js المعالج الرئيسي لتجنب التكرار
        // ملاحظة: تتبع الصوت يتم في bot.js للتحكم المحسن والمنطق المتقدم

        console.log('✅ تم تهيئة نظام تتبع النشاط بنجاح (بدون معالجات مكررة)');
        return true;
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام تتبع النشاط:', error);
        throw error;
    }
}

module.exports = {
    collectUserStats,
    createUserStatsEmbed,
    formatDuration,
    checkIfHasAdminRoles,
    getVacationStatus: getCustomVacationStatus, // إعادة تسمية لتجنب التعارض
    getDownStatus: getCustomDownStatus,       // إعادة تسمية لتجنب التعارض
    trackUserActivity,
    getRealUserStats,
    initializeActivityTracking,
    loadEvaluationSettings,
    getEvaluationType,
    calculateWeeklyActivity,
    calculateWeeklyVoiceTime
};