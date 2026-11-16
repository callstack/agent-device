import type { InputOptions } from 'rolldown';

export const strictBundlerInputOptions: InputOptions = {
  onLog(level, log, handler) {
    if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
    handler(level, log);
  },
};

export const providerPluginBuildConfig = {
  entry: { 'agent-device': 'src/index.ts' },
  outDir: 'dist',
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2022' as const,
  minify: true,
  dts: false,
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: strictBundlerInputOptions,
};
