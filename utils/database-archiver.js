const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const moment = require('moment-timezone');
const { execSync } = require('child_process');

class DatabaseArchiver {
    constructor() {
        this.mainDbPath = path.join(__dirname, '..', 'database', 'discord_bot.db');
        this.archiveDir = path.join(__dirname, '..', 'database', 'archives');
        this.emergencyThreshold = 90;
        this.warningThreshold = 80;
        
        if (!fs.existsSync(this.archiveDir)) {
            fs.mkdirSync(this.archiveDir, { recursive: true });
        }
    }

    getDiskUsage() {
        try {
            const output = execSync('df -h / | tail -1').toString();
            const match = output.match(/(\d+)%/);
            if (match) {
                return parseInt(match[1]);
            }
            return 0;
        } catch (error) {
            console.warn('⚠️ لم أستطع قراءة مساحة القرص، أفترض أنها آمنة');
            return 0;
        }
    }

    async handleEmergencyCleanup() {
        console.log('🚨 تنبيه: القرص ممتلئ! بدء التنظيف الطارئ...');
        
        try {
            await this.compressMainDatabase();
            console.log('✅ تم ضغط قاعدة البيانات الرئيسية');

            const twoWeeksAgo = moment().tz('Asia/Riyadh').subtract(14, 'days').format('YYYY-MM-DD');
            
            const mainDb = new sqlite3.Database(this.mainDbPath);
            const oldSessions = await this.get(mainDb, 
                `SELECT COUNT(*) as count FROM voice_sessions WHERE date < ?`, [twoWeeksAgo]);
            
            if (oldSessions && oldSessions.count > 0) {
                console.log(`🗑️ حذف ${oldSessions.count} جلسة صوتية تفصيلية (أكثر من أسبوعين)...`);
                await this.run(mainDb, `DELETE FROM voice_sessions WHERE date < ?`, [twoWeeksAgo]);
                await this.run(mainDb, 'VACUUM');
                console.log('✅ تم حذف الجلسات التفصيلية فقط');
                console.log('✅ تم الحفاظ على daily_activity و user_totals للإحصائيات الشهرية');
            }
            
            mainDb.close();

            const archiveFiles = fs.readdirSync(this.archiveDir)
                .filter(file => file.startsWith('archive_') && file.endsWith('.db'));
            
            let deletedArchives = 0;
            for (const file of archiveFiles) {
                const dateMatch = file.match(/archive_(\d{4}-\d{2}-\d{2})\.db/);
                if (dateMatch) {
                    const fileDate = dateMatch[1];
                    if (fileDate < twoWeeksAgo) {
                        fs.unlinkSync(path.join(this.archiveDir, file));
                        deletedArchives++;
                    }
                }
            }
            
            if (deletedArchives > 0) {
                console.log(`🗑️ تم حذف ${deletedArchives} ملف أرشيف قديم`);
            }

            const newUsage = this.getDiskUsage();
            console.log(`✅ التنظيف الطارئ اكتمل - استخدام القرص: ${newUsage}%`);
            
            return { success: true, diskUsage: newUsage };
            
        } catch (error) {
            console.error('❌ خطأ في التنظيف الطارئ:', error);
            return { success: false, error: error.message };
        }
    }

    async checkAndHandleDiskSpace() {
        const usage = this.getDiskUsage();
        
        if (usage >= this.emergencyThreshold) {
            console.log(`🚨 تحذير: استخدام القرص ${usage}% - تفعيل التنظيف الطارئ!`);
            await this.handleEmergencyCleanup();
            return true;
        } else if (usage >= this.warningThreshold) {
            console.log(`⚠️ تنبيه: استخدام القرص ${usage}% - تشغيل الضغط الوقائي`);
            await this.compressMainDatabase();
            return false;
        }
        
        return false;
    }

    async run(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    }

