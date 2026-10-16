const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags
} = require('discord.js');

function cleanText(value, fallback = '—') {
    const text = String(value || '').trim();
    return text || fallback;
}

function createProblemLogContainer({
    title,
    description,
    fields = [],
    thumbnailUrl = null,
    accentColor = '#5865F2',
    footer = 'Problem System'
}) {
    const color = Number.parseInt(String(accentColor).replace(/^#/, ''), 16);
    const heading = new TextDisplayBuilder().setContent(`## ${cleanText(title, 'Problem Log')}`);
    const section = new SectionBuilder().addTextDisplayComponents(heading);
    if (thumbnailUrl) {
        section.setThumbnailAccessory(new ThumbnailBuilder()
            .setURL(thumbnailUrl)
            .setDescription('Problem log'));
    }

    const fieldLines = fields
        .filter(field => field?.name && field?.value !== undefined)
        .map(field => `**${cleanText(field.name)} :** ${cleanText(field.value)}`);
    const body = [cleanText(description, ''), ...fieldLines].filter(Boolean).join('\n\n').slice(0, 3500);

    const container = new ContainerBuilder().setAccentColor(Number.isFinite(color) ? color : 0x5865f2);
    if (thumbnailUrl) container.addSectionComponents(section);
    else container.addTextDisplayComponents(heading);
    container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body || 'No additional details.'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));

    return container;
}

function problemLogPayload(container) {
    return {
        embeds: [],
        components: [container],
        flags: MessageFlags.IsComponentsV2
    };
}

function problemLogFromEmbed(embed) {
    const data = embed?.data || embed || {};
    return createProblemLogContainer({
        title: data.title,
        description: data.description,
        fields: data.fields,
        thumbnailUrl: data.thumbnail?.url,
        accentColor: data.color ? `#${Number(data.color).toString(16).padStart(6, '0')}` : '#5865F2'
    });
}

module.exports = { createProblemLogContainer, problemLogPayload, problemLogFromEmbed };
