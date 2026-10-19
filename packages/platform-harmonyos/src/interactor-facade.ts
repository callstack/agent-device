import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';

export async function createHarmonyInteractor(
  device: DeviceInfo,
  runner?: RunnerContext,
): Promise<Interactor> {
  const { createHarmonyInteractor: create } = await import('./interactor.ts');
  return create(device, runner);
}
