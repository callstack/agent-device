/**
 * The interaction guarantee matrix (ADR 0011).
 *
 * Every dispatch path an interaction command can take must classify EVERY
 * guarantee: enforced by shared runtime code, enforced runner-side (with a
 * parity table once ADR 0011 phase 3 lands), delegated to another path,
 * inapplicable by construction, or explicitly waived with a reason.
 *
 * This registry plus its gate test is an HONESTY/COMPLETENESS gate, not a
 * truth gate: it proves every path has declared a stance and that referenced
 * symbols exist. Behavioral parity is only proven once the golden fixture
 * tables (Layer 2) and contract scenarios (Layer 3) land.
 *
 * The `Record` over the guarantee union makes completeness a compile error:
 * adding a guarantee refuses to build until every path classifies it, and a
 * new path cannot omit a cell. The companion gate test keeps the entries
 * honest (referenced symbols must exist, waivers must carry reasons, and
 * every `gap:` waiver must carry a tracking issue).
 *
 * Closure strategy for the acknowledged gaps is hybrid (see ADR 0011):
 * runner-side parity for cheap geometry-local rules; delegation-on-error for
 * semantic/rich-runtime failures (which is NOT success-path parity — cells
 * where the fast path can succeed on a candidate the runtime rules would
 * refuse stay gaps until proven); and a shared runtime preflight against the
 * already-captured snapshot node for the native-ref path, because a backend
 * fast path can silently succeed and delegation-on-error never triggers
 * (implemented: preflightNativeRefInteraction, #1081).
 */

export const INTERACTION_GUARANTEES = [
  // Mutating selectors collapse duplicate wrappers only when every match is
  // one ancestry chain resolving to the same actionable node. Distinct
  // subtrees fail with bounded, actionable candidates; geometry never wins.
  'disambiguation',
  // Targets covered by another visible element are refused.
  'occlusion',
  // Targets whose tap point sits behind the visible software keyboard are refused. The keyboard is
  // its own system surface, so `occlusion` cannot see it and `offscreen` passes it (#2589).
  'keyboardOcclusion',
  // Element-targeted coordinate paths keep the resolved parent identity while
  // choosing a point outside independently interactive descendants. A parent
  // whose safe region is fully tiled fails closed instead of activating a child.
  'parentOwnedTouchPoint',
  // The tap point (rect center) must lie inside the root viewport; closed
  // drawers / off-viewport carousels are refused, not silently no-op tapped.
  'offscreen',
  // Non-hittable targets are promoted to a hittable ancestor when possible
  // and annotated (targetHittable/hint) when not.
  'nonHittable',
  // Response payloads are assembled by a single shared construction site,
  // never hand-rolled per branch (the class of bug that dropped fill @ref
  // evidence). Closed by ADR 0011 Layer 2: buildInteractionResponseData plus
  // the hand-rolled-literal guard test.
  'responseConstruction',
  // The identity fields a path can echo back: refLabel, selectorChain, the
  // resolved target. Distinct from construction — a path may build responses
  // through the shared site yet be unable to provide identity fields.
  'responseIdentity',
  // --verify captures a pre-action baseline and post-action digest.
  'verifyEvidence',
  // --settle (#1101) waits for the UI to go quiet after the action and returns
  // the settled diff vs the pre-action tree (plus refsGeneration when the
  // settled tree was stored) in the same response. Best-effort: never fails
  // the action.
  'settleObservation',
  // Failures use the shared codes/messages/hints (no-match diagnostics,
  // ambiguous shape, offscreen reasons). NOTE: expected to split into
  // errorCodes (stable codes / fallback classification) vs errorDiagnostics
  // (rich selector diagnostics and hints) once direct runner paths close
  // codes earlier than full diagnostics.
  'errorTaxonomy',
  // The additive `resolution` response field (ADR 0012 decision 2):
  // unique/disambiguated/exact/label-fallback/not-observed provenance,
  // pre-action diagnostics only — never ref-issued or MCP-pinned.
  'resolutionDisclosure',
  // How the path waits for the target to exist and become actionable before acting: a declared
  // budget under which a plain no-match keeps retrying, versus a target that must already exist at
  // dispatch time. Distinct from occlusion/offscreen/nonHittable, which judge a target already
  // found; this is about whether one is found at all.
  'targetReadiness',
  // What the path observes after dispatch to back its success claim, and whether that observation
  // is advisory (a hint the caller may ignore) or can change the response (a corroborated failure,
  // a settled diff). Distinct from the opt-in verifyEvidence/settleObservation features; this is the
  // path's baseline, always-on claim.
  'outcomeObservation',
] as const;

