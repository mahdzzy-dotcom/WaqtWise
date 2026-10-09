'use strict';

// Copies the Plus Jakarta Sans web-font files (SIL Open Font License) from the npm package
// "@fontsource/plus-jakarta-sans" into src/renderer/fonts, so the app ships them and works offline
// (the window's security policy blocks fonts from the internet).
// Runs automatically after "npm install". If the package is missing the app still works:
// styles.css falls back to the Windows system font.

const fs = require('fs');
const path = require('path');

const WEIGHTS = [400, 500, 600, 700, 800];
const SUBSETS = ['latin', 'latin-ext'];

function main() {
  const pkgDir = path.join(__dirname, '..', 'node_modules', '@fontsource', 'plus-jakarta-sans');
  const outDir = path.join(__dirname, '..', 'src', 'renderer', 'fonts');
  if (!fs.existsSync(pkgDir)) {
    console.warn('copy-fonts: @fontsource/plus-jakarta-sans is not installed; the app will use the system font.');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  let copied = 0;
  for (const subset of SUBSETS) {
    for (const weight of WEIGHTS) {
      const from = path.join(pkgDir, 'files', `plus-jakarta-sans-${subset}-${weight}-normal.woff2`);
      const to = path.join(outDir, `PlusJakartaSans-${subset}-${weight}.woff2`);
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, to);
        copied += 1;
      } else {
        console.warn(`copy-fonts: missing ${path.basename(from)}`);
      }
    }
  }
  const license = path.join(pkgDir, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(outDir, 'LICENSE-PlusJakartaSans.txt'));
  console.log(`copy-fonts: ${copied} font file(s) ready in src/renderer/fonts`);
}

main();
