import type { Plugin } from 'vite';
import type { Plugin as DependencyPlugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

/**
 * react-native-web 0.21 drops accessibilityState: a view forwards only the
 * props it lists, and none of them is that one. Let it through, and hand it to
 * `stateAsAria` once the DOM props are done.
 */
export function chicoryAccessibility(): Plugin {
  const helper = fileURLToPath(new URL('./accessibilityProps.ts', import.meta.url));
  const review = new Error('Review the browser accessibility state integration for this react-native-web version.');
  const rewrite = (code: string, id: string): string | null => {
    const path = id.split('?')[0].replaceAll('\\', '/');
    if (path.endsWith('/react-native-web/dist/modules/forwardedProps/index.js')) {
      const list = 'export var accessibilityProps = {';
      if (!code.includes(list)) throw review;
      return code.replace(list, `${list}\n  accessibilityState: true,`);
    }
    if (path.endsWith('/react-native-web/dist/modules/createDOMProps/index.js')) {
      const done = '  return domProps;';
      if (code.split(done).length !== 2 || !code.includes('var role = ')) throw review;
      return `import { stateAsAria } from ${JSON.stringify(helper)};\n` + code.replace(done, '  return stateAsAria(domProps, role);');
    }
    return null;
  };
  const dependencies: DependencyPlugin = {
    name: 'chicory-accessibility-state',
    setup(build) {
      build.onLoad({ filter: /react-native-web[/\\]dist[/\\]modules[/\\](forwardedProps|createDOMProps)[/\\]index\.js$/ }, async ({ path }) => {
        const code = await readFile(path, 'utf8');
        return { contents: rewrite(code, path) ?? code, loader: 'js' };
      });
    },
  };
  return {
    name: 'chicory-accessibility-state', enforce: 'pre',
    config: () => ({ optimizeDeps: { esbuildOptions: { plugins: [dependencies] } } }),
    transform: (code, id) => rewrite(code, id),
  };
}
