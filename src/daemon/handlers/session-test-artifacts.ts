import fs from 'node:fs';
import path from 'node:path';
import { isMaestroYamlPath } from '../../replay/format.ts';
import type { ReplayTestAttemptOutcome } from './session-test-types.ts';
import { SessionStore } from '../session-store.ts';

const DEFAULT_TEST_ARTIFACTS_ROOT = '.agent-device/test-artifacts';

export function resolveReplayTestArtifactsDir(params: {
  artifactsDir?: string;
  cwd?: string;
  suiteInvocationId: string;
}): string {
  const { artifactsDir, cwd, suiteInvocationId } = params;
  const resolvedRoot = SessionStore.expandHome(artifactsDir ?? DEFAULT_TEST_ARTIFACTS_ROOT, cwd);
  return path.join(resolvedRoot, suiteInvocationId);
}

export function buildReplayTestArtifactSlug(filePath: string, cwd?: string): string {
  const relativePath = cwd ? path.relative(cwd, filePath) : path.basename(filePath);
  const value =
    relativePath.length === 0 || relativePath.startsWith('..')
      ? path.basename(filePath)
      : relativePath;
  return (
    value
      .toLowerCase()
      .replace(/[\\/]+/g, '__')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'test'
  );
}

export function prepareReplayTestAttemptArtifacts(
  filePath: string,
  attemptArtifactsDir: string,
): void {
  fs.mkdirSync(attemptArtifactsDir, { recursive: true });
  copyReplaySourceFile(filePath, attemptArtifactsDir);
}

export function materializeReplayTestAttemptArtifacts(params: {
  outcome: ReplayTestAttemptOutcome;
  filePath: string;
  sessionName: string;
  attempts: number;
  maxAttempts: number;
  attemptArtifactsDir: string;
}): void {
  const { outcome, filePath, sessionName, attempts, maxAttempts, attemptArtifactsDir } = params;
  const passed = outcome.status === 'passed';
  const sourcePaths = [...new Set(outcome.artifactPaths)];
  if (outcome.status === 'failed' && typeof outcome.error.logPath === 'string') {
    sourcePaths.push(outcome.error.logPath);
  }
  const copiedArtifacts = copyReplayTestArtifacts(sourcePaths, attemptArtifactsDir);

  const lines = [
    `file: ${filePath}`,
    `session: ${sessionName}`,
    `attempt: ${attempts}/${maxAttempts}`,
    `status: ${passed ? 'passed' : 'failed'}`,
  ];

  if (outcome.status === 'passed') {
    lines.push(`replayed: ${outcome.replayed}`, `healed: ${outcome.healed}`);
  } else {
    lines.push(`code: ${outcome.error.code}`, `message: ${outcome.error.message}`);
    if (outcome.error.hint) lines.push(`hint: ${outcome.error.hint}`);
    if (outcome.error.diagnosticId) lines.push(`diagnosticId: ${outcome.error.diagnosticId}`);
    if (outcome.error.logPath) lines.push(`logPath: ${outcome.error.logPath}`);
    if (outcome.error.details?.reason === 'timeout') {
      lines.push('timeoutMode: cooperative');
    }
  }

  if (copiedArtifacts.length > 0) {
    lines.push(
      `copiedArtifacts: ${copiedArtifacts.map((entry) => path.basename(entry)).join(', ')}`,
    );
  }

  const resultPath = path.join(attemptArtifactsDir, 'result.txt');
  const output = `${lines.join('\n')}\n`;
  fs.writeFileSync(resultPath, output);
  if (!passed) {
    fs.writeFileSync(path.join(attemptArtifactsDir, 'failure.txt'), output);
  }
}

function copyReplayTestArtifacts(paths: string[], attemptArtifactsDir: string): string[] {
  const copiedPaths: string[] = [];
  const usedNames = new Map<string, number>();
  for (const sourcePath of paths) {
    if (!isExistingFile(sourcePath)) continue;
    const fileName = buildUniqueArtifactFileName(path.basename(sourcePath), usedNames);
    const destinationPath = path.join(attemptArtifactsDir, fileName);
    if (path.resolve(sourcePath) !== path.resolve(destinationPath)) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
    copiedPaths.push(destinationPath);
  }
  return copiedPaths;
}

function copyReplaySourceFile(filePath: string, attemptArtifactsDir: string): void {
  const genericReplayPath = path.join(attemptArtifactsDir, 'replay.ad');
  fs.copyFileSync(filePath, genericReplayPath);

  if (!isMaestroYamlPath(filePath)) return;
  // Keep replay.ad for existing artifact consumers, and preserve the original
  // Maestro filename so CI artifacts point back to the source flow.
  const originalReplayPath = path.join(attemptArtifactsDir, path.basename(filePath));
  if (path.resolve(originalReplayPath) !== path.resolve(genericReplayPath)) {
    fs.copyFileSync(filePath, originalReplayPath);
  }
}

function buildUniqueArtifactFileName(fileName: string, usedNames: Map<string, number>): string {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  const current = usedNames.get(fileName) ?? 0;
  usedNames.set(fileName, current + 1);
  if (current === 0) return fileName;
  return `${stem}-${current + 1}${extension}`;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
