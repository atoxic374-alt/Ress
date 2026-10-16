const { createCanvas } = require('canvas');
const { AttachmentBuilder } = require('discord.js');
const { ensureCairoFontsRegistered } = require('./cairoFont');

ensureCairoFontsRegistered();

const imageCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

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

function drawText(ctx, text, x, y, { font, color = '#ffffff', align = 'right' } = {}) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(String(text), x, y);
}

function drawSection(ctx, { title, rows, y, accent, width }) {
    const rowHeight = 58;
    const sectionHeight = 78 + Math.max(rows.length, 1) * rowHeight + 24;
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    roundedRect(ctx, 55, y, width - 110, sectionHeight, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    ctx.stroke();

    drawText(ctx, title, width - 90, y + 52, {
        font: 'bold 34px Cairo',
        color: '#ffffff'
    });
    ctx.fillStyle = accent;
    roundedRect(ctx, width - 355, y + 68, 265, 5, 3);
    ctx.fill();

    if (!rows.length) {
        drawText(ctx, title === 'المسؤوليات' ? 'لا توجد مسؤوليات حالياً' : 'لا يوجد إشراف حالياً', width - 90, y + 120, {
            font: '24px Cairo',
            color: 'rgba(255,255,255,0.65)'
        });
        return y + sectionHeight;
    }

    rows.forEach((row, index) => {
        const rowY = y + 116 + (index * rowHeight);
        if (index % 2 === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.035)';
            roundedRect(ctx, 78, rowY - 38, width - 156, 45, 12);
            ctx.fill();
        }
        drawText(ctx, row.name, width - 110, rowY - 7, {
            font: 'bold 23px Cairo'
        });
        if (row.otherResponsiblesCount !== undefined) {
            drawText(ctx, `مسؤولون آخرون : ${row.otherResponsiblesCount}`, 110, rowY - 7, {
                font: '20px Cairo',
                color: 'rgba(255,255,255,0.68)',
                align: 'left'
            });
        }
    });

    return y + sectionHeight;
}

function buildResponsibilitiesSummaryImage({
    guildName,
    memberName,
    accentColor,
    responsibilities = [],
    supervisors = []
}) {
    const cacheKey = JSON.stringify({ guildName, memberName, accentColor, responsibilities, supervisors });
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        return new AttachmentBuilder(Buffer.from(cached.buffer), { name: 'responsibilities-full.png' });
    }

    const width = 1200;
    const accent = normalizeColor(accentColor);
    const headerHeight = 280;
    const sectionRowHeight = 58;
    const sectionHeight = rows => 78 + Math.max(rows.length, 1) * sectionRowHeight + 24;
    const height = headerHeight + sectionHeight(responsibilities) + sectionHeight(supervisors) + 70;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#111318');
    background.addColorStop(1, '#20242d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = accent;
    roundedRect(ctx, 55, 52, 10, 204, 5);
    ctx.fill();

    drawText(ctx, 'My Responsibilities', width / 2, 82, {
        font: 'bold 48px Cairo',
        align: 'center'
    });
    drawText(ctx, String(memberName || 'Member').slice(0, 42), width / 2, 128, {
        font: 'bold 27px Cairo',
        color: 'rgba(255,255,255,0.68)'
        , align: 'center'
    });

    const cards = [
        { x: 95, title: 'المسؤوليات', count: responsibilities.length },
        { x: 625, title: 'الإشراف', count: supervisors.length }
    ];
    for (const card of cards) {
        ctx.fillStyle = 'rgba(255,255,255,0.055)';
        roundedRect(ctx, card.x, 178, 480, 78, 18);
        ctx.fill();
        drawText(ctx, card.title, card.x + 440, 228, { font: 'bold 26px Cairo' });
        drawText(ctx, String(card.count), card.x + 54, 230, {
            font: 'bold 38px Cairo',
            color: accent,
            align: 'left'
        });
    }

    let y = headerHeight;
    y = drawSection(ctx, { title: 'المسؤوليات', rows: responsibilities, y, accent, width });
    y += 24;
    y = drawSection(ctx, { title: 'الإشراف', rows: supervisors, y, accent, width });

    drawText(ctx, `${String(guildName || 'Server').slice(0, 54)} • Responsibilities Summary`, 70, height - 25, {
        font: '20px Cairo',
        color: 'rgba(255,255,255,0.52)',
        align: 'left'
    });

    const buffer = canvas.toBuffer('image/png');
    imageCache.set(cacheKey, { buffer, createdAt: Date.now() });
    if (imageCache.size > 100) {
        const oldestKey = imageCache.keys().next().value;
        imageCache.delete(oldestKey);
    }
    return new AttachmentBuilder(Buffer.from(buffer), { name: 'responsibilities-full.png' });
}

module.exports = { buildResponsibilitiesSummaryImage, normalizeColor };
