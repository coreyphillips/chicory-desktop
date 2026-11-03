import type { Plugin } from 'vite';
import type { Plugin as DependencyPlugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export function chicorySvg(): Plugin {
  const helper = fileURLToPath(new URL('./svgProps.ts', import.meta.url));
  const matches = (id: string) => id.split('?')[0].replaceAll('\\', '/').endsWith('/react-native-svg/lib/module/web/utils/prepare.js');
  const rewrite = (code: string) => {
    if (!code.includes('  return clean;')) throw new Error('Review the browser SVG accessibility integration for this renderer version.');
    return `import { svgWebProps } from ${JSON.stringify(helper)};\n` + code.replace('  return clean;', '  return svgWebProps(clean);');
  };
  const dependencies: DependencyPlugin = {
    name: 'chicory-svg-accessibility',
    setup(build) {
      build.onLoad({ filter: /react-native-svg[/\\]lib[/\\]module[/\\]web[/\\]utils[/\\]prepare\.js$/ }, async ({ path }) =>
        ({ contents: rewrite(await readFile(path, 'utf8')), loader: 'js' }));
    },
  };
  return {
    name: 'chicory-svg-accessibility', enforce: 'pre',
    config: () => ({ optimizeDeps: { esbuildOptions: { plugins: [dependencies] } } }),
    transform: (code, id) => matches(id) ? rewrite(code) : null,
  };
}
