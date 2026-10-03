import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { AppleRunnerCommandOptions } from '../runner/index.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAppleRunnerCommand } from './runner-client.ts';

/** The single Apple runner `querySelector` command builder shared by bound and safety-probe reads. */
export async function queryAppleRunnerSelector(
  device: DeviceInfo,
  selector: Readonly<{ key: ElementSelectorKey; value: string }>,
  appBundleId: string | undefined,
  options: AppleRunnerCommandOptions,
): Promise<Record<string, unknown>> {
  return await runAppleRunnerCommand(
    device,
    {
      command: 'querySelector',
      selectorKey: selector.key,
      selectorValue: selector.value,
      appBundleId,
    },
    options,
  );
}
