export type ExcludedImplementation = Readonly<{
  owner: string;
  paths: readonly RegExp[];
  markers: readonly string[];
}>;

export function packedCoreAbsenceFailures(
  exclusions: readonly ExcludedImplementation[],
  paths: readonly string[],
  readFile: (path: string) => string,
): string[] {
  return paths.flatMap((filename) => {
    const contents = /^dist\/.*\.[cm]?js$/.test(filename) ? readFile(filename) : '';
    return exclusions.flatMap(({ owner, paths, markers }) => [
      ...(paths.some((pattern) => pattern.test(filename))
        ? [`${owner}: forbidden packed path ${filename}`]
        : []),
      ...markers
        .filter((marker) => contents.includes(marker))
        .map((marker) => `${owner}: forbidden implementation marker in ${filename}: ${marker}`),
    ]);
  });
}
