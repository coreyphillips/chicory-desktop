import { fileURLToPath, URL } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import type { Alias } from 'vite';
import base from './vite.config';

const gallery = (file: string) => fileURLToPath(new URL(`./web/gallery/${file}`, import.meta.url));

// The sealed gallery build. It has its own entry and output directory, so the
// production build (vite.config.ts, index.html, dist/) never contains it.
// The secure store, clipboard and camera resolve to in-memory stand-ins.
const sealed: Alias[] = [
  { find: 'react-native-keychain', replacement: gallery('keychain.ts') },
  { find: '@react-native-clipboard/clipboard', replacement: gallery('clipboard.ts') },
  { find: 'react-native-camera-kit', replacement: gallery('cameraKit.tsx') },
];
const inherited = (base.resolve?.alias as Alias[]).filter(
  alias => !sealed.some(stand => stand.find === alias.find),
);

export default mergeConfig(
  { ...base, resolve: { ...base.resolve, alias: [] } },
  defineConfig({
    resolve: { alias: [...sealed, ...inherited] },
    define: { __DEV__: 'false' },
    server: { proxy: {} },
    build: {
      outDir: 'dist-gallery',
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL('./gallery.html', import.meta.url)) },
    },
  }),
);
