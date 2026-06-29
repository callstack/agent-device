import { AppError } from '../kernel/errors.ts';

export type AppearanceAction = 'light' | 'dark' | 'toggle';

export function parseAppearanceAction(state: string): AppearanceAction {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'light') return 'light';
  if (normalized === 'dark') return 'dark';
  if (normalized === 'toggle') return 'toggle';
  throw new AppError('INVALID_ARGS', `Invalid appearance state: ${state}. Use light|dark|toggle.`);
}
