const {
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { registerTicketInteractionRouter } = require('../utils/ticketInteractionRouter');
const colorManager = require('../utils/colorManager');

const name = 'ticket';
const aliases = ['تكت', 'tclose', 'اغلاق', 'قفل', 'اقفال', 'myticket', 'نقاطي', 'tadd', 'اضافه', 'اضافة', 'إضافة', 'tremove', 'ازاله', 'ازالة', 'إزالة', 'tchange', 'تغيير', 'تحويل', 'ttop', 'نقاط', 'tname', 'اسم', 'تسميه', 'تسمية', 'remind', 'تنبيه', 'استدعاء', 'points', 'tm', 'treset', 'tmreset', 'tblock'];
const dataPath = path.join(__dirname, '..', 'data', 'ticketConfig.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
const ticketImagesDir = path.join(__dirname, '..', 'data', 'ticket_images');
const pointsPath = path.join(__dirname, '..', 'data', 'points.json');
const ticketSearchSessions = new Map();
const pointsAdjustSessions = new Map();

let handlersRegistered = false;
const pingCooldowns = new Map();
const ticketClaimLocks = new Set();
const activeTicketSetupSessions = new Map();
const recentTicketCommandMessages = new Set();

function makeTicketEmbed(title, description, options = {}) {
  const embed = colorManager.createEmbed().setTitle(title).setDescription(description || null);
  if (options?.user) {
    embed.setAuthor({ name: options.user.username || options.user.tag || 'User', iconURL: options.user.displayAvatarURL?.() || undefined });
  }
  return embed;
}

function renderTicketText(template, memberId) {
  if (!template) return '';
  return String(template).replace(/\buser\b/gi, `<@${memberId}>`);
}

function pickReasonOverride(reasonValue, globalValue) {
  if (reasonValue === null || reasonValue === undefined || reasonValue === '') return globalValue;
  return reasonValue;
}

function isImageSettingValue(value) {
  if (!value || typeof value !== 'string') return false;
  return value.startsWith('local:') || /^https?:\/\//i.test(value);
}


function buildV2InfoCard(title, lines = []) {
  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}`),
      new TextDisplayBuilder().setContent((Array.isArray(lines) ? lines : [String(lines || '')]).filter(Boolean).join('\n'))
    )
    .addSeparatorComponents(new SeparatorBuilder());
}

function buildV2ComponentsFromEmbed(embed, actionRows = [], note = null) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {});
  const segments = [];

  if (data.title) segments.push(`## ${String(data.title).replace(/\*\*/g, '').trim()}`);
  if (note) segments.push(String(note));
  if (data.description) segments.push(String(data.description));
  for (const field of data.fields || []) {
    segments.push(`### ${String(field.name || '').replace(/\*\*/g, '').trim()}
${String(field.value || '')}`);
  }
  if (data.footer?.text) segments.push(`-# ${String(data.footer.text)}`);

  const chunks = [];
  let current = '';
  for (const segment of segments.filter(Boolean)) {
    const next = current ? `${current}

${segment}` : segment;
    if (next.length > 3500 && current) {
      chunks.push(current);
      current = segment;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push('## Ticket');

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(...chunks.map((chunk) => new TextDisplayBuilder().setContent(chunk.slice(0, 4000))));
  if (chunks.length > 0) container.addSeparatorComponents(new SeparatorBuilder());
  return [container, ...actionRows];
}

function buildMessageFlags({ ephemeral = false, useComponentsV2 = false } = {}) {
  let flags = 0;
  if (useComponentsV2) flags |= MessageFlags.IsComponentsV2;
  if (ephemeral) flags |= MessageFlags.Ephemeral;
  return flags || undefined;
}

function normalizeEmbedForStandardMessage(embed, note = null) {
  const normalized = EmbedBuilder.from(typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {}));
  if (note) {
    const previous = normalized.data?.description || normalized.description || '';
    normalized.setDescription([String(note), previous].filter(Boolean).join('\n\n'));
  }
  return normalized;
}

function buildTicketMessagePayload(title, description, options = {}) {
  const {
    user = null,
    components = [],
    note = null,
    files = null,
    content = null,
    ephemeral = false,
    useComponentsV2 = false
  } = options;

  const embed = normalizeEmbedForStandardMessage(makeTicketEmbed(title, description, { user }), note);
  const payload = {
    embeds: [embed]
  };

  if (components?.length) payload.components = components;
  const flags = buildMessageFlags({ ephemeral, useComponentsV2 });
  if (flags) payload.flags = flags;
  if (content) payload.content = content;
  if (files) payload.files = Array.isArray(files) ? files : [files];
  return payload;
}

function buildMentionChunks(roleIds = [], maxLen = 1800) {
  const mentions = [...new Set(roleIds)].map((id) => `<@&${id}>`);
  const chunks = [];
  let current = '';
  for (const mention of mentions) {
    const next = current ? `${current} ${mention}` : mention;
    if (next.length > maxLen) {
      if (current) chunks.push(current);
      current = mention;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function resolveButtonStyle(styleValue) {
  const safe = String(styleValue || 'primary').toLowerCase();
  if (safe === 'success') return ButtonStyle.Success;
  if (safe === 'danger') return ButtonStyle.Danger;
  if (safe === 'secondary') return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}

function loadPoints() {
  try {
    if (!fs.existsSync(pointsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePoints(points) {
  writeJsonAtomic(pointsPath, points);
}

function ensurePointsAudit(points) {
  if (!Array.isArray(points.__audit)) points.__audit = [];
  return points.__audit;
}

function ensureManagerAudit(points) {
  if (!Array.isArray(points.__managerAudit)) points.__managerAudit = [];
  return points.__managerAudit;
}

function sumPointBucket(bucket) {
  if (bucket && typeof bucket === 'object') {
    return Object.values(bucket).reduce((sum, value) => sum + Number(value || 0), 0);
  }
  return Number(bucket || 0);
}

function getUserTotalPoints(points, userId) {
  const targetId = String(userId || '').trim();
  if (!targetId) return 0;
  let total = 0;
  for (const [key, bucket] of Object.entries(points || {})) {
    if (key.startsWith('__')) continue;
    if (!bucket || typeof bucket !== 'object') continue;
    total += sumPointBucket(bucket[targetId]);
  }
  return total;
}

function getTopPointUsers(points, limit = 10) {
  const totals = new Map();
  for (const [key, bucket] of Object.entries(points || {})) {
    if (key.startsWith('__')) continue;
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [userId, userBucket] of Object.entries(bucket)) {
      totals.set(userId, (totals.get(userId) || 0) + sumPointBucket(userBucket));
    }
  }
  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .slice(0, Math.max(1, limit));
}

function getTopPointAwarder(points, userId) {
  const targetId = String(userId || '').trim();
  const awards = new Map();
  const auditEntries = Array.isArray(points?.__audit) ? points.__audit : [];
  for (const entry of auditEntries) {
    if (String(entry?.targetId || '') !== targetId || !entry?.actorId) continue;
    awards.set(entry.actorId, (awards.get(entry.actorId) || 0) + Number(entry.delta || 0));
  }
  if (!awards.size) return null;
  const [actorId, total] = [...awards.entries()].sort((a, b) => b[1] - a[1])[0];
  return { actorId, total };
}

function appendPointAuditEntry(points, entry) {
  const audit = ensurePointsAudit(points);
  audit.push({
    id: String(entry?.id || Date.now()),
    targetId: String(entry?.targetId || ''),
    actorId: String(entry?.actorId || ''),
    delta: Number(entry?.delta || 0),
    respName: String(entry?.respName || 'general'),
    source: String(entry?.source || 'manual'),
    at: String(entry?.at || Date.now())
  });
}

function removePointAuditEntry(points, entryId) {
  const audit = ensurePointsAudit(points);
  const before = audit.length;
  points.__audit = audit.filter((entry) => String(entry?.id || '') !== String(entryId || ''));
  return points.__audit.length !== before;
}

function appendManagerAuditEntry(points, entry) {
  const audit = ensureManagerAudit(points);
  if (audit.some((item) => String(item?.ticketKey || '') === String(entry?.ticketKey || ''))) return false;
  audit.push({
    ticketKey: String(entry?.ticketKey || ''),
    actorId: String(entry?.actorId || ''),
    targetId: String(entry?.targetId || ''),
    at: String(entry?.at || Date.now())
  });
  return true;
}

function getManagerEvaluationCount(points, userId) {
  const targetId = String(userId || '').trim();
  const audit = Array.isArray(points?.__managerAudit) ? points.__managerAudit : [];
  return audit.filter((entry) => String(entry?.actorId || '') === targetId).length;
}

function getTopManagers(points, limit = 10) {
  const totals = new Map();
  const audit = Array.isArray(points?.__managerAudit) ? points.__managerAudit : [];
  for (const entry of audit) {
    const actorId = String(entry?.actorId || '').trim();
    if (!actorId) continue;
    totals.set(actorId, (totals.get(actorId) || 0) + 1);
  }
  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .slice(0, Math.max(1, limit));
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function buildLogEvent(type, message, extra = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: String(type || 'note'),
    message: String(message || '').trim(),
    at: Number(extra.at || Date.now()),
    actorId: extra.actorId ? String(extra.actorId) : null,
    targetId: extra.targetId ? String(extra.targetId) : null,
    metadata: extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {}
  };
}

function formatTicketLogEvent(event) {
  if (!event) return '';
  if (typeof event === 'string') return event.trim();
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  const label = String(event.type || 'note');
  return `[${label}]`;
}

function appendTicketLogEntry(ticket, entry) {
  if (!ticket) return;
  const normalized = typeof entry === 'object' && entry !== null
    ? buildLogEvent(entry.type, entry.message, entry)
    : buildLogEvent('note', String(entry || '').trim());
  if (!normalized.message) return;
  if (!Array.isArray(ticket.logEvents)) ticket.logEvents = [];
  ticket.logEvents.push(normalized);
  if (ticket.logEvents.length > 40) ticket.logEvents = ticket.logEvents.slice(-40);
  if (!Array.isArray(ticket.logHistory)) ticket.logHistory = [];
  ticket.logHistory.push(formatTicketLogEvent(normalized));
  if (ticket.logHistory.length > 12) ticket.logHistory = ticket.logHistory.slice(-12);
}

function getTicketLogTimeline(ticket, limit = 8) {
  const events = Array.isArray(ticket?.logEvents) ? ticket.logEvents.slice(-limit) : [];
  return events
    .map((event) => {
      const at = Number(event?.at || 0);
      const time = at ? new Date(at).toISOString() : 'unknown-time';
      return `• ${time} — ${escapeHtml(formatTicketLogEvent(event))}`;
    })
    .join('<br>');
}

function renderTranscriptContent(channel, rawText = '') {
  const guild = channel?.guild;
  let html = escapeHtml(rawText || '');
  html = html
    .replace(/&lt;@!?(\d{1,22})&gt;/g, (_, id) => {
      const member = guild?.members?.cache?.get?.(id);
      const label = member?.displayName || member?.user?.username || id;
      return `<span class="mention user-mention">@${escapeHtml(label)}</span>`;
    })
    .replace(/&lt;@&(\d{1,22})&gt;/g, (_, id) => {
      const role = guild?.roles?.cache?.get?.(id);
      const label = role?.name || id;
      return `<span class="mention role-mention">@${escapeHtml(label)}</span>`;
    })
    .replace(/&lt;#(\d{1,22})&gt;/g, (_, id) => {
      const linked = guild?.channels?.cache?.get?.(id);
      const label = linked?.name || id;
      return `<span class="mention channel-mention">#${escapeHtml(label)}</span>`;
    });
  html = html.replace(/(https?:\/\/[^\s<]+)/gi, (url) => {
    const safeUrl = escapeHtml(url);
    const imageLike = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url)
      || /cdn\.discordapp\.com\/attachments\//i.test(url)
      || /media\.discordapp\.net\/attachments\//i.test(url)
      || /images?\./i.test(url);
    if (imageLike) {
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a><br><div class="media"><img src="${safeUrl}" alt="inline-image" loading="lazy"></div>`;
    }
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>`;
  });
  return html.replace(/\n/g, '<br>');
}

function formatDeletedTranscriptEntry(entry, channel = null) {
  const author = entry?.authorTag || entry?.authorName || entry?.authorId || 'unknown';
  const ts = new Date(Number(entry?.deletedAt || entry?.createdTimestamp || Date.now())).toLocaleString('en-GB', { hour12: false, timeZone: 'UTC' });
  const content = renderTranscriptContent(channel, entry?.content || '') || '<span class="muted">(empty)</span>';
  const avatar = entry?.avatarUrl
    ? `<img class="avatar-img" src="${escapeHtml(entry.avatarUrl)}" alt="${escapeHtml(author)}" loading="lazy">`
    : `<div class="avatar-fallback">${escapeHtml(String(author).slice(0, 2).toUpperCase())}</div>`;
  return {
    timestamp: Number(entry?.deletedAt || entry?.createdTimestamp || Date.now()),
    html: `
      <article class="message deleted-message">
        <div class="avatar">${avatar}</div>
        <div class="content">
          <div class="meta">
            <span class="author">${escapeHtml(author)}</span>
            <span class="time">${escapeHtml(ts)} UTC</span>
          </div>
          <div class="body" dir="auto"><span class="deleted-label">(deleted)</span> <span class="deleted-body">${content}</span></div>
        </div>
      </article>
    `
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTranscriptComponents(message) {
  const rows = Array.isArray(message?.components) ? message.components : [];
  if (!rows.length) return '';
  const parts = rows.map((row) => {
    const items = (row.components || []).map((component) => {
      if (component.data?.options?.length || component.options?.length) {
        const options = component.data?.options || component.options || [];
        return `<div class="component select-menu">[Menu] ${options.map((option) => escapeHtml(option.label || option.value || 'option')).join(' | ')}</div>`;
      }
      const label = component.label || component.data?.label || component.placeholder || component.data?.placeholder || component.customId || 'component';
      return `<div class="component button">${escapeHtml(label)}</div>`;
    }).join('');
    return `<div class="component-row">${items}</div>`;
  }).join('');
  return `<div class="components-wrap">${parts}</div>`;
}

function isImageLikeAttachment(attachment) {
  const name = String(attachment?.name || '').toLowerCase();
  const url = String(attachment?.url || '').toLowerCase();
  const contentType = String(attachment?.contentType || '').toLowerCase();
  return contentType.startsWith('image/')
    || (Number(attachment?.width || 0) > 0 && Number(attachment?.height || 0) > 0)
    || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
    || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url);
}

function buildTranscriptAvatar(author) {
  const url = author?.displayAvatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || author?.avatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || author?.avatarURL?.()
    || '';
  if (url) {
    return `<img class="avatar-img" src="${escapeHtml(url)}" alt="${escapeHtml(author?.tag || author?.username || 'avatar')}" loading="lazy">`;
  }
  const fallback = String(author?.tag || author?.username || author?.id || '??').slice(0, 2).toUpperCase();
  return `<div class="avatar-fallback">${escapeHtml(fallback)}</div>`;
}

function formatTranscriptEmbeds(embeds = []) {
  return embeds.map((e) => {
    const parts = [];
    if (e.author?.name) parts.push(`<div class="embed-author">${escapeHtml(e.author.name)}</div>`);
    if (e.title) parts.push(`<div class="embed-title">${escapeHtml(e.title)}</div>`);
    if (e.description) parts.push(`<div class="embed-description">${escapeHtml(e.description).replace(/\n/g, '<br>')}</div>`);
    if (Array.isArray(e.fields) && e.fields.length) {
      const fields = e.fields.slice(0, 15).map((field) => `
        <div class="embed-field">
          <div class="embed-field-name">${escapeHtml(field.name || '-')}</div>
          <div class="embed-field-value">${escapeHtml(field.value || '-').replace(/\n/g, '<br>')}</div>
        </div>
      `).join('');
      parts.push(`<div class="embed-fields">${fields}</div>`);
    }
    if (e.footer?.text) parts.push(`<div class="embed-footer">${escapeHtml(e.footer.text)}</div>`);
    const mediaUrl = e.image?.url || e.thumbnail?.url || null;
    if (mediaUrl) parts.push(`<div class="media"><img src="${escapeHtml(mediaUrl)}" alt="embed-media" loading="lazy"></div>`);
    if (!parts.length) return '';
    return `<section class="embed-card">${parts.join('')}</section>`;
  }).filter(Boolean).join('');
}

async function buildTicketTranscript(channel, maxMessages = 200) {
  try {
    const rows = [];
    let lastId = null;
    let fetchedTotal = 0;

    while (fetchedTotal < maxMessages) {
      const remaining = Math.min(100, maxMessages - fetchedTotal);
      const batch = await channel.messages.fetch({ limit: remaining, before: lastId }).catch(() => null);
      if (!batch || batch.size === 0) break;

      const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of ordered) {
        const ts = new Date(msg.createdTimestamp).toLocaleString('en-GB', { hour12: false, timeZone: 'UTC' });
        const author = msg.author?.tag || msg.author?.username || msg.author?.id || 'unknown';
        const content = renderTranscriptContent(channel, (msg.content || '').trim());
        const attachments = msg.attachments?.size
          ? [...msg.attachments.values()].map((a) => {
            const imagePreview = isImageLikeAttachment(a)
              ? `<div class="media"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name || 'image')}" loading="lazy"></div>`
              : '';
            return `<div class="attachment">${imagePreview}<a href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">${escapeHtml(a.name || a.url)}</a></div>`;
          }).join('<br>')
          : '';
        const embeds = msg.embeds?.length ? formatTranscriptEmbeds(msg.embeds) : '';
        const stickers = msg.stickers?.size
          ? `<div class="sticker-list">${[...msg.stickers.values()].map((sticker) => `🎟️ ${escapeHtml(sticker.name || sticker.id || 'sticker')}`).join('<br>')}</div>`
          : '';
        const reactions = msg.reactions?.cache?.size
          ? `<div class="reactions">${[...msg.reactions.cache.values()].map((reaction) => `:${escapeHtml(reaction.emoji?.name || 'emoji')}: ×${reaction.count || 1}`).join(' ')}</div>`
          : '';
        const reference = msg.reference?.messageId ? `<div class="reply-ref">↪️ Reply to message ${escapeHtml(msg.reference.messageId)}</div>` : '';
        const components = formatTranscriptComponents(msg);
        const blocks = [reference, content, attachments, embeds, stickers, reactions, components].filter(Boolean).join('<br>');
        rows.push({
          timestamp: msg.createdTimestamp,
          html: `
          <article class="message">
            <div class="avatar">${buildTranscriptAvatar(msg.author)}</div>
            <div class="content">
              <div class="meta">
                <span class="author">${escapeHtml(author)}</span>
                <span class="time">${escapeHtml(ts)} UTC</span>
              </div>
              <div class="body" dir="auto">${blocks || '<span class="muted">(empty)</span>'}</div>
            </div>
          </article>
        `
        });
      }

      fetchedTotal += batch.size;
      lastId = ordered[0]?.id;
      if (!lastId) break;
    }

    const deletedRows = Array.isArray(channel.ticketMeta?.deletedMessages)
      ? channel.ticketMeta.deletedMessages.map((entry) => formatDeletedTranscriptEntry(entry, channel))
      : [];
    const combinedRows = [...rows, ...deletedRows].sort((a, b) => a.timestamp - b.timestamp).map((row) => row.html);
    if (combinedRows.length === 0) return null;
    const logTimeline = getTicketLogTimeline(channel.ticketMeta || null);
    const fileName = `transcript-${channel.id}.html`;
    const html = `<!doctype html>
<html lang="ar">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Transcript ${escapeHtml(channel.name || channel.id)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #313338; color: #dbdee1; }
    .wrap { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; }
    .header { background: #1e1f22; border: 1px solid #3f4147; border-radius: 16px; padding: 16px 18px; margin-bottom: 16px; }
    .header h1 { margin: 0 0 8px; font-size: 22px; }
    .header p { margin: 4px 0; color: #b5bac1; }
    .message { display: flex; gap: 12px; padding: 12px 10px; border-radius: 12px; }
    .message:hover { background: rgba(255,255,255,0.03); }
    .avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; background: #5865f2; display: flex; align-items: center; justify-content: center; font-weight: 700; flex: 0 0 40px; }
    .avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .avatar-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .content { min-width: 0; flex: 1; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 4px; }
    .author { font-weight: 700; color: #fff; }
    .time { font-size: 12px; color: #949ba4; }
    .body { line-height: 1.6; word-break: break-word; }
    .body a { color: #00a8fc; text-decoration: none; }
    .body a:hover { text-decoration: underline; }
    .attachment { display: grid; gap: 6px; }
    .media img { max-width: min(100%, 520px); border-radius: 12px; border: 1px solid #3f4147; display: block; }
    .embed-card { margin-top: 8px; border-left: 4px solid #5865f2; background: #2b2d31; border-radius: 8px; padding: 10px 12px; display: grid; gap: 8px; }
    .mention { display: inline-block; border-radius: 6px; padding: 0 4px; background: rgba(88,101,242,.18); color: #c9cdfb; }
    .component-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .component { border: 1px solid #4e5058; border-radius: 8px; padding: 6px 10px; background: #2b2d31; color: #f2f3f5; font-size: 12px; }
    .embed-author, .embed-footer, .reply-ref, .reactions, .sticker-list { color: #b5bac1; font-size: 12px; }
    .embed-title, .embed-field-name { font-weight: 700; color: #fff; }
    .embed-fields { display: grid; gap: 8px; }
    .timeline { margin-bottom: 16px; background: #1e1f22; border: 1px solid #3f4147; border-radius: 12px; padding: 14px 16px; }
    .deleted-message { background: rgba(237, 66, 69, 0.08); border: 1px solid rgba(237, 66, 69, 0.25); }
    .deleted-label, .deleted-body { color: #ff6b6b; }
    .muted { color: #949ba4; }
    @media (max-width: 640px) { .wrap { padding: 12px 8px 32px; } .header h1 { font-size: 18px; } }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="header">
      <h1>#${escapeHtml(channel.name || channel.id)}</h1>
      <p>Channel ID: ${escapeHtml(channel.id)}</p>
      <p>Generated at: ${escapeHtml(new Date().toISOString())}</p>
    </section>
    ${logTimeline ? `<section class="timeline"><strong>Ticket activity</strong><br>${logTimeline}</section>` : ''}
    ${combinedRows.join('\n')}
  </main>
</body>
</html>`;
    return new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName });
  } catch {
    return null;
  }
}

async function retryAsync(fn, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await fn(i);
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function sendTranscriptToLogChannel(logChannel, transcriptFile) {
  if (!logChannel || !transcriptFile) return null;
  const message = await retryAsync(() => logChannel.send({ files: [transcriptFile] }).catch(() => null), 2);
  if (!message) return null;
  const attachment = [...message.attachments.values()].find((item) => String(item.name || '').startsWith('transcript-'));
  return attachment?.url || null;
}

async function finalizeTransferDmNotifications(ticket, guild, closedByLabel = 'غير محدد') {
  const notices = Array.isArray(ticket?.transferDmNotifications) ? ticket.transferDmNotifications : [];
  if (!notices.length || !guild?.client) return;
  for (const notice of notices) {
    const user = await guild.client.users.fetch(notice.userId).catch(() => null);
    if (!user) continue;
    const dm = await user.createDM().catch(() => null);
    if (!dm) continue;
    const msg = notice.messageId ? await dm.messages.fetch(notice.messageId).catch(() => null) : null;
    if (!msg?.editable) continue;
    const resolvedBy = closedByLabel || 'غير محدد';
    const transferredBy = notice.transferredById ? `<@${notice.transferredById}>` : 'غير محدد';
    await msg.edit({
      embeds: [makeTicketEmbed('تحويل تكت', `**من الذي حوّل التكت :** ${transferredBy}\n**ولكن تم حلها بنجاح بواسطة :** ${resolvedBy}`)]
    }).catch(() => {});
  }
}

async function syncTicketLogMessage({
  guild,
  config,
  ticket,
  channelId,
  actionText,
  actor = null,
  transcriptFile = null
}) {
  const logChannelId = config?.logChannelId;
  if (!guild || !ticket || !logChannelId) return false;

  const logChannel = guild.channels.cache.get(logChannelId)
    || await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased?.()) {
    ticket.logSyncFailedAt = Date.now();
    ticket.logSyncError = 'LOG_CHANNEL_UNAVAILABLE';
    return false;
  }

  appendTicketLogEntry(ticket, typeof actionText === 'object' ? actionText : { type: 'action', message: actionText, actorId: actor?.id || null });

  const reason = config.reasons?.[ticket.reasonKey] || {};
  const historyText = (ticket.logHistory || []).slice(-12).map((line, index) => `${index + 1}) ${line}`).join('\n') || 'لا يوجد';
  const statusLabel = ticket.status === 'closed' ? 'Closed / مغلق' : 'Open / مفتوح';
  const transcriptUrl = transcriptFile ? await sendTranscriptToLogChannel(logChannel, transcriptFile).catch(() => null) : (ticket.lastTranscriptUrl || null);
  if (transcriptUrl) ticket.lastTranscriptUrl = transcriptUrl;
  const ticketLabel = ticket.deletedChannel ? 'Deleted' : (channelId ? `<#${channelId}>` : (ticket.channelId ? `<#${ticket.channelId}>` : 'غير محدد'));
  const summaryLines = [
    `**Ticket :** ${ticketLabel}`,
    `**Member :** ${ticket.memberId ? `<@${ticket.memberId}>` : 'غير محدد'}`,
    `**Reason :** ${reason.name || `سبب ${ticket.reasonKey || '-'}`}`,
    `**Status :** ${statusLabel}`,
    transcriptUrl ? `**Transcript :** [Open here](${transcriptUrl})` : null,
    '',
    '**Results / النتائج :**',
    historyText
  ].filter(Boolean);

  let description = summaryLines.join('\n');
  if (description.length > 3800) {
    const trimmedHistory = (ticket.logHistory || []).slice(-8).map((line, index) => `${index + 1}) ${line}`).join('\n') || 'لا يوجد';
    description = [
      `**Ticket :** ${ticketLabel}`,
      `**Member :** ${ticket.memberId ? `<@${ticket.memberId}>` : 'غير محدد'}`,
      `**Reason :** ${reason.name || `سبب ${ticket.reasonKey || '-'}`}`,
      `**Status :** ${statusLabel}`,
      '',
      '**Results / النتائج :**',
      trimmedHistory
    ].filter(Boolean).join('\n');
  }

  const embed = colorManager.createEmbed()
    .setTitle('Log')
    .setDescription(description)
    .setFooter({ text: `Ticket ID: ${ticket.channelId || channelId || 'unknown'}` })
    .setTimestamp(new Date());

  embed.setAuthor({ name: guild.name || 'Server', iconURL: guild.iconURL?.({ dynamic: true, size: 128 }) || undefined });

  const payload = { embeds: [embed] };

  let savedMessage = null;
  ticket.logSyncFailedAt = null;
  ticket.logSyncError = null;
  if (ticket.logMessageId) {
    const existing = await retryAsync(() => logChannel.messages.fetch(ticket.logMessageId).catch(() => null), 2).catch(() => null);
    if (existing?.editable) {
      savedMessage = await retryAsync(() => existing.edit(payload).catch(() => null), 2).catch(() => null);
      if (savedMessage) return true;
    }
  }

  const sent = await retryAsync(() => logChannel.send(payload).catch(() => null), 2).catch(() => null);
  if (!sent) {
    ticket.logSyncFailedAt = Date.now();
    ticket.logSyncError = 'LOG_MESSAGE_SEND_FAILED';
    return false;
  }
  ticket.logMessageId = sent.id;
  return true;
}

async function sendClaimAnnounce({ channel, config, ticket, claimerId, claimImage }) {
  const adminRoleIds = getAdminRoles(config, ticket?.reasonKey)
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id));

  const reasonName = config.reasons?.[ticket.reasonKey]?.name || `سبب ${ticket.reasonKey}`;
  const mentionChunks = buildMentionChunks(adminRoleIds);
  for (const chunk of mentionChunks) {
    await channel.send({ content: chunk }).catch(() => {});
  }

  const claimEmbed = makeTicketEmbed('Ticket claimed', `**العضو :** <@${ticket.memberId}>\n**السبب :** ${reasonName}\n**المستلم :** <@${claimerId}>`);

  await channel.send({
    embeds: [claimEmbed]
  }).catch(() => {});
}

function buildClaimRequestContent(ticket, config, claimerId = null) {
  const reason = config?.reasons?.[ticket?.reasonKey] || {};
  const lines = [
    `**العضو :** <@${ticket?.memberId || 'unknown'}>`,
    `**السبب :** ${reason.name || `سبب ${ticket?.reasonKey || '-'}`}`
  ];
  if (reason.description) lines.push(`**الوصف :** ${reason.description}`);
  if (claimerId) lines.push(`**المستلم :** <@${claimerId}>`);
  return lines.join('\n');
}

function buildPostCloseControls(guildId, panelId, channelId, ticket = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_down2_${guildId}_${panelId}_${channelId}`).setLabel('-2').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_down_${guildId}_${panelId}_${channelId}`).setLabel('-1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_delete_${guildId}_${panelId}_${channelId}`).setLabel('حذف').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_up1_${guildId}_${panelId}_${channelId}`).setLabel('1').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_up2_${guildId}_${panelId}_${channelId}`).setLabel('2').setStyle(ButtonStyle.Success)
  );

  const memberHidden = ticket.memberHidden !== false;
  const claimerHidden = ticket.claimerHidden !== false;
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_toggle_member_${guildId}_${channelId}`)
      .setLabel(memberHidden ? 'ارجاع العضو' : 'اخفاء العضو')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket_toggle_claimer_${guildId}_${channelId}`)
      .setLabel(claimerHidden ? 'ارجاع المسؤول' : 'اخفاء المسؤول')
      .setStyle(ButtonStyle.Primary)
  );

  return [row1, row2];
}

