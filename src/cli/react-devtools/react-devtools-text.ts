/**
 * App-provided text for one line of output. Control characters, which a terminal would act on or
 * which would start a line the app wrote, become spaces.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
