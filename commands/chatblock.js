const fs = require('fs');
const path = require('path');

const name = 'chatb';

const blockedChannelsPath = path.join(__dirname, '..', 'data', 'blocked_channels.json');

function getBlockedChannels() {
    try {
        if (fs.existsSync(blockedChannelsPath)) {
            const data = fs.readFileSync(blockedChannelsPath, 'utf8');
            return JSON.parse(data);
        }
        return [];
    } catch (error) {
        console.error('خطأ في قراءة ملف الرومات المحظورة:', error);
        return [];
    }
}

function saveBlockedChannels(blockedChannels) {
    try {
        const dataDir = path.dirname(blockedChannelsPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(blockedChannelsPath, JSON.stringify(blockedChannels, null, 2));
        return true;
    } catch (error) {
        console.error('خطأ في حفظ ملف الرومات المحظورة:', error);
        return false;
    }
}

function isChannelBlocked(channelId) {
    const blockedChannels = getBlockedChannels();
    return blockedChannels.includes(channelId);
}

function toggleChannelBlock(channelId) {
    const blockedChannels = getBlockedChannels();
    const isBlocked = blockedChannels.includes(channelId);

    if (isBlocked) {
        const index = blockedChannels.indexOf(channelId);
        blockedChannels.splice(index, 1);
        const success = saveBlockedChannels(blockedChannels);
        return { action: 'unblocked', success };
    } else {
        blockedChannels.push(channelId);
        const success = saveBlockedChannels(blockedChannels);
        return { action: 'blocked', success };
    }
}

async function execute(message, args, { client, BOT_OWNERS }) {
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
        await message.react('❌');
        return;
    }

    let channelId = null;

    if (message.mentions.channels.size > 0) {
        channelId = message.mentions.channels.first().id;
    } else if (args.length > 0) {
        const idMatch = args[0].match(/\d{17,19}/);
        if (idMatch) {
            channelId = idMatch[0];
        }
    }

    if (!channelId) {
        await message.react('❌');
        return;
    }

    const result = toggleChannelBlock(channelId);

    if (result.success) {
        if (result.action === 'blocked') {
            await message.react('🔒');
        } else {
            await message.react('🔓');
        }
    } else {
        await message.react('❌');
    }
}

module.exports = {
    name,
    execute,
    isChannelBlocked,
    getBlockedChannels,
    toggleChannelBlock
};
