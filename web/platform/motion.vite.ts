import type { Plugin } from 'vite';
import type { Plugin as DependencyPlugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

/**
 * Reanimated 4.7.1's web dispatcher handles CSS presets but does not execute
 * custom native layout callbacks. Keep this narrow integration explicit and
 * fail the build if an upstream dependency changes the expected boundary.
 */
export function chicoryMotion(): Plugin {
  const browser = fileURLToPath(new URL('./motion.browser.ts', import.meta.url));
  const runner = fileURLToPath(new URL('./motion.ts', import.meta.url));
  const rewrite = (code: string, id: string): string | null => {
    const path = id.split('?')[0].replaceAll('\\', '/');
    if (path.endsWith('/react-native-reanimated/lib/module/layoutReanimation/web/animationsManager.js')) {
      const entering = 'export function startWebLayoutAnimation(props, element, animationType, transitionData) {';
      const layout = 'export function tryActivateLayoutTransition(props, element, snapshot) {';
      if (!code.includes(entering) || !code.includes(layout))
        throw new Error('The browser motion integration needs review for this Reanimated version.');
      return `import { runCustomWebAnimation, runCustomWebLayout } from ${JSON.stringify(browser)};\nimport { snapshots as chicoryMotionSnapshots } from "./componentStyle.js";\n` +
        code.replace(entering, entering + '\n  if (runCustomWebAnimation(props, element, animationType, chicoryMotionSnapshots)) return;')
          .replace(layout, layout + '\n  if (runCustomWebLayout(props, element, snapshot)) return;');
    }
    if (path.endsWith('/react-native-reanimated/lib/module/layoutReanimation/web/componentUtils.js')) {
      const target = 'export function getReducedMotionFromConfig(config) {';
      if (!code.includes(target)) throw new Error('The browser reduced-motion integration needs review for this Reanimated version.');
      return `import { isCustomLayoutConfig } from ${JSON.stringify(runner)};\n` +
        code.replace(target, target + '\n  if (isCustomLayoutConfig(config)) return false;');
    }
    return null;
  };
  const dependencies: DependencyPlugin = {
    name: 'chicory-browser-motion-dependencies',
    setup(build) {
      build.onLoad({ filter: /react-native-reanimated[/\\]lib[/\\]module[/\\]layoutReanimation[/\\]web[/\\](animationsManager|componentUtils)\.js$/ }, async ({ path }) => {
        const code = await readFile(path, 'utf8');
        return { contents: rewrite(code, path) ?? code, loader: 'js' };
      });
    },
  };
  return {
    name: 'chicory-browser-motion',
    enforce: 'pre',
    config() {
      // Keep prebundling, including Reanimated's CommonJS version validator.
      // Apply the same guarded rewrite during prebundling and normal builds.
      return { optimizeDeps: { esbuildOptions: { plugins: [dependencies] } } };
    },
    transform(code, id) {
      return rewrite(code, id);
    },
  };
}
