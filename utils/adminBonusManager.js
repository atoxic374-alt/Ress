const { calculateAward, BONUS_METRICS } = require('./bonusManager');

const MESSAGE_COUNT_COOLDOWN_MS = 60 * 1000;
const MAX_POINTS_PER_EVENT = 1000000;

function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function createAdminBonusManager(dbManager) {
  if (!dbManager) throw new TypeError('dbManager is required');

  async function readConfig(guildId) {
    const row = await dbManager.get('SELECT config_json FROM bonus_admin_config WHERE guild_id = ?', [String(guildId)]);
    return { automaticBonus: false, ...safeJsonParse(row?.config_json, {}) };
  }

  async function saveConfig(guildId, patch, actorId = null) {
    return dbManager.transaction(async tx => {
      const row = await tx.get('SELECT config_json FROM bonus_admin_config WHERE guild_id = ?', [String(guildId)]);
      const current = { automaticBonus: false, ...safeJsonParse(row?.config_json, {}) };
      const next = { ...current, ...patch };
      await tx.run(`
        INSERT INTO bonus_admin_config (guild_id, config_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
      `, [String(guildId), JSON.stringify(next), Date.now()]);
      if (actorId) await insertAudit(tx, guildId, actorId, 'config_update', null, { keys: Object.keys(patch) });
      return next;
    }, 'bonus-admin-config-save');
  }

  async function insertAudit(executor, guildId, actorId, action, targetUserId, details = {}) {
    await executor.run(`
      INSERT INTO bonus_admin_audit_log (guild_id, actor_id, target_user_id, action, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [String(guildId), actorId ? String(actorId) : null, targetUserId ? String(targetUserId) : null,
      String(action), JSON.stringify(details || {}), Date.now()]);
  }

  async function getRules(guildId) {
    const rows = await dbManager.all('SELECT metric, threshold, points, activated_at FROM bonus_admin_rules WHERE guild_id = ?', [String(guildId)]);
    return Object.fromEntries(rows.map(row => [row.metric, {
      threshold: Number(row.threshold), points: Number(row.points), activatedAt: Number(row.activated_at) || 0
    }]));
  }

  async function setRule(guildId, metric, threshold, points, actorId) {
    if (!Object.values(BONUS_METRICS).includes(metric)) throw new Error('INVALID_METRIC');
    const safeThreshold = Math.floor(Number(threshold));
    const safePoints = Math.floor(Number(points));
    const maxThreshold = metric === BONUS_METRICS.voice ? Number.MAX_SAFE_INTEGER : 1000000000;
    if (!Number.isSafeInteger(safeThreshold) || safeThreshold < 1 || safeThreshold > maxThreshold) throw new Error('INVALID_THRESHOLD');
    if (!Number.isSafeInteger(safePoints) || safePoints < 1 || safePoints > MAX_POINTS_PER_EVENT) throw new Error('INVALID_POINTS');
    const now = Date.now();
    const current = await dbManager.get('SELECT activated_at FROM bonus_admin_rules WHERE guild_id = ? AND metric = ?', [String(guildId), metric]);
    const activatedAt = current ? Number(current.activated_at) || now : now;
    await dbManager.transaction(async tx => {
      if (!current) {
        const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
        await tx.run(`UPDATE bonus_admin_balances SET ${progressColumn} = 0, updated_at = ? WHERE guild_id = ?`, [now, String(guildId)]);
      }
      await tx.run(`
        INSERT INTO bonus_admin_rules (guild_id, metric, threshold, points, activated_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, metric) DO UPDATE SET
          threshold = excluded.threshold, points = excluded.points, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `, [String(guildId), metric, safeThreshold, safePoints, activatedAt, now, String(actorId)]);
      await insertAudit(tx, guildId, actorId, 'rule_update', null, { metric, threshold: safeThreshold, points: safePoints, newlyActivated: !current });
    }, 'bonus-admin-rule-set');
    return { metric, threshold: safeThreshold, points: safePoints, activatedAt, newlyActivated: !current };
  }

  async function disableRule(guildId, metric, actorId) {
    if (!Object.values(BONUS_METRICS).includes(metric)) throw new Error('INVALID_METRIC');
    const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
    return dbManager.transaction(async tx => {
      const existing = await tx.get('SELECT metric FROM bonus_admin_rules WHERE guild_id = ? AND metric = ?', [String(guildId), metric]);
      if (!existing) return { disabled: false, clearedProgress: 0 };
      const totals = await tx.get(`SELECT COALESCE(SUM(${progressColumn}), 0) AS amount FROM bonus_admin_balances WHERE guild_id = ?`, [String(guildId)]);
      await tx.run('DELETE FROM bonus_admin_rules WHERE guild_id = ? AND metric = ?', [String(guildId), metric]);
      await tx.run(`UPDATE bonus_admin_balances SET ${progressColumn} = 0, updated_at = ? WHERE guild_id = ?`, [Date.now(), String(guildId)]);
      await insertAudit(tx, guildId, actorId, 'rule_disable', null, { metric, clearedProgress: Number(totals?.amount) || 0 });
      return { disabled: true, clearedProgress: Number(totals?.amount) || 0 };
    }, 'bonus-admin-rule-disable');
  }

  async function addActivity({ guildId, userId, metric, amount, eventId }) {
    const guild = String(guildId || '');
    const user = String(userId || '');
    if (!guild || !user || !eventId || !Object.values(BONUS_METRICS).includes(metric)) return { ignored: true };
    const safeAmount = Math.floor(Number(amount));
    if (!Number.isSafeInteger(safeAmount) || safeAmount < 1) return { ignored: true };

    return dbManager.transaction(async tx => {
      const inserted = await tx.run(`
        INSERT OR IGNORE INTO bonus_admin_activity_events (event_id, guild_id, user_id, metric, amount, awarded_points, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `, [String(eventId), guild, user, metric, safeAmount, Date.now()]);
      if (!inserted.changes) return { duplicate: true, awardedPoints: 0 };

      const rule = await tx.get('SELECT threshold, points, activated_at FROM bonus_admin_rules WHERE guild_id = ? AND metric = ?', [guild, metric]);
      if (!rule) return { noRule: true, awardedPoints: 0 };

      let balance = await tx.get('SELECT * FROM bonus_admin_balances WHERE guild_id = ? AND user_id = ?', [guild, user]);
      if (!balance) {
        const now = Date.now();
        await tx.run(`INSERT OR IGNORE INTO bonus_admin_balances
          (guild_id, user_id, points, message_progress, voice_progress_ms, updated_at)
          VALUES (?, ?, 0, 0, 0, ?)`, [guild, user, now]);
        balance = await tx.get('SELECT * FROM bonus_admin_balances WHERE guild_id = ? AND user_id = ?', [guild, user]);
      }

      const currentMessageId = metric === BONUS_METRICS.messages ? String(eventId).split(':').pop() : null;
      let advanceMessageCursor = metric === BONUS_METRICS.messages;
      if (metric === BONUS_METRICS.messages && balance.last_message_id) {
        try { advanceMessageCursor = BigInt(currentMessageId) > BigInt(String(balance.last_message_id)); }
        catch { advanceMessageCursor = currentMessageId !== String(balance.last_message_id); }
      }
      if (metric === BONUS_METRICS.messages && balance.last_message_id && !advanceMessageCursor) {
        return { stale: true, awardedPoints: 0, countedAmount: 0 };
      }

      const now = Date.now();
      if (metric === BONUS_METRICS.messages && Number(balance.last_message_at) > 0
        && now - Number(balance.last_message_at) < MESSAGE_COUNT_COOLDOWN_MS) {
        if (advanceMessageCursor) {
          await tx.run('UPDATE bonus_admin_balances SET last_message_id = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
            [currentMessageId, now, guild, user]);
        }
        return { rateLimited: true, awardedPoints: 0, countedAmount: 0 };
      }

      const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
      const previousProgress = Number(balance[progressColumn]) || 0;
      let eligibleAmount = safeAmount;
      if (metric === BONUS_METRICS.voice) {
        const eventParts = String(eventId).split(':');
        const startAt = Number(eventParts[eventParts.length - 2]);
        const endAt = Number(eventParts[eventParts.length - 1]);
        const activatedAt = Number(rule.activated_at) || 0;
        if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt && activatedAt > startAt) {
          eligibleAmount = Math.min(safeAmount, Math.max(0, endAt - Math.max(startAt, activatedAt)));
        }
        if (eligibleAmount < 1) return { awardedPoints: 0, eligibleAmount: 0, beforeActivation: true };
      }

      const award = calculateAward(previousProgress, eligibleAmount, Number(rule.threshold), Number(rule.points));
      if (metric === BONUS_METRICS.messages) {
        await tx.run(`UPDATE bonus_admin_balances SET ${progressColumn} = ?, points = points + ?,
          last_message_id = ?, last_message_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`,
        [award.leftover, award.awardedPoints, advanceMessageCursor ? currentMessageId : balance.last_message_id,
          advanceMessageCursor ? now : balance.last_message_at, now, guild, user]);
      } else {
        await tx.run(`UPDATE bonus_admin_balances SET ${progressColumn} = ?, points = points + ?, updated_at = ?
          WHERE guild_id = ? AND user_id = ?`, [award.leftover, award.awardedPoints, now, guild, user]);
      }
      await tx.run('UPDATE bonus_admin_activity_events SET awarded_points = ? WHERE event_id = ?', [award.awardedPoints, String(eventId)]);
      return { awardedPoints: award.awardedPoints, eligibleAmount, completed: award.completed, leftover: award.leftover };
    }, 'bonus-admin-activity');
  }

  async function getBalance(guildId, userId) {
    return dbManager.get('SELECT * FROM bonus_admin_balances WHERE guild_id = ? AND user_id = ?', [String(guildId), String(userId)]);
  }

  async function adjustPoints(guildId, userId, delta, actorId) {
    const amount = Math.floor(Number(delta));
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_POINTS_PER_EVENT) throw new Error('INVALID_POINTS');
    const now = Date.now();
    return dbManager.transaction(async tx => {
      const row = await tx.get('SELECT points FROM bonus_admin_balances WHERE guild_id = ? AND user_id = ?', [String(guildId), String(userId)]);
      const before = Number(row?.points) || 0;
      const after = before + amount;
      if (after < 0) throw new Error('INSUFFICIENT_USER_POINTS');
      await tx.run(`INSERT INTO bonus_admin_balances (guild_id, user_id, points, message_progress, voice_progress_ms, updated_at)
        VALUES (?, ?, ?, 0, 0, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`,
      [String(guildId), String(userId), after, now]);
      await insertAudit(tx, guildId, actorId, amount > 0 ? 'manual_add' : 'manual_remove', userId, { before, after, delta: amount });
      return { before, after, delta: amount };
    }, 'bonus-admin-manual-points');
  }

  async function getLeaderboard(guildId, limit = 100, offset = 0) {
    return dbManager.all(`SELECT user_id, points, message_progress, voice_progress_ms, updated_at
      FROM bonus_admin_balances WHERE guild_id = ? AND points > 0
      ORDER BY points DESC, updated_at ASC, user_id ASC LIMIT ? OFFSET ?`,
    [String(guildId), Math.max(1, Math.min(500, Number(limit) || 100)), Math.max(0, Number(offset) || 0)]);
  }

  async function getSummary(guildId) {
    return dbManager.get(`SELECT COUNT(*) AS members, COALESCE(SUM(points), 0) AS points
      FROM bonus_admin_balances WHERE guild_id = ? AND points > 0`, [String(guildId)]);
  }

  return { readConfig, saveConfig, getRules, setRule, disableRule, addActivity, getBalance, adjustPoints, getLeaderboard, getSummary };
}

module.exports = { createAdminBonusManager };