function buildPointRevertControls(guildId, panelId, channelId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_points_revert_${guildId}_${panelId}_${channelId}`)
      .setLabel('تراجع عن النقاط')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ticket_points_cancel_${guildId}_${panelId}_${channelId}`)
      .setLabel('إلغاء')
      .setStyle(ButtonStyle.Secondary)
  )];
}

function loadStore() {
  try {
    if (!fs.existsSync(dataPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  writeJsonAtomic(dataPath, store);
}

function loadResponsibilities() {
  try {
    if (!fs.existsSync(responsibilitiesPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ensureTicketImagesDir() {
  if (!fs.existsSync(ticketImagesDir)) fs.mkdirSync(ticketImagesDir, { recursive: true });
}

function removeStoredImage(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('local:')) return;
  const fileName = value.slice('local:'.length);
  const absolute = path.join(ticketImagesDir, fileName);
  if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
}

function resolveImageForSend(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith('local:')) return value;
  const fileName = value.slice('local:'.length);
  const absolute = path.join(ticketImagesDir, fileName);
  return fs.existsSync(absolute) ? absolute : null;
}

function getReasonVisualSettings(config, reasonKey) {
  const reason = config?.reasons?.[reasonKey] || {};
  return {
    reason,
    beforeText: pickReasonOverride(reason.beforeImage, config?.messages?.beforeImage),
    openImage: pickReasonOverride(reason.openImage, config?.messages?.ticketImage),
    afterText: pickReasonOverride(reason.afterImage, config?.messages?.afterImage),
    claimImage: pickReasonOverride(reason.claimImage, config?.messages?.claimImage || config?.messages?.ticketImage)
  };
}

async function storeImageLocally(url, guildId, slotKey, previousValue = null) {
  const safe = String(url || '').trim();
  if (!/^https?:\/\//i.test(safe)) throw new Error('الرابط غير صالح');
  const parsed = new URL(safe);
  const response = await fetch(parsed.toString());
  if (!response.ok) throw new Error(`فشل تحميل الصورة (${response.status})`);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('الرابط لا يشير إلى صورة');

  ensureTicketImagesDir();
  const extFromType = contentType.includes('png') ? '.png'
    : contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
      : contentType.includes('webp') ? '.webp'
        : contentType.includes('gif') ? '.gif'
          : path.extname(parsed.pathname || '') || '.png';

  const fileName = `${guildId}_${slotKey}_${Date.now()}${extFromType}`;
  const absolute = path.join(ticketImagesDir, fileName);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(absolute, bytes);

  removeStoredImage(previousValue);
  return `local:${fileName}`;
}


function formatSettingValue(value, fallback = 'غير مضبوط') {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value);
  if (text.startsWith('local:')) return `محلي (${text.slice(6)})`;
  if (/^https?:\/\//i.test(text)) return text.length > 90 ? `${text.slice(0, 90)}...` : text;
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function baseConfig() {
  return {
    ticketNameMode: 'counter',
    ticketNamePrefix: 'ticket',
    openCategoryId: null,
    closedCategoryId: null,
    responsibleRoleIds: [],
    adminRoleIds: [],
    useGlobalAdminRoles: true,
    adminClaimLimit: 1,
    memberOpenLimit: 1,
    autoCreateOnRequest: true,
    hideOnClaim: false,
    claimFromDedicatedChannel: false,
    claimChannelId: null,
    keepClosedTickets: false,
    deleteClaimMessageOnClaim: false,
    logChannelId: null,
    autoCloseEnabled: false,
    autoCloseHours: 24,
    autoCloseWarningMinutes: 10,
    messages: {
      beforeImage: '',
      ticketImage: '',
      claimImage: '',
      afterImage: ''
    },
    reasons: {},
    displayMode: 'buttons',
    buttonRows: 2,
    panelMessageId: null,
    exportedAt: null,
    counter: 1
  };
}

function getGuildData(guildId) {
  const store = loadStore();
  const existing = store[guildId] || {};
  const panels = existing.panels && typeof existing.panels === 'object' ? existing.panels : {};

  if (!panels.default) {
    const legacyConfig = { ...baseConfig(), ...(existing.config || {}) };
    legacyConfig.messages = { ...baseConfig().messages, ...(existing.config?.messages || {}) };
    legacyConfig.reasons = existing.config?.reasons || {};
    panels.default = {
      config: legacyConfig,
      tickets: existing.tickets || {},
      pendingRequests: existing.pendingRequests || {}
    };
  }

  const defaultPanel = panels.default || { config: baseConfig(), tickets: {}, pendingRequests: {} };
  return {
    store,
    guild: {
      panels,
      config: defaultPanel.config,
      tickets: defaultPanel.tickets || {},
      pendingRequests: defaultPanel.pendingRequests || {}
    }
  };
}

function setGuildData(guildId, config, tickets, pendingRequests = {}, panelId = 'default') {
  const store = loadStore();
  const existing = store[guildId] || {};
  const panels = existing.panels && typeof existing.panels === 'object' ? existing.panels : {};
  panels[panelId] = { config, tickets, pendingRequests };
  store[guildId] = { ...existing, panels };
  saveStore(store);
}

function getPanelData(guildId, panelId = 'default') {
  const { guild } = getGuildData(guildId);
  const panel = guild.panels[panelId] || { config: baseConfig(), tickets: {}, pendingRequests: {} };
  const config = { ...baseConfig(), ...(panel?.config || {}) };
  config.messages = { ...baseConfig().messages, ...(panel?.config?.messages || {}) };
  config.reasons = panel?.config?.reasons || {};
  const tickets = panel?.tickets || {};
  const pendingRequests = panel?.pendingRequests || {};
  return { config, tickets, pendingRequests };
}

function exportPanelSnapshot(guildId, panelId = 'default') {
  const { config } = getPanelData(guildId, panelId);
  return Buffer.from(JSON.stringify({
    version: 1,
    panelId,
    exportedAt: new Date().toISOString(),
    config
  }, null, 2), 'utf8').toString('base64');
}

function importPanelSnapshot(guildId, panelId, encoded, preserveRuntime = true) {
  const decoded = Buffer.from(String(encoded || ''), 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.config !== 'object') throw new Error('SNAPSHOT_INVALID');
  const current = getPanelData(guildId, panelId);
  const nextConfig = { ...baseConfig(), ...parsed.config };
  nextConfig.messages = { ...baseConfig().messages, ...(parsed.config.messages || {}) };
  nextConfig.reasons = parsed.config.reasons || {};
  if (preserveRuntime) {
    nextConfig.counter = current.config.counter || nextConfig.counter;
    nextConfig.panelMessageId = current.config.panelMessageId || nextConfig.panelMessageId;
  }
  setGuildData(guildId, nextConfig, current.tickets, current.pendingRequests, panelId);
  return nextConfig;
}

function findTicketPanel(guildId, channelId, preferredPanelId = 'default') {
  const { guild } = getGuildData(guildId);
  if (guild.panels?.[preferredPanelId]?.tickets?.[channelId]) return preferredPanelId;
  const entries = Object.entries(guild.panels || {});
  for (const [pid, panel] of entries) {
    if (panel?.tickets?.[channelId]) return pid;
  }
  return preferredPanelId;
}

function getTicketContext(guildId, channelId, preferredPanelId = 'default') {
  const panelId = findTicketPanel(guildId, channelId, preferredPanelId || 'default');
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
  const ticket = tickets[channelId] || null;
  return { panelId, config, tickets, pendingRequests, ticket };
}

function getTicketContextFromInteraction(guildId, interaction, channelId, preferredPanelId = 'default') {
  const parsedChannelId = String(channelId || '').trim() || interaction.channelId;
  let context = getTicketContext(guildId, parsedChannelId, preferredPanelId || 'default');

  if (!context.ticket && interaction?.channelId && interaction.channelId !== parsedChannelId) {
    context = getTicketContext(guildId, interaction.channelId, preferredPanelId || context.panelId || 'default');
  }

  return {
    ...context,
    actionChannelId: context.ticket ? (context.ticket.channelId || interaction.channelId || parsedChannelId) : parsedChannelId
  };
}

function findPendingRequestContext(guildId, reqId, preferredPanelId = 'default') {
  const direct = getPanelData(guildId, preferredPanelId || 'default');
  if (direct.pendingRequests?.[reqId]) {
    return { panelId: preferredPanelId || 'default', ...direct, req: direct.pendingRequests[reqId] };
  }

  const { guild } = getGuildData(guildId);
  for (const [panelId, panel] of Object.entries(guild.panels || {})) {
    const pendingRequests = panel?.pendingRequests || {};
    if (pendingRequests[reqId]) {
      const { config, tickets, pendingRequests: resolvedPendingRequests } = getPanelData(guildId, panelId);
      return { panelId, config, tickets, pendingRequests: resolvedPendingRequests, req: resolvedPendingRequests[reqId] };
    }
  }

  return null;
}

function touchTicketActivity(ticket, timestamp = Date.now()) {
  if (!ticket || ticket.status !== 'open') return false;
  ticket.lastActivityAt = timestamp;
  delete ticket.autoCloseWarningSentAt;
  return true;
}

function getTicketAutoCloseMs(config) {
  if (!config?.autoCloseEnabled) return 0;
  const hours = Number(config.autoCloseHours || 0);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.round(hours * 60 * 60 * 1000);
}

function getTicketDueAt(ticket, config) {
  const timeoutMs = getTicketAutoCloseMs(config);
  if (!timeoutMs) return 0;
  const base = Number(ticket?.lastActivityAt || ticket?.createdAt || Date.now());
  return base + timeoutMs;
}

function getConfiguredResponsibleRoleIds(config, guild, ticket = null) {
  const sourceRoleIds = Array.isArray(ticket?.transferredRoleIds) && ticket.transferredRoleIds.length
    ? ticket.transferredRoleIds
    : (config.responsibleRoleIds || []);

  return [...new Set(sourceRoleIds.map((id) => String(id)))]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild?.roles?.cache?.has(id));
}

function getGeneralResponsibleRoleIds(config, guild) {
  return [...new Set((config?.responsibleRoleIds || []).map((id) => String(id)))]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild?.roles?.cache?.has(id));
}

function getActiveResponsibleRoleIds(config, guild, ticket = null) {
  const generalRoleIds = (config?.responsibleRoleIds || []).map((id) => String(id || '').trim());
  const transferredRoleIds = Array.isArray(ticket?.transferredRoleIds) ? ticket.transferredRoleIds.map((id) => String(id || '').trim()) : [];
  return [...new Set([...generalRoleIds, ...transferredRoleIds])]
    .filter((id) => /^\d{16,20}$/.test(id) && guild?.roles?.cache?.has(id));
}

function getClosedTicketViewerTargets(config, ticket, guild) {
  const roleIds = getGeneralResponsibleRoleIds(config, guild);
  const userIds = [];

  return { roleIds, userIds };
}

function normalizeId(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(?:<@&?|<#)?(\d{16,20})>?$/);
  return match ? match[1] : null;
}

function extractChannelId(input) {
  if (!input) return null;
  const normalized = normalizeId(input);
  if (normalized) return normalized;
  const any = String(input).match(/(\d{16,20})/);
  return any ? any[1] : null;
}

function normalizeResponsibilityInput(input) {
  return String(input || '')
    .replace(/[\u0640]/g, '')
    .replace(/[\u061F\?\!\,\.\:\;\-\_\=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractResponsibilityNameFromInput(input) {
  const normalized = normalizeResponsibilityInput(input);
  if (!normalized) return null;

  const patterns = [
    /^مسؤول(?:ية|يه)?\s+(.*)$/i,
    /^المسؤول(?:ية|يه)?\s+(.*)$/i,
    /^responsibility\s+(.*)$/i,
    /^resp\s+(.*)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return normalized;
}

function findResponsibilityByName(rawName, responsibilities = {}) {
  const candidate = extractResponsibilityNameFromInput(rawName);
  if (!candidate) return null;
  const entries = Object.entries(responsibilities || {});
  if (!entries.length) return null;

  const exact = entries.find(([name]) => normalizeResponsibilityInput(name) === candidate);
  if (exact) return exact[0];

  const contains = entries.find(([name]) => normalizeResponsibilityInput(name).includes(candidate));
  if (contains) return contains[0];

  return null;
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[left.length][right.length];
}

function searchResponsibilitiesByName(rawQuery, responsibilities = {}, limit = 10) {
  const query = normalizeResponsibilityInput(rawQuery);
  if (!query) return [];

  return Object.keys(responsibilities || {})
    .map((name) => {
      const normalized = normalizeResponsibilityInput(name);
      const exact = normalized === query;
      const startsWith = normalized.startsWith(query);
      const includes = normalized.includes(query);
      const distance = levenshteinDistance(query, normalized);
      return {
        name,
        score: exact ? 1000 : startsWith ? 700 : includes ? 400 : Math.max(0, 250 - distance * 10)
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ar'))
    .slice(0, limit)
    .map((entry) => entry.name);
}

function createResponsibilitySearchSession({ guildId, panelId, channelId, query, results }) {
  const sessionId = `${guildId}_${panelId}_${channelId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  ticketSearchSessions.set(sessionId, {
    guildId,
    panelId,
    channelId,
    query,
    results,
    createdAt: Date.now()
  });
  return sessionId;
}

function buildResponsibilitySearchResultsMessage(sessionId, responsibilities, page = 0) {
  const session = ticketSearchSessions.get(sessionId);
  if (!session) return null;
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(session.results.length / perPage));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = session.results.slice(safePage * perPage, (safePage + 1) * perPage);
  const allNames = Object.keys(responsibilities || {});
  const options = slice.map((name) => {
    const index = allNames.indexOf(name);
    const count = Array.isArray(responsibilities?.[name]?.responsibles) ? responsibilities[name].responsibles.length : 0;
    return {
      label: name.slice(0, 100),
      value: `respidx_${index}`,
      description: `عدد المسؤولين: ${count}`
    };
  });
  return {
    page: safePage,
    totalPages,
    payload: {
      ...buildTicketMessagePayload('نتائج البحث', `**نتائج البحث عن :** ${session.query}\n**الصفحة:** ${safePage + 1}/${totalPages}\n**اختر المسؤولية ثم أكد التحويل.**`, { ephemeral: true }),
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_transfer_confirm_${session.guildId}_${session.panelId}_${session.channelId}`)
            .setPlaceholder('اختر المسؤولية المطلوبة')
            .addOptions(options.slice(0, 25))
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket_transfer_search_page_${sessionId}_${safePage - 1}`)
            .setLabel('السابق')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage <= 0),
          new ButtonBuilder()
            .setCustomId(`ticket_transfer_search_page_${sessionId}_${safePage + 1}`)
            .setLabel('التالي')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage + 1 >= totalPages)
        )
      ]
    }
  };
}

function createMainEmbed(config, guildName) {
  return colorManager.createEmbed()
    .setTitle(`**إعدادات التكت : ${guildName}**`)
    .setDescription([
      '**اكتب رقم الخيار من 1 الى 14 أو اكتب خروج.**',
      '**1** - **اسم شات التكت**',
      '**2** - **الكاتوقري عند فتح التكت**',
      '**3** - **تحديد المسؤولين**',
      '**4** - **تحديد رولات الادمن**',
      '**5** - **كولداون الاداري (حد الاستلام المفتوح)**',
      '**6** - **كولداون العضو (حد التكت المفتوح)**',
      '**7** - **انشاء التكت قبل الاستلام (toggle)**',
      '**8** - **اخفاء التكت عند الاستلام (toggle)**',
      '**9** - **الاستلام من شات مخصص (toggle + اعدادات)**',
      '**10** - **اقفال التكت والاحتفاظ به (toggle)**',
      '**11** - **اعدادات الرسائل**',
      '**12** - **تعيين الاسباب (1 - 25)**',
      '**13** - **طريقة العرض (buttons / menu)**',
      '**14** - **ارسال بانل التكت**'
    ].join('\n'))
    .addFields(
      { name: '**الاسم**', value: `**${config.ticketNamePrefix}** - **${config.ticketNameMode}**`, inline: true },
      { name: '**طريقة العرض**', value: `**${config.displayMode}**`, inline: true },
      { name: '**الاسباب**', value: `**${Object.keys(config.reasons || {}).length}**`, inline: true }
    );
}

function getAdminRoles(config, reasonKey = null) {
  const reason = reasonKey !== null && reasonKey !== undefined ? config?.reasons?.[String(reasonKey)] : null;
  if (reason?.useCustomAdminRoles) {
    return (reason.adminRoleIds || []).map((id) => String(id));
  }
  if (!config.useGlobalAdminRoles) return (config.adminRoleIds || []).map((id) => String(id));
  try {
    const fromFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'adminRoles.json'), 'utf8'));
    return Array.isArray(fromFile) ? fromFile.map((id) => String(id)) : [];
  } catch {
    return [];
  }
}

function countOpenMemberTickets(tickets, userId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.memberId === userId).length;
}

function countPendingMemberRequests(pendingRequests, userId) {
  return Object.values(pendingRequests || {}).filter((req) => req?.userId === userId).length;
}

function countClaimedByAdmin(tickets, adminId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.claimedBy === adminId).length;
}

function prunePendingRequests(pendingRequests, maxAgeMs = 2 * 60 * 60 * 1000) {
  const now = Date.now();
  let changed = false;
  for (const [reqId, req] of Object.entries(pendingRequests || {})) {
    const createdAt = Number(req?.createdAt || 0);
    const updatedAt = Number(req?.updatedAt || createdAt || 0);
    const isClaimed = Boolean(req?.claimedAt);
    if (!createdAt || (!isClaimed && now - updatedAt > maxAgeMs)) {
      delete pendingRequests[reqId];
      changed = true;
    }
  }
  return changed;
}

function hasStaffAccess(member, config, reasonKey = null, ticket = null) {
  if (member?.user?.bot || member?.bot) return true;
  if (resolveTicketBlockForMember(member?.guild?.id, member)) return false;
  const adminRoles = getAdminRoles(config, reasonKey);
  const responsibleRoles = ((Array.isArray(ticket?.transferredRoleIds) && ticket.transferredRoleIds.length)
    ? ticket.transferredRoleIds
    : (config.responsibleRoleIds || [])).map((id) => String(id));
  let roleIds = [];

  if (member?.roles?.cache) roleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) roleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) roleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) roleIds = member.roles.ids;

  roleIds = roleIds.map((id) => String(id));
  const hasRole = roleIds.some((id) => adminRoles.includes(id) || responsibleRoles.includes(id));
  return hasRole;
}

function hasResponsibleTicketAccess(member, config, guild, ticket = null) {
  if (resolveTicketBlockForMember(guild?.id, member)) return false;
  const allowedRoleIds = getActiveResponsibleRoleIds(config, guild, ticket);
  let memberRoleIds = [];
  const memberUserId = String(member?.id || member?.user?.id || '');
  const transferredUserIds = Array.isArray(ticket?.transferredUserIds) ? ticket.transferredUserIds.map((id) => String(id || '').trim()) : [];

  if (member?.roles?.cache) memberRoleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) memberRoleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) memberRoleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) memberRoleIds = member.roles.ids;

  memberRoleIds = memberRoleIds.map((id) => String(id));
  if (memberUserId && transferredUserIds.includes(memberUserId)) return true;
  return memberRoleIds.some((id) => allowedRoleIds.includes(id));
}

function canManageTicket(interaction, ticket, config) {
  if (interaction.user.id === ticket.claimedBy) return true;
  return hasResponsibleTicketAccess(interaction.member, config, interaction.guild, ticket);
}

function canManagePostCloseControls(interaction, ticket, config) {
  if (resolveTicketBlockForMember(interaction.guild?.id, interaction.member)) return false;
  const allowedRoleIds = getGeneralResponsibleRoleIds(config, interaction.guild);
  const memberRoleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()].map((id) => String(id)) : [];
  return memberRoleIds.some((id) => allowedRoleIds.includes(id));
}

function getGuildResponsibleRoleIds(guildId, guild) {
  const { guild: guildData } = getGuildData(guildId);
  const roleIds = new Set();
  for (const panel of Object.values(guildData?.panels || {})) {
    for (const roleId of panel?.config?.responsibleRoleIds || []) {
      const normalized = String(roleId || '').trim();
      if (/^\d{16,20}$/.test(normalized) && guild?.roles?.cache?.has(normalized)) {
        roleIds.add(normalized);
      }
    }
  }
  return [...roleIds];
}

function canUseGeneralPointsCommand(member, guildId, guild) {
  if (resolveTicketBlockForMember(guildId, member)) return false;
  const allowedRoleIds = getGuildResponsibleRoleIds(guildId, guild);
  let memberRoleIds = [];
  if (member?.roles?.cache) memberRoleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) memberRoleIds = member.roles;
  return memberRoleIds.map((id) => String(id)).some((id) => allowedRoleIds.includes(id));
}

function hasGlobalAdminAccess(member, message, BOT_OWNERS = [], ADMIN_ROLES = []) {
  if (!member || !message?.guild) return false;
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (isOwner) return true;
  return member.roles?.cache?.some?.((role) => ADMIN_ROLES.includes(role.id)) || false;
}

function getTicketBlockData(guildId) {
  const store = loadStore();
  const guildEntry = store[guildId] || {};
  const blocks = Array.isArray(guildEntry.ticketBlocks) ? guildEntry.ticketBlocks : [];
  const blockChannelId = guildEntry.ticketBlockChannelId || null;
  return { store, guildEntry, blocks, blockChannelId };
}

function saveTicketBlockData(guildId, { blocks, blockChannelId }) {
  const store = loadStore();
  const guildEntry = store[guildId] || {};
  store[guildId] = {
    ...guildEntry,
    ticketBlocks: Array.isArray(blocks) ? blocks : [],
    ticketBlockChannelId: blockChannelId || null
  };
  saveStore(store);
}

function pruneTicketBlocks(blocks = [], now = Date.now()) {
  return (Array.isArray(blocks) ? blocks : []).filter((entry) => !entry?.expiresAt || Number(entry.expiresAt) > now);
}

function resolveTicketBlockForMember(guildId, member) {
  if (!guildId || !member) return null;
  const { blocks } = getTicketBlockData(guildId);
  const activeBlocks = pruneTicketBlocks(blocks);
  const memberId = String(member.id || member.user?.id || '');
  const roleIds = member.roles?.cache ? [...member.roles.cache.keys()].map((id) => String(id)) : [];
  return activeBlocks.find((entry) => {
    const targetId = String(entry?.targetId || '');
    if (entry?.targetType === 'user') return targetId === memberId;
    if (entry?.targetType === 'role') return roleIds.includes(targetId);
    return false;
  }) || null;
}

function formatBlockDuration(expiresAt) {
  if (!expiresAt) return 'بدون مدة';
  return `<t:${Math.floor(Number(expiresAt) / 1000)}:R>`;
}

function formatBlockDurationText(expiresAt) {
  if (!expiresAt) return 'بدون مدة (دائم)';
  return `حتى <t:${Math.floor(Number(expiresAt) / 1000)}:F> (${formatBlockDuration(expiresAt)})`;
}

async function syncTicketBlocks(guildId) {
  const data = getTicketBlockData(guildId);
  const cleaned = pruneTicketBlocks(data.blocks);
  if (cleaned.length !== data.blocks.length) {
    saveTicketBlockData(guildId, { blocks: cleaned, blockChannelId: data.blockChannelId });
  }
  return cleaned;
}

async function logTicketBlockAction(guild, actor, blockEntry, action = 'block') {
  if (!guild || !blockEntry) return false;
  const { blockChannelId } = getTicketBlockData(guild.id);
  if (!blockChannelId) return false;
  const channel = guild.channels.cache.get(blockChannelId) || await guild.channels.fetch(blockChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  const targetMention = blockEntry.targetType === 'role' ? `<@&${blockEntry.targetId}>` : `<@${blockEntry.targetId}>`;
  const embed = makeTicketEmbed(
    action === 'unblock' ? 'فك بلوك تكت' : 'بلوك تكت',
    [
      `**الهدف :** ${targetMention}`,
      `**النوع :** ${blockEntry.targetType === 'role' ? 'رول' : 'عضو'}`,
      `**المدة :** ${formatBlockDuration(blockEntry.expiresAt)}`,
      `**السبب :** ${blockEntry.reason || 'بدون سبب'}`,
      `**الوقت :** <t:${Math.floor(Number(blockEntry.createdAt || Date.now()) / 1000)}:F>`,
      `**بواسطة :** <@${actor.id}>`
    ].join('\n'),
    { user: actor }
  );
  await channel.send({ embeds: [embed] }).catch(() => {});
  return true;
}

async function notifyTicketBlockTarget(guild, actor, blockEntry, action = 'block') {
  if (!guild || !actor || !blockEntry || blockEntry.targetType !== 'user') return false;
  const user = await guild.client.users.fetch(blockEntry.targetId).catch(() => null);
  if (!user) return false;

  const description = action === 'unblock'
    ? [
      '**تم فك حظر التكت عنك.**',
      `**بواسطة:** <@${actor.id}>`,
      `**الوقت:** <t:${Math.floor(Date.now() / 1000)}:F>`
    ].join('\n')
    : [
      '**تم حظرك من نظام التكت.**',
      `**المدة:** ${formatBlockDurationText(blockEntry.expiresAt)}`,
      `**السبب:** ${blockEntry.reason || 'بدون سبب'}`,
      `**بواسطة:** <@${actor.id}>`,
      `**الوقت:** <t:${Math.floor(Number(blockEntry.createdAt || Date.now()) / 1000)}:F>`
    ].join('\n');

  await user.send(buildTicketMessagePayload(action === 'unblock' ? 'فك حظر التكت' : 'حظر التكت', description, { user: actor })).catch(() => {});
  return true;
}

function canUserWriteInTicket(message, ticket, config) {
  const userId = message.author?.id;
  if (!userId || message.author?.bot) return true;
  if (resolveTicketBlockForMember(message.guild?.id, message.member)) return false;
  if (!ticket) return true;
  if (ticket.memberId === userId) return true;
  if (ticket.claimedBy === userId) return true;
  if (Array.isArray(ticket.extraMembers) && ticket.extraMembers.includes(userId)) return true;
  return hasResponsibleTicketAccess(message.member, config, message.guild, ticket);
}

async function deleteClaimMessageIfEnabled(interaction, config) {
  if (!config?.deleteClaimMessageOnClaim || !interaction?.message?.id) return false;
  const directDelete = await interaction.message.delete().then(() => true).catch(() => false);
  if (directDelete) return true;
  const fallbackChannel = interaction.channel
    || interaction.guild?.channels?.cache?.get?.(interaction.message.channelId)
    || await interaction.guild?.channels?.fetch?.(interaction.message.channelId).catch(() => null);
  if (!fallbackChannel?.messages?.delete) return false;
  return fallbackChannel.messages.delete(interaction.message.id).then(() => true).catch(() => false);
}

function normalizeMessageRefs(refs = []) {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => ({
      channelId: String(ref?.channelId || '').trim(),
      messageId: String(ref?.messageId || '').trim()
    }))
    .filter((ref) => /^\d{16,20}$/.test(ref.channelId) && /^\d{16,20}$/.test(ref.messageId));
}

async function deleteTrackedMessages(guild, refs = [], preserveMessageId = null) {
  const normalized = normalizeMessageRefs(refs)
    .filter((ref) => !preserveMessageId || ref.messageId !== String(preserveMessageId));
  if (!normalized.length || !guild) return false;

  let deletedAny = false;
  for (const ref of normalized) {
    const channel = guild.channels?.cache?.get?.(ref.channelId)
      || await guild.channels?.fetch?.(ref.channelId).catch(() => null);
    if (!channel?.messages?.delete) continue;
    const deleted = await channel.messages.delete(ref.messageId).then(() => true).catch(() => false);
    if (deleted) deletedAny = true;
  }

  return deletedAny;
}

async function recordUnauthorizedTicketMessage(message, ticket, config) {
  if (!message?.guild || !ticket || !config) return;
  await syncTicketLogMessage({
    guild: message.guild,
    config,
    ticket,
    channelId: message.channelId || message.channel?.id,
    actionText: {
      type: 'unauthorized_message',
      message: `تم حذف رسالة غير مصرح بها من : <@${message.author?.id || 'unknown'}>`,
      actorId: message.author?.id || null,
      metadata: {
        snippet: String(message.content || '').slice(0, 180)
      }
    },
    actor: message.author || null
  }).catch(() => {});
}

function rememberDeletedTicketMessage(ticket, message) {
  if (!ticket || !message) return false;
  if (!Array.isArray(ticket.deletedMessages)) ticket.deletedMessages = [];
  if (message.id && ticket.deletedMessages.some((entry) => entry?.id === message.id)) return false;
  const avatarUrl = message.author?.displayAvatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || message.author?.avatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || message.author?.avatarURL?.()
    || null;
  ticket.deletedMessages.push({
    id: message.id || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    authorId: message.author?.id || null,
    authorTag: message.author?.tag || null,
    authorName: message.author?.username || null,
    avatarUrl,
    content: String(message.content || ''),
    createdTimestamp: Number(message.createdTimestamp || Date.now()),
    deletedAt: Date.now()
  });
  if (ticket.deletedMessages.length > 100) ticket.deletedMessages = ticket.deletedMessages.slice(-100);
  return true;
}

function isAdminOnly(interaction, config, reasonKey = null) {
  const adminRoles = getAdminRoles(config, reasonKey);
  const roleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
  const hasAdminRole = roleIds.some((id) => adminRoles.includes(id));
  return hasAdminRole;
}

function sanitizeName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\-\_\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 90);
}

async function buildTicketControls(guildId, panelId, channelId, config, options = {}) {
  const includeClaimButton = options.includeClaimButton !== false && !options.disableClaimButton;
  const includeReassignButton = options.hideReassignButton !== true;
  const row1Buttons = [];
  if (includeClaimButton) row1Buttons.push(new ButtonBuilder().setCustomId(`ticket_claim_${guildId}_${panelId}_${channelId}`).setLabel('استلام').setStyle(ButtonStyle.Success));
  row1Buttons.push(
    new ButtonBuilder().setCustomId(`ticket_close_${guildId}_${panelId}_${channelId}`).setLabel('اقفال').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_rename_${guildId}_${panelId}_${channelId}`).setLabel('تغيير الاسم').setStyle(ButtonStyle.Secondary)
  );
  if (includeReassignButton) {
    row1Buttons.push(new ButtonBuilder().setCustomId(`ticket_reassign_${guildId}_${panelId}_${channelId}`).setLabel('تغيير المستلم').setStyle(ButtonStyle.Success));
  }
  const row1 = new ActionRowBuilder().addComponents(row1Buttons);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_add_${guildId}_${panelId}_${channelId}`).setLabel('اضافة شخص').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_remove_${guildId}_${panelId}_${channelId}`).setLabel('ازالة شخص').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_ping_${guildId}_${panelId}_${channelId}`).setLabel('استدعاء العضو').setStyle(ButtonStyle.Primary)
  );

  const responsibilities = loadResponsibilities();
  const allResponsibilityNames = Object.keys(responsibilities);
  const canSearchResponsibilities = allResponsibilityNames.length > 25;
  const responsibilityNames = canSearchResponsibilities ? allResponsibilityNames.slice(0, 24) : allResponsibilityNames.slice(0, 25);
  const responsibilityOptions = responsibilityNames
    .map((respName, index) => {
      const count = Array.isArray(responsibilities?.[respName]?.responsibles)
        ? responsibilities[respName].responsibles.length
        : 0;
      const originalIndex = allResponsibilityNames.indexOf(respName);
      return {
        label: respName.slice(0, 100),
        value: `respidx_${originalIndex}`,
        description: `عدد المسؤولين: ${count}`
      };
    });
  if (canSearchResponsibilities) {
    responsibilityOptions.push({
      label: 'بحث بالاسم',
      value: 'resp_search',
      description: 'ابحث عن المسؤولية بالاسم ثم أكد الاختيار'
    });
  }

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ticket_transfer_${guildId}_${panelId}_${channelId}`)
      .setPlaceholder('اختر مسؤولية لتحويل التكت')
      .addOptions(responsibilityOptions.length ? responsibilityOptions : [{ label: 'لا توجد مسؤوليات', value: 'resp_none' }])
      .setDisabled(responsibilityOptions.length === 0)
  );

  return [row1, row2, row3];
}

async function createTicketChannel({ guild, member, config, reasonKey, tickets, pendingRequests, includeClaimButton = true, panelId = 'default', openModalAnswers = null }) {
  const reasonSettings = getReasonVisualSettings(config, reasonKey);
  const reason = reasonSettings.reason;
  const prefix = sanitizeName(reason.ticketName || config.ticketNamePrefix || 'ticket') || 'ticket';
  const memberId = member?.id || member?.user?.id || null;
  if (!memberId) {
    throw new Error('MEMBER_ID_MISSING');
  }

  const memberUsername = member?.user?.username || member?.displayName || 'user';
  const suffix = config.ticketNameMode === 'user' ? sanitizeName(memberUsername) : String(config.counter || 1);
  const channelName = `${prefix}-${suffix}`.slice(0, 90);
  const categoryId = reason.categoryId || config.openCategoryId || null;

  const shouldExposeAdminRolesUntilClaim = includeClaimButton && !config.claimFromDedicatedChannel;
  const bootstrapStaffRoles = shouldExposeAdminRolesUntilClaim
    ? [...new Set([...(config.responsibleRoleIds || []), ...getAdminRoles(config, reasonKey)])]
    : [...new Set([...(config.responsibleRoleIds || [])])];
  const allowedStaffRoles = bootstrapStaffRoles
    .map((roleId) => String(roleId || '').trim())
    .filter((roleId) => /^\d{16,20}$/.test(roleId) && guild.roles.cache.has(roleId));

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: memberId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];

  for (const roleId of allowedStaffRoles) {
    permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites
  });

  const controls = await buildTicketControls(guild.id, panelId, channel.id, config, { includeClaimButton });

  const introText = renderTicketText(reasonSettings.beforeText, memberId);
  const openImage = resolveImageForSend(reasonSettings.openImage);
  await channel.send({
    ...(introText ? { content: introText } : {}),
    ...(openImage ? { files: [openImage] } : {}),
    components: controls
  }).catch(() => {});

  const outroText = renderTicketText(reasonSettings.afterText, memberId);
  if (outroText) await channel.send({ content: outroText }).catch(() => {});

  if (config.ticketNameMode !== 'user') config.counter = (config.counter || 1) + 1;

  tickets[channel.id] = {
    channelId: channel.id,
    panelId,
    memberId,
    reasonKey,
    claimedBy: null,
    status: 'open',
    extraMembers: [],
    logMessageId: null,
    logHistory: [],
    logEvents: [],
    deletedMessages: [],
    openModalAnswers: openModalAnswers && typeof openModalAnswers === 'object' ? openModalAnswers : undefined,
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };

  await syncTicketLogMessage({
    guild,
    config,
    ticket: tickets[channel.id],
    channelId: channel.id,
    actionText: `تم فتح التكت عن طريق : <@${memberId}>`,
    actor: member?.user || null
  });

  setGuildData(guild.id, config, tickets, pendingRequests, panelId);
  return channel;
}

async function applyHideOnClaim(channel, guild, config, claimerId, memberId, extraMembers = [], reasonKey = null) {
  const adminRoles = getAdminRoles(config, reasonKey)
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild.roles.cache.has(id));
  const configuredStaffRoles = [...new Set([...(config.responsibleRoleIds || [])])]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild.roles.cache.has(id));
  const visibleStaffRoles = [...configuredStaffRoles];
  const allStaffRoles = [...new Set([...adminRoles, ...configuredStaffRoles])];

  await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: false
  }).catch(() => {});

  for (const roleId of allStaffRoles) {
    const shouldSee = visibleStaffRoles.includes(roleId);
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: shouldSee
    }).catch(() => {});
  }

  await channel.permissionOverwrites.edit(claimerId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch(() => {});

  await channel.permissionOverwrites.edit(memberId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch(() => {});

  for (const userId of extraMembers) {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});
  }
}

