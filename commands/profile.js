const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { getCustomProfile } = require('./myprofile.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const colorManager = require('../utils/colorManager.js');

const name = 'profile';
const aliases = ['id'];
const { getUserLevel, updateUserLevel, updateLastNotified } = require('../utils/database.js');

// دالة لإرسال إشعار الترقية
async function sendLevelUpNotification(client, userId, oldVoiceLevel, newVoiceLevel, oldChatLevel, newChatLevel, voiceXP, chatXP) {
    try {
        const user = await client.users.fetch(userId);
        if (!user) return;

        const embed = colorManager.createEmbed()
            .setTitle('Congratulations')
            .setDescription('**Level Up **')
            .setTimestamp();
        
        // استخدام رابط صورة بدلاً من إيموجي في التمبنيل لأن ديسكورد لا يدعم الإيموجي هناك
        embed.setThumbnail('https://cdn.discordapp.com/emojis/1434229731183694040.png?size=128');

        let changesText = '';
        let levelUpType = [];

        // فحص الفويس
        if (newVoiceLevel > oldVoiceLevel) {
            changesText += `**voice :**\n`;
            changesText += `*Your Level* :**${newVoiceLevel}**\n`;
            changesText += `*Your Xp* : **${voiceXP.toLocaleString()}**\n\n`;
            levelUpType.push('Voice');
        }

        // فحص الشات
        if (newChatLevel > oldChatLevel) {
            changesText += `**chat :**\n`;
            changesText += `*Your Level* **${newChatLevel}**\n`;
            changesText += `*Your Xp* : **${chatXP.toLocaleString()}**\n\n`;
            levelUpType.push('Chat');
        }

        if (levelUpType.length === 0) return;

        embed.addFields([
            { name: 'Changes', value: changesText, inline: false }
        ]);

        // حساب المتبقي للمستوى التالي
        let nextLevelInfo = '';

        if (levelUpType.includes('Voice')) {
            const voiceNextLevelXP = Math.floor(Math.pow(newVoiceLevel + 1, 2) * 100);
            const voiceNeeded = voiceNextLevelXP - voiceXP;
            const voiceMinutesNeeded = Math.ceil((voiceNeeded * 5) / 60); // 5 دقائق = 1 XP
            nextLevelInfo += ` **تحتاج الى **${voiceNeeded.toLocaleString()} Xp** (حوالي **${voiceMinutesNeeded} ساعة**) **للفل القادم**\n\n`;
        }

        if (levelUpType.includes('Chat')) {
            const chatNextLevelXP = Math.floor(Math.pow(newChatLevel + 1, 2) * 100);
            const chatNeeded = chatNextLevelXP - chatXP;
            const chatMessagesNeeded = chatNeeded * 10; // 10 رسائل = 1 XP
            nextLevelInfo += ` **تحتاج الى :** **${chatNeeded.toLocaleString()} Xp ** (حوالي **${chatMessagesNeeded.toLocaleString()} رسالة**) **للفل القادم**\n`;
        }

        if (nextLevelInfo) {
            embed.addFields([
                { name: 'To Next Level', value: nextLevelInfo, inline: false }
            ]);
        }

        embed.addFields([
            { name: 'Type', value: levelUpType.join(' , '), inline: true },
            { name: 'Date', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
        ]);

        embed.setFooter({ text: 'يمكنك تعديل بروفايلك من امر بروفايلي' });

        await user.send({ embeds: [embed] });
        console.log(`✅ تم إرسال إشعار الترقية للمستخدم ${user.username}`);
    } catch (error) {
        console.log(`❌ لا يمكن إرسال رسالة خاصة للمستخدم ${userId}:`, error.message);
    }
}

// Database paths
const mainDbPath = path.join(__dirname, '..', 'database', 'discord_bot.db');
const streakDbPath = path.join(__dirname, '..', 'database', 'streak.db');

// Helper function to get data from main database
function getMainDbData(userId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(mainDbPath);
        
        db.get(`SELECT total_messages, total_voice_time, total_reactions FROM user_totals WHERE user_id = ?`, 
            [userId], 
            (err, row) => {
                db.close();
                if (err) {
                    reject(err);
                } else {
                    let stats = row || { total_messages: 0, total_voice_time: 0, total_reactions: 0 };
                    
                    // حساب الوقت الحي إذا كان العضو في روم صوتي حالياً
                    if (global.client && global.client.voiceSessions && global.client.voiceSessions.has(userId)) {
                        const session = global.client.voiceSessions.get(userId);
                        if (session && !session.isAFK) {
                            const liveStart = session.lastTrackedTime || session.startTime || session.sessionStartTime;
                            const liveDuration = Date.now() - liveStart;
                            stats.total_voice_time = (stats.total_voice_time || 0) + Math.max(0, liveDuration);
                        }
                    }
                    
                    resolve(stats);
                }
            }
        );
    });
}

