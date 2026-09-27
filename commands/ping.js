const colorManager = require('../utils/colorManager');

function latencyLabel(value) {
    if (value < 100) return 'ممتاز';
    if (value < 200) return 'جيد جدًا';
    if (value < 350) return 'جيد';
    if (value < 600) return 'متوسط';
    return 'مرتفع';
}

function latencyIcon(value) {
    if (value < 200) return '🟢';
    if (value < 500) return '🟡';
    return '🔴';
}

function formatUptime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days}ي`);
    if (hours) parts.push(`${hours}س`);
    if (minutes) parts.push(`${minutes}د`);
    if (!parts.length || seconds) parts.push(`${seconds}ث`);
    return parts.join(' و ');
}

function formatPing(value) {
    return Number.isFinite(value) && value >= 0 ? `${Math.round(value)}ms` : 'جارٍ القياس';
}

module.exports = {
    name: 'ping',
    aliases: ['بنق', 'latency'],
    async execute(message, args, { client }) {
        if (!message.guild) return;

        const startedAt = Date.now();
        const guild = message.guild;
        const guildIcon = guild.iconURL({ dynamic: true, size: 256 }) || undefined;
        const initialEmbed = colorManager.createEmbed()
            .setAuthor({ name: guild.name, iconURL: guildIcon })
            .setTitle('🏓 فحص اتصال البوت')
            .setDescription('جاري قياس زمن الاستجابة...')
            .setThumbnail(guildIcon)
            .setFooter({ text: `طلب بواسطة ${message.author.tag}` })
            .setTimestamp();

        const reply = await message.reply({ embeds: [initialEmbed], allowedMentions: { repliedUser: false } });
        const responseLatency = Date.now() - startedAt;
        const websocketPing = Number(client.ws?.ping);
        const websocketValue = Number.isFinite(websocketPing) && websocketPing >= 0 ? websocketPing : responseLatency;
        const uptime = formatUptime(client.uptime || 0);

        const embed = colorManager.createEmbed()
            .setAuthor({ name: guild.name, iconURL: guildIcon })
            .setTitle('🏓 حالة اتصال البوت')
            .setDescription('**الاتصال يعمل بشكل طبيعي**')
            .setThumbnail(guildIcon)
            .addFields(
                {
                    name: '⚡ بنق البوت',
                    value: `${latencyIcon(responseLatency)} **${formatPing(responseLatency)}**\n${latencyLabel(responseLatency)}`,
                    inline: true
                },
                {
                    name: '🌐 بنق Discord API',
                    value: `${latencyIcon(websocketValue)} **${formatPing(websocketValue)}**\n${latencyLabel(websocketValue)}`,
                    inline: true
                },
                {
                    name: '⏱️ وقت التشغيل',
                    value: `**${uptime}**`,
                    inline: true
                },
                {
                    name: '📡 حالة الاتصال',
                    value: '🟢 متصل ومستقر',
                    inline: true
                },
                {
                    name: '🏠 السيرفر',
                    value: `**${guild.name}**\n\`${guild.id}\``,
                    inline: true
                },
                {
                    name: '🤖 البوت',
                    value: client.user ? `**${client.user.tag}**\n\`${client.user.id}\`` : 'غير متوفر',
                    inline: true
                }
            )
            .setFooter({ text: `تم القياس في ${new Date().toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh' })}` })
            .setTimestamp();

        await reply.edit({ embeds: [embed] });
    }
};
