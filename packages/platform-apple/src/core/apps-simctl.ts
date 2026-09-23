export function isMissingAppErrorOutput(output: string): boolean {
  return (
    output.includes('not installed') ||
    output.includes('not found') ||
    output.includes('no such file')
  );
}
