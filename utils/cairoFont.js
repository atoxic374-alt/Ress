const fs = require('fs');
const path = require('path');
const { registerFont } = require('canvas');

let cairoFontsRegistered = false;

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const PERSISTENT_FONTS_DIR = path.join(__dirname, '..', 'data', 'fonts');

// All Cairo weights shipped with the project
const CAIRO_WEIGHTS = [
  { file: 'Cairo-ExtraLight.ttf', weight: '200' },
  { file: 'Cairo-Light.ttf',      weight: '300' },
  { file: 'Cairo-Regular.ttf',    weight: 'normal' },
  { file: 'Cairo-Medium.ttf',     weight: '500' },
  { file: 'Cairo-SemiBold.ttf',   weight: '600' },
  { file: 'Cairo-Bold.ttf',       weight: 'bold' },
  { file: 'Cairo-ExtraBold.ttf',  weight: '800' },
  { file: 'Cairo-Black.ttf',      weight: '900' },
];

function getCairoFontStatus() {
  const results = CAIRO_WEIGHTS.map(w => ({
    weight: w.weight,
    path: path.join(FONTS_DIR, w.file),
    exists: fs.existsSync(path.join(FONTS_DIR, w.file))
  }));
  const ready = results.every(r => r.exists);
  return {
    fontsDir: FONTS_DIR,
    persistentFontsDir: PERSISTENT_FONTS_DIR,
    weights: results,
    // legacy compat
    regularPath: path.join(FONTS_DIR, 'Cairo-Regular.ttf'),
    boldPath:    path.join(FONTS_DIR, 'Cairo-Bold.ttf'),
    hasRegular:  fs.existsSync(path.join(FONTS_DIR, 'Cairo-Regular.ttf')),
    hasBold:     fs.existsSync(path.join(FONTS_DIR, 'Cairo-Bold.ttf')),
    ready,
    registered: cairoFontsRegistered
  };
}

function restorePersistedFonts() {
  try {
    if (!fs.existsSync(PERSISTENT_FONTS_DIR)) return;
    fs.mkdirSync(FONTS_DIR, { recursive: true });
    for (const { file } of CAIRO_WEIGHTS) {
      const persistedPath = path.join(PERSISTENT_FONTS_DIR, file);
      const targetPath = path.join(FONTS_DIR, file);
      if (fs.existsSync(persistedPath)) {
        fs.copyFileSync(persistedPath, targetPath);
      }
    }
  } catch (error) {
    console.error('❌ Failed to restore persisted Cairo fonts:', error.message);
  }
}

function ensureCairoFontsRegistered(options = {}) {
  const force = Boolean(options.force);
  if (cairoFontsRegistered && !force) return;
  restorePersistedFonts();

  let registered = 0;
  let warned = false;

  for (const { file, weight } of CAIRO_WEIGHTS) {
    const filePath = path.join(FONTS_DIR, file);
    if (fs.existsSync(filePath)) {
      try {
        registerFont(filePath, { family: 'Cairo', weight });
        registered++;
      } catch (err) {
        console.error(`❌ Failed to register Cairo ${weight}:`, err.message);
      }
    } else if (!warned) {
      warned = true;
      // Fallback: register DejaVu under Cairo name so canvas doesn't crash
      const fallbackRegular = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
      const fallbackBold    = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      if (fs.existsSync(fallbackRegular)) registerFont(fallbackRegular, { family: 'Cairo', weight: 'normal' });
      if (fs.existsSync(fallbackBold))    registerFont(fallbackBold,    { family: 'Cairo', weight: 'bold' });
      console.warn(`⚠️ Cairo TTF not found in assets/fonts (missing: ${file}). DejaVu fallback loaded.`);
    }
  }

  if (registered > 0) {
    console.log(`✅ Cairo font registered (${registered}/${CAIRO_WEIGHTS.length} weights) from assets/fonts`);
  }

  cairoFontsRegistered = true;
}

module.exports = {
  ensureCairoFontsRegistered,
  getCairoFontStatus
};
