export function findMissingFixtureIdentifiers(
  fixtureSources: readonly string[],
  liveScenarioSources: readonly string[],
): string[] {
  const fixtureIdentifiers = new Set(
    fixtureSources.flatMap((source) =>
      [...source.matchAll(/\btestID="([^"]+)"/g)].map((match) => match[1]),
    ),
  );
  const liveScenarioIdentifiers = new Set(
    liveScenarioSources.flatMap(extractLiteralFixtureIdentifiers),
  );

  return [...liveScenarioIdentifiers]
    .filter((identifier) => !fixtureIdentifiers.has(identifier))
    .sort();
}

function extractLiteralFixtureIdentifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/\bid=(["'])([^"'$]+)\1/g)].flatMap((match) =>
      match[2] ? [match[2]] : [],
    ),
    ...[...source.matchAll(/\bidentifier\s*===\s*(["'])([^"']+)\1/g)].flatMap((match) =>
      match[2] ? [match[2]] : [],
    ),
  ];
}