async function handleOpenRequest(interaction, guildId, panelId, reasonKey) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  if (resolveTicketBlockForMember(guildId, interaction.member)) {
    await interaction.editReply(buildTicketMessagePayload('بلوك التكت', '**أنت محظور من استخدام نظام التكت حالياً.**'));
    return;
  }
  const pruned = prunePendingRequests(pendingRequests);
  if (pruned) setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

  if (!config.autoCreateOnRequest && !config.claimFromDedicatedChannel && !interaction.channelId) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا يمكن إنشاء طلب الاستلام بدون شات صالح.**'));
    return;
  }

  if (!config.autoCreateOnRequest && config.claimFromDedicatedChannel && !config.claimChannelId) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا يمكن فتح الطلب الآن: شات الاستلام المخصص غير محدد.**'));
    return;
  }

  const openCount = countOpenMemberTickets(tickets, interaction.user.id);
  const pendingCount = countPendingMemberRequests(pendingRequests, interaction.user.id);
  if ((openCount + pendingCount) >= (config.memberOpenLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', `**الحد : وصلت لاقصى تكت مفتوح (${config.memberOpenLimit}).**`));
    return;
  }

  if (config.autoCreateOnRequest) {
    try {
      const channel = await createTicketChannel({ guild, member: interaction.member, config, reasonKey, tickets, pendingRequests, panelId: panelId || 'default', openModalAnswers: interaction.ticketModalAnswers || null });
      await interaction.editReply(buildTicketMessagePayload('تم', `**تم انشاء التكت :** <#${channel.id}>`));
    } catch (error) {
      console.error('ticket open create channel error:', error?.message || error);
      await interaction.editReply(buildTicketMessagePayload('خطأ', '**فشل فتح التكت، تأكد من صلاحيات البوت والكاتوقري.**'));
    }
    return;
  }

  const reqId = `${guildId}_${panelId || 'default'}_${interaction.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const duplicateRequest = Object.values(pendingRequests)
    .find((req) => req.userId === interaction.user.id && req.panelId === (panelId || 'default') && !req.claimedAt);
  if (duplicateRequest) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**لديك طلب استلام معلّق بالفعل، انتظر حتى تتم معالجته.**'));
    return;
  }
  pendingRequests[reqId] = {
    guildId,
    panelId: panelId || 'default',
    userId: interaction.user.id,
    reasonKey,
    sourceChannelId: interaction.channelId,
    openModalAnswers: interaction.ticketModalAnswers || null,
    claimMessageRefs: [],
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**فشل : شات الاستلام غير صالح.**'));
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimreq_${reqId}`).setStyle(ButtonStyle.Primary).setLabel('استلام التكت')
  );

  const reasonSettings = getReasonVisualSettings(config, reasonKey);
  const reasonData = reasonSettings.reason;
  const claimImage = resolveImageForSend(reasonSettings.claimImage);

  const mentionChunks = buildMentionChunks(getAdminRoles(config, reasonKey));

  for (const chunk of mentionChunks) {
    const sent = await targetChannel.send({ content: chunk }).catch(() => null);
    if (sent?.id) {
      pendingRequests[reqId].claimMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
    }
  }

  const requestSummary = `**العضو :** <@${interaction.user.id}>\n**السبب :** ${reasonData.name || `سبب ${reasonKey}`}${reasonData.description ? `\n**الوصف :** ${reasonData.description}` : ''}`;

  if (claimImage) {
    const sent = await targetChannel.send({ content: requestSummary, files: [claimImage], components: [row] });
    if (sent?.id) {
      pendingRequests[reqId].claimMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
    }
  } else {
    const sent = await targetChannel.send({ content: requestSummary, components: [row] });
    if (sent?.id) {
      pendingRequests[reqId].claimMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
    }
  }

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
  await interaction.editReply(buildTicketMessagePayload('تم', '**تم ارسال طلبك لشات الاستلام.**'));
}

async function handleClaimInTicket(interaction, guildId, panelId, channelId) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const lockKey = `claim:${guildId}:${channelId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**جاري معالجة الاستلام، حاول بعد لحظات.**', { user: interaction.user }));
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket || ticket.status !== 'open' || interaction.channelId !== actionChannelId) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**هذا التكت غير متاح.**', { user: interaction.user }));
    return;
  }

  if (!hasStaffAccess(interaction.member, config, ticket?.reasonKey, ticket)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**ليس لديك صلاحية الاستلام.**', { user: interaction.user }));
    return;
  }

  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', `**التكت مستلم مسبقاً بواسطة :** <@${ticket.claimedBy}>`, { user: interaction.user }));
    return;
  }

  if (ticket.claimedBy === interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**أنت مستلم هذا التكت بالفعل.**', { user: interaction.user }));
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, { user: interaction.user }));
    return;
  }

  ticket.claimedBy = interaction.user.id;
  touchTicketActivity(ticket);
  if (config.hideOnClaim || !config.claimFromDedicatedChannel) {
    await applyHideOnClaim(interaction.channel, interaction.guild, config, interaction.user.id, ticket.memberId, ticket.extraMembers || [], ticket.reasonKey);
  }

  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم الاستلام عن طريق : <@${interaction.user.id}>`,
    actor: interaction.user
  });

  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  if (interaction.message?.components?.length) {
    const updatedRows = interaction.message.components.map((row) => {
      const updatedComponents = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_claim_')) {
          return ButtonBuilder.from(component).setDisabled(true).setLabel('تم الاستلام');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(updatedComponents);
    });
    const mentionChunks = buildMentionChunks(getAdminRoles(config, ticket?.reasonKey));
    const firstChunk = mentionChunks.shift() || null;

    if (config.deleteClaimMessageOnClaim) {
      await deleteClaimMessageIfEnabled(interaction, config);
    } else {
      await interaction.message.edit({
        content: [firstChunk, buildClaimRequestContent(ticket, config, interaction.user.id)].filter(Boolean).join('\n'),
        embeds: [],
        components: updatedRows
      }).catch(() => {});
    }

    for (const chunk of mentionChunks) {
      await interaction.channel.send({ content: chunk }).catch(() => {});
    }
  }

  await interaction.editReply(buildTicketMessagePayload('تم', '**تم استلام التكت بنجاح.**', { user: interaction.user }));
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

async function handleClaimFromRequest(interaction, reqId) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const lockKey = `claimreq:${reqId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**جاري معالجة هذا الطلب، حاول بعد لحظات.**', { user: interaction.user }));
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const [guildId, preferredPanelId = 'default'] = reqId.split('_');
  let requestContext = findPendingRequestContext(guildId, reqId, preferredPanelId);

  if (!requestContext) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**انتهى الطلب.**', { user: interaction.user }));
    return;
  }

  let { panelId, config, tickets, pendingRequests, req } = requestContext;
  const pruned = prunePendingRequests(pendingRequests);
  if (pruned) {
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    requestContext = findPendingRequestContext(guildId, reqId, panelId);
    if (!requestContext) {
      await interaction.editReply(buildTicketMessagePayload('تنبيه', '**انتهى الطلب.**', { user: interaction.user }));
      return;
    }
    ({ panelId, config, tickets, pendingRequests, req } = requestContext);
  }

  if (!hasStaffAccess(interaction.member, config, req?.reasonKey)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**ليس لديك صلاحية الاستلام.**', { user: interaction.user }));
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, { user: interaction.user }));
    return;
  }

  const member = await interaction.guild.members.fetch(req.userId).catch(() => null);
  if (!member) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا يمكن العثور على العضو.**', { user: interaction.user }));
    return;
  }

  let channel;
  req.claimedAt = Date.now();
  req.claimedBy = interaction.user.id;
  req.status = 'claiming';
  req.updatedAt = Date.now();
  setGuildData(guildId, config, tickets, pendingRequests, panelId);
  try {
    channel = await createTicketChannel({
      guild: interaction.guild,
      member,
      config,
      reasonKey: req.reasonKey,
      tickets,
      pendingRequests,
      includeClaimButton: false,
      panelId: req.panelId || panelId,
      openModalAnswers: req.openModalAnswers || null
    });
  } catch (error) {
    req.claimedAt = null;
    req.claimedBy = null;
    req.status = 'pending';
    req.updatedAt = Date.now();
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    console.error('ticket claimreq create channel error:', error?.message || error);
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**فشل انشاء التكت من طلب الاستلام، تأكد من صلاحيات البوت والكاتوقري.**', { user: interaction.user }));
    return;
  }
  tickets[channel.id].claimedBy = interaction.user.id;
  touchTicketActivity(tickets[channel.id]);

  if (config.hideOnClaim) {
    await applyHideOnClaim(channel, interaction.guild, config, interaction.user.id, member.id, tickets[channel.id].extraMembers || [], tickets[channel.id].reasonKey);
  }

  const createdTicket = tickets[channel.id];
  const claimImage = resolveImageForSend(getReasonVisualSettings(config, createdTicket.reasonKey).claimImage);
  await sendClaimAnnounce({ channel, config, ticket: createdTicket, claimerId: interaction.user.id, claimImage });
  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket: createdTicket,
    channelId: channel.id,
    actionText: `تم الاستلام عن طريق : <@${interaction.user.id}>`,
    actor: interaction.user
  });

  if (interaction.message?.editable) {
    const updatedRows = interaction.message.components.map((row) => {
      const components = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_claimreq_')) {
          return ButtonBuilder.from(component).setDisabled(true).setLabel('تم الاستلام');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(components);
    });
    if (config.deleteClaimMessageOnClaim) {
      await deleteTrackedMessages(interaction.guild, req?.claimMessageRefs, interaction.message.id);
      await deleteClaimMessageIfEnabled(interaction, config);
    } else {
      await interaction.message.edit({
        content: buildClaimRequestContent(createdTicket, config, interaction.user.id),
        embeds: [],
        components: updatedRows
      }).catch(() => {});
    }
  }

  delete pendingRequests[reqId];
  setGuildData(guildId, config, tickets, pendingRequests, panelId);
  await interaction.editReply(buildTicketMessagePayload('تم استلام التكت', `**تم الاستلام والانشاء :** <#${channel.id}>`));
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

