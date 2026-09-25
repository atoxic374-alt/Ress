const BONUS_METRICS = Object.freeze({ messages: 'messages', voice: 'voice_ms' });
const MAX_POINTS_PER_EVENT = 1000000;

function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function calculateAward(progress, amount, threshold, pointsPerThreshold, multiplier = 1) {
  const safeProgress = Math.max(0, Math.floor(Number(progress) || 0));
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  const safeThreshold = Math.max(1, Math.floor(Number(threshold) || 1));
  const safePoints = Math.max(1, Math.floor(Number(pointsPerThreshold) || 1));
  const total = safeProgress + safeAmount;
  const completed = Math.floor(total / safeThreshold);
  const leftover = total % safeThreshold;
  const baseAward = Math.min(MAX_POINTS_PER_EVENT, completed * safePoints);
  const factor = multiplier === 2 ? 2 : 1;
  return { leftover, baseAward, awardedPoints: Math.min(MAX_POINTS_PER_EVENT, baseAward * factor), completed };
}

function chooseOldestGroup(groups, roleIds, grantHistory = {}) {
  const heldRoleIds = new Set(Array.from(roleIds || [], String));
  const candidates = (groups || []).filter(group => heldRoleIds.has(String(group.role_id)));
  // لا نخمن عند تعدد القروبات: لا تُحتسب النقاط حتى يتوفر تاريخ موثوق لكل رول.
  if (candidates.length > 1 && candidates.some(group => Number(grantHistory[String(group.role_id)] || 0) <= 0)) return null;
  candidates.sort((a, b) => {
    const ta = Number(grantHistory[String(a.role_id)] || 0);
    const tb = Number(grantHistory[String(b.role_id)] || 0);
    const effectiveA = ta > 0 ? ta : Number.MAX_SAFE_INTEGER;
    const effectiveB = tb > 0 ? tb : Number.MAX_SAFE_INTEGER;
    if (effectiveA !== effectiveB) return effectiveA - effectiveB;
    const createdOrder = Number(a.created_at || 0) - Number(b.created_at || 0);
    if (createdOrder) return createdOrder;
    return String(a.role_id).localeCompare(String(b.role_id));
  });
  return candidates[0] || null;
}

