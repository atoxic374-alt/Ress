const schedule = require('node-schedule');
const moment = require('moment-timezone');
const { performDailyMaintenance, performMonthlyCleanup } = require('./database-archiver');

class DatabaseScheduler {
    constructor() {
        this.dailyJob = null;
        this.monthlyJob = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) {
            console.log('⚠️ المجدول يعمل بالفعل');
            return;
        }

        console.log('🚀 بدء مجدول قاعدة البيانات...');

        this.dailyJob = schedule.scheduleJob('0 2 * * *', async () => {
            console.log('\n⏰ تنفيذ الصيانة اليومية المجدولة...');
            try {
                const result = await performDailyMaintenance();
                console.log('✅ اكتملت الصيانة اليومية المجدولة');
            } catch (error) {
                console.error('❌ خطأ في الصيانة اليومية المجدولة:', error);
            }
        });

        this.monthlyJob = schedule.scheduleJob('0 3 1 * *', async () => {
            console.log('\n⏰ تنفيذ التنظيف الشهري المجدول...');
            try {
                const result = await performMonthlyCleanup();
                console.log('✅ اكتمل التنظيف الشهري المجدول');
            } catch (error) {
                console.error('❌ خطأ في التنظيف الشهري المجدول:', error);
            }
        });

        this.isRunning = true;
        
        console.log('✅ تم تشغيل مجدول قاعدة البيانات بنجاح');
        console.log('📅 الصيانة اليومية: كل يوم الساعة 2:00 صباحاً');
        console.log('📅 التنظيف الشهري: أول يوم من كل شهر الساعة 3:00 صباحاً');
    }

    stop() {
        if (this.dailyJob) {
            this.dailyJob.cancel();
            this.dailyJob = null;
        }

        if (this.monthlyJob) {
            this.monthlyJob.cancel();
            this.monthlyJob = null;
        }

        this.isRunning = false;
        console.log('⏹️ تم إيقاف مجدول قاعدة البيانات');
    }

    async runMaintenanceNow() {
        console.log('🔧 تنفيذ الصيانة اليومية يدوياً...');
        try {
            const result = await performDailyMaintenance();
            return result;
        } catch (error) {
            console.error('❌ خطأ في تنفيذ الصيانة:', error);
            throw error;
        }
    }

    async runCleanupNow() {
        console.log('🗑️ تنفيذ التنظيف الشهري يدوياً...');
        try {
            const result = await performMonthlyCleanup();
            return result;
        } catch (error) {
            console.error('❌ خطأ في تنفيذ التنظيف:', error);
            throw error;
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            dailyJobScheduled: this.dailyJob !== null,
            monthlyJobScheduled: this.monthlyJob !== null,
            nextDailyRun: this.dailyJob ? this.dailyJob.nextInvocation() : null,
            nextMonthlyRun: this.monthlyJob ? this.monthlyJob.nextInvocation() : null
        };
    }
}

const scheduler = new DatabaseScheduler();

module.exports = {
    scheduler,
    startScheduler: () => scheduler.start(),
    stopScheduler: () => scheduler.stop(),
    runMaintenanceNow: () => scheduler.runMaintenanceNow(),
    runCleanupNow: () => scheduler.runCleanupNow(),
    getSchedulerStatus: () => scheduler.getStatus()
};
