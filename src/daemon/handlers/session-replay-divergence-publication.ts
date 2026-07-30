import fs from 'node:fs';
import path from 'node:path';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import { boundReplayDivergence, type ReplayDivergence } from '../../replay/divergence.ts';
import {
  bindInternalObservationAuthority,
  type InternalObservationEvidence,
} from '../internal-observation.ts';
import { SessionStore } from '../session-store.ts';

/**
 * Daemon-owned replay projection and publication boundary. The response or
 * overflow artifact is projected first; ref authority is then activated
 * synchronously from that exact successful projection.
 */
export function boundReplayDivergenceForSession(params: {
  sessionStore: SessionStore;
  sessionName: string;
  divergence: ReplayDivergence;
  responseLevel: ResponseLevel | undefined;
  evidence: InternalObservationEvidence | undefined;
  signal?: AbortSignal;
}): ReplayDivergence {
  const { sessionStore, sessionName, divergence, responseLevel } = params;
  let overflowProjection: ReplayDivergence | undefined;
  let overflowArtifactPath: string | undefined;
  const bounded = boundReplayDivergence({
    divergence,
    level: responseLevel,
    writeOverflowArtifact: (payload) => {
      const artifactProjection = redactDiagnosticData(payload);
      const result = writeReplayDivergenceArtifact(sessionStore, sessionName, artifactProjection);
      if ('artifactPath' in result) {
        overflowProjection = artifactProjection;
        overflowArtifactPath = result.artifactPath;
      }
      return result;
    },
  });
  const projection = overflowProjection ?? bounded;
  const screen = projection.screen;
  if (screen.state !== 'available' || screen.refs.length === 0) {
    if (params.evidence) {
      bindInternalObservationAuthority({
        sessionStore,
        sessionName,
        ...(params.signal ? { signal: params.signal } : {}),
      }).finalize(params.evidence, {
        refsGeneration: screen.state === 'available' ? screen.refsGeneration : undefined,
        refs: [],
      });
    }
    return bounded;
  }
  if (!params.evidence) {
    removeUnpublishedOverflowArtifact(overflowArtifactPath);
    return suppressUnpublishedDivergenceRefs(bounded, 'missing-evidence');
  }

  const observationAuthority = bindInternalObservationAuthority({
    sessionStore,
    sessionName,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const publication = observationAuthority.finalize(params.evidence, {
    refsGeneration: screen.refsGeneration,
    refs: screen.refs.map((entry) => entry.ref),
  });
  if (publication.published === true) return bounded;

  removeUnpublishedOverflowArtifact(overflowArtifactPath);
  return suppressUnpublishedDivergenceRefs(bounded, publication.reason);
}

function suppressUnpublishedDivergenceRefs(
  divergence: ReplayDivergence,
  reason: 'missing-evidence' | 'empty' | 'cancelled' | 'stale-capture' | 'invalid-projection',
): ReplayDivergence {
  const { overflow: _overflow, ...withoutOverflow } = divergence;
  return {
    ...withoutOverflow,
    screen: {
      state: 'unavailable',
      reason: `ref-publication-${reason}`,
      hint: 'The replay observation changed before its refs could be published. Take a new snapshot before targeting an element.',
    },
    suggestions: divergence.suggestions.map(({ ref: _ref, ...suggestion }) => suggestion),
    ...(divergence.targetBinding
      ? {
          targetBinding: {
            ...divergence.targetBinding,
            candidates: divergence.targetBinding.candidates.map(
              ({ ref: _ref, ...candidate }) => candidate,
            ),
          },
        }
      : {}),
  };
}

function removeUnpublishedOverflowArtifact(artifactPath: string | undefined): void {
  if (!artifactPath) return;
  try {
    fs.unlinkSync(artifactPath);
  } catch {
    // The unreturned path is not exposed to the caller. Cleanup is best effort.
  }
}

function writeReplayDivergenceArtifact(
  sessionStore: SessionStore,
  sessionName: string,
  payload: ReplayDivergence,
): { artifactPath: string } | { artifactUnavailable: true } {
  try {
    const dir = path.join(sessionStore.ensureSessionDir(sessionName), 'replay-divergence');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${Date.now()}-step${payload.step.index}.json`;
    const artifactPath = path.join(dir, fileName);
    fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
    return { artifactPath };
  } catch {
    return { artifactUnavailable: true };
  }
}
