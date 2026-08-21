export function formatMaybeBytes(value) {
  return typeof value === 'number' ? formatBytes(value) : '-';
}

export function formatDiff(base, current) {
  return typeof base === 'number' ? formatSignedBytes(current - base) : '-';
}

export function formatBytes(value) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1000) return `${value} B`;
  if (absoluteValue < 1000 * 1000) return `${(value / 1000).toFixed(1)} kB`;
  return `${(value / (1000 * 1000)).toFixed(2)} MB`;
}

export function formatSignedBytes(value) {
  if (value === 0) return '0 B';
  const sign = value > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(value))}`;
}
