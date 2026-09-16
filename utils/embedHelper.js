
const colorManager = require('./colorManager.js');
const { EmbedBuilder } = require('discord.js');
const { allowedMentions } = require('./mentions.js');

// معالج الأخطاء المتقدم
class ErrorHandler {
    static handleDiscordError(error, context = '') {
        const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001, 50027, 10015, 50035, 10014, 10020, 40061];
        
        if (error.code && ignoredCodes.includes(error.code)) {
            console.log(`تم تجاهل خطأ Discord معروف في ${context}: ${error.code} - ${error.message}`);
            return true; // تم التعامل مع الخطأ
        }

        console.error(`خطأ غير معروف في ${context}:`, error);
        return false; // خطأ غير معروف
    }

    static async safeExecute(operation, fallback = null, context = 'Unknown') {
        try {
            return await operation();
        } catch (error) {
            if (!this.handleDiscordError(error, context)) {
                console.error(`فشلت العملية في ${context}:`, error);
            }
            return fallback;
        }
    }
}

// معالج التفاعلات الذكي
class InteractionHandler {
    static isValidInteraction(interaction) {
        if (!interaction || !interaction.isRepliable()) {
            return false;
        }

        // التحقق من عمر التفاعل
        const now = Date.now();
        const interactionAge = now - interaction.createdTimestamp;
        if (interactionAge > 13 * 60 * 1000) {
            console.log(`تفاعل منتهي الصلاحية: ${Math.floor(interactionAge / 60000)} دقيقة`);
            return false;
        }

        // التحقق من حالة الرد
        if (interaction.replied || interaction.deferred) {
            console.log('تفاعل تم الرد عليه مسبقاً');
            return false;
        }

        return true;
    }

    static async safeReply(interaction, content, options = {}) {
        if (!this.isValidInteraction(interaction)) {
            return false;
        }

        return await ErrorHandler.safeExecute(async () => {
            const replyOptions = {
                content: content || '**حدث خطأ غير متوقع**',
                ephemeral: true,
                allowedMentions,
                ...options
            };

            await interaction.reply(replyOptions);
            return true;
        }, false, 'safeReply');
    }

    static async safeUpdate(interaction, options = {}) {
        if (!this.isValidInteraction(interaction)) {
            return false;
        }

        return await ErrorHandler.safeExecute(async () => {
            await interaction.update(options);
            return true;
        }, false, 'safeUpdate');
    }

    static async safeFollowUp(interaction, content, options = {}) {
        if (!interaction) {
            return false;
        }

        return await ErrorHandler.safeExecute(async () => {
            const followUpOptions = {
                content: content || '**حدث خطأ غير متوقع**',
                ephemeral: true,
                allowedMentions,
                ...options
            };

            await interaction.followUp(followUpOptions);
            return true;
        }, false, 'safeFollowUp');
    }
}

// معالج الرسائل المحسن
class MessageHandler {
    static async safeSend(channel, content, options = {}) {
        if (!channel || !channel.send) {
            return null;
        }

        return await ErrorHandler.safeExecute(async () => {
            const messageOptions = typeof content === 'string' 
                ? { content, allowedMentions, ...options }
                : { allowedMentions, ...content, ...options };

            return await channel.send(messageOptions);
        }, null, 'safeSend');
    }

    static async safeEdit(message, content, options = {}) {
        if (!message || !message.edit) {
            return null;
        }

        return await ErrorHandler.safeExecute(async () => {
            const editOptions = typeof content === 'string'
                ? { content, allowedMentions, ...options }
                : { allowedMentions, ...content, ...options };

            return await message.edit(editOptions);
        }, null, 'safeEdit');
    }

    static async safeDelete(message, timeout = 0) {
        if (!message || !message.delete) {
            return false;
        }

        return await ErrorHandler.safeExecute(async () => {
            if (timeout > 0) {
                setTimeout(() => message.delete().catch(() => {}), timeout);
            } else {
                await message.delete();
            }
            return true;
        }, false, 'safeDelete');
    }
}

// منشئ الـ Embeds المتقدم
class AdvancedEmbedBuilder {
    static createEmbed(type = 'standard', title, description) {
        const embed = colorManager.createEmbed().setTimestamp();

        switch (type) {
            case 'success':
                return embed
                    .setDescription(`✅ ${description}`)
                    .setColor('#00FF00')
                    .setTitle(title || 'نجح');

            case 'error':
                return embed
                    .setDescription(`❌ ${description}`)
                    .setColor('#FF0000')
                    .setTitle(title || 'خطأ');

            case 'warning':
                return embed
                    .setDescription(`⚠️ ${description}`)
                    .setColor('#FFA500')
                    .setTitle(title || 'تحذير');

            case 'info':
                return embed
                    .setDescription(`ℹ️ ${description}`)
                    .setColor('#00BFFF')
                    .setTitle(title || 'معلومات');

            case 'loading':
                return embed
                    .setDescription(`🔄 ${description}`)
                    .setColor('#FFD700')
                    .setTitle(title || 'جاري التحميل...');

            default:
                return embed
                    .setTitle(title)
                    .setDescription(description);
        }
    }

