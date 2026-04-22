const { PermissionFlagsBits } = require('discord.js');
const colorManager = require('../utils/colorManager');

function sanitizeName(input, fallback = 'emoji') {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return (cleaned || fallback).slice(0, 32);
}

function extractUrls(text = '') {
  return [...String(text).matchAll(/https?:\/\/[^\s<>]+/g)].map((m) => m[0]);
}

async function fetchBuffer(url) {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, type };
}

module.exports = {
  name: 'addemoji',
  aliases: ['ايموجياضافة'],

  async execute(message) {
    const me = message.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions) || !message.member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
      await message.reply('**❌ يلزم صلاحية Manage Expressions لك وللبوت.**');
      return;
    }

    await message.reply('**ارسل الآن الصور أو الروابط لإضافة الإيموجي.**\n**يمكنك إرسال عدة مرفقات/روابط في رسالة واحدة خلال 60 ثانية.**');

    const collected = await message.channel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: 60000
    }).catch(() => null);

    const inputMsg = collected?.first();
    if (!inputMsg) {
      await message.reply('**❌ انتهت المهلة.**');
      return;
    }

    const sources = [];
    for (const [_, att] of inputMsg.attachments) {
      sources.push({ name: att.name || `emoji_${sources.length + 1}`, url: att.url });
    }
    for (const url of extractUrls(inputMsg.content)) {
      sources.push({ name: `emoji_${sources.length + 1}`, url });
    }

    if (sources.length === 0) {
      await message.reply('**❌ لم يتم العثور على صور أو روابط صالحة.**');
      return;
    }

    let staticCount = message.guild.emojis.cache.filter((e) => !e.animated).size;
    let animatedCount = message.guild.emojis.cache.filter((e) => e.animated).size;
    const limit = message.guild.emojiLimit || 50;

    let added = 0;
    let failed = 0;
    const addedMentions = [];

    for (let i = 0; i < sources.length; i += 1) {
      const src = sources[i];
      const data = await fetchBuffer(src.url);
      if (!data) {
        failed += 1;
        continue;
      }

      const isGif = data.type.includes('gif') || /\.gif(\?|$)/i.test(src.url);
      if ((!isGif && staticCount >= limit) || (isGif && animatedCount >= limit)) {
        failed += 1;
        continue;
      }

      try {
        const emoji = await message.guild.emojis.create({
          attachment: data.buffer,
          name: sanitizeName(src.name, `emoji_${i + 1}`)
        });
        if (emoji.animated) animatedCount += 1;
        else staticCount += 1;
        added += 1;
        addedMentions.push(`${emoji}`);
      } catch {
        failed += 1;
      }
    }

    const embed = colorManager.createEmbed()
      .setTitle('Add Emoji')
      .setDescription(
        `**المطلوب :** ${sources.length}\n` +
        `**تمت الإضافة :** ${added}\n` +
        `**فشل :** ${failed}\n` +
        `**الإيموجيات :** ${addedMentions.length ? addedMentions.join(' ') : '**لا يوجد**'}`
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  }
};
