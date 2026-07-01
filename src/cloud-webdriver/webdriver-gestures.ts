import type { W3CActionSequence, W3CPointerAction } from './webdriver-client.ts';

export function touchPointer(name: string, actions: W3CPointerAction[]): W3CActionSequence {
  return {
    type: 'pointer',
    id: name,
    parameters: { pointerType: 'touch' },
    actions,
  };
}
