// Family-name redaction and the leak check that audits it. Both work on the same tokenisation
// so the audit cannot pass what the scrubber missed by construction: text is split into
// alphanumeric words (also at camelCase boundaries), and a family "leaks" when its own words
// appear contiguously — `host-kit`, `host/kit`, `hostKit`, and `HostKit` all leak `host-kit`.
// The scrubber replaces every such run for every family in the answer space with `«x»`, and
// also the family's source folder (`daemon` for `daemon-server`), because a folder segment in
// an import path names the family as surely as the id does.

export const REDACTED = '«x»';

export type Token = { text: string; start: number; end: number };

const WORD = /[A-Za-z0-9]+/g;
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    let offset = match.index;
    for (const part of match[0].split(CAMEL_BOUNDARY)) {
      if (part.length === 0) continue;
      tokens.push({ text: part.toLowerCase(), start: offset, end: offset + part.length });
      offset += part.length;
    }
  }
  return tokens;
}

/** The lower-case word sequence a name reduces to: `daemon-server` -> `['daemon', 'server']`. */
export function wordsOf(name: string): string[] {
  return tokenize(name).map((token) => token.text);
}

export type Scrubber = {
  scrub(text: string): string;
  /** Names the scrubber removes, longest word sequence first. */
  readonly targets: readonly string[];
};

function matchesAt(tokens: readonly Token[], index: number, words: readonly string[]): boolean {
  if (index + words.length > tokens.length) return false;
  for (let offset = 0; offset < words.length; offset++) {
    if (tokens[index + offset]!.text !== words[offset]) return false;
  }
  return true;
}

/** Every span, as `[start, end)`, where one of the sequences occurs; longest sequences first. */
function occupiedSpans(
  text: string,
  sequences: readonly (readonly string[])[],
): [number, number][] {
  const tokens = tokenize(text);
  const consumed = new Array<boolean>(tokens.length).fill(false);
  const spans: [number, number][] = [];
  for (const words of sequences) {
    for (let index = 0; index < tokens.length; index++) {
      const span = claimSpan(tokens, consumed, index, words);
      if (span) spans.push(span);
    }
  }
  return spans.sort((left, right) => left[0] - right[0]);
}

/** Claims the tokens at `index` for `words` when they match and none is already claimed. */
function claimSpan(
  tokens: readonly Token[],
  consumed: boolean[],
  index: number,
  words: readonly string[],
): [number, number] | null {
  if (words.length === 0 || !matchesAt(tokens, index, words)) return null;
  const claimed = consumed.slice(index, index + words.length);
  if (claimed.some(Boolean)) return null;
  consumed.fill(true, index, index + words.length);
  return [tokens[index]!.start, tokens[index + words.length - 1]!.end];
}

export function createScrubber(names: Iterable<string>): Scrubber {
  const targets = [...new Set(names)]
    .filter((name) => wordsOf(name).length > 0)
    .sort(
      (left, right) => wordsOf(right).length - wordsOf(left).length || left.localeCompare(right),
    );
  const sequences = targets.map(wordsOf);
  return {
    targets,
    scrub(text) {
      const spans = occupiedSpans(text, sequences);
      if (spans.length === 0) return text;
      let out = '';
      let cursor = 0;
      for (const [start, end] of spans) {
        out += text.slice(cursor, start) + REDACTED;
        cursor = end;
      }
      return out + text.slice(cursor);
    },
  };
}

/** True when any of the names occurs in the text as a contiguous word sequence. */
export function leaksName(text: string, names: Iterable<string>): boolean {
  const tokens = tokenize(text);
  for (const name of names) {
    const words = wordsOf(name);
    if (words.length === 0) continue;
    for (let index = 0; index < tokens.length; index++) {
      if (matchesAt(tokens, index, words)) return true;
    }
  }
  return false;
}