export type InteractionGuarantee = (typeof INTERACTION_GUARANTEES)[number];

export const INTERACTION_PATH_IDS = [
  'runtime-selector',
  'runtime-ref',
  'target-drag',
  'native-ref',
  'coordinate',
  'maestro-direct-selector',
  'maestro-non-hittable-fallback',
] as const;

export type InteractionPathId = (typeof INTERACTION_PATH_IDS)[number];

type GuaranteeEnforcementBase =
  | {
      kind: 'runtime';
      /** `<module path>#<exported symbol>` implementing the rule. */
      via: string;
    }
  | {
      kind: 'runner';
      /** Swift symbol implementing the rule runner-side. */
      via: string;
      /**
       * Golden fixture table proving TS/Swift parity. Optional until ADR 0011
       * Layer 3 lands; required once a runner cell claims parity.
       */
      parityTable?: string;
    }
  | {
      kind: 'delegated';
      to: InteractionPathId;
      /** How the delegation is triggered (flag, error fallback, ...). */
      via: string;
    }
  | {
      kind: 'inapplicable';
      reason: string;
    }
  | {
      kind: 'waived';
      reason: string;
      /** Required when the reason starts with `gap:` — waivers must be owned. */
      trackingIssue?: string;
    };

export type GuaranteeEnforcement = GuaranteeEnforcementBase & {
  /**
   * Command scoping: when a guarantee only applies to a subset of the path's
   * commands (e.g. --verify exists on press/click/fill but not longpress),
   * the cell names that subset instead of implying path-wide coverage. Must
   * be a non-empty subset of the path's `commands`; omitted = all commands.
   */
  appliesTo?: readonly string[];
};

export type InteractionPathContract = {
  description: string;
  commands: readonly string[];
  guarantees: Record<InteractionGuarantee, GuaranteeEnforcement>;
};

const GAPS_UMBRELLA_ISSUE = 'https://github.com/callstack/agent-device/issues/1081';
const PARENT_OWNED_TOUCH_POINT_GAP_ISSUE = 'https://github.com/callstack/agent-device/issues/1718';

// Every path shares the SAME cell by construction: response payloads have one
// construction site (ADR 0011 Layer 2), and the hand-rolled-literal guard test
// (interaction-response-construction-guard.test.ts) keeps new branches on it.
const SHARED_RESPONSE_CONSTRUCTION: GuaranteeEnforcement = {
  kind: 'runtime',
  via: 'src/daemon/interaction/internal/interaction-touch-response.ts#buildInteractionResponseData',
};

// runtime-selector, runtime-ref, and coordinate share this waiver: all three finalize through
// finalizeTouchInteraction, which calls markDeferredInteractionOutcome with the tap point, and none
// observes the outcome in its own response.
const TAP_OUTCOME_NOT_OBSERVED_GAP: GuaranteeEnforcement = {
  kind: 'waived',
  reason:
    'gap: the response reports the dispatch only; only opt-in --verify/--settle capture post-action evidence into it. The deferred marks set after dispatch (Android snapshot freshness after press/click, the no-change tap retry when the request sets interactionOutcome.retryOnNoChange, post-gesture stabilization when the request sets postGestureStabilization) are judged by the next capture, never in this response, and the iOS ambiguous-failure corroboration reconsiders only a thrown runner error.',
  trackingIssue: GAPS_UMBRELLA_ISSUE,
};

