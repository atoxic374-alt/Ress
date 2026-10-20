const { createCanvas, loadImage } = require('canvas');
const { AttachmentBuilder } = require('discord.js');

const avatarCache = new Map();
const FALLBACK_NAME = 'Unknown member';

function roundRect(ctx, x, y, w, h, r, fill, stroke = null) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}
function hex(value, fallback = '#5865F2') { return /^#[\da-f]{6}$/i.test(String(value || '')) ? String(value) : fallback; }
function rgb(color) { const n = parseInt(hex(color).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return Array.from(value.values());
  if (typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') return Array.from(value);
  return [value];
}
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function memberId(member, fallback = '') { return String(member?.id ?? member?.user?.id ?? fallback ?? ''); }
function memberName(member, fallback = '') {
  const name = member?.displayName || member?.nickname || member?.user?.globalName || member?.user?.username || member?.username || member?.name || fallback;
  return String(name || FALLBACK_NAME);
}
function safeUrl(value, owner = null) {
  try { return typeof value === 'function' ? value.call(owner, { extension: 'png', size: 128 }) : value || null; } catch { return null; }
}
function avatarUrl(member) {
  return safeUrl(member?.displayAvatarURL, member) || safeUrl(member?.user?.displayAvatarURL, member?.user) || safeUrl(member?.avatarURL, member) || safeUrl(member?.user?.avatarURL, member?.user) || member?.avatar || member?.user?.avatar || null;
}
function iconUrl(guild) { return safeUrl(guild?.iconURL, guild); }
async function image(url) {
  if (!url) return null;
  if (!avatarCache.has(url)) avatarCache.set(url, Promise.resolve(loadImage(url)).catch(() => null));
  return avatarCache.get(url);
}
function avatarInitial(value) { return Array.from(String(value || '?').trim())[0] || '?'; }
function avatar(ctx, img, x, y, radius, ring = '#5865F2', label = '?') {
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.clip();
  if (img) ctx.drawImage(img, x - radius, y - radius, radius * 2, radius * 2);
  else { ctx.fillStyle = '#303746'; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2); ctx.fillStyle = '#DDE5F2'; ctx.font = `bold ${Math.max(18, Math.round(radius * .72))}px Cairo, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(avatarInitial(label), x, y); ctx.textBaseline = 'alphabetic'; }
  ctx.restore(); ctx.beginPath(); ctx.arc(x, y, radius + 3, 0, Math.PI * 2); ctx.strokeStyle = ring; ctx.lineWidth = 3; ctx.stroke();
}
function text(ctx, value, x, y, maxWidth) {
  let s = String(value ?? '—').trim() || '—';
  if (maxWidth > 0) { const chars = Array.from(s); while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop(); if (chars.length < Array.from(s).length) s = `${chars.join('')}…`; }
  ctx.fillText(s, x, y); return s;
}
function sortKey(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ar'); }
function compareRows(a, b) {
  return number(b.points) - number(a.points) || number(b.messages) - number(a.messages) || sortKey(a.name).localeCompare(sortKey(b.name), 'ar', { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
}
function normalizeRows(members) {
  return asArray(members).map((item, index) => {
    const member = item?.member || (item?.user_id || item?.points !== undefined || item?.messages !== undefined ? null : item);
    const id = String(item?.user_id ?? item?.userId ?? memberId(member, item?.id ?? `unknown-${index}`));
    return { ...item, id, member, name: memberName(member, item?.displayName || item?.username || item?.name || id || FALLBACK_NAME), points: number(item?.points), messages: number(item?.messages), reactions: number(item?.reactions), voice_ms: number(item?.voice_ms) };
  }).sort(compareRows);
}
async function resolveMember(guild, candidate) {
  if (!candidate) return null;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') return candidate;
  const id = String(candidate);
  const cached = guild?.members?.cache?.get?.(id);
  if (cached) return cached;
  try { const fetched = guild?.members?.fetch?.(id); return fetched && typeof fetched.then === 'function' ? await fetched.catch(() => null) : fetched || null; } catch { return null; }
}
async function resolveMembers(guild, candidates) {
  const result = []; const seen = new Set();
  for (const candidate of asArray(candidates)) { const member = await resolveMember(guild, candidate); const id = memberId(member, typeof candidate === 'string' || typeof candidate === 'number' ? candidate : ''); if (!id || seen.has(id)) continue; seen.add(id); result.push(member || { id }); }
  return result;
}
async function renderMembers({ guild, group, members, accentColor = '#5865F2' }) {
  const W = 1500, H = 980, accent = hex(accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); ctx.direction = 'rtl';
  const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0D1119'); bg.addColorStop(.55, '#171D2A'); bg.addColorStop(1, '#0B0F16'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); const [r, g, b] = rgb(accent); const glow = ctx.createRadialGradient(W * .78, 0, 10, W * .78, 0, 620); glow.addColorStop(0, `rgba(${r},${g},${b},.24)`); glow.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 32, 30, W - 64, H - 60, 28, 'rgba(17,22,32,.92)', `rgba(${r},${g},${b},.55)`); const guildImg = await image(iconUrl(guild)); avatar(ctx, guildImg, 1375, 112, 54, accent, guild?.name || 'G'); ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 44px Cairo, sans-serif'; text(ctx, 'Group Members', 1295, 78, 920); ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif'; text(ctx, `${group?.name || 'Group'}  •  Top Contributors`, 1295, 122, 920);
  const rowsWithMembers = await Promise.all(asArray(members).map(async item => { const isMetricRow = item && (item.member !== undefined || item.user_id !== undefined || item.userId !== undefined || item.points !== undefined || item.messages !== undefined); if (!isMetricRow || item.member) return item; const resolved = await resolveMember(guild, item.user_id ?? item.userId ?? item.id); return resolved ? { ...item, member: resolved } : item; })); const sorted = normalizeRows(rowsWithMembers).slice(0, 10); const medals = ['#F2C94C', '#D7E1EA', '#CD8A5A']; const podium = [{ x: 430, rank: 2, h: 230 }, { x: 750, rank: 1, h: 320 }, { x: 1070, rank: 3, h: 190 }];
  const podiumImages = await Promise.all(podium.map(p => image(avatarUrl(sorted[p.rank - 1]?.member)))); roundRect(ctx, 62, 180, 1160, 420, 24, 'rgba(255,255,255,.035)', 'rgba(255,255,255,.08)');
  for (let index = 0; index < podium.length; index += 1) { const p = podium[index], row = sorted[p.rank - 1], y = 555 - p.h, col = medals[p.rank - 1]; const grad = ctx.createLinearGradient(0, y, 0, 555); grad.addColorStop(0, `${col}45`); grad.addColorStop(1, `${col}0B`); roundRect(ctx, p.x - 105, y, 210, p.h, 20, grad, `${col}95`); ctx.fillStyle = col; ctx.font = 'bold 46px Cairo, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(p.rank), p.x, y + 58); const name = row?.name || FALLBACK_NAME; avatar(ctx, podiumImages[index], p.x, y - 74, p.rank === 1 ? 58 : 48, col, name); if (row) { ctx.fillStyle = '#FFF'; ctx.font = 'bold 22px Cairo, sans-serif'; text(ctx, name, p.x, y + 112, 180); ctx.fillStyle = col; ctx.font = 'bold 20px Cairo, sans-serif'; ctx.fillText(`${number(row.points).toLocaleString()} points`, p.x, y + 150); ctx.fillStyle = '#AAB4C5'; ctx.font = '16px Cairo, sans-serif'; ctx.fillText(`${number(row.messages).toLocaleString()} messages`, p.x, y + 182); } }
  ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 22px Cairo, sans-serif'; ctx.fillText('Top 10', 1370, 194); roundRect(ctx, 1250, 220, 185, 335, 18, 'rgba(255,255,255,.035)'); for (let i = 3; i < 10; i += 1) { const row = sorted[i], y = 252 + (i - 3) * 42; ctx.fillStyle = i % 2 ? '#C2CAD7' : '#FFF'; ctx.font = 'bold 17px Cairo, sans-serif'; text(ctx, `${String(i + 1).padStart(2, '0')}  ${row?.name || '—'}`, 1400, y, 122); ctx.fillStyle = accent; ctx.textAlign = 'left'; ctx.fillText(row ? number(row.points).toLocaleString() : '—', 1270, y); ctx.textAlign = 'right'; }
  const memberCount = Array.isArray(group?.memberIds) ? group.memberIds.length : sorted.length; ctx.fillStyle = '#FFF'; ctx.font = 'bold 20px Cairo, sans-serif'; ctx.fillText(`Members: ${memberCount}`, 1360, 625); ctx.fillStyle = '#AAB4C5'; ctx.font = '17px Cairo, sans-serif'; ctx.fillText(`Updated: ${group?.updated_at ? new Date(group.updated_at).toLocaleString('en-GB') : '—'}`, 1360, 658); return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `group-members-${group?.id || 'view'}.png` });
}
async function renderInfo({ guild, group, owner, managers, accentColor = '#5865F2' }) {
  const [resolvedOwner, resolvedManagers] = await Promise.all([resolveMember(guild, owner), resolveMembers(guild, [...asArray(managers), ...asArray(group?.managerIds)])]); const W = 1400, H = 760, accent = hex(accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); ctx.direction = 'rtl'; const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0C111A'); bg.addColorStop(1, '#1B2331'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); const [r, g, b] = rgb(accent); roundRect(ctx, 28, 28, W - 56, H - 56, 30, 'rgba(17,22,32,.95)', `rgba(${r},${g},${b},.65)`); const icon = await image(iconUrl(guild)); avatar(ctx, icon, 1240, 112, 56, accent, group?.name || 'G'); ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 44px Cairo, sans-serif'; text(ctx, 'My Group', 1148, 95, 900); ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif'; text(ctx, group?.name || 'Group', 1148, 135, 900);
  const managerNames = resolvedManagers.map(manager => memberName(manager, memberId(manager))).filter(Boolean); const managerValue = managerNames.length ? `${managerNames.slice(0, 3).join('، ')}${managerNames.length > 3 ? ` +${managerNames.length - 3}` : ''}` : 'None found'; const ownerName = resolvedOwner ? `@${memberName(resolvedOwner)}` : 'Not found'; const memberCount = Array.isArray(group?.memberIds) ? group.memberIds.length : number(group?.memberCount); const fields = [['Owner', ownerName], ['Managers', managerValue], ['Members', String(memberCount)], ['Points', number(group?.points).toLocaleString()], ['Status', group?.status || 'active'], ['Role', group?.role_id ? `<@&${group.role_id}>` : 'Not set']]; let y = 240;
  for (const [label, value] of fields) { roundRect(ctx, 90, y, 1220, 62, 14, 'rgba(255,255,255,.045)'); ctx.fillStyle = accent; ctx.font = 'bold 19px Cairo, sans-serif'; ctx.textAlign = 'right'; ctx.fillText(label, 1250, y + 32); ctx.fillStyle = '#F4F6FA'; ctx.font = '20px Cairo, sans-serif'; ctx.textAlign = 'left'; text(ctx, value, 125, y + 32, 1040); y += 78; }
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `group-info-${group?.id || 'view'}.png` });
}
module.exports = { renderMembers, renderInfo };
