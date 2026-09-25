const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { getDatabasePath, getDataDir } = require('./storagePaths');
const moment = require('moment-timezone');
const { normalizeMentionableIds } = require('./mentions');

// ضبط بداية الأسبوع على السبت (حسب التقويم العربي)
moment.updateLocale('en', {
    week: {
        dow: 6, // السبت هو بداية الأسبوع (0=الأحد, 6=السبت)
        doy: 12 // أول أسبوع في السنة
    }
});

// إنشاء مجلد قاعدة البيانات
const dbPath = getDatabasePath('discord_bot.db');

class DatabaseManager {
    constructor(databasePath = dbPath) {
        this.databasePath = databasePath;
        this.db = null;
        this.isInitialized = false;
        this.isDegraded = false;
        this.initializationPromise = null;
        this.writeQueue = Promise.resolve();
    }

    // تهيئة قاعدة البيانات
    async initialize() {
        if (this.isInitialized) return this;
        if (this.initializationPromise) return this.initializationPromise;

        this.initializationPromise = this.initializeInternal().finally(() => {
            this.initializationPromise = null;
        });

        return this.initializationPromise;
    }

    async recoverPersistent() {
        if (!this.isDegraded) return this;
        if (this.initializationPromise) return this.initializationPromise;
        await this.closeAsync().catch(() => null);
        this.db = null;
        this.isInitialized = false;
        this.isDegraded = false;
        return this.initialize();
    }

