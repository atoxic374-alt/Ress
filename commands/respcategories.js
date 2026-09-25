const { getBotConfigPath } = require('../utils/storagePaths');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const colorManager = require('../utils/colorManager.js');

const DATA_FILES = {
    categories: path.join(__dirname, '..', 'data', 'respCategories.json'),
    responsibilities: path.join(__dirname, '..', 'data', 'responsibilities.json')
};

function readJSONFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error);
        return defaultValue;
    }
}

function writeJSONFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`خطأ في كتابة ${filePath}:`, error);
        return false;
    }
}

function isAuthorizedCategoryManager(interaction) {
    try {
        const botConfig = readJSONFile(getBotConfigPath(), {});
        const BOT_OWNERS = botConfig.owners || [];
        return BOT_OWNERS.includes(interaction.user.id) || interaction.guild?.ownerId === interaction.user.id;
    } catch (error) {
        console.error('خطأ في التحقق من الصلاحية:', error);
        return false;
    }
}

let updateTimeout = null;
const pendingReorderCategoryByUser = new Map();
async function updateRespEmbeds(client) {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = setTimeout(async () => {
        try {
            const respCommand = client.commands.get('resp');
            if (respCommand && respCommand.updateEmbedMessage) {
                await respCommand.updateEmbedMessage(client);
                console.log('✅ [DEBOUNCED] تم تحديث رسائل الإيمبد تلقائياً');
            }
        } catch (error) {
            console.error('خطأ في تحديث رسائل الإيمبد:', error);
        }
    }, 3000);
}

