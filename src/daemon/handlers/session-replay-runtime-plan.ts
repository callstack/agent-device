import type { CommandFlags } from '../../core/dispatch.ts';
import type { ReplayScriptMetadata } from '@agent-device/ad-script';

/**
 * #1555 review P1 ("digest/resume must also occur behind runAdReplay"): the
 * `--from`/`--plan-digest` resume-point math (`resolveReplayEntryIndex`) and
 * the digest-metadata reader that fed it (`readEffectiveReplayPlanDigestMetadata`,
 * `PendingRecordAndHeal`) moved into `@agent-device/ad-replay` —
 * `inspectAdReplay`'s manifest now exposes the digest as `planDigest` and the
 * resume math as a `resolveEntryIndex` closure, both computed from the SAME
 * effective platform/target precedence this file used to apply itself. Only
 * `buildReplayMetadataFlags` stays here: it builds the REQUEST's flags (used
 * throughout `runReplayScriptFile`, not just for the digest), which is a
 * daemon/wire concern the manifest has no reason to own.
 */
export function buildReplayMetadataFlags(
  flags: CommandFlags | undefined,
  metadata: ReplayScriptMetadata,
): CommandFlags {
  return {
    ...(flags ?? {}),
    ...(metadata.platform !== undefined && flags?.platform === undefined
      ? { platform: metadata.platform }
      : {}),
    ...(metadata.target !== undefined && flags?.target === undefined
      ? { target: metadata.target }
      : {}),
  };
}
