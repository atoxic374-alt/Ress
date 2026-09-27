const fs = require('fs');
const path = require('path');

// مسار ملف بيانات الوقت الصوتي
const voiceTimeDataPath = path.join(__dirname, '..', 'data', 'voiceTimeData.json');

// دالة لقراءة ملف JSON مع معالجة الأخطاء وإصلاح Sets
function readJsonFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            const parsedData = JSON.parse(data);
            
            // إصلاح Sets في totalByChannel
            if (parsedData.totalByChannel) {
                Object.keys(parsedData.totalByChannel).forEach(channelId => {
                    if (parsedData.totalByChannel[channelId].uniqueUsers !== undefined) {
                        const users = parsedData.totalByChannel[channelId].uniqueUsers;
                        // إصلاح البيانات الفاسدة أو تحويل Array إلى Set
                        if (Array.isArray(users)) {
                            // تصفية وتنظيف البيانات - إبقاء الـ strings فقط
                            const cleanUsers = users.filter(user => typeof user === 'string');
                            parsedData.totalByChannel[channelId].uniqueUsers = new Set(cleanUsers);
                        } else if (typeof users === 'object' && users !== null && !users.add) {
                            // إصلاح البيانات الفاسدة (مثل {})
                            parsedData.totalByChannel[channelId].uniqueUsers = new Set();
                        } else if (!users || typeof users.add !== 'function') {
                            // إنشاء Set جديد للحالات الأخرى
                            parsedData.totalByChannel[channelId].uniqueUsers = new Set();
                        }
                    }
                });
            }
            
            // إصلاح Sets في dailyStats
            if (parsedData.dailyStats) {
                Object.keys(parsedData.dailyStats).forEach(date => {
                    if (parsedData.dailyStats[date].uniqueUsers !== undefined) {
                        const users = parsedData.dailyStats[date].uniqueUsers;
                        // إصلاح البيانات الفاسدة أو تحويل Array إلى Set
                        if (Array.isArray(users)) {
                            // تصفية وتنظيف البيانات - إبقاء الـ strings فقط
                            const cleanUsers = users.filter(user => typeof user === 'string');
                            parsedData.dailyStats[date].uniqueUsers = new Set(cleanUsers);
                        } else if (typeof users === 'object' && users !== null && !users.add) {
                            // إصلاح البيانات الفاسدة (مثل {})
                            parsedData.dailyStats[date].uniqueUsers = new Set();
                        } else if (!users || typeof users.add !== 'function') {
                            // إنشاء Set جديد للحالات الأخرى
                            parsedData.dailyStats[date].uniqueUsers = new Set();
                        }
                    }
                });
            }
            
            return parsedData;
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error);
        return defaultValue;
    }
}

// دالة لكتابة ملف JSON مع تحويل Sets إلى Arrays تلقائياً
function writeJsonFile(filePath, data) {
    try {
        // إنشاء مجلد البيانات إذا لم يكن موجوداً
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // استخدام replacer لتحويل Sets إلى Arrays تلقائياً
        const replacer = (key, value) => {
            if (value instanceof Set) {
                return Array.from(value);
            }
            return value;
        };
        
        fs.writeFileSync(filePath, JSON.stringify(data, replacer, 2));
        return true;
    } catch (error) {
        console.error(`خطأ في كتابة ${filePath}:`, error);
        return false;
    }
}

// دالة لتنسيق الوقت
function formatDuration(value) {
    if (!value || value <= 0) return '0m';

    let totalMinutes;
    if (value > 525600) {
        totalMinutes = Math.floor(value / 60000);
    } else {
        totalMinutes = Math.floor(value);
    }

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);

    return parts.join(' and ');
}

// دالة لحفظ جلسة صوتية
async function saveVoiceSession(userId, channelId, channelName, duration, startTime, endTime, guildId = null) {
    try {
        // حفظ في قاعدة البيانات SQLite (المصدر الرئيسي)
        const dbManager = require('./database');
        
        // التأكد من تهيئة قاعدة البيانات
        if (typeof dbManager.initialize === 'function' && !dbManager.isInitialized) {
            await dbManager.initialize();
        }
        
        // حفظ الجلسة في قاعدة البيانات
        let sessionId = null;
        try {
            sessionId = await dbManager.saveVoiceSession(userId, channelId, channelName, duration, startTime, endTime, guildId);
        } catch (error) {
            console.error(`❌ خطأ في حفظ الجلسة في قاعدة البيانات:`, error);
            // استخدام معرف بديل في حالة الخطأ
            sessionId = `${userId}_${startTime}_${Math.random().toString(36).substr(2, 9)}`;
        }
        
        if (!sessionId) {
            console.error(`❌ فشل في حفظ الجلسة الصوتية في قاعدة البيانات للمستخدم ${userId}`);
            return null;
        }

        // حفظ نسخة احتياطية مبسطة في JSON (الجلسات الحديثة فقط - آخر 3 أيام)
        const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
        const voiceData = readJsonFile(voiceTimeDataPath, {
            lastBackup: Date.now(),
            recentSessions: [],
            backupNote: "هذا ملف نسخ احتياطي مبسط - البيانات الرئيسية في قاعدة البيانات SQLite"
        });

        // تاريخ اليوم
        const today = new Date(startTime).toDateString();
        
        // إضافة الجلسة الجديدة للنسخة الاحتياطية فقط (مبسطة)
        const session = {
            sessionId,
            userId,
            duration,
            startTime,
            date: today,
            formattedDuration: formatDuration(duration)
        };
        
        // إضافة الجلسة الجديدة
        voiceData.recentSessions = voiceData.recentSessions || [];
        voiceData.recentSessions.push(session);
        
        // إبقاء الجلسات الحديثة فقط (آخر 3 أيام)
        voiceData.recentSessions = voiceData.recentSessions.filter(s => s.startTime > threeDaysAgo);
        
        // تحديث تاريخ آخر نسخة احتياطية
        voiceData.lastBackup = Date.now();
        
        // إضافة إحصائية بسيطة
        voiceData.totalRecentSessions = voiceData.recentSessions.length;
        
        // حفظ النسخة الاحتياطية المبسطة في JSON
        const saveResult = writeJsonFile(voiceTimeDataPath, voiceData);
        
        if (!saveResult) {
            console.warn(`⚠️ فشل حفظ النسخة الاحتياطية JSON للمستخدم ${userId}`);
        }
        
        return sessionId;
        
    } catch (error) {
        console.error('خطأ في حفظ الجلسة الصوتية:', error);
        return null;
    }
}

