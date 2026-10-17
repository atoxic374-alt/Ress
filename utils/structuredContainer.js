const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    MessageFlags
} = require('discord.js');

function colorToNumber(color, fallback = 0x5865f2) {
    const value = String(color || '').replace(/^#/, '').replace(/^0x/i, '');
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function createStructuredContainer({ title, description = '', footer = '', accentColor }) {
    const container = new ContainerBuilder()
        .setAccentColor(colorToNumber(accentColor));

    if (title) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ${String(title).slice(0, 200)}`)
        );
    }
    if (description) {
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(String(description).slice(0, 3900))
        );
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
