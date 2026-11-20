// The pull-request body rules, as one pure decision.
//
// `docs/agents/pull-requests.md` states these rules; this module is what enforces them, so the
// prose keeps only what no check can say. The rules are:
//
// - `## Summary` and `## Validation` are present and say something.
// - `## Before / after` is present when the title's conventional type is `feat` or `fix`. The
//   section may state `No observable change` instead, with a reason.
// - `## Value` is present when the title's conventional type is `refactor`.
// - The body stays under `WORD_BUDGET` words.
// - `## Validation` names a commit SHA that is an ancestor of, or equal to, the PR head.
//
// Bot authors and draft PRs are exempt: neither is a hand-written body a reviewer depends on, and
// a draft is explicitly where work in progress is allowed to be unfinished.
//
// The caller resolves SHAs. This module never runs git or calls GitHub, which is what makes every
// rule below testable on a string, including the stale-body case.

/** Prose words a body may hold, outside fenced code blocks, tables, comments, and bot footers. */
export const WORD_BUDGET = 250;

/**
 * Prose words a `## Before / after` section must hold when it uses the `No observable change`
 * escape. The phrase itself is three words; a stated reason is a sentence, so anything shorter is
 * the phrase alone, which is the dodge this floor exists to reject.
 */
export const MIN_NO_CHANGE_REASON_WORDS = 8;

/** Types whose change a caller can observe, so the body must show it. */
const OBSERVABLE_TYPES = new Set(['feat', 'fix']);

const SUMMARY = 'summary';
const BEFORE_AFTER = 'before/after';
const VALUE = 'value';
const VALIDATION = 'validation';

/**
 * HTML comments that open a bot footer. Everything from the first match onward is dropped, because
 * a footer is appended by the bot and rewritten by neither the author nor a rebase, so its prose is
 * neither the author's budget nor something an author can update.
 */
const BOT_FOOTER_MARKERS: readonly RegExp[] = [
  /<!--\s*codesmith:footer\s*-->/,
  /<!--\s*This is an auto-generated description by cubic\.\s*-->/,
];

/**
 * Logins that post as bots without the `[bot]` suffix. GitHub Apps post `renovate[bot]` and
 * `dependabot[bot]`, covered by the suffix rule; these are the spellyings that reach the payload
 * without it.
 */
const BOT_AUTHOR_LOGINS = new Set(['renovate', 'dependabot', 'greenkeeper', 'snyk-bot']);

/**
 * A commit object id written as a token: 7 to 40 hexadecimal characters, not glued to other
 * characters on either side.
 */
