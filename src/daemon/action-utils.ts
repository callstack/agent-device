import type { SessionAction } from './types.ts';

export function inferFillText(action: SessionAction): string {
  const resultText = action.result?.text;
  if (typeof resultText === 'string' && resultText.trim().length > 0) {
    return resultText;
  }
  const positionals = action.positionals ?? [];
  if (positionals.length === 0) return '';
  const first = positionals[0];
  if (first?.startsWith('@')) {
    if (positionals.length >= 3) return positionals.slice(2).join(' ').trim();
    return positionals.slice(1).join(' ').trim();
  }
  if (
    positionals.length >= 3 &&
    !Number.isNaN(Number(positionals[0])) &&
    !Number.isNaN(Number(positionals[1]))
  ) {
    return positionals.slice(2).join(' ').trim();
  }
  return positionals.slice(1).join(' ').trim();
}
