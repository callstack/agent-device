import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRawResult } from './schema.ts';
import type { BenchmarkResult } from './types.ts';

/**
 * Each corpus is pinned by an annotated tag on the mutable `evidence/ios-snapshot` branch tip plus
 * the full evidence commit below. Re-tag (a new suffix, a new commit) if a corpus is ever
 * re-measured — never move these tags.
 */
export type PublishedCorpus = {
  /** Revision the leg measured, as a full SHA. */
  revision: string;
  /** Durable ref the corpus is fetched from. */
  tag: string;
  /** Evidence-branch commit holding the files. */
  commit: string;
  /** Corpus file name -> sha256. */
  files: Readonly<Record<string, string>>;
};

const BASELINE_CORPUS: PublishedCorpus = {
  revision: '71fb2483f30d90e615e949601c836aeebbf450c5',
  tag: 'refs/tags/evidence/ios-snapshot/71fb2483f',
  commit: '2d4baf461aa8897d49c6d4683cd16d8f43588ae8',
  files: {
    'ios-snapshot-cold-local-71fb2483f.json':
      '532a83247bfbf8ee47039f80ac429f067c84679e92c781768c1044da1ae6e9bf',
    'ios-snapshot-warm-relaunch-local-71fb2483f.json':
      '6d299e8baec69662dca2c1ad8f1348e4361d5afaa781080e9a6b9b3dac362cbf',
    'ios-snapshot-proxy-71fb2483f.json':
      'b11b7a07be9e4dcf003f3af66943682a6733c6f21f5f43d3d9e88b3fb37b51a7',
  },
};

const CONVERGENCE_FINAL_CORPUS: PublishedCorpus = {
  revision: '7c434b575837e3291c51315bf9bb8b54c8ce7568',
  tag: 'refs/tags/evidence/ios-snapshot/7c434b575',
  commit: '96d4951c19fbe009ba19d192a9774668edcc3f56',
  files: {
    'ios-snapshot-cold-local-7c434b575.json':
      '4663897ee5104569ad54e2ac803c216b284280c1c70fd82a8b2cf7b675d8a8bd',
    'ios-snapshot-first-interaction-local-7c434b575.json':
      '87c686336f5581e3f18111e160cf7b733cd726b41e79ed6d8e5b53e2ab40c3fb',
    'ios-snapshot-warm-relaunch-local-7c434b575.json':
      'd49df3c3c943178f016a2b958449b257c6d46a44c8ffdf8fab75c1634ae1ebce',
    'ios-snapshot-proxy-7c434b575.json':
      '5b5353831851f3a0f60e19d6bfd0cf50db47c3c4db52a283024c10bb17e71573',
  },
};

export const PUBLISHED_CORPORA: readonly PublishedCorpus[] = [
  BASELINE_CORPUS,
  CONVERGENCE_FINAL_CORPUS,
];

/** Raw results published on the evidence branch, keyed by file name across every corpus. */
export const PUBLISHED_EVIDENCE: Readonly<Record<string, string>> = Object.fromEntries(
  PUBLISHED_CORPORA.flatMap((corpus) => Object.entries(corpus.files)),
);
export const DEFAULT_EVIDENCE_DIR = path.join(import.meta.dirname, 'evidence');
export const EVIDENCE_FIXTURE_PATH = path.join(import.meta.dirname, 'evidence-fixture.v1.json');

export type EvidenceFile = {
  file: string;
  sha256: string;
  published: 'match' | 'mismatch' | 'unlisted';
  revision: string | null;
  status: BenchmarkResult['status'] | null;
  cells: number;
  errors: string[];
};

function corpusFetchCommand(corpus: PublishedCorpus, file: string): string {
  const destination = path.posix.join('scripts/ios-snapshot-benchmark/evidence', file);
  return `git show ${corpus.commit}:${file} > ${destination}`;
}

/**
 * The fetch recipe for one corpus file. An unknown name falls back to the newest corpus, which is
 * what a generic hint should recommend.
 */
export function fetchEvidenceCommand(file = '<file>'): string {
  const corpus =
    PUBLISHED_CORPORA.find((candidate) => file in candidate.files) ?? PUBLISHED_CORPORA.at(-1)!;
  return `git fetch origin ${corpus.tag} && ${corpusFetchCommand(corpus, file)}`;
}

