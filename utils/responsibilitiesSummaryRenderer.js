const { createCanvas } = require('canvas');
const { AttachmentBuilder } = require('discord.js');
const { ensureCairoFontsRegistered } = require('./cairoFont');

ensureCairoFontsRegistered();

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

function buildResponsibilitiesSummaryImage({ guildName, accentColor, responsibilityCount, supervisorCount }) {
    const width = 1200;
    const height = 320;
    const accent = normalizeColor(accentColor);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#111318');
    background.addColorStop(1, '#20242d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, height - 50);
    ctx.quadraticCurveTo(width * 0.28, height - 150, width * 0.58, height - 70);
    ctx.quadraticCurveTo(width * 0.8, height - 12, width, height - 92);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = accent;
    roundedRect(ctx, 64, 62, 10, 196, 5);
    ctx.fill();

    const cards = [
        { x: 115, title: 'المسؤوليات', count: responsibilityCount },
        { x: 590, title: 'الإشراف', count: supervisorCount }
    ];

    for (const card of cards) {
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        roundedRect(ctx, card.x, 52, 405, 215, 22);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.09)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.font = 'bold 42px Cairo';
        ctx.fillText(card.title, card.x + 350, 106);

        ctx.fillStyle = accent;
        roundedRect(ctx, card.x + 34, 84, 82, 6, 3);
        ctx.fill();
        roundedRect(ctx, card.x + 268, 84, 82, 6, 3);
        ctx.fill();

        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 86px Cairo';
        ctx.fillText(String(card.count), card.x + 202, 190);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = 'bold 20px Cairo';
        ctx.fillText(card.title === 'المسؤوليات' ? 'عدد المسؤوليات' : 'عدد الإشراف', card.x + 202, 232);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.52)';
    ctx.font = '20px Cairo';
    ctx.fillText(String(guildName || 'Server').slice(0, 48), 78, 295);

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'responsibilities-summary.png' });
}

module.exports = { buildResponsibilitiesSummaryImage, normalizeColor };