// Helper function to get streak data
function getStreakData(guildId, userId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(streakDbPath);
        
        db.get(`SELECT current_streak FROM streak_users WHERE guild_id = ? AND user_id = ?`, 
            [guildId, userId], 
            (err, row) => {
                db.close();
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.current_streak : 0);
                }
            }
        );
    });
}

// Helper function to get total rank (from user_totals - the real leaderboard)
function getTotalRank(userId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(mainDbPath);
        
        // Get voice rank from total voice time
        db.all(`
            SELECT user_id, total_voice_time as voice_time
            FROM user_totals 
            WHERE total_voice_time > 0
            ORDER BY total_voice_time DESC
        `, [], (err, voiceRows) => {
            if (err) {
                db.close();
                reject(err);
                return;
            }
            
            const voiceRank = voiceRows.findIndex(u => u.user_id === userId) + 1;
            
            // Get chat rank from total messages
            db.all(`
                SELECT user_id, total_messages as messages
                FROM user_totals 
                WHERE total_messages > 0
                ORDER BY total_messages DESC
            `, [], (err, chatRows) => {
                db.close();
                if (err) {
                    reject(err);
                } else {
                    const chatRank = chatRows.findIndex(u => u.user_id === userId) + 1;
                    resolve({ voiceRank, chatRank });
                }
            });
        });
    });
}

// Calculate level and XP from voice time
function calculateVoiceLevel(voiceTime) {
    const xp = Math.floor(voiceTime / 5); // 5 دقائق = 1 XP
    const level = Math.floor(Math.sqrt(xp / 100)); // الجذر التربيعي الصحيح
    const xpForCurrentLevel = level * level * 100;
    const xpForNextLevel = (level + 1) * (level + 1) * 100;
    const currentLevelXP = xp - xpForCurrentLevel;
    const neededXP = xpForNextLevel - xpForCurrentLevel;
    const progress = neededXP > 0 ? currentLevelXP / neededXP : 0;
    
    return { level, xp, progress };
}

// Calculate level and XP from messages
function calculateChatLevel(messages) {
    const xp = Math.floor(messages / 10);
    const level = Math.floor(Math.sqrt(xp / 100)); // الجذر التربيعي الصحيح
    const xpForCurrentLevel = level * level * 100;
    const xpForNextLevel = (level + 1) * (level + 1) * 100;
    const currentLevelXP = xp - xpForCurrentLevel;
    const neededXP = xpForNextLevel - xpForCurrentLevel;
    const progress = neededXP > 0 ? currentLevelXP / neededXP : 0;
    
    return { level, xp, progress };
}

// Format voice time
function formatVoiceTime(minutes) {
    // التأكد من أن القيمة رقمية وموجبة
    if (!minutes || minutes <= 0) return '0m';
    
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = Math.floor(minutes % 60);
    
    if (days > 0) {
        return `${days.toLocaleString()}d ${hours}h`;
    } else if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
}

// Format large numbers
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

// Draw rounded rectangle
function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