async function sendAutoCloseWarning(channel, ticket, dueAt) {
  const mentions = [...new Set([ticket?.claimedBy, ticket?.memberId].filter(Boolean))]
    .map((id) => `<@${id}>`)
    .join(' ');

  await channel.send({
    content: mentions || undefined,
    ...buildTicketMessagePayload(
      'تنبيه الإغلاق التلقائي',
      `**هذا التكت سيتم قفله تلقائيًا قريبًا.**\n**موعد الإقفال:** <t:${Math.floor(dueAt / 1000)}:R>\n**أي رسالة جديدة داخل التكت ستعيد المدة من البداية.**`
    )
  }).catch(() => {});
}

async function closeTicketCore({
  channel,
  guildId,
  panelId = 'default',
  channelId,
  config,
  tickets,
  pendingRequests,
  ticket,
  interaction = null,
  closedByLabel = null,
  autoClose = false,
  silentCloseNotice = false
}) {
  if (!ticket || ticket.closedAt) return false;

  ticket.status = 'closed';
  ticket.closedAt = Date.now();
  ticket.deletedChannel = !config.keepClosedTickets;
  ticket.memberHidden = true;
  ticket.claimerHidden = true;
  delete ticket.autoCloseWarningSentAt;

  channel.ticketMeta = ticket;
  const transcriptFile = await buildTicketTranscript(channel).catch(() => null);
  const logTranscriptFile = config.keepClosedTickets ? null : transcriptFile;
  await syncTicketLogMessage({
    guild: channel.guild,
    config,
    ticket,
    channelId,
    actionText: {
      type: autoClose ? 'auto_close' : 'close',
      message: `تم الغلق عن طريق : ${closedByLabel || (autoClose ? 'خمول التكت' : 'غير محدد')}`,
      actorId: interaction?.user?.id || null
    },
    actor: interaction?.user || null,
    transcriptFile: logTranscriptFile
  });
  await finalizeTransferDmNotifications(ticket, channel.guild, closedByLabel || (autoClose ? 'خمول التكت' : 'غير محدد'));

  if (!config.keepClosedTickets) {
    delete tickets[channelId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

    if (interaction) {
      await interaction.reply(buildTicketMessagePayload(
        autoClose ? 'إغلاق تلقائي' : 'اقفال',
        '**سيتم حذف التكت خلال 3 ثواني.**',
        { ephemeral: true }
      )).catch(() => {});
    } else if (!silentCloseNotice) {
      await channel.send(buildTicketMessagePayload('إغلاق تلقائي', `**تم إقفال هذا التكت تلقائيًا${closedByLabel ? ` بواسطة ${closedByLabel}` : ''} وسيتم حذفه خلال 3 ثواني.**`)).catch(() => {});
    }

    setTimeout(() => channel.delete().catch(() => {}), 3000);
    return true;
  }

  if (ticket.memberId) {
    await channel.permissionOverwrites.edit(ticket.memberId, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: false
  }).catch(() => {});

  for (const userId of (ticket.transferredUserIds || [])) {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: true
    }).catch(() => {});
  }

  const { roleIds: visibleRoleIds, userIds: visibleUserIds } = getClosedTicketViewerTargets(config, ticket, channel.guild);
  for (const roleId of visibleRoleIds) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});
  }
  for (const userId of visibleUserIds) {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});
  }

  if (ticket.claimedBy) {
    await channel.permissionOverwrites.edit(ticket.claimedBy, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: true
    }).catch(() => {});
  }

  if (interaction?.message?.editable) {
    await interaction.message.edit({ components: [] }).catch(() => {});
  }

  const closePrefix = `closed-${sanitizeName(config.ticketNamePrefix || 'ticket')}`;
  await channel.setName(`${closePrefix}-${channelId.slice(-4)}`).catch(() => {});
  if (config.closedCategoryId) await channel.setParent(config.closedCategoryId).catch(() => {});

  await channel.send({
    embeds: [makeTicketEmbed(
      'التكت مقفل',
      [
        `**تم إقفال التكت${autoClose ? ' تلقائيًا' : ''}، يمكنك استخدام أزرار الإدارة بالأسفل.**`,
        `**Amdin :** ${ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'غير محدد'}`,
        `**Closer :** ${closedByLabel || (autoClose ? 'خمول التكت' : 'غير محدد')}`,
        `**Member :** ${ticket.memberId ? `<@${ticket.memberId}>` : 'غير محدد'}`
      ].join('\n')
    )],
    components: buildPostCloseControls(guildId, panelId || 'default', channelId, ticket)
  }).catch(() => {});

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

  if (interaction) {
    await interaction.reply(buildTicketMessagePayload(autoClose ? 'إغلاق تلقائي' : 'اقفال', autoClose ? '**تم إقفال التكت تلقائيًا والاحتفاظ به.**' : '**تم اقفال التكت والاحتفاظ به.**', { ephemeral: true })).catch(() => {});
  }

  return true;
}

function resolveCloseContext(guildId, panelId, channelId, actor) {
  const resolved = getTicketContext(guildId, channelId, panelId || 'default');
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket } = resolved;
  if (!ticket) {
    return { error: buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }) };
  }
  if (!canManageTicket(actor, ticket, config)) {
    return { error: buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الاقفال.**', { ephemeral: true }) };
  }
  if (ticket.closedAt) {
    return { error: buildTicketMessagePayload('تنبيه', '**التكت مقفل مسبقاً.**', { ephemeral: true }) };
  }
  return {
    panelId: resolvedPanelId,
    config,
    tickets,
    pendingRequests,
    ticket,
    actionChannelId: ticket?.channelId || channelId
  };
}

async function handleClose(interaction, guildId, panelId, channelId) {
  const resolved = resolveCloseContext(guildId, panelId, channelId, interaction);
  if (resolved.error) {
    await interaction.reply(resolved.error);
    return;
  }
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = resolved;
  if (interaction.channelId !== actionChannelId) {
    await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
    return;
  }
  await closeTicketCore({
    channel: interaction.channel,
    guildId,
    panelId: resolvedPanelId,
    channelId: actionChannelId,
    config,
    tickets,
    pendingRequests,
    ticket,
    interaction,
    closedByLabel: `<@${interaction.user.id}>`
  });
}

async function handleCloseAliasMessage(message) {
  if (!message.guild || !message.channel) return false;
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const resolved = resolveCloseContext(guildId, 'default', channelId, { member: message.member, guild: message.guild, user: message.author });
  if (resolved.error) {
    return false;
  }

  const { panelId, config, tickets, pendingRequests, ticket, actionChannelId } = resolved;
  await closeTicketCore({
    channel: message.channel,
    guildId,
    panelId,
    channelId: actionChannelId,
    config,
    tickets,
    pendingRequests,
    ticket,
    interaction: null,
    closedByLabel: `<@${message.author.id}>`,
    silentCloseNotice: true
  });
  return true;
}

function resolveTicketMessageContext(message) {
  if (!message.guild || !message.channel) {
    return { error: buildTicketMessagePayload('خطأ', '**هذا الأمر يعمل داخل السيرفر فقط.**') };
  }
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const panelId = findTicketPanel(guildId, channelId, 'default');
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, panelId);
  const actionChannelId = ticket?.channelId || channelId;
  if (!ticket || channelId !== actionChannelId) {
    return { error: buildTicketMessagePayload('خطأ', '**يجب استخدام هذا الأمر داخل روم التكت.**') };
  }
  return { guildId, panelId: resolvedPanelId, channelId: actionChannelId, config, tickets, pendingRequests, ticket };
}

function resolveTicketAliasContext(message, { requireOpen = true } = {}) {
  const ctx = resolveTicketMessageContext(message);
  if (ctx.error) return { ok: false, ctx: null };
  if (requireOpen && ctx.ticket?.status !== 'open') return { ok: false, ctx: null };
  return { ok: true, ctx };
}

async function handleRenameAliasMessage(message, newNameRaw) {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: false });
  if (!ok) return false;
  if (!canManageTicket({ user: message.author, member: message.member, guild: message.guild }, ctx.ticket, ctx.config)) {
    return false;
  }
  const newName = sanitizeName(newNameRaw);
  if (!newName) return false;
  await message.channel.setName(newName).catch(() => {});
  await syncTicketLogMessage({
    guild: message.guild,
    config: ctx.config,
    ticket: ctx.ticket,
    channelId: ctx.channelId,
    actionText: `تم تغيير اسم التكت عن طريق : <@${message.author.id}> -> ${newName}`,
    actor: message.author
  });
  return true;
}

async function handleAddRemoveAliasMessage(message, userInput, mode = 'add') {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: false });
  if (!ok) return false;
  const actor = { user: message.author, member: message.member, guild: message.guild };
  if (!canManageTicket(actor, ctx.ticket, ctx.config)) {
    return false;
  }
  const userId = normalizeId(userInput);
  if (!userId) return false;
  if (mode === 'add') {
    if (ctx.ticket.memberId === userId) {
      return false;
    }
    const targetMember = await message.guild.members.fetch(userId).catch(() => null);
    if (!targetMember) return false;
    await message.channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});
    if (!ctx.ticket.extraMembers.includes(userId)) ctx.ticket.extraMembers.push(userId);
    await syncTicketLogMessage({
      guild: message.guild,
      config: ctx.config,
      ticket: ctx.ticket,
      channelId: ctx.channelId,
      actionText: `تمت إضافة شخص عن طريق : <@${message.author.id}> -> <@${userId}>`,
      actor: message.author
    });
    setGuildData(ctx.guildId, ctx.config, ctx.tickets, ctx.pendingRequests, ctx.panelId);
    return true;
  }

  if (ctx.ticket.memberId === userId) {
    return false;
  }
  await message.channel.permissionOverwrites.edit(userId, { ViewChannel: false }).catch(() => {});
  ctx.ticket.extraMembers = (ctx.ticket.extraMembers || []).filter((id) => id !== userId);
  await syncTicketLogMessage({
    guild: message.guild,
    config: ctx.config,
    ticket: ctx.ticket,
    channelId: ctx.channelId,
    actionText: `تمت إزالة شخص عن طريق : <@${message.author.id}> -> <@${userId}>`,
    actor: message.author
  });
  setGuildData(ctx.guildId, ctx.config, ctx.tickets, ctx.pendingRequests, ctx.panelId);
  return true;
}

async function handlePingAliasMessage(message) {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: true });
  if (!ok) return false;
  const actor = { user: message.author, member: message.member, guild: message.guild };
  if (!canManageTicket(actor, ctx.ticket, ctx.config)) {
    return false;
  }
  const cooldownKey = `${message.guild.id}:${ctx.channelId}:${message.author.id}`;
  const last = pingCooldowns.get(cooldownKey) || 0;
  const now = Date.now();
  const cooldownMs = 10 * 60 * 1000;
  if (now - last < cooldownMs) {
    return false;
  }
  const user = await message.client.users.fetch(ctx.ticket.memberId).catch(() => null);
  const link = `https://discord.com/channels/${message.guild.id}/${message.channel.id}`;
  if (user) {
    await user.send(buildTicketMessagePayload('استدعاء للتكت', `**تم استدعاؤك للتكت**\n**الرابط :** ${link}`)).catch(() => {});
  }
  pingCooldowns.set(cooldownKey, now);
  await syncTicketLogMessage({
    guild: message.guild,
    config: ctx.config,
    ticket: ctx.ticket,
    channelId: ctx.channelId,
    actionText: `تم استدعاء العضو عن طريق : <@${message.author.id}>`,
    actor: message.author
  });
  setGuildData(ctx.guildId, ctx.config, ctx.tickets, ctx.pendingRequests, ctx.panelId);
  return true;
}

async function handleReassignAliasMessage(message) {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: true });
  if (!ok) return false;
  const fakeInteraction = {
    guild: message.guild,
    channel: message.channel,
    channelId: message.channel.id,
    user: message.author,
    member: message.member,
    client: message.client,
    deferred: false,
    replied: false,
    deferReply: async () => { fakeInteraction.deferred = true; },
    editReply: async () => { fakeInteraction.replied = true; return null; },
    deleteReply: async () => {}
  };
  return handleReassignRequest(fakeInteraction, message.guild.id, ctx.panelId, ctx.channelId, { silent: true });
}

function buildMemberPointsEmbed({ requester, targetUser, targetId, guildId, targetIsResponsible = false, note = null }) {
  const points = loadPoints();
  const totalPoints = getUserTotalPoints(points, targetId);
  const topAwarder = getTopPointAwarder(points, targetId);
  const managerPoints = getManagerEvaluationCount(points, targetId);
  const { guild: guildData } = getGuildData(guildId);
  let claimedTickets = 0;
  for (const panel of Object.values(guildData?.panels || {})) {
    claimedTickets += Object.values(panel?.tickets || {}).filter((ticket) => ticket?.claimedBy === targetId).length;
  }

  const embed = colorManager.createEmbed()
    .setTitle('نقاط العضو')
    .setDescription(targetIsResponsible
      ? [
        `**العضو:** <@${targetId}>`,
        `**نقاطه كمسؤول:** ${managerPoints}m`,
        `**عدد التكتات المقيمها:** ${managerPoints}`,
        note ? `\n${note}` : null
      ].filter(Boolean).join('\n')
      : [
        `**العضو:** <@${targetId}>`,
        `**التكتات المستلمة:** ${claimedTickets}`,
        `**النقاط الحالية:** ${totalPoints}p`,
        `**أكثر مسؤول عطاه نقاط:** ${topAwarder ? `<@${topAwarder.actorId}> (${topAwarder.total}p)` : 'غير معروف'}`,
        note ? `\n${note}` : null
      ].filter(Boolean).join('\n'))
    .setThumbnail(targetUser?.displayAvatarURL?.({ forceStatic: false, size: 256 }) || null)
    .setFooter({ text: `بواسطة ${requester?.username || requester?.tag || 'System'}` });

  return embed;
}

async function handleMyTicketPointsMessage(message, targetInput = null) {
  const targetId = normalizeId(targetInput) || message.author.id;
  const targetUser = await message.client.users.fetch(targetId).catch(() => null);
  const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
  const targetIsResponsible = targetMember ? canUseGeneralPointsCommand(targetMember, message.guild.id, message.guild) : false;
  const embed = buildMemberPointsEmbed({
    requester: message.author,
    targetUser,
    targetId,
    guildId: message.guild.id,
    targetIsResponsible
  });
  return message.reply({ embeds: [embed] }).catch(() => {});
}

function applyManualPointsDelta({ targetId, actorId, delta }) {
  const points = loadPoints();
  const respName = 'general';
  if (!points[respName] || typeof points[respName] !== 'object') points[respName] = {};
  const existing = points[respName][targetId];
  const total = sumPointBucket(existing);
  const next = Math.max(0, total + delta);
  const actualDelta = next - total;
  const auditId = `${Date.now()}_${actorId}_${targetId}`;
  points[respName][targetId] = { ...(typeof existing === 'object' && existing ? existing : {}), [Date.now()]: actualDelta };
  appendPointAuditEntry(points, {
    id: auditId,
    targetId,
    actorId,
    delta: actualDelta,
    respName,
    source: 'manual_command',
    at: auditId
  });
  savePoints(points);
  return actualDelta;
}

function applyManagerPointsDelta({ targetId, delta }) {
  const points = loadPoints();
  if (!Array.isArray(points.__managerAudit)) points.__managerAudit = [];
  const amount = Math.max(0, Math.abs(Number(delta || 0)));
  if (!amount) return 0;
  if (delta > 0) {
    for (let i = 0; i < amount; i += 1) {
      points.__managerAudit.push({
        ticketKey: `manual_manager_${Date.now()}_${i}`,
        actorId: targetId,
        targetId: targetId,
        source: 'manual_manager',
        at: `${Date.now()}_${i}`
      });
    }
    savePoints(points);
    return amount;
  }

  let removed = 0;
  for (let i = points.__managerAudit.length - 1; i >= 0 && removed < amount; i -= 1) {
    if (String(points.__managerAudit[i]?.actorId || '') === String(targetId)) {
      points.__managerAudit.splice(i, 1);
      removed += 1;
    }
  }
  savePoints(points);
  return -removed;
}

async function handlePointsAdjustMessage(message, args, { BOT_OWNERS = [] } = {}) {
  const actorIsResponsible = canUseGeneralPointsCommand(message.member, message.guild.id, message.guild);
  const actorIsOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (!actorIsResponsible && !actorIsOwner) {
    return message.reply(buildTicketMessagePayload('خطأ', '**هذا الأمر متاح للمسؤولين العامة أو المالك فقط.**')).catch(() => {});
  }

  const targetId = normalizeId(args?.[0]);
  if (!targetId) {
    return message.reply(buildTicketMessagePayload('خطأ', '**الاستخدام:** points <@user|id>')).catch(() => {});
  }
  const targetUser = await message.client.users.fetch(targetId).catch(() => null);
  const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
  const targetIsResponsible = targetMember ? canUseGeneralPointsCommand(targetMember, message.guild.id, message.guild) : false;
  if (targetIsResponsible && !actorIsOwner) {
    return message.reply(buildTicketMessagePayload('خطأ', '**لا يمكن تعديل نقاط المسؤولين إلا بواسطة مالك السيرفر أو بوت أونر.**')).catch(() => {});
  }

  const sessionId = `${message.guild.id}:${message.channel.id}:${message.author.id}:${targetId}:${Date.now()}`;
  pointsAdjustSessions.set(sessionId, { targetId, actorId: message.author.id, targetIsResponsible });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_points_action_add_${sessionId}`).setLabel('إضافة').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_points_action_remove_${sessionId}`).setLabel('إزالة').setStyle(ButtonStyle.Danger)
  );

  const sent = await message.reply({
    embeds: [buildMemberPointsEmbed({ requester: message.author, targetUser, targetId, guildId: message.guild.id, targetIsResponsible, note: '**اختر العملية من الأزرار بالأسفل.**' })],
    components: [actionRow]
  }).catch(() => null);
  if (!sent) return;

  const collector = sent.createMessageComponentCollector({ time: 3 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('خطأ', '**فقط صاحب الأمر يمكنه استخدام الأزرار.**', { ephemeral: true })).catch(() => {});
      return;
    }

    const addPrefix = `ticket_points_action_add_${sessionId}`;
    const removePrefix = `ticket_points_action_remove_${sessionId}`;
    const amountPrefix = `ticket_points_amount_`;
    if (interaction.customId === addPrefix || interaction.customId === removePrefix) {
      const mode = interaction.customId === addPrefix ? 'add' : 'remove';
      pointsAdjustSessions.set(sessionId, { ...(pointsAdjustSessions.get(sessionId) || {}), mode });
      const amountRow = new ActionRowBuilder().addComponents(
        [1, 2, 3, 4, 5].map((value) => new ButtonBuilder()
          .setCustomId(`${amountPrefix}${mode}_${value}_${sessionId}`)
          .setLabel(String(value))
          .setStyle(mode === 'add' ? ButtonStyle.Success : ButtonStyle.Danger))
      );
      await interaction.update({
        embeds: [buildMemberPointsEmbed({ requester: message.author, targetUser, targetId, guildId: message.guild.id, targetIsResponsible, note: `**تم اختيار:** ${mode === 'add' ? 'إضافة' : 'إزالة'}\n**اختر العدد من 1 إلى 5.**` })],
        components: [amountRow]
      }).catch(() => {});
      return;
    }

    if (interaction.customId.startsWith(amountPrefix) && interaction.customId.endsWith(`_${sessionId}`)) {
      const [, , , mode, valueStr] = interaction.customId.split('_');
      const amount = Number(valueStr);
      if (!['add', 'remove'].includes(mode) || !Number.isFinite(amount) || amount <= 0) {
        await interaction.reply(buildTicketMessagePayload('خطأ', '**خيار غير صالح.**', { ephemeral: true })).catch(() => {});
        return;
      }
      const delta = mode === 'remove' ? -Math.abs(amount) : Math.abs(amount);
      const actualDelta = targetIsResponsible
        ? applyManagerPointsDelta({ targetId, delta })
        : applyManualPointsDelta({ targetId, actorId: message.author.id, delta });
      collector.stop('done');
      await interaction.update({
        embeds: [buildMemberPointsEmbed({
          requester: message.author,
          targetUser,
          targetId,
          guildId: message.guild.id,
          targetIsResponsible,
          note: `**✅ تم ${actualDelta >= 0 ? 'إضافة' : 'إزالة'} ${Math.abs(actualDelta)} ${targetIsResponsible ? 'نقطة مسؤول' : 'نقطة'} للعضو:** <@${targetId}>`
        })],
        components: []
      }).catch(() => {});
    }
  });

  collector.on('end', async () => {
    pointsAdjustSessions.delete(sessionId);
    await sent.edit({ components: [] }).catch(() => {});
  });
}

async function handleTopPointsMessage(message, page = 1) {
  const points = loadPoints();
  const entries = getTopPointUsers(points, 1000);
  const safePage = Math.max(1, Number(page || 1));
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageEntries = entries.slice(start, start + pageSize);
  const description = pageEntries.length
    ? pageEntries.map((entry, index) => {
      const rank = start + index + 1;
      const topAwarder = getTopPointAwarder(points, entry.userId);
      return `#${rank} - <@${entry.userId}> : ${entry.total}p\n**اكثر من عطاه نقاط المسؤول:** ${topAwarder ? `<@${topAwarder.actorId}>` : 'غير معروف'}`;
    }).join('\n\n')
    : '**لا توجد نقاط مسجلة حالياً.**';
  const embed = makeTicketEmbed('توب النقاط', description, { user: message.author })
    .setFooter({ text: `الصفحة ${currentPage}/${totalPages} • نقاطك: ${getUserTotalPoints(points, message.author.id)}p` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_top_prev_${message.author.id}_${currentPage}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
    new ButtonBuilder().setCustomId(`ticket_top_next_${message.author.id}_${currentPage}`).setLabel('التالي').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
  );
  const sent = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ time: 5 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('خطأ', '**فقط طالب الأمر يمكنه التحكم بالتصفح.**', { ephemeral: true })).catch(() => {});
      return;
    }
    const isNext = interaction.customId.startsWith('ticket_top_next_');
    const nextPage = Math.min(totalPages, Math.max(1, currentPage + (isNext ? 1 : -1)));
    collector.stop();
    await interaction.update({ components: [] }).catch(() => {});
    await handleTopPointsMessage(message, nextPage);
  });
  collector.on('end', async () => {
    await sent.edit({ components: [] }).catch(() => {});
  });
}

