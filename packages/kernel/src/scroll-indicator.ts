export function isSystemScrollIndicatorLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /^(vertical|horizontal)\s+scroll\s+bar(?:,?\s*\d+\s+pages?)?$/.test(normalized);
}

export function inferVerticalScrollIndicatorDirections(
  label: string | undefined,
  value: string | undefined,
): { above: boolean; below: boolean } | null {
  const normalizedLabel = label?.trim().toLowerCase() ?? '';
  if (!normalizedLabel.includes('vertical scroll bar')) {
    return null;
  }
  const scrollPercent = parsePercentValue(value);
  if (scrollPercent === null) {
    return null;
  }
  // Treat ≤1% as "at the top" and ≥99% as "at the bottom".  The 1% tolerance
  // absorbs minor rounding that accessibility APIs report (e.g. iOS VoiceOver
  // may report 1% instead of 0% when very close to an edge).
  if (scrollPercent <= 1) {
    return { above: false, below: true };
  }
  if (scrollPercent >= 99) {
    return { above: true, below: false };
  }
  return { above: true, below: true };
}

function parsePercentValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{1,3})%$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, parsed));
}
