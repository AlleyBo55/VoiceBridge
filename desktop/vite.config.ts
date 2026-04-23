import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import preact from '@preact/preset-vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');

  return {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [preact()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      emptyOutDir: true,
      target: 'esnext',
      minify: 'esbuild',
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        '@native': resolve(__dirname, 'src/native'),
      },
    },
    define: {
      'import.meta.env.VITE_VERSION': JSON.stringify(env['VITE_VERSION'] ?? '1.0.0'),
    },
  };
});
