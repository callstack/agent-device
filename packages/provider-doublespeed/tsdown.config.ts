import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { plugin: 'src/plugin.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  minify: true,
  dts: false,
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: {
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      handler(level, log);
    },
  },
});
