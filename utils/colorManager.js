const { EmbedBuilder } = require('discord.js');

class ColorManager {
    constructor() {
        this.currentColor = '#0099ff'; // اللون الافتراضي
        this.client = null;
    }

    // تهيئة النظام مع client
    initialize(client) {
        this.client = client;
        this.updateColorFromAvatar();
    }

    // استخراج اللون من أفتار البوت
    async updateColorFromAvatar() {
        if (!this.client || !this.client.user) {
            console.log('⚠️ العميل أو المستخدم غير متاح بعد');
            return;
        }

        try {
            const avatarUrl = this.client.user.displayAvatarURL({ format: 'png', size: 128 });
            console.log('🔗 رابط الأفتار:', avatarUrl);

            // استخدام مكتبة لاستخراج اللون السائد من الصورة
            const dominantColor = await this.extractDominantColor(avatarUrl);
            this.currentColor = dominantColor;

            console.log(`🎨 تم تحديث لون الـ embeds إلى: ${this.currentColor}`);
        } catch (error) {
            console.error('❌ خطأ في استخراج لون الأفتار:', error);
            // استخدام لون افتراضي في حالة الخطأ
            this.currentColor = '#0099ff';
            console.log(`🎨 تم استخدام اللون الافتراضي: ${this.currentColor}`);
        }
    }

    // استخراج اللون السائد من رابط الصورة
    async extractDominantColor(imageUrl) {
        try {
            console.log('🔍 محاولة استخراج اللون من:', imageUrl);

            // التحقق من وجود المكتبات المطلوبة
            let sharp, fetch;
            try {
                sharp = require('sharp');
                // استيراد node-fetch بطريقة ES modules
                const { default: nodeFetch } = await import('node-fetch');
                fetch = nodeFetch;
            } catch (requireError) {
                console.error('❌ مكتبات مطلوبة غير موجودة:', requireError.message);
                throw new Error('Missing required packages');
            }

            const response = await fetch(imageUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // استخراج اللون السائد باستخدام sharp
            const { data, info } = await sharp(buffer)
                .resize(1, 1)
                .raw()
                .toBuffer({ resolveWithObject: true });

            const [r, g, b] = data;
            const extractedColor = this.rgbToHex(r, g, b);

            console.log(`✅ تم استخراج اللون بنجاح: ${extractedColor} من RGB(${r}, ${g}, ${b})`);
            return extractedColor;

        } catch (error) {
            console.error('❌ فشل في استخراج اللون من الأفتار:', error.message);

            // في حالة فشل استخراج اللون، نستخدم ألوان افتراضية جميلة
            const defaultColors = [
                '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
                '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
            ];
            const fallbackColor = defaultColors[Math.floor(Math.random() * defaultColors.length)];
            console.log(`🎨 استخدام لون احتياطي: ${fallbackColor}`);
            return fallbackColor;
        }
    }

    // تحويل RGB إلى HEX
    rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    // الحصول على اللون الحالي
    getCurrentColor() {
        return this.currentColor;
    }

    // إنشاء embed بلون تلقائي
    createEmbed() {
        return new EmbedBuilder().setColor(this.currentColor);
    }

    // تحديث لون embed موجود
    updateEmbedColor(embed) {
        if (embed instanceof EmbedBuilder) {
            embed.setColor(this.currentColor);
        }
        return embed;
    }

    // تحديث اللون يدوياً (يُستخدم عند تغيير الأفتار)
    async forceUpdateColor() {
        await this.updateColorFromAvatar();
        console.log(`🔄 تم تحديث لون جميع الـ embeds إلى: ${this.currentColor}`);
    }

    // إضافة دالة getColor المفقودة
    getColor() {
        return this.currentColor;
    }
}

// إنشاء instance واحد للاستخدام في جميع أنحاء التطبيق
const colorManager = new ColorManager();

module.exports = colorManager;

// إنشاء instance واحد للاستخدام في جميع أنحاء التطبيق