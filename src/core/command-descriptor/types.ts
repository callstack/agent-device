import type { CommandCapability } from '../capabilities.ts';
import type { DaemonCommandDescriptor } from '../../daemon/daemon-command-registry.ts';
// The typed-flags request from contracts/, not the daemon's server-side refinement: these
// descriptors read `command`, `positionals` and `flags` and never touch `internal`.
import type { DispatchedCommand } from '@agent-device/contracts/command';
import type { PostActionObservationSupport } from './post-action-observation.ts';
import type { CommandPlatformExecution } from '@agent-device/contracts/platform';

export type ResponseDataFieldTransform = {
  defaultValue?: unknown;
  omitDefault?: boolean;
};

export type CommandResponseDataTransform = {
  fields: Record<string, ResponseDataFieldTransform>;
};

/**
 * The daemon route + request-policy traits for a command, minus the `command`
 * key (which is carried at the descriptor top level as `name`). This reuses the
 * existing hand-authored `DaemonCommandDescriptor` shape VERBATIM — including the
 * closure traits (`allowSessionlessDefaultDevice`, `skipSessionlessProviderDevice`)
 * — rather than flattening them into booleans.
 */
export type DaemonCommandTraits = Omit<DaemonCommandDescriptor, 'command'>;

/**
 * Where a command's user-facing time budget comes from. The policy lives on
 * command descriptors (ADR 0008); ADR 0011 moved the former timeout hand lists
 * onto that descriptor surface.
 *
 *  - `'none'`             — the command has no user-supplied budget; the request
 *                           envelope is exactly `envelopeMs`.
 *  - `'flag'`             — the `--timeout` flag (`flags.timeoutMs`). By default it
 *                           REPLACES the envelope (replay semantics: --timeout
 *                           bounds the request). With `envelope: 'widen'` it only
 *                           ever EXTENDS the envelope to envelopeMs + budget +
 *                           margin (interaction --settle semantics, #1101: the
 *                           flag bounds a post-action wait, so the request must
 *                           also cover selector/action overhead). `defaultBudgetMs`
 *                           is used when the feature flag is present but the
 *                           numeric timeout flag is omitted.
 *  - `'positional-parser'`— the budget travels inside the positionals; `parser`
 *                           extracts it (or returns null when none was given).
 *                           The client widens the envelope to
 *                           budget + margin, never shrinking below `envelopeMs`.
 */
export type CommandTimeoutBudget =
  | { source: 'none' }
  | { source: 'flag'; envelope?: 'bound' | 'widen'; defaultBudgetMs?: number }
  | { source: 'positional-parser'; parser: (positionals: string[]) => number | null };

/**
 * The request-envelope + on-timeout daemon policy for one command. This is what
 * used to live in two hand-maintained client lists (`isExplicitTimeoutCommand`
 * in daemon-client.ts and `DAEMON_PRESERVING_TIMEOUT_COMMANDS` in
 * daemon-client-timeout.ts) — the split that let `wait` fall through both
 * (#1075). Declared per descriptor so a new command must decide, and read by
 * the daemon client via `resolveCommandTimeoutPolicy`.
 *
 *  - `envelopeMs`  — the base client request envelope; `'unbounded'` disables the
 *                    client-side timeout entirely (only `test`, which streams
 *                    per-scenario progress and has its own budgets downstream).
 *  - `onTimeout`   — whether a timed-out request tears the local daemon down
 *                    (`'reset-daemon'`) or keeps it alive so sessions survive and
 *                    evidence commands still work (`'preserve-daemon'`; read-only
 *                    capture/polling commands that can block in platform
 *                    accessibility bridges).
 */
export type CommandTimeoutPolicy = {
  budget: CommandTimeoutBudget;
  envelopeMs: number | 'unbounded';
  onTimeout: 'preserve-daemon' | 'reset-daemon';
};

/**
 * #1320 "Command descriptor policy": what a command may do with the host-global
 * device claim store. REQUIRED on every descriptor (no default), and read by the
 * request-execution scope so enforcement is derived from the declaration rather
 * than from a per-handler call a new author can forget.
 *
 *  - `none`                — host/config-only; never binds a device.
 *  - `observe`             — device inventory/ownership projection; may report a
 *                            claim, never mutates one.
 *  - `require-owner`       — session-bound work; trusts the invariant `open`
 *                            established and does NO claim-store I/O.
 *  - `transient-exclusive` — sessionless device mutation; acquires a
 *                            command-scoped claim before device operations reach
 *                            the handler, refuses a foreign claim, and releases
 *                            in `finally`. Enforced at the request scope's
 *                            device binding, so it is available only to ADR 0019
 *                            `device-runtime` commands.
 *  - `acquire-session`     — `open`; acquires the session claim before platform
 *                            preparation or mutation.
 *  - `release-session`     — `close`; releases the session claim only after
 *                            teardown reaches a safe terminal state.
 */
export type DeviceClaimPolicy =
  | 'none'
  | 'observe'
  | 'require-owner'
  | 'transient-exclusive'
  | 'acquire-session'
  | 'release-session';

export type CommandCatalogGroup = 'public' | 'internal' | 'local-cli' | 'dispatch-alias';

/**
 * Which default tool set a framework adapter (`agent-device/ai-sdk`, the
 * planned `@agent-device/eve` package) includes a public command in.
 *  - `'core'`     — the small, curated perceive/act loop a typical tool-calling
 *                   agent needs by default: launch, observe, interact, read,
 *                   verify, wait, navigate, and system-dialog handling.
 *  - `'extended'` — everything else public: device/session management,
 *                   observability, recording/replay, and specialized or
 *                   destructive commands. Still available with an explicit
 *                   opt-in (e.g. `set: 'all'`), just excluded from the default
 *                   tool set so a model isn't handed dozens of rarely-needed
 *                   tools up front.
 * Declared per public command so the classification lives beside the rest of
 * that command's descriptor facets instead of a separate hand-maintained list
 * in the adapter code; `resolveCommandFrameworkTier` reads it back.
 */
