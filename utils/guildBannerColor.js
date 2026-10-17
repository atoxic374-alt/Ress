const sharp = require('sharp');

const bannerColorCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COLOR = '#5865F2';

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b]
        .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
        .join('')}`.toUpperCase();
}

function lightenHex(hex, minimumLightness = 0.55) {
    const value = String(hex || DEFAULT_COLOR).replace(/^#/, '');
    const r = Number.parseInt(value.slice(0, 2), 16) / 255;
    const g = Number.parseInt(value.slice(2, 4), 16) / 255;
    const b = Number.parseInt(value.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const lightness = (max + min) / 2;
    let hue = 0;
    let saturation = 0;
    if (delta !== 0) {
        saturation = delta / (1 - Math.abs(2 * lightness - 1));
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
    }
    const l = Math.max(lightness, minimumLightness);
    const chroma = (1 - Math.abs(2 * l - 1)) * saturation;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = l - chroma / 2;
    let rr = 0, gg = 0, bb = 0;
    if (hue < 60) [rr, gg, bb] = [chroma, x, 0];
    else if (hue < 120) [rr, gg, bb] = [x, chroma, 0];
    else if (hue < 180) [rr, gg, bb] = [0, chroma, x];
    else if (hue < 240) [rr, gg, bb] = [0, x, chroma];
    else if (hue < 300) [rr, gg, bb] = [x, 0, chroma];
    else [rr, gg, bb] = [chroma, 0, x];
    return rgbToHex({ r: (rr + m) * 255, g: (gg + m) * 255, b: (bb + m) * 255 });
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

module.exports = { getGuildBannerHex, clearGuildBannerColorCache, rgbToHex, lightenHex, DEFAULT_COLOR };
