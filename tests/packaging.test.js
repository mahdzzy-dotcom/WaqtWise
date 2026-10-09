'use strict';

// Checks that the installer settings and the files they refer to are consistent, so that most
// packaging mistakes are caught here instead of in a failed build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { PROTOCOL, APP_ID } = require('../src/main/toast');

function listFiles(dir, extension) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, extension));
    else if (full.endsWith(extension)) out.push(full);
  }
  return out;
}

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.slice(1, 4).toString('ascii'), 'PNG', `${file} is a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('package.json: entry point, scripts and the three kinds of dependency', () => {
  assert.equal(pkg.productName, 'WaqtWise');
  assert.ok(fs.existsSync(path.join(root, pkg.main)), 'the main file exists');
  assert.equal(pkg.scripts.dist, 'electron-builder --win --publish never');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.ok(pkg.dependencies.adhan, 'the prayer library is a normal dependency (it ships inside the app)');
  assert.ok(pkg.devDependencies.electron && pkg.devDependencies['electron-builder']);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('installer settings: a normal wizard, installed for the current user only, with shortcuts', () => {
  const b = pkg.build;
  assert.equal(b.appId, APP_ID);
  assert.deepEqual(b.win.target.map((t) => t.target), ['nsis']);
  assert.equal(b.nsis.oneClick, false, 'Next -> Install -> Finish wizard');
  assert.equal(b.nsis.perMachine, false, 'no administrator rights needed');
  assert.equal(b.nsis.createStartMenuShortcut, true);
  assert.equal(b.nsis.createDesktopShortcut, true);
  assert.equal(b.nsis.allowToChangeInstallationDirectory, true);
  assert.match(b.nsis.artifactName, /\.exe$/);
  assert.ok(fs.existsSync(path.join(root, b.nsis.include)), 'the custom uninstall script exists');
  assert.ok(b.files.includes('src/**/*'));
});

test('the link name that notification buttons use is registered by the installer', () => {
  assert.deepEqual(pkg.build.protocols[0].schemes, [PROTOCOL]);
});

test('icons exist and are big enough for Windows', () => {
  // The Windows icon is a real .ico that holds 256, 128, 64, 48, 32, 24 and 16 pixel versions.
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  const ico = fs.readFileSync(path.join(root, pkg.build.win.icon));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'is an icon file');
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) sizes.push(ico[6 + i * 16] || 256);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
  for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) {
    assert.equal(pkg.build.nsis[key], 'build/icon.ico', key);
  }
  const png = pngSize(path.join(root, 'build/icon.png'));
  assert.ok(png.width >= 256 && png.height >= 256 && png.width === png.height, `${png.width}x${png.height}`);
  assert.ok(fs.existsSync(path.join(root, 'src/main/icon.ico')), 'the icon used by the window ships inside the app');
  const tray = pngSize(path.join(root, 'src/main/tray-icon.png'));
  assert.deepEqual(tray, { width: 16, height: 16 });
  assert.equal(pngSize(path.join(root, 'src/main/tray-icon@2x.png')).width, 32);
});

test('uninstaller asks whether to keep or delete the data, but never during an update or a silent uninstall', () => {
  const script = fs.readFileSync(path.join(root, pkg.build.nsis.include), 'utf8');
  assert.ok(script.includes('!macro customUnInstall'));
  assert.ok(script.includes('${ifNot} ${isUpdated}'));
  assert.ok(script.includes('IfSilent'));
  assert.ok(script.includes('MB_YESNO'));
  // The data folder is named after the product name (Electron's default for the user data folder)
  assert.ok(script.includes(`$APPDATA\\${pkg.productName}`));
  assert.ok(script.indexOf('MessageBox') < script.indexOf('RMDir'), 'asks before deleting');
});

test('everything the app loads while running is inside src/ or an installed dependency', () => {
  const allowed = new Set([...builtinModules, 'electron', 'adhan']);
  const files = listFiles(path.join(root, 'src'), '.js');
  assert.ok(files.length >= 15);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/require\('([^']+)'\)/g)) {
      const request = match[1];
      if (request.startsWith('.')) {
        const target = path.resolve(path.dirname(file), request);
        const resolved = [target, `${target}.js`, path.join(target, 'index.js')].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        assert.ok(resolved, `${path.relative(root, file)} requires ${request}, which does not exist`);
        assert.ok(resolved.startsWith(path.join(root, 'src')), `${request} is outside src/ and would not be packaged`);
      } else {
        assert.ok(allowed.has(request.replace(/^node:/, '')), `${path.relative(root, file)} uses "${request}", which is not a declared dependency`);
      }
    }
  }
});

test('the window page: every file it refers to exists; no inline scripts or styles (security policy)', () => {
  const dir = path.join(root, 'src/renderer');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(html.includes("script-src 'self'"));
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(dir, ref)), `index.html refers to ${ref}`);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\sstyle="/i.test(html), 'no inline style attributes');
  assert.ok(!/\son\w+="/i.test(html), 'no inline event handlers');
});

test('the full-screen reminder page: its files exist, same security rules, and its preload ships inside the app', () => {
  const dir = path.join(root, 'src/renderer');
  const html = fs.readFileSync(path.join(dir, 'alert.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(html.includes("script-src 'self'"));
  for (const ref of [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1])) {
    assert.ok(fs.existsSync(path.join(dir, ref)), `alert.html refers to ${ref}`);
  }
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\sstyle="/i.test(html), 'no inline style attributes');
  assert.ok(fs.existsSync(path.join(root, 'src/main/alert-preload.js')));
  assert.ok(fs.existsSync(path.join(root, 'src/main/alert-window.js')));
  // the settings page draws the same reminder as a preview
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(index.includes('alert-view.js') && index.includes('alert.css'));
});

test('the build workflows exist and do the right things', () => {
  const dir = path.join(root, '.github/workflows');
  const test = fs.readFileSync(path.join(dir, 'test.yml'), 'utf8');
  const build = fs.readFileSync(path.join(dir, 'build.yml'), 'utf8');
  assert.ok(test.includes('npm test'));
  assert.ok(build.includes('npm run dist'));
  assert.ok(build.includes('windows-latest'));
  assert.ok(build.includes('dist/*.exe'));
  assert.ok(build.includes('upload-artifact'));
  assert.ok(build.includes('CSC_IDENTITY_AUTO_DISCOVERY'), 'no code signing in v1');
  assert.match(build, /node-version: 20/);
});

test('the guides for the user exist', () => {
  for (const file of ['docs/HOW_TO_INSTALL_AND_USE.md', 'docs/ACCEPTANCE_CHECKLIST.md', 'docs/DATA_FORMAT.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
  }
});

test('fonts: the stylesheet, the copy script and the security policy agree', () => {
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'tools/copy-fonts.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(html.includes("font-src 'self'"));
  assert.equal(pkg.scripts.postinstall, 'node tools/copy-fonts.js');
  assert.ok(pkg.devDependencies['@fontsource/plus-jakarta-sans']);
  const urls = [...css.matchAll(/url\('(fonts\/[^']+)'\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 10, '5 weights x latin / latin-ext');
  for (const u of urls) {
    const [, subset, weight] = u.match(/PlusJakartaSans-(latin(?:-ext)?)-(\d+)\.woff2$/);
    assert.ok(script.includes(`'${subset}'`) && script.includes(String(weight)), `${u} is produced by copy-fonts.js`);
  }
  assert.ok(fs.existsSync(path.join(root, 'src/renderer/logo.png')));
});

test('sounds: the lists in the window code match the settings, and both pages load the sound code', () => {
  const { DONE_SOUNDS, ALERT_SOUNDS } = require('../src/core/settings');
  const code = fs.readFileSync(path.join(root, 'src/renderer/sounds.js'), 'utf8');
  const listIds = (name) => [...code.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/\['(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(listIds('DONE_OPTIONS'), DONE_SOUNDS);
  assert.deepEqual(listIds('ALERT_OPTIONS'), ALERT_SOUNDS);
  for (const id of [...DONE_SOUNDS, ...ALERT_SOUNDS].filter((i) => i !== 'off')) {
    assert.ok(new RegExp(`\\b${id}\\(ctx, out, t\\)`).test(code), `a recipe exists for "${id}"`);
  }
  for (const page of ['index.html', 'alert.html']) {
    assert.ok(fs.readFileSync(path.join(root, 'src/renderer', page), 'utf8').includes('<script src="sounds.js"></script>'), `${page} loads sounds.js`);
  }
});
