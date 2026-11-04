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

export async function readSimctlContainerPath(stdout: string): Promise<string | undefined> {
  const simctl = await import('./core/simctl.ts');
  return simctl.readSimctlContainerPath(stdout);
}