// دالة للحصول على إحصائيات المستخدم الصوتية
async function getUserVoiceStats(userId) {
    try {
        // الحصول على البيانات من قاعدة البيانات (المصدر الرئيسي)
        const dbManager = require('./database');
        
        if (!dbManager.isInitialized) {
            await dbManager.initialize();
        }
        
        const userStats = await dbManager.getUserStats(userId);
        if (!userStats) {
            return {
                totalTime: 0,
                formattedTotalTime: 'لا يوجد',
                sessionsCount: 0,
                channels: {},
                averageSessionTime: 0,
                firstSession: null,
                lastSession: null
            };
        }
        
        const averageSessionTime = userStats.sessionsCount > 0 ? 
            userStats.totalTime / userStats.sessionsCount : 0;
        
        return {
            totalTime: userStats.totalTime,
            formattedTotalTime: formatDuration(userStats.totalTime),
            sessionsCount: userStats.sessionsCount,
            channels: userStats.channels || {},
            averageSessionTime,
            formattedAverageSessionTime: formatDuration(averageSessionTime),
            firstSession: userStats.firstSession,
            lastSession: userStats.lastSession
        };
        
    } catch (error) {
        console.error('خطأ في الحصول على إحصائيات المستخدم الصوتية:', error);
        return {
            totalTime: 0,
            formattedTotalTime: 'خطأ',
            sessionsCount: 0,
            channels: {},
            averageSessionTime: 0,
            firstSession: null,
            lastSession: null
        };
    }
}

// دالة للحصول على إحصائيات هذا الأسبوع من قاعدة البيانات
async function getWeeklyVoiceStats(userId) {
    try {
        const dbManager = require('./database');
        
        if (!dbManager.isInitialized) {
            await dbManager.initialize();
        }
        
        const weeklyStats = await dbManager.getWeeklyStats(userId);
        
        return {
            weeklyTime: weeklyStats.weeklyTime || 0,
            formattedWeeklyTime: formatDuration(weeklyStats.weeklyTime || 0),
            weeklySessions: weeklyStats.weeklySessions || 0,
            weeklyChannels: weeklyStats.weeklyChannels || {},
            weekStart: weeklyStats.weekStart || 'غير معروف'
        };
        
    } catch (error) {
        console.error('خطأ في حساب الإحصائيات الأسبوعية:', error);
        return {
            weeklyTime: 0,
            formattedWeeklyTime: 'خطأ',
            weeklySessions: 0,
            weeklyChannels: {},
            weekStart: 'غير معروف'
        };
    }
}

// دالة لتنظيف البيانات القديمة (الأقدم من شهرين) من قاعدة البيانات والنسخة الاحتياطية
async function cleanupOldVoiceData() {
    try {
        const twoMonthsAgo = Date.now() - (60 * 24 * 60 * 60 * 1000); // 60 يوماً
        
        // تنظيف قاعدة البيانات
        const dbManager = require('./database');
        if (!dbManager.isInitialized) {
            await dbManager.initialize();
        }
        
        const dbCleanedCount = await dbManager.run(`
            DELETE FROM voice_sessions 
            WHERE start_time < ?
        `, [twoMonthsAgo]);
        
        // تنظيف النسخة الاحتياطية JSON
        const voiceData = readJsonFile(voiceTimeDataPath, { recentSessions: [] });
        const originalSessionsCount = voiceData.recentSessions ? voiceData.recentSessions.length : 0;
        
        if (voiceData.recentSessions) {
            voiceData.recentSessions = voiceData.recentSessions.filter(session => session.startTime > twoMonthsAgo);
        }
        
        const cleanedSessionsCount = originalSessionsCount - (voiceData.recentSessions ? voiceData.recentSessions.length : 0);
        
        if (cleanedSessionsCount > 0 || dbCleanedCount > 0) {
            writeJsonFile(voiceTimeDataPath, voiceData);
            console.log(`🧹 تم تنظيف ${dbCleanedCount || 0} جلسة من قاعدة البيانات و ${cleanedSessionsCount} من النسخة الاحتياطية`);
        }
        
        return (dbCleanedCount || 0) + cleanedSessionsCount;
        
    } catch (error) {
        console.error('خطأ في تنظيف البيانات القديمة:', error);
        return 0;
    }
}

module.exports = {
    saveVoiceSession,
    getUserVoiceStats,
    getWeeklyVoiceStats,
    cleanupOldVoiceData,
    formatDuration
};
