const { createCanvas } = require('canvas');
const { AttachmentBuilder } = require('discord.js');

function roundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
}

function normalizeColor(value) {
    const raw = String(value || '#5865F2').trim();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toUpperCase() : '#5865F2';
}

function drawText(ctx, value, x, y, options = {}) {
    ctx.font = options.font || '22px Cairo';
    ctx.fillStyle = options.color || '#FFFFFF';
    ctx.textAlign = options.align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value ?? ''), x, y);
}

function buildTopSummaryImage({
    accentColor,
    title = 'Rank',
    subtitle = 'Monthly • Voice and Chat Leaderboard',
    sections = [],
    yourRank = 'Your Rank :  Unranked'
}) {
    const accent = normalizeColor(accentColor);
    const rowHeight = 48;
    const sectionHeight = 42;
    const contentHeight = Math.max(250, sections.reduce((sum, section) => sum + sectionHeight + (section.rows?.length || 0) * rowHeight, 0));
    const width = 1200;
    const panelHeight = contentHeight + 45;
    const height = 165 + panelHeight + 190;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#111318');
    background.addColorStop(1, '#20242D');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createRadialGradient(width * 0.14, height * 0.16, 0, width * 0.14, height * 0.16, width * 0.72);
    glow.addColorStop(0, `${accent}20`);
    glow.addColorStop(1, `${accent}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = accent;
    roundedRect(ctx, 55, 45, 9, 165, 5);
    ctx.fill();

    ctx.fillStyle = '#1C1F27';
    roundedRect(ctx, 80, 40, width - 160, height - 100, 20);
    ctx.fill();
    ctx.strokeStyle = '#343945';
    ctx.lineWidth = 2;
    ctx.stroke();

    drawText(ctx, title, 110, 90, { font: 'bold 34px Cairo' });
    drawText(ctx, subtitle, 110, 130, { font: '22px Cairo', color: '#AEB4C2' });

    const panelY = 165;
    ctx.fillStyle = '#292D36';
    roundedRect(ctx, 110, panelY, width - 220, panelHeight, 14);
    ctx.fill();

    let y = panelY + 45;
    for (const section of sections) {
        drawText(ctx, section.title, 140, y, { font: 'bold 24px Cairo', color: accent });
        y += sectionHeight;
        for (const row of section.rows || []) {
            drawText(ctx, row.label, 150, y, { font: '21px Cairo', color: '#D3D7E0' });
            drawText(ctx, row.value, 1045, y, { font: 'bold 21px Cairo', align: 'right' });
            y += rowHeight;
        }
    }

    ctx.fillStyle = '#252933';
    roundedRect(ctx, 110, height - 145, width - 220, 48, 12);
    ctx.fill();
    drawText(ctx, yourRank, width / 2, height - 121, { font: 'bold 18px Cairo', color: '#DCE2ED', align: 'center' });

    return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'top-summary.png' });
}

module.exports = { buildTopSummaryImage };
