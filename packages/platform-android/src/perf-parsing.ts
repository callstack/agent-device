export function parseNumericToken(token: string): number | null {
  const match = token.replaceAll(',', '').match(/^-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}
