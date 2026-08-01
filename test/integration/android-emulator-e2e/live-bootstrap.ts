import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

export async function installCachedFixture(context: LiveContext): Promise<void> {
  await runStep(context, 'install cached fixture APK through public CLI', [
    'install',
    context.appPath,
  ]);
  verifyCommand(context, PUBLIC_COMMANDS.install, 'cached fixture APK installs through public CLI');
}
