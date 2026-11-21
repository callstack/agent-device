/**
 * The JSON objects one CLI run printed, in order. A run that reports success and then fails prints one
 * object each, so a test that reads only the first of them never sees the second.
 */
export function parseJsonOutputs(stdout: string): unknown[] {
  const outputs: unknown[] = [];
  let lines: string[] = [];
  for (const line of stdout.split('\n')) {
    lines.push(line);
    // `printJson` pretty-prints with two spaces, so a `}` at column 0 closes the top-level object.
    if (line === '}') {
      outputs.push(JSON.parse(lines.join('\n')) as unknown);
      lines = [];
    }
  }
  return outputs;
}

/** The objects that reported success. */
export function successfulOutputs(outputs: unknown[]): unknown[] {
  return outputs.filter(
    (output) =>
      typeof output === 'object' &&
      output !== null &&
      (output as { success?: unknown }).success === true,
  );
}
