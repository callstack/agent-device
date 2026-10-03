const KEYBOARD_ACTIONS = ['status', 'get', 'dismiss', 'enter', 'return'] as const;

export type KeyboardAction = (typeof KEYBOARD_ACTIONS)[number];

export function isKeyboardAction(action: string): action is KeyboardAction {
  return KEYBOARD_ACTIONS.includes(action as KeyboardAction);
}