async function updateAllCategoriesEmbeds(client) {
    try {
        const categories = readJSONFile(DATA_FILES.categories, {});
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const embed = createCategoriesListEmbed(categories, responsibilities);
        const buttons = createMainMenuButtons();

        // تحديث جميع رسائل ctg في جميع السيرفرات
        if (client.ctgMessages) {
            for (const [guildId, message] of client.ctgMessages.entries()) {
                try {
                    await message.edit({
                        embeds: [embed],
                        components: [buttons]
                    });
                    console.log(`✅ تم تحديث إيمبد ctg في السيرفر ${guildId}`);
                } catch (error) {
                    console.error(`خطأ في تحديث إيمبد ctg للسيرفر ${guildId}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('خطأ في تحديث إيمبد ctg:', error);
    }
}

async function updateCategoriesEmbed(message) {
    try {
        const categories = readJSONFile(DATA_FILES.categories, {});
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const embed = createCategoriesListEmbed(categories, responsibilities);
        const buttons = createMainMenuButtons();

        if (message && message.edit) {
            await message.edit({
                embeds: [embed],
                components: [buttons]
            });
        }
    } catch (error) {
        console.error('خطأ في تحديث إيمبد الأقسام:', error);
    }
}

function createCategoriesListEmbed(categories, responsibilities = {}) {
    const embed = colorManager.createEmbed()
        .setTitle('Categories List');

    if (Object.keys(categories).length === 0) {
        embed.setDescription ('No categories\n\n Choose Button To setup categories');
    } else {
        let description = '** categories :**\n\n';
        const sortedCategories = Object.entries(categories).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

        sortedCategories.forEach(([catName, catData], index) => {
            const respList = catData.responsibilities || [];
            const respCount = respList.length;

            description += `**${index + 1}. ${catName}** (ترتيب: ${catData.order || 0})\n`;

            if (respCount === 0) {
                description += `    لا توجد مسؤوليات\n\n`;
            } else {
                description += `   المسؤوليات (${respCount}) :\n`;
                respList.forEach(respName => {
                    description += `      • ${respName}\n`;
                });
                description += '\n';
            }
        });

        embed.setDescription(description);
    }

    return embed;
}

function createMainMenuButtons() {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('add_category')
                .setLabel('Add')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('edit_category')
                .setLabel('Edit')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('delete_category')
                .setLabel('Delete')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('manage_category_resps')
                .setLabel('responsibilities')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('reorder_category_resps')
                .setLabel('ترتيب المسؤوليات')
                .setStyle(ButtonStyle.Secondary)
        );
}

function createCategorySelectMenu(categories, customId = 'select_category', placeholder = 'اختر قسماً...') {
    const sortedCategories = Object.entries(categories).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

    const options = sortedCategories.map(([catName, catData], index) => ({
        label: catName,
        value: catName,
        description: `${catData.responsibilities ? catData.responsibilities.length : 0} مسؤولية`,

    }));

    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(options.length > 0 ? options : [{ label: 'لا توجد أقسام', value: 'none', description: 'قم بإضافة قسم أولاً' }])
        .setDisabled(options.length === 0);
}

async function showCategoryRespsPage(interaction, categoryName, allRespNames, currentRespNames, page, isInitial) {
    const totalPages = Math.ceil(allRespNames.length / 25);
    const start = page * 25;
    const end = Math.min(start + 25, allRespNames.length);
    const pageResps = allRespNames.slice(start, end);

    const options = pageResps.map(respName => ({
        label: respName.substring(0, 100),
        value: respName,
        description: currentRespNames.includes(respName) ? '✅ مضافة حالياً' : 'غير مضافة',
        default: currentRespNames.includes(respName)
    }));

    const components = [];

    // القائمة المنسدلة
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`add_resps_to_category_page_${page}_${categoryName}`)
        .setPlaceholder(`اختر المسؤوليات (صفحة ${page + 1}/${totalPages})...`)
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options);
    components.push(new ActionRowBuilder().addComponents(selectMenu));

    // أزرار التنقل
    if (totalPages > 1) {
        const navButtons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`category_resps_nav_prev`)
                    .setLabel('◀️ السابق')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`category_resps_nav_info`)
                    .setLabel(`صفحة ${page + 1} من ${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`category_resps_nav_next`)
                    .setLabel('التالي ▶️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
        components.push(navButtons);
    }

    // زر الحفظ
    const actionButtons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`save_category_resps_${categoryName}`)
                .setLabel('💾 حفظ')
                .setStyle(ButtonStyle.Success)
        );
    components.push(actionButtons);

    const updateOptions = {
        content: `**إدارة مسؤوليات القسم: ${categoryName}**\n\n اختر المسؤوليات التي تريد إضافتها لهذا القسم:\n\nالمسؤوليات المتاحة: ${allRespNames.length}\n✅ المسؤوليات المحددة حالياً : ${currentRespNames.length}`,
        components: components
    };

    if (isInitial) {
        await interaction.update(updateOptions);
    } else {
        await interaction.update(updateOptions);
    }
}

module.exports = {
    name: 'ctg',
    description: 'إدارة أقسام المسؤوليات',

    async handleInteraction(interaction, context) {
        const { client } = context;
        const customId = interaction.customId;

        if (!isAuthorizedCategoryManager(interaction)) {
            if (interaction.deferred || interaction.replied) return;
            await interaction.reply({
                content: '❌ لا تملك صلاحية استخدام إدارة الأقسام.',
                ephemeral: true
            });
            return;
        }

        if (interaction.isButton()) {
            if (customId === 'add_category') {
                const modal = new ModalBuilder()
                    .setCustomId('add_category_modal')
                    .setTitle('إضافة قسم جديد');

                const nameInput = new TextInputBuilder()
                    .setCustomId('category_name')
                    .setLabel('اسم القسم')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('مثال: قسم الإدارة')
                    .setRequired(true)
                    .setMaxLength(100);

                const orderInput = new TextInputBuilder()
                    .setCustomId('category_order')
                    .setLabel('الترتيب (رقم)')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('1')
                    .setRequired(false)
                    .setMaxLength(3);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(nameInput),
                    new ActionRowBuilder().addComponents(orderInput)
                );

                await interaction.showModal(modal);

            } else if (customId === 'edit_category') {
                const currentCategories = readJSONFile(DATA_FILES.categories, {});

                if (Object.keys(currentCategories).length === 0) {
                    await interaction.reply({
                        content: '❌ لا توجد أقسام للتعديل',
                        ephemeral: true
                    });
                    return;
                }

                const selectMenu = createCategorySelectMenu(currentCategories, 'select_category_to_edit', 'اختر قسماً للتعديل...');

                await interaction.reply({
                    content: '**اختر القسم الذي تريد تعديله:**',
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });

            } else if (customId === 'delete_category') {
                const currentCategories = readJSONFile(DATA_FILES.categories, {});

                if (Object.keys(currentCategories).length === 0) {
                    await interaction.reply({
                        content: '❌ لا توجد أقسام للحذف',
                        ephemeral: true
                    });
                    return;
                }

                const selectMenu = createCategorySelectMenu(currentCategories, 'select_category_to_delete', 'اختر قسماً للحذف...');

                await interaction.reply({
                    content: '**اختر القسم الذي تريد حذفه:**',
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });

            } else if (customId === 'manage_category_resps') {
                const currentCategories = readJSONFile(DATA_FILES.categories, {});

                if (Object.keys(currentCategories).length === 0) {
                    await interaction.reply({
                        content: '❌ لا توجد أقسام. قم بإضافة قسم أولاً',
                        ephemeral: true
                    });
                    return;
                }

                const selectMenu = createCategorySelectMenu(currentCategories, 'select_category_for_resps', 'اختر قسماً...');

                await interaction.reply({
                    content: '**اختر القسم لإدارة مسؤولياته:**',
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });

            } else if (customId === 'reorder_category_resps') {
                const currentCategories = readJSONFile(DATA_FILES.categories, {});

                if (Object.keys(currentCategories).length === 0) {
                    await interaction.reply({
                        content: '❌ لا توجد أقسام. قم بإضافة قسم أولاً',
                        ephemeral: true
                    });
                    return;
                }

                const selectMenu = createCategorySelectMenu(currentCategories, 'select_category_for_resp_order', 'اختر قسماً لترتيب مسؤولياته...');

                await interaction.reply({
                    content: '**اختر القسم الذي تريد ترتيب مسؤولياته:**',
                    components: [new ActionRowBuilder().addComponents(selectMenu)],
                    ephemeral: true
                });

            } else if (customId.startsWith('confirm_delete_')) {
                const categoryName = customId.replace('confirm_delete_', '');
                const currentCategories = readJSONFile(DATA_FILES.categories, {});

                delete currentCategories[categoryName];
                writeJSONFile(DATA_FILES.categories, currentCategories);

                await interaction.update({
                    content: `✅ تم حذف القسم "${categoryName}" بنجاح`,
                    components: []
                });

                await updateRespEmbeds(client);
                await updateAllCategoriesEmbeds(client);

            } else if (customId === 'cancel_delete') {
                await interaction.update({
                    content: '❌ تم إلغاء الحذف',
                    components: []
                });

            } else if (customId.startsWith('save_category_resps_')) {
                const categoryName = customId.replace('save_category_resps_', '');
                const selectedResps = interaction.message.tempCategoryResps?.[categoryName] || [];

                const currentCategories = readJSONFile(DATA_FILES.categories, {});

                if (!currentCategories[categoryName]) {
                    currentCategories[categoryName] = { order: 0, responsibilities: [] };
                }

                currentCategories[categoryName].responsibilities = selectedResps;
                writeJSONFile(DATA_FILES.categories, currentCategories);

                await interaction.update({
                    content: `✅ تم حفظ ${selectedResps.length} مسؤولية للقسم "${categoryName}"`,
                    components: []
                });

                await updateRespEmbeds(client);
                await updateAllCategoriesEmbeds(client);
            }
        } else if (interaction.isStringSelectMenu()) {
            if (customId === 'select_category_to_edit') {
                const categoryName = interaction.values[0];
                const currentCategories = readJSONFile(DATA_FILES.categories, {});
                const categoryData = currentCategories[categoryName];

                const modal = new ModalBuilder()
                    .setCustomId(`edit_category_modal_${categoryName}`)
                    .setTitle('تعديل القسم');

                const nameInput = new TextInputBuilder()
                    .setCustomId('category_new_name')
                    .setLabel('الاسم الجديد للقسم')
                    .setStyle(TextInputStyle.Short)
                    .setValue(categoryName)
                    .setRequired(true)
                    .setMaxLength(100);

                const orderInput = new TextInputBuilder()
                    .setCustomId('category_new_order')
                    .setLabel('الترتيب الجديد (رقم)')
                    .setStyle(TextInputStyle.Short)
                    .setValue((categoryData.order || 0).toString())
                    .setRequired(false)
                    .setMaxLength(3);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(nameInput),
                    new ActionRowBuilder().addComponents(orderInput)
                );

                await interaction.showModal(modal);

            } else if (customId === 'select_category_to_delete') {
                const categoryName = interaction.values[0];

                const confirmRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`confirm_delete_${categoryName}`)
                            .setLabel('✅ تأكيد الحذف')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId('cancel_delete')
                            .setLabel('❌ إلغاء')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({
                    content: `**⚠️ هل أنت متأكد من حذف القسم "${categoryName}"؟**\n\nسيتم حذف القسم فقط، المسؤوليات ستبقى موجودة.`,
                    components: [confirmRow]
                });

            } else if (customId === 'select_category_for_resp_order') {
                const categoryName = interaction.values[0];
                const currentCategories = readJSONFile(DATA_FILES.categories, {});
                const categoryData = currentCategories[categoryName];

                if (!categoryData) {
                    await interaction.update({ content: '❌ القسم غير موجود', components: [] });
                    return;
                }

                const categoryResps = Array.isArray(categoryData.responsibilities) ? categoryData.responsibilities : [];
                if (categoryResps.length < 2) {
                    await interaction.update({
                        content: '❌ يجب أن يحتوي القسم على مسؤوليتين على الأقل لإعادة الترتيب.',
                        components: []
                    });
                    return;
                }

                pendingReorderCategoryByUser.set(interaction.user.id, categoryName);

                const modal = new ModalBuilder()
                    .setCustomId('reorder_category_resps_modal')
                    .setTitle(`ترتيب مسؤوليات: ${categoryName}`);

                const respNameInput = new TextInputBuilder()
                    .setCustomId('resp_name')
                    .setLabel('اسم المسؤولية')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder(categoryResps[0])
                    .setRequired(true)
                    .setMaxLength(100);

                const posInput = new TextInputBuilder()
                    .setCustomId('new_position')
                    .setLabel(`الموضع الجديد (1 - ${categoryResps.length})`)
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('1')
                    .setRequired(true)
                    .setMaxLength(3);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(respNameInput),
                    new ActionRowBuilder().addComponents(posInput)
                );

                await interaction.showModal(modal);

            } else if (customId === 'select_category_for_resps') {
                const categoryName = interaction.values[0];
                const currentCategories = readJSONFile(DATA_FILES.categories, {});
                const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
                const categoryData = currentCategories[categoryName] || { responsibilities: [] };

                const allRespNames = Object.keys(responsibilities);
                const currentRespNames = categoryData.responsibilities || [];

                if (allRespNames.length === 0) {
                    await interaction.update({
                        content: '❌ لا توجد مسؤوليات متاحة. يجب إنشاء مسؤوليات أولاً من خلال الأوامر الأخرى.',
                        components: []
                    });
                    return;
                }

                // تخزين البيانات المؤقتة
                if (!interaction.message.tempCategoryResps) {
                    interaction.message.tempCategoryResps = {};
                }
                interaction.message.tempCategoryResps[categoryName] = [...currentRespNames];
                interaction.message.tempCategoryData = {
                    categoryName,
                    allRespNames,
                    currentPage: 0
                };

                // إنشاء القوائم مع pagination
                await showCategoryRespsPage(interaction, categoryName, allRespNames, currentRespNames, 0, true);

            } else if (customId.startsWith('add_resps_to_category_page_')) {
                const parts = customId.split('_');
                const pageNum = parseInt(parts[parts.length - 1]);
                const categoryName = interaction.message.tempCategoryData?.categoryName;

                if (!categoryName) {
                    await interaction.update({
                        content: '❌ حدث خطأ في تحميل البيانات',
                        components: []
                    });
                    return;
                }

                const selectedResps = interaction.values;
                const tempData = interaction.message.tempCategoryResps || {};
                if (!tempData[categoryName]) {
                    tempData[categoryName] = [];
                }

                // دمج الاختيارات
                selectedResps.forEach(resp => {
                    if (!tempData[categoryName].includes(resp)) {
                        tempData[categoryName].push(resp);
                    }
                });

                // إزالة المسؤوليات غير المحددة في هذه الصفحة
                const currentCategories = readJSONFile(DATA_FILES.categories, {});
                const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
                const allRespNames = Object.keys(responsibilities);
                const start = pageNum * 25;
                const end = Math.min(start + 25, allRespNames.length);
                const pageResps = allRespNames.slice(start, end);

                pageResps.forEach(resp => {
                    if (!selectedResps.includes(resp)) {
                        const index = tempData[categoryName].indexOf(resp);
                        if (index > -1) {
                            tempData[categoryName].splice(index, 1);
                        }
                    }
                });

                interaction.message.tempCategoryResps = tempData;

                await interaction.deferUpdate();

            } else if (customId.startsWith('category_resps_nav_')) {
                const action = customId.split('_').pop();
                const categoryName = interaction.message.tempCategoryData?.categoryName;
                const allRespNames = interaction.message.tempCategoryData?.allRespNames || [];
                const currentPage = interaction.message.tempCategoryData?.currentPage || 0;

                let newPage = currentPage;
                if (action === 'prev' && currentPage > 0) {
                    newPage = currentPage - 1;
                } else if (action === 'next') {
                    const totalPages = Math.ceil(allRespNames.length / 25);
                    if (currentPage < totalPages - 1) {
                        newPage = currentPage + 1;
                    }
                }

                interaction.message.tempCategoryData.currentPage = newPage;

                const tempData = interaction.message.tempCategoryResps || {};
                const currentRespNames = tempData[categoryName] || [];

                await showCategoryRespsPage(interaction, categoryName, allRespNames, currentRespNames, newPage, false);
            }
        }
    },

    async execute(message, args, context) {
        const { client } = context;

        const botConfig = readJSONFile(getBotConfigPath(), {});
        const BOT_OWNERS = botConfig.owners || [];
        const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;

        if (!isOwner) {
            await message.react('❌');
            return;
        }

        const categories = readJSONFile(DATA_FILES.categories, {});
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const embed = createCategoriesListEmbed(categories, responsibilities);
        const buttons = createMainMenuButtons();

        const sentMessage = await message.channel.send({
            embeds: [embed],
            components: [buttons]
        });

        // حفظ مرجع الرسالة للتحديثات التلقائية
        if (!client.ctgMessages) {
            client.ctgMessages = new Map();
        }
        client.ctgMessages.set(message.guild.id, sentMessage);
    },

    async handleModalSubmit(interaction, client) {
        if (!isAuthorizedCategoryManager(interaction)) {
            if (interaction.deferred || interaction.replied) return;
            await interaction.reply({
                content: '❌ لا تملك صلاحية استخدام إدارة الأقسام.',
                ephemeral: true
            });
            return;
        }

        if (interaction.customId === 'add_category_modal') {
            const categoryName = interaction.fields.getTextInputValue('category_name');
            const orderInput = interaction.fields.getTextInputValue('category_order');
            const order = orderInput ? parseInt(orderInput) : Object.keys(readJSONFile(DATA_FILES.categories, {})).length + 1;

            const categories = readJSONFile(DATA_FILES.categories, {});

            if (categories[categoryName]) {
                await interaction.reply({
                    content: `❌ القسم "${categoryName}" موجود بالفعل`,
                    ephemeral: true
                });
                return;
            }

            categories[categoryName] = {
                order: order,
                responsibilities: []
            };

            writeJSONFile(DATA_FILES.categories, categories);

            await interaction.reply({
                content: `✅ تم إضافة القسم "${categoryName}" بنجاح`,
                ephemeral: true
            });

            await updateRespEmbeds(client);
            await updateAllCategoriesEmbeds(client);

        } else if (interaction.customId === 'reorder_category_resps_modal') {
            const categoryName = pendingReorderCategoryByUser.get(interaction.user.id);
            pendingReorderCategoryByUser.delete(interaction.user.id);

            if (!categoryName) {
                await interaction.reply({ content: '❌ انتهت جلسة الترتيب، أعد المحاولة.', ephemeral: true });
                return;
            }

            const categories = readJSONFile(DATA_FILES.categories, {});
            const categoryData = categories[categoryName];
            if (!categoryData || !Array.isArray(categoryData.responsibilities)) {
                await interaction.reply({ content: '❌ القسم غير موجود أو لا يحتوي مسؤوليات.', ephemeral: true });
                return;
            }

            const respName = interaction.fields.getTextInputValue('resp_name').trim();
            const newPositionRaw = interaction.fields.getTextInputValue('new_position').trim();
            const newPosition = Number(newPositionRaw);
            const list = categoryData.responsibilities;

            const respToMove = list.find((name) => name.toLowerCase() === respName.toLowerCase());

            const currentIndex = respToMove ? list.indexOf(respToMove) : -1;
            if (currentIndex === -1) {
                await interaction.reply({ content: `❌ المسؤولية "${respName}" غير موجودة داخل قسم "${categoryName}".`, ephemeral: true });
                return;
            }

            if (!Number.isInteger(newPosition) || newPosition < 1 || newPosition > list.length) {
                await interaction.reply({ content: `❌ أدخل ترتيباً صحيحاً من 1 إلى ${list.length}.`, ephemeral: true });
                return;
            }

            const targetIndex = newPosition - 1;
            if (targetIndex !== currentIndex) {
                const [moved] = list.splice(currentIndex, 1);
                list.splice(targetIndex, 0, moved);
                writeJSONFile(DATA_FILES.categories, categories);
                await updateRespEmbeds(client);
                await updateAllCategoriesEmbeds(client);
            }

            await interaction.reply({
                content: `✅ تم نقل "${respToMove}" إلى الترتيب ${newPosition} داخل قسم "${categoryName}".`,
                ephemeral: true
            });

        } else if (interaction.customId.startsWith('edit_category_modal_')) {
            const oldCategoryName = interaction.customId.replace('edit_category_modal_', '');
            const newCategoryName = interaction.fields.getTextInputValue('category_new_name');
            const orderInput = interaction.fields.getTextInputValue('category_new_order');
            const newOrder = orderInput ? parseInt(orderInput) : 0;

            const categories = readJSONFile(DATA_FILES.categories, {});

            if (oldCategoryName !== newCategoryName && categories[newCategoryName]) {
                await interaction.reply({
                    content: `❌ القسم "${newCategoryName}" موجود بالفعل`,
                    ephemeral: true
                });
                return;
            }

            const categoryData = categories[oldCategoryName];
            delete categories[oldCategoryName];

            categories[newCategoryName] = {
                order: newOrder,
                responsibilities: categoryData.responsibilities || []
            };

            writeJSONFile(DATA_FILES.categories, categories);

            await interaction.reply({
                content: `✅ تم تعديل القسم بنجاح`,
                ephemeral: true
            });

            await updateRespEmbeds(client);
            await updateAllCategoriesEmbeds(client);
        }
    }
};
