import { defineConfig } from 'tsdown';

const typeScriptPackageJsonUrl = import.meta.resolve('typescript/package.json');
const { default: getTypeScript7ExePath } = await import(
  new URL('lib/getExePath.js', typeScriptPackageJsonUrl).href
);

export default defineConfig({
  entry: { index: 'src/index.ts', node: 'src/node.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
  dts: { tsgo: { path: getTypeScript7ExePath() } },
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: {
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      handler(level, log);
    },
  },
});
