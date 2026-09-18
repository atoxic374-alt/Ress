function getOnlineResponsibleMentions(guild, roleIds = [], userIds = []) {
  const candidateIds = new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  const validRoleIds = new Set((roleIds || []).map((id) => String(id || '').trim()).filter(Boolean));

  // A responsibility can be represented by a role, not only by explicit users.
  // Also, discord.js may keep the presence in Guild.presences rather than on
  // the cached GuildMember, so check both stores before reporting N/A.
  if (guild?.members?.cache) {
    for (const member of guild.members.cache.values()) {
      if (member?.roles?.cache && [...validRoleIds].some((roleId) => member.roles.cache.has(roleId))) {
        candidateIds.add(String(member.id));
      }
    }
  }

  return [...candidateIds]
    .filter((userId) => {
      const member = guild?.members?.cache?.get(userId);
      const presence = member?.presence || guild?.presences?.cache?.get(userId);
      const status = presence?.status;
      return Boolean(status && status !== 'offline');
    })
    .map((userId) => `<@${userId}>`);
}

module.exports = { getOnlineResponsibleMentions };
