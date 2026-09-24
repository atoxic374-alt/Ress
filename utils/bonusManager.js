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
  candidates.sort((a, b) => {
    const ta = Number(grantHistory[String(a.role_id)] || 0);
    const tb = Number(grantHistory[String(b.role_id)] || 0);
    const effectiveA = ta > 0 ? ta : Number(a.created_at || Number.MAX_SAFE_INTEGER);
    const effectiveB = tb > 0 ? tb : Number(b.created_at || Number.MAX_SAFE_INTEGER);
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
    const current = await readConfig(guildId);
    const next = { ...current, ...patch };
    await dbManager.run(`
      INSERT INTO bonus_guild_config (guild_id, config_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
    `, [String(guildId), JSON.stringify(next), Date.now()]);
    if (actorId) {
      await audit(guildId, actorId, 'config_update', null, null, null, { keys: Object.keys(patch) });
    }
    return next;
  }

  async function audit(guildId, actorId, action, targetUserId, sourceGroupId, targetGroupId, details = {}) {
    await dbManager.run(`
      INSERT INTO bonus_audit_log
        (guild_id, actor_id, action, target_user_id, source_group_id, target_group_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [String(guildId), actorId ? String(actorId) : null, String(action), targetUserId ? String(targetUserId) : null,
      sourceGroupId == null ? null : Number(sourceGroupId), targetGroupId == null ? null : Number(targetGroupId),
      JSON.stringify(details || {}), Date.now()]);
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
    const existing = await dbManager.get('SELECT * FROM bonus_groups WHERE guild_id = ? AND role_id = ?', [String(guildId), String(roleId)]);
    if (existing && existing.archived_at == null) throw new Error('ROLE_ALREADY_REGISTERED');
    if (existing && existing.archived_at != null) {
      await dbManager.run(`UPDATE bonus_groups SET owner_id = ?, avatar_url = ?, archived_at = NULL WHERE id = ?`,
        [String(ownerId), avatarUrl, Number(existing.id)]);
      await audit(guildId, actorId, 'group_reactivate', null, null, Number(existing.id), { roleId: String(roleId), ownerId: String(ownerId) });
      return dbManager.get('SELECT * FROM bonus_groups WHERE id = ?', [Number(existing.id)]);
    }
    const now = Date.now();
    const result = await dbManager.run(`
      INSERT INTO bonus_groups (guild_id, role_id, owner_id, avatar_url, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [String(guildId), String(roleId), String(ownerId), avatarUrl, now, String(actorId)]);
    await audit(guildId, actorId, 'group_add', null, null, result.id, { roleId: String(roleId), ownerId: String(ownerId) });
    return dbManager.get('SELECT * FROM bonus_groups WHERE id = ?', [result.id]);
  }

  async function resolveTargetGroup(guildId, userId, roleIds, grantHistory = {}) {
    const groups = await listGroups(guildId, false);
    const target = chooseOldestGroup(groups, roleIds, grantHistory);
    return target ? Number(target.id) : null;
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
          (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at
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
        balance: current || { points: 0, message_progress: 0, voice_progress_ms: 0 } };
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
      if (metric === BONUS_METRICS.voice) {
        const inserted = await tx.run(`
          INSERT OR IGNORE INTO bonus_activity_events
            (event_id, guild_id, user_id, metric, amount, awarded_points, group_id, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `, [String(eventId), guild, user, metric, safeAmount, targetGroupId, Date.now()]);
        if (!inserted.changes) return { duplicate: true, awardedPoints: 0 };
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
      if (metric === BONUS_METRICS.messages && balance?.last_message_id) {
        const currentSnowflake = String(eventId).split(':').pop();
        const previousSnowflake = String(balance.last_message_id);
        try {
          if (currentSnowflake === previousSnowflake || (BigInt(currentSnowflake) <= BigInt(previousSnowflake))) {
            return { duplicate: true, awardedPoints: 0 };
          }
        } catch {
          if (currentSnowflake === previousSnowflake) return { duplicate: true, awardedPoints: 0 };
        }
      }
      if (!balance || (balance.group_id == null ? null : Number(balance.group_id)) !== targetGroupId) {
        const now = Date.now();
        const oldGroupId = balance?.group_id == null ? null : Number(balance.group_id);
        await tx.run(`
          INSERT INTO bonus_balances (guild_id, user_id, group_id, points, message_progress, voice_progress_ms, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at
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
          balance = { ...balance, group_id: targetGroupId };
        } else {
          balance = { points: 0, message_progress: 0, voice_progress_ms: 0, group_id: targetGroupId };
        }
      }

      const rule = await tx.get('SELECT threshold, points, activated_at FROM bonus_rules WHERE guild_id = ? AND metric = ?', [guild, metric]);
      if (!rule) {
        if (metric === BONUS_METRICS.messages) {
          const snowflake = String(eventId).split(':').pop();
          await tx.run('UPDATE bonus_balances SET last_message_id = ?, last_message_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
            [snowflake, Date.now(), Date.now(), guild, user]);
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
        const snowflake = String(eventId).split(':').pop();
        await tx.run(`
          UPDATE bonus_balances SET ${progressColumn} = ?, points = points + ?, last_message_id = ?, last_message_at = ?, updated_at = ?
          WHERE guild_id = ? AND user_id = ?
        `, [award.leftover, award.awardedPoints, snowflake, now, now, guild, user]);
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
    if (!['group', 'user'].includes(scope) || !Number.isSafeInteger(Number(groupId))) throw new Error('INVALID_MULTIPLIER_SCOPE');
    if (scope === 'user' && !userId) throw new Error('USER_REQUIRED');
    const now = Date.now();
    const endsAt = durationMs ? now + Math.max(60000, Math.min(Number(durationMs), 30 * 24 * 60 * 60 * 1000)) : null;
    return dbManager.transaction(async tx => {
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
    const result = await dbManager.run(`
      UPDATE bonus_multipliers SET active = 0
      WHERE guild_id = ? AND scope = ? AND group_id = ? AND active = 1 AND COALESCE(user_id, '') = COALESCE(?, '')
    `, [String(guildId), scope, Number(groupId), userId ? String(userId) : null]);
    await audit(guildId, actorId, 'double_bonus_off', userId, groupId, groupId, { scope, removed: result.changes });
    return result.changes;
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
      const members = await tx.all('SELECT user_id, points FROM bonus_balances WHERE guild_id = ? AND group_id = ? AND points > 0 ORDER BY points DESC, user_id ASC',
        [String(guildId), Number(groupId)]);
      const membersBefore = members.reduce((sum, row) => sum + Number(row.points || 0), 0);
      const before = manualBefore + membersBefore;
      let after;
      let actualDelta;
      let manualDelta = 0;
      let memberDelta = 0;
      const deductionPreview = [];
      let deductionCount = 0;
      if (safeDelta > 0) {
        after = before + safeDelta;
        actualDelta = safeDelta;
        manualDelta = safeDelta;
        await tx.run(`
          INSERT INTO bonus_group_point_balances (guild_id, group_id, points, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(guild_id, group_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at
        `, [String(guildId), Number(groupId), manualBefore + safeDelta, Date.now()]);
      } else {
        const requested = Math.abs(safeDelta);
        const remaining = Math.min(requested, before);
        if (!remaining) throw new Error('NO_POINTS_TO_REMOVE');
        const manualTaken = Math.min(manualBefore, remaining);
        manualDelta = -manualTaken;
        let pending = remaining - manualTaken;
        if (manualTaken) {
          await tx.run('UPDATE bonus_group_point_balances SET points = points - ?, updated_at = ? WHERE guild_id = ? AND group_id = ?',
            [manualTaken, Date.now(), String(guildId), Number(groupId)]);
        }
        for (const member of members) {
          if (pending <= 0) break;
          const balance = Number(member.points) || 0;
          const taken = Math.min(balance, pending);
          await tx.run('UPDATE bonus_balances SET points = points - ?, updated_at = ? WHERE guild_id = ? AND user_id = ? AND group_id = ?',
            [taken, Date.now(), String(guildId), String(member.user_id), Number(groupId)]);
          if (deductionPreview.length < 25) deductionPreview.push({ userId: String(member.user_id), points: taken });
          deductionCount += 1;
          memberDelta -= taken;
          pending -= taken;
        }
        actualDelta = -(manualTaken + Math.abs(memberDelta));
        after = before + actualDelta;
      }
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null, safeDelta > 0 ? 'manual_group_points_add' : 'manual_group_points_remove',
        Number(groupId), Number(groupId), JSON.stringify({ requested: Math.abs(safeDelta), actual: Math.abs(actualDelta), before, after,
          manualDelta, memberDelta, deductedMembers: deductionCount, deductionPreview }), Date.now()]);
      return { before, after, delta: actualDelta, manualDelta, memberDelta, deductedMembers: deductionCount, deductions: deductionPreview };
    }, 'bonus-manual-group-points');
  }

  async function resetGroup(guildId, groupId, actorId) {
    return dbManager.transaction(async tx => {
      const rows = await tx.all('SELECT user_id, points, message_progress, voice_progress_ms FROM bonus_balances WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      const totals = rows.reduce((acc, row) => ({
        members: acc.members + 1,
        points: acc.points + Number(row.points || 0),
        messageProgress: acc.messageProgress + Number(row.message_progress || 0),
        voiceProgressMs: acc.voiceProgressMs + Number(row.voice_progress_ms || 0)
      }), { members: 0, points: 0, messageProgress: 0, voiceProgressMs: 0 });
      const manual = await tx.get('SELECT points FROM bonus_group_point_balances WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      totals.manualPoints = Number(manual?.points) || 0;
      totals.points += totals.manualPoints;
      await tx.run(`UPDATE bonus_balances SET points = 0, message_progress = 0, voice_progress_ms = 0, updated_at = ? WHERE guild_id = ? AND group_id = ?`, [Date.now(), String(guildId), Number(groupId)]);
      await tx.run('UPDATE bonus_group_point_balances SET points = 0, updated_at = ? WHERE guild_id = ? AND group_id = ?', [Date.now(), String(guildId), Number(groupId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, target_group_id, details_json, created_at)
        VALUES (?, ?, 'group_reset', ?, ?, ?, ?)
      `, [String(guildId), String(actorId), Number(groupId), Number(groupId), JSON.stringify(totals), Date.now()]);
      return totals;
    }, 'bonus-reset-group');
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
    const current = await dbManager.get('SELECT * FROM bonus_groups WHERE guild_id = ? AND id = ?', [String(guildId), Number(groupId)]);
    if (!current) throw new Error('GROUP_NOT_FOUND');
    const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    await dbManager.run(`UPDATE bonus_groups SET ${setSql} WHERE guild_id = ? AND id = ?`, [...values, String(guildId), Number(groupId)]);
    await audit(guildId, actorId, entries.some(([key]) => key === 'owner_id') ? 'owner_change' : 'group_update', null,
      Number(groupId), Number(groupId), Object.fromEntries(entries));
    return dbManager.get('SELECT * FROM bonus_groups WHERE guild_id = ? AND id = ?', [String(guildId), Number(groupId)]);
  }

  async function archiveGroup(guildId, groupId, actorId) {
    return dbManager.transaction(async tx => {
      const now = Date.now();
      const result = await tx.run('UPDATE bonus_groups SET archived_at = ? WHERE guild_id = ? AND id = ? AND archived_at IS NULL',
        [now, String(guildId), Number(groupId)]);
      if (!result.changes) return false;
      const members = await tx.all('SELECT user_id, points, message_progress, voice_progress_ms FROM bonus_balances WHERE guild_id = ? AND group_id = ?',
        [String(guildId), Number(groupId)]);
      await tx.run('UPDATE bonus_balances SET group_id = NULL, updated_at = ? WHERE guild_id = ? AND group_id = ?',
        [now, String(guildId), Number(groupId)]);
      await tx.run('UPDATE bonus_multipliers SET active = 0 WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(groupId)]);
      await tx.run(`
        INSERT INTO bonus_audit_log (guild_id, actor_id, action, source_group_id, details_json, created_at)
        VALUES (?, ?, 'group_archive', ?, ?, ?)
      `, [String(guildId), actorId ? String(actorId) : null, Number(groupId), JSON.stringify({ unassignedMembers: members.length,
        carriedPoints: members.reduce((sum, member) => sum + Number(member.points || 0), 0) }), now]);
      return true;
    }, 'bonus-archive-group');
  }

  async function getLeaderboard(guildId, limit = 10) {
    return dbManager.all(`
      SELECT g.id, g.role_id, g.owner_id, g.avatar_url, g.created_at,
        COALESCE(SUM(b.points), 0) + COALESCE(MAX(gp.points), 0) AS points,
        COUNT(DISTINCT CASE WHEN b.points > 0 THEN b.user_id END) AS contributors
      FROM bonus_groups g
      LEFT JOIN bonus_balances b ON b.guild_id = g.guild_id AND b.group_id = g.id
      LEFT JOIN bonus_group_point_balances gp ON gp.guild_id = g.guild_id AND gp.group_id = g.id
      WHERE g.guild_id = ? AND g.archived_at IS NULL
      GROUP BY g.id
      ORDER BY points DESC, g.created_at ASC, g.id ASC
      LIMIT ?
    `, [String(guildId), Math.max(1, Math.min(25, Number(limit) || 10))]);
  }

  async function getLeaderboardSummary(guildId) {
    return dbManager.get(`
      SELECT COUNT(*) AS groups, COALESCE(SUM(points), 0) AS points FROM (
        SELECT g.id, COALESCE(SUM(b.points), 0) + COALESCE(MAX(gp.points), 0) AS points
        FROM bonus_groups g
        LEFT JOIN bonus_balances b ON b.guild_id = g.guild_id AND b.group_id = g.id
        LEFT JOIN bonus_group_point_balances gp ON gp.guild_id = g.guild_id AND gp.group_id = g.id
        WHERE g.guild_id = ? AND g.archived_at IS NULL
        GROUP BY g.id
      )
    `, [String(guildId)]);
  }

  async function getBalance(guildId, userId) {
    return dbManager.get('SELECT * FROM bonus_balances WHERE guild_id = ? AND user_id = ?', [String(guildId), String(userId)]);
  }

  async function isReady(guildId) {
    const [config, groups, rules] = await Promise.all([readConfig(guildId), listGroups(guildId), getRules(guildId)]);
    return Boolean(config.channelId && config.topMessageId && groups.length > 0 && Object.keys(rules).length > 0);
  }

  return {
    readConfig, saveConfig, audit, listGroups, getRules, setRule, disableRule, addGroup, resolveTargetGroup,
    syncAssignment, addActivity, setMultiplier, clearMultiplier, listActiveUserMultipliers, getActiveGroupMultiplier,
    adjustGroupPoints, resetGroup, resetUser, updateGroup, archiveGroup, getLeaderboard, getLeaderboardSummary, getBalance, isReady
  };
}

module.exports = { createBonusManager, calculateAward, chooseOldestGroup, BONUS_METRICS };