export type CommandFrameworkTier = 'core' | 'extended';

export type CommandCatalogFacet = {
  /**
   * The command catalog group. This is explicit on every descriptor so new
   * descriptors cannot accidentally become public CLI/MCP commands by omission.
   */
  group: CommandCatalogGroup;
  /**
   * Stable property name used by catalog object projections, e.g.
   * `longPress` for the command name `longpress`.
   */
  key?: string;
};

export type CommandDispatchFacet = {
  /**
   * Platform dispatch command handled by src/core/dispatch.ts. The descriptor
   * name is the dispatched command; dispatch-only names such as `read` are
   * modeled as named descriptors rather than hidden aliases.
   */
} & Record<string, never>;

/**
 * ADR 0016: whether a recorded request changes app-visible state or only
 * observes it. The resolver form keeps subcommand-sensitive decisions on the
 * descriptor (for example, `alert get` versus `alert accept`).
 */
export type RecordingEffect = 'mutates-app' | 'observes-app';
export type CommandRecordingEffect =
  | RecordingEffect
  | ((req: DispatchedCommand) => RecordingEffect);

/**
 * ADR 0012 / #1349: when replay verifies a recorded `target-v1` annotation.
 * `pre-dispatch` — the step loop verifies against a fresh capture before
 * dispatch (touch/fill/get/is expect their target present). `post-resolution`
 * — the command's own resolution verifies (wait's polling loop, whose
 * landmark may legitimately be absent at step start); only decision 3 path 1
 * runs up front. Declared on every evidence-carrying command and pinned by
 * the parity test, so a new one must choose a phase explicitly.
 */
export type TargetIdentityVerification = 'pre-dispatch' | 'post-resolution';

/**
 * The single additive command-descriptor shape (ADR-0008, Phase 1 step 1).
 *
 * Per command this carries, side-by-side, the facts that today live in three
 * separate hand-authored tables:
 *  - `daemon`     — the daemon route + request-policy traits
 *                   (from DAEMON_COMMAND_DESCRIPTORS). Absent for commands that
 *                   have no daemon route (e.g. `app-switcher`, `install-from-source`).
 *  - `capability` — the optional platform/kind capability entry
 *                   (from BASE_COMMAND_CAPABILITY_MATRIX).
 *  - `batchable`  — whether the command is exposed through `batch`
 *                   (from STRUCTURED_BATCH_COMMAND_NAMES).
 *  - `mcpExposed` — whether the command is surfaced over MCP.
 *  - `timeoutPolicy` — the request-envelope budget source + on-timeout daemon
 *                   policy. REQUIRED on every entry — most commands share the
 *                   explicit `DEFAULT_TIMEOUT_POLICY` constant, but a new
 *                   command must say so rather than inherit silently.
 *  - `postActionObservation` — optional interaction observation trait for
 *                   commands that support `--settle`/`--verify`; consumed by
 *                   command surfaces and timeout policy instead of repeated
 *                   command-name lists.
 *  - `responseDataTransform` — optional public response data shaping rules for
 *                   command-owned fields in daemon responses. This keeps
 *                   response shaping on the same descriptor surface as other
 *                   command traits.
 *  - `catalog` — command identity projection metadata. Every descriptor
 *                   declares its catalog group explicitly.
 *  - `frameworkTier` — which default tool set a framework adapter includes a
 *                   public command in (see {@link CommandFrameworkTier}).
 *  - `dispatch` — whether src/core/dispatch.ts accepts this command name as a
 *                   platform dispatch target.
 *
 * The registry started dormant (proven byte-equal to the hand tables by the
 * parity tests) and is now the live source: the daemon registry, capability
 * matrix, batch allowlist, and the daemon client's timeout policy are all
 * built from it.
 */
type CommandDescriptorBase = {
  name: string;
  daemon?: DaemonCommandTraits;
  capability?: CommandCapability;
  batchable: boolean;
  mcpExposed: boolean;
  timeoutPolicy: CommandTimeoutPolicy;
  /**
   * #1320 device-claim policy. REQUIRED with no default so a new command must
   * classify itself; `transient-exclusive` is the only value that makes the
   * request scope touch the host-global claim store.
   */
  deviceClaimPolicy: DeviceClaimPolicy;
  postActionObservation?: PostActionObservationSupport;
  responseDataTransform?: CommandResponseDataTransform;
  catalog: CommandCatalogFacet;
  /** Required iff `catalog.group === 'public'`; see {@link CommandFrameworkTier}. */
  frameworkTier?: CommandFrameworkTier;
  dispatch?: CommandDispatchFacet;
  /** Internal-only ADR 0019 cutover discriminant; public projections must ignore it. */
  platformExecution: CommandPlatformExecution;
  /** ADR 0012 / #1349: present iff this command's recorded steps can carry `target-v1` evidence. */
  targetIdentityVerification?: TargetIdentityVerification;
  /**
   * Whether the command records an action into the active session replay script
   * by default, making `--no-record` meaningful. Declared on every raw descriptor
   * so the recording decision is explicit; the daemon `replayScopedAction` trait and
   * MCP `noRecord` schema projection are both derived from this value.
   */
};

export type CommandDescriptor = CommandDescriptorBase &
  (
    | {
        recordsSessionAction: true;
        /** Required for every recordable command; publication ordering consumes only this trait. */
        recordingEffect: CommandRecordingEffect;
      }
    | {
        recordsSessionAction: false;
        recordingEffect?: never;
      }
  );
