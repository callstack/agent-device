import fs from 'node:fs';
import type { DaemonResponse } from '../types.ts';

export function collectReplayActionArtifactPaths(response: DaemonResponse): string[] {
  const candidates = response.ok
    ? collectSuccessfulArtifactCandidates(response.data)
    : collectFailureArtifactCandidates(response.error.details?.artifactPaths);
  return uniqueExistingArtifactPaths(candidates);
}

type ReplayResponseData = Extract<DaemonResponse, { ok: true }>['data'];

function collectFailureArtifactCandidates(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function collectSuccessfulArtifactCandidates(data: ReplayResponseData): string[] {
  if (!data) return [];
  return [
    readString(data.path),
    readString(data.outPath),
    ...collectNestedArtifactCandidates(data.artifacts),
  ].filter(isString);
}

function collectNestedArtifactCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readNestedArtifactPath).filter(isString);
}

function readNestedArtifactPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  return readString(artifact.localPath) ?? readString(artifact.path);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function uniqueExistingArtifactPaths(candidates: string[]): string[] {
  return [...new Set(candidates.filter(isReplayArtifactPath))];
}

function isReplayArtifactPath(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
