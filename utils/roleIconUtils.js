const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const MAX_ICON_BYTES = 256 * 1024;

function parseCustomEmoji(input) {
  const match = input.match(/<(a?):\w+:(\d+)>/);
  if (!match) return null;
  const isAnimated = match[1] === 'a';
  const id = match[2];
  const urls = isAnimated
    ? [
        `https://cdn.discordapp.com/emojis/${id}.gif`,
        `https://cdn.discordapp.com/emojis/${id}.png`
      ]
    : [`https://cdn.discordapp.com/emojis/${id}.png`];
  return { id, isAnimated, urls };
}

function parseEmojiId(input) {
  const match = input.match(/\b\d{17,19}\b/);
  if (!match) return null;
  return match[0];
}

function parseUnicodeEmoji(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const codePoints = Array.from(trimmed).map(char => char.codePointAt(0).toString(16)).join('-');
  if (!codePoints) return null;
  return `https://twemoji.maxcdn.com/v/latest/72x72/${codePoints}.png`;
}

function extractFirstEmoji(input) {
  if (!input) return null;
  const match = input.match(/(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/u);
  return match ? match[0] : null;
}

async function fetchImageBuffer(url, maxBytes = MAX_ICON_BYTES) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`فشل تحميل الصورة: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('الملف ليس صورة.');
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error('حجم الصورة كبير جداً.');
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > maxBytes) {
    throw new Error('حجم الصورة كبير جداً.');
  }
  return buffer;
}

async function tryFetchImage(urls) {
  for (const url of urls) {
    try {
      const buffer = await fetchImageBuffer(url);
      if (buffer) return buffer;
    } catch (error) {
      continue;
    }
  }
  return null;
}

async function resolveIconBuffer(input, attachments = []) {
  if (attachments && attachments.length > 0) {
    const attachmentUrl = attachments[0].url;
    return fetchImageBuffer(attachmentUrl);
  }

  if (!input) return null;

  const trimmedInput = input.trim();
  const tokens = trimmedInput.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    if (token.startsWith('http://') || token.startsWith('https://')) {
      const buffer = await tryFetchImage([token]);
      if (buffer) return buffer;
    }
  }

  const customMatches = [...trimmedInput.matchAll(/<(a?):\w+:(\d+)>/g)];
  for (const match of customMatches) {
    const customEmoji = parseCustomEmoji(match[0]);
    if (!customEmoji) continue;
    const buffer = await tryFetchImage(customEmoji.urls);
    if (buffer) return buffer;
  }

  const emojiId = parseEmojiId(trimmedInput);
  if (emojiId) {
    const buffer = await tryFetchImage([
      `https://cdn.discordapp.com/emojis/${emojiId}.png`,
      `https://cdn.discordapp.com/emojis/${emojiId}.gif`
    ]);
    if (buffer) return buffer;
  }

  const emojiToken = extractFirstEmoji(trimmedInput);
  if (emojiToken) {
    const unicodeUrl = parseUnicodeEmoji(emojiToken);
    if (unicodeUrl) {
      const buffer = await tryFetchImage([unicodeUrl]);
      if (buffer) return buffer;
    }
  }

  return null;
}

async function applyRoleIcon(role, buffer) {
  const updatedRole = await role.setIcon(buffer).catch(() => null);
  const roleId = updatedRole?.id || role?.id;
  if (!roleId) {
    throw new Error('icon_not_applied');
  }

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  let refreshedRole = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await wait(750);
    }
    refreshedRole = await role.guild.roles.fetch(roleId).catch(() => null);
    if (refreshedRole?.icon) break;
  }

  if (!refreshedRole || !refreshedRole.icon) {
    throw new Error('icon_not_applied');
  }
  return refreshedRole;
}

module.exports = {
  parseCustomEmoji,
  parseEmojiId,
  parseUnicodeEmoji,
  extractFirstEmoji,
  fetchImageBuffer,
  tryFetchImage,
  resolveIconBuffer,
  applyRoleIcon
};