async function handleTopManagersMessage(message, page = 1) {
  const points = loadPoints();
  const entries = getTopManagers(points, 1000);
  const safePage = Math.max(1, Number(page || 1));
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageEntries = entries.slice(start, start + pageSize);
  const description = pageEntries.length
    ? pageEntries.map((entry, index) => `#${start + index + 1} - <@${entry.userId}> : ${entry.total}m`).join('\n\n')
    : '**لا توجد نقاط مسؤولين مسجلة حالياً.**';
  const embed = makeTicketEmbed('توب المسؤولين', description, { user: message.author })
    .setFooter({ text: `الصفحة ${currentPage}/${totalPages} • تقييماتك: ${getManagerEvaluationCount(points, message.author.id)}m` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_tm_prev_${message.author.id}_${currentPage}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
    new ButtonBuilder().setCustomId(`ticket_tm_next_${message.author.id}_${currentPage}`).setLabel('التالي').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
  );
  const sent = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ time: 5 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('خطأ', '**فقط طالب الأمر يمكنه التحكم بالتصفح.**', { ephemeral: true })).catch(() => {});
      return;
    }
    const isNext = interaction.customId.startsWith('ticket_tm_next_');
    const nextPage = Math.min(totalPages, Math.max(1, currentPage + (isNext ? 1 : -1)));
    collector.stop();
    await interaction.update({ components: [] }).catch(() => {});
    await handleTopManagersMessage(message, nextPage);
  });
  collector.on('end', async () => {
    await sent.edit({ components: [] }).catch(() => {});
  });
}

async function handleResetPointsMessage(message, { ownerOnly = false } = {}) {
  const points = loadPoints();
  const adminCount = getTopPointUsers(points, 100000).length;
  const managerCount = getTopManagers(points, 100000).length;
  const actionLabel = ownerOnly ? 'تصفير توب المسؤولين' : 'تصـفير نقاط الإدارة';
  const warning = ownerOnly
    ? `**سيتم حذف توب المسؤولين فقط.**\n**لن يتم حذف نقاط الإدارة العادية.**\n**عدد المسؤولين المتأثرين:** ${managerCount}`
    : `**سيتم حذف نقاط الإدارة العادية فقط.**\n**لن يتم حذف توب المسؤولين.**\n**عدد الإداريين المتأثرين:** ${adminCount}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_reset_confirm_${ownerOnly ? 'manager' : 'admin'}_${message.author.id}`).setLabel('تأكيد').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_reset_cancel_${ownerOnly ? 'manager' : 'admin'}_${message.author.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
  );
  const prompt = await message.reply({ ...buildTicketMessagePayload(actionLabel, warning), components: [row] }).catch(() => null);
  if (!prompt) return;
  const collector = prompt.createMessageComponentCollector({ time: 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('خطأ', '**فقط طالب الأمر يمكنه التأكيد.**', { ephemeral: true })).catch(() => {});
      return;
    }
    if (interaction.customId.startsWith('ticket_reset_cancel_')) {
      collector.stop();
      await interaction.update({ components: [], embeds: [makeTicketEmbed(actionLabel, '**تم إلغاء العملية.**', { user: message.author })] }).catch(() => {});
      return;
    }
    const nextPoints = loadPoints();
    if (ownerOnly) {
      nextPoints.__managerAudit = [];
    } else {
      for (const key of Object.keys(nextPoints)) {
        if (!key.startsWith('__')) delete nextPoints[key];
      }
      nextPoints.__audit = [];
    }
    savePoints(nextPoints);
    collector.stop();
    await interaction.update({
      components: [],
      embeds: [makeTicketEmbed('تم', ownerOnly ? '**تم تصفير توب المسؤولين بنجاح.**' : '**تم تصفير نقاط الإدارة بنجاح.**', { user: message.author })]
    }).catch(() => {});
  });
  collector.on('end', async () => {
    await prompt.edit({ components: [] }).catch(() => {});
  });
}

async function handleTicketBlockListMessage(message, page = 1) {
  const blocks = await syncTicketBlocks(message.guild.id);
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(blocks.length / pageSize));
  const currentPage = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = blocks.slice(start, start + pageSize);
  const embed = makeTicketEmbed('قائمة بلوكات التكت', pageItems.length ? '**قائمة البلوكات الحالية:**' : '**لا توجد بلوكات تكت حالياً.**', { user: message.author })
    .setFooter({ text: `الصفحة ${currentPage}/${totalPages}` });
  for (const entry of pageItems) {
    embed.addFields({
      name: `${entry.targetType === 'role' ? 'رول' : 'عضو'} • ${entry.targetType === 'role' ? `<@&${entry.targetId}>` : `<@${entry.targetId}>`}`,
      value: `**المدة:** ${formatBlockDuration(entry.expiresAt)}\n**السبب:** ${entry.reason || 'بدون سبب'}\n**بواسطة:** <@${entry.actorId}>\n**الوقت:** <t:${Math.floor(Number(entry.createdAt) / 1000)}:F>`,
      inline: false
    });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_block_list_prev_${message.author.id}_${currentPage}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
    new ButtonBuilder().setCustomId(`ticket_block_list_next_${message.author.id}_${currentPage}`).setLabel('التالي').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
  );
  const sent = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ time: 5 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('خطأ', '**فقط طالب الأمر يمكنه التحكم بالتصفح.**', { ephemeral: true })).catch(() => {});
      return;
    }
    const isNext = interaction.customId.startsWith('ticket_block_list_next_');
    collector.stop();
    await interaction.update({ components: [] }).catch(() => {});
    await handleTicketBlockListMessage(message, currentPage + (isNext ? 1 : -1));
  });
  collector.on('end', async () => {
    await sent.edit({ components: [] }).catch(() => {});
  });
}

async function collectTicketBlockPrompt(message, promptText) {
  const prompt = await message.channel.send(buildTicketMessagePayload('بلوك التكت', promptText, { user: message.author })).catch(() => null);
  if (!prompt) return null;
  const collected = await message.channel.awaitMessages({
    filter: (m) => m.author.id === message.author.id,
    max: 1,
    time: 120000
  }).catch(() => null);
  const reply = collected?.first?.() || null;
  return { prompt, reply };
}

async function handleTicketBlockApplyMessage(message, targetInput, BOT_OWNERS = []) {
  const member = message.member;
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (!isOwner && !canUseGeneralPointsCommand(member, message.guild.id, message.guild)) {
    await message.react('❌').catch(() => {});
    return;
  }

  const targetId = normalizeId(targetInput);
  if (!targetId) {
    await message.reply(buildTicketMessagePayload('خطأ', '**أرسل منشن أو آيدي صحيح.**')).catch(() => {});
    return;
  }

  await syncTicketBlocks(message.guild.id);
  const data = getTicketBlockData(message.guild.id);
  const targetType = message.guild.roles.cache.has(targetId) ? 'role' : 'user';
  const existing = data.blocks.find((entry) => entry.targetId === targetId && entry.targetType === targetType);
  if (existing) {
    const nextBlocks = data.blocks.filter((entry) => !(entry.targetId === targetId && entry.targetType === targetType));
    saveTicketBlockData(message.guild.id, { blocks: nextBlocks, blockChannelId: data.blockChannelId });
    await message.delete().catch(() => {});
    await logTicketBlockAction(message.guild, message.author, existing, 'unblock');
    await notifyTicketBlockTarget(message.guild, message.author, existing, 'unblock');
    await message.channel.send(buildTicketMessagePayload('تم', `**تم فك بلوك التكت عن** ${targetType === 'role' ? `<@&${targetId}>` : `<@${targetId}>`}.`, { user: message.author })).catch(() => {});
    return;
  }

  await message.delete().catch(() => {});
  const durationStep = await collectTicketBlockPrompt(message, '**كم تريد المدة؟**\n**0 = بدون مدة**');
  const durationText = durationStep?.reply?.content?.trim();
  await durationStep?.prompt?.delete().catch(() => {});
  await durationStep?.reply?.delete().catch(() => {});
  if (!durationText) return;

  const hours = Number(durationText);
  const expiresAt = durationText === '0' ? null : (Number.isFinite(hours) && hours > 0 ? Date.now() + (hours * 60 * 60 * 1000) : null);
  if (durationText !== '0' && !expiresAt) {
    await message.channel.send(buildTicketMessagePayload('خطأ', '**المدة غير صالحة.**', { user: message.author })).catch(() => {});
    return;
  }

  const reasonStep = await collectTicketBlockPrompt(message, '**اذكر السبب أو 0 (بدون سبب)**');
  const reasonText = reasonStep?.reply?.content?.trim();
  await reasonStep?.prompt?.delete().catch(() => {});
  await reasonStep?.reply?.delete().catch(() => {});
  if (reasonText === undefined) return;

  const blockEntry = {
    targetId,
    targetType,
    actorId: message.author.id,
    createdAt: Date.now(),
    expiresAt,
    reason: reasonText === '0' ? '' : reasonText
  };
  const nextBlocks = pruneTicketBlocks([...data.blocks, blockEntry]);
  saveTicketBlockData(message.guild.id, { blocks: nextBlocks, blockChannelId: data.blockChannelId });
  await logTicketBlockAction(message.guild, message.author, blockEntry, 'block');
  await notifyTicketBlockTarget(message.guild, message.author, blockEntry, 'block');
  await message.channel.send(buildTicketMessagePayload('تم', `**تم إعطاء بلوك تكت إلى** ${targetType === 'role' ? `<@&${targetId}>` : `<@${targetId}>`}.`, { user: message.author })).catch(() => {});
}

