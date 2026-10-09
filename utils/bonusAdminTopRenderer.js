const { createCanvas, loadImage } = require('canvas');
const { AttachmentBuilder } = require('discord.js');
const { ensureCairoFontsRegistered } = require('./cairoFont');
const { findDominantColor, normalizeHex } = require('./bonusTopRenderer');

ensureCairoFontsRegistered();
const WIDTH = 1600;
const HEIGHT = 900;
const DEFAULT_COLOR = '#D9A441';

function safeText(value, fallback = '—', max = 64) {
  return String(value || fallback).replace(/[\u0000-\u001f]/g, '').slice(0, max);
}
function formatPoints(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}
function roundedRect(ctx, x, y, width, height, radius, fill, stroke = null) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}
function drawAvatar(ctx, image, x, y, radius, accent) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  if (image) ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
  else {
    ctx.fillStyle = '#343B49';
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 26px Cairo, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y);
  }
  ctx.restore();
}
async function buildBonusAdminTopImage({ guild, members = [], config = {}, updatedAt = Date.now() }) {
  const accent = config.colorAuto === false
    ? normalizeHex(config.color, DEFAULT_COLOR)
    : await findDominantColor(guild?.iconURL?.({ extension: 'png', size: 256 }));
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';
  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bg.addColorStop(0, '#10131B');
  bg.addColorStop(0.55, '#1A1E29');
  bg.addColorStop(1, '#10131A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  roundedRect(ctx, 26, 24, WIDTH - 52, HEIGHT - 48, 32, 'rgba(18,22,31,0.94)', `${accent}99`);
  roundedRect(ctx, 54, 53, 8, 88, 4, accent);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 46px Cairo, sans-serif';
  ctx.fillText('توب الإدارة', 1500, 82);
  ctx.fillStyle = '#AEB6C5';
  ctx.font = '23px Cairo, sans-serif';
  ctx.fillText(`${safeText(guild?.name, 'السيرفر', 52)} • ترتيب نقاط الأعضاء`, 1500, 128);
  ctx.textAlign = 'left';
  ctx.fillStyle = accent;
  ctx.font = 'bold 21px Cairo, sans-serif';
  ctx.fillText('TOP MEMBERS', 78, 92);
  ctx.fillStyle = '#858D9B';
  ctx.font = '16px Cairo, sans-serif';
  ctx.fillText(`UPDATED ${new Date(Number(updatedAt) || Date.now()).toLocaleString('en-GB')}`, 78, 126);

  const medalColors = ['#F1C75B', '#D4DCE7', '#CE9164'];
  const top = Array.from(members || []).slice(0, 10);
  for (let index = 0; index < 10; index += 1) {
    const member = top[index];
    const y = 174 + index * 68;
    const accentRow = index < 3 ? medalColors[index] : accent;
    roundedRect(ctx, 62, y, WIDTH - 124, 62, 15,
      index < 3 ? 'rgba(255,255,255,0.065)' : (index % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.045)'),
      index < 3 ? 'rgba(255,255,255,0.12)' : null);
    ctx.textAlign = 'center';
    ctx.fillStyle = accentRow;
    ctx.font = 'bold 22px Cairo, sans-serif';
    ctx.fillText(String(index + 1).padStart(2, '0'), 1482, y + 31);
    let avatar = null;
    if (member?.avatar_url) avatar = await loadImage(member.avatar_url).catch(() => null);
    drawAvatar(ctx, avatar, 1418, y + 31, 22, accentRow);
    ctx.textAlign = 'right';
    ctx.fillStyle = member ? '#F5F6F8' : '#77808F';
    ctx.font = 'bold 20px Cairo, sans-serif';
    ctx.fillText(safeText(member?.display_name || member?.username, 'لا يوجد عضو', 44), 1368, y + 23, 950);
    ctx.fillStyle = '#969EAC';
    ctx.font = '14px Cairo, sans-serif';
    ctx.fillText(member?.username ? `@${safeText(member.username, '', 40)}` : (member ? 'عضو في السيرفر' : '—'), 1368, y + 47, 950);
    ctx.textAlign = 'left';
    ctx.fillStyle = member ? accentRow : '#596170';
    ctx.font = 'bold 21px Cairo, sans-serif';
    ctx.fillText(member ? `${formatPoints(member.points)} نقطة` : '—', 104, y + 31);
  }

  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'bonus-admin-top.png' });
}

module.exports = { buildBonusAdminTopImage };