    async all(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async get(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async archiveDailyData() {
        console.log('📦 بدء عملية الأرشفة اليومية...');
        
        try {
            const yesterday = moment().tz('Asia/Riyadh').subtract(1, 'days');
            const archiveDate = yesterday.format('YYYY-MM-DD');
            const archiveDbPath = path.join(this.archiveDir, `archive_${archiveDate}.db`);

            if (fs.existsSync(archiveDbPath)) {
                console.log(`⚠️ الأرشيف ليوم ${archiveDate} موجود مسبقاً`);
                return { success: true, message: 'Already archived' };
            }

            const mainDb = new sqlite3.Database(this.mainDbPath);
            const archiveDb = new sqlite3.Database(archiveDbPath);

            await this.run(archiveDb, 'PRAGMA journal_mode=WAL');
            await this.run(archiveDb, 'PRAGMA synchronous=NORMAL');

            await this.run(archiveDb, `CREATE TABLE IF NOT EXISTS voice_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                user_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                duration INTEGER NOT NULL,
                start_time INTEGER NOT NULL,
                end_time INTEGER NOT NULL,
                date TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now'))
            )`);

            await this.run(archiveDb, `CREATE TABLE IF NOT EXISTS daily_activity (
                date TEXT NOT NULL,
                user_id TEXT NOT NULL,
                voice_time INTEGER DEFAULT 0,
                messages INTEGER DEFAULT 0,
                reactions INTEGER DEFAULT 0,
                voice_joins INTEGER DEFAULT 0,
                PRIMARY KEY (date, user_id)
            )`);

            const sessionsToArchive = await this.all(mainDb, 
                `SELECT * FROM voice_sessions WHERE date = ?`, [archiveDate]);

            const dailyToArchive = await this.all(mainDb,
                `SELECT * FROM daily_activity WHERE date = ?`, [archiveDate]);

            console.log(`📊 وجدت ${sessionsToArchive.length} جلسة و ${dailyToArchive.length} نشاط يومي للأرشفة`);

            for (const session of sessionsToArchive) {
                await this.run(archiveDb, 
                    `INSERT OR IGNORE INTO voice_sessions 
                    (session_id, user_id, channel_id, channel_name, duration, start_time, end_time, date, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [session.session_id, session.user_id, session.channel_id, session.channel_name, 
                     session.duration, session.start_time, session.end_time, session.date, session.created_at]
                );
            }

            for (const activity of dailyToArchive) {
                await this.run(archiveDb,
                    `INSERT OR IGNORE INTO daily_activity 
                    (date, user_id, voice_time, messages, reactions, voice_joins)
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [activity.date, activity.user_id, activity.voice_time, 
                     activity.messages, activity.reactions, activity.voice_joins]
                );
            }

            await this.run(mainDb, `DELETE FROM voice_sessions WHERE date = ?`, [archiveDate]);
            
            await this.run(archiveDb, 'VACUUM');
            await this.run(archiveDb, 'ANALYZE');

            archiveDb.close();
            mainDb.close();

            console.log(`✅ تم أرشفة بيانات يوم ${archiveDate} بنجاح`);
            return { success: true, date: archiveDate, sessions: sessionsToArchive.length };

        } catch (error) {
            console.error('❌ خطأ في الأرشفة اليومية:', error);
            return { success: false, error: error.message };
        }
    }

    async compressMainDatabase() {
        console.log('🗜️ بدء ضغط قاعدة البيانات الرئيسية...');
        
        try {
            const mainDb = new sqlite3.Database(this.mainDbPath);
            
            await this.run(mainDb, 'PRAGMA wal_checkpoint(TRUNCATE)');
            await this.run(mainDb, 'PRAGMA incremental_vacuum');
            await this.run(mainDb, 'ANALYZE');
            await this.run(mainDb, 'PRAGMA optimize');

            mainDb.close();
            
            console.log('✅ تم ضغط قاعدة البيانات الرئيسية بنجاح');
            return { success: true };
            
        } catch (error) {
            console.error('❌ خطأ في ضغط قاعدة البيانات:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteMonthlyData() {
        console.log('🗑️ بدء عملية الحذف الشهري...');
        
        try {
            const oneMonthAgo = moment().tz('Asia/Riyadh').subtract(1, 'months');
            const cutoffDate = oneMonthAgo.format('YYYY-MM-DD');

            const archiveFiles = fs.readdirSync(this.archiveDir)
                .filter(file => file.startsWith('archive_') && file.endsWith('.db'));

            let deletedCount = 0;
            let totalSize = 0;

            for (const file of archiveFiles) {
                const dateMatch = file.match(/archive_(\d{4}-\d{2}-\d{2})\.db/);
                if (dateMatch) {
                    const fileDate = dateMatch[1];
                    if (fileDate < cutoffDate) {
                        const filePath = path.join(this.archiveDir, file);
                        const stats = fs.statSync(filePath);
                        totalSize += stats.size;
                        
                        fs.unlinkSync(filePath);
                        deletedCount++;
                        console.log(`🗑️ تم حذف ${file}`);
                    }
                }
            }

            const mainDb = new sqlite3.Database(this.mainDbPath);
            
            const deletedDaily = await this.get(mainDb,
                `SELECT COUNT(*) as count FROM daily_activity WHERE date < ?`, [cutoffDate]);
            
            await this.run(mainDb, 
                `DELETE FROM daily_activity WHERE date < ?`, [cutoffDate]);

            const deletedSessions = await this.get(mainDb,
                `SELECT COUNT(*) as count FROM voice_sessions WHERE date < ?`, [cutoffDate]);
            
            await this.run(mainDb,
                `DELETE FROM voice_sessions WHERE date < ?`, [cutoffDate]);

            await this.run(mainDb, 'VACUUM');
            
            mainDb.close();

            const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);
            console.log(`✅ تم حذف ${deletedCount} ملف أرشيف (${totalSizeMB} MB)`);
            console.log(`✅ تم حذف ${deletedDaily?.count || 0} نشاط يومي قديم`);
            console.log(`✅ تم حذف ${deletedSessions?.count || 0} جلسة صوتية قديمة`);
            console.log(`✅ البيانات المحذوفة: أقدم من ${cutoffDate}`);
            console.log('📊 user_totals محفوظة بالكامل (الإجماليات الكلية للأبد)');
            
            return { 
                success: true, 
                deletedFiles: deletedCount,
                freedSpaceMB: totalSizeMB,
                cutoffDate: cutoffDate,
                deletedDaily: deletedDaily?.count || 0,
                deletedSessions: deletedSessions?.count || 0
            };
            
        } catch (error) {
            console.error('❌ خطأ في الحذف الشهري:', error);
            return { success: false, error: error.message };
        }
    }

    async getDatabaseStats() {
        try {
            const stats = {
                main: { path: this.mainDbPath },
                archives: []
            };

            if (fs.existsSync(this.mainDbPath)) {
                const mainStats = fs.statSync(this.mainDbPath);
                stats.main.sizeInMB = (mainStats.size / (1024 * 1024)).toFixed(2);
                stats.main.sizeInBytes = mainStats.size;
            }

            if (fs.existsSync(this.archiveDir)) {
                const archiveFiles = fs.readdirSync(this.archiveDir)
                    .filter(file => file.endsWith('.db'));

                let totalArchiveSize = 0;
                for (const file of archiveFiles) {
                    const filePath = path.join(this.archiveDir, file);
                    const fileStats = fs.statSync(filePath);
                    totalArchiveSize += fileStats.size;
                    
                    stats.archives.push({
                        name: file,
                        sizeInMB: (fileStats.size / (1024 * 1024)).toFixed(2),
                        sizeInBytes: fileStats.size
                    });
                }

                stats.totalArchiveSizeMB = (totalArchiveSize / (1024 * 1024)).toFixed(2);
                stats.archiveCount = archiveFiles.length;
            }

            return stats;
        } catch (error) {
            console.error('❌ خطأ في جلب إحصائيات قاعدة البيانات:', error);
            return null;
        }
    }

    async performDailyMaintenance() {
        console.log('\n🔧 بدء الصيانة اليومية لقاعدة البيانات...');
        console.log('='.repeat(50));
        
        const diskUsage = this.getDiskUsage();
        console.log(`💾 استخدام القرص الحالي: ${diskUsage}%`);

        const emergencyHandled = await this.checkAndHandleDiskSpace();
        
        const results = {
            archive: null,
            compress: null,
            stats: null,
            emergency: emergencyHandled,
            diskUsageBefore: diskUsage,
            timestamp: moment().tz('Asia/Riyadh').format('YYYY-MM-DD HH:mm:ss')
        };

        results.archive = await this.archiveDailyData();
        
        if (!emergencyHandled) {
            results.compress = await this.compressMainDatabase();
        } else {
            results.compress = { success: true, message: 'تم الضغط في التنظيف الطارئ' };
        }
        
        results.stats = await this.getDatabaseStats();
        results.diskUsageAfter = this.getDiskUsage();

        console.log('\n📊 نتائج الصيانة اليومية:');
        console.log('='.repeat(50));
        console.log(`الوقت: ${results.timestamp}`);
        if (emergencyHandled) {
            console.log(`🚨 تم تفعيل التنظيف الطارئ!`);
        }
        console.log(`استخدام القرص: ${results.diskUsageBefore}% → ${results.diskUsageAfter}%`);
        console.log(`الأرشفة: ${results.archive.success ? '✅ نجحت' : '❌ فشلت'}`);
        console.log(`الضغط: ${results.compress.success ? '✅ نجح' : '❌ فشل'}`);
        if (results.stats) {
            console.log(`حجم قاعدة البيانات الرئيسية: ${results.stats.main.sizeInMB} MB`);
            console.log(`عدد الأرشيفات: ${results.stats.archiveCount || 0}`);
            console.log(`حجم الأرشيفات الإجمالي: ${results.stats.totalArchiveSizeMB || 0} MB`);
        }
        console.log('='.repeat(50) + '\n');

        return results;
    }

    async performMonthlyCleanup() {
        console.log('\n🗑️ بدء التنظيف الشهري...');
        console.log('='.repeat(50));
        
        const result = await this.deleteMonthlyData();
        
        if (result.success) {
            await this.compressMainDatabase();
        }

        console.log('='.repeat(50) + '\n');
        
        return result;
    }
}

const archiver = new DatabaseArchiver();

module.exports = {
    archiver,
    performDailyMaintenance: () => archiver.performDailyMaintenance(),
    performMonthlyCleanup: () => archiver.performMonthlyCleanup(),
    getDatabaseStats: () => archiver.getDatabaseStats()
};
