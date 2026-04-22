import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import preact from '@preact/preset-vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');

  return {
    plugins: [preact()],
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
      target: 'esnext',
      minify: 'esbuild',
      sourcemap: true,
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
