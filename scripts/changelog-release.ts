// Folds `changelog.d/*.md` fragments into `CHANGELOG.md` as a new `## <version>` section, run by
// the `npm version` lifecycle script. See `changelog.d/README.md` for the fragment format.
//
// `parseFragment`/`assembleChangelog` are pure; `runCli` is the filesystem half, parameterized by
// `root` so it can target a scratch directory. `--check` (wired into `release:prepare`) fails a
// release that would otherwise ship with `changelog.d/` fragments still unconsumed.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Kind =
  | 'Breaking'
  | 'Added'
  | 'Changed'
  | 'Deprecated'
  | 'Removed'
  | 'Fixed'
  | 'Security';

export type ChangelogFragment = { name: string; text: string };

type Bullet = { kind: Kind; text: string };

// Kind rank first (Breaking, Removed, Changed, Deprecated, Added, Fixed, Security), independent of
// how often a kind appears; the array's index is the sort key.
const KIND_ORDER: readonly Kind[] = [
  'Breaking',
  'Removed',
  'Changed',
  'Deprecated',
  'Added',
  'Fixed',
  'Security',
];

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const BULLET_HEADER =
  /^- (Breaking|Added|Changed|Deprecated|Removed|Fixed|Security)(?: \([^)]+\))?: \S/;
const CONTINUATION = /^ {2}\S/;

/** The fragment's basename with the required `.md` extension stripped. */
function slug(fragmentName: string): string {
  return fragmentName.slice(0, -'.md'.length);
}

/**
 * Parses one fragment's bullets, in file order. Throws — naming the fragment and the offending
 * line — on a name that is missing the `.md` extension or fails the slug pattern, a leading
 * non-bullet line, an unknown kind, or a continuation line that is not indented under a bullet.
 * Bullet text keeps its internal newlines (a multi-line bullet's continuation lines) but drops
 * trailing whitespace per line.
 */
export function parseFragment(fragment: ChangelogFragment): Bullet[] {
  if (!fragment.name.endsWith('.md')) {
    throw new Error(`${fragment.name}: fragment file name must end in ".md".`);
  }
  const name = slug(fragment.name);
  if (!SLUG.test(name)) {
    throw new Error(
      `${fragment.name}: fragment name "${name}" must match ${SLUG.source} (lowercase, ` +
        'digits and hyphens, starting with a lowercase letter or digit).',
    );
  }

  const bullets: Bullet[] = [];
  let current: Bullet | undefined;
  for (const rawLine of fragment.text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) {
      current = undefined;
      continue;
    }
    const header = BULLET_HEADER.exec(line);
    if (header) {
      current = { kind: header[1] as Kind, text: line };
      bullets.push(current);
      continue;
    }
    if (current && CONTINUATION.test(line)) {
      current.text += `\n${line}`;
      continue;
    }
    throw new Error(
      `${fragment.name}: invalid line ${JSON.stringify(rawLine)}. Expected a bullet matching ` +
        `${BULLET_HEADER.source} or a two-space-indented continuation of one.`,
    );
  }
  if (bullets.length === 0) {
    throw new Error(`${fragment.name}: no bullets found.`);
  }
  return bullets;
}

/**
 * Folds `fragments` into `changelog` as a new `## <version>` section, sorted by kind rank, then
 * fragment name, then position within the fragment — deterministic regardless of the order
 * `fragments` arrives in. With no fragments, `changelog` comes back unchanged: a release with no
 * user-visible change gets no section, and the version/heading refusals below do not apply to it.
 */
export function assembleChangelog(input: {
  changelog: string;
  fragments: ChangelogFragment[];
  version: string;
}): string {
  const { changelog, fragments, version } = input;
  if (fragments.length === 0) return changelog;

  if (version.includes('-')) {
    throw new Error(`Refusing to release version "${version}": a "-dev" marker is not a release.`);
  }
  const heading = `## ${version}`;
  if (changelog.includes(`${heading}\n`) || changelog.includes(`${heading} `)) {
    throw new Error(
      `CHANGELOG.md already has a "${heading}" section. Fragments were already consumed for this version.`,
    );
  }
  if (changelog.includes('## Unreleased')) {
    throw new Error(
      'CHANGELOG.md still has an "## Unreleased" heading. Migrate it before running the assembler.',
    );
  }

  const sorted = fragments
    .map((fragment, fragmentIndex) => ({
      fragment,
      fragmentIndex,
      bullets: parseFragment(fragment),
    }))
    .flatMap(({ fragment, fragmentIndex, bullets }) =>
      bullets.map((bullet, bulletIndex) => ({ fragment, fragmentIndex, bulletIndex, bullet })),
    )
    .sort((a, b) => {
      const kindDelta = KIND_ORDER.indexOf(a.bullet.kind) - KIND_ORDER.indexOf(b.bullet.kind);
      if (kindDelta !== 0) return kindDelta;
      const nameDelta =
        a.fragment.name < b.fragment.name ? -1 : a.fragment.name > b.fragment.name ? 1 : 0;
      if (nameDelta !== 0) return nameDelta;
      return a.bulletIndex - b.bulletIndex;
    })
    .map(({ bullet }) => bullet.text);

  const section = `${heading}\n\n${sorted.join('\n')}\n\n`;
  const titleMatch = /^# Changelog\n+/.exec(changelog);
  const insertAt = titleMatch ? titleMatch[0].length : 0;
  return changelog.slice(0, insertAt) + section + changelog.slice(insertAt);
}

const FRAGMENTS_DIR = 'changelog.d';
const README = 'README.md';

/**
 * Every `changelog.d` entry other than `README.md` and dotfiles (such as `.DS_Store`), regardless
 * of extension. The assembler and `--check` both consume this exact list, so an entry that is not
 * a valid `<slug>.md` fragment fails `parseFragment` instead of being silently skipped by an
 * extension filter.
 */
export function readFragments(dir: string): ChangelogFragment[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name !== README && !name.startsWith('.'))
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

/** The CLI's file-system half, kept separate from `main()` so tests can point it at a scratch root. */
export function runCli(options: { root: string; check: boolean }): number {
  const { root, check } = options;
  const fragmentsDir = path.join(root, FRAGMENTS_DIR);

  if (check) {
    const fragments = readFragments(fragmentsDir);
    for (const fragment of fragments) parseFragment(fragment);
    if (fragments.length > 0) {
      process.stderr.write(
        `${fragments.length} fragment(s) still in ${FRAGMENTS_DIR}/: ` +
          `${fragments.map((f) => f.name).join(', ')}. Run the assembler (no --check) before releasing.\n`,
      );
      return 1;
    }
    process.stdout.write(`${FRAGMENTS_DIR}/ carries no unconsumed fragments.\n`);
    return 0;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const fragments = readFragments(fragmentsDir);
  if (fragments.length === 0) {
    process.stdout.write('No changelog.d/ fragments to assemble; CHANGELOG.md is unchanged.\n');
    return 0;
  }

  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const assembled = assembleChangelog({ changelog, fragments, version: pkg.version });
  fs.writeFileSync(changelogPath, assembled);
  for (const fragment of fragments) fs.rmSync(path.join(fragmentsDir, fragment.name));

  process.stdout.write(
    `Assembled ${fragments.length} fragment(s) into CHANGELOG.md under "## ${pkg.version}" and removed them from ${FRAGMENTS_DIR}/.\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runCli({ root: process.cwd(), check: process.argv.includes('--check') }));
}
