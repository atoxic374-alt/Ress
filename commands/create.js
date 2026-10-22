const groupsCommand = require('./groups');

module.exports = {
  name: 'create',
  aliases: [],
  execute(message, args, context) {
    return groupsCommand.execute(message, ['create', ...args], context);
  }
};