function createBonusManager(dbManager) {
  if (!dbManager) throw new TypeError('dbManager is required');

  async function readConfig(guildId) {
    const row = await dbManager.get('SELECT config_json FROM bonus_guild_config WHERE guild_id = ?', [String(guildId)]);
    return safeJsonParse(row?.config_json, {});
  }

  async function saveConfig(guildId, patch, actorId = null) {
    return dbManager.transaction(async tx => {
      const row = await tx.get('SELECT config_json FROM bonus_guild_config WHERE guild_id = ?', [String(guildId)]);
      const current = safeJsonParse(row?.config_json, {});
      const next = { ...current, ...patch };
      await tx.run(`
        INSERT INTO bonus_guild_config (guild_id, config_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
      `, [String(guildId), JSON.stringify(next), Date.now()]);
      if (actorId) await insertAudit(tx, guildId, actorId, 'config_update', null, null, null, { keys: Object.keys(patch) });
      return next;
    }, 'bonus-config-save');
  }

  async function insertAudit(executor, guildId, actorId, action, targetUserId, sourceGroupId, targetGroupId, details = {}) {
    await executor.run(`
      INSERT INTO bonus_audit_log
        (guild_id, actor_id, action, target_user_id, source_group_id, target_group_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [String(guildId), actorId ? String(actorId) : null, String(action), targetUserId ? String(targetUserId) : null,
      sourceGroupId == null ? null : Number(sourceGroupId), targetGroupId == null ? null : Number(targetGroupId),
      JSON.stringify(details || {}), Date.now()]);
  }

  async function audit(guildId, actorId, action, targetUserId, sourceGroupId, targetGroupId, details = {}) {
    await insertAudit(dbManager, guildId, actorId, action, targetUserId, sourceGroupId, targetGroupId, details);
  }

  async function listAuditLog(guildId, { page = 0, limit = 10, action = null, userId = null, groupId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const safePage = Math.max(0, Number(page) || 0);
    const filters = ['guild_id = ?'];
    const params = [String(guildId)];
    if (action) { filters.push('action = ?'); params.push(String(action)); }
    if (userId) { filters.push('target_user_id = ?'); params.push(String(userId)); }
    if (groupId != null) { filters.push('(source_group_id = ? OR target_group_id = ?)'); params.push(Number(groupId), Number(groupId)); }
    const where = filters.join(' AND ');
    const total = await dbManager.get(`SELECT COUNT(*) AS count FROM bonus_audit_log WHERE ${where}`, params);
    const rows = await dbManager.all(`SELECT * FROM bonus_audit_log WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, safeLimit, safePage * safeLimit]);
    return { rows, total: Number(total?.count) || 0, page: safePage, limit: safeLimit };
  }

  async function listGroups(guildId, includeArchived = false) {
    const sql = includeArchived
      ? 'SELECT * FROM bonus_groups WHERE guild_id = ? ORDER BY created_at ASC, id ASC'
      : 'SELECT * FROM bonus_groups WHERE guild_id = ? AND archived_at IS NULL ORDER BY created_at ASC, id ASC';
    return dbManager.all(sql, [String(guildId)]);
  }

  async function getRules(guildId) {
    const rows = await dbManager.all('SELECT metric, threshold, points, activated_at FROM bonus_rules WHERE guild_id = ?', [String(guildId)]);
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
    if (!Number.isSafeInteger(safePoints) || safePoints < 1 || safePoints > 1000000) throw new Error('INVALID_POINTS');
    const now = Date.now();
    const created = await dbManager.transaction(async tx => {
      const current = await tx.get('SELECT activated_at FROM bonus_rules WHERE guild_id = ? AND metric = ?', [String(guildId), metric]);
      if (!current) {
        const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
        await tx.run(`UPDATE bonus_balances SET ${progressColumn} = 0, updated_at = ? WHERE guild_id = ?`, [now, String(guildId)]);
      }
      await tx.run(`
        INSERT INTO bonus_rules (guild_id, metric, threshold, points, activated_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, metric) DO UPDATE SET
          threshold = excluded.threshold, points = excluded.points,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `, [String(guildId), metric, safeThreshold, safePoints, current ? Number(current.activated_at) || now : now, now, String(actorId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'rule_update', ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null,
        JSON.stringify({ metric, threshold: safeThreshold, points: safePoints, newlyActivated: !current }), now]);
      return { newlyActivated: !current, activatedAt: current ? (Number(current.activated_at) || now) : now };
    }, 'bonus-rule-set');
    return { metric, threshold: safeThreshold, points: safePoints, activatedAt: created.activatedAt, newlyActivated: created.newlyActivated };
  }

  async function disableRule(guildId, metric, actorId) {
    if (!Object.values(BONUS_METRICS).includes(metric)) throw new Error('INVALID_METRIC');
    return dbManager.transaction(async tx => {
      const result = await tx.run('DELETE FROM bonus_rules WHERE guild_id = ? AND metric = ?', [String(guildId), metric]);
      const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
      const previous = await tx.get(`SELECT COALESCE(SUM(${progressColumn}), 0) AS progress FROM bonus_balances WHERE guild_id = ?`, [String(guildId)]);
      await tx.run(`UPDATE bonus_balances SET ${progressColumn} = 0, updated_at = ? WHERE guild_id = ?`, [Date.now(), String(guildId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'rule_disable', ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null,
        JSON.stringify({ metric, removed: result.changes, clearedProgress: Number(previous?.progress) || 0 }), Date.now()]);
      return { disabled: result.changes > 0, clearedProgress: Number(previous?.progress) || 0 };
    }, 'bonus-rule-disable');
  }

  async function addGroup(guildId, roleId, ownerId, actorId, avatarUrl = null) {
    return dbManager.transaction(async tx => {
      const existing = await tx.get('SELECT * FROM bonus_groups WHERE guild_id = ? AND role_id = ?', [String(guildId), String(roleId)]);
      if (existing && existing.archived_at == null) throw new Error('ROLE_ALREADY_REGISTERED');
      const ownerGroup = await tx.get(
        'SELECT id FROM bonus_groups WHERE guild_id = ? AND owner_id = ? AND archived_at IS NULL AND role_id <> ?',
        [String(guildId), String(ownerId), String(roleId)]
      );
      if (ownerGroup) throw new Error('OWNER_ALREADY_ASSIGNED');
      if (existing && existing.archived_at != null) {
        await tx.run(`UPDATE bonus_groups SET owner_id = ?, avatar_url = ?, archived_at = NULL WHERE id = ?`,
          [String(ownerId), avatarUrl, Number(existing.id)]);
        await insertAudit(tx, guildId, actorId, 'group_reactivate', null, null, Number(existing.id), { roleId: String(roleId), ownerId: String(ownerId) });
        return tx.get('SELECT * FROM bonus_groups WHERE id = ?', [Number(existing.id)]);
      }
      const now = Date.now();
      const result = await tx.run(`
        INSERT INTO bonus_groups (guild_id, role_id, owner_id, avatar_url, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [String(guildId), String(roleId), String(ownerId), avatarUrl, now, String(actorId)]);
      await insertAudit(tx, guildId, actorId, 'group_add', null, null, result.id, { roleId: String(roleId), ownerId: String(ownerId) });
      return tx.get('SELECT * FROM bonus_groups WHERE id = ?', [result.id]);
    }, 'bonus-group-add');
  }

  async function resolveTargetGroup(guildId, userId, roleIds, grantHistory = {}) {
    const groups = await listGroups(guildId, false);
    const target = chooseOldestGroup(groups, roleIds, grantHistory);
    return target ? Number(target.id) : null;
  }

  async function getRoleGrantHistory(guildId, userId, roleIds = []) {
    const ids = Array.from(new Set(Array.from(roleIds || [], String)));
    if (!ids.length) return {};
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await dbManager.all(`
      SELECT role_id, granted_at
      FROM bonus_member_role_history
      WHERE guild_id = ? AND user_id = ? AND removed_at IS NULL AND role_id IN (${placeholders})
    `, [String(guildId), String(userId), ...ids]);
    return Object.fromEntries(rows.map(row => [String(row.role_id), Number(row.granted_at) || 0]));
  }

  async function recordRoleChanges(guildId, userId, { addedRoleIds = [], removedRoleIds = [], changedAt = Date.now() } = {}) {
    const added = Array.from(new Set(Array.from(addedRoleIds || [], String)));
    const removed = Array.from(new Set(Array.from(removedRoleIds || [], String)));
    if (!added.length && !removed.length) return { added: 0, removed: 0 };
    const now = Number(changedAt) || Date.now();
    return dbManager.transaction(async tx => {
      for (const roleId of added) {
        await tx.run(`
          INSERT INTO bonus_member_role_history (guild_id, user_id, role_id, granted_at, removed_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?)
          ON CONFLICT(guild_id, user_id, role_id) DO UPDATE SET
            granted_at = CASE WHEN bonus_member_role_history.removed_at IS NULL
              THEN bonus_member_role_history.granted_at ELSE excluded.granted_at END,
            removed_at = NULL,
            updated_at = excluded.updated_at
        `, [String(guildId), String(userId), roleId, now, now]);
      }
      for (const roleId of removed) {
        await tx.run(`
          UPDATE bonus_member_role_history
          SET removed_at = ?, updated_at = ?
          WHERE guild_id = ? AND user_id = ? AND role_id = ? AND removed_at IS NULL
        `, [now, now, String(guildId), String(userId), roleId]);
      }
      return { added: added.length, removed: removed.length };
    }, 'bonus-role-history');
  }

  async function seedRoleGrantHistory(guildId, userId, history = {}) {
    const entries = Object.entries(history || {})
      .map(([roleId, grantedAt]) => [String(roleId), Number(grantedAt)])
      .filter(([, grantedAt]) => Number.isSafeInteger(grantedAt) && grantedAt > 0);
    if (!entries.length) return 0;
    return dbManager.transaction(async tx => {
      let inserted = 0;
      for (const [roleId, grantedAt] of entries) {
        const result = await tx.run(`
          INSERT OR IGNORE INTO bonus_member_role_history
            (guild_id, user_id, role_id, granted_at, removed_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?)
        `, [String(guildId), String(userId), roleId, grantedAt, Date.now()]);
        inserted += result.changes;
      }
      return inserted;
    }, 'bonus-role-history-seed');
  }

  async function syncAssignment(guildId, userId, targetGroupId, actorId = null, reason = 'role_sync') {
    const guild = String(guildId);
    const user = String(userId);
    const nextGroupId = targetGroupId == null ? null : Number(targetGroupId);
    return dbManager.transaction(async tx => {
      const current = await tx.get('SELECT * FROM bonus_balances WHERE guild_id = ? AND user_id = ?', [guild, user]);
      const oldGroupId = current?.group_id == null ? null : Number(current.group_id);
      if (oldGroupId === nextGroupId) return { changed: false, balance: current || null };

      const now = Date.now();
      await tx.run(`
        INSERT INTO bonus_balances
          (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, last_message_id, last_message_at, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, NULL, NULL, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET group_id = excluded.group_id, points = 0,
          message_progress = 0, voice_progress_ms = 0, last_message_id = NULL, last_message_at = NULL, updated_at = excluded.updated_at
      `, [guild, user, nextGroupId, now]);

      if (current) {
        if (oldGroupId != null) {
          await tx.run(`UPDATE bonus_multipliers SET active = 0
            WHERE guild_id = ? AND scope = 'user' AND group_id = ? AND user_id = ? AND active = 1`, [guild, oldGroupId, user]);
        }
        await tx.run(`
          INSERT INTO bonus_audit_log
            (guild_id, actor_id, action, target_user_id, source_group_id, target_group_id, details_json, created_at)
          VALUES (?, ?, 'member_transfer', ?, ?, ?, ?, ?)
        `, [guild, actorId ? String(actorId) : null, user, oldGroupId, nextGroupId,
          JSON.stringify({ reason, points: Number(current.points) || 0, messageProgress: Number(current.message_progress) || 0,
            voiceProgressMs: Number(current.voice_progress_ms) || 0 }), now]);
      }
      return { changed: true, sourceGroupId: oldGroupId, targetGroupId: nextGroupId,
        balance: { ...(current || {}), group_id: nextGroupId, points: 0, message_progress: 0, voice_progress_ms: 0,
          last_message_id: null, last_message_at: null } };
    }, 'bonus-assignment');
  }

  async function addActivity({ guildId, userId, metric, amount, eventId, roleIds = [], roleGrantHistory = {}, voiceSession = null }) {
    const guild = String(guildId || '');
    const user = String(userId || '');
    if (!guild || !user || !eventId || !Object.values(BONUS_METRICS).includes(metric)) return { ignored: true };
    const safeAmount = Math.floor(Number(amount));
    if (!Number.isSafeInteger(safeAmount) || safeAmount < 1) return { ignored: true };
    const targetGroupId = await resolveTargetGroup(guild, user, roleIds, roleGrantHistory);

    return dbManager.transaction(async tx => {
      // سجل كل نشاط كبصمة فريدة لمنع إعادة احتسابه بعد تغير إسناد العضو.
      const inserted = await tx.run(`
        INSERT OR IGNORE INTO bonus_activity_events
          (event_id, guild_id, user_id, metric, amount, awarded_points, group_id, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `, [String(eventId), guild, user, metric, safeAmount, targetGroupId, Date.now()]);
      if (!inserted.changes) return { duplicate: true, awardedPoints: 0 };

      // لا يمنح البونس نقاطاً أو تقدماً لعضو غير مسند إلى قروب نشط.
      // يبقى الحدث مسجلاً فقط لمنع إعادة معالجة نفس النشاط لاحقاً.
      if (targetGroupId == null) {
        return { unassigned: true, assignedGroupId: null, awardedPoints: 0, countedAmount: 0 };
      }

      const persistVoiceCursor = async () => {
        if (metric !== BONUS_METRICS.voice || !voiceSession) return;
        await tx.run(`
          INSERT INTO bonus_voice_sessions (guild_id, user_id, channel_id, last_checkpoint_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id,
            last_checkpoint_at = excluded.last_checkpoint_at, updated_at = excluded.updated_at
        `, [guild, user, String(voiceSession.channelId), Number(voiceSession.lastCheckpointAt), Date.now()]);
      };

      let balance = await tx.get('SELECT * FROM bonus_balances WHERE guild_id = ? AND user_id = ?', [guild, user]);
      const currentMessageId = metric === BONUS_METRICS.messages ? String(eventId).split(':').pop() : null;
      let shouldAdvanceMessageCursor = metric === BONUS_METRICS.messages;
      if (metric === BONUS_METRICS.messages && balance?.last_message_id) {
        try { shouldAdvanceMessageCursor = BigInt(currentMessageId) > BigInt(String(balance.last_message_id)); }
        catch { shouldAdvanceMessageCursor = currentMessageId !== String(balance.last_message_id); }
      }
      // الرسائل المتأخرة لا يجوز أن تمنح نقاطاً؛ مؤشر الرسالة يمنع تحريك المؤشر
      // فقط، لذلك يجب إيقاف النشاط القديم قبل حساب التقدم والمكافأة.
      if (metric === BONUS_METRICS.messages && balance?.last_message_id && !shouldAdvanceMessageCursor) {
        await tx.run('UPDATE bonus_activity_events SET group_id = ? WHERE event_id = ?', [targetGroupId, String(eventId)]);
        return { stale: true, assignedGroupId: targetGroupId, awardedPoints: 0, countedAmount: 0 };
      }
      if (!balance || (balance.group_id == null ? null : Number(balance.group_id)) !== targetGroupId) {
        const now = Date.now();
        const oldGroupId = balance?.group_id == null ? null : Number(balance.group_id);
        await tx.run(`
          INSERT INTO bonus_balances (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, last_message_id, last_message_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, NULL, NULL, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET group_id = excluded.group_id, points = 0,
            message_progress = 0, voice_progress_ms = 0, last_message_id = NULL, last_message_at = NULL, updated_at = excluded.updated_at
        `, [guild, user, targetGroupId, now]);
        if (balance) {
          if (oldGroupId != null) {
            await tx.run(`UPDATE bonus_multipliers SET active = 0
              WHERE guild_id = ? AND scope = 'user' AND group_id = ? AND user_id = ? AND active = 1`, [guild, oldGroupId, user]);
          }
          await tx.run(`
            INSERT INTO bonus_audit_log
              (guild_id, action, target_user_id, source_group_id, target_group_id, details_json, created_at)
            VALUES (?, 'member_transfer', ?, ?, ?, ?, ?)
          `, [guild, user, oldGroupId, targetGroupId, JSON.stringify({ reason: 'activity_role_resolution', points: balance.points,
            messageProgress: balance.message_progress, voiceProgressMs: balance.voice_progress_ms }), now]);
        balance = { ...balance, group_id: targetGroupId, points: 0, message_progress: 0, voice_progress_ms: 0,
          last_message_id: null, last_message_at: null };
        } else {
          balance = { points: 0, message_progress: 0, voice_progress_ms: 0, group_id: targetGroupId };
        }
      }

      const rule = await tx.get('SELECT threshold, points, activated_at FROM bonus_rules WHERE guild_id = ? AND metric = ?', [guild, metric]);
      if (!rule) {
        if (metric === BONUS_METRICS.messages) {
          if (shouldAdvanceMessageCursor) {
            await tx.run('UPDATE bonus_balances SET last_message_id = ?, last_message_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
              [currentMessageId, Date.now(), Date.now(), guild, user]);
          }
        } else {
          await tx.run('UPDATE bonus_activity_events SET group_id = ? WHERE event_id = ?', [targetGroupId, String(eventId)]);
          await persistVoiceCursor();
        }
        return { noRule: true, assignedGroupId: targetGroupId, awardedPoints: 0 };
      }

      const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
      const previousProgress = Number(balance[progressColumn]) || 0;
      const now = Date.now();
      const groupId = targetGroupId;
      let eligibleAmount = safeAmount;
      if (metric === BONUS_METRICS.voice) {
        const eventParts = String(eventId).split(':');
        const startAt = Number(eventParts[eventParts.length - 2]);
        const endAt = Number(eventParts[eventParts.length - 1]);
        const activatedAt = Number(rule.activated_at) || 0;
        if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt && activatedAt > startAt) {
          eligibleAmount = Math.min(safeAmount, Math.max(0, endAt - Math.max(startAt, activatedAt)));
        }
        if (eligibleAmount < 1) {
          await tx.run('UPDATE bonus_activity_events SET group_id = ? WHERE event_id = ?', [groupId, String(eventId)]);
          await persistVoiceCursor();
          return { assignedGroupId: groupId, awardedPoints: 0, eligibleAmount: 0, beforeActivation: true };
        }
      }
      let multiplier = 1;
      if (groupId != null) {
        const userDouble = await tx.get(`
          SELECT id FROM bonus_multipliers
          WHERE guild_id = ? AND scope = 'user' AND group_id = ? AND user_id = ? AND active = 1
            AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY created_at DESC LIMIT 1
        `, [guild, groupId, user, now, now]);
        const groupDouble = await tx.get(`
          SELECT id FROM bonus_multipliers
          WHERE guild_id = ? AND scope = 'group' AND group_id = ? AND active = 1
            AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY created_at DESC LIMIT 1
        `, [guild, groupId, now, now]);
        if (userDouble || groupDouble) multiplier = 2;
      }

      const award = calculateAward(previousProgress, eligibleAmount, Number(rule.threshold), Number(rule.points), multiplier);
      if (metric === BONUS_METRICS.messages) {
        const lastMessageId = shouldAdvanceMessageCursor ? currentMessageId : balance.last_message_id;
        await tx.run(`
          UPDATE bonus_balances SET ${progressColumn} = ?, points = points + ?, last_message_id = ?, last_message_at = ?, updated_at = ?
          WHERE guild_id = ? AND user_id = ?
        `, [award.leftover, award.awardedPoints, lastMessageId, shouldAdvanceMessageCursor ? now : balance.last_message_at, now, guild, user]);
      } else {
        await tx.run(`
          UPDATE bonus_balances SET ${progressColumn} = ?, points = points + ?, updated_at = ?
          WHERE guild_id = ? AND user_id = ?
        `, [award.leftover, award.awardedPoints, now, guild, user]);
        await tx.run('UPDATE bonus_activity_events SET awarded_points = ?, group_id = ? WHERE event_id = ?',
          [award.awardedPoints, groupId, String(eventId)]);
        await persistVoiceCursor();
      }
      return { assignedGroupId: groupId, awardedPoints: award.awardedPoints, completed: award.completed, eligibleAmount,
        leftover: award.leftover, multiplier, baseAward: award.baseAward };
    }, 'bonus-activity');
  }

  async function setMultiplier(guildId, { scope, groupId, userId = null, durationMs = null }, actorId) {
    if (!['group', 'user'].includes(scope) || !Number.isSafeInteger(Number(groupId)) || Number(groupId) < 1) throw new Error('INVALID_MULTIPLIER_SCOPE');
    if (scope === 'user' && !userId) throw new Error('USER_REQUIRED');
    if (durationMs != null && (!Number.isSafeInteger(Number(durationMs)) || Number(durationMs) <= 0)) throw new Error('INVALID_MULTIPLIER_DURATION');
    const now = Date.now();
    const endsAt = durationMs ? now + Math.max(60000, Math.min(Number(durationMs), 30 * 24 * 60 * 60 * 1000)) : null;
    return dbManager.transaction(async tx => {
      const group = await tx.get('SELECT id FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL', [String(guildId), Number(groupId)]);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      await tx.run(`
        UPDATE bonus_multipliers SET active = 0
        WHERE guild_id = ? AND scope = ? AND group_id = ? AND active = 1 AND COALESCE(user_id, '') = COALESCE(?, '')
      `, [String(guildId), scope, Number(groupId), userId ? String(userId) : null]);
      const result = await tx.run(`
        INSERT INTO bonus_multipliers
          (guild_id, scope, group_id, user_id, starts_at, ends_at, active, changed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `, [String(guildId), scope, Number(groupId), userId ? String(userId) : null, now, endsAt, String(actorId), now]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, target_user_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'double_bonus_on', ?, ?, ?, ?)
      `, [String(guildId), String(actorId), userId ? String(userId) : null, Number(groupId), JSON.stringify({ scope, endsAt }), now]);
      return { id: result.id, scope, groupId: Number(groupId), userId: userId ? String(userId) : null, endsAt };
    }, 'bonus-multiplier');
  }

  async function clearMultiplier(guildId, { scope, groupId, userId = null }, actorId) {
    if (!['group', 'user'].includes(scope) || !Number.isSafeInteger(Number(groupId)) || Number(groupId) < 1) {
      throw new Error('INVALID_MULTIPLIER_SCOPE');
    }
    if (scope === 'user' && !userId) throw new Error('USER_REQUIRED');
    return dbManager.transaction(async tx => {
      const group = await tx.get('SELECT id FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL', [String(guildId), Number(groupId)]);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      const result = await tx.run(`
        UPDATE bonus_multipliers SET active = 0
        WHERE guild_id = ? AND scope = ? AND group_id = ? AND active = 1 AND COALESCE(user_id, '') = COALESCE(?, '')
      `, [String(guildId), scope, Number(groupId), userId ? String(userId) : null]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, target_user_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'double_bonus_off', ?, ?, ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null, userId ? String(userId) : null, Number(groupId),
        JSON.stringify({ scope, removed: result.changes }), Date.now()]);
      return result.changes;
    }, 'bonus-multiplier-clear');
  }

  async function listActiveUserMultipliers(guildId, groupId) {
    const now = Date.now();
    return dbManager.all(`
      SELECT id, user_id, starts_at, ends_at, changed_by, created_at
      FROM bonus_multipliers
      WHERE guild_id = ? AND scope = 'user' AND group_id = ? AND active = 1
        AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY created_at DESC
    `, [String(guildId), Number(groupId), now, now]);
  }

  async function getActiveGroupMultiplier(guildId, groupId) {
    const now = Date.now();
    return dbManager.get(`
      SELECT id, starts_at, ends_at, changed_by, created_at
      FROM bonus_multipliers
      WHERE guild_id = ? AND scope = 'group' AND group_id = ? AND active = 1
        AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
      ORDER BY created_at DESC LIMIT 1
    `, [String(guildId), Number(groupId), now, now]);
  }

  async function adjustGroupPoints(guildId, groupId, delta, actorId) {
    const safeDelta = Number(delta);
    if (!Number.isSafeInteger(safeDelta) || safeDelta === 0 || Math.abs(safeDelta) > MAX_POINTS_PER_EVENT) {
      throw new Error('INVALID_POINTS_ADJUSTMENT');
    }
    return dbManager.transaction(async tx => {
      const group = await tx.get('SELECT id FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL', [String(guildId), Number(groupId)]);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      const currentRow = await tx.get('SELECT points FROM bonus_group_point_balances WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      const manualBefore = Number(currentRow?.points) || 0;
      const membersRow = await tx.get('SELECT COALESCE(SUM(points), 0) AS points FROM bonus_balances WHERE guild_id = ? AND group_id = ?',
        [String(guildId), Number(groupId)]);
      const adjustmentsRow = await tx.get('SELECT COALESCE(SUM(delta), 0) AS points FROM bonus_group_adjustments WHERE guild_id = ? AND group_id = ? AND active = 1',
        [String(guildId), Number(groupId)]);
      const before = manualBefore + Number(membersRow?.points || 0) + Number(adjustmentsRow?.points || 0);
      const actualDelta = safeDelta > 0 ? safeDelta : -Math.min(Math.abs(safeDelta), Math.max(0, before));
      if (safeDelta < 0 && actualDelta === 0) throw new Error('NO_POINTS_TO_REMOVE');
      const after = before + actualDelta;
      if (safeDelta > 0) {
        await tx.run(`
          INSERT INTO bonus_group_point_balances (guild_id, group_id, points, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(guild_id, group_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at
        `, [String(guildId), Number(groupId), manualBefore + safeDelta, Date.now()]);
      } else {
        await tx.run(`
          INSERT INTO bonus_group_adjustments (guild_id, group_id, delta, reason, actor_id, active, created_at)
          VALUES (?, ?, ?, 'manual_group_deduction', ?, 1, ?)
        `, [String(guildId), Number(groupId), actualDelta, actorId ? String(actorId) : null, Date.now()]);
      }
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null, safeDelta > 0 ? 'manual_group_points_add' : 'manual_group_points_remove',
        Number(groupId), Number(groupId), JSON.stringify({ requested: Math.abs(safeDelta), actual: Math.abs(actualDelta), before, after,
          affectsMembers: false, persistent: safeDelta < 0 }), Date.now()]);
      return { before, after, delta: actualDelta, manualDelta: safeDelta > 0 ? actualDelta : 0, memberDelta: 0, deductions: [] };
    }, 'bonus-manual-group-points');
  }

  async function adjustUserPoints(guildId, groupId, userId, amount, actorId) {
    const safeAmount = Number(amount);
    if (!Number.isSafeInteger(safeAmount) || safeAmount <= 0 || safeAmount > MAX_POINTS_PER_EVENT) throw new Error('INVALID_POINTS_ADJUSTMENT');
    return dbManager.transaction(async tx => {
      const group = await tx.get('SELECT id FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL', [String(guildId), Number(groupId)]);
      const row = await tx.get('SELECT points FROM bonus_balances WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(groupId), String(userId)]);
      if (!group || !row) throw new Error('MEMBER_NOT_IN_GROUP');
      const before = Number(row.points) || 0;
      if (safeAmount > before) throw new Error('INSUFFICIENT_MEMBER_POINTS');
      const now = Date.now();
      await tx.run('UPDATE bonus_balances SET points = points - ?, updated_at = ? WHERE guild_id = ? AND group_id = ? AND user_id = ?',
        [safeAmount, now, String(guildId), Number(groupId), String(userId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, target_user_id, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'member_points_remove', ?, ?, ?, ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null, String(userId), Number(groupId), Number(groupId),
        JSON.stringify({ requested: safeAmount, before, after: before - safeAmount }), now]);
      return { userId: String(userId), before, after: before - safeAmount, delta: -safeAmount };
    }, 'bonus-member-points-remove');
  }

  async function resetGroup(guildId, groupId, actorId) {
    return dbManager.transaction(async tx => {
      const group = await tx.get('SELECT id FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL', [String(guildId), Number(groupId)]);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      const rows = await tx.all('SELECT user_id, points, message_progress, voice_progress_ms FROM bonus_balances WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      const adjustments = await tx.all('SELECT delta, reason, actor_id, created_at FROM bonus_group_adjustments WHERE guild_id = ? AND group_id = ? AND active = 1',
        [String(guildId), Number(groupId)]);
      const totals = rows.reduce((acc, row) => ({
        members: acc.members + 1,
        points: acc.points + Number(row.points || 0),
        messageProgress: acc.messageProgress + Number(row.message_progress || 0),
        voiceProgressMs: acc.voiceProgressMs + Number(row.voice_progress_ms || 0)
      }), { members: 0, points: 0, messageProgress: 0, voiceProgressMs: 0 });
      const manual = await tx.get('SELECT points FROM bonus_group_point_balances WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      totals.manualPoints = Number(manual?.points) || 0;
      totals.points += totals.manualPoints;
      totals.adjustmentPoints = adjustments.reduce((sum, row) => sum + Number(row.delta || 0), 0);
      totals.points += totals.adjustmentPoints;
      const snapshotAt = Date.now();
      const snapshot = { snapshotAt, rows, manualPoints: totals.manualPoints, adjustments };
      const snapshotResult = await tx.run(`
        INSERT INTO bonus_group_reset_snapshots (guild_id, group_id, snapshot_json, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [String(guildId), Number(groupId), JSON.stringify(snapshot), actorId ? String(actorId) : null, snapshotAt]);
      await tx.run(`UPDATE bonus_balances SET points = 0, message_progress = 0, voice_progress_ms = 0, updated_at = ? WHERE guild_id = ? AND group_id = ?`, [Date.now(), String(guildId), Number(groupId)]);
      await tx.run('UPDATE bonus_group_point_balances SET points = 0, updated_at = ? WHERE guild_id = ? AND group_id = ?', [Date.now(), String(guildId), Number(groupId)]);
      await tx.run('UPDATE bonus_group_adjustments SET active = 0 WHERE guild_id = ? AND group_id = ? AND active = 1', [String(guildId), Number(groupId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'group_reset', ?, ?, ?, ?)
      `, [String(guildId), String(actorId), Number(groupId), Number(groupId), JSON.stringify({ ...totals, snapshotId: snapshotResult.id }), Date.now()]);
      return { ...totals, snapshotId: snapshotResult.id };
    }, 'bonus-reset-group');
  }

  async function listGroupResetSnapshots(guildId, groupId, limit = 10) {
    return dbManager.all(`
      SELECT id, actor_id, created_at, restored_at
      FROM bonus_group_reset_snapshots
      WHERE guild_id = ? AND group_id = ?
      ORDER BY created_at DESC LIMIT ?
    `, [String(guildId), Number(groupId), Math.max(1, Math.min(25, Number(limit) || 10))]);
  }

  async function restoreGroupReset(guildId, groupId, snapshotId, actorId) {
    return dbManager.transaction(async tx => {
      const group = await tx.get('SELECT id FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL', [String(guildId), Number(groupId)]);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      const snapshotRow = await tx.get('SELECT * FROM bonus_group_reset_snapshots WHERE guild_id = ? AND group_id = ? AND id = ?',
        [String(guildId), Number(groupId), Number(snapshotId)]);
      if (!snapshotRow) throw new Error('RESET_SNAPSHOT_NOT_FOUND');
      const snapshot = safeJsonParse(snapshotRow.snapshot_json, {});
      const now = Date.now();
      for (const row of Array.isArray(snapshot.rows) ? snapshot.rows : []) {
        await tx.run(`UPDATE bonus_balances SET points = ?, message_progress = ?, voice_progress_ms = ?, updated_at = ?
          WHERE guild_id = ? AND group_id = ? AND user_id = ?`,
        [Math.max(0, Number(row.points) || 0), Math.max(0, Number(row.message_progress) || 0), Math.max(0, Number(row.voice_progress_ms) || 0), now,
          String(guildId), Number(groupId), String(row.user_id)]);
      }
      await tx.run(`
        INSERT INTO bonus_group_point_balances (guild_id, group_id, points, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, group_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at
      `, [String(guildId), Number(groupId), Math.max(0, Number(snapshot.manualPoints) || 0), now]);
      await tx.run('UPDATE bonus_group_adjustments SET active = 0 WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      for (const adjustment of Array.isArray(snapshot.adjustments) ? snapshot.adjustments : []) {
        const delta = Number(adjustment.delta);
        if (!Number.isSafeInteger(delta) || delta === 0) continue;
        await tx.run(`INSERT INTO bonus_group_adjustments (guild_id, group_id, delta, reason, actor_id, active, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)`, [String(guildId), Number(groupId), delta, String(adjustment.reason || 'restored'),
          adjustment.actor_id ? String(adjustment.actor_id) : null, Number(adjustment.created_at) || now]);
      }
      await tx.run('UPDATE bonus_group_reset_snapshots SET restored_at = ? WHERE id = ?', [now, Number(snapshotId)]);
      await tx.run(`INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'group_reset_restore', ?, ?, ?, ?)`, [String(guildId), actorId ? String(actorId) : null, Number(groupId), Number(groupId),
        JSON.stringify({ snapshotId: Number(snapshotId) }), now]);
      return { restored: true, snapshotId: Number(snapshotId) };
    }, 'bonus-reset-restore');
  }

  async function resetUser(guildId, groupId, userId, actorId) {
    return dbManager.transaction(async tx => {
      const row = await tx.get('SELECT points, message_progress, voice_progress_ms FROM bonus_balances WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(groupId), String(userId)]);
      if (!row) return null;
      const before = { points: Number(row.points) || 0, messageProgress: Number(row.message_progress) || 0,
        voiceProgressMs: Number(row.voice_progress_ms) || 0 };
      await tx.run(`UPDATE bonus_balances SET points = 0, message_progress = 0, voice_progress_ms = 0, updated_at = ? WHERE guild_id = ? AND group_id = ? AND user_id = ?`,
        [Date.now(), String(guildId), Number(groupId), String(userId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, target_user_id, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'member_reset', ?, ?, ?, ?, ?)
      `, [String(guildId), String(actorId), String(userId), Number(groupId), Number(groupId), JSON.stringify(before), Date.now()]);
      return before;
    }, 'bonus-reset-user');
  }

  async function updateGroup(guildId, groupId, patch, actorId) {
    const allowed = ['owner_id', 'avatar_url'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) throw new Error('EMPTY_GROUP_UPDATE');
    return dbManager.transaction(async tx => {
      const current = await tx.get('SELECT * FROM bonus_groups WHERE guild_id = ? AND id = ?', [String(guildId), Number(groupId)]);
      if (!current) throw new Error('GROUP_NOT_FOUND');
      if (entries.some(([key]) => key === 'owner_id')) {
        const ownerGroup = await tx.get(
          'SELECT id FROM bonus_groups WHERE guild_id = ? AND owner_id = ? AND archived_at IS NULL AND id <> ?',
          [String(guildId), String(patch.owner_id), Number(groupId)]
        );
        if (ownerGroup) throw new Error('OWNER_ALREADY_ASSIGNED');
      }
      const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
      const values = entries.map(([, value]) => value);
      await tx.run(`UPDATE bonus_groups SET ${setSql} WHERE guild_id = ? AND id = ?`, [...values, String(guildId), Number(groupId)]);
      const after = Object.fromEntries(entries);
      const before = Object.fromEntries(entries.map(([key]) => [key, current[key] ?? null]));
      await insertAudit(tx, guildId, actorId, entries.some(([key]) => key === 'owner_id') ? 'owner_change' : 'group_update', null,
        Number(groupId), Number(groupId), { before, after, changedFields: entries.map(([key]) => key) });
      return tx.get('SELECT * FROM bonus_groups WHERE guild_id = ? AND id = ?', [String(guildId), Number(groupId)]);
    }, 'bonus-group-update');
  }

  async function archiveGroup(guildId, groupId, actorId) {
    return dbManager.transaction(async tx => {
      const now = Date.now();
      const result = await tx.run('UPDATE bonus_groups SET archived_at = ? WHERE guild_id = ? AND id = ? AND archived_at IS NULL',
        [now, String(guildId), Number(groupId)]);
      if (!result.changes) return false;
      const members = await tx.all('SELECT user_id, points, message_progress, voice_progress_ms FROM bonus_balances WHERE guild_id = ? AND group_id = ?',
        [String(guildId), Number(groupId)]);
      const totals = members.reduce((result, member) => ({
        points: result.points + Number(member.points || 0),
        messageProgress: result.messageProgress + Number(member.message_progress || 0),
        voiceProgressMs: result.voiceProgressMs + Number(member.voice_progress_ms || 0)
      }), { points: 0, messageProgress: 0, voiceProgressMs: 0 });
      await tx.run(`
        UPDATE bonus_balances
        SET group_id = NULL, points = 0, message_progress = 0, voice_progress_ms = 0,
          last_message_id = NULL, last_message_at = NULL, updated_at = ?
        WHERE guild_id = ? AND group_id = ?
      `, [now, String(guildId), Number(groupId)]);
      await tx.run('UPDATE bonus_multipliers SET active = 0 WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, details_json, created_at)
        VALUES (?, ?, 'group_archive', ?, ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null, Number(groupId), JSON.stringify({
        unassignedMembers: members.length, resetApplied: true, before: totals,
        after: { points: 0, messageProgress: 0, voiceProgressMs: 0 }
      }), now]);
      return true;
    }, 'bonus-archive-group');
  }

  async function getLeaderboard(guildId, limit = 10, offset = 0) {
    return dbManager.all(`
      SELECT g.id, g.role_id, g.owner_id, g.avatar_url, g.created_at,
        COALESCE(SUM(b.points), 0) + COALESCE(MAX(gp.points), 0) + COALESCE(MAX(ga.points), 0) AS points,
        COUNT(DISTINCT CASE WHEN b.points > 0 THEN b.user_id END) AS contributors
      FROM bonus_groups g
      LEFT JOIN bonus_balances b ON b.guild_id = g.guild_id AND b.group_id = g.id
      LEFT JOIN bonus_group_point_balances gp ON gp.guild_id = g.guild_id AND gp.group_id = g.id
      LEFT JOIN (SELECT guild_id, group_id, SUM(delta) AS points FROM bonus_group_adjustments WHERE active = 1 GROUP BY guild_id, group_id) ga
        ON ga.guild_id = g.guild_id AND ga.group_id = g.id
      WHERE g.guild_id = ? AND g.archived_at IS NULL
      GROUP BY g.id
      ORDER BY points DESC, g.created_at ASC, g.id ASC
      LIMIT ? OFFSET ?
    `, [String(guildId), Math.max(1, Math.min(25, Number(limit) || 10)), Math.max(0, Number(offset) || 0)]);
  }

  async function getLeaderboardSummary(guildId) {
    return dbManager.get(`
      SELECT COUNT(*) AS groups, COALESCE(SUM(points), 0) AS points FROM (
        SELECT g.id, COALESCE(SUM(b.points), 0) + COALESCE(MAX(gp.points), 0) + COALESCE(MAX(ga.points), 0) AS points
        FROM bonus_groups g
        LEFT JOIN bonus_balances b ON b.guild_id = g.guild_id AND b.group_id = g.id
        LEFT JOIN bonus_group_point_balances gp ON gp.guild_id = g.guild_id AND gp.group_id = g.id
        LEFT JOIN (SELECT guild_id, group_id, SUM(delta) AS points FROM bonus_group_adjustments WHERE active = 1 GROUP BY guild_id, group_id) ga
          ON ga.guild_id = g.guild_id AND ga.group_id = g.id
        WHERE g.guild_id = ? AND g.archived_at IS NULL
        GROUP BY g.id
      )
    `, [String(guildId)]);
  }

  async function getGroupPoints(guildId, groupId) {
    const row = await dbManager.get(`
      SELECT COALESCE((SELECT SUM(points) FROM bonus_balances WHERE guild_id = ? AND group_id = ?), 0)
        + COALESCE((SELECT points FROM bonus_group_point_balances WHERE guild_id = ? AND group_id = ?), 0)
        + COALESCE((SELECT SUM(delta) FROM bonus_group_adjustments WHERE guild_id = ? AND group_id = ? AND active = 1), 0) AS points
      FROM bonus_groups WHERE guild_id = ? AND id = ? AND archived_at IS NULL
    `, [String(guildId), Number(groupId), String(guildId), Number(groupId), String(guildId), Number(groupId), String(guildId), Number(groupId)]);
    return row ? Number(row.points) || 0 : null;
  }

  async function getBalance(guildId, userId) {
    return dbManager.get('SELECT * FROM bonus_balances WHERE guild_id = ? AND user_id = ?', [String(guildId), String(userId)]);
  }

  async function isReady(guildId) {
    const [config, groups, rules] = await Promise.all([readConfig(guildId), listGroups(guildId), getRules(guildId)]);
    return Boolean(config.channelId && config.topMessageId && groups.length > 0 && Object.keys(rules).length > 0);
  }

  return {
    readConfig, saveConfig, audit, listAuditLog, listGroups, getRules, setRule, disableRule, addGroup, resolveTargetGroup,
    getRoleGrantHistory, recordRoleChanges, seedRoleGrantHistory,
    syncAssignment, addActivity, setMultiplier, clearMultiplier, listActiveUserMultipliers, getActiveGroupMultiplier,
    adjustGroupPoints, adjustUserPoints, resetGroup, listGroupResetSnapshots, restoreGroupReset, resetUser, updateGroup, archiveGroup,
    getLeaderboard, getLeaderboardSummary, getGroupPoints, getBalance, isReady
  };
}

module.exports = { createBonusManager, calculateAward, chooseOldestGroup, BONUS_METRICS };
