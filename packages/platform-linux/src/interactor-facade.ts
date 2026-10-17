import type { Interactor } from '@agent-device/contracts/interactor-types';

export async function createLinuxInteractor(): Promise<Interactor> {
  const { createLinuxInteractor: create } = await import('./interactor.ts');
  return create();
}
