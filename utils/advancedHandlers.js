
const { ErrorHandler, InteractionHandler, MessageHandler } = require('./embedHelper.js');

// معالج التفاعلات المتقدم
class AdvancedInteractionHandler {
    constructor() {
        this.activeInteractions = new Map();
        this.rateLimits = new Map();
    }

    // منع التفاعلات المكررة
    isInteractionActive(interactionId) {
        return this.activeInteractions.has(interactionId);
    }

    setInteractionActive(interactionId, active = true) {
        if (active) {
            this.activeInteractions.set(interactionId, Date.now());
        } else {
            this.activeInteractions.delete(interactionId);
        }
    }

    // تنظيف التفاعلات القديمة
    cleanupOldInteractions() {
        const now = Date.now();
        for (const [id, timestamp] of this.activeInteractions.entries()) {
            if (now - timestamp > 300000) { // 5 دقائق
                this.activeInteractions.delete(id);
            }
        }
    }

    // معالج Rate Limiting
    checkRateLimit(userId, action, limit = 5, timeWindow = 60000) {
        const key = `${userId}_${action}`;
        const now = Date.now();
        
        if (!this.rateLimits.has(key)) {
            this.rateLimits.set(key, []);
        }
        
        const timestamps = this.rateLimits.get(key);
        
        // إزالة الطوابع الزمنية القديمة
        const recent = timestamps.filter(time => now - time < timeWindow);
        this.rateLimits.set(key, recent);
        
        if (recent.length >= limit) {
            return false; // تجاوز الحد المسموح
        }
        
        recent.push(now);
        return true;
    }

    // معالج شامل للتفاعلات
    async handleInteraction(interaction, handler, options = {}) {
        const {
            requireAuth = false,
            checkRateLimit = true,
            rateLimitAction = 'default',
            rateLimitCount = 5,
            rateLimitWindow = 60000,
            logAction = true
        } = options;

        try {
            // التحقق من صحة التفاعل
            if (!InteractionHandler.isValidInteraction(interaction)) {
                return false;
            }

            // التحقق من التفاعلات النشطة
            const interactionId = `${interaction.user.id}_${interaction.customId}`;
            if (this.isInteractionActive(interactionId)) {
                console.log(`تم تجاهل تفاعل مكرر: ${interactionId}`);
                return false;
            }

            // التحقق من Rate Limiting
            if (checkRateLimit && !this.checkRateLimit(interaction.user.id, rateLimitAction, rateLimitCount, rateLimitWindow)) {
                await InteractionHandler.safeReply(interaction, '**يرجى عدم الإفراط في استخدام هذا الأمر! انتظر قليلاً ثم حاول مرة أخرى.**');
                return false;
            }

            // تسجيل التفاعل كنشط
            this.setInteractionActive(interactionId);

            // تسجيل العملية
            if (logAction) {
                console.log(`معالجة تفاعل: ${interaction.customId} من المستخدم: ${interaction.user.id}`);
            }

            // تنفيذ المعالج
            const result = await handler(interaction);

            return result;

        } catch (error) {
            if (!ErrorHandler.handleDiscordError(error, 'AdvancedInteractionHandler')) {
                console.error('خطأ في معالج التفاعلات المتقدم:', error);
                await InteractionHandler.safeReply(interaction, '**حدث خطأ أثناء معالجة طلبك. يرجى المحاولة مرة أخرى لاحقاً.**');
            }
            return false;
        } finally {
            // إزالة التفاعل من القائمة النشطة
            const interactionId = `${interaction.user.id}_${interaction.customId}`;
            this.setInteractionActive(interactionId, false);
        }
    }

    // معالج الأخطاء العام
    async handleError(error, context, interaction = null) {
        // تسجيل الخطأ
        console.error(`خطأ في ${context}:`, {
            message: error.message,
            code: error.code,
            stack: error.stack?.split('\n')[0]
        });

        // محاولة الرد على المستخدم
        if (interaction && InteractionHandler.isValidInteraction(interaction)) {
            await InteractionHandler.safeReply(interaction, '**حدث خطأ غير متوقع. تم تسجيل الخطأ وسيتم إصلاحه قريباً.**');
        }

        return false;
    }

