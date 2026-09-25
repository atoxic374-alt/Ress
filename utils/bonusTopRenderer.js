const { createCanvas, loadImage } = require('canvas');
const { AttachmentBuilder } = require('discord.js');
const { ensureCairoFontsRegistered } = require('./cairoFont');

ensureCairoFontsRegistered();
const WIDTH = 1600;
const HEIGHT = 900;
const FALLBACK_COLOR = '#D9A441';

function normalizeHex(value, fallback = FALLBACK_COLOR) {
  const match = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : fallback;
}

function roundedRect(ctx, x, y, width, height, radius, fill, stroke = null, lineWidth = 1) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

function safeText(value, fallback = '—') {
  return String(value || fallback).replace(/[\u0000-\u001f]/g, '').slice(0, 80);
}

function rgb(hex) {
  const clean = normalizeHex(hex).slice(1);
  return [0, 2, 4].map(index => parseInt(clean.slice(index, index + 2), 16));
}

function shade(hex, factor) {
  const [r, g, b] = rgb(hex).map(value => Math.max(0, Math.min(255, Math.round(value * factor))));
  return `rgb(${r}, ${g}, ${b})`;
}

async function findDominantColor(iconUrl) {
  if (!iconUrl) return FALLBACK_COLOR;
  try {
    const image = await loadImage(iconUrl);
    const sample = createCanvas(32, 32);
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 32, 32);
    const pixels = ctx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 160) continue;
      const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (max - min < 20) continue;
      r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n += 1;
    }
    if (!n) return FALLBACK_COLOR;
    const avg = [r / n, g / n, b / n].map(value => Math.max(45, Math.min(235, Math.round(value))));
    return `#${avg.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  } catch {
    return FALLBACK_COLOR;
  }
}

function fmtNumber(value) {
  try { return new Intl.NumberFormat('en-US').format(Number(value) || 0); }
  catch { return String(Number(value) || 0); }
}

function drawAvatar(ctx, image, x, y, radius, accent) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  if (image) ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
  else {
    ctx.fillStyle = '#303746';
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.fillStyle = '#B9C1D0';
    ctx.font = 'bold 30px Cairo, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('★', x, y + 11);
  }
  ctx.restore();
}

function drawMedal(ctx, rank, x, y, accent) {
  const colors = { 1: '#F7C948', 2: '#D8E0EA', 3: '#CD8B58' };
  const fill = colors[rank] || accent;
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = '#181B23';
  ctx.font = 'bold 18px Cairo, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(rank), x, y + 1);
}

async function buildBonusTopImage({ guild, groups, config = {}, updatedAt = Date.now() }) {
  const accent = config.autoColor === false ? normalizeHex(config.color) : await findDominantColor(guild?.iconURL?.({ extension: 'png', size: 256 }));
  const [ar, ag, ab] = rgb(accent);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.direction = 'rtl';
  ctx.textBaseline = 'middle';

  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bg.addColorStop(0, '#10131B');
  bg.addColorStop(0.52, '#171B25');
  bg.addColorStop(1, '#10131A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(WIDTH * 0.5, 10, 10, WIDTH * 0.5, 10, 850);
  glow.addColorStop(0, `rgba(${ar},${ag},${ab},0.19)`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  roundedRect(ctx, 26, 24, WIDTH - 52, HEIGHT - 48, 32, 'rgba(18,22,31,0.92)', `rgba(${ar},${ag},${ab},0.55)`, 2);
  ctx.fillStyle = accent;
  roundedRect(ctx, 54, 53, 8, 88, 4, accent);

  const guildIconUrl = guild?.iconURL?.({ extension: 'png', size: 256 }) || null;
  let guildIcon = null;
  if (guildIconUrl) guildIcon = await loadImage(guildIconUrl).catch(() => null);
  if (guildIcon) drawAvatar(ctx, guildIcon, 1460, 94, 47, accent);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 42px Cairo, sans-serif';
  ctx.fillText('توب القروبات', 1384, 78);
  ctx.fillStyle = '#AEB6C5';
  ctx.font = '22px Cairo, sans-serif';
  ctx.fillText(safeText(guild?.name, 'السيرفر') + '  •  أفضل 10 قروبات', 1384, 122);

  ctx.textAlign = 'right';
  ctx.fillStyle = accent;
  ctx.font = 'bold 20px Cairo, sans-serif';
  ctx.fillText('المراكز الأولى', 732, 205);
  ctx.fillText('قائمة الترتيب', 1510, 205);

  // Podium panel for ranks 1–3
  roundedRect(ctx, 54, 232, 684, 596, 24, 'rgba(255,255,255,0.035)', 'rgba(255,255,255,0.08)', 1);
  const podium = [
    { rank: 2, x: 175, base: 737, height: 205, width: 166 },
    { rank: 1, x: 396, base: 737, height: 298, width: 184 },
    { rank: 3, x: 617, base: 737, height: 165, width: 166 }
  ];
  const podiumPalette = { 1: '#F1C75B', 2: '#D4DCE7', 3: '#CE9164' };
  for (const item of podium) {
    const group = groups[item.rank - 1];
    const centerX = item.x;
    const x = centerX - item.width / 2;
    const y = item.base - item.height;
    const grad = ctx.createLinearGradient(0, y, 0, item.base);
    grad.addColorStop(0, `rgba(${rgb(podiumPalette[item.rank]).join(',')},0.28)`);
    grad.addColorStop(1, `rgba(${rgb(podiumPalette[item.rank]).join(',')},0.07)`);
    roundedRect(ctx, x, y, item.width, item.height, 18, grad, `rgba(${rgb(podiumPalette[item.rank]).join(',')},0.55)`, 2);
    const medalY = item.base - item.height - 130;
    const groupIconUrl = group?.avatar_url || guildIconUrl;
    const image = groupIconUrl ? await loadImage(groupIconUrl).catch(() => null) : guildIcon;
    drawAvatar(ctx, image, centerX, medalY + 6, item.rank === 1 ? 58 : 49, podiumPalette[item.rank]);
    drawMedal(ctx, item.rank, centerX, medalY - (item.rank === 1 ? 65 : 55), podiumPalette[item.rank]);
    if (group) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      ctx.font = item.rank === 1 ? 'bold 23px Cairo, sans-serif' : 'bold 20px Cairo, sans-serif';
      ctx.fillText(safeText(group.role_name || `قروب ${item.rank}`), centerX, medalY + 88, 178);
      ctx.fillStyle = '#AEB6C5';
      ctx.font = '15px Cairo, sans-serif';
      ctx.fillText(safeText(group.owner_name || 'المالك غير محدد'), centerX, medalY + 116, 178);
      ctx.fillStyle = podiumPalette[item.rank];
      ctx.font = 'bold 19px Cairo, sans-serif';
      ctx.fillText(`${fmtNumber(group.points)} نقطة`, centerX, medalY + 146, 178);
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#70798A';
      ctx.font = '18px Cairo, sans-serif';
      ctx.fillText('بانتظار قروب', centerX, medalY + 104);
    }
    ctx.fillStyle = podiumPalette[item.rank];
    ctx.font = 'bold 49px Cairo, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(item.rank), centerX, y + 62);
  }

  // Ranks 4–10 rows
  roundedRect(ctx, 770, 232, 776, 596, 24, 'rgba(255,255,255,0.035)', 'rgba(255,255,255,0.08)', 1);
  for (let index = 0; index < 7; index += 1) {
    const group = groups[index + 3];
    const y = 254 + index * 79;
    roundedRect(ctx, 792, y, 732, 66, 16, index % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.025)', null);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#AEB6C5';
    ctx.font = 'bold 20px Cairo, sans-serif';
    ctx.fillText(String(index + 4).padStart(2, '0'), 1480, y + 33);
    const groupIconUrl = group?.avatar_url || guildIconUrl;
    const image = groupIconUrl ? await loadImage(groupIconUrl).catch(() => null) : guildIcon;
    drawAvatar(ctx, image, 1414, y + 33, 23, accent);
    ctx.textAlign = 'right';
    ctx.fillStyle = group ? '#F5F6F8' : '#727A88';
    ctx.font = 'bold 18px Cairo, sans-serif';
    ctx.fillText(safeText(group?.role_name, '—'), 1368, y + 25, 280);
    ctx.fillStyle = '#9EA7B5';
    ctx.font = '14px Cairo, sans-serif';
    ctx.fillText(safeText(group?.owner_name, group ? 'المالك غير محدد' : 'بانتظار قروب'), 1368, y + 49, 280);
    ctx.textAlign = 'left';
    ctx.fillStyle = group ? accent : '#4A5060';
    ctx.font = 'bold 17px Cairo, sans-serif';
    ctx.fillText(group ? fmtNumber(group.points) : '—', 824, y + 33);
    if (group) {
      const maxPoints = Math.max(1, Number(groups[0]?.points) || 1);
      const progress = Math.min(1, (Number(group.points) || 0) / maxPoints);
      roundedRect(ctx, 824, y + 54, 90, 4, 2, 'rgba(255,255,255,0.09)', null);
      roundedRect(ctx, 824, y + 54, Math.max(3, 90 * progress), 4, 2, accent, null);
    }
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#7E8796';
  ctx.font = '14px Cairo, sans-serif';
  ctx.fillText('Automatic refresh every 30 seconds', 1516, 804);

  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'bonus-top.png' });
}

module.exports = { buildBonusTopImage, findDominantColor, normalizeHex, FALLBACK_COLOR };
