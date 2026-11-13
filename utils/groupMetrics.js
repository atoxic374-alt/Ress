'use strict';

function safeCount(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) && fallbackNumber >= 0 ? Math.floor(fallbackNumber) : 0;
}

function getGroupMemberCount(group, fallback = 0) {
  if (!group || typeof group !== 'object') return safeCount(fallback);

  const memberList = Array.isArray(group.memberIds)
    ? group.memberIds
    : Array.isArray(group.member_ids) ? group.member_ids : null;
  const managerList = Array.isArray(group.managerIds)
    ? group.managerIds
    : Array.isArray(group.manager_ids) ? group.manager_ids : null;
  const ownerId = group.owner_id ?? group.ownerId;
  const hasOwnerId = ownerId !== undefined && ownerId !== null && String(ownerId).trim() !== '';

  // Membership lists are authoritative when present, including when empty.
  if (memberList || managerList || hasOwnerId) {
    const ids = [
      ...(hasOwnerId ? [ownerId] : []),
      ...(memberList || []),
      ...(managerList || [])
    ].map(id => String(id ?? '').trim()).filter(Boolean);
    return new Set(ids).size;
  }

  return safeCount(group.memberCount ?? group.member_count, fallback);
}

module.exports = { getGroupMemberCount };
