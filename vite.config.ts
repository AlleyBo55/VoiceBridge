import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'offscreen': resolve(__dirname, 'src/offscreen/offscreen.ts'),
        'content-script': resolve(__dirname, 'src/content/content-script.ts'),
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
    minify: 'terser',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
      '@styles': resolve(__dirname, 'src/styles'),
    },
  },
  define: {
    'import.meta.env.VITE_DEMO_API_KEY': JSON.stringify(process.env.VITE_DEMO_API_KEY ?? ''),
    'import.meta.env.VITE_DEMO_KEY_ENABLED': JSON.stringify(process.env.VITE_DEMO_KEY_ENABLED ?? 'true'),
    'import.meta.env.VITE_VERSION': JSON.stringify(process.env.VITE_VERSION ?? '1.0.0'),
  },
});
