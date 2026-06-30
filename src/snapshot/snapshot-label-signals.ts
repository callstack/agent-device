export function normalizeRepeatedNodeLabel(label: string): string | null {
  const normalized = label.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized || isEmailLikeLabel(normalized)) return null;
  return normalized;
}

function isEmailLikeLabel(label: string): boolean {
  return /\S+@\S+\.\S+/.test(label);
}
