const groups = require('./groups');

const GROUP_SETUP_TOKENS = new Set(['groups', 'group', 'قروبات', 'قروب', 'إعدادات', 'اعدادات', 'تهيئة']);
const HELP_TOKENS = new Set(['help', 'مساعدة', '؟']);

module.exports = {
  name: 'setup',
  aliases: ['إعدادات', 'group-setup'],
  async execute(message, args = [], context = {}) {
    const action = String(args[0] || '').toLowerCase();
    if (!action || GROUP_SETUP_TOKENS.has(action)) {
      return groups.execute(message, ['setup'], context);
    }
    if (HELP_TOKENS.has(action)) {
      return message.reply([
        '**إعداد نظام القروبات**',
        '`:setup groups` — فتح لوحة الإعداد التفاعلية.',
        '`:groups control` — فتح لوحة إدارة القروبات.',
        '`:groups rules` — عرض قواعد النقاط أو تعديلها.',
        'من لوحة الإعداد يمكنك تدقيق الجاهزية، ضبط القنوات والرتب، إدارة مسؤولي النظام، ومسح الإعدادات الخاطئة.'
      ].join('\n'));
    }
    return message.reply('الخيار غير معروف. استخدم `:setup help` أو `:setup groups`.');
  },
  registerInteractionHandler: groups.registerInteractionHandler
};