// Draw stat box with reduced glow
function drawStatBox(ctx, x, y, label, value) {
    ctx.save();
    
    // Softer outer shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    
    // Main box background with gradient
    roundRect(ctx, x, y, 140, 60, 12);
    const boxGradient = ctx.createLinearGradient(x, y, x, y + 60);
    boxGradient.addColorStop(0, 'rgba(45, 55, 80, 0.45)');
    boxGradient.addColorStop(0.5, 'rgba(30, 40, 60, 0.4)');
    boxGradient.addColorStop(1, 'rgba(20, 30, 50, 0.5)');
    ctx.fillStyle = boxGradient;
    ctx.fill();
    
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    
    // Top light reflection
    ctx.save();
    roundRect(ctx, x + 2, y + 2, 136, 18, 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fill();
    ctx.restore();
    
    // Inner shadow
    roundRect(ctx, x + 1, y + 1, 138, 58, 11);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Border
    roundRect(ctx, x, y, 140, 60, 12);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    ctx.restore();
    
    // Label text
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + 70, y + 24);
    ctx.restore();
    
    // Value text - SMALLER SIZE
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.font = 'bold 17px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(value, x + 70 + 1, y + 46 + 1);
    
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
    ctx.shadowBlur = 3;
    ctx.fillText(value, x + 70, y + 46);
    ctx.restore();
}

