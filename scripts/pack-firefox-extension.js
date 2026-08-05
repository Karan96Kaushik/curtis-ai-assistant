#!/usr/bin/env node
/**
 * Pack extensions/firefox into a Firefox-installable .xpi
 * (ZIP with extension files at the archive root — not nested in a folder).
 *
 * Usage: node scripts/pack-firefox-extension.js
 *    or: npm run extension:pack
 *
 * Install:
 *   about:debugging → This Firefox → Load Temporary Add-on → select the .xpi
 *   (or drag the .xpi onto about:addons in Developer Edition / with signing disabled)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'extensions', 'firefox');
const outDir = path.join(root, 'dist');
const outName = 'curtis-bridge.xpi';
const outFile = path.join(outDir, outName);

const manifestPath = path.join(srcDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`Missing manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version || '0.0.0';

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

const zipBin = process.platform === 'win32' ? null : 'zip';
if (!zipBin) {
  console.error('This packer uses the zip CLI (macOS/Linux). On Windows, zip the contents of extensions/firefox so manifest.json is at the archive root, then rename to .xpi');
  process.exit(1);
}

try {
  execFileSync(
    zipBin,
    ['-r', '-X', outFile, '.', '-x', '*.DS_Store', '-x', '**/.DS_Store', '-x', '*.map'],
    { cwd: srcDir, stdio: 'inherit' }
  );
} catch (err) {
  console.error('zip failed:', err.message || err);
  process.exit(1);
}

const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`\nPacked Curtis Bridge v${version}`);
console.log(`  → ${outFile} (${sizeKb} KB)`);
console.log(`
Install in Firefox:
  1. Open about:debugging#/runtime/this-firefox
  2. Click "Load Temporary Add-on…"
  3. Select ${outName} (or extensions/firefox/manifest.json)

Keep Curtis running (npm start) so the extension can connect to ws://127.0.0.1:8765
`);