// Both Maestro-compatible fast paths (src/daemon/interaction/internal/interaction-touch-direct-ios.ts)
// dispatch ONE fused XCTest runner request (`command: 'tap'` with a selectorKey/selectorValue) built
// in packages/platform-apple/src/interactions.ts#tapElementSelector — not the separate
// packages/maestro/ flow-script engine, which drives standalone `.yaml` Maestro flows and never
// participates in an ordinary daemon click.
const DIRECT_IOS_SINGLE_QUERY_READINESS: GuaranteeEnforcement = {
  kind: 'waived',
  reason:
    "Intentional: the fused runner request performs a single XCTest selector/frame query per dispatch and does not itself retry for an as-yet-nonexistent target; a miss is a runner failure (see errorTaxonomy) rather than a wait, and delegation-on-error (ADR 0011) is a different path's guarantee, not a retry of this one.",
};

// Shares the SAME reasoning as TAP_OUTCOME_NOT_OBSERVED_GAP: the tap outcome is not observed on the
// success path here either. The shared ambiguous-XCTest-failure corroboration
// (src/daemon/interaction/internal/interaction-ios-tap-outcome.ts#corroborateIosTapFailure) is
// invoked identically from this fast path and from the tree-based runtime dispatch, but only ever
// reconsiders a THROWN error — it never validates a call that returned success, so it is not a
// baseline outcome claim for either path.
const DIRECT_IOS_OUTCOME_NOT_OBSERVED_GAP: GuaranteeEnforcement = {
  kind: 'waived',
  reason:
    "gap: this replay-only route observes no outcome beyond the runner's own report; --verify/--settle do not apply here (see the inapplicable cells on this row), and the shared ambiguous-failure corroboration only reconsiders a thrown error, never a successful dispatch.",
  trackingIssue: GAPS_UMBRELLA_ISSUE,
};

// The two runtime tree paths (selector and ref resolution) run the SAME shared
// guard/observation implementations; only how the target is found
// (disambiguation) and how failures are described (errorTaxonomy) differ.
const RUNTIME_TREE_SHARED_GUARANTEES = {
  // #1656: the decision point is the pipeline runner, which reads the acting
  // row's occlusion stage; isSnapshotNodeInteractionBlocked stays the
  // predicate it applies (and the annotation contract it reads).
  occlusion: {
    kind: 'runtime',
    via: 'packages/selectors/src/selector-pipeline.ts#runNodePipelineStages',
  },
  parentOwnedTouchPoint: {
    kind: 'runtime',
    via: 'packages/selectors/src/interaction-touch-point.ts#resolveInteractionTouchPoint',
  },
  // #2589: one guard for every acting node path, run at the shared pipeline door
  // (`runInteractionPipelineStages`), so the native-ref fast path cannot succeed on a target the
  // shared rule refuses. Its band is the one the capture's producer measured, or the one derived
  // from the tree the path already holds when the producer measured none (#2660): the keyboard is
  // never a covering sibling of app content and never leaves the app window rect, so neither
  // `occlusion` nor `offscreen` can reach it.
  keyboardOcclusion: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/keyboard-occlusion.ts#assertTapTargetClearOfVisibleKeyboard',
  },
  // #1542: the base decision is the contracts-owned snapshot visibility resolver (bulk accessibility
  // tree), but throwIfOffscreenInteractionTarget is the actual end-to-end
  // enforcement point — on iOS (local, non-provider sessions only) a would-be
  // refusal is re-checked against a live, tree-independent read via the
  // optional AgentDeviceBackend.confirmOffscreenTargetVisible hook before
  // erroring, and a confirmed rescue re-targets the action at the LIVE rect,
  // not the bulk one. Every other platform, and any backend that omits the
  // hook, refuses on the visibility resolver's verdict unchanged — this is a
  // rescue-only override, never a way to relax a genuine refusal.
  // The live read is a SEPARATE runner request (the direct querySelector), so
  // it shares the runner's prepareActiveCommandContext surface policy only with
  // a RUNNER-ROUTED capture: eligible simulator captures go to the host AX
  // bridge (packages/platform-apple/src/snapshot-route.ts), and a bridge-served
  // capture never reaches that seam. #2448 puts the system-surface case (the
  // web sign-in sheet) back on the runner, where both reads do share it. Either
  // way this is not a same-instant guarantee — no captured surface identity
  // crosses the two requests, so a surface that appears or dismisses between
  // them is undetected.
  offscreen: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/target-visibility-stages.ts#throwIfOffscreenInteractionTarget',
  },
  // Promotion runs only for rows that declare it (#1656); the retarget itself
  // is still resolveActionableTouchResolution.
  nonHittable: {
    kind: 'runtime',
    via: 'packages/selectors/src/selector-pipeline.ts#runNodePipelineStages',
  },
  responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
  responseIdentity: {
    kind: 'runtime',
    via: 'src/daemon/interaction/internal/interaction-touch-targets.ts#interactionResultExtra',
  },
  verifyEvidence: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/interactions.ts#pressCommand',
    appliesTo: ['press', 'click', 'fill'],
  },
  settleObservation: {
    kind: 'runtime',
    via: 'src/commands/interaction/runtime/settle.ts#settleAfterInteraction',
  },
} satisfies Partial<Record<InteractionGuarantee, GuaranteeEnforcement>>;