    static createProgressEmbed(title, current, total, description = '') {
        const percentage = Math.round((current / total) * 100);
        const progressBar = this.createProgressBar(percentage);
        
        return this.createEmbed('info', title, `${description}\n\n${progressBar}\n**التقدم:** ${current}/${total} (${percentage}%)`)
            .addFields([
                { name: 'المتبقي', value: `${total - current}`, inline: true },
                { name: 'مكتمل', value: `${percentage}%`, inline: true }
            ]);
    }

    static createProgressBar(percentage, length = 10) {
        const filled = Math.round((percentage / 100) * length);
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    static createListEmbed(title, items, itemsPerPage = 10, currentPage = 1) {
        const totalPages = Math.ceil(items.length / itemsPerPage);
        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const currentItems = items.slice(startIndex, endIndex);

        const description = currentItems.length > 0 
            ? currentItems.map((item, index) => `**${startIndex + index + 1}.** ${item}`).join('\n')
            : '**لا توجد عناصر للعرض**';

        return this.createEmbed('standard', title, description)
            .setFooter({ text: `صفحة ${currentPage} من ${totalPages} • المجموع: ${items.length}` });
    }

    static createConfirmationEmbed(title, description, confirmText = 'تأكيد', cancelText = 'إلغاء') {
        return this.createEmbed('warning', title, description)
            .addFields([
                { name: '⚠️ تحذير', value: 'هذا الإجراء لا يمكن التراجع عنه!', inline: false },
                { name: 'الخيارات', value: `✅ ${confirmText}\n❌ ${cancelText}`, inline: false }
            ]);
    }
}

// معالج الكولكتورز المتقدم
class CollectorManager {
    static createButtonCollector(message, filter, options = {}) {
        const defaultOptions = {
            time: 300000, // 5 دقائق
            max: 1,
            dispose: true,
            ...options
        };

        const collector = message.createMessageComponentCollector({
            filter,
            ...defaultOptions
        });

        // إضافة معالجات الأخطاء التلقائية
        collector.on('error', (error) => {
            ErrorHandler.handleDiscordError(error, 'ButtonCollector');
        });

        return collector;
    }

    static createMessageCollector(channel, filter, options = {}) {
        const defaultOptions = {
            time: 300000, // 5 دقائق
            max: 1,
            ...options
        };

        const collector = channel.createMessageCollector({
            filter,
            ...defaultOptions
        });

        // إضافة معالجات الأخطاء التلقائية
        collector.on('error', (error) => {
            ErrorHandler.handleDiscordError(error, 'MessageCollector');
        });

        return collector;
    }

    static async waitForResponse(channel, userId, timeout = 60000) {
        return new Promise((resolve, reject) => {
            const filter = m => m.author.id === userId;
            const collector = this.createMessageCollector(channel, filter, { 
                time: timeout, 
                max: 1 
            });

            collector.on('collect', (message) => {
                resolve(message);
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time') {
                    reject(new Error('انتهت مهلة الانتظار'));
                } else if (collected.size === 0) {
                    reject(new Error('لم يتم تلقي أي رد'));
                }
            });
        });
    }
}

// دوال الوراثة للتوافق مع الكود القديم
function createStandardEmbed(title, description) {
    return AdvancedEmbedBuilder.createEmbed('standard', title, description);
}

function createErrorEmbed(message) {
    return AdvancedEmbedBuilder.createEmbed('error', null, message);
}

function createSuccessEmbed(message) {
    return AdvancedEmbedBuilder.createEmbed('success', null, message);
}

function createWarningEmbed(message) {
    return AdvancedEmbedBuilder.createEmbed('warning', null, message);
}

function updateEmbedColor(embed) {
    return colorManager.updateEmbedColor(embed);
}

module.exports = {
    // الكلاسات الجديدة
    ErrorHandler,
    InteractionHandler,
    MessageHandler,
    AdvancedEmbedBuilder,
    CollectorManager,
    
    // الدوال القديمة للتوافق
    createStandardEmbed,
    createErrorEmbed,
    createSuccessEmbed,
    createWarningEmbed,
    updateEmbedColor,
    
    // دوال إضافية
    createInfoEmbed: (message) => AdvancedEmbedBuilder.createEmbed('info', null, message),
    createLoadingEmbed: (message) => AdvancedEmbedBuilder.createEmbed('loading', null, message),
    createProgressEmbed: AdvancedEmbedBuilder.createProgressEmbed,
    createListEmbed: AdvancedEmbedBuilder.createListEmbed,
    createConfirmationEmbed: AdvancedEmbedBuilder.createConfirmationEmbed
};
