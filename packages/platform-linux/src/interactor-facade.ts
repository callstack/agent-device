import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

export async function createLinuxInteractor(host: HostEnvironment): Promise<Interactor> {
  const { createLinuxInteractor: create } = await import('./interactor.ts');
  return create(host);
}
