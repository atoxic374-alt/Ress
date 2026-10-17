const sharp = require('sharp');

const bannerColorCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COLOR = '#5865F2';

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b]
        .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
        .join('')}`.toUpperCase();
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
        const color = rgbToHex(stats.dominant);
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

module.exports = { getGuildBannerHex, clearGuildBannerColorCache, rgbToHex, DEFAULT_COLOR };
