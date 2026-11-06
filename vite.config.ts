import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { chicoryAccessibility } from './web/platform/accessibility.vite';
import { chicoryMotion } from './web/platform/motion.vite';
import { chicorySvg } from './web/platform/svg.vite';

const platform = (file: string) => fileURLToPath(new URL(`./web/platform/${file}`, import.meta.url));

export default defineConfig({
  plugins: [chicoryMotion(), chicorySvg(), chicoryAccessibility(), react({ babel: { plugins: ['react-native-worklets/plugin'] } })],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      { find: '@react-native/assets-registry/registry', replacement: 'react-native-web/dist/modules/AssetRegistry' },
      { find: 'react-native-keychain', replacement: platform('keychain.ts') },
      { find: '@react-native-clipboard/clipboard', replacement: platform('clipboard.ts') },
      { find: 'react-native-camera-kit', replacement: platform('cameraKit.tsx') },
    ],
    extensions: ['.web.mjs', '.mjs', '.web.js', '.js', '.web.ts', '.ts', '.web.tsx', '.tsx', '.json'],
    dedupe: ['react', 'react-dom', 'react-native-web'],
  },
  define: { __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'), global: 'globalThis' },
  optimizeDeps: {
    include: ['react-native-web', 'react-native-reanimated', 'react-native-gesture-handler', 'react-native-svg'],
    esbuildOptions: { resolveExtensions: ['.web.js', '.js', '.web.ts', '.ts', '.web.tsx', '.tsx', '.json'] },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': process.env.CHICORY_MANAGER_URL || 'http://127.0.0.1:3000',
      '/wallets': process.env.CHICORY_MANAGER_URL || 'http://127.0.0.1:3000',
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
