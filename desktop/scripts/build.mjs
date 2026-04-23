#!/usr/bin/env node
/**
 * VoiceBridge Desktop — Production Build Script
 * Bundles main process + preload with esbuild for electron-builder packaging.
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

async function buildMain() {
  await build({
    ...commonOptions,
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.js'),
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });
  console.log('[build] Main process → dist/main/main.js');
}

async function buildPreload() {
  await build({
    ...commonOptions,
    entryPoints: [resolve(root, 'src/preload/preload.ts')],
    outfile: resolve(root, 'dist/preload/preload.cjs'),
  });
  console.log('[build] Preload → dist/preload/preload.cjs');
}

async function main() {
  console.log('[build] Building for production...');
  await Promise.all([buildMain(), buildPreload()]);
  console.log('[build] Done.');
}

main().catch((err) => {
  console.error('[build] Fatal error:', err);
  process.exit(1);
});
