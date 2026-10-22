const groupsCommand = require('./groups');

module.exports = {
  name: 'delete',
  aliases: [],
  execute(message, args, context) {
    return groupsCommand.execute(message, ['delete', ...args], context);
  }
};
