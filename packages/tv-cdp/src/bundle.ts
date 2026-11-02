type BuildLog = Readonly<{ code?: string; message: string }>;

/** tsdown options for a TV plugin: one self-contained ESM file with the workspace packages inside. */
export const TV_PLUGIN_BUNDLE = {
  entry: { 'agent-device': 'src/index.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  minify: true,
  dts: false,
  hash: false,
  deps: { alwaysBundle: [/^@agent-device\//] },
  inputOptions: {
    onLog(level: string, log: BuildLog, handler: (level: string, log: BuildLog) => void) {
      if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      handler(level, log);
    },
  },
} as const;
