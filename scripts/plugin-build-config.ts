import type { UserConfig } from 'tsdown';

export const strictBundlerInputOptions: NonNullable<UserConfig['inputOptions']> = {
  onLog(level, log, handler) {
    if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
    handler(level, log);
  },
};

export const providerPluginBuildConfig = {
  entry: { 'agent-device': 'src/index.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  minify: true,
  dts: false,
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: strictBundlerInputOptions,
} satisfies UserConfig;
