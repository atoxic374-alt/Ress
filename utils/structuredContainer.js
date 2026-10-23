const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags
} = require('discord.js');
const colorManager = require('./colorManager');

function colorToNumber(color, fallback = 0x5865f2) {
    const safeFallback = Number.isInteger(fallback) && fallback >= 0 && fallback <= 0xffffff ? fallback : 0x5865f2;
    if (Number.isInteger(color) && color >= 0 && color <= 0xffffff) return color;
    if (color && typeof color === 'object') {
        if (Number.isInteger(color.value) && color.value >= 0 && color.value <= 0xffffff) return color.value;
        if (Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b)) {
            const red = Math.max(0, Math.min(255, Number(color.r)));
            const green = Math.max(0, Math.min(255, Number(color.g)));
            const blue = Math.max(0, Math.min(255, Number(color.b)));
            return ((red << 16) | (green << 8) | blue) >>> 0;
        }
    }
    const raw = String(color || '').trim();
    const rgbMatch = raw.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
    if (rgbMatch) {
        const red = Math.max(0, Math.min(255, Number(rgbMatch[1])));
        const green = Math.max(0, Math.min(255, Number(rgbMatch[2])));
        const blue = Math.max(0, Math.min(255, Number(rgbMatch[3])));
        return ((red << 16) | (green << 8) | blue) >>> 0;
    }
    const value = raw.replace(/^#/, '').replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,6}$/i.test(value)) return safeFallback;
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0xffffff ? parsed : safeFallback;
}

function createStructuredContainer({ title, description = '', footer = '', accentColor, thumbnailUrl = '' }) {
    const container = new ContainerBuilder()
        .setAccentColor(colorToNumber(accentColor ?? colorManager.getColor?.()));

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
