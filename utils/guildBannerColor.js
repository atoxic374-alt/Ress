const sharp = require('sharp');

const bannerColorCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COLOR = '#5865F2';

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b]
        .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
        .join('')}`.toUpperCase();
}

async function extractBannerAccent(buffer, fallback) {
    const { data } = await sharp(buffer)
        .resize(128, 72, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 3) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luminance = (r * 0.299) + (g * 0.587) + (b * 0.114);
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (luminance < 120 || luminance > 230 || chroma < 8 || chroma > 120) continue;
        red += r;
        green += g;
        blue += b;
        count++;
    }
    if (!count) return fallback;
    return rgbToHex({ r: red / count, g: green / count, b: blue / count });
}

async function getGuildBannerHex(guild, fallback = DEFAULT_COLOR) {
    const bannerUrl = guild?.bannerURL?.({ extension: 'png', size: 1024 });
    if (!bannerUrl) return fallback;

    const cacheKey = `${guild.id}:${bannerUrl}`;
    const cached = bannerColorCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.color;

    try {
        const response = await fetch(bannerUrl);
        if (!response.ok) throw new Error(`Banner request failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const stats = await sharp(buffer).resize(64, 64, { fit: 'cover' }).stats();
        const color = await extractBannerAccent(buffer, rgbToHex(stats.dominant));
        bannerColorCache.set(cacheKey, { color, createdAt: Date.now() });
        return color;
    } catch (error) {
        console.error(`تعذر استخراج لون بنر السيرفر ${guild?.id || 'unknown'}:`, error.message);
        return fallback;
    }
}

function clearGuildBannerColorCache(guildId) {
    for (const key of bannerColorCache.keys()) {
        if (key.startsWith(`${guildId}:`)) bannerColorCache.delete(key);
    }
}

module.exports = { getGuildBannerHex, clearGuildBannerColorCache, rgbToHex, extractBannerAccent, DEFAULT_COLOR };
