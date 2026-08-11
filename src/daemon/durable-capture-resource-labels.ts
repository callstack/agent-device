/** User-facing and diagnostic naming shared by every durable-capture lifecycle phase. */
export function capitalizeDurableCaptureLabel(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function durableCaptureDiagnosticPrefix(resourceKind: string): string {
  return resourceKind.replaceAll('-', '_');
}
