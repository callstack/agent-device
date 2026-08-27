export function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

export function roundOneDecimal(value: number): number {
  return roundPercent(value);
}
