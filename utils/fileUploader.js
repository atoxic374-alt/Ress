const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

class FileUploader {
  constructor() {
    this.maxDiscordFileSize = 25 * 1024 * 1024;
  }

  async uploadFile(filePath, autoDelete = false) {
    const fileStats = fs.statSync(filePath);
    const fileSizeInBytes = fileStats.size;

    console.log(`📁 حجم الملف: ${(fileSizeInBytes / 1024 / 1024).toFixed(2)} MB`);

    if (fileSizeInBytes <= this.maxDiscordFileSize) {
      return {
        type: 'local',
        path: filePath,
        size: fileSizeInBytes,
        autoDelete: autoDelete
      };
    }

    console.log('📤 الملف كبير جداً، سيتم رفعه إلى خدمة خارجية...');
    
    const uploadResult = await this.uploadToPixelDrain(filePath, fileSizeInBytes);
    
    // حذف الملف المحلي فوراً بعد الرفع الناجح للملفات الكبيرة
    if (autoDelete && uploadResult.type === 'external') {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑️ تم حذف الملف المحلي تلقائياً: ${filePath}`);
      } catch (deleteError) {
        console.error(`⚠️ فشل حذف الملف: ${deleteError.message}`);
      }
    }
    
    return uploadResult;
  }

  async uploadToPixelDrain(filePath, fileSize) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));

      const response = await axios.post('https://pixeldrain.com/api/file', form, {
        headers: {
          ...form.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const fileId = response.data.id;
      const downloadUrl = `https://pixeldrain.com/api/file/${fileId}`;

      console.log(`✅ تم رفع الملف إلى PixelDrain: ${downloadUrl}`);

      return {
        type: 'external',
        url: downloadUrl,
        service: 'pixeldrain',
        fileId: fileId,
        size: fileSize
      };
    } catch (error) {
      console.error('❌ فشل الرفع إلى PixelDrain:', error.message);
      
      return await this.uploadToFileIo(filePath, fileSize);
    }
  }

  async uploadToFileIo(filePath, fileSize) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));

      const response = await axios.post('https://file.io', form, {
        headers: {
          ...form.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      if (response.data.success) {
        const downloadUrl = response.data.link;

        console.log(`✅ تم رفع الملف إلى File.io: ${downloadUrl}`);
        console.log(`⚠️ تحذير: الرابط يعمل لمرة واحدة فقط!`);

        return {
          type: 'external',
          url: downloadUrl,
          service: 'file.io',
          size: fileSize,
          warning: '⚠️ **تحذير مهم:** هذا الرابط يعمل لمرة واحدة فقط! بعد التحميل الأول سيتم حذف الملف نهائياً.',
          warningEmoji: '⚠️'
        };
      } else {
        throw new Error('File.io upload failed');
      }
    } catch (error) {
      console.error('❌ فشل الرفع إلى File.io:', error.message);
      throw new Error('فشل رفع الملف إلى جميع الخدمات المتاحة');
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  // حذف ملف محلي بأمان بعد فترة زمنية (للتأكد من اكتمال الإرسال)
  scheduleFileDeletion(filePath, delayMinutes = 5) {
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ تم حذف الملف المجدول: ${filePath}`);
        }
      } catch (error) {
        console.error(`❌ فشل حذف الملف المجدول: ${error.message}`);
      }
    }, delayMinutes * 60 * 1000);
  }
}

module.exports = new FileUploader();
