const { PermissionFlagsBits } = require('discord.js');
const colorManager = require('../utils/colorManager');

function sanitizeName(input, fallback = 'sticker') {
  const cleaned = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return cleaned || fallback;
}

function extractEmojiMentions(text = '') {
  return [...String(text).matchAll(/<a?:([a-zA-Z0-9_]{2,32}):(\d{15,22})>/g)].map((m) => ({ name: m[1], id: m[2], animated: m[0].startsWith('<a:') }));
}

function extractUrls(text = '') {
  return [...String(text).matchAll(/https?:\/\/[^\s<>]+/g)].map((m) => m[0]);
}

async function fetchBuffer(url) {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

module.exports = {
  name: 'addsticker',
  aliases: ['اضافةستيكر'],

  async execute(message) {
    const me = message.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions) || !message.member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
      await message.reply('**❌ يلزم صلاحية Manage Expressions لك وللبوت.**');
      return;
    }

    await message.reply('**ارسل الآن صور أو ستيكرات أو إيموجيات (منشن/رابط) لإضافتها كستيكرات.**\n**يمكنك إرسال عدة عناصر في رسالة واحدة خلال 60 ثانية.**');

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
      sources.push({ name: att.name || `sticker_${sources.length + 1}`, url: att.url });
    }

    for (const st of inputMsg.stickers.values()) {
      if (st.url) sources.push({ name: st.name || `sticker_${sources.length + 1}`, url: st.url });
    }

    for (const em of extractEmojiMentions(inputMsg.content)) {
      const ext = em.animated ? 'gif' : 'png';
      sources.push({ name: em.name, url: `https://cdn.discordapp.com/emojis/${em.id}.${ext}?size=4096&quality=lossless` });
    }

    for (const url of extractUrls(inputMsg.content)) {
      sources.push({ name: `sticker_${sources.length + 1}`, url });
    }

    if (sources.length === 0) {
      await message.reply('**❌ لم يتم العثور على مصادر صالحة.**');
      return;
    }

    const limit = message.guild.stickerLimit || 60;
    let current = message.guild.stickers.cache.size;

    let added = 0;
    let failed = 0;
    const addedNames = [];

    for (let i = 0; i < sources.length; i += 1) {
      if (current >= limit) {
        failed += (sources.length - i);
        break;
      }

      const src = sources[i];
      const buffer = await fetchBuffer(src.url);
      if (!buffer) {
        failed += 1;
        continue;
      }

      try {
        const sticker = await message.guild.stickers.create({
          file: buffer,
          name: sanitizeName(src.name, `sticker_${i + 1}`),
          tags: '🙂',
          description: 'Added by addsticker command'
        });
        added += 1;
        current += 1;
        addedNames.push(sticker.name);
      } catch {
        failed += 1;
      }
    }

    const embed = colorManager.createEmbed()
      .setTitle('Add Sticker')
      .setDescription(
        `**المطلوب :** ${sources.length}\n` +
        `**تمت الإضافة :** ${added}\n` +
        `**فشل :** ${failed}\n` +
        `**الستيكرات :** ${addedNames.length ? addedNames.map((n) => `\`${n}\``).join(' ، ') : '**لا يوجد**'}`
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  }
};
