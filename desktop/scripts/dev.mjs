#!/usr/bin/env node
/**
 * VoiceBridge Desktop — Dev Script
 * Compiles main + preload with esbuild, starts Vite dev server for renderer,
 * launches Electron, and watches for changes.
 */

import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Shared esbuild options ──────────────────────────────────

const commonEsbuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'warning',
};

// ── Build main process ──────────────────────────────────────

async function buildMain(watch = false) {
  const ctx = await build({
    ...commonEsbuildOptions,
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.cjs'),
    define: {
      'process.env.NODE_ENV': '"development"',
    },
    ...(watch ? {} : {}),
  });
  return ctx;
}

// ── Build preload script ────────────────────────────────────

async function buildPreload() {
  await build({
    ...commonEsbuildOptions,
    entryPoints: [resolve(root, 'src/preload/preload.ts')],
    outfile: resolve(root, 'dist/preload/preload.cjs'),
  });
}

// ── Start Vite dev server for renderer ──────────────────────

async function startViteDevServer() {
  const server = await createServer({
    root: resolve(root, 'src/renderer'),
    configFile: resolve(root, 'vite.config.ts'),
    server: {
      port: 5173,
      strictPort: true,
    },
  });
  await server.listen();
  console.log('[dev] Vite dev server running at http://localhost:5173');
  return server;
}

// ── Launch Electron ─────────────────────────────────────────

function launchElectron() {
  const electronBin = resolve(root, 'node_modules/.bin/electron');
  const mainFile = resolve(root, 'dist/main/main.cjs');

  if (!existsSync(mainFile)) {
    console.error('[dev] dist/main/main.js not found — build failed?');
    process.exit(1);
  }

  const child = spawn(electronBin, [mainFile], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  });

  child.on('close', (code) => {
    console.log(`[dev] Electron exited with code ${code}`);
    process.exit(code ?? 0);
  });

  return child;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('[dev] Building main process...');
  await buildMain();

  console.log('[dev] Building preload script...');
  await buildPreload();

  console.log('[dev] Starting Vite dev server...');
  const viteServer = await startViteDevServer();

  console.log('[dev] Launching Electron...');
  const electronProcess = launchElectron();

  // Cleanup on exit
  process.on('SIGINT', () => {
    electronProcess.kill();
    viteServer.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    electronProcess.kill();
    viteServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[dev] Fatal error:', err);
  process.exit(1);
});
