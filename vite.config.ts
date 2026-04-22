import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

/**
 * Vite plugin to copy static extension assets (manifest, HTML, CSS, icons)
 * to the dist folder after build.
 */
function copyExtensionAssets() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      mkdirSync(dist, { recursive: true });

      // manifest.json
      copyFileSync(resolve(__dirname, 'src/manifest.json'), resolve(dist, 'manifest.json'));

      // HTML pages
      const htmlPages = [
        { src: 'src/popup/popup.html', dest: 'popup/popup.html' },
        { src: 'src/sidepanel/sidepanel.html', dest: 'sidepanel/sidepanel.html' },
        { src: 'src/options/options.html', dest: 'options/options.html' },
        { src: 'src/onboarding/onboarding.html', dest: 'onboarding/onboarding.html' },
        { src: 'src/offscreen/offscreen.html', dest: 'offscreen/offscreen.html' },
      ];
      for (const { src, dest } of htmlPages) {
        const destPath = resolve(dist, dest);
        mkdirSync(resolve(destPath, '..'), { recursive: true });
        copyFileSync(resolve(__dirname, src), destPath);
      }

      // CSS
      mkdirSync(resolve(dist, 'styles'), { recursive: true });
      for (const file of readdirSync(resolve(__dirname, 'src/styles'))) {
        copyFileSync(resolve(__dirname, 'src/styles', file), resolve(dist, 'styles', file));
      }
      // Also copy widget.css to assets/ for content script
      mkdirSync(resolve(dist, 'assets'), { recursive: true });
      copyFileSync(resolve(__dirname, 'src/styles/widget.css'), resolve(dist, 'assets/widget.css'));

      // Icons
      mkdirSync(resolve(dist, 'icons'), { recursive: true });
      for (const file of readdirSync(resolve(__dirname, 'src/icons'))) {
        if (file.endsWith('.png') || file.endsWith('.svg')) {
          copyFileSync(resolve(__dirname, 'src/icons', file), resolve(dist, 'icons', file));
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');

  return {
    build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'offscreen': resolve(__dirname, 'src/offscreen/offscreen.ts'),
        'offscreen-loader': resolve(__dirname, 'src/offscreen/offscreen-loader.ts'),
        'content-script': resolve(__dirname, 'src/content/content-script.ts'),
        'content-loader': resolve(__dirname, 'src/content/content-loader.ts'),
        'widget': resolve(__dirname, 'src/content/widget.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.ts'),
        'sidepanel': resolve(__dirname, 'src/sidepanel/sidepanel.ts'),
        'options': resolve(__dirname, 'src/options/options.ts'),
        'onboarding': resolve(__dirname, 'src/onboarding/onboarding.ts'),
        'audio-processor.worklet': resolve(__dirname, 'src/worklets/audio-processor.worklet.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: true,
  },
  plugins: [copyExtensionAssets()],
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
      '@styles': resolve(__dirname, 'src/styles'),
    },
  },
  define: {
    'import.meta.env.VITE_DEMO_KEY_ENABLED': JSON.stringify(env['VITE_DEMO_KEY_ENABLED'] ?? 'false'),
    'import.meta.env.VITE_DEMO_ELEVENLABS_KEY': JSON.stringify(env['VITE_DEMO_ELEVENLABS_KEY'] ?? ''),
    'import.meta.env.VITE_DEMO_LLM_PROVIDER': JSON.stringify(env['VITE_DEMO_LLM_PROVIDER'] ?? 'openrouter'),
    'import.meta.env.VITE_DEMO_LLM_KEY': JSON.stringify(env['VITE_DEMO_LLM_KEY'] ?? ''),
    'import.meta.env.VITE_DEMO_OPENROUTER_MODEL': JSON.stringify(env['VITE_DEMO_OPENROUTER_MODEL'] ?? 'openai/gpt-4o'),
    'import.meta.env.VITE_DEMO_UNLIMITED': JSON.stringify(env['VITE_DEMO_UNLIMITED'] ?? 'false'),
    'import.meta.env.VITE_DEMO_VOICE_LIMIT_SECONDS': JSON.stringify(env['VITE_DEMO_VOICE_LIMIT_SECONDS'] ?? '300'),
    'import.meta.env.VITE_VERSION': JSON.stringify(env['VITE_VERSION'] ?? '1.0.0'),
  },
};
});
