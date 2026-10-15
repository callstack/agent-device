import {
  networkDumpUse,
  resolveNetworkRuntimePlan,
} from '@agent-device/contracts/network-runtime-plan';
import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('network descriptor declares the exact use selected by all eight projection cells', () => {
  const network = commandDescriptors.find(({ name }) => name === 'network');

  expect(network?.platformExecution).toEqual({
    kind: 'device-runtime',
    use: networkDumpUse,
  });
  const selectedUses = ['dump', 'log'].flatMap((action) =>
    ['summary', 'headers', 'body', 'all'].map(
      (include) => resolveNetworkRuntimePlan({ action, include }).use,
    ),
  );
  expect(new Set(selectedUses)).toEqual(new Set([networkDumpUse]));
});
