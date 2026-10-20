const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags
} = require('discord.js');

function colorToNumber(color, fallback = 0x5865f2) {
    if (Number.isInteger(color) && color >= 0 && color <= 0xffffff) return color;
    if (color && typeof color === 'object') {
        if (Number.isInteger(color.value) && color.value >= 0 && color.value <= 0xffffff) return color.value;
        if (Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b)) {
            const red = Math.max(0, Math.min(255, Number(color.r)));
            const green = Math.max(0, Math.min(255, Number(color.g)));
            const blue = Math.max(0, Math.min(255, Number(color.b)));
            return (red << 16) | (green << 8) | blue;
        }
    }
    const raw = String(color || '').trim();
    const rgbMatch = raw.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
    if (rgbMatch) {
        return (Number(rgbMatch[1]) << 16) | (Number(rgbMatch[2]) << 8) | Number(rgbMatch[3]);
    }
    const value = raw.replace(/^#/, '').replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,6}$/i.test(value)) return fallback;
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) && parsed <= 0xffffff ? parsed : fallback;
}

function createStructuredContainer({ title, description = '', footer = '', accentColor, thumbnailUrl = '' }) {
    const container = new ContainerBuilder()
        .setAccentColor(colorToNumber(accentColor));

    if (title || description) {
        const textComponents = [];
        if (title) textComponents.push(new TextDisplayBuilder().setContent(`## ${String(title).slice(0, 200)}`));
        if (description) textComponents.push(new TextDisplayBuilder().setContent(String(description).slice(0, 3900)));
        if (thumbnailUrl) {
            const section = new SectionBuilder().addTextDisplayComponents(textComponents)
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(String(thumbnailUrl)));
            container.addSectionComponents(section);
        } else {
            if (title) container.addTextDisplayComponents(textComponents[0]);
            if (description) {
                container.addSeparatorComponents(new SeparatorBuilder());
                container.addTextDisplayComponents(textComponents[title ? 1 : 0]);
            }
        }
    }
    if (footer) {
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${String(footer).slice(0, 300)}`)
        );
    }
    return container;
}

function componentsV2Payload(container) {
    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2
    };
}

module.exports = { createStructuredContainer, componentsV2Payload, colorToNumber };
