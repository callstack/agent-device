import type { W3CActionSequence } from './webdriver-client.ts';

export function touchPointer(name: string, actions: Record<string, unknown>[]): W3CActionSequence {
  return {
    type: 'pointer',
    id: name,
    parameters: { pointerType: 'touch' },
    actions,
  };
}