async function handleReassignRequest(interaction, guildId, panelId, channelId, options = {}) {
  const silent = options?.silent === true;
  if (!silent) await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const reply = async (payload) => {
    if (silent) return;
    await interaction.editReply(payload).catch(() => {});
  };
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket || interaction.channelId !== actionChannelId) {
    await reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
    return false;
  }
  if (!isAdminOnly(interaction, config, ticket?.reasonKey)) {
    await reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية تغيير المستلم.**', { ephemeral: true }));
    return false;
  }
  if (ticket.status !== 'open') {
    await reply(buildTicketMessagePayload('تنبيه', '**تغيير المستلم متاح فقط قبل إغلاق التكت.**', { ephemeral: true }));
    return false;
  }

  const previousClaimer = ticket.claimedBy || null;
  if (ticket.reassignPendingAt) {
    await reply(buildTicketMessagePayload('تنبيه', '**يوجد طلب تغيير مستلم معلّق بالفعل.**', { ephemeral: true }));
    return false;
  }

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    await reply(buildTicketMessagePayload('خطأ', '**شات القبول غير صالح أو غير متاح.**', { ephemeral: true }));
    return false;
  }

  const mentionChunks = buildMentionChunks(getAdminRoles(config, ticket?.reasonKey));
  const requestRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_reassign_claim_${guildId}_${resolvedPanelId}_${actionChannelId}`)
      .setLabel('استلام المستلم الجديد')
      .setStyle(ButtonStyle.Primary)
  );

  const reasonSettings = getReasonVisualSettings(config, ticket.reasonKey);
  const reason = reasonSettings.reason;
  const requestText = [
    '# طلب تغيير الاداري',
    `**العضو :** <@${ticket.memberId}>`,
    `**السبب :** ${reason.name || `سبب ${ticket.reasonKey}`}`,
    `**التكت :** <#${actionChannelId}>`
  ].join('\n');

  try {
    ticket.reassignRequestMessageRefs = [];
    for (const chunk of mentionChunks) {
      const sent = await targetChannel.send({ content: chunk });
      if (sent?.id) {
        ticket.reassignRequestMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    }

    const claimImage = resolveImageForSend(reasonSettings.claimImage);
    if (claimImage) {
      const sent = await targetChannel.send({ content: requestText, files: [claimImage], components: [requestRow] });
      if (sent?.id) {
        ticket.reassignRequestMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    } else {
      const sent = await targetChannel.send({ content: requestText, components: [requestRow] });
      if (sent?.id) {
        ticket.reassignRequestMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    }
  } catch {
    delete ticket.reassignRequestMessageRefs;
    await reply(buildTicketMessagePayload('خطأ', '**فشل إرسال طلب تغيير المستلم في شات القبول، تم إلغاء العملية.**', { ephemeral: true }));
    return false;
  }

  ticket.claimedBy = null;
  ticket.reassignPendingAt = Date.now();
  ticket.reassignPreviousClaimer = previousClaimer || interaction.user.id;

  if (interaction.user.id) {
    await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }
  if (previousClaimer && previousClaimer !== interaction.user.id) {
    await interaction.channel.permissionOverwrites.edit(previousClaimer, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }

  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم تغيير المستلم عن طريق : <@${interaction.user.id}>`,
    actor: interaction.user
  });
  if (!silent) {
    await interaction.channel.send({
      content: `**تم تغير المستلم :** ${previousClaimer ? `<@${previousClaimer}>` : (interaction.user.id ? `<@${interaction.user.id}>` : 'غير محدد')}\n**انتظر المستلم الجديد.**`
    }).catch(() => {});
  }
  await reply(buildTicketMessagePayload('تم', '**تم إخراجك من التكت وإرسال طلب استلام جديد.**', { ephemeral: true }));
  return true;
}


async function handleReassignClaim(interaction, guildId, panelId, channelId) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const lockKey = `reassign_claim:${guildId}:${channelId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**جاري معالجة الطلب، حاول بعد لحظات.**')).catch(() => {});
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**'));
    return;
  }
  if (!hasStaffAccess(interaction.member, config, ticket?.reasonKey, ticket)) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الاستلام.**'));
    return;
  }
  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`));
    return;
  }
  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', `**تم الاستلام بالفعل بواسطة :** <@${ticket.claimedBy}>`));
    return;
  }
  if (!ticket.reassignPendingAt) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**لا يوجد طلب تغيير مستلم نشط لهذا التكت.**')).catch(() => {});
    return;
  }
  if (ticket.reassignPreviousClaimer && ticket.reassignPreviousClaimer === interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('تنبيه', '**لا يمكن للمستلم السابق استلام نفس التكت بعد طلب تغيير المستلم.**')).catch(() => {});
    return;
  }

  const ticketChannel = interaction.guild.channels.cache.get(actionChannelId)
    || await interaction.guild.channels.fetch(actionChannelId).catch(() => null);
  if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**تعذر العثور على روم التكت.**')).catch(() => {});
    return;
  }

  ticket.claimedBy = interaction.user.id;
  delete ticket.reassignPendingAt;
  touchTicketActivity(ticket);
  await ticketChannel.permissionOverwrites.edit(interaction.user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch(() => {});

  if (interaction.message?.editable) {
    const rows = interaction.message.components.map((row) => {
      const comps = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_reassign_claim_')) {
          return ButtonBuilder.from(component).setDisabled(true).setLabel('تم الاستلام');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(comps);
    });
    if (config.deleteClaimMessageOnClaim) {
      await deleteTrackedMessages(interaction.guild, ticket?.reassignRequestMessageRefs, interaction.message.id);
      await deleteClaimMessageIfEnabled(interaction, config);
    } else {
      await interaction.message.edit({
        content: buildClaimRequestContent(ticket, config, interaction.user.id),
        embeds: [],
        components: rows
      }).catch(() => {});
    }
  }

  const claimImage = resolveImageForSend(getReasonVisualSettings(config, ticket.reasonKey).claimImage);
  await sendClaimAnnounce({ channel: ticketChannel, config, ticket, claimerId: interaction.user.id, claimImage });
  delete ticket.reassignRequestMessageRefs;

  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم استلام التكت بالمستلم الجديد عن طريق : <@${interaction.user.id}>`,
    actor: interaction.user
  });

  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  await interaction.editReply(buildTicketMessagePayload('تم', '**تم استلام التكت بالمستلم الجديد.**'));
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

function createReasonComponents(config, guildId, panelId = 'default') {
  const reasons = Object.entries(config.reasons || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 25);
  if (config.displayMode === 'menu') {
    const options = reasons.length
      ? reasons.map(([k, v]) => ({ label: (v.name || `سبب ${k}`).slice(0, 100), description: (v.description || '').slice(0, 100) || undefined, value: `reason_${k}`, emoji: v.emoji || undefined }))
      : [{ label: 'فتح تكت عام', value: 'reason_0', emoji: '🎫' }];
    return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticket_open_menu_${guildId}_${panelId}`).setPlaceholder('اختر السبب').addOptions(options))];
  }

  const maxButtons = Math.max(1, Math.min(25, (config.buttonRows || 2) * 5));
  const entries = (reasons.length ? reasons : [['0', { name: 'فتح تكت', emoji: '🎫' }]])
    .sort((a, b) => Number(a[1]?.buttonOrder || a[0]) - Number(b[1]?.buttonOrder || b[0]))
    .slice(0, maxButtons);
  const buttons = entries.map(([k, v]) => new ButtonBuilder()
    .setCustomId(`ticket_open_btn_${guildId}_${panelId}_${k}`)
    .setLabel((v.name || `سبب ${k}`).slice(0, 80))
    .setStyle(resolveButtonStyle(v.buttonStyle))
    .setEmoji(v.emoji || '🎫'));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function execute(message, args, { BOT_OWNERS = [], ADMIN_ROLES = [] }) {
  const dedupeKey = `${message.guild?.id || 'dm'}:${message.id}`;
  if (recentTicketCommandMessages.has(dedupeKey)) return;
  recentTicketCommandMessages.add(dedupeKey);
  setTimeout(() => recentTicketCommandMessages.delete(dedupeKey), 60 * 1000);

  const invokedToken = String(message.content || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;
  const hasGlobalAdmin = hasGlobalAdminAccess(member, message, BOT_OWNERS, ADMIN_ROLES);
  const activeBlock = resolveTicketBlockForMember(message.guild.id, member);
  if (activeBlock && !invokedToken.endsWith('tblock')) {
    await message.reply(buildTicketMessagePayload('بلوك التكت', '**أنت محظور من استخدام نظام التكت حالياً.**')).catch(() => {});
    return;
  }
  const closeAliases = ['tclose', 'اغلاق', 'قفل', 'اقفال'];
  const isCloseAliasInvocation = closeAliases.some((alias) => invokedToken.endsWith(alias));
  if (isCloseAliasInvocation) {
    const ok = await handleCloseAliasMessage(message);
    await message.react(ok ? '✅' : '❌').catch(() => {});
    return;
  }

  if (['myticket', 'نقاطي'].some((alias) => invokedToken.endsWith(alias))) {
    const targetArg = args?.[0] || null;
    const hasTargetLookup = Boolean(normalizeId(targetArg));
    if (hasTargetLookup && !hasGlobalAdmin) {
      await message.react('❌').catch(() => {});
      return;
    }
    await handleMyTicketPointsMessage(message, targetArg);
    return;
  }
  if (['tadd', 'اضافه', 'اضافة', 'إضافة'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleAddRemoveAliasMessage(message, args?.join(' '), 'add');
    await message.react(ok ? '✅' : '❌').catch(() => {});
    return;
  }
  if (['tremove', 'ازاله', 'ازالة', 'إزالة'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleAddRemoveAliasMessage(message, args?.join(' '), 'remove');
    await message.react(ok ? '✅' : '❌').catch(() => {});
    return;
  }
  if (['tchange', 'تغيير', 'تحويل'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleReassignAliasMessage(message);
    await message.react(ok ? '✅' : '❌').catch(() => {});
    return;
  }
  if (['tname', 'اسم', 'تسميه', 'تسمية'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleRenameAliasMessage(message, args?.join(' '));
    await message.react(ok ? '✅' : '❌').catch(() => {});
    return;
  }
  if (['remind', 'تنبيه', 'استدعاء'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handlePingAliasMessage(message);
    await message.react(ok ? '✅' : '❌').catch(() => {});
    return;
  }
  if (invokedToken.endsWith('ttop') || (invokedToken.endsWith('نقاط') && String(args?.[0] || '').toLowerCase() !== 'add')) {
    if (!hasGlobalAdmin) {
      await message.react('❌').catch(() => {});
      return;
    }
    await handleTopPointsMessage(message, Number(args?.[0] || 1));
    return;
  }
  if (invokedToken.endsWith('tm')) {
    if (!hasGlobalAdmin) {
      await message.react('❌').catch(() => {});
      return;
    }
    await handleTopManagersMessage(message, Number(args?.[0] || 1));
    return;
  }
  if (invokedToken.endsWith('points')) {
    await handlePointsAdjustMessage(message, args, { BOT_OWNERS });
    return;
  }
  if (invokedToken.endsWith('treset')) {
    if (!canUseGeneralPointsCommand(member, message.guild.id, message.guild)) {
      await message.react('❌').catch(() => {});
      return;
    }
    await handleResetPointsMessage(message, { ownerOnly: false });
    return;
  }
  if (invokedToken.endsWith('tmreset')) {
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
      await message.react('❌').catch(() => {});
      return;
    }
    await handleResetPointsMessage(message, { ownerOnly: true });
    return;
  }
  if (invokedToken.endsWith('tblock')) {
    const sub = String(args?.[0] || '').toLowerCase();
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (sub === 'chat') {
      if (!isOwner) {
        await message.react('❌').catch(() => {});
        return;
      }
      const channelId = normalizeId(args?.[1]);
      const channel = channelId ? await message.guild.channels.fetch(channelId).catch(() => null) : null;
      if (!channel?.isTextBased?.()) {
        await message.reply(buildTicketMessagePayload('خطأ', '**أرسل منشن أو آيدي روم بلوك صالح.**')).catch(() => {});
        return;
      }
      const data = getTicketBlockData(message.guild.id);
      saveTicketBlockData(message.guild.id, { blocks: data.blocks, blockChannelId: channelId });
      await message.reply(buildTicketMessagePayload('تم', `**تم تعيين شات بلوك التكت:** <#${channelId}>`)).catch(() => {});
      return;
    }
    if (sub === 'list') {
      if (!canUseGeneralPointsCommand(member, message.guild.id, message.guild) && !isOwner) {
        await message.react('❌').catch(() => {});
        return;
      }
      await handleTicketBlockListMessage(message, Number(args?.[1] || 1));
      return;
    }
    await handleTicketBlockApplyMessage(message, args?.[0], BOT_OWNERS);
    return;
  }

  if (!hasGlobalAdmin) {
    await message.react('❌');
    return;
  }

  const subcommand = String(args?.[0] || '').toLowerCase();
  if (subcommand === 'export') {
    const panelId = extractChannelId(args?.[1]) || message.channel.id;
    const snapshot = exportPanelSnapshot(message.guild.id, panelId);
    await message.reply(buildTicketMessagePayload('تصدير إعدادات التكت', `\`\`\`\n${snapshot}\n\`\`\``, { ephemeral: false })).catch(() => {});
    return;
  }
  if (subcommand === 'import' || subcommand === 'restore') {
    const panelId = extractChannelId(args?.[1]) || message.channel.id;
    const encoded = args?.slice(2).join('').trim();
    if (!encoded) {
      await message.reply(buildTicketMessagePayload('خطأ', '**أرسل snapshot base64 بعد الروم.**')).catch(() => {});
      return;
    }
    try {
      importPanelSnapshot(message.guild.id, panelId, encoded, true);
      await message.reply(buildTicketMessagePayload('تم', `**تم استيراد إعدادات التكت للروم:** <#${panelId}>`)).catch(() => {});
    } catch {
      await message.reply(buildTicketMessagePayload('خطأ', '**snapshot غير صالح أو تالف.**')).catch(() => {});
    }
    return;
  }

  const setupSessionKey = `${message.guild.id}:${message.author.id}`;
  const existingSession = activeTicketSetupSessions.get(setupSessionKey);
  if (existingSession && (Date.now() - existingSession.startedAt) < (30 * 60 * 1000)) {
    if (existingSession.sourceMessageId === message.id) return;
    const setupLink = existingSession.messageId
      ? `https://discord.com/channels/${message.guild.id}/${existingSession.channelId || message.channel.id}/${existingSession.messageId}`
      : null;
    await message.reply(setupLink
      ? `**لديك جلسة إعداد تكت قيد العمل بالفعل.**\n**الرابط :** ${setupLink}`
      : '**لديك جلسة إعداد تكت قيد العمل بالفعل.**').catch(() => {});
    return;
  }

  activeTicketSetupSessions.set(setupSessionKey, {
    startedAt: Date.now(),
    messageId: null,
    channelId: message.channel.id,
    sourceMessageId: message.id,
    initializing: true
  });

  const controlChannel = message.channel;
  let setupMessage = null;
  let activePromptInteraction = null;

  let panelId = extractChannelId((args || []).join(' '));
  if (!panelId) {
    await controlChannel.send(buildTicketMessagePayload('ربط لوحة التكت', '**ارسل اي دي او منشن الروم المراد ربط إعدادات التكت به.**')).catch(() => {});
    const collected = await controlChannel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: 180000
    });
    const first = collected.first();
    if (first) {
      panelId = extractChannelId(first.content || '');
      await first.delete().catch(() => {});
    }
  }

  const panelChannel = panelId ? await message.guild.channels.fetch(panelId).catch(() => null) : null;
  if (!panelChannel || !panelChannel.isTextBased?.()) {
    activeTicketSetupSessions.delete(setupSessionKey);
    await controlChannel.send(buildTicketMessagePayload('خطأ', '**❌ الروم غير صالح، استخدم منشن أو اي دي روم نصي صحيح.**')).catch(() => {});
    return;
  }

  const { config, tickets, pendingRequests } = getPanelData(message.guild.id, panelId);

  const ask = async (prompt, timeout = 180000, options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    const imageOnly = Boolean(opts.imageOnly);
    const preferAttachment = Boolean(opts.preferAttachment);

    if (activePromptInteraction) {
      await activePromptInteraction.followUp(buildTicketMessagePayload('تنبيه', `🔒 ${prompt}`, { ephemeral: true })).catch(() => {});
    }

    const maxAttempts = imageOnly ? 3 : 1;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;

      const collected = await controlChannel.awaitMessages({
        filter: (m) => m.author.id === message.author.id,
        max: 1,
        time: timeout
      });
      const first = collected.first();
      if (!first) return null;

      const attachment = first.attachments?.first?.();
      const attachmentUrl = attachment?.url || null;
      const text = (first.content || '').trim();

      if (first) await first.delete().catch(() => {});

      if (imageOnly) {
        if (text === '0') return '0';
        if (attachmentUrl) return attachmentUrl;
        if (/^https?:\/\//i.test(text)) return text;

        const remaining = maxAttempts - attempt;
        if (remaining > 0) {
          await controlChannel.send(buildTicketMessagePayload(
            'خطأ',
            `**❌ ادخال الصورة غير صالح. المتبقي ${remaining} محاولة.**\n**ارسل الصورة كمرفق بدون نص، او رابط مباشر للصورة، او 0 للإلغاء.**`
          )).catch(() => {});
          continue;
        }

        await controlChannel.send(buildTicketMessagePayload('خطأ', '**❌ تم إلغاء العملية: لم يتم استلام صورة صالحة.**')).catch(() => {});
        return null;
      }

      if (preferAttachment && attachmentUrl) return attachmentUrl;
      if (text) return text;
      return attachmentUrl;
    }

    return null;
  };

  const askNumberInRange = async (prompt, min, max) => {
    const raw = await ask(prompt);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      await controlChannel.send(buildTicketMessagePayload('خطأ', `**❌ ادخال غير صالح. اكتب رقمًا بين ${min} و ${max}.**`)).catch(() => {});
      return null;
    }
    return value;
  };

  const promptAndStoreImage = async ({
    prompt,
    currentValue,
    slotKey,
    failureText
  }) => {
    const v = await ask(prompt, 180000, { imageOnly: true, preferAttachment: true });
    if (!v) {
      await activePromptInteraction?.followUp(buildTicketMessagePayload('تنبيه', '**⚠️ لم يتم تغيير الصورة.**', { ephemeral: true })).catch(() => {});
      return currentValue;
    }
    if (v === '0') {
      removeStoredImage(currentValue);
      await activePromptInteraction?.followUp(buildTicketMessagePayload('تم', '**✅ تم حذف الصورة بنجاح.**', { ephemeral: true })).catch(() => {});
      return '';
    }
    try {
      const stored = await storeImageLocally(v, message.guild.id, slotKey, currentValue);
      await activePromptInteraction?.followUp(buildTicketMessagePayload('تم', '**✅ تم حفظ الصورة بنجاح.**', { ephemeral: true })).catch(() => {});
      return stored;
    } catch {
      await activePromptInteraction?.followUp(buildTicketMessagePayload('خطأ', failureText || '**❌ فشل حفظ الصورة. تأكد ان الرابط مباشر او ارسل الصورة كمرفق.**', { ephemeral: true })).catch(() => {});
      return currentValue;
    }
  };

  const notifySetupResult = async (text) => {
    await activePromptInteraction?.followUp(buildTicketMessagePayload('نتيجة التحديث', text, { ephemeral: true })).catch(() => {});
  };


  const buildSetupEmbed = () => {
    const reasonsCount = Object.keys(config.reasons || {}).length;
    const responsiblesMentions = (config.responsibleRoleIds || []).length
      ? (config.responsibleRoleIds || []).map((id) => `<@&${id}>`).join(' ')
      : 'غير معين';
    const adminRolesMentions = config.useGlobalAdminRoles
      ? 'adminRoles'
      : ((config.adminRoleIds || []).length
        ? (config.adminRoleIds || []).map((id) => `<@&${id}>`).join(' ')
        : 'غير معين');
    const reasonsNamesRaw = Object.entries(config.reasons || {})
      .sort((a, b) => Number(a[1]?.buttonOrder || a[0]) - Number(b[1]?.buttonOrder || b[0]))
      .map(([k, v]) => `**${k})** ${v.name || `سبب ${k}`}`)
      .join('\n') || 'لا يوجد';
    const reasonsNames = reasonsNamesRaw.length > 1000 ? `${reasonsNamesRaw.slice(0, 1000)}\n...` : reasonsNamesRaw;
    const setupIssues = getSetupIssues();
    const setupStatus = setupIssues.length === 0
      ? 'مكتمل ✅'
      : `ناقص ⚠️\n${setupIssues.map((i) => `• ${i.replace(/\*\*/g, '')}`).join('\n')}`;

    return colorManager.createEmbed()
      .setColor(colorManager.getColor())
      .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL({ dynamic: true, size: 256 }) || undefined })
      .setTitle(`**اعدادات التكت : ${message.guild.name}**`)
      .setThumbnail(message.guild.iconURL({ dynamic: true, size: 256 }))
      .setDescription('**اختر من المنيو بالأسفل التعديل المطلوب.**')
      .addFields(
        { name: 'الروم الحالي', value: `<#${panelId}>`, inline: true },
        { name: 'اسم التكت', value: `${config.ticketNamePrefix} - ${config.ticketNameMode}`, inline: true },
        { name: 'كاتوقري الفتح', value: config.openCategoryId ? `<#${config.openCategoryId}>` : 'غير معين', inline: true },
        { name: 'المسؤولين', value: responsiblesMentions.slice(0, 1024), inline: false },
        { name: 'رولات الادمن', value: adminRolesMentions.slice(0, 1024), inline: false },
        { name: 'طريقة العرض', value: config.displayMode, inline: true },
        { name: 'روم اللوق', value: config.logChannelId ? `<#${config.logChannelId}>` : 'غير معين', inline: true },
        { name: 'حدود النظام', value: `حد الاستلام: ${config.adminClaimLimit}\nحد الفتح: ${config.memberOpenLimit}`, inline: true },
        { name: 'حالة التبديلات', value: `انشاء قبل الاستلام: ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}\nاخفاء عند الاستلام: ${config.hideOnClaim ? 'مفعل' : 'مقفل'}\nشات استلام مخصص: ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}\nالاحتفاظ بعد الاغلاق: ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}\nحذف رسالة الاستلام بعد التنفيذ: ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}\nالإغلاق التلقائي: ${config.autoCloseEnabled ? `مفعل (${config.autoCloseHours} ساعة)` : 'مقفل'}`, inline: false },
        { name: `الاسباب (${reasonsCount})`, value: reasonsNames, inline: false },
        { name: 'جاهزية النظام', value: setupStatus.slice(0, 1024), inline: false }
      )
      .setFooter({ text: 'Ticket Settings • لوحة منظمة وسهلة القراءة' });
  };


  const getSetupIssues = () => {
    const issues = [];
    const adminRolesResolved = getAdminRoles(config);

    if (!config.openCategoryId) issues.push('**يلزم تعيين كاتوقري فتح التكت**');
    if ((config.responsibleRoleIds || []).length === 0) issues.push('**يلزم تعيين رولات المسؤولين**');
    if (adminRolesResolved.length === 0) issues.push('**يلزم تعيين رولات الادمن**');
    if (Object.keys(config.reasons || {}).length === 0) issues.push('**يلزم تعيين سبب واحد على الاقل**');

    if (config.claimFromDedicatedChannel && !config.claimChannelId) {
      issues.push('**تفعيل شات الاستلام يحتاج تعيين شات الاستلام**');
    }

    if (!config.autoCreateOnRequest && !config.claimChannelId) {
      issues.push('**عند تعطيل الانشاء المباشر يجب تعيين شات الاستلام**');
    }

    if (config.displayMode === 'buttons') {
      if (!Number.isFinite(config.buttonRows) || config.buttonRows < 1 || config.buttonRows > 5) {
        issues.push('**عدد صفوف الازرار يجب ان يكون بين 1 و 5**');
      }
    }

    return issues;
  };

  const assertSetupReady = async (actionLabel = 'تنفيذ العملية') => {
    const issues = getSetupIssues();
    if (issues.length === 0) return true;
    await refresh(`**لا يمكن ${actionLabel} قبل اكمال المتطلبات :**\n${issues.join('\n')}`);
    return false;
  };

  const buildMenuComponents = () => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ticket_setup_menu_${message.author.id}_${Date.now()}`)
      .setPlaceholder('اختر اعداد التكت')
      .addOptions([
        { label: '1) اسم شات التكت', value: 'set_name', description: 'تحديد بادئة الاسم وطريقة التسمية', emoji: '🎫' },
        { label: '2) كاتوقري الفتح', value: 'set_open_category', description: 'تحديد كاتوقري استقبال التكتات', emoji: '🎫' },
        { label: '3) تحديد المسؤولين', value: 'set_responsibles', description: 'الرولات التي تدير التكتات', emoji: '🎫' },
        { label: '4) تحديد رولات الادمن', value: 'set_admin_roles', description: 'الرولات التي لها صلاحيات إدارية', emoji: '🎫' },
        { label: '5) حد استلام الاداري', value: 'set_admin_limit', description: 'عدد التكتات المفتوحة لكل إداري', emoji: '🎫' },
        { label: '6) حد فتح العضو', value: 'set_member_limit', description: 'عدد التكتات المفتوحة لكل عضو', emoji: '🎫' },
        { label: '7) انشاء قبل الاستلام (toggle)', value: 'toggle_auto_create', description: 'فتح مباشر أو انتظار الاستلام', emoji: '🎫' },
        { label: '8) اخفاء عند الاستلام (toggle)', value: 'toggle_hide_on_claim', description: 'إخفاء/إظهار بحسب المستلم', emoji: '🎫' },
        { label: '9) الاستلام من شات مخصص', value: 'toggle_claim_channel', description: 'تفعيل شات منفصل لطلبات الاستلام', emoji: '🎫' },
        { label: '10) الاحتفاظ بعد الاغلاق', value: 'toggle_keep_closed', description: 'حذف التكت أو إبقاؤه بعد الإغلاق', emoji: '🎫' },
        { label: '11) اعدادات الرسائل (نصوص فقط)', value: 'set_messages', description: 'تخصيص النصوص قبل/بعد/قبول', emoji: '🎫' },
        { label: '12) اعدادات الصور', value: 'set_images', description: 'تخصيص صور الفتح/الاستلام/الفاصل', emoji: '🎫' },
        { label: '13) تعيين الاسباب', value: 'set_reasons', description: 'تعديل أسماء/وصف/كاتوقري الأسباب', emoji: '🎫' },
        { label: '14) طريقة العرض', value: 'set_display_mode', description: 'الاختيار بين buttons أو menu', emoji: '🎫' },
        { label: '15) ارسال بانل التكت', value: 'send_panel_now', description: 'إرسال بانل الفتح للروم المحدد', emoji: '🎫' },
        { label: '16) حذف رسالة الاستلام بعد التنفيذ', value: 'toggle_delete_claim_msg', description: 'حذف رسالة القبول بعد الاستلام', emoji: '🎫' },
        { label: '17) الإغلاق التلقائي', value: 'toggle_auto_close', description: 'تفعيل مدة إغلاق تلقائي حسب آخر رسالة', emoji: '🎫' },
        { label: '18) روم اللوق', value: 'set_log_channel', description: 'روم يسجل كل عمليات التكت', emoji: '🎫' },
        { label: 'انهاء الاعداد', value: 'finish', description: 'حفظ الإعدادات وإغلاق الجلسة', emoji: '🎫' }
      ]);

    return [new ActionRowBuilder().addComponents(menu)];
  };

  setupMessage = await controlChannel.send({ embeds: [buildSetupEmbed()], components: buildMenuComponents() });
  activeTicketSetupSessions.set(setupSessionKey, {
    startedAt: Date.now(),
    messageId: setupMessage.id,
    channelId: setupMessage.channel.id,
    sourceMessageId: message.id,
    initializing: false
  });

  const collector = setupMessage.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id && i.customId.startsWith('ticket_setup_menu_'),
    time: 30 * 60 * 1000
  });

  const refresh = async (note = null, components = buildMenuComponents()) => {
    setGuildData(message.guild.id, config, tickets, pendingRequests, panelId);
    await setupMessage.edit({
      embeds: [normalizeEmbedForStandardMessage(buildSetupEmbed(), note)],
      components
    }).catch(() => {});
  };

  const buildReasonsIndexText = () => {
    const lines = [];
    for (let i = 1; i <= 25; i += 1) {
      const key = String(i);
      const reason = config.reasons?.[key] || {};
      const label = reason.name || `سبب ${i}`;
      lines.push(`**${i})** ${label}`);
    }
    return lines.join('\n');
  };

  const buildReasonSelectOptions = () => {
    const options = [];
    for (let i = 1; i <= 25; i += 1) {
      const key = String(i);
      const reason = config.reasons?.[key] || {};
      options.push({
        label: `${i}) ${(reason.name || `سبب ${i}`).slice(0, 80)}`,
        description: (reason.description || `تعديل إعدادات السبب ${i}`).slice(0, 90),
        value: `reason_${i}`,
        emoji: reason.emoji || '🎫'
      });
    }
    return options;
  };

  const pickReasonFromMenu = async () => {
    await setupMessage.edit({
      embeds: [colorManager.createEmbed()
        .setTitle('**اختيار السبب**')
        .setDescription('**اختر السبب من المنيو ثم عدّل كل تفاصيله (الاسم / الكاتوقري / الرسائل / الصور / المودال).**')],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ticket_reason_pick_${message.author.id}_${Date.now()}`)
          .setPlaceholder('اختر السبب المراد تعديله')
          .addOptions(buildReasonSelectOptions())
      )]
    }).catch(() => {});

    const pick = await setupMessage.awaitMessageComponent({
      filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_reason_pick_'),
      time: 240000
    }).catch(() => null);

    if (!pick) return null;
    activePromptInteraction = pick;
    await pick.deferUpdate().catch(() => {});
    const raw = pick.values?.[0] || '';
    const idx = Number(String(raw).replace('reason_', ''));
    if (!Number.isFinite(idx) || idx < 1 || idx > 25) return null;
    return idx;
  };

  const openReasonSubmenu = async (key, reason, idx) => {
    let done = false;
    while (!done) {
      const modalFields = Array.isArray(reason.openModal?.fields) ? reason.openModal.fields : [];
      const modalOrderText = modalFields.length
        ? modalFields.map((f, i) => `**${i + 1})** ${String(f?.label || 'حقل').slice(0, 45)}`).join('\n')
        : 'لا يوجد';

      const state = colorManager.createEmbed()
        .setTitle(`**إعدادات السبب ${idx}**`)
        .setDescription('**التعديل من الأعلى للأقل أهمية: الاسم ← الكاتوقري ← الرسائل ← الصور ← العرض (عند الأزرار فقط) ← المودال.**')
        .addFields(
          {
            name: 'الهوية الأساسية',
            value: [
              `**الاسم:** ${reason.name || `سبب ${idx}`}`,
              `**اسم التكت:** ${reason.ticketName || 'افتراضي'}`,
              `**وصف السبب:** ${formatSettingValue(reason.description)}`,
              `**الايموجي:** ${formatSettingValue(reason.emoji || '🎫')}`,
              `**الكاتوقري:** ${reason.categoryId ? `<#${reason.categoryId}>` : 'افتراضي'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'رسائل السبب',
            value: [
              `**رسالة قبل الصورة:** ${formatSettingValue(reason.beforeImage)}`,
              `**رسالة بعد الصورة:** ${formatSettingValue(reason.afterImage)}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'صور السبب',
            value: [
              `**صورة الفتح:** ${formatSettingValue(reason.openImage)}`,
              `**صورة الاستلام:** ${formatSettingValue(reason.claimImage)}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'العرض الخاص بالسبب',
            value: [
              `**لون الزر:** ${formatSettingValue(reason.buttonStyle || 'primary')}`,
              `**ترتيب الزر:** ${formatSettingValue(reason.buttonOrder || idx)}`,
              `**الحالة:** ${config.displayMode === 'buttons' ? 'يعمل الآن' : 'غير مستخدم لأن طريقة العرض الحالية ليست أزرار'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'إدارة السبب',
            value: [
              `**الحالة:** ${reason.useCustomAdminRoles ? 'رولات خاصة بهذا السبب' : 'الرولات الإدارية العامة'}`,
              `**الرولات:** ${reason.useCustomAdminRoles ? ((reason.adminRoleIds || []).map((id) => `<@&${id}>`).join(' ') || 'لا يوجد') : 'يستخدم العام'}`
            ].join('\n').slice(0, 1024),
            inline: false
          },
          {
            name: 'مودال السبب',
            value: [
              `**الحالة:** ${reason.openModal?.enabled ? 'مفعل' : 'غير مفعل'}`,
              `**العنوان:** ${formatSettingValue(reason.openModal?.title)}`,
              `**الوصف:** ${formatSettingValue(reason.openModal?.description)}`,
              `**ترتيب الحقول:** ${modalOrderText}`
            ].join('\n').slice(0, 1024),
            inline: false
          }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر العنصر المطلوب تعديله لهذا السبب، أو انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_reason_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر إعداد السبب')
            .addOptions([
              { label: '1) اسم السبب', value: 'r1', description: 'الاسم الذي يظهر للعضو' },
              { label: '2) كاتوقري السبب', value: 'r2', description: 'كاتوقري مخصص لهذا السبب' },
              { label: '3) اسم التكت لهذا السبب', value: 'r3', description: 'اسم مخصص بدل الافتراضي' },
              { label: '4) وصف السبب', value: 'r4', description: 'يظهر داخل منيو الأسباب' },
              { label: '5) رسالة قبل صورة التكت', value: 'r6', description: 'داخل التكت قبل الصورة' },
              { label: '6) رسالة بعد صورة التكت', value: 'r7', description: 'داخل التكت بعد الصورة وتحت منيو المسؤوليات' },
              { label: '7) صورة الفتح لهذا السبب', value: 'r8', description: 'ترسل عند فتح التكت' },
              { label: '8) صورة الاستلام لهذا السبب', value: 'r9', description: 'تظهر في طلبات وإعلانات الاستلام' },
              { label: '9) ايموجي السبب', value: 'r10', description: 'ايموجي يظهر مع السبب' },
              { label: '10) لون وترتيب زر السبب', value: 'r11', description: 'يعمل فقط إذا كانت طريقة العرض أزرار' },
              { label: '11) رولات الإدارة الخاصة بهذا السبب', value: 'r12', description: 'تستبدل الرولات الإدارية العامة لهذا السبب فقط' },
              { label: '12) مودال السبب وترتيب حقوله', value: 'r13', description: 'حقول من الأهم للأقل' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_reason_menu_'),
        time: 240000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'r1') {
        const v = await ask('**اسم السبب : (0 لاعادة التعيين)**');
        reason.name = v === '0' ? `سبب ${idx}` : (v || reason.name);
        await notifySetupResult('**✅ تم تحديث اسم السبب.**');
      }
      if (c === 'r2') {
        const v = await ask('**كاتوقري السبب : منشن/ايدي (0 لاعادة التعيين)**');
        reason.categoryId = v === '0' ? null : normalizeId(v);
        await notifySetupResult('**✅ تم تحديث كاتوقري السبب.**');
      }
      if (c === 'r3') {
        const v = await ask('**اسم التكت لهذا السبب : (0 لاعادة التعيين)**');
        reason.ticketName = v === '0' ? '' : (v || reason.ticketName);
        await notifySetupResult('**✅ تم تحديث اسم التكت للسبب.**');
      }
      if (c === 'r4') {
        const v = await ask('**وصف السبب : (0 لاعادة التعيين)**');
        reason.description = v === '0' ? '' : (v || reason.description || '');
        await notifySetupResult('**✅ تم تحديث وصف السبب.**');
      }
      if (c === 'r6') {
        const v = await ask('**رسالة قبل الصورة : (0 لاعادة التعيين)**');
        reason.beforeImage = v === '0' ? '' : (v || reason.beforeImage);
        await notifySetupResult('**✅ تم تحديث رسالة ما قبل الصورة.**');
      }
      if (c === 'r7') {
        const v = await ask('**رسالة بعد الصورة : (0 لاعادة التعيين)**');
        reason.afterImage = v === '0' ? '' : (v || reason.afterImage);
        await notifySetupResult('**✅ تم تحديث رسالة ما بعد الصورة.**');
      }
      if (c === 'r8') {
        reason.openImage = await promptAndStoreImage({
          prompt: '**صورة فتح السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: reason.openImage,
          slotKey: `reason_${key}_open`,
          failureText: '**❌ فشل حفظ صورة فتح السبب.**'
        });
      }
      if (c === 'r9') {
        reason.claimImage = await promptAndStoreImage({
          prompt: '**صورة استلام السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: reason.claimImage,
          slotKey: `reason_${key}_claim`,
          failureText: '**❌ فشل حفظ صورة استلام السبب.**'
        });
      }
      if (c === 'r10') {
        const emo = await ask('**ايموجي السبب : (0 لاعادة التعيين)**');
        reason.emoji = emo === '0' ? '🎫' : (emo || reason.emoji);
        await notifySetupResult('**✅ تم تحديث ايموجي السبب.**');
      }
      if (c === 'r11') {
        if (config.displayMode !== 'buttons') {
          await notifySetupResult('**❌ لا يمكن تعديل لون أو ترتيب السبب إلا عندما تكون طريقة العرض الأساسية أزرار (buttons).**');
        } else {
          const v = ((await ask('**لون الزر: primary / secondary / success / danger (0 لاعادة التعيين)**')) || '').toLowerCase();
          if (v === '0') reason.buttonStyle = 'primary';
          else if (['primary', 'secondary', 'success', 'danger'].includes(v)) reason.buttonStyle = v;

          const order = Number(await ask('**ترتيب الزر (رقم من 1 الى 999 - 0 لاعادة التعيين)**'));
          if (order === 0) reason.buttonOrder = idx;
          else if (Number.isFinite(order) && order >= 1 && order <= 999) reason.buttonOrder = order;
          await notifySetupResult('**✅ تم تحديث لون وترتيب زر السبب.**');
        }
      }
      if (c === 'r12') {
        const raw = await ask('**رولات الإدارة الخاصة بهذا السبب: منشن/آيدي الرولات أو 0 للرجوع للرولات العامة**');
        if (raw === '0') {
          reason.useCustomAdminRoles = false;
          reason.adminRoleIds = [];
          await notifySetupResult('**✅ تم إرجاع هذا السبب إلى الرولات الإدارية العامة.**');
        } else {
          const parsed = (raw || '').split(/\s+/).map(normalizeId).filter(Boolean);
          if (parsed.length === 0) {
            await notifySetupResult('**❌ فشل حفظ رولات الإدارة الخاصة بالسبب: أرسل منشنات أو آيديات رولات صالحة.**');
          } else {
            reason.useCustomAdminRoles = true;
            reason.adminRoleIds = [...new Set(parsed)];
            await notifySetupResult('**✅ تم تحديث رولات الإدارة الخاصة بهذا السبب.**');
          }
        }
      }
      if (c === 'r13') {
        const enabled = ((await ask('**تفعيل مودال السبب؟ yes/no**')) || '').toLowerCase();
        if (!reason.openModal || typeof reason.openModal !== 'object') {
          reason.openModal = { enabled: false, title: '', description: '', fields: [] };
        }

        if (enabled === 'yes' || enabled === 'y' || enabled === 'نعم') {
          reason.openModal.enabled = true;

          const title = await ask('**عنوان المودال (0 لاعادة التعيين)**');
          if (title === '0') reason.openModal.title = '';
          else if (title) reason.openModal.title = title.slice(0, 45);

          const desc = await ask('**شرح المودال (0 لاعادة التعيين)**');
          if (desc === '0') reason.openModal.description = '';
          else if (desc) reason.openModal.description = desc.slice(0, 200);

          const labelsRaw = await ask('**حقول المودال بالترتيب من الأهم للأقل (افصل بينهم |) مثال: الاسم|الايدي|الوصف**');
          if (labelsRaw === '0') {
            reason.openModal.fields = [];
          } else {
            const labels = String(labelsRaw || '')
              .split('|')
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 5)
              .map((label) => ({ label: label.slice(0, 45), placeholder: '', style: 'short', required: true }));
            reason.openModal.fields = labels;
          }
          await notifySetupResult('**✅ تم تحديث المودال وترتيب حقوله.**');
        } else {
          reason.openModal = { enabled: false, title: '', description: '', fields: [] };
          await notifySetupResult('**✅ تم تعطيل مودال السبب.**');
        }
      }

      config.reasons[key] = reason;
    }
  };


  const openMessagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
        .setTitle('**اعدادات الرسائل**')
        .setDescription('**كل خيار يوضح مكان ظهور الرسالة داخل نظام التكت.**')
        .addFields(
          {
            name: '1) رسالة قبل صورة التكت',
            value: `**المكان:** داخل شات التكت قبل الصورة\n**القيمة الحالية:** ${formatSettingValue(config.messages.beforeImage)}`,
            inline: false
          },
          {
            name: '2) رسالة بعد صورة التكت',
            value: `**المكان:** داخل شات التكت بعد الصورة\n**القيمة الحالية:** ${formatSettingValue(config.messages.afterImage)}`,
            inline: false
          }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر من قائمة اعدادات الرسائل، او انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_msg_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الرسائل')
            .addOptions([
              { label: '1) رسالة قبل الصورة - شات التكت', description: 'تظهر قبل صورة فتح التكت', value: 'm2' },
              { label: '2) رسالة بعد الصورة - شات التكت', description: 'تظهر بعد صورة فتح التكت', value: 'm3' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_msg_menu_'),
        time: 180000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'm2') {
        const v = await ask('**رسالة قبل صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**');
        config.messages.beforeImage = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp(buildTicketMessagePayload('تم', '**✅ تم تحديث رسالة ما قبل الصورة.**', { ephemeral: true })).catch(() => {});
      }
      if (c === 'm3') {
        const v = await ask('**رسالة بعد صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**');
        config.messages.afterImage = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp(buildTicketMessagePayload('تم', '**✅ تم تحديث رسالة ما بعد الصورة.**', { ephemeral: true })).catch(() => {});
      }
    }
  };


  const openImagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
        .setTitle('**اعدادات الصور**')
        .setDescription('**رفع الصورة يتم بطريقتين:** ارسال رابط مباشر للصورة أو ارفاق الصورة بدون نص.')
        .addFields(
          {
            name: '1) صورة التكت العامة',
            value: `**المكان:** داخل شات التكت عند الفتح\n**القيمة الحالية:** ${formatSettingValue(config.messages.ticketImage)}`,
            inline: false
          },
          {
            name: '2) صورة الاستلام العامة',
            value: `**المكان:** طلبات/إعلانات الاستلام\n**القيمة الحالية:** ${formatSettingValue(config.messages.claimImage || config.messages.ticketImage)}`,
            inline: false
          },
          {
            name: '3) صور السبب',
            value: '**المكان:** لكل سبب على حدة (صورة فتح + صورة استلام).',
            inline: false
          }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر اعداد الصور، او انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_img_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الصور')
            .addOptions([
              { label: '1) صورة التكت العامة', description: 'تظهر داخل شات التكت', value: 'i1' },
              { label: '2) صورة الاستلام العامة', description: 'تظهر في طلبات وإعلانات الاستلام', value: 'i2' },
              { label: '3) صور السبب', description: 'لكل سبب: فتح + استلام', value: 'i3' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_img_menu_'),
        time: 240000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'i1') {
        config.messages.ticketImage = await promptAndStoreImage({
          prompt: '**صورة التكت العامة: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: config.messages.ticketImage,
          slotKey: 'global_ticket_image',
          failureText: '**❌ فشل حفظ الصورة العامة.**'
        });
      }

      if (c === 'i2') {
        config.messages.claimImage = await promptAndStoreImage({
          prompt: '**صورة الاستلام العامة: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: config.messages.claimImage,
          slotKey: 'global_claim_image',
          failureText: '**❌ فشل حفظ صورة الاستلام العامة.**'
        });
      }

      if (c === 'i3') {
        await setupMessage.edit({
          embeds: [normalizeEmbedForStandardMessage(colorManager.createEmbed().setTitle('**فهرس الأسباب (1 - 25)**').setDescription(buildReasonsIndexText()), '**اختر رقم السبب من القائمة التالية ثم اكتب الرقم في الشات.**')]
        }).catch(() => {});

        const idx = await askNumberInRange('**اختر رقم السبب من 1 الى 25**', 1, 25);
        if (!idx) continue;
        const key = String(idx);
        const reason = {
          name: `سبب ${idx}`,
          openImage: '',
          claimImage: '',
          ...(config.reasons[key] || {})
        };

        await setupMessage.edit({
          embeds: [normalizeEmbedForStandardMessage(
            colorManager.createEmbed().setTitle(`**صور السبب ${idx}**`).setDescription([
              `**صورة الفتح (داخل شات التكت عند الانشاء):** ${formatSettingValue(reason.openImage)}`,
              `**صورة الاستلام (في طلبات وإعلانات الاستلام):** ${formatSettingValue(reason.claimImage)}`
            ].join('\n')),
            '**اختر نوع الصورة لهذا السبب.**'
          )],
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`ticket_img_reason_menu_${message.author.id}_${Date.now()}`)
              .setPlaceholder('اختر الصورة')
              .addOptions([
                { label: 'صورة الفتح', value: 'open' },
                { label: 'صورة الاستلام', value: 'claim' },
                { label: 'انهاء', value: 'finish' }
              ])
          )]
        }).catch(() => {});

        const reasonPick = await setupMessage.awaitMessageComponent({
          filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_img_reason_menu_'),
          time: 180000
        }).catch(() => null);
        if (!reasonPick) continue;
        activePromptInteraction = reasonPick;
        await reasonPick.deferUpdate().catch(() => {});
        const rc = reasonPick.values?.[0];
        if (rc === 'finish') continue;

        if (rc === 'open') {
          reason.openImage = await promptAndStoreImage({
            prompt: '**صورة فتح السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
            currentValue: reason.openImage,
            slotKey: `reason_${key}_open`,
            failureText: '**❌ فشل حفظ صورة السبب.**'
          });
        }
        if (rc === 'claim') {
          reason.claimImage = await promptAndStoreImage({
            prompt: '**صورة استلام السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
            currentValue: reason.claimImage,
            slotKey: `reason_${key}_claim`,
            failureText: '**❌ فشل حفظ صورة السبب.**'
          });
        }

        config.reasons[key] = { ...(config.reasons[key] || {}), ...reason };
      }
    }
  };


  const openDisplayModeSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
        .setTitle('**اعدادات طريقة العرض**')
        .setDescription([
          `**الوضع الحالي:** ${config.displayMode}`,
          `**عدد صفوف الازرار:** ${config.buttonRows || 2}`,
          '**في وضع المنيو يمكنك استخدام وصف السبب لكل سبب ليظهر تحت الاسم.**'
        ].join('\n'));

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر طريقة العرض او انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_display_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر طريقة العرض')
            .addOptions([
              { label: 'استخدام الازرار', value: 'buttons' },
              { label: 'استخدام المنيو', value: 'menu' },
              { label: 'تعديل صفوف الازرار', value: 'rows' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_display_menu_'),
        time: 180000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }
      if (c === 'buttons') config.displayMode = 'buttons';
      if (c === 'menu') config.displayMode = 'menu';
      if (c === 'rows') {
        const rows = Number(await ask('**عدد الصفوف : من 1 الى 5**'));
        if (Number.isFinite(rows) && rows >= 1 && rows <= 5) config.buttonRows = rows;
      }
    }
  };

  collector.on('collect', async (interaction) => {
    try {
      const choice = interaction.values?.[0];
      if (!choice) return;

      activePromptInteraction = interaction;
      await interaction.deferUpdate().catch(() => {});

      if (choice === 'finish') {
        collector.stop('finished');
        await refresh('**تم إنهاء الاعداد.**', []);
        return;
      }

      if (choice === 'set_name') {
        const mode = await ask('**اكتب : counter او user (او 0 لاعادة التعيين)**');
        if (mode === '0') {
          config.ticketNameMode = 'counter';
          config.ticketNamePrefix = 'ticket';
          await refresh('**✅ تم إعادة تعيين اسم التكت للوضع الافتراضي.**');
          await notifySetupResult('**✅ تم إعادة تعيين اسم التكت للوضع الافتراضي.**');
          return;
        }

        if (!['counter', 'user'].includes((mode || '').toLowerCase())) {
          await refresh('**❌ فشل تحديث الاسم: اكتب فقط counter أو user أو 0.**');
          await notifySetupResult('**❌ فشل تحديث الاسم: اكتب فقط counter أو user أو 0.**');
          return;
        }

        config.ticketNameMode = mode.toLowerCase();
        const prefix = await ask('**اكتب : بادئة اسم التكت**');
        if (prefix && prefix !== '0') config.ticketNamePrefix = sanitizeName(prefix);

        await refresh('**✅ تم تحديث الاسم.**');
        await notifySetupResult('**✅ تم تحديث إعداد الاسم بنجاح.**');
        return;
      }

      if (choice === 'set_open_category') {
        const v = await ask('**ارسل : منشن/ايدي الكاتوقري (0 لاعادة التعيين)**');
        if (v === '0') {
          config.openCategoryId = null;
          await refresh('**✅ تم إعادة تعيين كاتوقري الفتح.**');
          await notifySetupResult('**✅ تم إعادة تعيين كاتوقري الفتح.**');
          return;
        }

        const catId = normalizeId(v);
        if (!catId) {
          await refresh('**❌ فشل تحديث كاتوقري الفتح: أرسل منشن أو آيدي كاتوقري صحيح.**');
          await notifySetupResult('**❌ فشل تحديث كاتوقري الفتح: أرسل منشن أو آيدي كاتوقري صحيح.**');
          return;
        }

        config.openCategoryId = catId;
        await refresh('**✅ تم تحديث كاتوقري الفتح.**');
        await notifySetupResult('**✅ تم تحديث كاتوقري الفتح بنجاح.**');
        return;
      }

      if (choice === 'set_responsibles') {
        const v = await ask([
          '**تحديد المسؤولين - اختر طريقة واحدة:**',
          '**0 = رولات الادمن العامة**',
          '**اسم مسؤولية = مسؤولية معينة** (مثال: مسؤولية الدعم / المسؤولية الدعم)',
          '**منشن رولات = رولات محددة**'
        ].join('\n'));
        if (v === '0') config.responsibleRoleIds = [];
        else if (findResponsibilityByName(v, loadResponsibilities())) {
          const resp = loadResponsibilities();
          const foundName = findResponsibilityByName(v, resp);
          const selected = foundName ? resp[foundName] : null;
          const set = new Set((selected?.roles || []).map((id) => String(id || '').trim()).filter((id) => /^\d{16,20}$/.test(id)));
          config.responsibleRoleIds = [...set];
          if (config.responsibleRoleIds.length === 0) {
            await refresh(`**تنبيه : المسؤولية \"${foundName}\" لا تحتوي رولات صالحة.**`);
            return;
          }
          await refresh(`**تم تعيين المسؤولين من المسؤولية : ${foundName}**`);
          return;
        } else {
          config.responsibleRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean);
        }
        if (config.responsibleRoleIds.length === 0) {
          await refresh( '**تنبيه : لم يتم حفظ اي رول مسؤول صالح.**');
          return;
        }
        await refresh('**✅ تم تحديث المسؤولين.**');
        await notifySetupResult('**✅ تم تحديث المسؤولين بنجاح.**');
        return;
      }

      if (choice === 'set_admin_roles') {
        const v = await ask('**ارسل : رولات الادمن (منشن/ايدي) او 0 لاستخدام الادمن رولز العامة**');
        if (v === '0') {
          config.useGlobalAdminRoles = true;
          config.adminRoleIds = [];
        } else {
          config.useGlobalAdminRoles = false;
          config.adminRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean);
        }
        if (getAdminRoles(config).length === 0) {
          await refresh( '**تنبيه : لا توجد رولات ادمن فعالة بعد التحديث.**');
          return;
        }
        await refresh('**✅ تم تحديث رولات الادمن.**');
        await notifySetupResult('**✅ تم تحديث رولات الادمن بنجاح.**');
        return;
      }

      if (choice === 'set_admin_limit') {
        const n = Number(await ask('**اكتب : حد استلام الاداري المفتوح**'));
        if (!Number.isFinite(n) || n <= 0) {
          await refresh('**❌ فشل تحديث حد استلام الاداري: أدخل رقمًا أكبر من 0.**');
          await notifySetupResult('**❌ فشل تحديث حد استلام الاداري: أدخل رقمًا أكبر من 0.**');
          return;
        }
        config.adminClaimLimit = n;
        await refresh('**✅ تم تحديث حد استلام الاداري.**');
        await notifySetupResult('**✅ تم تحديث حد استلام الاداري بنجاح.**');
        return;
      }

      if (choice === 'set_member_limit') {
        const n = Number(await ask('**اكتب : حد فتح العضو المفتوح**'));
        if (!Number.isFinite(n) || n <= 0) {
          await refresh('**❌ فشل تحديث حد فتح العضو: أدخل رقمًا أكبر من 0.**');
          await notifySetupResult('**❌ فشل تحديث حد فتح العضو: أدخل رقمًا أكبر من 0.**');
          return;
        }
        config.memberOpenLimit = n;
        await refresh('**✅ تم تحديث حد فتح العضو.**');
        await notifySetupResult('**✅ تم تحديث حد فتح العضو بنجاح.**');
        return;
      }

      if (choice === 'toggle_auto_create') {
        config.autoCreateOnRequest = !config.autoCreateOnRequest;
        await refresh(`**✅ تم التحديث : ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة إنشاء التكت قبل الاستلام: ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_hide_on_claim') {
        config.hideOnClaim = !config.hideOnClaim;
        await refresh(`**✅ تم التحديث : ${config.hideOnClaim ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة إخفاء التكت عند الاستلام: ${config.hideOnClaim ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_claim_channel') {
        config.claimFromDedicatedChannel = !config.claimFromDedicatedChannel;
        if (config.claimFromDedicatedChannel) {
          const askedChannel = normalizeId(await ask('**ارسل : منشن/ايدي شات الاستلام**'));
          const channelObj = askedChannel ? await message.guild.channels.fetch(askedChannel).catch(() => null) : null;
          if (!channelObj || channelObj.type !== ChannelType.GuildText) {
            config.claimFromDedicatedChannel = false;
            config.claimChannelId = null;
            await refresh( '**فشل : شات الاستلام غير صالح وتم الغاء التفعيل.**');
            return;
          }
          config.claimChannelId = askedChannel;
        }
        await refresh(`**✅ تم التحديث : ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة شات الاستلام المخصص: ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_keep_closed') {
        config.keepClosedTickets = !config.keepClosedTickets;
        if (config.keepClosedTickets) {
          const v = await ask('**ارسل : كاتوقري المقفلة (0 للبقاء بنفس المكان)**');
          config.closedCategoryId = v === '0' ? null : normalizeId(v);
        }
        await refresh(`**✅ تم التحديث : ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة الاحتفاظ بالتكت بعد الإغلاق: ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'set_messages') {
        await openMessagesSubmenu();
        await refresh('**✅ تم تحديث اعدادات الرسائل.**');
        await notifySetupResult('**✅ تم حفظ إعدادات الرسائل بنجاح.**');
        return;
      }

      if (choice === 'set_images') {
        await openImagesSubmenu();
        await refresh('**✅ تم تحديث اعدادات الصور.**');
        await notifySetupResult('**✅ تم حفظ إعدادات الصور بنجاح.**');
        return;
      }

      if (choice === 'set_reasons') {
        if (!config.openCategoryId) {
          await refresh('**يلزم تعيين كاتوقري الفتح قبل تعديل الاسباب.**');
          return;
        }

        const idx = await pickReasonFromMenu();
        if (!Number.isFinite(idx) || idx < 1 || idx > 25) {
          await refresh('**❌ لم يتم اختيار سبب صالح.**');
          await notifySetupResult('**❌ لم يتم اختيار سبب صالح.**');
          return;
        }

        const key = String(idx);
        const reason = {
          name: `سبب ${idx}`,
          ticketName: '',
          openImage: '',
          emoji: '🎫',
          categoryId: null,
          claimImage: '',
          beforeImage: '',
          afterImage: '',
          useCustomAdminRoles: false,
          adminRoleIds: [],
          description: '',
          ...(config.reasons[key] || {})
        };

        await openReasonSubmenu(key, reason, idx);
        config.reasons[key] = reason;

        await refresh('**✅ تم تحديث السبب.**');
        await notifySetupResult('**✅ تم حفظ إعدادات السبب بنجاح.**');
        return;
      }

      if (choice === 'set_display_mode') {
        await openDisplayModeSubmenu();
        await refresh('**✅ تم تحديث طريقة العرض.**');
        await notifySetupResult('**✅ تم حفظ إعدادات طريقة العرض بنجاح.**');
        return;
      }

      if (choice === 'send_panel_now') {
        if (!(await assertSetupReady('ارسال البانل'))) return;

        const mode = ((await ask('**طريقة الارسال : text / image / both**')) || 'both').toLowerCase();
        if (!['text', 'image', 'both'].includes(mode)) {
          await refresh('**❌ طريقة ارسال غير صالحة. استخدم text أو image أو both.**');
          return;
        }

        const text = mode === 'image' ? '' : await ask('**النص : (0 لتخطي)**');
        const imageInput = mode === 'text' ? '' : await ask('**الصورة : رابط مباشر او ارفق صورة فقط (0 لالغاء العملية)**', 180000, { imageOnly: true, preferAttachment: true });

        const payload = {
          content: text && text !== '0' ? text : null,
          components: createReasonComponents(config, message.guild.id, panelId)
        };

        const previousPanelMessage = config.panelMessageId
          ? await panelChannel.messages.fetch(config.panelMessageId).catch(() => null)
          : null;

        if (mode === 'image' || mode === 'both') {
          if (!imageInput || imageInput === '0') {
            await refresh('**❌ تم إلغاء ارسال البانل: وضع الصورة يتطلب صورة صالحة.**');
            return;
          }

          let storedPanelImage = '';
          try {
            storedPanelImage = await storeImageLocally(imageInput, message.guild.id, `panel_send_${Date.now()}`);
          } catch {
            await refresh('**❌ فشل رفع صورة البانل. تأكد ان الرابط مباشر أو ارسل الصورة كمرفق بدون نص.**');
            return;
          }

          const panelImage = resolveImageForSend(storedPanelImage);
          if (!panelImage) {
            await refresh('**❌ فشل تجهيز صورة البانل بعد الحفظ.**');
            return;
          }

          if (previousPanelMessage?.editable) {
            await previousPanelMessage.edit({ ...payload, files: [panelImage] }).catch(() => {});
          } else {
            const sentPanelMessage = await panelChannel.send({ ...payload, files: [panelImage] }).catch(() => null);
            if (sentPanelMessage) config.panelMessageId = sentPanelMessage.id;
          }
          removeStoredImage(storedPanelImage);
        } else {
          if (previousPanelMessage?.editable) {
            await previousPanelMessage.edit(payload).catch(() => {});
          } else {
            const sentPanelMessage = await panelChannel.send(payload).catch(() => null);
            if (sentPanelMessage) config.panelMessageId = sentPanelMessage.id;
          }
        }

        if (previousPanelMessage?.id) config.panelMessageId = previousPanelMessage.id;

        await refresh(`**✅ تم ارسال بانل التكت بنجاح في <#${panelId}>.**`);
        return;
      }

      if (choice === 'toggle_delete_claim_msg') {
        config.deleteClaimMessageOnClaim = !config.deleteClaimMessageOnClaim;
        await refresh(`**✅ تم التحديث : ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة حذف رسالة الاستلام بعد التنفيذ: ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_auto_close') {
        config.autoCloseEnabled = !config.autoCloseEnabled;
        if (config.autoCloseEnabled) {
          const hours = Number(await ask('**ارسل مدة الإغلاق التلقائي بالساعات (مثال: 24 أو 12.5)**'));
          if (!Number.isFinite(hours) || hours <= 0) {
            config.autoCloseEnabled = false;
            await refresh('**❌ فشل التفعيل: أدخل مدة صحيحة بالساعات أكبر من 0.**');
            await notifySetupResult('**❌ فشل تفعيل الإغلاق التلقائي بسبب مدة غير صالحة.**');
            return;
          }
          config.autoCloseHours = Math.round(hours * 100) / 100;
        }
        await refresh(`**✅ تم التحديث : ${config.autoCloseEnabled ? `مفعل (${config.autoCloseHours} ساعة)` : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة الإغلاق التلقائي: ${config.autoCloseEnabled ? `مفعل (${config.autoCloseHours} ساعة)` : 'مقفل'}.**`);
        return;
      }

      if (choice === 'set_log_channel') {
        const v = await ask('**ارسل : منشن/ايدي روم اللوق (0 لاعادة التعيين)**');
        if (v === '0') {
          config.logChannelId = null;
          await refresh('**✅ تم إعادة تعيين روم اللوق.**');
          await notifySetupResult('**✅ تم حذف روم اللوق من الإعدادات.**');
          return;
        }

        const logChannelId = normalizeId(v);
        const logChannel = logChannelId ? await message.guild.channels.fetch(logChannelId).catch(() => null) : null;
        if (!logChannel || !logChannel.isTextBased?.()) {
          await refresh('**❌ روم اللوق غير صالح. أرسل منشن أو آيدي روم نصي صحيح.**');
          await notifySetupResult('**❌ فشل تعيين روم اللوق.**');
          return;
        }

        config.logChannelId = logChannelId;
        await refresh(`**✅ تم تعيين روم اللوق :** <#${logChannelId}>`);
        await notifySetupResult(`**✅ تم تعيين روم اللوق :** <#${logChannelId}>`);
        return;
      }

    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(buildTicketMessagePayload('خطأ', '**حدث خطأ اثناء تحديث الاعدادات.**', { ephemeral: true })).catch(() => {});
      }
    }
  });

  collector.on('end', async () => {
    setGuildData(message.guild.id, config, tickets, pendingRequests, panelId);
    await setupMessage.edit({ embeds: [buildSetupEmbed()], components: [] }).catch(() => {});
    await controlChannel.send(buildTicketMessagePayload('تم', '**تم حفظ اعدادات التكت.**')).catch(() => {});
    activeTicketSetupSessions.delete(setupSessionKey);
  });
}

async function handleTransferResponsibility(interaction, guildId, panelId, channelId, value) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply().catch(() => {});
  }

  if (!value || value === 'resp_none') {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا توجد مسؤولية صالحة.**')).catch(() => {});
    return;
  }

  const responsibilities = loadResponsibilities();
  const responsibilityNames = Object.keys(responsibilities);

  let respName = null;
  if (value.startsWith('respidx_')) {
    const index = Number(value.replace('respidx_', ''));
    if (Number.isInteger(index) && index >= 0 && index < responsibilityNames.length) {
      respName = responsibilityNames[index];
    }
  } else if (value.startsWith('resp_')) {
    respName = value.replace('resp_', '');
  }

  if (!respName) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا توجد مسؤولية صالحة.**')).catch(() => {});
    return;
  }

  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket || interaction.channelId !== actionChannelId) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**')).catch(() => {});
    return;
  }

  if (!canManageTicket(interaction, ticket, config)) {
    await interaction.deleteReply().catch(() => {});
    return;
  }

  const selected = responsibilities[respName];
  if (!selected) {
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**المسؤولية غير موجودة.**')).catch(() => {});
    return;
  }

  const previousClaimer = ticket.claimedBy;
  const previousTransferredUserIds = Array.isArray(ticket.transferredUserIds) ? ticket.transferredUserIds.map((id) => String(id || '').trim()) : [];
  ticket.claimedBy = null;
  ticket.transferredTo = respName;

  const targetRoles = (selected.roles || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && interaction.guild.roles.cache.has(id));
  const generalResponsibleRoles = (config.responsibleRoleIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && interaction.guild.roles.cache.has(id));
  const adminRoles = getAdminRoles(config, ticket?.reasonKey);
  const allKnownRoles = [...new Set([...generalResponsibleRoles, ...targetRoles, ...adminRoles])];

  for (const roleId of allKnownRoles) {
    const shouldSee = targetRoles.includes(roleId) || generalResponsibleRoles.includes(roleId);
    await interaction.channel.permissionOverwrites.edit(roleId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: shouldSee
    }).catch(() => {});
  }

  ticket.transferredRoleIds = [...targetRoles];
  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم تحويل التكت عن طريق : <@${interaction.user.id}> -> ${respName}`,
    actor: interaction.user
  });
  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);

  const responsibleUsers = (selected.responsibles || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id));
  const shouldGrantIndividualTransferUsers = targetRoles.length === 0;

  for (const userId of [...new Set([...previousTransferredUserIds, ...responsibleUsers])]) {
    const shouldSee = shouldGrantIndividualTransferUsers && responsibleUsers.includes(userId);
    await interaction.channel.permissionOverwrites.edit(userId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: true
    }).catch(() => {});
  }

  const mentions = [
    ...targetRoles.map((id) => `<@&${id}>`),
    ...responsibleUsers.map((id) => `<@${id}>`)
  ];

  const onlineResponsibleMentions = responsibleUsers
    .filter((uid) => {
      const member = interaction.guild.members.cache.get(uid);
      const status = member?.presence?.status;
      return status && status !== 'offline';
    })
    .map((uid) => `<@${uid}>`);

  if (previousClaimer) {
    await interaction.channel.permissionOverwrites.edit(previousClaimer, { ViewChannel: false, SendMessages: false }).catch(() => {});
  }
  ticket.transferredUserIds = shouldGrantIndividualTransferUsers ? [...responsibleUsers] : [];
  const dmEmbed = makeTicketEmbed('تحويل تكت', `يوجد تكت تم تحويله لمسؤوليتكم في <#${actionChannelId}>`);
  if (!Array.isArray(ticket.transferDmNotifications)) ticket.transferDmNotifications = [];
  for (const uid of responsibleUsers) {
    const user = await interaction.client.users.fetch(uid).catch(() => null);
    if (user) {
      const sentDm = await user.send({
        embeds: [dmEmbed]
      }).catch(() => null);
      if (sentDm) {
        ticket.transferDmNotifications.push({
          userId: uid,
          messageId: sentDm.id,
          transferredById: interaction.user.id
        });
      }
    }
  }

  const mentionChunks = buildMentionChunks(targetRoles);
  for (const chunk of mentionChunks) {
    await interaction.channel.send({ content: chunk }).catch(() => {});
  }

  const renamed = `مسؤولين-${sanitizeName(respName)}`.slice(0, 90);
  await interaction.channel.setName(renamed).catch(() => {});

  if (interaction.message?.editable) {
    const refreshedControls = await buildTicketControls(guildId, resolvedPanelId, actionChannelId, config, {
      includeClaimButton: false,
      disableClaimButton: true,
      hideReassignButton: true
    });
    await interaction.message.edit({ components: refreshedControls }).catch(() => {});
  }

  await interaction.editReply({
    content: mentions.join(' ') || null,
    ...buildTicketMessagePayload('تحويل', `**تم تحويل التكت لمسؤولين : ${respName}**\n**المتصلون الآن:** ${onlineResponsibleMentions.join(' ') || 'لا يوجد'}\n**الرولات:** ${targetRoles.map((id) => `<@&${id}>`).join(' ') || 'لا يوجد'}`)
  }).catch(() => {});
}

