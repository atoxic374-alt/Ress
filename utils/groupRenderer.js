const { createCanvas, loadImage } = require('canvas');
const { AttachmentBuilder } = require('discord.js');
const colorManager = require('./colorManager');
const { getGuildBannerHexFast } = require('./guildBannerColor');
require('./cairoFont').ensureCairoFontsRegistered();

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
  if (!avatarCache.has(url)) {
    const pending = Promise.resolve(loadImage(url)).catch(() => null);
    avatarCache.set(url, pending);
    while (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
    pending.then(result => { if (!result && avatarCache.get(url) === pending) avatarCache.delete(url); });
  }
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
function serverAccent(guild, requested) {
  const fallback = colorManager.getColor?.() || '#5865F2';
  return hex(requested || getGuildBannerHexFast(guild, fallback), fallback);
}
async function resolveRole(guild, roleId) {
  if (!roleId) return null;
  const cached = guild?.roles?.cache?.get?.(String(roleId));
  if (cached) return cached;
  try { return await guild?.roles?.fetch?.(String(roleId)) || null; } catch { return null; }
}
async function resolveChannel(guild, channelId) {
  if (!channelId) return null;
  const cached = guild?.channels?.cache?.get?.(String(channelId));
  if (cached) return cached;
  try { return await guild?.channels?.fetch?.(String(channelId)) || null; } catch { return null; }
}
function formatDate(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return 'غير محدد';
  try { return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
  catch { return date.toLocaleString('en-GB'); }
}
function drawWrappedText(ctx, value, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) { ctx.fillText('لا يوجد وصف للقروب.', x, y); return; }
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) visible[maxLines - 1] = `${visible[maxLines - 1].replace(/[.…]+$/, '')}…`;
  visible.forEach((item, index) => text(ctx, item, x, y + index * lineHeight, maxWidth));
}
async function renderMembers({ guild, group, members, accentColor = null }) {
  const W = 1500, H = 1120, accent = serverAccent(guild, accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.direction = 'rtl';
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0D1119'); bg.addColorStop(.55, '#171D2A'); bg.addColorStop(1, '#0B0F16');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const [r, g, b] = rgb(accent);
  const glow = ctx.createRadialGradient(W * .78, 0, 10, W * .78, 0, 620);
  glow.addColorStop(0, `rgba(${r},${g},${b},.24)`); glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 32, 30, W - 64, H - 60, 28, 'rgba(17,22,32,.92)', `rgba(${r},${g},${b},.55)`);

  const guildImg = await image(iconUrl(guild));
  avatar(ctx, guildImg, 1375, 112, 48, accent, guild?.name || 'G');
  ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 42px Cairo, sans-serif';
  text(ctx, 'أعضاء القروب', 1305, 78, 900);
  ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif';
  text(ctx, `${group?.name || 'قروب'}  •  ترتيب النقاط والتفاعل`, 1305, 122, 900);

  const rowsWithMembers = await Promise.all(asArray(members).map(async item => {
    const isMetricRow = item && (item.member !== undefined || item.user_id !== undefined || item.userId !== undefined || item.points !== undefined || item.messages !== undefined);
    if (!isMetricRow || item.member) return item;
    const resolved = await resolveMember(guild, item.user_id ?? item.userId ?? item.id);
    return resolved ? { ...item, member: resolved } : item;
  }));
  const sorted = normalizeRows(rowsWithMembers).slice(0, 10);
  const memberCount = Array.isArray(group?.memberIds) ? group.memberIds.length : number(group?.memberCount ?? sorted.length);
  roundRect(ctx, 62, 55, 265, 105, 18, 'rgba(255,255,255,.045)', `rgba(${r},${g},${b},.42)`);
  ctx.textAlign = 'center'; ctx.fillStyle = '#AAB4C5'; ctx.font = '19px Cairo, sans-serif'; ctx.fillText('عدد الأعضاء', 195, 91);
  ctx.fillStyle = '#FFF'; ctx.font = 'bold 34px Cairo, sans-serif'; ctx.fillText(memberCount.toLocaleString('ar-SA'), 195, 137);

  const medals = ['#F2C94C', '#D7E1EA', '#CD8A5A'];
  const podium = [{ x: 420, rank: 2, h: 205 }, { x: 750, rank: 1, h: 275 }, { x: 1080, rank: 3, h: 180 }];
  const podiumImages = await Promise.all(podium.map(p => image(avatarUrl(sorted[p.rank - 1]?.member))));
  roundRect(ctx, 62, 180, 1376, 420, 24, 'rgba(255,255,255,.035)', 'rgba(255,255,255,.08)');
  for (let index = 0; index < podium.length; index += 1) {
    const p = podium[index], row = sorted[p.rank - 1], y = 565 - p.h, medal = medals[p.rank - 1];
    const grad = ctx.createLinearGradient(0, y, 0, 565); grad.addColorStop(0, `${medal}45`); grad.addColorStop(1, `${medal}0B`);
    roundRect(ctx, p.x - 112, y, 224, p.h, 20, grad, `${medal}95`);
    ctx.fillStyle = medal; ctx.font = 'bold 42px Cairo, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(p.rank), p.x, y + 48);
    const name = row?.name || '—';
    avatar(ctx, podiumImages[index], p.x, y - 58, p.rank === 1 ? 48 : 42, medal, name);
    if (row) {
      ctx.fillStyle = '#FFF'; ctx.font = 'bold 22px Cairo, sans-serif'; text(ctx, name, p.x, y + 95, 190);
      ctx.fillStyle = medal; ctx.font = 'bold 20px Cairo, sans-serif'; ctx.fillText(`${number(row.points).toLocaleString('ar-SA')} نقطة`, p.x, y + 132);
      ctx.fillStyle = '#AAB4C5'; ctx.font = '17px Cairo, sans-serif'; ctx.fillText(`${number(row.messages).toLocaleString('ar-SA')} رسالة`, p.x, y + 163);
    }
  }
  if (!sorted.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = '#AAB4C5'; ctx.font = 'bold 24px Cairo, sans-serif';
    ctx.fillText('لا توجد نقاط مسجلة حتى الآن', 750, 390);
  }

  ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 25px Cairo, sans-serif';
  ctx.fillText('المراكز من 4 إلى 10', 1430, 655);
  const rankCards = [];
  for (let rank = 4; rank <= 7; rank += 1) rankCards.push({ rank, x: 72 + (rank - 4) * 344, y: 680 });
  for (let rank = 8; rank <= 10; rank += 1) rankCards.push({ rank, x: 244 + (rank - 8) * 344, y: 858 });
  const rankImages = await Promise.all(rankCards.map(card => image(avatarUrl(sorted[card.rank - 1]?.member))));
  for (let index = 0; index < rankCards.length; index += 1) {
    const card = rankCards[index], row = sorted[card.rank - 1], cardW = 324, cardH = 150;
    roundRect(ctx, card.x, card.y, cardW, cardH, 18, 'rgba(255,255,255,.045)', `rgba(${r},${g},${b},.32)`);
    ctx.textAlign = 'left'; ctx.fillStyle = accent; ctx.font = 'bold 20px Cairo, sans-serif';
    ctx.fillText(`#${card.rank}`, card.x + 20, card.y + 32);
    avatar(ctx, rankImages[index], card.x + 59, card.y + 92, 35, accent, row?.name || '—');
    ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 22px Cairo, sans-serif';
    text(ctx, row?.name || 'لا يوجد عضو', card.x + cardW - 20, card.y + 52, 220);
    ctx.fillStyle = row ? accent : '#7F8CA1'; ctx.font = 'bold 19px Cairo, sans-serif';
    ctx.fillText(row ? `${number(row.points).toLocaleString('ar-SA')} نقطة` : 'لا توجد نقاط', card.x + cardW - 20, card.y + 91);
    ctx.fillStyle = '#AAB4C5'; ctx.font = '17px Cairo, sans-serif';
    ctx.fillText(row ? `${number(row.messages).toLocaleString('ar-SA')} رسالة` : '—', card.x + cardW - 20, card.y + 121);
  }
  ctx.textAlign = 'right'; ctx.fillStyle = '#7F8CA1'; ctx.font = '17px Cairo, sans-serif';
  text(ctx, `آخر تحديث  ${group?.updated_at ? formatDate(group.updated_at) : 'غير محدد'}`, 1425, 1058, 900);
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `group-members-${group?.id || 'view'}.png` });
}
async function renderInfo({ guild, group, owner, managers, accentColor = null }) {
  const [resolvedOwner, resolvedManagers, role, chatChannel, thread, voiceChannel] = await Promise.all([
    resolveMember(guild, owner),
    resolveMembers(guild, [...asArray(managers), ...asArray(group?.managerIds)]),
    resolveRole(guild, group?.role_id),
    resolveChannel(guild, group?.text_channel_id),
    resolveChannel(guild, group?.thread_id),
    resolveChannel(guild, group?.voice_channel_id)
  ]);
  const W = 1400, H = 1100, accent = serverAccent(guild, accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.direction = 'rtl';
  const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#0C111A'); bg.addColorStop(1, '#1B2331');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const [r, g, b] = rgb(accent);
  roundRect(ctx, 28, 28, W - 56, H - 56, 30, 'rgba(17,22,32,.95)', `rgba(${r},${g},${b},.65)`);
  const icon = await image(iconUrl(guild)); avatar(ctx, icon, 1240, 112, 54, accent, group?.name || 'G');
  ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 42px Cairo, sans-serif'; text(ctx, 'معلومات القروب', 1148, 92, 900);
  ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif'; text(ctx, group?.name || 'قروب', 1148, 135, 900);

  roundRect(ctx, 70, 180, 1260, 120, 18, 'rgba(255,255,255,.045)', `rgba(${r},${g},${b},.25)`);
  ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 20px Cairo, sans-serif'; ctx.fillText('الوصف', 1295, 214);
  ctx.fillStyle = '#E5E9F0'; ctx.font = '20px Cairo, sans-serif'; drawWrappedText(ctx, group?.description || 'لا يوجد وصف للقروب.', 1295, 251, 1200, 30, 2);

  const managerNames = resolvedManagers.map(manager => memberName(manager, memberId(manager))).filter(Boolean);
  const managerValue = managerNames.length ? `${managerNames.slice(0, 4).join('، ')}${managerNames.length > 4 ? ` +${managerNames.length - 4}` : ''}` : 'لا يوجد مسؤولون';
  const ownerName = resolvedOwner ? memberName(resolvedOwner) : 'غير موجود';
  const memberCount = Array.isArray(group?.memberIds) ? group.memberIds.length : number(group?.memberCount);
  const status = ({ active: 'نشط', orphaned: 'يتطلب تنظيفًا', deleted: 'محذوف' })[String(group?.status || '').toLowerCase()] || 'غير محدد';
  const chatName = thread?.name ? `#${thread.name}` : chatChannel?.name ? `#${chatChannel.name}` : 'غير متاح';
  const voiceName = voiceChannel?.name ? `#${voiceChannel.name}` : 'غير متاح';
  const createdAt = group?.created_at ? formatDate(group.created_at) : 'غير محدد';
  const updatedAt = group?.updated_at ? formatDate(group.updated_at) : 'غير محدد';
  const fields = [
    ['المالك', ownerName], ['المسؤولون', managerValue],
    ['عدد الأعضاء', memberCount.toLocaleString('ar-SA')], ['إجمالي النقاط', number(group?.points).toLocaleString('ar-SA')],
    ['اسم الرتبة', role?.name || (group?.role_id ? 'الرتبة غير موجودة' : 'غير محدد')], ['قناة الشات', chatName],
    ['القناة الصوتية', voiceName], ['الحالة', status],
    ['رقم القروب', String(group?.id ?? 'غير محدد')], ['تاريخ الإنشاء', createdAt],
    ['آخر تحديث', updatedAt], ['الإيموجي', group?.emoji || 'بدون إيموجي']
  ];
  const colX = [70, 715], cardW = 615, cardH = 86, startY = 330, rowGap = 105;
  fields.forEach(([label, value], index) => {
    const col = index % 2, row = Math.floor(index / 2), x = colX[col], y = startY + row * rowGap;
    roundRect(ctx, x, y, cardW, cardH, 16, 'rgba(255,255,255,.045)', 'rgba(255,255,255,.075)');
    ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 17px Cairo, sans-serif'; ctx.fillText(label, x + cardW - 20, y + 29);
    ctx.fillStyle = '#F4F6FA'; ctx.font = 'bold 20px Cairo, sans-serif'; text(ctx, value, x + cardW - 20, y + 62, cardW - 42);
  });
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `group-info-${group?.id || 'view'}.png` });
}
async function renderTopGroups({ guild, groups = [], memberRowsByGroup = {}, groupAvatars = {}, selectedGroup = null, viewerId = null, accentColor = null } = {}) {
  const W = 1600, H = 1080, accent = serverAccent(guild, accentColor), canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  ctx.direction = 'rtl';
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0B1019'); bg.addColorStop(.55, '#182132'); bg.addColorStop(1, '#090D14');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const [r, g, b] = rgb(accent), guildImg = await image(iconUrl(guild));
  const glow = ctx.createRadialGradient(W * .82, 0, 10, W * .82, 0, 680);
  glow.addColorStop(0, `rgba(${r},${g},${b},.28)`); glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 28, 28, W - 56, H - 56, 30, 'rgba(15,21,32,.94)', `rgba(${r},${g},${b},.65)`);
  avatar(ctx, guildImg, 1460, 104, 48, accent, guild?.name || 'G');
  ctx.textAlign = 'right'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 46px Cairo, sans-serif';
  text(ctx, 'Top Groups', 1375, 86, 1070);
  ctx.fillStyle = '#AAB4C5'; ctx.font = '22px Cairo, sans-serif';
  text(ctx, 'أفضل 10 قروبات حسب النقاط  •  جميع المراكز معروضة بالتساوي', 1375, 128, 1070);

  const sorted = asArray(groups).map((group, index) => ({
    ...group,
    id: String(group?.id ?? `group-${index}`),
    points: number(group?.points),
    memberCount: Array.isArray(group?.memberIds) ? group.memberIds.length : number(group?.memberCount)
  })).sort((a, b) => number(b.points) - number(a.points)
    || Number(a.id) - Number(b.id)
    || sortKey(a.name).localeCompare(sortKey(b.name), 'ar', { sensitivity: 'base' }));
  const top10 = sorted.slice(0, 10);
  const medals = ['#F2C94C', '#D7E1EA', '#CD8A5A'];
  const avatars = await Promise.all(top10.map(row => image(groupAvatars[String(row.id)] || iconUrl(guild))));
  for (let index = 0; index < 10; index += 1) {
    const row = top10[index] || null;
    const x = 70 + (index % 5) * 294, y = 172 + Math.floor(index / 5) * 338;
    const cardW = 280, cardH = 310, medal = medals[index] || accent;
    const fill = index < 3 ? `${medal}13` : 'rgba(255,255,255,.045)';
    const stroke = index < 3 ? `${medal}90` : `rgba(${r},${g},${b},.42)`;
    roundRect(ctx, x, y, cardW, cardH, 22, fill, stroke);
    ctx.textAlign = 'left'; ctx.fillStyle = medal; ctx.font = 'bold 24px Cairo, sans-serif';
    ctx.fillText(`#${index + 1}`, x + 20, y + 36);
    if (row) {
      avatar(ctx, avatars[index], x + cardW / 2, y + 103, 48, medal, row.name || 'G');
      ctx.textAlign = 'center'; ctx.fillStyle = '#FFF'; ctx.font = 'bold 23px Cairo, sans-serif';
      text(ctx, row.name || 'Group', x + cardW / 2, y + 178, cardW - 34);
      ctx.fillStyle = medal; ctx.font = 'bold 25px Cairo, sans-serif';
      ctx.fillText(`${number(row.points).toLocaleString('ar-SA')} نقطة`, x + cardW / 2, y + 224);
      ctx.fillStyle = '#AAB4C5'; ctx.font = '20px Cairo, sans-serif';
      ctx.fillText(`${number(row.memberCount).toLocaleString('ar-SA')} أعضاء`, x + cardW / 2, y + 264);
      roundRect(ctx, x + 45, y + 280, cardW - 90, 3, 2, `rgba(${r},${g},${b},.65)`);
    } else {
      ctx.textAlign = 'center'; ctx.fillStyle = '#7F8CA1'; ctx.font = '20px Cairo, sans-serif';
      ctx.fillText('لا يوجد قروب في هذا المركز', x + cardW / 2, y + 160);
    }
  }

  const selected = selectedGroup ? sorted.find(row => String(row.id) === String(selectedGroup.id)) || selectedGroup : null;
  const selectedRows = selected ? normalizeRows(memberRowsByGroup?.[String(selected.id)] || selected.members || []) : [];
  const viewerIndex = viewerId == null ? -1 : selectedRows.findIndex(row => String(row.id) === String(viewerId));
  const viewerRow = viewerIndex >= 0 ? selectedRows[viewerIndex] : null;
  roundRect(ctx, 62, 870, 1476, 135, 22, 'rgba(255,255,255,.045)', `rgba(${r},${g},${b},.38)`);
  ctx.textAlign = 'right'; ctx.fillStyle = accent; ctx.font = 'bold 23px Cairo, sans-serif';
  text(ctx, selected ? `قروبك  •  ${selected.name || 'قروب'}` : viewerId == null ? 'استعراض ترتيبك الشخصي' : 'ترتيبك في القروب', 1498, 912, 1380);
  ctx.fillStyle = '#F4F6FA'; ctx.font = 'bold 25px Cairo, sans-serif';
  const rankText = viewerId == null ? 'استخدم زري My Rank وMy Group لعرض بياناتك بشكل خاص.'
    : viewerRow ? `ترتيبك ${viewerIndex + 1}  •  ${number(viewerRow.points).toLocaleString('ar-SA')} نقطة  •  ${number(viewerRow.messages).toLocaleString('ar-SA')} رسالة`
      : selected ? 'لا توجد نقاط مسجلة لك في هذا القروب حتى الآن.' : 'لا يوجد قروب مرتبط بعضويتك.';
  text(ctx, rankText, 1498, 956, 1380);
  ctx.fillStyle = '#7F8CA1'; ctx.font = '17px Cairo, sans-serif';
  text(ctx, `يعرض ${top10.length} من أصل ${sorted.length} قروبًا نشطًا`, 1498, 988, 1380);
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `top-groups-${guild?.id || 'view'}.png` });
}
module.exports = { renderMembers, renderInfo, renderTopGroups };
