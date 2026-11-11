import { interpretIosNode } from '@agent-device/capture-kit/ios-node-interpretation';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  AuthorizedPressTarget,
  QuerySelectorInput,
} from '@agent-device/contracts/selector-observation-runtime';
import type { AppleRunnerCommandOptions } from '@agent-device/apple-runner';
import { isHandheldAppleDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { runAppleRunnerCommand } from './runner-client.ts';

/** Builds the distinct public selector and strict readiness runner reads. */
export async function queryAppleRunnerSelector(
  device: DeviceInfo,
  selector: QuerySelectorInput['selector'] | Readonly<{ authorizedTarget: AuthorizedPressTarget }>,
  appBundleId: string | undefined,
  options: AppleRunnerCommandOptions,
): Promise<Record<string, unknown>> {
  const result = await runAppleRunnerCommand(
    device,
    {
      command: 'authorizedTarget' in selector ? 'pressReadiness' : 'querySelector',
      ...('authorizedTarget' in selector
        ? { authorizedTarget: selector.authorizedTarget }
        : { selectorKey: selector.key, selectorValue: selector.value }),
      appBundleId,
    },
    options,
  );
  return {
    ...result,
    ...(Array.isArray(result.nodes)
      ? {
          nodes: (result.nodes as RawSnapshotNode[]).map((node) =>
            interpretIosNode(node, {
              reactNativeValue: isHandheldAppleDevice(device),
            }),
          ),
        }
      : {}),
  };
}
