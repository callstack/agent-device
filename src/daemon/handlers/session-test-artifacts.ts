import fs from 'node:fs';
import path from 'node:path';
import { isMaestroYamlPath } from '../../replay/format.ts';
import type { DaemonResponse } from '../types.ts';
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
  response: DaemonResponse;
  filePath: string;
  sessionName: string;
  attempts: number;
  maxAttempts: number;
  attemptArtifactsDir: string;
}): void {
  const { response, filePath, sessionName, attempts, maxAttempts, attemptArtifactsDir } = params;
  const artifactPaths = getReplayTestArtifactPaths(response);
  const sourcePaths = [...artifactPaths];
  if (!response.ok && typeof response.error.logPath === 'string') {
    sourcePaths.push(response.error.logPath);
  }
  const copiedArtifacts = copyReplayTestArtifacts(sourcePaths, attemptArtifactsDir);

  const lines = [
    `file: ${filePath}`,
    `session: ${sessionName}`,
    `attempt: ${attempts}/${maxAttempts}`,
    `status: ${response.ok ? 'passed' : 'failed'}`,
  ];

  if (response.ok) {
    const replayed = typeof response.data?.replayed === 'number' ? response.data.replayed : 0;
    const healed = typeof response.data?.healed === 'number' ? response.data.healed : 0;
    lines.push(`replayed: ${replayed}`, `healed: ${healed}`);
  } else {
    lines.push(`code: ${response.error.code}`, `message: ${response.error.message}`);
    if (response.error.hint) lines.push(`hint: ${response.error.hint}`);
    if (response.error.diagnosticId) lines.push(`diagnosticId: ${response.error.diagnosticId}`);
    if (response.error.logPath) lines.push(`logPath: ${response.error.logPath}`);
    if (response.error.details?.reason === 'timeout') {
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
  if (!response.ok) {
    fs.writeFileSync(path.join(attemptArtifactsDir, 'failure.txt'), output);
  }
}

function getReplayTestArtifactPaths(response: DaemonResponse): string[] {
  const raw = response.ok
    ? (response.data as Record<string, unknown> | undefined)?.artifactPaths
    : response.error.details?.artifactPaths;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((entry): entry is string => typeof entry === 'string'))];
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
