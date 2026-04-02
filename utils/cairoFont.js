const fs = require('fs');
const path = require('path');
const { registerFont } = require('canvas');

let cairoFontsRegistered = false;
let cairoFontNoticeShown = false;

function ensureCairoFontsRegistered() {
  if (cairoFontsRegistered) return;

  const customRegular = path.join(__dirname, '..', 'assets', 'fonts', 'Cairo-Regular.ttf');
  const customBold = path.join(__dirname, '..', 'assets', 'fonts', 'Cairo-Bold.ttf');
  const regularPath = fs.existsSync(customRegular) ? customRegular : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const boldPath = fs.existsSync(customBold) ? customBold : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  try {
    if (fs.existsSync(regularPath)) registerFont(regularPath, { family: 'Cairo', weight: 'normal' });
    if (fs.existsSync(boldPath)) registerFont(boldPath, { family: 'Cairo', weight: 'bold' });
    cairoFontsRegistered = true;

    if (!cairoFontNoticeShown && (!fs.existsSync(customRegular) || !fs.existsSync(customBold))) {
      cairoFontNoticeShown = true;
      console.warn('⚠️ Cairo TTF not found in assets/fonts. Using DejaVu fallback. Place Cairo-Regular.ttf and Cairo-Bold.ttf in assets/fonts for true Cairo.');
    }
  } catch (error) {
    console.error('❌ Failed to register Cairo fonts:', error);
  }
}

module.exports = {
  ensureCairoFontsRegistered
};
