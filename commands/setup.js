const groups = require('./groups');
module.exports = {
  name: 'setup',
  aliases: ['إعدادات', 'group-setup'],
  async execute(message, args, context) {
    if (!args.length || ['groups', 'group', 'قروبات', 'قروب'].includes(String(args[0]).toLowerCase())) {
      return groups.execute(message, ['setup'], context);
    }
    return message.reply('Available: `:setup groups`');
  },
  registerInteractionHandler: groups.registerInteractionHandler
};
