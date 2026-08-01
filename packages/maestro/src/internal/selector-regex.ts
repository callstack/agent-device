const REGEX_SYNTAX = new Set('^$\\.*+?()[]{}|');

export function matchesMaestroRegex(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'ims').test(value);
  } catch {
    return value.toLocaleLowerCase() === pattern.toLocaleLowerCase();
  }
}

export function literalFromMaestroRegex(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
  } catch {
    return pattern;
  }

  let literal = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character !== '\\') {
      if (REGEX_SYNTAX.has(character)) return undefined;
      literal += character;
      continue;
    }

    const escaped = pattern[index + 1];
    if (escaped === undefined || !REGEX_SYNTAX.has(escaped)) return undefined;
    literal += escaped;
    index += 1;
  }
  return literal;
}