const SHA_TOKEN = /(?<![0-9a-z])(?<sha>[0-9a-f]{7,40})(?![0-9a-z])/gi;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// A fence line, optionally inside blockquotes: the marker run, then the info string or nothing.
const FENCE_LINE = /^ {0,3}(?:> ?)*(`{3,}|~{3,})(.*)$/;
// A Markdown table row, blockquoted included. Its cells are data, not prose.
const TABLE_ROW = /^ {0,3}(?:> ?)*\|/;
// A level-one or level-two heading opens a section, and a level-three heading stays inside it, so
// `### Base` and `### Head` under `## Before / after` belong to that section.
const SECTION_HEADING = /^ {0,3}#{1,2}\s+(?<title>.*?)\s*$/;
const CONVENTIONAL_TITLE = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?:/;
const WORD = /\S+/g;

/**
 * The outcome of looking up one SHA named in `## Validation`, against the PR head.
 *
 * `unknown` says the environment cannot answer — no repository, a shallow clone, or a head commit
 * this checkout does not carry. That is not a verdict about the body, so it reads as a note rather
 * than a violation. `unreachable` and `diverged` are verdicts about the body.
 */
export type ShaResolution =
  | { readonly verdict: 'ancestor' }
  | { readonly verdict: 'diverged' }
  | { readonly verdict: 'unreachable' }
  | { readonly verdict: 'unknown'; readonly reason: string };

export type PullRequestFacts = {
  readonly title: string;
  readonly body: string;
  /** Login without the leading `@`. Empty when the payload does not name one. */
  readonly author: string;
  /** GitHub's `user.type` for the author, for example `Bot` or `User`. Empty when unknown. */
  readonly authorType: string;
  readonly draft: boolean;
  /** The PR head the tested SHA is compared with, as the payload states it. */
  readonly head: string;
  /** Whether one SHA named in `## Validation` is still an ancestor of `head`. */
  readonly resolveValidationSha: (sha: string) => ShaResolution;
};

export type BodyViolation = {
  readonly rule: string;
  readonly message: string;
};

export type BodyVerdict = {
  /** Why the body was exempted, or null when the rules were applied. */
  readonly exemption: string | null;
  /** Every rule that failed, in the order the body reads. */
  readonly violations: readonly BodyViolation[];
  /** Facts worth printing that are not violations, for example a SHA this checkout cannot verify. */
  readonly notes: readonly string[];
  /** Words counted against `WORD_BUDGET`. */
  readonly words: number;
};

/** One level-two section of a body, in the order it appears. */
type Section = {
  /** Heading with whitespace removed and case folded, so `## Before / after` is `before/after`. */
  readonly heading: string;
  /**
   * The section's prose: fenced code and table rows blanked. A receipt transcript is content for the
   * section's own rule, so `filled` reads `raw`; `prose` is what reads as a stated reason.
   */
  readonly prose: string;
  /** The section as written, fenced receipts included, so a SHA in a transcript still counts. */
  readonly raw: string;
};

function blank(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

/** The body up to the first bot footer marker, with CRLF folded and HTML comments blanked. */
function authoredBody(body: string): string {
  const normalized = body.replaceAll('\r\n', '\n');
  // The cut comes before comments are blanked: the markers this looks for are comments, and a
  // blanked one cannot be recognized as a marker.
  const indexes = BOT_FOOTER_MARKERS.map((pattern) => normalized.search(pattern)).filter(
    (index) => index >= 0,
  );
  const authored = indexes.length > 0 ? normalized.slice(0, Math.min(...indexes)) : normalized;
  return authored.replaceAll(HTML_COMMENT, blank);
}

/** Whether a line opens or closes a fence, given the fence currently open. */
function fenceState(line: string, open: string | null): string | null {
  const [, marker = '', info = ''] = FENCE_LINE.exec(line) ?? [];
  if (open === null) return marker !== '' ? marker : null;
  const closes = marker[0] === open[0] && marker.length >= open.length && info.trim() === '';
  return closes ? null : open;
}

/**
 * The same view of every line twice over: the line itself when it is prose, and an empty string when
 * it is a fence line, inside a fence, or a table row. One pass keeps the word count and the section
 * split reading one classification.
 */
function proseLines(body: string): string[] {
  let fence: string | null = null;
  return authoredBody(body)
    .split('\n')
    .map((line) => {
      const wasInsideFence = fence !== null;
      const opensOrCloses = FENCE_LINE.test(line);
      fence = fenceState(line, fence);
      return wasInsideFence || opensOrCloses || TABLE_ROW.test(line) ? '' : line;
    });
}

/**
 * The level-one and level-two sections of the authored body, in order. Headings are recognized only
 * on prose lines, so a `## ` line printed inside an example opens no section, and each section's
 * prose and raw views come from the same classification of the same line.
 */
function sectionsOf(body: string): Section[] {
  const authored = authoredBody(body).split('\n');
  const prose = proseLines(body);
  const sections: Section[] = [];
  let heading: string | null = null;
  let ownProse: string[] = [];
  let ownRaw: string[] = [];
  const close = (): void => {
    if (heading === null) return;
    // The first section of a name wins, so a template's explanatory heading cannot be shadowed by
    // a second one of the same name pasted below it.
    if (!sections.some((section) => section.heading === heading))
      sections.push({ heading, prose: ownProse.join('\n'), raw: ownRaw.join('\n') });
    ownProse = [];
    ownRaw = [];
  };
  authored.forEach((line, index) => {
    const text = prose[index]!;
    const title = SECTION_HEADING.exec(text)?.groups?.title;
    if (title !== undefined) {
      close();
      heading = title.replaceAll(/\s+/g, '').toLowerCase();
      return;
    }
    if (heading === null) return;
    ownProse.push(text);
    ownRaw.push(line);
  });
  close();
  return sections;
}

function countWords(text: string): number {
  return [...text.matchAll(WORD)]
    .map((match) => match[0])
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Words the budget counts: prose outside fenced code blocks, tables, comments, and bot footers. */
export function countBodyWords(body: string): number {
  return countWords(proseLines(body).join('\n'));
}

function sectionOf(sections: readonly Section[], heading: string): Section | undefined {
  return sections.find((section) => section.heading === heading);
}

/** The conventional-commit type of a PR title, or null when the title is not conventional. */
export function conventionalType(title: string): string | null {
  const match = CONVENTIONAL_TITLE.exec(title.replaceAll('\r', '').trim());
  return match?.groups?.type ?? null;
}

/** Whether the author is a bot, by GitHub's own author type or by a bot login shape. */
export function isBotAuthor(author: string, authorType: string): boolean {
  if (authorType.toLowerCase() === 'bot') return true;
  const login = author.replace(/^@/, '').toLowerCase();
  return login.endsWith('[bot]') || BOT_AUTHOR_LOGINS.has(login);
}

function shaTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(SHA_TOKEN)) {
    const sha = match.groups?.sha;
    if (sha) tokens.add(sha.toLowerCase());
  }
  return [...tokens];
}

/**
 * Decides the `## Validation` SHA rule: any named SHA that is an ancestor of the head satisfies it,
 * since a body may legitimately name base and head. With none satisfying it, a SHA the resolver could
 * not look up is a note — the environment, not the author, is what cannot answer — and one it looked
 * up is a violation naming the head to revalidate at.
 */
function checkValidationSha(
  section: string,
  head: string,
  resolve: (sha: string) => ShaResolution,
): { violations: BodyViolation[]; notes: string[] } {
  const unverifiable: string[] = [];
  const unreachable: string[] = [];
  const diverged: string[] = [];
  for (const sha of shaTokens(section)) {
    const resolution = resolve(sha);
    if (resolution.verdict === 'ancestor') return { violations: [], notes: [] };
    if (resolution.verdict === 'unknown') unverifiable.push(sha);
    else if (resolution.verdict === 'diverged') diverged.push(sha);
    // A run of digits the repository has no commit for is a date, a count, or a timing.
    else if (!/^\d+$/.test(sha)) unreachable.push(sha);
  }
  if (unverifiable.length + unreachable.length + diverged.length === 0) {
    return {
      violations: [
        {
          rule: 'validation-sha',
          message:
            'Validation SHA rule: name the tested commit SHA (7 to 40 hexadecimal characters) under ' +
            '"## Validation", so a reader can tell which commit the recorded results belong to.',
        },
      ],
      notes: [],
    };
  }
  if (unverifiable.length > 0) {
    const resolution = resolve(unverifiable[0]!);
    const reason = resolution.verdict === 'unknown' ? resolution.reason : '';
    return {
      violations: [],
      notes: [
        `Validation SHA ${unverifiable[0]} was not compared with the PR head — ${reason}. ` +
          'Run this check in a checkout that carries the PR head to get that verdict.',
      ],
    };
  }
  const named = [...unreachable, ...diverged].map((sha) => `\`${sha.slice(0, 10)}\``).join(', ');
  const shortHead = head.slice(0, 10);
  return {
    violations: [
      unreachable.length > 0
        ? {
            rule: 'validation-sha',
            message:
              `Validation SHA rule: ${named} is not a commit this repository has, so the body names a commit that ` +
              `was never pushed or was rewritten; revalidate at head \`${shortHead}\` and name that SHA.`,
          }
        : {
            rule: 'validation-sha',
            message:
              `Validation SHA rule: ${named} is not an ancestor of this PR's head \`${shortHead}\`, so the body ` +
              'describes commits that left the PR; rebase, revalidate, and name the new tested SHA.',
          },
    ],
    notes: [],
  };
}

/** The section rules: which required sections the body is missing or leaving empty. */
function sectionViolations(sections: readonly Section[], type: string | null): BodyViolation[] {
  const violations: BodyViolation[] = [];
  const filled = (heading: string): boolean =>
    (sectionOf(sections, heading)?.raw.trim() ?? '').length > 0;

  if (!filled(SUMMARY)) {
    violations.push({
      rule: 'summary',
      message:
        'Summary rule: add a "## Summary" section stating the behavior, the reason, the linked issue, ' +
        'and any scope expansion.',
    });
  }

  if (type !== null && OBSERVABLE_TYPES.has(type) && !filled(BEFORE_AFTER)) {
    violations.push({
      rule: 'before-after',
      message:
        `Before / after rule: a \`${type}\` change needs a "## Before / after" section that shows the same call at ` +
        'base and head, or that states "No observable change" with the reason.',
    });
  }

  if (type === 'refactor' && !filled(VALUE)) {
    violations.push({
      rule: 'value',
      message:
        'Value rule: a `refactor` change needs a "## Value" section with 2 to 4 numbers measured at base and head.',
    });
  }

  if (!filled(VALIDATION)) {
    violations.push({
      rule: 'validation',
      message:
        'Validation rule: add a "## Validation" section with the tested SHA, the command results, ' +
        'the CI obligations, and any unresolved risks.',
    });
  }
  return violations;
}

/**
 * The `No observable change` escape, checked on its own so a body that claims it still owes a
 * reason. The claim is only a claim when the section makes it in prose: a transcript that happens to
 * contain the phrase elsewhere is not the author disclaiming the change.
 */
function noChangeEscapeViolation(beforeAfter: string): BodyViolation | null {
  if (!/no observable change/i.test(beforeAfter)) return null;
  if (countWords(beforeAfter) >= MIN_NO_CHANGE_REASON_WORDS) return null;
  return {
    rule: 'before-after',
    message:
      'Before / after rule: the section states "No observable change" without a reason, so nothing explains ' +
      'what the change does; say why nothing observable changed.',
  };
}

/** Applies every body rule to one pull request and reports all failures at once. */
export function checkPullRequest(facts: PullRequestFacts): BodyVerdict {
  const words = countBodyWords(facts.body);
  if (facts.draft) {
    return { exemption: 'the pull request is a draft', violations: [], notes: [], words };
  }
  if (isBotAuthor(facts.author, facts.authorType)) {
    return {
      exemption: `author ${facts.author || '(unknown)'} is a bot`,
      violations: [],
      notes: [],
      words,
    };
  }

  const sections = sectionsOf(facts.body);
  const type = conventionalType(facts.title);
  const violations = sectionViolations(sections, type);

  const beforeAfter = sectionOf(sections, BEFORE_AFTER);
  if (type !== null && OBSERVABLE_TYPES.has(type) && (beforeAfter?.raw.trim().length ?? 0) > 0) {
    const escape = noChangeEscapeViolation(beforeAfter!.prose);
    if (escape) violations.push(escape);
  }

  if (words >= WORD_BUDGET) {
    violations.push({
      rule: 'word-budget',
      message:
        `Word budget rule: the body is ${words} words outside code blocks, tables, and bot footers; ` +
        `cut it below ${WORD_BUDGET}.`,
    });
  }

  const validation = sectionOf(sections, VALIDATION);
  const sha =
    (validation?.raw.trim().length ?? 0) > 0
      ? checkValidationSha(validation!.raw, facts.head, facts.resolveValidationSha)
      : { violations: [], notes: [] };
  return {
    exemption: null,
    violations: [...violations, ...sha.violations],
    notes: sha.notes,
    words,
  };
}
