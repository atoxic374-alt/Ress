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
  roundRect(ctx, 32, 30, W - 64, H - 60, 28, 'rgba(17,22,32,.92)', `rgba(${r},${g},${b},.55)`); const guildImg = await image(iconUrl(guild)); avatar(ctx, guildImg, 1375, 112, 54, accent, guild?.name || 'G'); ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 44px Cairo, sans-serif'; text(ctx, 'أعضاء القروب', 1295, 78, 920); ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif'; text(ctx, `${group?.name || 'قروب'}  •  أعلى المساهمين`, 1295, 122, 920);
  const rowsWithMembers = await Promise.all(asArray(members).map(async item => { const isMetricRow = item && (item.member !== undefined || item.user_id !== undefined || item.userId !== undefined || item.points !== undefined || item.messages !== undefined); if (!isMetricRow || item.member) return item; const resolved = await resolveMember(guild, item.user_id ?? item.userId ?? item.id); return resolved ? { ...item, member: resolved } : item; })); const sorted = normalizeRows(rowsWithMembers).slice(0, 10); const medals = ['#F2C94C', '#D7E1EA', '#CD8A5A']; const podium = [{ x: 430, rank: 2, h: 230 }, { x: 750, rank: 1, h: 320 }, { x: 1070, rank: 3, h: 190 }];
  const podiumImages = await Promise.all(podium.map(p => image(avatarUrl(sorted[p.rank - 1]?.member)))); roundRect(ctx, 62, 180, 1160, 420, 24, 'rgba(255,255,255,.035)', 'rgba(255,255,255,.08)');
  for (let index = 0; index < podium.length; index += 1) { const p = podium[index], row = sorted[p.rank - 1], y = 555 - p.h, col = medals[p.rank - 1]; const grad = ctx.createLinearGradient(0, y, 0, 555); grad.addColorStop(0, `${col}45`); grad.addColorStop(1, `${col}0B`); roundRect(ctx, p.x - 105, y, 210, p.h, 20, grad, `${col}95`); ctx.fillStyle = col; ctx.font = 'bold 46px Cairo, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(p.rank), p.x, y + 58); const name = row?.name || FALLBACK_NAME; avatar(ctx, podiumImages[index], p.x, y - 74, p.rank === 1 ? 58 : 48, col, name); if (row) { ctx.fillStyle = '#FFF'; ctx.font = 'bold 22px Cairo, sans-serif'; text(ctx, name, p.x, y + 112, 180); ctx.fillStyle = col; ctx.font = 'bold 20px Cairo, sans-serif'; ctx.fillText(`${number(row.points).toLocaleString()} نقطة`, p.x, y + 150); ctx.fillStyle = '#AAB4C5'; ctx.font = '16px Cairo, sans-serif'; ctx.fillText(`${number(row.messages).toLocaleString()} رسالة`, p.x, y + 182); } }
  ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 22px Cairo, sans-serif'; ctx.fillText('أفضل 10', 1370, 194); roundRect(ctx, 1250, 220, 185, 335, 18, 'rgba(255,255,255,.035)'); for (let i = 3; i < 10; i += 1) { const row = sorted[i], y = 252 + (i - 3) * 42; ctx.fillStyle = i % 2 ? '#C2CAD7' : '#FFF'; ctx.font = 'bold 17px Cairo, sans-serif'; text(ctx, `${String(i + 1).padStart(2, '0')}  ${row?.name || '—'}`, 1400, y, 122); ctx.fillStyle = accent; ctx.textAlign = 'left'; ctx.fillText(row ? number(row.points).toLocaleString() : '—', 1270, y); ctx.textAlign = 'right'; }
  const memberCount = Array.isArray(group?.memberIds) ? group.memberIds.length : sorted.length; ctx.fillStyle = '#FFF'; ctx.font = 'bold 20px Cairo, sans-serif'; ctx.fillText(`الأعضاء : ${memberCount}`, 1360, 625); ctx.fillStyle = '#AAB4C5'; ctx.font = '17px Cairo, sans-serif'; ctx.fillText(`آخر تحديث : ${group?.updated_at ? new Date(group.updated_at).toLocaleString('en-GB') : '—'}`, 1360, 658); return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `group-members-${group?.id || 'view'}.png` });
}
async function renderInfo({ guild, group, owner, managers, accentColor = '#5865F2' }) {
  const [resolvedOwner, resolvedManagers] = await Promise.all([resolveMember(guild, owner), resolveMembers(guild, [...asArray(managers), ...asArray(group?.managerIds)])]); const W = 1400, H = 760, accent = hex(accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); ctx.direction = 'rtl'; const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0C111A'); bg.addColorStop(1, '#1B2331'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); const [r, g, b] = rgb(accent); roundRect(ctx, 28, 28, W - 56, H - 56, 30, 'rgba(17,22,32,.95)', `rgba(${r},${g},${b},.65)`); const icon = await image(iconUrl(guild)); avatar(ctx, icon, 1240, 112, 56, accent, group?.name || 'G'); ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 44px Cairo, sans-serif'; text(ctx, 'قروبي', 1148, 95, 900); ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif'; text(ctx, group?.name || 'Group', 1148, 135, 900);
  const managerNames = resolvedManagers.map(manager => memberName(manager, memberId(manager))).filter(Boolean); const managerValue = managerNames.length ? `${managerNames.slice(0, 3).join('، ')}${managerNames.length > 3 ? ` +${managerNames.length - 3}` : ''}` : 'غير موجود'; const ownerName = resolvedOwner ? `@${memberName(resolvedOwner)}` : 'غير موجود'; const memberCount = Array.isArray(group?.memberIds) ? group.memberIds.length : number(group?.memberCount); const fields = [['المالك', ownerName], ['المسؤولون', managerValue], ['الأعضاء', String(memberCount)], ['النقاط', number(group?.points).toLocaleString()], ['الحالة', group?.status || 'مفعل'], ['الرول', group?.role_id ? `<@&${group.role_id}>` : 'غير محدد']]; let y = 240;
  for (const [label, value] of fields) { roundRect(ctx, 90, y, 1220, 62, 14, 'rgba(255,255,255,.045)'); ctx.fillStyle = accent; ctx.font = 'bold 19px Cairo, sans-serif'; ctx.textAlign = 'right'; ctx.fillText(label, 1250, y + 32); ctx.fillStyle = '#F4F6FA'; ctx.font = '20px Cairo, sans-serif'; ctx.textAlign = 'left'; text(ctx, value, 125, y + 32, 1040); y += 78; }
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `group-info-${group?.id || 'view'}.png` });
}
async function renderTopGroups({ guild, groups = [], memberRowsByGroup = {}, selectedGroup = null, viewerId = null, accentColor = '#5865F2' } = {}) {
  const W = 1600, H = 1000, accent = hex(accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.direction = 'rtl';
  const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0B1019'); bg.addColorStop(.55, '#182132'); bg.addColorStop(1, '#090D14'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const [r, g, b] = rgb(accent), guildImg = await image(iconUrl(guild));
  const glow = ctx.createRadialGradient(W * .82, 0, 10, W * .82, 0, 680); glow.addColorStop(0, `rgba(${r},${g},${b},.28)`); glow.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 28, 28, W - 56, H - 56, 30, 'rgba(15,21,32,.94)', `rgba(${r},${g},${b},.65)`);
  avatar(ctx, guildImg, 1460, 112, 56, accent, guild?.name || 'G'); ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 46px Cairo, sans-serif'; text(ctx, 'توب القروبات', 1370, 92, 1000); ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif'; text(ctx, 'أفضل 3 قروبات  •  أفضل 10', 1370, 132, 1000);
  const sorted = asArray(groups).map((group, index) => ({ ...group, id: String(group?.id ?? `group-${index}`), points: number(group?.points), memberCount: Array.isArray(group?.memberIds) ? group.memberIds.length : number(group?.memberCount) })).sort((a, b) => number(b.points) - number(a.points) || sortKey(a.name).localeCompare(sortKey(b.name), 'ar', { sensitivity: 'base' }));
  const top3 = sorted.slice(0, 3), top10 = sorted.slice(0, 10);
  const podium = [{ x: 430, rank: 2, h: 240 }, { x: 760, rank: 1, h: 335 }, { x: 1090, rank: 3, h: 205 }], medals = ['#F2C94C', '#D7E1EA', '#CD8A5A'];
  roundRect(ctx, 62, 180, 1190, 440, 24, 'rgba(255,255,255,.035)', 'rgba(255,255,255,.08)');
  const podiumImages = await Promise.all(podium.map(p => image(iconUrl(guild))));
  for (let index = 0; index < podium.length; index += 1) { const p = podium[index], row = top3[p.rank - 1], y = 570 - p.h, col = medals[p.rank - 1]; roundRect(ctx, p.x - 122, y, 244, p.h, 20, `${col}20`, `${col}95`); ctx.fillStyle = col; ctx.font = 'bold 48px Cairo, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(p.rank), p.x, y + 58); avatar(ctx, podiumImages[index], p.x, y - 76, p.rank === 1 ? 58 : 49, col, row?.name || 'G'); if (row) { ctx.fillStyle = '#FFF'; ctx.font = 'bold 23px Cairo, sans-serif'; text(ctx, row.name || 'Group', p.x, y + 116, 210); ctx.fillStyle = col; ctx.font = 'bold 21px Cairo, sans-serif'; ctx.fillText(`${number(row.points).toLocaleString()} نقطة`, p.x, y + 156); ctx.fillStyle = '#AAB4C5'; ctx.font = '16px Cairo, sans-serif'; ctx.fillText(`${number(row.memberCount)} أعضاء`, p.x, y + 187); } }
  ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 24px Cairo, sans-serif'; ctx.fillText('أفضل 10', 1500, 194); roundRect(ctx, 1270, 220, 250, 400, 18, 'rgba(255,255,255,.035)');
  for (let i = 0; i < 10; i += 1) { const row = top10[i], y = 254 + i * 35; ctx.fillStyle = i < 3 ? medals[i] : '#C2CAD7'; ctx.font = 'bold 18px Cairo, sans-serif'; text(ctx, `${String(i + 1).padStart(2, '0')}  ${row?.name || '—'}`, 1490, y, 175); ctx.textAlign = 'left'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 16px Cairo, sans-serif'; ctx.fillText(row ? number(row.points).toLocaleString() : '—', 1290, y); ctx.textAlign = 'right'; }
  const selected = selectedGroup ? sorted.find(row => String(row.id) === String(selectedGroup.id)) || selectedGroup : null;
  const selectedRows = selected ? normalizeRows(memberRowsByGroup?.[String(selected.id)] || selected.members || []) : [];
  const viewerIndex = viewerId == null ? -1 : selectedRows.findIndex(row => String(row.id) === String(viewerId));
  const viewerRow = viewerIndex >= 0 ? selectedRows[viewerIndex] : null;
  const selectedRank = viewerIndex >= 0 ? viewerIndex + 1 : null;
  roundRect(ctx, 62, 660, 1458, 250, 20, 'rgba(255,255,255,.035)', 'rgba(255,255,255,.08)'); ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 24px Cairo, sans-serif'; text(ctx, selected ? `قروبي  •  ${selected.name || 'قروب'}` : 'ترتيبي', 1460, 710, 1250);
  ctx.fillStyle = '#F4F6FA'; ctx.font = 'bold 30px Cairo, sans-serif'; text(ctx, selected ? (viewerRow ? `الترتيب رقم ${selectedRank} في هذا القروب` : 'أنت غير موجود في قائمة هذا القروب') : 'اختر قروبي لعرض ترتيبك', 1460, 770, 1250);
  ctx.fillStyle = '#AAB4C5'; ctx.font = '21px Cairo, sans-serif'; text(ctx, viewerRow ? `${number(viewerRow.points).toLocaleString()} إجمالي النقاط  •  ${number(viewerRow.messages).toLocaleString()} رسالة` : selected ? 'لا توجد نقاط تفاعل مسجلة حتى الآن.' : 'حدّث القائمة بعد جمع النقاط.', 1460, 818, 1250);
  ctx.fillStyle = '#7F8CA1'; ctx.font = '17px Cairo, sans-serif'; text(ctx, `يعرض ${top10.length} من أصل ${sorted.length} قروبًا نشطًا`, 1460, 866, 1250);
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `top-groups-${guild?.id || 'view'}.png` });
}
module.exports = { renderMembers, renderInfo, renderTopGroups };
