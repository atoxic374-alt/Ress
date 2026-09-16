const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function normalizeDiscordId(value) {
  if (value === null || value === undefined) return null;

  const raw = typeof value === 'object'
    ? (value.id ?? value.userId ?? value.user_id ?? value.memberId)
    : value;
  if (raw === null || raw === undefined) return null;

  const text = String(raw).trim();
  const mention = text.match(/^<@!?(\d{17,20})>$/);
  const id = mention ? mention[1] : text;
  return DISCORD_ID_PATTERN.test(id) ? id : null;
}

function userMention(value) {
  const id = normalizeDiscordId(value);
  return id ? `<@${id}>` : null;
}

function roleMention(value) {
  const id = normalizeDiscordId(value);
  return id ? `<@&${id}>` : null;
}

const allowedMentions = {
  parse: ['users', 'roles'],
  repliedUser: false
};

function normalizeMentionableIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeDiscordId).filter(Boolean))];
}

module.exports = {
  normalizeDiscordId,
  normalizeMentionableIds,
  userMention,
  roleMention,
  allowedMentions
};
