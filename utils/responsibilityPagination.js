const { StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const ITEMS_PER_PAGE = 24;

/**
 * Creates a paginated select menu for responsibilities
 */
function createPaginatedResponsibilityMenu(responsibilities, currentPage = 0, customId = 'select_responsibility', placeholder = 'اختر مسؤولية...') {
    const respEntries = Object.entries(responsibilities);
    if (respEntries.length === 0) return { components: [], totalPages: 0, currentPage: 0 };

    const totalPages = Math.ceil(respEntries.length / ITEMS_PER_PAGE);
    const validPage = Math.max(0, Math.min(currentPage, totalPages - 1));
    const pageItems = respEntries.slice(validPage * ITEMS_PER_PAGE, (validPage + 1) * ITEMS_PER_PAGE);

    const options = pageItems.map(([name, data]) => ({
        label: name.substring(0, 100),
        value: name,
        description: data.description ? data.description.substring(0, 100) : 'لا يوجد شرح'
    }));

    const components = [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
    )];

    if (totalPages > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${customId}_prev_page`).setLabel('◀️').setStyle(ButtonStyle.Primary).setDisabled(validPage === 0),
            new ButtonBuilder().setCustomId(`${customId}_info`).setLabel(`${validPage + 1}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId(`${customId}_next_page`).setLabel('▶️').setStyle(ButtonStyle.Primary).setDisabled(validPage === totalPages - 1)
        ));
    }

    return { components, totalPages, currentPage: validPage, hasMultiplePages: totalPages > 1 };
}

/**
 * Creates a paginated select menu from an array of options
 */
function createPaginatedResponsibilityArray(responsibilities, currentPage = 0, customId = 'select_responsibility', placeholder = 'اختر مسؤولية...', maxValues = 1) {
    const totalPages = Math.ceil(responsibilities.length / ITEMS_PER_PAGE);
    
    if (totalPages === 0) {
        return {
            components: [],
            totalPages: 0,
            currentPage: 0
        };
    }

    const validPage = Math.max(0, Math.min(currentPage, totalPages - 1));
    const start = validPage * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, responsibilities.length);
    const pageItems = responsibilities.slice(start, end);

    const options = pageItems.map(resp => ({
        label: resp.label || resp.name_role || (resp.name ? resp.name.substring(0, 100) : (typeof resp === 'string' ? resp.substring(0, 100) : 'Option')),
        value: resp.value || resp.name || resp,
        description: resp.description ? resp.description.substring(0, 100) : undefined,
        emoji: resp.emoji || undefined
    }));

    const selectMenuBuilder = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(options);
    
    if (maxValues > 1) {
        selectMenuBuilder.setMaxValues(Math.min(maxValues, options.length));
    }

    const components = [new ActionRowBuilder().addComponents(selectMenuBuilder)];

    if (totalPages > 1) {
        const navigationButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${customId}_prev_page`)
                .setLabel('◀️ السابق')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(validPage === 0),
            new ButtonBuilder()
                .setCustomId(`${customId}_page_info`)
                .setLabel(`صفحة ${validPage + 1} من ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`${customId}_next_page`)
                .setLabel('التالي ▶️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(validPage === totalPages - 1)
        );
        components.push(navigationButtons);
    }

    return {
        components,
        totalPages,
        currentPage: validPage,
        hasMultiplePages: totalPages > 1
    };
}

/**
 * Handles common pagination button interactions
 */
function handlePaginationInteraction(interaction, customId) {
    if (!interaction.customId.startsWith(customId)) {
        return null;
    }

    if (interaction.customId === `${customId}_prev_page`) {
        return { action: 'prev' };
    }
    
    if (interaction.customId === `${customId}_next_page`) {
        return { action: 'next' };
    }

    return null;
}

/**
 * Specialized pagination for responsibility statistics
 */
function createPaginatedResponsibilityStats(responsibilityStats, currentPage = 0, customId = 'stats_select_responsibility', placeholder = 'اختر مسؤولية لعرض إحصائياتها') {
    const totalPages = Math.ceil(responsibilityStats.length / ITEMS_PER_PAGE);
    
    if (totalPages === 0) {
        return {
            components: [],
            totalPages: 0,
            currentPage: 0
        };
    }

    const validPage = Math.max(0, Math.min(currentPage, totalPages - 1));
    const start = validPage * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, responsibilityStats.length);
    const pageItems = responsibilityStats.slice(start, end);

    const options = pageItems.map((resp, index) => {
        const globalIndex = start + index;
        return {
            label: resp.name,
            description: `${resp.totalPoints || 0} نقطة - ${resp.membersCount || 0} مسؤول`,
            value: resp.name,
            emoji: globalIndex === 0 ? '🏆' : globalIndex === 1 ? '🥈' : globalIndex === 2 ? '🥉' : '📊'
        };
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(options);

    const components = [new ActionRowBuilder().addComponents(selectMenu)];

    if (totalPages > 1) {
        const navigationButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${customId}_prev_page`)
                .setLabel('◀️ السابق')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(validPage === 0),
            new ButtonBuilder()
                .setCustomId(`${customId}_page_info`)
                .setLabel(`صفحة ${validPage + 1} من ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`${customId}_next_page`)
                .setLabel('التالي ▶️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(validPage === totalPages - 1)
        );
        components.push(navigationButtons);
    }

    return {
        components,
        totalPages,
        currentPage: validPage,
        hasMultiplePages: totalPages > 1
    };
}

module.exports = {
    createPaginatedResponsibilityMenu,
    createPaginatedResponsibilityArray,
    createPaginatedResponsibilityStats,
    handlePaginationInteraction,
    ITEMS_PER_PAGE
};
