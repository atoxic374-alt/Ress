const { createCanvas } = require('canvas');
const { AttachmentBuilder } = require('discord.js');
const { ensureCairoFontsRegistered } = require('./cairoFont');

ensureCairoFontsRegistered();

const imageCache = new Map();
const CACHE_TTL_MS = 5 * 1000;

function normalizeColor(color, fallback = '#5865F2') {
    const value = String(color || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^[0-9a-f]{6}$/i.test(value)) return `#${value}`;
    return fallback;
}

function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function drawText(ctx, text, x, y, { font = '24px Cairo', color = '#ffffff', align = 'right' } = {}) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(String(text ?? ''), x, y);
}

function formatRiyadh(dateValue) {
    if (!dateValue) return 'Not specified';
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    }).format(new Date(dateValue));
}

function fitText(ctx, text, maxWidth, font, fallback = 'Not specified') {
    const value = String(text || fallback);
    ctx.font = font;
    if (ctx.measureText(value).width <= maxWidth) return value;
    let output = value;
    while (output.length > 3 && ctx.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
    return `${output}…`;
}

function buildVacationSummaryImage({
    guildName,
    memberName,
    accentColor,
    status = 'In Vacation',
    timeRemaining = 'Ended',
    startDate,
    endDate,
    approvedBy,
    reason,
    removedRoles = []
}) {
    const cacheKey = JSON.stringify({ guildName, memberName, accentColor, status, timeRemaining, startDate, endDate, approvedBy, reason, removedRoles });
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        return new AttachmentBuilder(Buffer.from(cached.buffer), { name: 'vacation-summary.png' });
    }

    const width = 1200;
    const rows = [
        ['Status', status],
        ['Time Remaining', timeRemaining],
        ['Approved by', approvedBy || 'Unknown'],
        ['Start Date', formatRiyadh(startDate)],
        ['End Date', formatRiyadh(endDate)],
        ['Reason', reason || 'Not specified'],
        ['Removed Roles', removedRoles.length ? removedRoles.join(' • ') : 'None']
    ];
    const rowHeight = 66;
    const height = 300 + rows.length * rowHeight + 100;
    const accent = normalizeColor(accentColor);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#111318');
    background.addColorStop(1, '#20242d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createRadialGradient(120, 105, 10, 120, 105, 520);
    glow.addColorStop(0, `${accent}55`);
    glow.addColorStop(1, `${accent}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 720, 430);

    ctx.shadowColor = 'rgba(255,255,255,0.35)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#FFFFFF';
    roundedRect(ctx, 55, 50, 10, 202, 5);
    ctx.fill();
    ctx.shadowBlur = 0;

    drawText(ctx, 'My Vacation', width / 2, 94, { font: 'bold 52px Cairo', align: 'center' });
    drawText(ctx, fitText(ctx, memberName || 'Member', 720, 'bold 29px Cairo'), width / 2, 145, {
        font: 'bold 29px Cairo', color: 'rgba(255,255,255,0.68)', align: 'center'
    });

    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    roundedRect(ctx, 95, 190, width - 190, 78, 18);
    ctx.fill();
    drawText(ctx, 'VACATION STATUS', width - 130, 241, { font: 'bold 27px Cairo' });
    drawText(ctx, status, 135, 241, { font: 'bold 29px Cairo', color: '#FFFFFF', align: 'left' });

    let y = 315;
    rows.forEach(([label, value], index) => {
        if (index % 2 === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.045)';
            roundedRect(ctx, 70, y - 40, width - 140, 54, 13);
            ctx.fill();
        }
        drawText(ctx, label, width - 110, y - 4, { font: 'bold 24px Cairo' });
        drawText(ctx, fitText(ctx, value, 680, '22px Cairo'), 110, y - 4, {
            font: '22px Cairo', color: 'rgba(255,255,255,0.84)', align: 'left'
        });
        y += rowHeight;
    });

    drawText(ctx, `${String(guildName || 'Server').slice(0, 54)} • Vacation Summary`, 70, height - 28, {
        font: '20px Cairo', color: 'rgba(255,255,255,0.52)', align: 'left'
    });

    const buffer = canvas.toBuffer('image/png');
    imageCache.set(cacheKey, { buffer, createdAt: Date.now() });
    if (imageCache.size > 100) imageCache.delete(imageCache.keys().next().value);
    return new AttachmentBuilder(Buffer.from(buffer), { name: 'vacation-summary.png' });
}

module.exports = { buildVacationSummaryImage, formatRiyadh };