// Draw progress bar with reduced glow
function drawProgressBar(ctx, x, y, width, progress, colors) {
    const height = 20;
    const radius = 10;
    
    ctx.save();
    
    // Softer outer shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    
    // Background bar
    roundRect(ctx, x, y, width, height, radius);
    const bgGradient = ctx.createLinearGradient(x, y, x, y + height);
    bgGradient.addColorStop(0, 'rgba(15, 20, 35, 0.7)');
    bgGradient.addColorStop(1, 'rgba(25, 35, 55, 0.5)');
    ctx.fillStyle = bgGradient;
    ctx.fill();
    
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    
    // Inner shadow
    roundRect(ctx, x + 1, y + 1, width - 2, height - 2, radius - 1);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Progress fill
    if (progress > 0) {
        const fillWidth = Math.max(height, width * progress);
        
        ctx.save();
        ctx.shadowColor = colors[1];
        ctx.shadowBlur = 8;
        roundRect(ctx, x + 2, y + 2, fillWidth - 4, height - 4, radius - 2);
        
        // Gradient fill
        const progressGradient = ctx.createLinearGradient(x, y, x, y + height);
        progressGradient.addColorStop(0, colors[0]);
        progressGradient.addColorStop(0.5, colors[1]);
        progressGradient.addColorStop(1, colors[0]);
        ctx.fillStyle = progressGradient;
        ctx.fill();
        ctx.restore();
        
        // Top highlight
        ctx.save();
        roundRect(ctx, x + 3, y + 3, fillWidth - 6, (height - 6) / 2, radius - 3);
        const highlightGradient = ctx.createLinearGradient(x, y, x, y + height / 2);
        highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
        highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = highlightGradient;
        ctx.fill();
        ctx.restore();
        
        // Subtle glow
        ctx.shadowColor = colors[1];
        ctx.shadowBlur = 10;
        roundRect(ctx, x + 2, y + 2, fillWidth - 4, height - 4, radius - 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
    
    // Outer border
    ctx.shadowBlur = 0;
    roundRect(ctx, x, y, width, height, radius);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    ctx.restore();
}

// Draw 3D icon with depth and shadows
function drawIcon(ctx, x, y, type) {
    ctx.save();
    
    if (type === 'microphone') {
        // === 3D MICROPHONE ICON - SMALLER SIZE ===
        const micX = x + 10;
        const micY = y;
        
        // Deep shadow for 3D effect
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 5;
        
        // Main microphone body - rounded rectangle (smaller)
        ctx.fillStyle = '#FFFFFF';
        roundRect(ctx, micX + 6, micY + 1, 12, 16, 6);
        ctx.fill();
        ctx.restore();
        
        // Inner shadow on microphone body
        ctx.save();
        const micGradient = ctx.createLinearGradient(micX + 6, micY + 1, micX + 18, micY + 17);
        micGradient.addColorStop(0, '#FFFFFF');
        micGradient.addColorStop(0.5, '#F5F5F5');
        micGradient.addColorStop(1, '#E8E8E8');
        ctx.fillStyle = micGradient;
        roundRect(ctx, micX + 6, micY + 1, 12, 16, 6);
        ctx.fill();
        ctx.restore();
        
        // Highlight on microphone
        ctx.save();
        const highlightGradient = ctx.createLinearGradient(micX + 7, micY + 2, micX + 17, micY + 12);
        highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
        highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        roundRect(ctx, micX + 7, micY + 2, 10, 10, 5);
        ctx.fillStyle = highlightGradient;
        ctx.fill();
        ctx.restore();
        
        // Microphone arc holder with 3D effect (smaller)
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 3;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(micX + 2, micY + 12);
        ctx.quadraticCurveTo(micX + 2, micY + 24, micX + 12, micY + 24);
        ctx.quadraticCurveTo(micX + 22, micY + 24, micX + 22, micY + 12);
        ctx.stroke();
        ctx.restore();
        
        // Inner white stroke for arc
        ctx.save();
        ctx.strokeStyle = '#F8F8F8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(micX + 3, micY + 12);
        ctx.quadraticCurveTo(micX + 3, micY + 23, micX + 12, micY + 23);
        ctx.quadraticCurveTo(micX + 21, micY + 23, micX + 21, micY + 12);
        ctx.stroke();
        ctx.restore();
        
        // Microphone stand with 3D effect (smaller)
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 5;
        ctx.shadowOffsetY = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(micX + 12, micY + 24);
        ctx.lineTo(micX + 12, micY + 30);
        ctx.stroke();
        ctx.restore();
        
        // Stand base with gradient (smaller)
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 5;
        ctx.shadowOffsetY = 2;
        const baseGradient = ctx.createLinearGradient(micX + 6, micY + 29, micX + 18, micY + 32);
        baseGradient.addColorStop(0, '#FFFFFF');
        baseGradient.addColorStop(0.5, '#F5F5F5');
        baseGradient.addColorStop(1, '#FFFFFF');
        roundRect(ctx, micX + 6, micY + 29, 12, 3, 1.5);
        ctx.fillStyle = baseGradient;
        ctx.fill();
        ctx.restore();
        
        // Highlight on stand base
        ctx.save();
        roundRect(ctx, micX + 7, micY + 29.5, 10, 1.5, 0.75);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fill();
        ctx.restore();
        
        // Silver details on microphone body - like chat style
        const micDetailY = micY + 9;
        const micDetails = [
            { x: micX + 12, y: micDetailY - 3 },
            { x: micX + 12, y: micDetailY },
            { x: micX + 12, y: micDetailY + 3 }
        ];
        
        micDetails.forEach(detail => {
            // Detail shadow
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
            ctx.shadowBlur = 2;
            ctx.shadowOffsetY = 0.5;
            ctx.fillStyle = '#9CA3AF';
            ctx.beginPath();
            ctx.arc(detail.x, detail.y, 1.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            
            // Detail highlight - silver/gray color
            ctx.save();
            const detailGradient = ctx.createRadialGradient(detail.x - 0.3, detail.y - 0.3, 0, detail.x, detail.y, 1.5);
            detailGradient.addColorStop(0, '#C0C0C0');  // Silver
            detailGradient.addColorStop(0.5, '#A8A8A8');
            detailGradient.addColorStop(1, '#808080');
            ctx.fillStyle = detailGradient;
            ctx.beginPath();
            ctx.arc(detail.x, detail.y, 1.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
        
    } else if (type === 'chat') {
        // === 3D CHAT BUBBLE ICON ===
        const chatX = x + 2;
        const chatY = y;
        
        // Deep shadow for 3D effect
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 6;
        
        // Main chat bubble
        ctx.fillStyle = '#FFFFFF';
        roundRect(ctx, chatX + 2, chatY + 2, 28, 22, 6);
        ctx.fill();
        ctx.restore();
        
        // Inner gradient on chat bubble
        ctx.save();
        const bubbleGradient = ctx.createLinearGradient(chatX + 2, chatY + 2, chatX + 30, chatY + 24);
        bubbleGradient.addColorStop(0, '#FFFFFF');
        bubbleGradient.addColorStop(0.5, '#F5F5F5');
        bubbleGradient.addColorStop(1, '#E8E8E8');
        ctx.fillStyle = bubbleGradient;
        roundRect(ctx, chatX + 2, chatY + 2, 28, 22, 6);
        ctx.fill();
        ctx.restore();
        
        // Highlight on bubble
        ctx.save();
        const bubbleHighlight = ctx.createLinearGradient(chatX + 4, chatY + 4, chatX + 28, chatY + 16);
        bubbleHighlight.addColorStop(0, 'rgba(255, 255, 255, 0.6)');
        bubbleHighlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
        roundRect(ctx, chatX + 4, chatY + 4, 24, 14, 5);
        ctx.fillStyle = bubbleHighlight;
        ctx.fill();
        ctx.restore();
        
        // Chat tail with 3D shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 4;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(chatX + 8, chatY + 24);
        ctx.lineTo(chatX + 6, chatY + 32);
        ctx.lineTo(chatX + 14, chatY + 24);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        
        // Gradient on tail
        ctx.save();
        const tailGradient = ctx.createLinearGradient(chatX + 6, chatY + 24, chatX + 10, chatY + 32);
        tailGradient.addColorStop(0, '#F5F5F5');
        tailGradient.addColorStop(1, '#E0E0E0');
        ctx.fillStyle = tailGradient;
        ctx.beginPath();
        ctx.moveTo(chatX + 8, chatY + 24);
        ctx.lineTo(chatX + 6, chatY + 32);
        ctx.lineTo(chatX + 14, chatY + 24);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        
        // Chat dots inside bubble - silver color for visibility
        const dotY = chatY + 13;
        const dots = [
            { x: chatX + 10, y: dotY },
            { x: chatX + 16, y: dotY },
            { x: chatX + 22, y: dotY }
        ];
        
        dots.forEach(dot => {
            // Dot shadow
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
            ctx.shadowBlur = 3;
            ctx.shadowOffsetY = 1;
            ctx.fillStyle = '#9CA3AF';
            ctx.beginPath();
            ctx.arc(dot.x, dot.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            
            // Dot highlight - silver/gray color
            ctx.save();
            const dotGradient = ctx.createRadialGradient(dot.x - 0.5, dot.y - 0.5, 0, dot.x, dot.y, 2.5);
            dotGradient.addColorStop(0, '#C0C0C0');  // Silver
            dotGradient.addColorStop(0.5, '#A8A8A8');
            dotGradient.addColorStop(1, '#808080');
            ctx.fillStyle = dotGradient;
            ctx.beginPath();
            ctx.arc(dot.x, dot.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }
    
    ctx.restore();
}

async function execute(message, args, { client }) {
    try {
        if (isChannelBlocked(message.channel.id)) {
            return;
        }

        // فحص البلوك
        if (isUserBlocked(message.author.id)) {
            const blockedEmbed = colorManager.createEmbed()
                .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
                .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

            await message.channel.send({ embeds: [blockedEmbed] });
            return;
        }

        // دعم المنشن أو الآي دي
        let targetUser = message.mentions.users.first();
        
        // إذا لم يكن هناك منشن، تحقق من الآي دي
        if (!targetUser && args[0]) {
            const userId = args[0].replace(/[<@!>]/g, ''); // إزالة أي رموز
            try {
                targetUser = await client.users.fetch(userId);
            } catch (error) {
                // إذا فشل جلب المستخدم، استخدم صاحب الرسالة
                targetUser = message.author;
            }
        }
        
        // إذا لم يتم تحديد مستخدم، استخدم صاحب الرسالة
        if (!targetUser) {
            targetUser = message.author;
        }
        
        const userId = targetUser.id;
        const guildId = message.guild.id;

        // تهيئة قاعدة البيانات المخصصة قبل الاستخدام
        const { initDatabase } = require('./myprofile.js');
        await initDatabase();
        // Fetch data from both databases and custom profile
        const [mainData, streak, totalRank, customProfile] = await Promise.all([
            getMainDbData(userId),
            getStreakData(guildId, userId),
            getTotalRank(userId),
            getCustomProfile(userId)
        ]);
        
        const { total_messages, total_voice_time, total_reactions } = mainData;
        
        // تحويل وقت الفويس من ملي ثانية إلى دقائق
        const voiceTimeInMinutes = Math.floor(total_voice_time / 60000);
        
        // Calculate levels
        const voiceLevel = calculateVoiceLevel(voiceTimeInMinutes);
        const chatLevel = calculateChatLevel(total_messages);
        
        const { voiceRank, chatRank } = totalRank;
        
        // Create canvas
        const canvas = createCanvas(1000, 380);
        const ctx = canvas.getContext('2d');
        
        // Use a simpler approach for loading images to prevent hanging
        const loadImg = async (url) => {
            try {
                if (url.startsWith('/data/')) {
                    const localPath = path.join(__dirname, '..', url);
                    if (fs.existsSync(localPath)) {
                        return await loadImage(localPath);
                    }
                }
                const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
                return await loadImage(Buffer.from(response.data));
            } catch (err) {
                console.error(`Failed to load image from ${url}:`, err.message);
                return null;
            }
        };

        // === ENHANCED 3D BACKGROUND ===
        let backgroundDrawn = false;
        if (customProfile && customProfile.banner_url && customProfile.banner_url.trim() !== '') {
            const bannerImage = await loadImg(customProfile.banner_url);
            if (bannerImage) {
                ctx.drawImage(bannerImage, 0, 0, 1000, 380);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.fillRect(0, 0, 1000, 380);
                backgroundDrawn = true;
            }
        }

        if (!backgroundDrawn) {
            const bgGradient = ctx.createLinearGradient(0, 0, 1000, 380);
            bgGradient.addColorStop(0, '#0f1525');
            bgGradient.addColorStop(0.3, '#1a1f3a');
            bgGradient.addColorStop(0.6, '#2d3561');
            bgGradient.addColorStop(1, '#1e2442');
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, 1000, 380);
        }
        
        // Radial gradient overlay for depth (always applied)
        const radialBg = ctx.createRadialGradient(500, 190, 50, 500, 190, 500);
        radialBg.addColorStop(0, 'rgba(60, 80, 120, 0.15)');
        radialBg.addColorStop(1, 'rgba(0, 0, 0, 0.3)');
        ctx.fillStyle = radialBg;
        ctx.fillRect(0, 0, 1000, 380);
        
        // Subtle decorative circles - reduced glow
        const circles = [
            { x: 150, y: 80, r: 120, opacity: 0.04, color: '100, 150, 255' },
            { x: 850, y: 280, r: 140, opacity: 0.05, color: '150, 100, 255' },
            { x: 500, y: 190, r: 180, opacity: 0.03, color: '120, 140, 255' },
            { x: 80, y: 300, r: 90, opacity: 0.025, color: '80, 120, 200' },
            { x: 920, y: 100, r: 100, opacity: 0.035, color: '180, 120, 255' }
        ];
        
        circles.forEach(circle => {
            // Outer glow
            const outerGlow = ctx.createRadialGradient(circle.x, circle.y, 0, circle.x, circle.y, circle.r * 1.3);
            outerGlow.addColorStop(0, `rgba(${circle.color}, ${circle.opacity * 0.5})`);
            outerGlow.addColorStop(0.5, `rgba(${circle.color}, ${circle.opacity * 0.2})`);
            outerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = outerGlow;
            ctx.beginPath();
            ctx.arc(circle.x, circle.y, circle.r * 1.3, 0, Math.PI * 2);
            ctx.fill();
            
            // Inner circle
            const gradient = ctx.createRadialGradient(circle.x, circle.y, 0, circle.x, circle.y, circle.r);
            gradient.addColorStop(0, `rgba(${circle.color}, ${circle.opacity})`);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
            ctx.fill();
        });
        
        // Cut corner effect with 3D shadow (top right)
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetX = -5;
        ctx.shadowOffsetY = 5;
        
        ctx.fillStyle = '#0a0e1a';
        ctx.beginPath();
        ctx.moveTo(1000, 0);
        ctx.lineTo(1000, 130);
        ctx.quadraticCurveTo(940, 90, 870, 0);
        ctx.closePath();
        ctx.fill();
        
        // Inner gradient for depth
        const cutGradient = ctx.createLinearGradient(900, 0, 1000, 100);
        cutGradient.addColorStop(0, 'rgba(20, 30, 50, 0.6)');
        cutGradient.addColorStop(1, 'rgba(10, 14, 26, 1)');
        ctx.shadowBlur = 0;
        ctx.fillStyle = cutGradient;
        ctx.fill();
        ctx.restore();
        
        // === STAT BOXES (LEFT SIDE) ===
        const leftX = 30;
        drawStatBox(ctx, leftX, 30, 'streak', formatNumber(streak));
        drawStatBox(ctx, leftX, 105, 'messages', formatNumber(total_messages));
        drawStatBox(ctx, leftX, 180, 'voice time', formatVoiceTime(voiceTimeInMinutes));
        drawStatBox(ctx, leftX, 255, 'reactions', formatNumber(total_reactions));
        
        // === PROFILE PICTURE (CENTER) - Reduced Glow ===
        try {
            // Use custom avatar if exists, otherwise use Discord avatar
            let avatarURL = targetUser.displayAvatarURL({ extension: 'png', size: 256 });
            if (customProfile && customProfile.avatar_url && customProfile.avatar_url.trim() !== '') {
                avatarURL = customProfile.avatar_url;
            }
            
            const avatarImage = await loadImg(avatarURL) || await loadImg(targetUser.displayAvatarURL({ extension: 'png', size: 256 }));
            
            if (!avatarImage) throw new Error("Could not load any avatar");

            const avatarSize = 180;
            const avatarX = 260;
            const avatarY = 100;
            const centerX = avatarX + avatarSize / 2;
            const centerY = avatarY + avatarSize / 2;
            
            // Softer shadow
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
            ctx.shadowBlur = 18;
            ctx.shadowOffsetY = 6;
            ctx.beginPath();
            ctx.arc(centerX, centerY, avatarSize / 2 + 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
            ctx.fill();
            ctx.restore();
            
            // Subtle glow ring
            ctx.save();
            ctx.shadowColor = 'rgba(100, 150, 255, 0.3)';
            ctx.shadowBlur = 12;
            const outerRing = ctx.createRadialGradient(centerX, centerY, avatarSize / 2 + 4, centerX, centerY, avatarSize / 2 + 8);
            outerRing.addColorStop(0, 'rgba(100, 150, 255, 0.25)');
            outerRing.addColorStop(0.5, 'rgba(150, 100, 255, 0.15)');
            outerRing.addColorStop(1, 'rgba(100, 150, 255, 0.05)');
            ctx.beginPath();
            ctx.arc(centerX, centerY, avatarSize / 2 + 8, 0, Math.PI * 2);
            ctx.fillStyle = outerRing;
            ctx.fill();
            ctx.restore();
            
            // White border
            const borderGradient = ctx.createLinearGradient(centerX, avatarY, centerX, avatarY + avatarSize);
            borderGradient.addColorStop(0, '#FFFFFF');
            borderGradient.addColorStop(0.5, '#F5F5F5');
            borderGradient.addColorStop(1, '#EEEEEE');
            ctx.beginPath();
            ctx.arc(centerX, centerY, avatarSize / 2 + 5, 0, Math.PI * 2);
            ctx.fillStyle = borderGradient;
            ctx.fill();
            
            // Inner shadow
            ctx.save();
            ctx.beginPath();
            ctx.arc(centerX, centerY, avatarSize / 2 + 4, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
            
            // Avatar clip and draw
            ctx.save();
            ctx.beginPath();
            ctx.arc(centerX, centerY, avatarSize / 2, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(avatarImage, avatarX, avatarY, avatarSize, avatarSize);
            ctx.restore();
            
            // Subtle light reflection
            ctx.save();
            ctx.beginPath();
            ctx.arc(centerX, centerY - 10, avatarSize / 2, 0, Math.PI * 2);
            ctx.clip();
            const reflection = ctx.createLinearGradient(centerX, avatarY, centerX, avatarY + avatarSize / 2);
            reflection.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
            reflection.addColorStop(0.5, 'rgba(255, 255, 255, 0.05)');
            reflection.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = reflection;
            ctx.fillRect(avatarX - 10, avatarY - 10, avatarSize + 20, avatarSize / 2);
            ctx.restore();
            
        } catch (error) {
            console.error('Error loading avatar:', error);
            // Draw default circle
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(350, 190, 75, 0, Math.PI * 2);
            const defaultGradient = ctx.createRadialGradient(350, 190, 0, 350, 190, 75);
            defaultGradient.addColorStop(0, '#6a7598');
            defaultGradient.addColorStop(1, '#4a5578');
            ctx.fillStyle = defaultGradient;
            ctx.fill();
            ctx.restore();
        }
        
        // === NICKNAME ===
        ctx.textAlign = 'center';
        const displayName = targetUser.displayName || targetUser.globalName || targetUser.username;
        const nickname = displayName.length > 15 ? displayName.substring(0, 15) + '...' : displayName;
        
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.font = 'bold 18px Arial';
        ctx.fillText(nickname, 351, 318);
        
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.4)';
        ctx.shadowBlur = 5;
        ctx.fillText(nickname, 350, 317);
        ctx.restore();
        
        // === VOICE LEVEL (RIGHT SIDE) ===
        const rightX = 480;
        const iconX = rightX + 25;
        
        // Draw microphone icon - positioned slightly above
        drawIcon(ctx, iconX, 90, 'microphone');
        
        // Voice level text - aligned with icon
        ctx.save();
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.font = 'bold 17px Arial';
        ctx.fillText(`Lvl : ${voiceLevel.level}`, iconX + 51, 82);
        
        ctx.fillStyle = '#E8E8E8';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Lvl : ${voiceLevel.level}`, iconX + 50, 81);
        ctx.restore();
        
        // Voice progress bar - better spacing
        drawProgressBar(ctx, iconX + 50, 98, 380, voiceLevel.progress, ['#667eea', '#764ba2']);
        
        // XP text - aligned under progress bar
        ctx.save();
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.font = 'bold 17px Arial';
        ctx.fillText(`Xp : ${formatNumber(voiceLevel.xp)}`, iconX + 51, 146);
        
        ctx.fillStyle = '#E8E8E8';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Xp : ${formatNumber(voiceLevel.xp)}`, iconX + 50, 145);
        ctx.restore();
        
        // Rank text - aligned at the end
        ctx.save();
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.font = 'bold 17px Arial';
        ctx.fillText(`Rank : #${voiceRank || 'N/A'}`, iconX + 426, 146);
        
        ctx.fillStyle = '#E8E8E8';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Rank : #${voiceRank || 'N/A'}`, iconX + 425, 145);
        ctx.restore();
        
        // === CHAT LEVEL (RIGHT SIDE) ===
        // Draw chat icon - aligned with progress bar level
        drawIcon(ctx, iconX, 228, 'chat');
        
        // Chat level text - aligned with icon
        ctx.save();
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.font = 'bold 17px Arial';
        ctx.fillText(`Lvl : ${chatLevel.level}`, iconX + 51, 222);
        
        ctx.fillStyle = '#E8E8E8';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Lvl : ${chatLevel.level}`, iconX + 50, 221);
        ctx.restore();
        
        // Chat progress bar - better spacing
        drawProgressBar(ctx, iconX + 50, 238, 380, chatLevel.progress, ['#f093fb', '#f5576c']);
        
        // XP text - aligned under progress bar
        ctx.save();
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.font = 'bold 17px Arial';
        ctx.fillText(`Xp : ${formatNumber(chatLevel.xp)}`, iconX + 51, 286);
        
        ctx.fillStyle = '#E8E8E8';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Xp : ${formatNumber(chatLevel.xp)}`, iconX + 50, 285);
        ctx.restore();
        
        // Rank text - aligned at the end
        ctx.save();
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.font = 'bold 17px Arial';
        ctx.fillText(`Rank : #${chatRank || 'N/A'}`, iconX + 426, 286);
        
        ctx.fillStyle = '#E8E8E8';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.shadowBlur = 3;
        ctx.fillText(`Rank : #${chatRank || 'N/A'}`, iconX + 425, 285);
        ctx.restore();
        
        // Send the image
        const buffer = canvas.toBuffer('image/png');
        await message.channel.send({
            files: [{
                attachment: buffer,
                name: 'profile.png'
            }]
        });
        
    } catch (error) {
        console.error('Error in profile command:', error);
        await message.channel.send('❌ An error occurred while generating the profile.');
    }
}

module.exports = { 
    name,
    aliases,
    execute,
    sendLevelUpNotification
};
