
// مثال على كيفية استخدام المعالجات المتقدمة في الأوامر

const { 
    globalInteractionHandler, 
    globalCommandHandler,
    InteractionHandler,
    MessageHandler
} = require('./advancedHandlers.js');

const { 
    AdvancedEmbedBuilder,
    CollectorManager,
    createSuccessEmbed,
    createErrorEmbed
} = require('./embedHelper.js');

// مثال 1: معالجة تفاعل الأزرار بطريقة متقدمة
async function handleButtonInteraction(interaction) {
    return await globalInteractionHandler.handleInteraction(
        interaction,
        async (interaction) => {
            // المنطق الفعلي للزر
            const embed = createSuccessEmbed('تم الضغط على الزر بنجاح!');
            await InteractionHandler.safeReply(interaction, '', { embeds: [embed] });
            return true;
        },
        {
            checkRateLimit: true,
            rateLimitAction: 'button_click',
            rateLimitCount: 3,
            rateLimitWindow: 30000, // 30 ثانية
            logAction: true
        }
    );
}

// مثال 2: معالجة أمر رسالة بطريقة متقدمة
async function handleMessageCommand(message, args) {
    return await globalCommandHandler.handleCommand(
        message,
        'example',
        args,
        async (message, args) => {
            // المنطق الفعلي للأمر
            const embed = AdvancedEmbedBuilder.createProgressEmbed(
                'جاري التنفيذ',
                1,
                3,
                'يرجى الانتظار...'
            );
            
            const sentMessage = await MessageHandler.safeSend(message.channel, '', { embeds: [embed] });
            
            // محاكاة عملية طويلة
            for (let i = 1; i <= 3; i++) {
                setTimeout(async () => {
                    const progressEmbed = AdvancedEmbedBuilder.createProgressEmbed(
                        'جاري التنفيذ',
                        i,
                        3,
                        `الخطوة ${i} من 3`
                    );
                    await MessageHandler.safeEdit(sentMessage, '', { embeds: [progressEmbed] });
                    
                    if (i === 3) {
                        const successEmbed = createSuccessEmbed('تم الانتهاء من العملية!');
                        await MessageHandler.safeEdit(sentMessage, '', { embeds: [successEmbed] });
                    }
                }, i * 2000);
            }
            
            return true;
        },
        {
            cooldown: 10000, // 10 ثواني
            validateArgs: (args) => args.length > 0,
            logUsage: true
        }
    );
}

// مثال 3: إنشاء قائمة تفاعلية متقدمة
async function createInteractiveList(message, items) {
    const itemsPerPage = 5;
    let currentPage = 1;
    const totalPages = Math.ceil(items.length / itemsPerPage);
    
    const embed = AdvancedEmbedBuilder.createListEmbed(
        'قائمة العناصر',
        items,
        itemsPerPage,
        currentPage
    );
    
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    
    const prevButton = new ButtonBuilder()
        .setCustomId('prev_page')
        .setLabel('◀️ السابق')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage === 1);
    
    const nextButton = new ButtonBuilder()
        .setCustomId('next_page')
        .setLabel('التالي ▶️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage === totalPages);
    
    const row = new ActionRowBuilder().addComponents(prevButton, nextButton);
    
    const sentMessage = await MessageHandler.safeSend(message.channel, '', {
        embeds: [embed],
        components: [row]
    });
    
    if (!sentMessage) return;
    
    // إنشاء collector للأزرار
    const collector = CollectorManager.createButtonCollector(
        sentMessage,
        i => i.user.id === message.author.id && ['prev_page', 'next_page'].includes(i.customId),
        { time: 300000 } // 5 دقائق
    );
    
    collector.on('collect', async (interaction) => {
        await globalInteractionHandler.handleInteraction(
            interaction,
            async (interaction) => {
                if (interaction.customId === 'prev_page' && currentPage > 1) {
                    currentPage--;
                } else if (interaction.customId === 'next_page' && currentPage < totalPages) {
                    currentPage++;
                }
                
                const newEmbed = AdvancedEmbedBuilder.createListEmbed(
                    'قائمة العناصر',
                    items,
                    itemsPerPage,
                    currentPage
                );
                
                const newPrevButton = ButtonBuilder.from(prevButton)
                    .setDisabled(currentPage === 1);
                const newNextButton = ButtonBuilder.from(nextButton)
                    .setDisabled(currentPage === totalPages);
                
                const newRow = new ActionRowBuilder().addComponents(newPrevButton, newNextButton);
                
                await InteractionHandler.safeUpdate(interaction, {
                    embeds: [newEmbed],
                    components: [newRow]
                });
                
                return true;
            },
            {
                checkRateLimit: true,
                rateLimitAction: 'pagination',
                rateLimitCount: 10,
                rateLimitWindow: 30000
            }
        );
    });
    
    collector.on('end', async () => {
        const disabledRow = new ActionRowBuilder().addComponents(
            ButtonBuilder.from(prevButton).setDisabled(true),
            ButtonBuilder.from(nextButton).setDisabled(true)
        );
        
        await MessageHandler.safeEdit(sentMessage, '', {
            embeds: [embed],
            components: [disabledRow]
        });
    });
}

// مثال 4: نظام تأكيد متقدم
async function createAdvancedConfirmation(message, title, description, onConfirm, onCancel) {
    const embed = AdvancedEmbedBuilder.createConfirmationEmbed(title, description);
    
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    
    const confirmButton = new ButtonBuilder()
        .setCustomId('confirm_action')
        .setLabel('✅ تأكيد')
        .setStyle(ButtonStyle.Success);
    
    const cancelButton = new ButtonBuilder()
        .setCustomId('cancel_action')
        .setLabel('❌ إلغاء')
        .setStyle(ButtonStyle.Danger);
    
    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);
    
    const sentMessage = await MessageHandler.safeSend(message.channel, '', {
        embeds: [embed],
        components: [row]
    });
    
    if (!sentMessage) return;
    
    const collector = CollectorManager.createButtonCollector(
        sentMessage,
        i => i.user.id === message.author.id && ['confirm_action', 'cancel_action'].includes(i.customId),
        { time: 30000, max: 1 } // 30 ثانية، تفاعل واحد فقط
    );
    
    collector.on('collect', async (interaction) => {
        await globalInteractionHandler.handleInteraction(
            interaction,
            async (interaction) => {
                if (interaction.customId === 'confirm_action') {
                    const result = await onConfirm();
                    if (result) {
                        const successEmbed = createSuccessEmbed('تم تنفيذ العملية بنجاح!');
                        await InteractionHandler.safeUpdate(interaction, {
                            embeds: [successEmbed],
                            components: []
                        });
                    }
                } else {
                    const cancelEmbed = AdvancedEmbedBuilder.createEmbed('info', 'تم الإلغاء', 'تم إلغاء العملية بواسطة المستخدم.');
                    await InteractionHandler.safeUpdate(interaction, {
                        embeds: [cancelEmbed],
                        components: []
                    });
                    if (onCancel) await onCancel();
                }
                
                return true;
            },
            { logAction: true }
        );
    });
    
    collector.on('end', async (collected) => {
        if (collected.size === 0) {
            const timeoutEmbed = AdvancedEmbedBuilder.createEmbed('warning', 'انتهت المهلة', 'تم إلغاء العملية بسبب انتهاء المهلة الزمنية.');
            await MessageHandler.safeEdit(sentMessage, '', {
                embeds: [timeoutEmbed],
                components: []
            });
        }
    });
}

module.exports = {
    handleButtonInteraction,
    handleMessageCommand,
    createInteractiveList,
    createAdvancedConfirmation
};
