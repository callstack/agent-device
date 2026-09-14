// `pnpm check:packaged-runner-swift` — hold the two properties of the Apple runner source the npm
// package ships that nothing else in this repo can observe.
//
// `apple/runner/**` is rewritten on its way into `dist/apple/runner/**`: unit-test `#if` blocks
// come out, and `scripts/strip-swift-comments.mjs` takes the comments out (#2461). Nothing in the
// repo compiles, imports or reads the result — the first consumer is a user's `xcodebuild` — so
// both the Swift staying valid and its line numbers staying meaningful are claims only a check
// makes. This is that check:
//
//   1. Line parity. Every rewritten line is emptied, never deleted, so packaged line N is
//      checkout line N. An `xcodebuild`/runner failure names the packaged path (it lands in
//      `runner.log`), and the number it prints is only worth reading if it points at the same
//      line of `apple/runner/**`. Asserted two ways per file: the line count, and the line every
//      declaration the packaged file still carries sits on.
//   2. It parses. `xcrun swiftc -parse` over every packaged Swift file. The scanner throws on a
//      construct it cannot lex rather than shipping, but a future mis-lex that fails to throw
//      would ship Swift that does not compile, and no other gate would notice.
//
// Packaging runs into a throwaway root over a symlinked `apple/`, so the gate reads the bytes the
// packager really writes without touching `dist/`.
//
// Property 1 needs no toolchain and runs everywhere. Property 2 needs Swift: on a host without it
// (Linux CI) the parse is reported as skipped rather than failing, which is why the gate is
// declared on the macOS lane, where it is the half that matters.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageAppleRunnerScript = path.join(repoRoot, 'scripts/package-apple-runner-source.mjs');
const SOURCE_DIR = path.join('apple', 'runner');
const PACKAGED_DIR = path.join('dist', 'apple', 'runner');

/**
 * A Swift declaration and its name. Matched per line and used as a line-number anchor, so it is
 * deliberately independent of the rewrite: it reads the name out of whatever the line still holds
 * rather than comparing the two lines, which a removed trailing comment would break.
 */
const DECLARATION = /\b(actor|class|enum|extension|func|protocol|struct)\s+([A-Za-z_]\w*)/;

/** The declaration each line declares, keyed by 1-based line number. */
export function declarationsByLine(text: string): Map<number, string> {
  const declarations = new Map<number, string>();
  for (const [index, line] of text.split('\n').entries()) {
    const match = DECLARATION.exec(line);
    if (match) declarations.set(index + 1, `${match[1]} ${match[2]}`);
  }
  return declarations;
}

/** Every way the packaged file's line numbering can disagree with the checkout's. */
export function parityFailures(
  relativePath: string,
  sourceText: string,
  packagedText: string,
): string[] {
  const sourceLines = sourceText.split('\n').length;
  const packagedLines = packagedText.split('\n').length;
  if (sourceLines !== packagedLines) {
    return [
      `${relativePath}: packaged source has ${packagedLines} lines, checkout has ${sourceLines}. ` +
        'Packaging must empty a removed line, not delete it.',
    ];
  }
  const sourceDeclarations = declarationsByLine(sourceText);
  return [...declarationsByLine(packagedText)]
    .filter(([line, declaration]) => sourceDeclarations.get(line) !== declaration)
    .map(
      ([line, declaration]) =>
        `${relativePath}:${line}: packaged \`${declaration}\` is \`` +
        `${sourceDeclarations.get(line) ?? '(blank)'}\` at the same line of the checkout.`,
    );
}

function swiftFilesUnder(root: string, relativeDir = ''): string[] {
  const entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return swiftFilesUnder(root, relativePath);
    return entry.isFile() && entry.name.endsWith('.swift') ? [relativePath] : [];
  });
}

/**
 * Packages the runner into a disposable root. `apple/` is symlinked rather than copied: the
 * packager only reads it, and the output path it derives (`<root>/dist/apple/runner`) is what has
 * to land outside the checkout.
 */
function packageIntoScratchRoot(scratchRoot: string): string {
  fs.symlinkSync(path.join(repoRoot, 'apple'), path.join(scratchRoot, 'apple'), 'dir');
  runCmdSync(process.execPath, [packageAppleRunnerScript, '--root', scratchRoot, '--quiet']);
  return path.join(scratchRoot, PACKAGED_DIR);
}

function lineParityFailures(packagedRoot: string, relativePaths: readonly string[]): string[] {
  return relativePaths.flatMap((relativePath) => {
    const sourcePath = path.join(repoRoot, SOURCE_DIR, relativePath);
    if (!fs.existsSync(sourcePath)) {
      return [`${path.join(PACKAGED_DIR, relativePath)} has no counterpart in ${SOURCE_DIR}.`];
    }
    return parityFailures(
      path.join(PACKAGED_DIR, relativePath),
      fs.readFileSync(sourcePath, 'utf8'),
      fs.readFileSync(path.join(packagedRoot, relativePath), 'utf8'),
    );
  });
}

/** The Swift compiler, or undefined on a host that has none. */
function findSwiftc(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const found = runCmdSync('xcrun', ['--find', 'swiftc'], { allowFailure: true });
    return found.exitCode === 0 && found.stdout.trim() !== '' ? found.stdout.trim() : undefined;
  } catch {
    // No `xcrun` on PATH at all: a macOS host without the command line tools.
    return undefined;
  }
}

/**
 * Parses each packaged file on its own, so a diagnostic names the file that caused it and one
 * file's top-level code cannot change how another is read.
 */
function swiftParseFailures(
  swiftc: string,
  packagedRoot: string,
  relativePaths: readonly string[],
  tmpDir: string,
): string[] {
  return relativePaths.flatMap((relativePath) => {
    const result = runCmdSync(swiftc, ['-parse', path.join(packagedRoot, relativePath)], {
      allowFailure: true,
      env: { ...process.env, TMPDIR: tmpDir },
    });
    if (result.exitCode === 0) return [];
    // Swift names the scratch copy it was handed; say where that file comes from instead.
    const detail = (result.stderr || result.stdout)
      .replaceAll(`${packagedRoot}${path.sep}`, `${PACKAGED_DIR}${path.sep}`)
      .trim();
    return [`${path.join(PACKAGED_DIR, relativePath)} does not parse after packaging:\n${detail}`];
  });
}

function main(): number {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-packaged-swift-'));
  try {
    const packagedRoot = packageIntoScratchRoot(scratchRoot);
    const relativePaths = swiftFilesUnder(packagedRoot);
    const swiftc = findSwiftc();
    const failures = [
      ...lineParityFailures(packagedRoot, relativePaths),
      ...(swiftc === undefined
        ? []
        : swiftParseFailures(swiftc, packagedRoot, relativePaths, scratchRoot)),
    ];
    if (failures.length > 0) {
      process.stderr.write(`${failures.join('\n')}\n`);
      process.stdout.write(
        `packaged runner Swift: ${failures.length} failure(s) over ${relativePaths.length} files.\n`,
      );
      return 1;
    }
    const parse =
      swiftc === undefined
        ? 'parse skipped, no Swift toolchain on this host'
        : `all ${relativePaths.length} parse under swiftc -parse`;
    process.stdout.write(
      `packaged runner Swift: ok — ${relativePaths.length} files keep the checkout's line ` +
        `numbering; ${parse}.\n`,
    );
    return 0;
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
