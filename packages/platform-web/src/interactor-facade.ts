import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { WebProvider } from './provider.ts';

export async function createWebInteractor(provider?: WebProvider): Promise<Interactor> {
  const { createWebInteractor: create } = await import('./interactor.ts');
  return await create(provider);
}
