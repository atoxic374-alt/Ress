const { buildTopSummaryImage } = require('./topSummaryRenderer.js');
const { ensureCairoFontsRegistered } = require('./cairoFont');

ensureCairoFontsRegistered();

const imageCache = new Map();
const CACHE_TTL_MS = 15 * 1000;

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

function cleanValue(value, fallback = 'Not specified') {
    const text = String(value ?? '').trim();
    return text || fallback;
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
    const normalizedRoles = Array.isArray(removedRoles) && removedRoles.length
        ? removedRoles.join(', ')
        : 'None';
    const cacheKey = JSON.stringify({ guildName, memberName, accentColor, status, timeRemaining, startDate, endDate, approvedBy, reason, normalizedRoles });
    const cached = imageCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        return new (require('discord.js').AttachmentBuilder)(Buffer.from(cached.buffer), { name: 'vacation-summary.png' });
    }

    const attachment = buildTopSummaryImage({
        accentColor,
        title: 'My Vacation',
        subtitle: `Vacation for ${cleanValue(memberName, 'Member')} • ${cleanValue(guildName, 'Server')}`,
        sections: [
            {
                title: 'Vacation',
                rows: [
                    { label: 'Status', value: cleanValue(status) },
                    { label: 'Time Remaining', value: cleanValue(timeRemaining) },
                    { label: 'Start Date', value: formatRiyadh(startDate) },
                    { label: 'End Date', value: formatRiyadh(endDate) }
                ]
            },
            {
                title: 'Details',
                rows: [
                    { label: 'Approved by', value: cleanValue(approvedBy, 'Unknown') },
                    { label: 'Reason', value: cleanValue(reason) },
                    { label: 'Removed Roles', value: normalizedRoles }
                ]
            }
        ],
        yourRank: `Status :  ${cleanValue(status)}   •   Ends :  ${formatRiyadh(endDate)}`
    });

    const buffer = attachment.attachment;
    imageCache.set(cacheKey, { buffer, createdAt: Date.now() });
    if (imageCache.size > 100) imageCache.delete(imageCache.keys().next().value);
    return new (require('discord.js').AttachmentBuilder)(Buffer.from(buffer), { name: 'vacation-summary.png' });
}

module.exports = { buildVacationSummaryImage, formatRiyadh };
