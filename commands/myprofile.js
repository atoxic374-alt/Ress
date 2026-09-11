const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { isUserBlocked } = require('./block.js');
const colorManager = require('../utils/colorManager.js');

const name = 'myprofile';

// مسار قاعدة البيانات
const { getDatabasePath } = require('../utils/storagePaths');
const dbPath = getDatabasePath('discord_bot.db');

// تهيئة جدول البيانات المخصصة
function initDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        
        db.run(`
            CREATE TABLE IF NOT EXISTS custom_profiles (
                user_id TEXT PRIMARY KEY,
                avatar_url TEXT,
                banner_url TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// الحصول على بيانات المستخدم المخصصة
function getCustomProfile(userId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        
        db.get('SELECT avatar_url, banner_url FROM custom_profiles WHERE user_id = ?', [userId], (err, row) => {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve(row || {});
            }
        });
    });
}

// تعيين الأفتار المخصص
async function setCustomAvatar(userId, avatarUrl) {
    try {
        const response = await axios.get(avatarUrl, { responseType: 'arraybuffer' });
        const ext = avatarUrl.split('.').pop().split('?')[0] || 'png';
        const fileName = `${userId}_avatar_${Date.now()}.${ext}`;
        const dirPath = path.join(__dirname, '..', 'data', 'custom_assets', 'avatars');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        const filePath = path.join(dirPath, fileName);
        
        fs.writeFileSync(filePath, Buffer.from(response.data));
        const localUrl = `/data/custom_assets/avatars/${fileName}`;

        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath);
            db.run(`
                INSERT INTO custom_profiles (user_id, avatar_url, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET 
                    avatar_url = excluded.avatar_url,
                    updated_at = CURRENT_TIMESTAMP
            `, [userId, localUrl], (err) => {
                db.close();
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (error) {
        console.error('Error saving local avatar:', error);
        throw error;
    }
}

// تعيين البنر المخصص
async function setCustomBanner(userId, bannerUrl) {
    try {
        const response = await axios.get(bannerUrl, { responseType: 'arraybuffer' });
        const ext = bannerUrl.split('.').pop().split('?')[0] || 'png';
        const fileName = `${userId}_banner_${Date.now()}.${ext}`;
        const dirPath = path.join(__dirname, '..', 'data', 'custom_assets', 'banners');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        const filePath = path.join(dirPath, fileName);
        
        fs.writeFileSync(filePath, Buffer.from(response.data));
        const localUrl = `/data/custom_assets/banners/${fileName}`;

        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath);
            db.run(`
                INSERT INTO custom_profiles (user_id, banner_url, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET 
                    banner_url = excluded.banner_url,
                    updated_at = CURRENT_TIMESTAMP
            `, [userId, localUrl], (err) => {
                db.close();
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (error) {
        console.error('Error saving local banner:', error);
        throw error;
    }
}

// إزالة الأفتار المخصص
function removeCustomAvatar(userId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        
        db.run('UPDATE custom_profiles SET avatar_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [userId], (err) => {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// إزالة البنر المخصص
function removeCustomBanner(userId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        
        db.run('UPDATE custom_profiles SET banner_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [userId], (err) => {
            db.close();
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// التحقق من صحة الرابط
function isValidImageUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
        return false;
    }
}

// إنشاء الإمبد الرئيسي
async function createMainEmbed(userId, client) {
    const userProfile = await getCustomProfile(userId);
    
    const embed = new EmbedBuilder()
        .setTitle('Your Profile')
        .setDescription('اختر ما تريد تخصيصه في بروفايلك :')
  .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }))
        .addFields(
            {
                name: 'Avatar',
                value: userProfile.avatar_url ? '✅ تم تعيين أفتار مخصص' : '❌ لم يتم تعيين أفتار مخصص',
                inline: true
            },
            {
                name: 'Banner',
                value: userProfile.banner_url ? '✅ تم تعيين بنر مخصص' : '❌ لم يتم تعيين بنر مخصص',
                inline: true
            }
        )
        .setFooter({ text: 'Choose What You Need' });
    
    return embed;
}

// إنشاء الأزرار
async function createButtons(userId) {
    const userProfile = await getCustomProfile(userId);
    
    const row = new ActionRowBuilder();
    
    // زر الأفتار
    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`myprofile_avatar_${userId}`)
            .setLabel('Set Avatar')
            .setEmoji('<:emoji_52:1442587232358764658>')
            .setStyle(ButtonStyle.Primary)
    );
    
    // زر البنر
    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`myprofile_banner_${userId}`)
            .setLabel('Set Banner')
            .setEmoji('<:emoji_52:1442587232358764658>')
            .setStyle(ButtonStyle.Primary)
    );
    
    // زر إزالة الأفتار إذا كان موجوداً
    if (userProfile.avatar_url) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`myprofile_remove_avatar_${userId}`)
                .setLabel('Remove Avatar')
                .setEmoji('<:emoji_64:1442587855447654522>')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    
    // زر إزالة البنر إذا كان موجوداً
    if (userProfile.banner_url) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`myprofile_remove_banner_${userId}`)
                .setLabel('Remove Banner')
                .setEmoji('<:emoji_64:1442587855447654522>')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    
    return row;
}

async function execute(message, args, { client }) {
    try {
        // فحص البلوك
        if (isUserBlocked(message.author.id)) {
            const blockedEmbed = colorManager.createEmbed()
                .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
                .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

            await message.channel.send({ embeds: [blockedEmbed] });
            return;
        }

        await initDatabase();
        
        const userId = message.author.id;
        
        const embed = await createMainEmbed(userId, client);
        const buttons = await createButtons(userId);
        
        await message.channel.send({
            embeds: [embed],
            components: [buttons]
        });
    } catch (error) {
        console.error('خطأ في أمر myprofile:', error);
        await message.channel.send('❌ حدث خطأ أثناء تحميل إعدادات البروفايل.');
    }
}

// معالج التفاعلات
async function handleInteraction(interaction, client) {
    if (!interaction.isButton()) return;
    
    const customId = interaction.customId;
    
    // التحقق من أن المستخدم هو صاحب الأمر
    const userIdFromButton = customId.split('_').pop();
    if (interaction.user.id !== userIdFromButton) {
        return interaction.reply({
            content: '❌ شتبي انت؟',
            ephemeral: true
        });
    }
    
    const userId = interaction.user.id;
    
    // معالجة إزالة الأفتار
    if (customId.startsWith('myprofile_remove_avatar_')) {
        try {
            await removeCustomAvatar(userId);
            await interaction.message.react('✅');
            
            const embed = await createMainEmbed(userId, client);
            const buttons = await createButtons(userId);
            
            await interaction.update({
                embeds: [embed],
                components: [buttons]
            });
        } catch (error) {
            console.error('خطأ في إزالة الأفتار:', error);
            await interaction.reply({
                content: '❌ حدث خطأ أثناء إزالة الأفتار.',
                ephemeral: true
            });
        }
        
        return;
    }
    
    // معالجة إزالة البنر
    if (customId.startsWith('myprofile_remove_banner_')) {
        try {
            await removeCustomBanner(userId);
            await interaction.message.react('✅');
            
            const embed = await createMainEmbed(userId, client);
            const buttons = await createButtons(userId);
            
            await interaction.update({
                embeds: [embed],
                components: [buttons]
            });
        } catch (error) {
            console.error('خطأ في إزالة البنر:', error);
            await interaction.reply({
                content: '❌ حدث خطأ أثناء إزالة البنر.',
                ephemeral: true
            });
        }
        
        return;
    }
    
    // معالجة تعيين الأفتار
    if (customId.startsWith('myprofile_avatar_')) {
        await interaction.reply({
            content: ' ** ارسل رابط او ارسل الصورة**',
            ephemeral: true
        });
        
        const filter = m => m.author.id === userId;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });
        
        collector.on('collect', async (msg) => {
            let imageUrl = null;
            
            // التحقق من المرفقات
            if (msg.attachments.size > 0) {
                const attachment = msg.attachments.first();
                if (attachment?.url) {
                    imageUrl = attachment.url;
                }
            }
            // التحقق من الرابط
            else if (msg.content && isValidImageUrl(msg.content)) {
                imageUrl = msg.content;
            }
            
            if (imageUrl) {
                try {
                    // التحقق من صحة الصورة
                    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 15 * 1024 * 1024 });
                    if (!response.data || !Buffer.from(response.data).length) throw new Error('الصورة فارغة');
                    
                    await setCustomAvatar(userId, imageUrl);
                    await msg.react('✅');
                    
                    const embed = await createMainEmbed(userId, client);
                    const buttons = await createButtons(userId);
                    
                    await interaction.message.edit({
                        embeds: [embed],
                        components: [buttons]
                    });
                } catch (error) {
                    await msg.react('❌');
                    await interaction.followUp({
                        content: '❌ فشل تحميل الصورة. تأكد من صحة الرابط.',
                        ephemeral: true
                    });
                }
            } else {
                await msg.react('❌');
                await interaction.followUp({
                    content: '❌ الرجاء إرسال رابط صورة صحيح أو إرفاق صورة.',
                    ephemeral: true
                });
            }
        });
        
        collector.on('end', (collected) => {
            if (collected.size === 0) {
                interaction.followUp({
                    content: '⏱️ انتهى الوقت. الرجاء المحاولة مرة أخرى.',
                    ephemeral: true
                });
            }
        });
        
        return;
    }
    
    // معالجة تعيين البنر
    if (customId.startsWith('myprofile_banner_')) {
        await interaction.reply({
            content: '🎨 **ارسل البنر او رابطه**',
            ephemeral: true
        });
        
        const filter = m => m.author.id === userId;
        const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });
        
        collector.on('collect', async (msg) => {
            let imageUrl = null;
            
            // التحقق من المرفقات
            if (msg.attachments.size > 0) {
                const attachment = msg.attachments.first();
                if (attachment?.url) {
                    imageUrl = attachment.url;
                }
            }
            // التحقق من الرابط
            else if (msg.content && isValidImageUrl(msg.content)) {
                imageUrl = msg.content;
            }
            
            if (imageUrl) {
                try {
                    // التحقق من صحة الصورة
                    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 15 * 1024 * 1024 });
                    if (!response.data || !Buffer.from(response.data).length) throw new Error('الصورة فارغة');
                    
                    await setCustomBanner(userId, imageUrl);
                    await msg.react('✅');
                    
                    const embed = await createMainEmbed(userId, client);
                    const buttons = await createButtons(userId);
                    
                    await interaction.message.edit({
                        embeds: [embed],
                        components: [buttons]
                    });
                } catch (error) {
                    await msg.react('❌');
                    await interaction.followUp({
                        content: '❌ فشل تحميل الصورة. تأكد من صحة الرابط.',
                        ephemeral: true
                    });
                }
            } else {
                await msg.react('❌');
                await interaction.followUp({
                    content: '❌ الرجاء إرسال رابط صورة صحيح أو إرفاق صورة.',
                    ephemeral: true
                });
            }
        });
        
        collector.on('end', (collected) => {
            if (collected.size === 0) {
                interaction.followUp({
                    content: '⏱️ انتهى الوقت. الرجاء المحاولة مرة أخرى.',
                    ephemeral: true
                });
            }
        });
        
        return;
    }
}

module.exports = { 
    name, 
    execute,
    handleInteraction,
    getCustomProfile,
    initDatabase
};
