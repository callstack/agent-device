import type { SessionAction } from '@agent-device/contracts/session';

export function inferFillText(action: SessionAction): string {
  const resultText = action.result?.text;
  if (typeof resultText === 'string') return resultText;
  const positionals = action.positionals ?? [];
  if (positionals.length === 0) return '';
  const first = positionals[0];
  if (first?.startsWith('@')) {
    if (positionals.length >= 3) return positionals.slice(2).join(' ');
    return positionals.slice(1).join(' ');
  }
  if (
    positionals.length >= 3 &&
    !Number.isNaN(Number(positionals[0])) &&
    !Number.isNaN(Number(positionals[1]))
  ) {
    return positionals.slice(2).join(' ');
  }
  return positionals.slice(1).join(' ');
}
