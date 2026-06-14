const fs = require('fs');
const path = require('path');
const axios = require('axios');
const colorManager = require('../utils/colorManager');
const { ensureCairoFontsRegistered, getCairoFontStatus } = require('../utils/cairoFont');

const name = 'cairo';
const aliases = ['خط', 'خط-كايرو'];
const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const REGULAR_FONT_PATH = path.join(FONTS_DIR, 'Cairo-Regular.ttf');
const BOLD_FONT_PATH = path.join(FONTS_DIR, 'Cairo-Bold.ttf');
const MAX_FONT_BYTES = 8 * 1024 * 1024;

function extractUrls(text = '') {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>]+/g)].map(match => match[0]);
}

function isFontBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const signature = buffer.subarray(0, 4);
  return (
    signature.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) ||
    signature.toString('ascii') === 'OTTO' ||
    signature.toString('ascii') === 'true' ||
    signature.toString('ascii') === 'ttcf'
  );
}

function detectWeight(source = {}, fallbackIndex = 0) {
  const label = `${source.name || ''} ${source.url || ''}`.toLowerCase();
  if (/bold|black|heavy|extrabold|semi.?bold|700|800|900|سميك|عريض/.test(label)) return 'bold';
  if (/regular|normal|book|400|عادي/.test(label)) return 'regular';
  return fallbackIndex === 0 ? 'regular' : 'bold';
}

async function fetchFontBuffer(source) {
  const response = await axios.get(source.url, {
    responseType: 'arraybuffer',
    maxContentLength: MAX_FONT_BYTES,
    maxBodyLength: MAX_FONT_BYTES,
    timeout: 20000,
    validateStatus: status => status >= 200 && status < 300
  });
  return Buffer.from(response.data);
}

function collectSources(message, args) {
  const sources = [];

  for (const attachment of message.attachments.values()) {
    sources.push({
      name: attachment.name || `font_${sources.length + 1}`,
      url: attachment.url
    });
  }

  for (const url of extractUrls(args.join(' '))) {
    sources.push({
      name: path.basename(url.split('?')[0]) || `font_${sources.length + 1}`,
      url
    });
  }

  return sources.slice(0, 2);
}

function formatStatus(status) {
  return [
    `**المجلد :** \`${status.fontsDir}\``,
    `**Regular :** ${status.hasRegular ? '✅ موجود' : '❌ غير موجود'} \`${status.regularPath}\``,
    `**Bold :** ${status.hasBold ? '✅ موجود' : '❌ غير موجود'} \`${status.boldPath}\``,
    `**جاهز للأوامر :** ${status.ready ? '✅ نعم' : '❌ لا'}`
  ].join('\n');
}

module.exports = {
  name,
  aliases,

  async execute(message, args = []) {
    if (args[0]?.toLowerCase() === 'status') {
      const status = getCairoFontStatus();
      const embed = colorManager.createEmbed()
        .setTitle('Cairo Font Status')
        .setDescription(formatStatus(status))
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    const sources = collectSources(message, args);
    if (sources.length !== 2) {
      const status = getCairoFontStatus();
      await message.reply(
        '**ارفق ملفين خط أو حط رابطين:** `Cairo-Regular.ttf` و `Cairo-Bold.ttf`\n' +
        '**مثال:** `.cairo` مع مرفقين، أو `.cairo رابط_Regular رابط_Bold`\n\n' +
        formatStatus(status)
      );
      return;
    }

    await fs.promises.mkdir(FONTS_DIR, { recursive: true });

    const saved = { regular: null, bold: null };
    const usedWeights = new Set();

    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      const buffer = await fetchFontBuffer(source);
      if (!isFontBuffer(buffer)) {
        await message.reply(`**❌ الملف رقم ${i + 1} ليس ملف خط صالح TTF/OTF.**`);
        return;
      }

      let weight = detectWeight(source, i);
      if (usedWeights.has(weight)) weight = weight === 'regular' ? 'bold' : 'regular';
      usedWeights.add(weight);

      const targetPath = weight === 'bold' ? BOLD_FONT_PATH : REGULAR_FONT_PATH;
      await fs.promises.writeFile(targetPath, buffer);
      saved[weight] = path.basename(targetPath);
    }

    ensureCairoFontsRegistered({ force: true });
    const status = getCairoFontStatus();

    const embed = colorManager.createEmbed()
      .setTitle('Cairo Font Updated')
      .setDescription(
        `**✅ تم إنشاء/تجهيز المجلد:** \`assets/fonts\`\n` +
        `**✅ تم حفظ:** \`${saved.regular || 'Cairo-Regular.ttf'}\`\n` +
        `**✅ تم حفظ:** \`${saved.bold || 'Cairo-Bold.ttf'}\`\n` +
        `**✅ تم إعادة تسجيل الخط لعائلة:** \`Cairo\`\n\n` +
        formatStatus(status) +
        '\n\n**الأوامر التي تستخدم Cairo مثل profile و setroom/review و temp ستقرأ نفس عائلة الخط.**'
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  }
};
