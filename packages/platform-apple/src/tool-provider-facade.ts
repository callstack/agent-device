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
  AppleToolExecOptions,
  AppleToolSubcommandExecutor,
} from './core/tool-provider.ts';

export async function parseApplePlist(bytes: Uint8Array): Promise<Record<string, unknown> | null> {
  const plist = await import('./core/plist.ts');
  return await plist.parseApplePlist(bytes);
}

export async function readSimctlContainerPath(stdout: string): Promise<string | undefined> {
  const simctl = await import('./core/simctl.ts');
  return simctl.readSimctlContainerPath(stdout);
}
