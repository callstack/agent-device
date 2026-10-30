/**
 * `xcodebuild`'s own echo of the recipe it was handed: build settings under their own header, and
 * the arguments it does not treat as settings — the `-I` package-sandbox flags — on the invocation
 * line. Built from the arguments the cache identity records, so a test that renders a log and a
 * test that renders a drifted one differ only in the arguments they leave out.
 */
export function xcodebuildLogWithBuildArguments(args: readonly string[]): string {
  const isSetting = (arg: string) => /^[A-Z][A-Z0-9_]*=/.test(arg);
  const buildSettings = args.filter(isSetting).map((arg) => {
    const index = arg.indexOf('=');
    return `    ${arg.slice(0, index)} = ${arg.slice(index + 1)}`;
  });
  const flags = args.filter((arg) => !isSetting(arg));
  return [
    'Command line invocation:',
    `    /usr/bin/xcodebuild build-for-testing ${flags.join(' ')}`.trimEnd(),
    '',
    'Build settings from command line:',
    ...buildSettings,
    '',
    'Resolve Package Graph',
    '',
  ].join('\n');
}