export const INTERACTION_DISPATCH_PATHS: Record<InteractionPathId, InteractionPathContract> = {
  'runtime-selector': {
    description: 'Daemon tree capture, selector chain resolution, guarded coordinate tap.',
    commands: ['press', 'click', 'fill', 'longpress', 'hover'],
    guarantees: {
      ...RUNTIME_TREE_SHARED_GUARANTEES,
      disambiguation: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      // Full pre-action diagnostic shape; equivalent wrapper chains disclose
      // their structural collapse, while distinct subtrees never succeed.
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      // press/click/longpress poll the promotedTarget row's readiness budget only when the caller
      // supplies readinessTimeoutMs (never model- or CLI-writable), capped at the row's
      // maxTimeoutMs; fill/hover resolve against the resolvedTarget row, which declares no poll budget.
      targetReadiness: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-readiness.ts#pollForSelectorReadiness',
        appliesTo: ['press', 'click', 'longpress'],
      },
      outcomeObservation: TAP_OUTCOME_NOT_OBSERVED_GAP,
    },
  },
  'runtime-ref': {
    description:
      'Session snapshot ref lookup, guarded coordinate tap. #1654: when the caller already resolved the node (a mutating `find`), the lookup is replaced by that node and every guarantee below is enforced against it — the guards are unchanged, only the lookup is skipped.',
    commands: ['press', 'click', 'fill', 'longpress', 'hover'],
    guarantees: {
      ...RUNTIME_TREE_SHARED_GUARANTEES,
      disambiguation: {
        kind: 'waived',
        reason:
          'Intentional: a resolved @ref names exactly one node, but the replay trailing-label recovery resolves a stale @ref by FIRST label match without the visible/deepest/smallest ranking; that outcome is disclosed per-response as resolutionDisclosure label-fallback rather than silently claiming exactness.',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/selectors/src/internal/resolve.ts#STALE_REF_HINT',
      },
      // ADR 0012 decision 2: the shared builder produces both outcomes — exact
      // for an ordinary or pre-resolved @ref, label-fallback only for trailing-
      // label recovery. The pre-resolved path validates carried ref/node/tree
      // provenance before it can claim exact.
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution-disclosure.ts#buildRefResolution',
      },
      targetReadiness: {
        kind: 'inapplicable',
        reason:
          'A resolved @ref names exactly one node in its authorized frame; ADR 0014 fails a stale or unusable ref at once instead of waiting for a fresher observation to authorize it, so there is no existence budget to poll under.',
      },
      outcomeObservation: TAP_OUTCOME_NOT_OBSERVED_GAP,
    },
  },
  'target-drag': {
    description:
      'Target-authored gesture drag resolves source and destination independently through the runtime tree, verifies both identities on replay, then dispatches one uninterrupted pointer plan.',
    commands: ['gesture'],
    guarantees: {
      disambiguation: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/selector-action-resolution.ts#resolveActionSelector',
      },
      occlusion: {
        kind: 'runtime',
        via: 'packages/selectors/src/selector-pipeline.ts#runNodePipelineStages',
      },
      parentOwnedTouchPoint: {
        kind: 'runtime',
        via: 'packages/selectors/src/interaction-touch-point.ts#resolveInteractionTouchPoint',
      },
      keyboardOcclusion: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/keyboard-occlusion.ts#assertTapTargetClearOfVisibleKeyboard',
      },
      offscreen: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/target-visibility-stages.ts#throwIfOffscreenInteractionTarget',
      },
      nonHittable: {
        kind: 'inapplicable',
        reason:
          'Drag endpoints name contact coordinates and intentionally need not be independently tappable controls; covered, keyboard-occluded, and off-screen endpoints are still refused.',
      },
      responseConstruction: {
        kind: 'runtime',
        via: 'src/daemon/interaction/internal/interaction-gesture-response.ts#gestureResponseData',
      },
      responseIdentity: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/gestures.ts#dragCommand',
      },
      verifyEvidence: {
        kind: 'inapplicable',
        reason: 'Target-authored drag has replay identity evidence but does not expose --verify.',
      },
      settleObservation: {
        kind: 'inapplicable',
        reason:
          'Target-authored drag does not expose --settle; callers can wait on the destination state.',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/selectors/src/internal/resolve.ts#formatSelectorFailure',
      },
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/gestures.ts#dragCommand',
      },
      targetReadiness: {
        kind: 'inapplicable',
        reason:
          'Both endpoints resolve through the resolvedTarget row, which declares no poll budget; only the promotedTarget row carries a readiness budget.',
      },
      outcomeObservation: {
        kind: 'waived',
        reason:
          'gap: target-authored drag has no --settle/--verify observation of the destination; the tap-shaped runtime paths are the only ones with an opt-in evidence route today.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
    },
  },
  'native-ref': {
    // WEB-ONLY in production: apple/android backends never define
    // tapTarget/fillTarget/hoverTarget - the sole wiring is the web provider's
    // clickRef/fillRef/hoverRef (stable DOM-handle actions). Verified
    // 2026-07-04 while designing the #1088 retirement experiment, which this
    // finding dissolved: there is no iOS runner round trip to retire.
    description:
      'click @ref / fill @ref / hover @ref dispatch through the bound touch operation, whose web runtime owner selects clickRef/fillRef/hoverRef internally; no mobile owner advertises native-ref support. The route bypasses runtime resolution when no non-default options are set. A zero-round-trip preflight (preflightNativeRefInteraction) runs the shared guards against the stored session snapshot node first; no snapshot / no usable rect makes the preflight a no-op.',
    commands: ['click', 'fill', 'hover'],
    guarantees: {
      disambiguation: {
        kind: 'inapplicable',
        reason: 'Refs identify exactly one node by construction.',
      },
      occlusion: {
        kind: 'runtime',
        via: 'packages/selectors/src/selector-pipeline.ts#runNodePipelineStages',
      },
      // Same door as the runtime tree paths: the preflight IS `runInteractionPipelineStages`, so
      // the keyboard guard runs before the backend call even though `occlusion` above is served by
      // the snapshot annotation the pipeline reads.
      keyboardOcclusion: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/keyboard-occlusion.ts#assertTapTargetClearOfVisibleKeyboard',
      },
      parentOwnedTouchPoint: {
        kind: 'inapplicable',
        reason:
          'The native web ref path activates a provider-owned semantic handle rather than choosing a coordinate from the daemon snapshot.',
      },
      // Same enforcement point as the runtime-tree paths (#1542): the
      // preflight guard IS throwIfOffscreenInteractionTarget, which can
      // rescue via the optional iOS confirmOffscreenTargetVisible hook — see
      // the comment on RUNTIME_TREE_SHARED_GUARANTEES.offscreen above. This
      // path is web-only in production (no mobile backend implements
      // tapTarget/fillTarget), so the rescue hook never fires here in
      // practice, but the code path is identical.
      offscreen: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/target-visibility-stages.ts#throwIfOffscreenInteractionTarget',
      },
      // Annotation only (targetHittable/hint on the result): promotion to a
      // hittable ancestor stays a runtime-path behavior — the preflight never
      // changes which element the backend acts on.
      nonHittable: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/native-ref-interaction.ts#preflightNativeRefInteraction',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'runtime',
        via: 'src/daemon/interaction/internal/interaction-touch-targets.ts#interactionResultExtra',
      },
      verifyEvidence: {
        kind: 'delegated',
        to: 'runtime-ref',
        via: '--verify disables the native ref fast path when the descriptor post-action observation trait supports verify evidence',
      },
      settleObservation: {
        kind: 'delegated',
        to: 'runtime-ref',
        via: '--settle disables the native ref fast path when the descriptor post-action observation trait supports settle observation — settling needs the tree-based baseline and captures',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/selectors/src/internal/resolve.ts#STALE_REF_HINT',
      },
      // An @ref names exactly one node by construction (same cell as runtime-ref).
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution-disclosure.ts#EXACT_REF_RESOLUTION',
      },
      targetReadiness: {
        kind: 'waived',
        reason:
          "Intentional: the fast path dispatches to the web provider's own element handle (clickRef/fillRef/hoverRef), which owns its own auto-wait/actionability semantics outside this repo. The shared preflight still refuses an already-resolved node that fails occlusion/offscreen/keyboard; it does not wait for one to first exist.",
      },
      outcomeObservation: {
        kind: 'waived',
        reason:
          'gap: the fast path observes no post-action outcome by default; --settle/--verify disable it and delegate to runtime-ref instead of running here.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
    },
  },
  coordinate: {
    description: 'Raw x/y tap. Semantics are intentionally minimal.',
    commands: ['press', 'click', 'fill', 'longpress', 'hover'],
    guarantees: {
      disambiguation: {
        kind: 'inapplicable',
        reason: 'Coordinates name a point, not an element.',
      },
      occlusion: {
        kind: 'inapplicable',
        reason: 'Coordinates bypass element semantics by design (escape hatch).',
      },
      parentOwnedTouchPoint: {
        kind: 'inapplicable',
        reason: 'Coordinates name the exact point to activate; no parent element is resolved.',
      },
      // The classifier runs, and the refusal reason reaches the response as a warning instead of an
      // error: coordinates are the escape hatch that still reaches a keyboard's own control, and
      // this path never captures the tree the band is measured against, so a refusal would trust an
      // arbitrarily stale snapshot. See `describeKeyboardOccludedPointWarning`.
      keyboardOcclusion: {
        kind: 'waived',
        reason:
          'Intentional: a raw point carries no element identity to excuse a deliberate keyboard tap, and the point is checked against the last-known tree rather than one captured for this action. The shared decision still runs and publishes `tap_keyboard_occludes_target` in the response warning.',
      },
      offscreen: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#resolveInteractionTarget',
      },
      nonHittable: {
        kind: 'inapplicable',
        reason: 'No element to promote or annotate.',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'inapplicable',
        reason: 'No resolved node, so no refLabel/selectorChain.',
      },
      verifyEvidence: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/resolution.ts#resolveInteractionTarget',
        appliesTo: ['press', 'click', 'fill'],
      },
      settleObservation: {
        kind: 'runtime',
        via: 'src/commands/interaction/runtime/settle.ts#settleAfterInteraction',
      },
      errorTaxonomy: {
        kind: 'runtime',
        via: 'packages/kernel/src/errors.ts#normalizeError',
      },
      resolutionDisclosure: {
        kind: 'inapplicable',
        reason: 'Coordinates name a point; no element was resolved to disclose.',
      },
      targetReadiness: {
        kind: 'inapplicable',
        reason:
          'Coordinates name a point, not an element; there is no target existence to wait for.',
      },
      outcomeObservation: TAP_OUTCOME_NOT_OBSERVED_GAP,
    },
  },
  'maestro-direct-selector': {
    description:
      'An explicit Maestro-compatible simple-selector click completed as an XCTest element tap. This path is selected only when the runner was allowed to use the non-hittable coordinate fallback but reported that it did not use it.',
    commands: ['click'],
    guarantees: {
      disambiguation: {
        kind: 'waived',
        reason:
          'Intentional: Maestro replay uses its expected-point compatibility scan rather than runtime structural-equivalence-or-reject semantics.',
      },
      occlusion: {
        kind: 'waived',
        reason:
          'Intentional: the direct element-tap outcome relies on XCTest hittability instead of the daemon snapshot occlusion classifier.',
      },
      keyboardOcclusion: {
        kind: 'waived',
        reason:
          'Intentional: the fused runner element tap never sees a daemon tree, so no band can be derived; the daemon-resolved sibling paths refuse the same target.',
      },
      parentOwnedTouchPoint: {
        kind: 'waived',
        reason:
          'gap: the runner has the matched element but no daemon snapshot tree from which to exclude independently interactive descendants.',
        trackingIssue: PARENT_OWNED_TOUCH_POINT_GAP_ISSUE,
      },
      offscreen: {
        kind: 'waived',
        reason:
          'Intentional: successful direct element taps rely on XCTest hittability instead of the daemon viewport rule.',
      },
      nonHittable: {
        kind: 'inapplicable',
        reason:
          'A non-hittable candidate that succeeds does so through the separate maestro-non-hittable-fallback path.',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'waived',
        reason:
          'gap: the fused runner request does not return daemon refLabel or selectorChain fields.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
      verifyEvidence: {
        kind: 'inapplicable',
        reason: 'The eligibility gate excludes --verify from this replay-only route.',
      },
      settleObservation: {
        kind: 'inapplicable',
        reason: 'The eligibility gate excludes --settle from this replay-only route.',
      },
      errorTaxonomy: {
        kind: 'waived',
        reason: 'gap: Maestro preserves the runner-native direct-selector error shapes.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
      resolutionDisclosure: {
        kind: 'runtime',
        via: 'src/daemon/interaction/internal/interaction-touch-response.ts#buildInteractionResponseData',
      },
      targetReadiness: DIRECT_IOS_SINGLE_QUERY_READINESS,
      outcomeObservation: DIRECT_IOS_OUTCOME_NOT_OBSERVED_GAP,
    },
  },
  'maestro-non-hittable-fallback': {
    description:
      'Replay-only coordinate fallback for non-hittable elements (allowNonHittableCoordinateFallback), matching Maestro semantics.',
    commands: ['press', 'click', 'fill'],
    guarantees: {
      disambiguation: {
        kind: 'waived',
        reason:
          'Intentional: Maestro replay matches by its expected-point/non-hittable compatibility scan (findElement), a deliberate divergence from runtime structural-equivalence-or-reject semantics.',
      },
      occlusion: {
        kind: 'waived',
        reason: 'Intentional: Maestro taps resolved bounds regardless of overlay state.',
      },
      keyboardOcclusion: {
        kind: 'waived',
        reason:
          'Intentional: shares the occlusion waiver above — Maestro taps resolved bounds regardless of what overlays them.',
      },
      parentOwnedTouchPoint: {
        kind: 'waived',
        reason:
          'gap: Maestro compatibility executes the matched element center runner-side without a daemon snapshot tree of independently interactive descendants.',
        trackingIssue: PARENT_OWNED_TOUCH_POINT_GAP_ISSUE,
      },
      offscreen: {
        // hasTappableFrame keeps two path-specific choices (empty element
        // frames are refused; app.frame is the frame source, Maestro-style)
        // but its center-in-frame decision is the shared TapPointPolicy.
        kind: 'runner',
        via: 'RunnerTests+Interaction.swift#hasTappableFrame',
        parityTable: 'contracts/fixtures/tap-point-policy.json',
      },
      nonHittable: {
        kind: 'waived',
        reason: 'Intentional: the entire point of this path is tapping non-hittable elements.',
      },
      responseConstruction: SHARED_RESPONSE_CONSTRUCTION,
      responseIdentity: {
        kind: 'waived',
        reason: 'Intentional: replay-only path; Maestro semantics do not consume identity fields.',
      },
      verifyEvidence: {
        kind: 'inapplicable',
        reason: 'Replay-only path; --verify is not part of replay semantics.',
      },
      settleObservation: {
        kind: 'inapplicable',
        reason: 'Replay-only path; --settle is not part of replay semantics.',
      },
      errorTaxonomy: {
        kind: 'waived',
        reason: 'gap: shares the direct path error shapes, including their missing hints.',
        trackingIssue: GAPS_UMBRELLA_ISSUE,
      },
      resolutionDisclosure: {
        kind: 'inapplicable',
        reason:
          'Maestro owns matching; the fallback is coordinate execution. Cell membership is usage-based: only a dispatch whose runner actually executed the coordinate fallback is this path — allowed-but-not-taken is the direct path and discloses not-observed.',
      },
      targetReadiness: DIRECT_IOS_SINGLE_QUERY_READINESS,
      outcomeObservation: DIRECT_IOS_OUTCOME_NOT_OBSERVED_GAP,
    },
  },
};