/** One shell line per corpus that holds any of `files`, so a hint never names the wrong commit. */
function fetchEvidenceCommands(files: readonly string[]): string {
  const lines: string[] = [];
  for (const corpus of PUBLISHED_CORPORA) {
    const missing = files.filter((file) => file in corpus.files);
    if (missing.length === 0) continue;
    const fetches = missing.map((file) => corpusFetchCommand(corpus, file));
    lines.push(`git fetch origin ${corpus.tag} && ${fetches.join(' && ')}`);
  }
  return lines.join('\n');
}

export function listEvidenceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

export function readEvidenceFile(filePath: string): EvidenceFile {
  const file = path.basename(filePath);
  const bytes = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const parsed = parseJson(bytes.toString('utf8'));
  const errors = parsed.ok ? validateRawResult(parsed.value) : [parsed.error];
  const result = parsed.ok && errors.length === 0 ? (parsed.value as BenchmarkResult) : null;
  return {
    file,
    sha256,
    published: publishedState(file, sha256),
    revision: result?.revision.commit ?? null,
    status: result?.status ?? null,
    cells: result?.measurements.length ?? 0,
    errors,
  };
}

export function readEvidenceDir(dir: string): EvidenceFile[] {
  return listEvidenceFiles(dir).map((file) => readEvidenceFile(path.join(dir, file)));
}

export function renderEvidenceReport(dir: string, files: EvidenceFile[]): string {
  const lines = [`Evidence directory: ${dir}`];
  for (const entry of files) {
    lines.push(
      `- ${entry.file}: ${entry.errors.length === 0 ? 'valid' : 'INVALID'}; ` +
        `revision ${entry.revision ?? '–'}; status ${entry.status ?? '–'}; ` +
        `${entry.cells} cells; sha256 ${entry.sha256} (${entry.published})`,
      ...entry.errors.map((error) => `    ${error}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function publishedState(file: string, sha256: string): EvidenceFile['published'] {
  const expected = PUBLISHED_EVIDENCE[file];
  if (expected === undefined) return 'unlisted';
  return expected === sha256 ? 'match' : 'mismatch';
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : error}` };
  }
}

/**
 * --evidence-dir intentionally stays permissive: a custom directory (a fresh --out location, a
 * partial re-check) is not required to hold the complete published corpus. Only the default
 * directory — the one this repo ships evidence into — is held to the full PUBLISHED_EVIDENCE
 * filename set.
 */
function readEvidenceDirOption(argv: string[]): { dir: string; isDefault: boolean } {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  if (normalized.length === 0) return { dir: DEFAULT_EVIDENCE_DIR, isDefault: true };
  if (normalized[0] === '--evidence-dir' && normalized[1] && normalized.length === 2) {
    return { dir: path.resolve(normalized[1]), isDefault: false };
  }
  throw new Error('Usage: pnpm bench:ios-snapshot:evidence -- [--evidence-dir <dir>]');
}

function missingPublishedEvidence(files: EvidenceFile[]): string[] {
  const present = new Set(files.map((entry) => entry.file));
  return Object.keys(PUBLISHED_EVIDENCE).filter((file) => !present.has(file));
}

/**
 * Throws on schema/hash rejects, always. Throws on an incomplete corpus only when `isDefault` is
 * set — the default directory must hold the full published filename set; an explicit
 * --evidence-dir stays permissive by design (see readEvidenceDirOption).
 */
export function checkEvidenceCorpus(dir: string, files: EvidenceFile[], isDefault: boolean): void {
  const rejected = files.filter(
    (entry) => entry.errors.length > 0 || entry.published === 'mismatch',
  );
  if (rejected.length > 0) {
    throw new Error(`${rejected.length} evidence file(s) failed validation.`);
  }
  if (isDefault) {
    const missing = missingPublishedEvidence(files);
    if (missing.length > 0) {
      throw new Error(
        `${dir} is missing published evidence file(s): ${missing.join(', ')}.\n` +
          `Fetch them with:\n${fetchEvidenceCommands(missing)}`,
      );
    }
  }
}

function runEvidenceReport(argv: string[]): void {
  const { dir, isDefault } = readEvidenceDirOption(argv);
  const files = readEvidenceDir(dir);
  if (files.length === 0) {
    throw new Error(
      `${dir} holds no evidence; fetch it with:\n` +
        `${fetchEvidenceCommands(Object.keys(PUBLISHED_EVIDENCE))}`,
    );
  }
  process.stdout.write(renderEvidenceReport(dir, files));
  checkEvidenceCorpus(dir, files, isDefault);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runEvidenceReport(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
