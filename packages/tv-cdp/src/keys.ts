import type { TvRemoteButton } from '@agent-device/contracts/tv-remote';

export type KeyDefinition = Readonly<{
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}>;

/** Remote buttons the page receives as key events over CDP. */
export type RemoteKeys = Readonly<Partial<Record<TvRemoteButton, KeyDefinition>>>;

// Enter carries text because without it Chromium fires no keypress, so a focused <button> never
// gets the click a real OK press produces.
export const NAVIGATION_KEYS = {
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  select: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
} as const satisfies RemoteKeys;

export function supportedRemoteButtons(keys: RemoteKeys): readonly TvRemoteButton[] {
  return Object.keys(keys) as TvRemoteButton[];
}

export function keyEvents(definition: KeyDefinition) {
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  };
  return [
    { ...base, type: 'keyDown', ...(definition.text && { text: definition.text }) },
    { ...base, type: 'keyUp' },
  ];
}