    // تنظيف دوري للذاكرة
    startCleanupTask() {
        setInterval(() => {
            this.cleanupOldInteractions();
            
            // تنظيف rate limits القديمة
            const now = Date.now();
            for (const [key, timestamps] of this.rateLimits.entries()) {
                const recent = timestamps.filter(time => now - time < 300000); // 5 دقائق
                if (recent.length === 0) {
                    this.rateLimits.delete(key);
                } else {
                    this.rateLimits.set(key, recent);
                }
            }
            
            console.log(`تنظيف الذاكرة: ${this.activeInteractions.size} تفاعل نشط، ${this.rateLimits.size} rate limit`);
        }, 300000); // كل 5 دقائق
    }
}

// معالج الأوامر المتقدم
class AdvancedCommandHandler {
    constructor() {
        this.commandStats = new Map();
        this.commandCooldowns = new Map();
    }

    // تسجيل إحصائيات الأوامر
    logCommandUsage(commandName, userId, success = true) {
        const key = `${commandName}_${success ? 'success' : 'error'}`;
        const current = this.commandStats.get(key) || 0;
        this.commandStats.set(key, current + 1);
    }

    // الحصول على إحصائيات الأوامر
    getCommandStats() {
        const stats = {};
        for (const [key, value] of this.commandStats.entries()) {
            const [command, type] = key.split('_');
            if (!stats[command]) {
                stats[command] = { success: 0, error: 0 };
            }
            stats[command][type] = value;
        }
        return stats;
    }

    // معالج Cooldown متقدم
    checkCooldown(userId, commandName, cooldownTime = 5000) {
        const key = `${userId}_${commandName}`;
        const lastUsed = this.commandCooldowns.get(key);
        
        if (lastUsed && Date.now() - lastUsed < cooldownTime) {
            return Math.ceil((cooldownTime - (Date.now() - lastUsed)) / 1000);
        }
        
        this.commandCooldowns.set(key, Date.now());
        return 0;
    }

    // معالج الأوامر الشامل
    async handleCommand(message, commandName, args, handler, options = {}) {
        const {
            requireAuth = false,
            adminOnly = false,
            ownerOnly = false,
            cooldown = 5000,
            validateArgs = null,
            logUsage = true
        } = options;

        try {
            // التحقق من Cooldown
            const remainingCooldown = this.checkCooldown(message.author.id, commandName, cooldown);
            if (remainingCooldown > 0) {
                await message.react('⏰');
                const cooldownMessage = await message.channel.send(`**يرجى الانتظار ${remainingCooldown} ثانية قبل استخدام هذا الأمر مرة أخرى.**`);
                setTimeout(() => {
                    MessageHandler.safeDelete(cooldownMessage);
                }, 5000);
                return false;
            }

            // التحقق من صحة المدخلات
            if (validateArgs && !validateArgs(args)) {
                await message.react('❌');
                return false;
            }

            // تنفيذ المعالج
            const result = await handler(message, args);

            // تسجيل الاستخدام
            if (logUsage) {
                this.logCommandUsage(commandName, message.author.id, !!result);
            }

            return result;

        } catch (error) {
            this.logCommandUsage(commandName, message.author.id, false);
            console.error(`خطأ في الأمر ${commandName}:`, error);
            await message.react('❌');
            return false;
        }
    }
}

// إنشاء instances عامة
const globalInteractionHandler = new AdvancedInteractionHandler();
const globalCommandHandler = new AdvancedCommandHandler();

// بدء تشغيل مهام التنظيف
globalInteractionHandler.startCleanupTask();

module.exports = {
    AdvancedInteractionHandler,
    AdvancedCommandHandler,
    globalInteractionHandler,
    globalCommandHandler,
    ErrorHandler,
    InteractionHandler,
    MessageHandler
};