async function showInputModal(interaction, customId, title, label, placeholder = '') {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(placeholder)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function showResponsibilitySearchModal(interaction, guildId, panelId, channelId) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_transfer_search_modal_${guildId}_${panelId}_${channelId}`)
    .setTitle('بحث المسؤولية');

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel('اسم المسؤولية')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('اكتب اسم المسؤولية أو جزء منه')
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client) {
  const { config } = getPanelData(guildId, panelId || 'default');
  const reason = config.reasons?.[reasonKey] || {};
  const modalCfg = reason.openModal && typeof reason.openModal === 'object' ? reason.openModal : null;
  if (!modalCfg?.enabled) {
    await handleOpenRequest(interaction, guildId, panelId, reasonKey);
    return;
  }

  const fields = Array.isArray(modalCfg.fields) ? modalCfg.fields.filter((f) => f?.label).slice(0, 5) : [];
  if (fields.length === 0) {
    await handleOpenRequest(interaction, guildId, panelId, reasonKey);
    return;
  }

  const nonce = `${interaction.user.id}_${Date.now()}`;
  const customId = `ticket_open_reason_modal_${guildId}_${panelId}_${reasonKey}_${nonce}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle((modalCfg.title || `نموذج ${reason.name || `سبب ${reasonKey}`}`).slice(0, 45));

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const input = new TextInputBuilder()
      .setCustomId(`f_${i}`)
      .setLabel(String(field.label).slice(0, 45))
      .setStyle((field.style || 'short') === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false)
      .setMaxLength(400)
      .setPlaceholder(String(field.placeholder || modalCfg.description || '').slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  if (!client.ticketOpenModalData) client.ticketOpenModalData = new Map();
  client.ticketOpenModalData.set(customId, { guildId, panelId, reasonKey, fields, createdAt: Date.now() });
  await interaction.showModal(modal);
}

function registerTicketMessageActivityTracker(client) {
  if (client.__ticketMessageActivityTrackerRegistered) return;
  client.__ticketMessageActivityTrackerRegistered = true;

  client.on('messageCreate', async (message) => {
    if (!message.guild || !message.channel || message.author?.bot) return;
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const { panelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, 'default');
    if (!ticket) return;

    if (!canUserWriteInTicket(message, ticket, config)) {
      rememberDeletedTicketMessage(ticket, message);
      await message.delete().catch(() => {});
      await recordUnauthorizedTicketMessage(message, ticket, config);
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
      return;
    }

    if (ticket.status !== 'open') return;
    if (touchTicketActivity(ticket, message.createdTimestamp || Date.now())) {
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
    }
  });

  client.on('messageDelete', async (message) => {
    if (!message?.guild || !message.channel) return;
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const { panelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, 'default');
    if (!ticket) return;
    if (rememberDeletedTicketMessage(ticket, message)) {
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
    }
  });

  client.on('messageDeleteBulk', async (messages) => {
    const first = messages?.first?.();
    if (!first?.guild || !first.channel) return;
    const guildId = first.guild.id;
    const channelId = first.channel.id;
    const { panelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, 'default');
    if (!ticket) return;
    let changed = false;
    for (const message of messages.values()) {
      changed = rememberDeletedTicketMessage(ticket, message) || changed;
    }
    if (changed) {
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
    }
  });
}

function startTicketAutoCloseWatcher(client) {
  if (client.__ticketAutoCloseWatcherStarted) return;
  client.__ticketAutoCloseWatcherStarted = true;

  const runCheck = async () => {
    const store = loadStore();

    for (const [guildId, guildData] of Object.entries(store || {})) {
      const panels = guildData?.panels || {};
      for (const [panelId, panel] of Object.entries(panels)) {
        const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
        const timeoutMs = getTicketAutoCloseMs(config);
        if (!timeoutMs) continue;
        const warningMs = Math.max(1, Number(config.autoCloseWarningMinutes || 10)) * 60 * 1000;

        let changed = false;
        for (const [channelId, ticket] of Object.entries(tickets || {})) {
          if (!ticket || ticket.status !== 'open') continue;
          const dueAt = getTicketDueAt(ticket, config);
          if (!dueAt) continue;

          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (!guild) continue;
          const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
          if (!channel || channel.type !== ChannelType.GuildText) continue;

          const now = Date.now();
          if (ticket.logSyncFailedAt && channel) {
            await syncTicketLogMessage({
              guild,
              config,
              ticket,
              channelId,
              actionText: {
                type: 'log_retry',
                message: 'إعادة مزامنة سجل التكت بعد فشل سابق'
              }
            }).catch(() => {});
          }
          if (now >= dueAt) {
            await closeTicketCore({
              channel,
              guildId,
              panelId,
              channelId,
              config,
              tickets,
              pendingRequests,
              ticket,
              autoClose: true,
              closedByLabel: 'خمول التكت'
            });
            changed = true;
            continue;
          }

          if ((dueAt - now) <= warningMs && !ticket.autoCloseWarningSentAt) {
            await sendAutoCloseWarning(channel, ticket, dueAt);
            ticket.autoCloseWarningSentAt = now;
            changed = true;
          }
        }

        if (changed) {
          setGuildData(guildId, config, tickets, pendingRequests, panelId);
        }
      }
    }
  };

  runCheck().catch(() => {});
  client.__ticketAutoCloseWatcherInterval = setInterval(() => {
    runCheck().catch(() => {});
  }, 60 * 1000);
}

function registerHandlers(client) {
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerTicketMessageActivityTracker(client);
  startTicketAutoCloseWatcher(client);

  registerTicketInteractionRouter(async (interaction) => {
    try {
      if (client.ticketOpenModalData && client.ticketOpenModalData.size > 0) {
        const now = Date.now();
        for (const [key, value] of client.ticketOpenModalData.entries()) {
          if (!value?.createdAt || now - value.createdAt > 15 * 60 * 1000) {
            client.ticketOpenModalData.delete(key);
          }
        }
      }

      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const id = interaction.customId || '';
        if (interaction.guild && interaction.member && id.startsWith('ticket_') && resolveTicketBlockForMember(interaction.guild.id, interaction.member)) {
          await interaction.reply(buildTicketMessagePayload('بلوك التكت', '**أنت محظور من استخدام نظام التكت حالياً.**', { ephemeral: true })).catch(() => {});
          return;
        }

        if (id.startsWith('ticket_open_btn_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const panelId = parts.length >= 6 ? parts[4] : 'default';
          const reasonKey = parts.length >= 6 ? parts[5] : parts[4];
          await handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client);
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_open_menu_')) {
          const raw = id.replace('ticket_open_menu_', '');
          const [guildId, panelId = 'default'] = raw.split('_');
          const value = interaction.values?.[0] || 'reason_0';
          const reasonKey = value.replace('reason_', '');
          await handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client);
          const { config } = getPanelData(guildId, panelId || 'default');
          if (interaction.message?.editable) {
            await interaction.message.edit({ components: createReasonComponents(config, guildId, panelId || 'default') }).catch(() => {});
          }
          return;
        }

        if (id.startsWith('ticket_claimreq_')) {
          const reqId = id.replace('ticket_claimreq_', '');
          await handleClaimFromRequest(interaction, reqId);
          return;
        }

        if (id.startsWith('ticket_claim_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          await handleClaimInTicket(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_close_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          await handleClose(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_reassign_claim_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const panelId = parts.length >= 6 ? parts[4] : 'default';
          const channelId = parts.length >= 6 ? parts[5] : parts[4];
          await handleReassignClaim(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_reassign_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          await handleReassignRequest(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_delete_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : findTicketPanel(guildId, parts[3], 'default');
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**هذا الزر متاح بعد الإغلاق فقط.**', { ephemeral: true }));
            return;
          }
          if (!canManagePostCloseControls(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الحذف.**', { ephemeral: true }));
            return;
          }
          interaction.channel.ticketMeta = ticket;
          const transcriptFile = await buildTicketTranscript(interaction.channel).catch(() => null);
          ticket.deletedChannel = true;
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId,
            actionText: `تم حذف التكت عن طريق : <@${interaction.user.id}>`,
            actor: interaction.user,
            transcriptFile
          });
          delete tickets[channelId];
          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload(
            'حذف',
            '**سيتم حذف التكت خلال 3 ثواني.**',
            { ephemeral: true }
          ));
          setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
          return;
        }

        if (id.startsWith('ticket_down2_') || id.startsWith('ticket_down_') || id.startsWith('ticket_up1_') || id.startsWith('ticket_up2_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : findTicketPanel(guildId, parts[3], 'default');
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**أزرار النقاط متاحة بعد إغلاق التكت فقط.**', { ephemeral: true }));
            return;
          }
          if (!canManagePostCloseControls(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية النقاط.**', { ephemeral: true }));
            return;
          }

          const delta = id.startsWith('ticket_down2_') ? -2
            : id.startsWith('ticket_down_') ? -1
              : id.startsWith('ticket_up1_') ? 1 : 2;
          const reasonName = config.reasons?.[ticket.reasonKey]?.name;
          const respName = ticket.transferredTo || reasonName || 'ticket';
          const targetId = ticket.claimedBy;
          if (!targetId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا يوجد مستلم مرتبط بهذا التكت للنقاط.**', { ephemeral: true }));
            return;
          }

          const points = loadPoints();
          const now = Date.now().toString();
          if (!points[respName] || typeof points[respName] !== 'object') points[respName] = {};
          const existingAward = ticket.pointAward && typeof ticket.pointAward === 'object' ? ticket.pointAward : null;
          if (existingAward) {
            if (existingAward.actorId === interaction.user.id) {
              await interaction.reply({
                ...buildTicketMessagePayload(
                  'النقاط مسجلة مسبقًا',
                  `**أنت بالفعل وضعت ${existingAward.delta > 0 ? '+' : ''}${existingAward.delta} نقطة لهذا الإداري.**\n**هل تريد التراجع؟**`,
                  { ephemeral: true }
                ),
                components: buildPointRevertControls(guildId, resolvedPanelId, channelId)
              });
            } else {
              await interaction.reply(buildTicketMessagePayload(
                'النقاط مسجلة مسبقًا',
                `**المسؤول :** <@${existingAward.actorId}>\n**أعطى الإداري بالفعل :** ${existingAward.delta > 0 ? '+' : ''}${existingAward.delta} نقطة.`,
                { ephemeral: true }
              ));
            }
            return;
          }
          const existing = points[respName][targetId];
          const total = typeof existing === 'object'
            ? Object.values(existing).reduce((s, v) => s + Number(v || 0), 0)
            : Number(existing || 0);
          const next = Math.max(0, total + delta);
          const actualDelta = next - total;
          if (typeof existing === 'object' && existing !== null) {
            points[respName][targetId][now] = actualDelta;
          } else if (existing !== undefined) {
            points[respName][targetId] = { [now]: actualDelta };
          } else {
            points[respName][targetId] = { [now]: actualDelta };
          }
          appendPointAuditEntry(points, {
            id: now,
            targetId,
            actorId: interaction.user.id,
            delta: actualDelta,
            respName,
            source: 'ticket_button',
            at: now
          });
          ticket.pointAward = { actorId: interaction.user.id, delta: actualDelta, respName, targetId, at: now, auditId: now };
          savePoints(points);

          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId,
            actionText: `تم تعديل النقاط عن طريق : <@${interaction.user.id}> (${actualDelta > 0 ? '+' : ''}${actualDelta})`,
            actor: interaction.user
          });

          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('تم', `**تم تعديل النقاط (${delta > 0 ? '+' : ''}${delta}) للمستلم.**`, { ephemeral: true }));
          return;
        }

        if (id.startsWith('ticket_points_revert_') || id.startsWith('ticket_points_cancel_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const panelId = parts[4];
          const channelId = parts[5];
          if (id.startsWith('ticket_points_cancel_')) {
            await interaction.update({ components: [] });
            return;
          }
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          const existingAward = ticket.pointAward && typeof ticket.pointAward === 'object' ? ticket.pointAward : null;
          if (!existingAward) {
            await interaction.update({ components: [] });
            return;
          }
          if (existingAward.actorId !== interaction.user.id) {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**فقط المسؤول الذي قيّم يمكنه التراجع عن النقاط.**', { ephemeral: true }));
            return;
          }
          const points = loadPoints();
          const bucket = points?.[existingAward.respName]?.[existingAward.targetId];
          if (bucket && typeof bucket === 'object') {
            delete bucket[existingAward.at];
          }
          removePointAuditEntry(points, existingAward.auditId || existingAward.at);
          delete ticket.pointAward;
          savePoints(points);
          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.update({
            ...buildTicketMessagePayload('تم', '**تم التراجع عن النقاط السابقة، يمكنك اختيار نقاط جديدة الآن.**', { ephemeral: true }),
            components: []
          });
          return;
        }

        if (id.startsWith('ticket_toggle_member_') || id.startsWith('ticket_toggle_claimer_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const channelId = parts[4];
          const panelId = findTicketPanel(guildId, channelId, 'default');
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**هذه الأزرار متاحة بعد إغلاق التكت فقط.**', { ephemeral: true }));
            return;
          }
          if (!canManagePostCloseControls(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية هذا الإجراء.**', { ephemeral: true }));
            return;
          }

          const isMember = id.startsWith('ticket_toggle_member_');
          const targetId = isMember ? ticket.memberId : ticket.claimedBy;
          if (!targetId) {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**لا يوجد مستخدم مرتبط بهذا الزر.**', { ephemeral: true }));
            return;
          }

          const key = isMember ? 'memberHidden' : 'claimerHidden';
          ticket[key] = !(ticket[key] !== false);
          await interaction.channel.permissionOverwrites.edit(targetId, {
            ViewChannel: !ticket[key],
            SendMessages: !ticket[key],
            ReadMessageHistory: true
          }).catch(() => {});

          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.update({
            components: buildPostCloseControls(guildId, resolvedPanelId, channelId, ticket)
          });
          return;
        }

        if (id.startsWith('ticket_rename_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية تغيير الاسم.**', { ephemeral: true }));
            return;
          }
          await showInputModal(interaction, `ticket_rename_modal_${guildId}_${resolvedPanelId}_${actionChannelId}`, 'تغيير اسم التكت', 'الاسم الجديد', 'مثال : support-user');
          return;
        }

        if (id.startsWith('ticket_transfer_search_page_')) {
          const parts = id.split('_');
          const page = Number(parts.pop());
          const sessionId = parts.slice(4).join('_');
          const responsibilities = loadResponsibilities();
          const pageData = buildResponsibilitySearchResultsMessage(sessionId, responsibilities, page);
          if (!pageData) {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**انتهت صلاحية نتائج البحث، أعد البحث مرة أخرى.**', { ephemeral: true }));
            return;
          }
          await interaction.update(pageData.payload);
          return;
        }

        if (id.startsWith('ticket_add_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الاضافة.**', { ephemeral: true }));
            return;
          }
          await showInputModal(interaction, `ticket_add_modal_${guildId}_${resolvedPanelId}_${actionChannelId}`, 'اضافة شخص للتكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_remove_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الازالة.**', { ephemeral: true }));
            return;
          }
          await showInputModal(interaction, `ticket_remove_modal_${guildId}_${resolvedPanelId}_${actionChannelId}`, 'ازالة شخص من التكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_ping_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { panelId: resolvedPanelId, tickets, config, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الاستدعاء.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'open') {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**لا يمكن الاستدعاء بعد إقفال التكت.**', { ephemeral: true }));
            return;
          }
          const cooldownKey = `${interaction.guild.id}:${channelId}:${interaction.user.id}`;
          const last = pingCooldowns.get(cooldownKey) || 0;
          const now = Date.now();
          const cooldownMs = 10 * 60 * 1000;
          if (now - last < cooldownMs) {
            const left = Math.ceil((cooldownMs - (now - last)) / 1000);
            await interaction.reply(buildTicketMessagePayload('كولداون', `**انتظر ${left} ثانية قبل استخدام الاستدعاء مرة أخرى.**`, { ephemeral: true }));
            return;
          }

          const user = await client.users.fetch(ticket.memberId).catch(() => null);
          const link = `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;
          if (user) {
            await user.send(buildTicketMessagePayload('استدعاء للتكت', `**تم استدعاؤك للتكت**\n**الرابط :** ${link}`)).catch(() => {});
          }
          pingCooldowns.set(cooldownKey, now);
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تم استدعاء العضو عن طريق : <@${interaction.user.id}>`,
            actor: interaction.user
          });
          setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('تم', `**تم استدعاء العضو :** <@${ticket.memberId}>`, { ephemeral: true }));
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_transfer_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const selected = interaction.values?.[0] || 'resp_none';
          if (selected === 'resp_search') {
            await showResponsibilitySearchModal(interaction, guildId, panelId, channelId);
            return;
          }
          await handleTransferResponsibility(interaction, guildId, panelId, channelId, selected);
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (ticket && interaction.message?.editable) {
            const hasTransferredAssignment = Boolean(ticket.transferredRoleIds?.length || ticket.transferredUserIds?.length || ticket.transferredTo);
            const refreshedControls = await buildTicketControls(guildId, resolvedPanelId, actionChannelId, config, {
              includeClaimButton: !hasTransferredAssignment,
              disableClaimButton: hasTransferredAssignment,
              hideReassignButton: hasTransferredAssignment
            });
            await interaction.message.edit({ components: refreshedControls }).catch(() => {});
          }
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_transfer_confirm_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const panelId = parts.length >= 6 ? parts[4] : 'default';
          const channelId = parts.length >= 6 ? parts[5] : parts[4];
          const selected = interaction.values?.[0] || 'resp_none';
          await handleTransferResponsibility(interaction, guildId, panelId, channelId, selected);
          return;
        }
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_')) {
        const modalId = interaction.customId;
        if (interaction.guild && interaction.member && resolveTicketBlockForMember(interaction.guild.id, interaction.member)) {
          await interaction.reply(buildTicketMessagePayload('بلوك التكت', '**أنت محظور من استخدام نظام التكت حالياً.**', { ephemeral: true })).catch(() => {});
          return;
        }

        if (modalId.startsWith('ticket_open_reason_modal_')) {
          const data = client.ticketOpenModalData?.get(modalId);
          if (!data) {
            await interaction.reply(buildTicketMessagePayload('تنبيه', '**انتهت صلاحية نموذج فتح التكت، حاول مرة أخرى.**', { ephemeral: true }));
            return;
          }

          const answers = {};
          for (let i = 0; i < data.fields.length; i += 1) {
            const label = data.fields[i].label || `حقل ${i + 1}`;
            answers[label] = interaction.fields.getTextInputValue(`f_${i}`);
          }
          client.ticketOpenModalData.delete(modalId);
          interaction.ticketModalAnswers = answers;
          await handleOpenRequest(interaction, data.guildId, data.panelId, data.reasonKey);
          return;
        }

        if (modalId.startsWith('ticket_transfer_search_modal_')) {
          const [, , , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const query = interaction.fields.getTextInputValue('value');
          const responsibilities = loadResponsibilities();
          const results = searchResponsibilitiesByName(query, responsibilities, 50);
          if (results.length === 0) {
            await interaction.reply(buildTicketMessagePayload('بحث المسؤولية', '**لا توجد نتائج مطابقة.**', { ephemeral: true }));
            return;
          }
          const sessionId = createResponsibilitySearchSession({ guildId, panelId, channelId, query, results });
          const pageData = buildResponsibilitySearchResultsMessage(sessionId, responsibilities, 0);
          await interaction.reply(pageData.payload);
          return;
        }

        if (modalId.startsWith('ticket_rename_modal_')) {
          const [, , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const newName = sanitizeName(interaction.fields.getTextInputValue('value'));
          if (!newName) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**الاسم غير صالح.**', { ephemeral: true }));
            return;
          }
          const { config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية تغيير الاسم.**', { ephemeral: true }));
            return;
          }
          await interaction.channel.setName(newName).catch(() => {});
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تم تغيير اسم التكت عن طريق : <@${interaction.user.id}> -> ${newName}`,
            actor: interaction.user
          });
          await interaction.reply(buildTicketMessagePayload('تم', `**تم تغيير الاسم :** ${newName}`, { ephemeral: true }));
          return;
        }

        if (modalId.startsWith('ticket_add_modal_')) {
          const [, , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**المدخل غير صالح.**', { ephemeral: true }));
            return;
          }
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الاضافة.**', { ephemeral: true }));
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**الشخص هو صاحب التكت بالفعل.**', { ephemeral: true }));
            return;
          }
          const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!targetMember) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا يمكن العثور على العضو.**', { ephemeral: true }));
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          }).catch(() => {});
          if (!ticket.extraMembers.includes(userId)) ticket.extraMembers.push(userId);
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تمت إضافة شخص عن طريق : <@${interaction.user.id}> -> <@${userId}>`,
            actor: interaction.user
          });
          setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('تم', `**تم اضافة الشخص :** <@${userId}>`, { ephemeral: true }));
          return;
        }

        if (modalId.startsWith('ticket_remove_modal_')) {
          const [, , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**المدخل غير صالح.**', { ephemeral: true }));
            return;
          }
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**ليس لديك صلاحية الازالة.**', { ephemeral: true }));
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply(buildTicketMessagePayload('خطأ', '**لا يمكن إزالة صاحب التكت.**', { ephemeral: true }));
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false }).catch(() => {});
          ticket.extraMembers = (ticket.extraMembers || []).filter((id) => id !== userId);
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تمت إزالة شخص عن طريق : <@${interaction.user.id}> -> <@${userId}>`,
            actor: interaction.user
          });
          setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('تم', `**تم ازالة الشخص :** <@${userId}>`, { ephemeral: true }));
          return;
        }
      }

      return false;
    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(buildTicketMessagePayload('خطأ', '**حدث خطأ أثناء معالجة التكت.**', { ephemeral: true })).catch(() => {});
      }
      return true;
    }
  });
}

module.exports = { name, aliases, execute, registerHandlers };
