export {
  createLocalAppleToolProvider,
  hasScopedAppleToolProvider,
  readApplePlistJson,
  resolveAppleToolProvider,
  runAppleToolCommand,
  runXcrun,
  withAppleToolProvider,
} from './core/tool-provider.ts';
export type {
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleToolProvider,
  AppleToolSubcommandExecutor,
} from './core/tool-provider.ts';