    async initializeInternal() {
        try {
            // إنشاء مجلد قاعدة البيانات إذا لم يكن موجوداً
            const fs = require('fs');
            const dbDir = path.dirname(this.databasePath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = await this.openDatabaseWithFallback(this.databasePath);
            await this.prepareDatabase();

            this.isInitialized = true;
            console.log(this.isDegraded
                ? '✅ تم تهيئة قاعدة بيانات مؤقتة في الذاكرة لاستمرار عمل البوت'
                : '✅ تم تهيئة قاعدة البيانات بنجاح مع تحسينات الأداء');
        } catch (error) {
            console.error('❌ خطأ في تهيئة قاعدة البيانات:', error);
            throw error;
        }
    }

    openDatabase(filePath) {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(filePath, (error) => {
                if (error) reject(error);
                else resolve(db);
            });
        });
    }

    async prepareDatabase() {
        this.db.configure('busyTimeout', Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 60000));
        this.db.serialize();

        try {
            await this.applyPragmas();
            await this.createTables();
            await this.runResponsibilityMigrations();
            await this.createIndexes();
        } catch (error) {
            if (!this.isDegraded && this.isBusyError(error)) {
                console.warn('⚠️ ملف SQLite مقفول أثناء التهيئة؛ سيتم التحويل لقاعدة مؤقتة حتى يعمل البوت والتكت.');
                await this.closeAsync().catch(() => null);
                this.db = await this.openDatabase(':memory:');
                this.isDegraded = true;
                this.writeQueue = Promise.resolve();
                this.db.configure('busyTimeout', Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 60000));
                this.db.serialize();
                await this.applyPragmas();
                await this.createTables();
                await this.runResponsibilityMigrations();
                await this.createIndexes();
                return;
            }
            throw error;
        }
    }

    async applyPragmas() {
        await this.run('PRAGMA journal_mode=WAL');
        await this.run('PRAGMA synchronous=NORMAL');
        await this.run('PRAGMA temp_store=MEMORY');
        await this.run('PRAGMA cache_size=-65536');
        await this.run('PRAGMA mmap_size=268435456');
        await this.run('PRAGMA locking_mode=NORMAL');
        await this.run(`PRAGMA busy_timeout=${Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 60000)}`);
        await this.run('PRAGMA threads=4');
        await this.run('PRAGMA wal_autocheckpoint=1000');
        await this.run('PRAGMA cache_spill=ON');
        await this.run('PRAGMA secure_delete=OFF');
        await this.run('PRAGMA auto_vacuum=NONE');
        await this.run('PRAGMA cell_size_check=OFF');
        await this.run('PRAGMA automatic_index=ON');
    }

    async runResponsibilityMigrations() {
        try {
            const tableInfo = await this.all("PRAGMA table_info(responsibilities)");
            const hasConfig = tableInfo.some(col => col.name === 'config');
            if (!hasConfig) {
                console.log('⚠️ Adding missing "config" column to responsibilities table');
                await this.run('ALTER TABLE responsibilities ADD COLUMN config TEXT');
            }
            const hasImage = tableInfo.some(col => col.name === 'image');
            if (!hasImage) {
                console.log('⚠️ Adding missing "image" column to responsibilities table');
                await this.run('ALTER TABLE responsibilities ADD COLUMN image TEXT');
            }
        } catch (migrationError) {
            console.error('❌ Migration Error:', migrationError);
        }
    }

    closeAsync() {
        return new Promise((resolve, reject) => {
            if (!this.db) return resolve();
            this.db.close((error) => error ? reject(error) : resolve());
        });
    }

    async openDatabaseWithFallback(filePath) {
        const attempts = Number(process.env.SQLITE_OPEN_RETRIES || 5);
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const db = await this.openDatabase(filePath);
                this.isDegraded = false;
                return db;
            } catch (error) {
                if (!this.isBusyError(error) || attempt === attempts) {
                    console.error(`❌ تعذر فتح SQLite من ${filePath}:`, error.message);
                    break;
                }
                const delay = Math.min(1000 * attempt, 5000);
                console.warn(`⚠️ SQLite مشغول أثناء الفتح، إعادة المحاولة ${attempt}/${attempts} بعد ${delay}ms`);
                await this.delay(delay);
            }
        }

        console.warn('⚠️ سيتم تشغيل قاعدة بيانات مؤقتة في الذاكرة حتى يعمل البوت والتكت رغم قفل ملف SQLite.');
        this.isDegraded = true;
        return this.openDatabase(':memory:');
    }

    async getResponsibilities() {
        try {
            const rows = await this.all('SELECT name, config, image FROM responsibilities');
            const data = {};
            for (const row of rows) {
                try {
                    const configStr = row.config || '{}';
                    const parsedConfig = JSON.parse(configStr);
                    if (Array.isArray(parsedConfig.responsibles)) {
                        parsedConfig.responsibles = normalizeMentionableIds(parsedConfig.responsibles);
                    }
                    if (row.image) {
                        parsedConfig.image = row.image;
                    }
                    data[row.name] = parsedConfig;
                } catch (e) {
                    console.error(`Error parsing config for ${row.name}:`, e);
                    data[row.name] = { responsibles: [], description: '' };
                }
            }
            
            // If DB is empty, try to seed from JSON
            if (Object.keys(data).length === 0) {
                const fs = require('fs');
                const path = require('path');
                const jsonPath = path.join(getDataDir(), 'responsibilities.json');
                if (fs.existsSync(jsonPath)) {
                    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    if (jsonData && Object.keys(jsonData).length > 0) {
                        console.log('🌱 Seeding database from responsibilities.json');
                        for (const [name, config] of Object.entries(jsonData)) {
                            await this.updateResponsibility(name, config);
                            data[name] = config;
                        }
                    }
                }
            }
            
            return data;
        } catch (error) {
            console.error('Error in getResponsibilities:', error);
            return {};
        }
    }

    async updateResponsibility(name, config) {
        try {
            const normalizedConfig = {
                ...(config || {})
            };
            if (Array.isArray(normalizedConfig.responsibles)) {
                normalizedConfig.responsibles = normalizeMentionableIds(normalizedConfig.responsibles);
            }
            const imageValue = typeof config?.image === 'string' ? config.image : null;
            await this.run(`
                INSERT INTO responsibilities (name, config, image)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    config = excluded.config,
                    image = COALESCE(excluded.image, responsibilities.image)
            `, [name, JSON.stringify(normalizedConfig), imageValue]);
            
            const fs = require('fs');
            const path = require('path');
            
            // Re-fetch all to ensure global state is fresh
            const allResps = await this.all('SELECT name, config, image FROM responsibilities');
            const data = {};
            for (const row of allResps) {
                try {
                    const parsedConfig = JSON.parse(row.config || '{}');
                    if (row.image) {
                        parsedConfig.image = row.image;
                    }
                    data[row.name] = parsedConfig;
                } catch (e) {
                    data[row.name] = { responsibles: [], description: '' };
                }
            }
            
            // Sync to JSON for redundancy
            const responsibilitiesPath = path.join(getDataDir(), 'responsibilities.json');
            fs.writeFileSync(responsibilitiesPath, JSON.stringify(data, null, 2));
            
            // CRITICAL: Update global object used by all commands
            global.responsibilities = data;

            // Emit update event to update UI in real-time
            if (global.client) {
                global.client.emit('responsibilityUpdate');
            }
            
            return true;
        } catch (error) {
            console.error('❌ خطأ في تحديث المسؤولية:', error);
            return false;
        }
    }

    async deleteResponsibility(name) {
        try {
            await this.run('DELETE FROM responsibilities WHERE name = ?', [name]);
            
            // Sync to JSON
            const fs = require('fs');
            const path = require('path');
            const responsibilitiesPath = path.join(getDataDir(), 'responsibilities.json');
            const allResps = await this.getResponsibilities();
            fs.writeFileSync(responsibilitiesPath, JSON.stringify(allResps, null, 2));
            global.responsibilities = allResps;

            // Emit update event to update UI in real-time
            if (global.client) {
                global.client.emit('responsibilityUpdate');
            }

            // Remove from categories
            const categoriesPath = path.join(getDataDir(), 'respCategories.json');
            if (fs.existsSync(categoriesPath)) {
                const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
                let changed = false;
                for (const catName in categories) {
                    const idx = categories[catName].responsibilities?.indexOf(name);
                    if (idx !== undefined && idx > -1) {
                        categories[catName].responsibilities.splice(idx, 1);
                        changed = true;
                    }
                }
                if (changed) {
                    fs.writeFileSync(categoriesPath, JSON.stringify(categories, null, 2));
                }
            }
            
            return true;
        } catch (error) {
            console.error('❌ خطأ في حذف المسؤولية:', error);
            return false;
        }
    }

    async createTables() {
        const tables = [
            `CREATE TABLE IF NOT EXISTS responsibilities (
                name TEXT PRIMARY KEY,
                config TEXT
            )`,
            // جدول الجلسات الصوتية
            `CREATE TABLE IF NOT EXISTS voice_sessions (
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
            )`,

            // جدول إجماليات المستخدمين
            `CREATE TABLE IF NOT EXISTS user_totals (
                user_id TEXT PRIMARY KEY,
                total_voice_time INTEGER DEFAULT 0,
                total_sessions INTEGER DEFAULT 0,
                total_messages INTEGER DEFAULT 0,
                total_reactions INTEGER DEFAULT 0,
                total_voice_joins INTEGER DEFAULT 0,
                first_seen INTEGER,
                last_activity INTEGER,
                active_days INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            )`,

            // جدول إجماليات القنوات
            `CREATE TABLE IF NOT EXISTS channel_totals (
                channel_id TEXT PRIMARY KEY,
                channel_name TEXT NOT NULL,
                total_time INTEGER DEFAULT 0,
                total_sessions INTEGER DEFAULT 0,
                unique_users INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            )`,

            // جدول النشاط اليومي
            `CREATE TABLE IF NOT EXISTS daily_activity (
                date TEXT NOT NULL,
                user_id TEXT NOT NULL,
                voice_time INTEGER DEFAULT 0,
                messages INTEGER DEFAULT 0,
                reactions INTEGER DEFAULT 0,
                voice_joins INTEGER DEFAULT 0,
                PRIMARY KEY (date, user_id)
            )`,

            // نشاط يومي معزول لكل سيرفر لاستخدام التصفية والإحصائيات الدقيقة
            `CREATE TABLE IF NOT EXISTS guild_daily_activity (
                guild_id TEXT NOT NULL,
                date TEXT NOT NULL,
                user_id TEXT NOT NULL,
                voice_time INTEGER DEFAULT 0,
                messages INTEGER DEFAULT 0,
                reactions INTEGER DEFAULT 0,
                voice_joins INTEGER DEFAULT 0,
                PRIMARY KEY (guild_id, date, user_id)
            )`,

            // جدول المستخدمين الفريدين لكل قناة (بدلاً من Set)
            `CREATE TABLE IF NOT EXISTS channel_users (
                channel_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                first_joined INTEGER DEFAULT (strftime('%s', 'now')),
                PRIMARY KEY (channel_id, user_id)
            )`,

            // جدول رسائل القنوات لتتبع أكثر قناة يكتب فيها المستخدم
            `CREATE TABLE IF NOT EXISTS message_channels (
                user_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                message_count INTEGER DEFAULT 0,
                last_message INTEGER,
                PRIMARY KEY (user_id, channel_id)
            )`,

            `CREATE TABLE IF NOT EXISTS guild_message_channels (
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                message_count INTEGER DEFAULT 0,
                last_message INTEGER,
                PRIMARY KEY (guild_id, user_id, channel_id)
            )`,

            // جدول مستويات المستخدمين للترقيات التلقائية
            `CREATE TABLE IF NOT EXISTS user_levels (
                user_id TEXT PRIMARY KEY,
                voice_level INTEGER DEFAULT 0,
                chat_level INTEGER DEFAULT 0,
                last_notified INTEGER DEFAULT 0
            )`,
            // جدول الدعوات
            `CREATE TABLE IF NOT EXISTS user_invites (
                user_id TEXT PRIMARY KEY,
                total_invites INTEGER DEFAULT 0,
                fake_invites INTEGER DEFAULT 0,
                leave_invites INTEGER DEFAULT 0,
                bonus_invites INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            )`,
            // جدول سجل المنضمين
            `CREATE TABLE IF NOT EXISTS members_history (
                user_id TEXT PRIMARY KEY,
                inviter_id TEXT,
                join_method TEXT, -- 'invite', 'vanity', 'unknown'
                join_time INTEGER DEFAULT (strftime('%s', 'now'))
            )`,
            `CREATE TABLE IF NOT EXISTS bonus_guild_config (
                guild_id TEXT PRIMARY KEY,
                config_json TEXT NOT NULL DEFAULT '{}',
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
            )`,
            `CREATE TABLE IF NOT EXISTS bonus_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                role_id TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                avatar_url TEXT,
                created_at INTEGER NOT NULL,
                archived_at INTEGER,
                created_by TEXT NOT NULL,
                UNIQUE (guild_id, role_id)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_groups_guild_active ON bonus_groups(guild_id, archived_at, created_at)`,
            `CREATE TABLE IF NOT EXISTS bonus_member_role_history (
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role_id TEXT NOT NULL,
                granted_at INTEGER NOT NULL,
                removed_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, user_id, role_id)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_role_history_member ON bonus_member_role_history(guild_id, user_id, removed_at, granted_at)`,
            `CREATE TABLE IF NOT EXISTS bonus_group_point_balances (
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, group_id),
                FOREIGN KEY (group_id) REFERENCES bonus_groups(id) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS bonus_group_adjustments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                delta INTEGER NOT NULL CHECK (delta <> 0),
                reason TEXT NOT NULL DEFAULT 'manual_group_deduction',
                actor_id TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (group_id) REFERENCES bonus_groups(id) ON DELETE CASCADE
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_group_adjustments_active ON bonus_group_adjustments(guild_id, group_id, active, created_at)`,
            `CREATE TABLE IF NOT EXISTS bonus_group_reset_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                actor_id TEXT,
                created_at INTEGER NOT NULL,
                restored_at INTEGER,
                FOREIGN KEY (group_id) REFERENCES bonus_groups(id) ON DELETE CASCADE
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_group_reset_snapshots_lookup ON bonus_group_reset_snapshots(guild_id, group_id, restored_at, created_at DESC)`,
            `CREATE TABLE IF NOT EXISTS bonus_rules (
                guild_id TEXT NOT NULL,
                metric TEXT NOT NULL CHECK (metric IN ('messages', 'voice_ms')),
                threshold INTEGER NOT NULL CHECK (threshold > 0),
                points INTEGER NOT NULL CHECK (points > 0),
                activated_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                updated_by TEXT NOT NULL,
                PRIMARY KEY (guild_id, metric)
            )`,
            `CREATE TABLE IF NOT EXISTS bonus_balances (
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                group_id INTEGER,
                points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
                message_progress INTEGER NOT NULL DEFAULT 0 CHECK (message_progress >= 0),
                voice_progress_ms INTEGER NOT NULL DEFAULT 0 CHECK (voice_progress_ms >= 0),
                last_message_id TEXT,
                last_message_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, user_id),
                FOREIGN KEY (group_id) REFERENCES bonus_groups(id) ON DELETE SET NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_balances_group ON bonus_balances(guild_id, group_id, points DESC)`,
            `CREATE TABLE IF NOT EXISTS bonus_multipliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                scope TEXT NOT NULL CHECK (scope IN ('group', 'user')),
                group_id INTEGER,
                user_id TEXT,
                starts_at INTEGER NOT NULL,
                ends_at INTEGER,
                active INTEGER NOT NULL DEFAULT 1,
                changed_by TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                CHECK ((scope = 'group' AND group_id IS NOT NULL AND user_id IS NULL) OR
                       (scope = 'user' AND group_id IS NOT NULL AND user_id IS NOT NULL))
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_multiplier_lookup ON bonus_multipliers(guild_id, active, scope, group_id, user_id, ends_at)`,
            `CREATE TABLE IF NOT EXISTS bonus_activity_events (
                event_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                metric TEXT NOT NULL CHECK (metric IN ('messages', 'voice_ms')),
                amount INTEGER NOT NULL CHECK (amount > 0),
                awarded_points INTEGER NOT NULL DEFAULT 0,
                group_id INTEGER,
                created_at INTEGER NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS bonus_voice_sessions (
                guild_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                last_checkpoint_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, user_id)
            )`,
            `CREATE TABLE IF NOT EXISTS bonus_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT NOT NULL,
                actor_id TEXT,
                action TEXT NOT NULL,
                target_user_id TEXT,
                source_group_id INTEGER,
                target_group_id INTEGER,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_bonus_audit_guild_time ON bonus_audit_log(guild_id, created_at DESC)`,
            `CREATE TABLE IF NOT EXISTS bonus_migrations (
                migration_key TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )`
        ];

        for (const sql of tables) {
            await this.run(sql);
        }
        const bonusRuleColumns = await this.all('PRAGMA table_info(bonus_rules)');
        if (!bonusRuleColumns.some(column => column.name === 'activated_at')) {
            await this.run('ALTER TABLE bonus_rules ADD COLUMN activated_at INTEGER NOT NULL DEFAULT 0');
        }
        await this.run('UPDATE bonus_rules SET activated_at = updated_at WHERE activated_at = 0');
        const migrationKey = 'bonus-consistency-v1';
        const migration = await this.get('SELECT migration_key FROM bonus_migrations WHERE migration_key = ?', [migrationKey]);
        if (!migration) {
            const now = Date.now();
            await this.run(`
              UPDATE bonus_balances SET points = 0, message_progress = 0, voice_progress_ms = 0,
                last_message_id = NULL, last_message_at = NULL, group_id = NULL, updated_at = ?
              WHERE group_id IS NULL OR group_id NOT IN (
                SELECT id FROM bonus_groups WHERE archived_at IS NULL
              )
            `, [now]);
            await this.run(`
              DELETE FROM bonus_voice_sessions
              WHERE last_checkpoint_at < ? OR NOT EXISTS (
                SELECT 1 FROM bonus_groups g
                WHERE g.guild_id = bonus_voice_sessions.guild_id AND g.archived_at IS NULL
              )
            `, [now - 24 * 60 * 60 * 1000]);
            await this.run('INSERT OR IGNORE INTO bonus_migrations (migration_key, applied_at) VALUES (?, ?)', [migrationKey, now]);
        }
        const ownerMigrationKey = 'bonus-one-active-owner-v1';
        const ownerMigration = await this.get('SELECT migration_key FROM bonus_migrations WHERE migration_key = ?', [ownerMigrationKey]);
        if (!ownerMigration) {
            const now = Date.now();
            // احتفظ بأقدم قروب نشط للمالك وأرشف أي تكرارات قديمة قبل إنشاء القيد.
            await this.run(`
              UPDATE bonus_groups AS duplicate
              SET archived_at = ?
              WHERE duplicate.archived_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM bonus_groups AS original
                  WHERE original.guild_id = duplicate.guild_id
                    AND original.owner_id = duplicate.owner_id
                    AND original.archived_at IS NULL
                    AND (original.created_at < duplicate.created_at
                      OR (original.created_at = duplicate.created_at AND original.id < duplicate.id))
                )
            `, [now]);
            await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_bonus_one_active_owner ON bonus_groups(guild_id, owner_id) WHERE archived_at IS NULL');
            await this.run('INSERT OR IGNORE INTO bonus_migrations (migration_key, applied_at) VALUES (?, ?)', [ownerMigrationKey, now]);
        } else {
            await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_bonus_one_active_owner ON bonus_groups(guild_id, owner_id) WHERE archived_at IS NULL');
        }
    }

    // إضافة وظائف الدعوات
    async addInvite(userId, inviterId, method = 'invite') {
        try {
            // تحديث سجل المنضم
            await this.run(`
                INSERT OR REPLACE INTO members_history (user_id, inviter_id, join_method)
                VALUES (?, ?, ?)
            `, [userId, inviterId, method]);

            if (inviterId) {
                // تحديث عداد الداعي
                await this.run(`
                    INSERT INTO user_invites (user_id, total_invites)
                    VALUES (?, 1)
                    ON CONFLICT(user_id) DO UPDATE SET
                        total_invites = total_invites + 1,
                        updated_at = strftime('%s', 'now')
                `, [inviterId]);
            }
        } catch (error) {
            console.error('❌ خطأ في إضافة دعوة:', error);
        }
    }

    async getInviteStats(userId) {
        try {
            const stats = await this.get('SELECT * FROM user_invites WHERE user_id = ?', [userId]);
            return stats || { total_invites: 0, fake_invites: 0, leave_invites: 0, bonus_invites: 0 };
        } catch (error) {
            console.error('❌ خطأ في جلب إحصائيات الدعوات:', error);
            return { total_invites: 0, fake_invites: 0, leave_invites: 0, bonus_invites: 0 };
        }
    }

    async getInviter(userId) {
        try {
            const result = await this.get('SELECT inviter_id, join_method FROM members_history WHERE user_id = ?', [userId]);
            return result;
        } catch (error) {
            console.error('❌ خطأ في جلب الداعي:', error);
            return null;
        }
    }

    // إنشاء الفهارس للأداء
    async createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_id ON voice_sessions(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_voice_sessions_channel_id ON voice_sessions(channel_id)',
            'CREATE INDEX IF NOT EXISTS idx_voice_sessions_date ON voice_sessions(date)',
            'CREATE INDEX IF NOT EXISTS idx_voice_sessions_start_time ON voice_sessions(start_time)',
            'CREATE INDEX IF NOT EXISTS idx_daily_activity_date ON daily_activity(date)',
            'CREATE INDEX IF NOT EXISTS idx_daily_activity_user_id ON daily_activity(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_guild_daily_activity_user_date ON guild_daily_activity(guild_id, user_id, date)',
            'CREATE INDEX IF NOT EXISTS idx_channel_users_channel_id ON channel_users(channel_id)',
            'CREATE INDEX IF NOT EXISTS idx_user_totals_last_activity ON user_totals(last_activity)',
            'CREATE INDEX IF NOT EXISTS idx_message_channels_user_id ON message_channels(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_guild_message_channels_user ON guild_message_channels(guild_id, user_id, message_count)',
            'CREATE INDEX IF NOT EXISTS idx_user_levels_user_id ON user_levels(user_id)'
        ];

        for (const sql of indexes) {
            await this.run(sql);
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isBusyError(error) {
        return error && (error.code === 'SQLITE_BUSY' || /database is locked|SQLITE_BUSY/i.test(error.message || ''));
    }

    async withBusyRetry(operation, label = 'sqlite') {
        const retries = Number(process.env.SQLITE_BUSY_RETRIES || 8);
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (!this.isBusyError(error) || attempt === retries) throw error;
                const delay = Math.min(250 * (attempt + 1), 3000);
                console.warn(`⚠️ ${label}: SQLite locked, retry ${attempt + 1}/${retries} after ${delay}ms`);
                await this.delay(delay);
            }
        }
        throw lastError;
    }

    // تنفيذ استعلام - الكتابات تمر في طابور واحد لتقليل SQLITE_BUSY
    run(sql, params = []) {
        const task = () => this.withBusyRetry(() => new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    console.error('خطأ في تنفيذ الاستعلام:', err);
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        }), 'run');

        const next = this.writeQueue.catch(() => null).then(task);
        this.writeQueue = next.catch(() => null);
        return next;
    }

    // معاملات ذرية تمر ضمن طابور الكتابة نفسه؛ يجب أن تستخدم callback.run
    // داخل العملية ولا تستدعِ this.run منها لتجنب انتظار الطابور على نفسه.
    transaction(operation, label = 'transaction') {
        const task = () => this.withBusyRetry(async () => {
            const runDirect = (sql, params = []) => new Promise((resolve, reject) => {
                this.db.run(sql, params, function (error) {
                    if (error) reject(error);
                    else resolve({ id: this.lastID, changes: this.changes });
                });
            });
            const getDirect = (sql, params = []) => new Promise((resolve, reject) => {
                this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
            });
            const allDirect = (sql, params = []) => new Promise((resolve, reject) => {
                this.db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
            });

            await runDirect('BEGIN IMMEDIATE');
            try {
                const result = await operation({ run: runDirect, get: getDirect, all: allDirect });
                await runDirect('COMMIT');
                return result;
            } catch (error) {
                await runDirect('ROLLBACK').catch(() => {});
                throw error;
            }
        }, label);

        const next = this.writeQueue.catch(() => null).then(task);
        this.writeQueue = next.catch(() => null);
        return next;
    }

    // جلب سجل واحد
    get(sql, params = []) {
        const task = () => this.withBusyRetry(() => new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    console.error('خطأ في جلب السجل:', err);
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        }), 'get');
        return this.writeQueue.catch(() => null).then(task);
    }

    // جلب عدة سجلات
    all(sql, params = []) {
        const task = () => this.withBusyRetry(() => new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('خطأ في جلب السجلات:', err);
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        }), 'all');
        return this.writeQueue.catch(() => null).then(task);
    }

    // حفظ جلسة صوتية
    async saveVoiceSession(userId, channelId, channelName, duration, startTime, endTime, guildId = null) {
        try {
            const sessionId = `${userId}_${startTime}_${Math.random().toString(36).substr(2, 9)}`;
            const date = moment(startTime).tz('Asia/Riyadh').format('YYYY-MM-DD');

            // حفظ الجلسة
            await this.run(`
                INSERT INTO voice_sessions 
                (session_id, user_id, channel_id, channel_name, duration, start_time, end_time, date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [sessionId, userId, channelId, channelName, duration, startTime, endTime, date]);

            // تحديث إجماليات المستخدم
            await this.updateUserTotals(userId, { voiceTime: duration, sessions: 1 });

            // تحديث إجماليات القناة
            await this.updateChannelTotals(channelId, channelName, duration, userId);

            // تحديث النشاط اليومي
            await this.updateDailyActivity(date, userId, { voiceTime: duration }, guildId);

            return sessionId;

        } catch (error) {
            console.error('❌ خطأ في حفظ الجلسة الصوتية:', error);
            return null;
        }
    }

    // تحديث إجماليات المستخدم
    async updateUserTotals(userId, updates) {
        try {
            const { messages = 0, voiceTime = 0, voiceJoins = 0, reactions = 0 } = updates;

            // التأكد من وجود السجل أولاً
            await this.run(`
                INSERT OR IGNORE INTO user_totals (user_id, total_messages, total_voice_time, total_voice_joins, total_reactions)
                VALUES (?, 0, 0, 0, 0)
            `, [userId]);

            // تحديث القيم
            if (messages > 0) {
                await this.run(`UPDATE user_totals SET total_messages = total_messages + ?, last_activity = ? WHERE user_id = ?`, [messages, new Date().toISOString(), userId]);
            }
            if (voiceTime > 0) {
                await this.run(`UPDATE user_totals SET total_voice_time = total_voice_time + ?, last_activity = ? WHERE user_id = ?`, [voiceTime, new Date().toISOString(), userId]);
            }
            if (voiceJoins > 0) {
                await this.run(`UPDATE user_totals SET total_voice_joins = total_voice_joins + ?, last_activity = ? WHERE user_id = ?`, [voiceJoins, new Date().toISOString(), userId]);
            }
            if (reactions > 0) {
                // تحديث التفاعلات مع التحقق من النجاح
                const updateResult = await this.run(`UPDATE user_totals SET total_reactions = total_reactions + ?, last_activity = ? WHERE user_id = ?`, [reactions, new Date().toISOString(), userId]);

                if (updateResult.changes === 0) {
                    // محاولة إنشاء السجل إذا لم يكن موجوداً
                    try {
                        await this.run(`
                            INSERT INTO user_totals (user_id, total_reactions, total_messages, total_voice_time, total_voice_joins, first_seen, last_activity)
                            VALUES (?, ?, 0, 0, 0, strftime('%s', 'now'), ?)
                        `, [userId, reactions, new Date().toISOString()]);
                    } catch (insertError) {
                        console.error(`❌ فشل في إنشاء سجل جديد للمستخدم ${userId}:`, insertError);
                    }
                }
            }

        } catch (error) {
            console.error('خطأ في تحديث إجماليات المستخدم:', error);
            throw error;
        }
    }

    // تحديث إجماليات القناة
    async updateChannelTotals(channelId, channelName, duration, userId) {
        try {
            // تحديث أو إنشاء إجماليات القناة
            await this.run(`
                INSERT INTO channel_totals (channel_id, channel_name, total_time, total_sessions, unique_users)
                VALUES (?, ?, ?, 1, 1)
                ON CONFLICT(channel_id) DO UPDATE SET
                    channel_name = excluded.channel_name,
                    total_time = total_time + excluded.total_time,
                    total_sessions = total_sessions + 1,
                    updated_at = strftime('%s', 'now')
            `, [channelId, channelName, duration]);

            // إضافة المستخدم إلى قائمة مستخدمي القناة
            await this.run(`
                INSERT OR IGNORE INTO channel_users (channel_id, user_id)
                VALUES (?, ?)
            `, [channelId, userId]);

            // تحديث عدد المستخدمين الفريدين
            const uniqueCount = await this.get(`
                SELECT COUNT(*) as count FROM channel_users WHERE channel_id = ?
            `, [channelId]);

            await this.run(`
                UPDATE channel_totals 
                SET unique_users = ?
                WHERE channel_id = ?
            `, [uniqueCount.count, channelId]);

        } catch (error) {
            console.error('❌ خطأ في تحديث إجماليات القناة:', error);
        }
    }

    // تحديث النشاط اليومي
    async updateDailyActivity(date, userId, activity, guildId = null) {
        try {
            const { messages = 0, voiceTime = 0, voiceJoins = 0, reactions = 0 } = activity;

            if (guildId) {
                await this.run(`
                    INSERT OR IGNORE INTO guild_daily_activity
                    (guild_id, date, user_id, messages, voice_time, voice_joins, reactions)
                    VALUES (?, ?, ?, 0, 0, 0, 0)
                `, [guildId, date, userId]);

                const updates = [
                    ['messages', messages],
                    ['voice_time', voiceTime],
                    ['voice_joins', voiceJoins],
                    ['reactions', reactions]
                ];
                for (const [column, amount] of updates) {
                    if (amount > 0) {
                        await this.run(
                            `UPDATE guild_daily_activity SET ${column} = ${column} + ? WHERE guild_id = ? AND date = ? AND user_id = ?`,
                            [amount, guildId, date, userId]
                        );
                    }
                }
                return;
            }

            // التأكد من وجود السجل أولاً
            await this.run(`
                INSERT OR IGNORE INTO daily_activity (date, user_id, messages, voice_time, voice_joins, reactions)
                VALUES (?, ?, 0, 0, 0, 0)
            `, [date, userId]);

            // تحديث القيم
            if (messages > 0) {
                await this.run(`UPDATE daily_activity SET messages = messages + ? WHERE date = ? AND user_id = ?`, [messages, date, userId]);
            }
            if (voiceTime > 0) {
                // تحديث القيمة بالميلي ثانية مباشرة دون تصحيح
                await this.run(`
                    UPDATE daily_activity 
                    SET voice_time = voice_time + ?
                    WHERE date = ? AND user_id = ?
                `, [voiceTime, date, userId]);
            }
            if (voiceJoins > 0) {
                await this.run(`UPDATE daily_activity SET voice_joins = voice_joins + ? WHERE date = ? AND user_id = ?`, [voiceJoins, date, userId]);
            }
            if (reactions > 0) {
                await this.run(`UPDATE daily_activity SET reactions = reactions + ? WHERE date = ? AND user_id = ?`, [reactions, date, userId]);
                console.log(`📅 تم تحديث ${reactions} تفاعل يومي للمستخدم ${userId} - التاريخ: ${date}`);
            }
        } catch (error) {
            console.error('خطأ في تحديث النشاط اليومي:', error);
            throw error;
        }
    }

    // حساب أيام النشاط الفعلية من قاعدة البيانات
    async getActiveDaysCount(userId, daysBack = 30) {
        try {
            const now = moment().tz('Asia/Riyadh');
            const cutoffDate = now.clone().subtract(daysBack, 'days').format('YYYY-MM-DD');

            const result = await this.get(`
                SELECT COUNT(DISTINCT date) as activeDays
                FROM daily_activity 
                WHERE user_id = ? 
                AND date >= ?
                AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
            `, [userId, cutoffDate]);

            return result ? result.activeDays : 0;
        } catch (error) {
            console.error('❌ خطأ في حساب أيام النشاط:', error);
            return 0;
        }
    }

    async getWeeklyActiveDays(userId) {
        try {
            const now = moment().tz('Asia/Riyadh');
            const weekStart = now.clone().startOf('week').format('YYYY-MM-DD');

            const result = await this.get(`
                SELECT COUNT(DISTINCT date) as activeDays
                FROM daily_activity 
                WHERE user_id = ? 
                AND date >= ?
                AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
            `, [userId, weekStart]);

            return result ? result.activeDays : 0;
        } catch (error) {
            console.error('❌ خطأ في حساب أيام النشاط الأسبوعية:', error);
            return 0;
        }
    }

    // حساب أيام النشاط الأسبوعية
    async getWeeklyActiveDays(userId) {
        try {
            // حساب بداية الأسبوع (السبت) بتوقيت الرياض
            const now = moment().tz('Asia/Riyadh');
            const weekStart = now.clone().startOf('week');
            const weekStartString = weekStart.format('YYYY-MM-DD');

            const result = await this.get(`
                SELECT COUNT(DISTINCT date) as weeklyActiveDays
                FROM daily_activity 
                WHERE user_id = ? 
                AND date >= ?
                AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
            `, [userId, weekStartString]);

            return result ? result.weeklyActiveDays : 0;
        } catch (error) {
            console.error('❌ خطأ في حساب أيام النشاط الأسبوعية:', error);
            return 0;
        }
    }

    // جلب إحصائيات المستخدم
    async getUserStats(userId) {
        try {
            const user = await this.get('SELECT * FROM user_totals WHERE user_id = ?', [userId]);

            if (!user) {
                return {
                    totalVoiceTime: 0,
                    totalSessions: 0,
                    totalMessages: 0,
                    totalReactions: 0,
                    totalVoiceJoins: 0,
                    firstSeen: null,
                    lastActivity: null,
                    activeDays: 0,
                    weeklyActiveDays: 0
                };
            }

            // حساب أيام النشاط الفعلية
            const activeDays = await this.getActiveDaysCount(userId, 30);
            const weeklyActiveDays = await this.getWeeklyActiveDays(userId);

            return {
                totalVoiceTime: user.total_voice_time || 0,
                totalSessions: user.total_sessions || 0,
                totalMessages: user.total_messages || 0,
                totalReactions: user.total_reactions || 0,
                totalVoiceJoins: user.total_voice_joins || 0,
                firstSeen: user.first_seen,
                lastActivity: user.last_activity
            };

        } catch (error) {
            console.error('❌ خطأ في جلب إحصائيات المستخدم:', error);
            return null;
        }
    }

    // جلب النشاط الأسبوعي مع الرسائل والتفاعلات
    async getWeeklyStats(userId) {
        try {
            // حساب بداية الأسبوع (السبت) بتوقيت الرياض
            const now = moment().tz('Asia/Riyadh');
            const weekStart = now.clone().startOf('week');
            const weekStartString = weekStart.format('YYYY-MM-DD');

            // جلب النشاط الأسبوعي من جدول النشاط اليومي لضمان التطابق مع الإحصائيات الأخرى
            const activity = await this.get(`
                SELECT SUM(voice_time) as weeklyTime,
                       SUM(messages) as weeklyMessages, 
                       SUM(reactions) as weeklyReactions,
                       SUM(voice_joins) as weeklyVoiceJoins
                FROM daily_activity 
                WHERE user_id = ? AND date >= ?
            `, [userId, weekStartString]);

            // جلب عدد الجلسات من voice_sessions (اختياري، لكن سنبقي عليه للتوافق)
            const sessionsCount = await this.get(`
                SELECT COUNT(*) as count FROM voice_sessions 
                WHERE user_id = ? AND date >= ?
            `, [userId, weekStartString]);

            return {
                weeklyTime: activity?.weeklyTime || 0,
                weeklySessions: sessionsCount?.count || 0,
                weeklyChannels: {}, // القنوات التفصيلية تتطلب استعلاماً منفصلاً إذا لزم الأمر
                weeklyMessages: activity?.weeklyMessages || 0,
                weeklyReactions: activity?.weeklyReactions || 0,
                weeklyVoiceJoins: activity?.weeklyVoiceJoins || 0
            };

        } catch (error) {
            console.error('❌ خطأ في جلب الإحصائيات الأسبوعية:', error);
            return { 
                weeklyTime: 0, 
                weeklySessions: 0, 
                weeklyChannels: {},
                weeklyMessages: 0,
                weeklyReactions: 0,
                weeklyVoiceJoins: 0
            };
        }
    }

    // جلب الرسائل الأسبوعية فقط
    async getWeeklyMessages(userId) {
        try {
            // حساب بداية الأسبوع (السبت) بتوقيت الرياض
            const now = moment().tz('Asia/Riyadh');
            const weekStart = now.clone().startOf('week');
            const weekStartString = weekStart.format('YYYY-MM-DD');

            const result = await this.get(`
                SELECT SUM(messages) as weeklyMessages
                FROM daily_activity 
                WHERE user_id = ? AND date >= ?
            `, [userId, weekStartString]);

            return result?.weeklyMessages || 0;
        } catch (error) {
            console.error('❌ خطأ في جلب الرسائل الأسبوعية:', error);
            return 0;
        }
    }

    // جلب التفاعلات الأسبوعية فقط
    async getWeeklyReactions(userId) {
        try {
            // حساب بداية الأسبوع (السبت) بتوقيت الرياض
            const now = moment().tz('Asia/Riyadh');
            const weekStart = now.clone().startOf('week');
            const weekStartString = weekStart.format('YYYY-MM-DD');

            const result = await this.get(`
                SELECT SUM(reactions) as weeklyReactions
                FROM daily_activity 
                WHERE user_id = ? AND date >= ?
            `, [userId, weekStartString]);

            return result?.weeklyReactions || 0;
        } catch (error) {
            console.error('❌ خطأ في جلب التفاعلات الأسبوعية:', error);
            return 0;
        }
    }

    // تحديث رسائل القناة
    async updateMessageChannel(userId, channelId, channelName, guildId = null) {
        try {
            await this.run(`
                INSERT INTO message_channels (user_id, channel_id, channel_name, message_count, last_message)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(user_id, channel_id) DO UPDATE SET
                    channel_name = excluded.channel_name,
                    message_count = message_count + 1,
                    last_message = excluded.last_message
            `, [userId, channelId, channelName, Date.now()]);
            if (guildId) {
                await this.run(`
                    INSERT INTO guild_message_channels (guild_id, user_id, channel_id, channel_name, message_count, last_message)
                    VALUES (?, ?, ?, ?, 1, ?)
                    ON CONFLICT(guild_id, user_id, channel_id) DO UPDATE SET
                        channel_name = excluded.channel_name,
                        message_count = message_count + 1,
                        last_message = excluded.last_message
                `, [guildId, userId, channelId, channelName, Date.now()]);
            }
        } catch (error) {
            console.error('❌ خطأ في تحديث رسائل القناة:', error);
        }
    }

    // الحصول على أكثر قناة صوتية للمستخدم
    async getMostActiveVoiceChannel(userId, period = 'total') {
        try {
            let dateFilter = '';
            let params = [userId];

            if (period === 'daily') {
                const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');
                dateFilter = 'AND date = ?';
                params.push(today);
            } else if (period === 'weekly') {
                // بداية الأسبوع (السبت) بتوقيت الرياض
                const now = moment().tz('Asia/Riyadh');
                const weekStart = now.clone().startOf('week').format('YYYY-MM-DD');
                dateFilter = 'AND date >= ?';
                params.push(weekStart);
            } else if (period === 'monthly') {
                // بداية الشهر الحالي بتوقيت الرياض
                const now = moment().tz('Asia/Riyadh');
                const monthStart = now.clone().startOf('month').format('YYYY-MM-DD');
                dateFilter = 'AND date >= ?';
                params.push(monthStart);
            }

            const result = await this.get(`
                SELECT channel_id, channel_name, SUM(duration) as total_time, COUNT(*) as session_count
                FROM voice_sessions
                WHERE user_id = ? ${dateFilter}
                GROUP BY channel_id
                ORDER BY total_time DESC
                LIMIT 1
            `, params);

            return result || { channel_id: null, channel_name: 'لا يوجد', total_time: 0, session_count: 0 };
        } catch (error) {
            console.error('❌ خطأ في جلب أكثر قناة صوتية:', error);
            return { channel_name: 'لا يوجد', total_time: 0, session_count: 0 };
        }
    }

    // الحصول على أكثر قناة رسائل للمستخدم
    async getMostActiveMessageChannel(userId, guildId = null) {
        try {
            const result = guildId ? await this.get(`
                SELECT channel_id, channel_name, message_count
                FROM guild_message_channels
                WHERE guild_id = ? AND user_id = ?
                ORDER BY message_count DESC, last_message DESC
                LIMIT 1
            `, [guildId, userId]) : null;
            if (result) return result;
            return await this.get(`
                SELECT channel_id, channel_name, message_count
                FROM message_channels
                WHERE user_id = ?
                ORDER BY message_count DESC, last_message DESC
                LIMIT 1
            `, [userId]);

        } catch (error) {
            console.error('❌ خطأ في جلب أكثر قناة رسائل:', error);
            return { channel_id: null, channel_name: 'لا يوجد', message_count: 0 };
        }
    }

    // جلب الإحصائيات اليومية
    async getDailyStats(userId) {
        try {
            const today = moment().tz('Asia/Riyadh').format('YYYY-MM-DD');

            const dailyActivity = await this.get(`
                SELECT voice_time, messages, reactions, voice_joins
                FROM daily_activity
                WHERE user_id = ? AND date = ?
            `, [userId, today]);

            const activeDays = await this.get(`
                SELECT COUNT(DISTINCT date) as count
                FROM daily_activity
                WHERE user_id = ? AND date = ?
                AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
            `, [userId, today]);

            return {
                voiceTime: dailyActivity?.voice_time || 0,
                messages: dailyActivity?.messages || 0,
                reactions: dailyActivity?.reactions || 0,
                voiceJoins: dailyActivity?.voice_joins || 0,
                activeDays: activeDays?.count || 0
            };
        } catch (error) {
            console.error('❌ خطأ في جلب الإحصائيات اليومية:', error);
            return { voiceTime: 0, messages: 0, reactions: 0, voiceJoins: 0, activeDays: 0 };
        }
    }

    // جلب الإحصائيات الشهرية
    async getMonthlyStats(userId, guildId = null) {
        try {
            // حساب بداية الشهر الحالي بتوقيت الرياض
            const now = moment().tz('Asia/Riyadh');
            const monthStart = now.clone().startOf('month').format('YYYY-MM-DD');

            const activityTable = guildId ? 'guild_daily_activity' : 'daily_activity';
            const scopeClause = guildId ? 'guild_id = ? AND user_id = ? AND date >= ?' : 'user_id = ? AND date >= ?';
            const scopeParams = guildId ? [guildId, userId, monthStart] : [userId, monthStart];

            const monthlyActivity = await this.all(`
                SELECT SUM(voice_time) as voiceTime,
                       SUM(messages) as messages,
                       SUM(reactions) as reactions,
                       SUM(voice_joins) as voiceJoins
                FROM ${activityTable}
                WHERE ${scopeClause}
            `, scopeParams);

            const activeDays = await this.get(`
                SELECT COUNT(DISTINCT date) as count
                FROM ${activityTable}
                WHERE ${scopeClause}
                AND (voice_time > 0 OR messages > 0 OR reactions > 0 OR voice_joins > 0)
            `, scopeParams);

            return {
                voiceTime: monthlyActivity[0]?.voiceTime || 0,
                messages: monthlyActivity[0]?.messages || 0,
                reactions: monthlyActivity[0]?.reactions || 0,
                voiceJoins: monthlyActivity[0]?.voiceJoins || 0,
                activeDays: activeDays?.count || 0
            };
        } catch (error) {
            console.error('❌ خطأ في جلب الإحصائيات الشهرية:', error);
            return { voiceTime: 0, messages: 0, reactions: 0, voiceJoins: 0, activeDays: 0 };
        }
    }

    // تنظيف البيانات القديمة (حذف الجلسات التفصيلية فقط، الاحتفاظ بالإجماليات)
    async cleanupOldData(daysToKeep = 60) {
        try {
            const cutoffDate = moment().tz('Asia/Riyadh').subtract(daysToKeep, 'days').format('YYYY-MM-DD');
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

            // حذف الجلسات التفصيلية القديمة فقط (voice_sessions)
            const sessionsResult = await this.run(`
                DELETE FROM voice_sessions WHERE start_time < ?
            `, [cutoffTime]);

            // حذف بيانات النشاط اليومي القديمة (أقدم من 90 يوماً بدلاً من 6 أشهر)
            const ninetyDaysAgo = moment().tz('Asia/Riyadh').subtract(90, 'days').format('YYYY-MM-DD');
            const dailyResult = await this.run(`
                DELETE FROM daily_activity WHERE date < ?
            `, [ninetyDaysAgo]);

            // حذف بيانات القنوات غير النشطة (آخر رسالة أقدم من 90 يوماً)
            const channelCleanup = await this.run(`
                DELETE FROM message_channels WHERE last_message < ?
            `, [Date.now() - (90 * 24 * 60 * 60 * 1000)]);

            console.log(`🧹 تنظيف تلقائي: ${sessionsResult.changes || 0} جلسة، ${dailyResult.changes || 0} نشاط يومي، ${channelCleanup.changes || 0} قناة`);
            console.log(`📊 الإحصائيات الإجمالية محفوظة - البيانات التفصيلية لآخر ${daysToKeep} يوم محفوظة`);
            
            // ضغط تلقائي قوي بعد التنظيف
            await this.run('PRAGMA incremental_vacuum');
            await this.run('ANALYZE');
            
            return {
                sessions: sessionsResult.changes || 0,
                dailyActivity: dailyResult.changes || 0,
                channels: channelCleanup.changes || 0
            };

        } catch (error) {
            console.error('❌ خطأ في تنظيف البيانات القديمة:', error);
            return { sessions: 0, dailyActivity: 0, channels: 0 };
        }
    }

    // تصفير جميع إحصائيات التفاعل (إجمالي وأسبوعي)
    async resetAllStats() {
        try {
            console.log('🔄 بدء تصفير جميع الإحصائيات...');
            
            // حذف جميع الجلسات الصوتية
            const sessionsResult = await this.run(`DELETE FROM voice_sessions`);
            
            // حذف جميع النشاطات اليومية
            const dailyResult = await this.run(`DELETE FROM daily_activity`);
            
            // إعادة تعيين إجماليات المستخدمين
            const totalsResult = await this.run(`
                UPDATE user_totals SET 
                    total_voice_time = 0,
                    total_sessions = 0,
                    total_messages = 0,
                    total_reactions = 0,
                    total_voice_joins = 0,
                    active_days = 0
            `);
            
            // إعادة تعيين إجماليات القنوات
            const channelResult = await this.run(`
                UPDATE channel_totals SET 
                    total_time = 0,
                    total_sessions = 0,
                    unique_users = 0
            `);
            
            // حذف مستخدمي القنوات
            const channelUsersResult = await this.run(`DELETE FROM channel_users`);

            const totalDeleted = (sessionsResult.changes || 0) + 
                                (dailyResult.changes || 0) + 
                                (channelUsersResult.changes || 0);
            const totalUpdated = (totalsResult.changes || 0) + 
                                (channelResult.changes || 0);

            console.log(`✅ تم تصفير الإحصائيات: حذف ${totalDeleted} سجل، تحديث ${totalUpdated} سجل`);
            
            return {
                success: true,
                deletedRecords: totalDeleted,
                updatedRecords: totalUpdated,
                details: {
                    voiceSessions: sessionsResult.changes || 0,
                    dailyActivity: dailyResult.changes || 0,
                    userTotals: totalsResult.changes || 0,
                    channelTotals: channelResult.changes || 0,
                    channelUsers: channelUsersResult.changes || 0
                }
            };

        } catch (error) {
            console.error('❌ خطأ في تصفير الإحصائيات:', error);
            return {
                success: false,
                error: error.message,
                deletedRecords: 0,
                updatedRecords: 0
            };
        }
    }

    // تصفير وقت الفويس لمستخدم معين
    async resetUserVoiceTime(userId) {
        try {
            await this.run(`
                UPDATE user_totals 
                SET total_voice_time = 0, total_sessions = 0, total_voice_joins = 0
                WHERE user_id = ?
            `, [userId]);

            await this.run(`UPDATE daily_activity SET voice_time = 0, voice_joins = 0 WHERE user_id = ?`, [userId]);
            await this.run(`DELETE FROM voice_sessions WHERE user_id = ?`, [userId]);
            
            console.log(`✅ تم تصفير وقت الفويس للمستخدم ${userId}`);
            return { success: true };
        } catch (error) {
            console.error('Error resetting user voice time:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير الرسائل لمستخدم معين
    async resetUserMessages(userId) {
        try {
            await this.run(`
                UPDATE user_totals 
                SET total_messages = 0
                WHERE user_id = ?
            `, [userId]);

            await this.run(`UPDATE daily_activity SET messages = 0 WHERE user_id = ?`, [userId]);
            await this.run(`DELETE FROM message_channels WHERE user_id = ?`, [userId]);
            
            console.log(`✅ تم تصفير الرسائل للمستخدم ${userId}`);
            return { success: true };
        } catch (error) {
            console.error('Error resetting user messages:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير التفاعلات لمستخدم معين
    async resetUserReactions(userId) {
        try {
            await this.run(`
                UPDATE user_totals 
                SET total_reactions = 0
                WHERE user_id = ?
            `, [userId]);

            await this.run(`UPDATE daily_activity SET reactions = 0 WHERE user_id = ?`, [userId]);
            
            console.log(`✅ تم تصفير التفاعلات للمستخدم ${userId}`);
            return { success: true };
        } catch (error) {
            console.error('Error resetting user reactions:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير جميع إحصائيات مستخدم معين
    async resetUserAllStats(userId) {
        try {
            await this.run(`DELETE FROM voice_sessions WHERE user_id = ?`, [userId]);
            await this.run(`DELETE FROM message_channels WHERE user_id = ?`, [userId]);
            await this.run(`DELETE FROM channel_users WHERE user_id = ?`, [userId]);
            await this.run(`DELETE FROM daily_activity WHERE user_id = ?`, [userId]);
            await this.run(`
                UPDATE user_totals 
                SET total_voice_time = 0, total_sessions = 0, total_messages = 0, 
                    total_reactions = 0, total_voice_joins = 0, active_days = 0
                WHERE user_id = ?
            `, [userId]);
            
            return { success: true };
        } catch (error) {
            console.error('Error resetting all user stats:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير وقت الفويس لجميع المستخدمين
    async resetAllVoiceTime() {
        try {
            await this.run(`UPDATE user_totals SET total_voice_time = 0, total_sessions = 0, total_voice_joins = 0`);
            await this.run(`UPDATE daily_activity SET voice_time = 0, voice_joins = 0`);
            await this.run(`DELETE FROM voice_sessions`);
            
            console.log('✅ تم تصفير وقت الفويس لجميع الأعضاء');
            return { success: true };
        } catch (error) {
            console.error('Error resetting all voice time:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير الرسائل لجميع المستخدمين
    async resetAllMessages() {
        try {
            await this.run(`UPDATE user_totals SET total_messages = 0`);
            await this.run(`UPDATE daily_activity SET messages = 0`);
            await this.run(`DELETE FROM message_channels`);
            
            console.log('✅ تم تصفير الرسائل لجميع الأعضاء');
            return { success: true };
        } catch (error) {
            console.error('Error resetting all messages:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير التفاعلات لجميع المستخدمين
    async resetAllReactions() {
        try {
            await this.run(`UPDATE user_totals SET total_reactions = 0`);
            await this.run(`UPDATE daily_activity SET reactions = 0`);
            
            console.log('✅ تم تصفير التفاعلات لجميع الأعضاء');
            return { success: true };
        } catch (error) {
            console.error('Error resetting all reactions:', error);
            return { success: false, error: error.message };
        }
    }

    // تصفير النشاط اليومي لجميع المستخدمين
    async resetAllActivity() {
        try {
            await this.run(`DELETE FROM daily_activity`);
            await this.run(`UPDATE user_totals SET active_days = 0`);
            
            console.log('✅ تم تصفير النشاط اليومي لجميع الأعضاء');
            return { success: true };
        } catch (error) {
            console.error('Error resetting all activity:', error);
            return { success: false, error: error.message };
        }
    }

    // ضغط وتنظيف قاعدة البيانات
    async compressDatabase() {
        try {
            console.log('🗜️ بدء عملية ضغط قاعدة البيانات...');
            
            // تنفيذ VACUUM لضغط الملف
            await this.run('VACUUM');
            
            // تنفيذ incremental vacuum
            await this.run('PRAGMA incremental_vacuum');
            
            // إعادة تحليل الإحصائيات
            await this.run('ANALYZE');
            
            console.log('✅ تم ضغط قاعدة البيانات بنجاح');
            return { success: true };
        } catch (error) {
            console.error('❌ خطأ في ضغط قاعدة البيانات:', error);
            return { success: false, error: error.message };
        }
    }

    // الحصول على حجم قاعدة البيانات
    async getDatabaseSize() {
        try {
            const fs = require('fs');
            const stats = fs.statSync(this.databasePath);
            const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
            
            // حساب عدد السجلات
            const counts = {
                voice_sessions: (await this.get('SELECT COUNT(*) as count FROM voice_sessions')).count,
                daily_activity: (await this.get('SELECT COUNT(*) as count FROM daily_activity')).count,
                user_totals: (await this.get('SELECT COUNT(*) as count FROM user_totals')).count
            };
            
            return {
                sizeInMB: sizeInMB,
                sizeInBytes: stats.size,
                counts: counts
            };
        } catch (error) {
            console.error('❌ خطأ في الحصول على حجم القاعدة:', error);
            return null;
        }
    }

    // إغلاق الاتصال
    close() {
        if (this.db) {
            this.db.close();
            console.log('✅ تم إغلاق اتصال قاعدة البيانات');
        }
    }
}

// إنشاء مثيل واحد فقط
const dbManager = new DatabaseManager();

// الوظائف التي سيتم تصديرها
async function initializeDatabase() {
    try {
        if (!dbManager.isInitialized) {
            await dbManager.initialize();
            console.log('✅ تم تهيئة قاعدة البيانات بنجاح');
        } else {
            console.log('✅ قاعدة البيانات مهيأة مسبقاً');
        }
        return dbManager;
    } catch (error) {
        console.error('❌ فشل في تهيئة قاعدة البيانات:', error);
        throw error;
    }
}

function getDatabase() {
    if (!dbManager.isInitialized) {
        if (dbManager.initializationPromise) {
            throw new Error('Database initialization is still running; use JSON/in-memory fallback for now.');
        }

        console.log('⚠️ قاعدة البيانات غير مهيأة، تشغيل قاعدة مؤقتة طارئة حتى لا يتوقف البوت...');
        try {
            const sqlite3 = require('sqlite3').verbose();

            if (!dbManager.db) {
                dbManager.db = new sqlite3.Database(':memory:');
                dbManager.db.configure('busyTimeout', Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 60000));
                dbManager.db.serialize();
                dbManager.isDegraded = true;
                dbManager.isInitialized = true;
                console.log('✅ تم تهيئة قاعدة بيانات مؤقتة بشكل طارئ');
            }
        } catch (error) {
            console.error('❌ فشل في التهيئة الطارئة:', error);
            throw new Error('Database not initialized and emergency initialization failed.');
        }
    }
    return dbManager;
}

// وظائف وهمية لتوضيح الهيكل، سيتم استبدالها بالوظائف الحقيقية
async function trackUserActivity(userId, activityType, amount) {
    console.log(`Tracking activity: User ${userId}, Type ${activityType}, Amount ${amount}`);
    // سيتم إضافة منطق التتبع الفعلي هنا
    // مثال:
    // const db = getDatabase();
    // await db.updateUserTotals(userId, { [activityType]: amount });
    return true;
}

async function getRealUserStats(userId) {
    console.log(`Fetching stats for user ${userId}`);
    // سيتم إضافة منطق جلب الإحصائيات الفعلي هنا
    // مثال:
    // const db = getDatabase();
    // return await db.getUserStats(userId);
    return {
        totalVoiceTime: 0,
        totalSessions: 0,
        totalMessages: 0,
        totalReactions: 0,
        totalVoiceJoins: 0,
        firstSeen: null,
        lastActivity: null,
        activeDays: 0,
        weeklyActiveDays: 0
    };
}

// User level tracking for promotion system
async function getUserLevel(userId) {
    try {
        const db = getDatabase();
        const result = await db.get(`
            SELECT voice_level, chat_level, last_notified
            FROM user_levels
            WHERE user_id = ?
        `, [userId]);
        
        return result || { voice_level: 0, chat_level: 0, last_notified: 0 };
    } catch (error) {
        console.error('خطأ في جلب مستوى المستخدم:', error);
        return { voice_level: 0, chat_level: 0, last_notified: 0 };
    }
}

async function updateUserLevel(userId, voiceLevel, chatLevel) {
    try {
        const db = getDatabase();
        await db.run(`
            INSERT INTO user_levels (user_id, voice_level, chat_level)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                voice_level = excluded.voice_level,
                chat_level = excluded.chat_level
        `, [userId, voiceLevel, chatLevel]);
        
        return true;
    } catch (error) {
        console.error('خطأ في تحديث مستوى المستخدم:', error);
        return false;
    }
}

async function updateLastNotified(userId) {
    try {
        const db = getDatabase();
        await db.run(`
            UPDATE user_levels
            SET last_notified = ?
            WHERE user_id = ?
        `, [Date.now(), userId]);
        
        return true;
    } catch (error) {
        console.error('خطأ في تحديث وقت الإشعار:', error);
        return false;
    }
}

module.exports = {
    DatabaseManager,
    getDatabase: getDatabase,
    dbManager: dbManager,
    initializeDatabase: initializeDatabase,
    trackUserActivity: trackUserActivity,
    getRealUserStats: getRealUserStats,
    getUserLevel: getUserLevel,
    updateUserLevel: updateUserLevel,
    updateLastNotified: updateLastNotified,
    saveVoiceSession: async (userId, channelId, channelName, duration, startTime, endTime, guildId = null) => {
        const db = getDatabase();
        return await db.saveVoiceSession(userId, channelId, channelName, duration, startTime, endTime, guildId);
    },
    resetAllStats: async () => {
        const db = getDatabase();
        return await db.resetAllStats();
    }
};
