#!/usr/bin/env node
/**
 * Generate app icons from icon.svg for all platforms.
 * Requires: macOS with sips, iconutil, and ImageMagick (convert).
 */

import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', 'build');
const svgPath = resolve(buildDir, 'icon.svg');
const iconsetDir = resolve(buildDir, 'icon.iconset');

if (!existsSync(svgPath)) {
  console.error('icon.svg not found in build/');
  process.exit(1);
}

// Sizes needed for macOS .iconset
const sizes = [16, 32, 64, 128, 256, 512, 1024];

console.log('[icons] Generating PNGs from SVG...');

// Create iconset directory
if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true });
mkdirSync(iconsetDir, { recursive: true });

// Generate base 1024px PNG first
const basePng = resolve(buildDir, 'icon-1024.png');
execSync(`convert -background none -density 300 "${svgPath}" -resize 1024x1024 "${basePng}"`, { stdio: 'inherit' });

// Generate iconset PNGs for macOS
for (const size of sizes) {
  const name1x = `icon_${size}x${size}.png`;
  const name2x = `icon_${size / 2}x${size / 2}@2x.png`;

  execSync(`sips -z ${size} ${size} "${basePng}" --out "${resolve(iconsetDir, name1x)}" 2>/dev/null`, { stdio: 'inherit' });

  if (size >= 32) {
    execSync(`sips -z ${size} ${size} "${basePng}" --out "${resolve(iconsetDir, name2x)}" 2>/dev/null`, { stdio: 'inherit' });
  }
}

// Generate .icns for macOS
console.log('[icons] Building icon.icns...');
execSync(`iconutil -c icns "${iconsetDir}" -o "${resolve(buildDir, 'icon.icns')}"`, { stdio: 'inherit' });

// Generate 256px PNG for Linux and electron-builder fallback
console.log('[icons] Building icon.png (256px)...');
execSync(`sips -z 256 256 "${basePng}" --out "${resolve(buildDir, 'icon.png')}" 2>/dev/null`, { stdio: 'inherit' });

// Generate .ico for Windows (multi-size)
console.log('[icons] Building icon.ico...');
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoInputs = icoSizes.map(s => {
  const tmp = resolve(buildDir, `icon-${s}.png`);
  execSync(`sips -z ${s} ${s} "${basePng}" --out "${tmp}" 2>/dev/null`, { stdio: 'inherit' });
  return `"${tmp}"`;
});
execSync(`convert ${icoInputs.join(' ')} "${resolve(buildDir, 'icon.ico')}"`, { stdio: 'inherit' });

// Cleanup temp files
rmSync(iconsetDir, { recursive: true });
for (const s of [...sizes, ...icoSizes, 1024]) {
  const tmp = resolve(buildDir, `icon-${s}.png`);
  if (existsSync(tmp)) rmSync(tmp);
}

console.log('[icons] Done. Generated: icon.icns, icon.ico, icon.png');
