const colorManager = require('../utils/colorManager.js');
const { memberIsAdmin } = require('./store.js');

const name = 'clear';
const aliases = ['مسح'];

const MAX_BULK = 100;
const MAX_SCAN = 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function parseAmount(args) {
  const firstNumeric = args.find((arg) => /^\d+$/.test(arg));
  const parsed = Number(firstNumeric);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, MAX_BULK);
}

function extractTargetUser(message, args) {
  if (message.mentions.users.size > 0) {
    return message.mentions.users.first();
  }

  const idArg = args.find((arg) => /^\d{17,20}$/.test(arg));
  if (idArg) {
    return message.client.users.fetch(idArg).catch(() => null);
  }

  if (message.reference?.messageId) {
    return message.channel.messages.fetch(message.reference.messageId)
      .then((msg) => msg.author)
      .catch(() => null);
  }

  return null;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function collectTargetMessages(channel, targetId, limit) {
  const selected = [];
  let before;
  let scanned = 0;

  while (selected.length < limit && scanned < MAX_SCAN) {
    const batchSize = Math.min(100, MAX_SCAN - scanned);
    const batch = await channel.messages.fetch({ limit: batchSize, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const now = Date.now();
    for (const msg of batch.values()) {
      if (now - msg.createdTimestamp > FOURTEEN_DAYS_MS) continue;
      if (msg.author?.id === targetId) {
        selected.push(msg);
        if (selected.length >= limit) break;
      }
    }

    scanned += batch.size;
    before = batch.last()?.id;
    if (!before) break;
  }

  return selected;
}

function buildResultEmbed({ deletedCount, deletedUser, executor }) {
  const avatarUser = deletedUser || executor;
  const footerName = deletedUser?.displayName || deletedUser?.username || executor.displayName || executor.username;

  return colorManager.createEmbed()
    .setDescription(`**${deletedCount}messages has been deleted By <@${executor.id}>**`)
    .setThumbnail(avatarUser.displayAvatarURL({ extension: 'png', size: 256 }))
    .setFooter({ text: footerName });
}

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!memberIsAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌').catch(() => {});
    return;
  }

  const amount = parseAmount(args);
  const rawTarget = await extractTargetUser(message, args);
  const deletedUser = rawTarget ? await message.guild.members.fetch(rawTarget.id).catch(() => rawTarget) : null;

  let deletedCount = 0;

  if (deletedUser) {
    const targetMessages = await collectTargetMessages(message.channel, deletedUser.id, amount);

    if (targetMessages.length > 0) {
      const chunks = chunkArray(targetMessages.map((m) => m.id), 100);
      const results = await Promise.all(
        chunks.map((ids) => message.channel.bulkDelete(ids, true).catch(() => null))
      );
      deletedCount = results.reduce((sum, col) => sum + (col?.size || 0), 0);
    }
  } else {
    const deleted = await message.channel.bulkDelete(amount + 1, true).catch(() => null);
    deletedCount = Math.max((deleted?.size || 0) - 1, 0);
  }

  if (deletedCount <= 0) {
    const noMessages = await message.channel.send({ content: 'لا يوجد رسائل.' }).catch(() => null);
    if (noMessages) {
      setTimeout(() => noMessages.delete().catch(() => {}), 3000);
    }
    return;
  }

  const reply = await message.channel.send({
    embeds: [
      buildResultEmbed({
        deletedCount,
        deletedUser,
        executor: message.member || message.author
      })
    ]
  }).catch(() => null);

  if (reply) {
    setTimeout(() => reply.delete().catch(() => {}), 3000);
  }
}

module.exports = {
  name,
  aliases,
  execute
};
