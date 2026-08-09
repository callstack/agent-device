import {
  AMBIGUOUS_MATCH_SAMPLE,
  APP_NOT_INSTALLED_SAMPLE,
  BROWSERSTACK_CONNECT_SAMPLE,
  DEVICE_IN_USE_SAMPLE,
  FOREGROUND_SNAPSHOT_FAILURE_SAMPLE,
  MERGED_CARD_ACTIONS_SAMPLE,
  NOT_SETTLED_SAMPLE,
  OFFSCREEN_TARGET_SNAPSHOT_SAMPLE,
  SETTLE_DIFF_SAMPLE,
  SETTLE_DIFF_SAMPLE_NOTES,
  SETTLE_TAIL_SAMPLE,
  STALE_REF_SAMPLE,
  sampleText,
} from './help-conformance-sample-outputs.mjs';

// Raw-coordinate fallback the quiz cases forbid: a click/fill/press targeting
// bare numbers instead of a ref or selector.
const RAW_COORDINATE_TARGET =
  /(?:^|\n)(?:agent-device\s+)?(?:click|fill|press)\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/i;

// Ref pasted without its leading @: byte-for-byte copying is the contract,
// and a dropped @ silently stops targeting the observed element.
const BARE_REF_TARGET =
  /(?:^|\n)(?:agent-device\s+)?(?:press|tap|click|fill|longpress)\s+['"]?e\d+\b/i;

function quiz(sample, question) {
  return `Read this previous agent-device output, then plan the next command:

${sampleText(sample)}

${question}`;
}

// Case docs reference help topic ids from src/cli/parser/cli-help.ts plus the
// synthetic '--help:first30' first-screen slice. Topic coverage is enforced by
// scripts/__tests__/help-conformance-topic-coverage.test.ts: a new help topic
// needs a case here or an explicit waiver there.
//
// A case whose quoted output is a rendered error declares
// `recovery: { code, sample }` — the error code the case teaches recovery from
// and the pinned sample it quotes. That marking is what
// scripts/__tests__/help-conformance-error-recovery-coverage.test.ts counts as
// coverage (a bare mention of an error code in prose is not a quiz), and it is
// how the gate proves the quoted text is verbatim sample output.
export const CASES = [
  {
    id: 'raw-first-screen-bluesky',
    docs: ['--help:first30'],
    task: 'Plan commands to open an already installed Bluesky app, search "callstack", open the @callstack.com account, press Follow or Following, and close.',
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'noWaitStable',
    ],
  },
  {
    id: 'focused-type-stops-at-success',
    docs: ['--help:first30', 'workflow'],
    task: 'Plan commands to open the installed app com.example.messages, press the visible New message control, focus the Message field, type the exact text "hello", press Send, wait for the explicit "Sent" confirmation, and close. The task ends at Sent; do not open the transient "View message" follow-up.',
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'opensAndCloses',
    ],
    matchers: [
      { id: 'typesExactMessage', pattern: /\bagent-device\s+type\s+(?:"hello"|'hello')/i },
      { id: 'waitsForSent', pattern: /\bagent-device\s+wait\s+text\s+(?:"Sent"|'Sent')/i },
    ],
    forbidden: [
      { id: 'typeDoesNotUseSettle', pattern: /\bagent-device\s+type\b[^\n]*--settle\b/i },
      { id: 'stopsBeforeTransientFollowUp', pattern: /View message/i },
    ],
  },
  {
    id: 'metamorphic-community-search',
    docs: ['--help:first30'],
    task: 'Plan commands to open the already installed app com.example.community, open the visible Discover destination, fill the People search field with "react native", open the @react.dev account, press Connect or Connected, and close.',
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'noWaitStable',
      'opensAndCloses',
    ],
    matchers: [
      {
        id: 'opensKnownCommunityApp',
        pattern: /\bagent-device\s+open\s+com\.example\.community\b/i,
      },
      {
        id: 'fillsExpectedSearch',
        pattern: /\bagent-device\s+fill\b[^\n]*(?:"react native"|'react native')[^\n]*--settle\b/i,
      },
      {
        id: 'usesLiteralHandleSelector',
        pattern:
          /\bagent-device\s+(?:press|click|tap)\b[^\n]*(?:label|text)=@react\.dev\b[^\n]*--settle\b/i,
      },
    ],
    forbidden: [
      {
        id: 'noBlueskyLeakage',
        pattern: /(?:bluesky|callstack|@e64|@callstack\.com)/i,
      },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'manual-qa-bluesky-script',
    docs: ['--help:first30', 'manual-qa'],
    task: 'You are following a manual QA script: on Bluesky, open Search, search "callstack", open @callstack.com, press Follow or Following, verify the button state changed, then close. Plan commands only.',
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'verifiesNamedExpectation',
      'noWaitStable',
    ],
  },
  {
    id: 'dogfood-mode',
    docs: ['--help:first30', 'dogfood'],
    task: 'Plan a short dogfood pass for the logged-in iOS shop app com.example.shop. Exercise the visible Home, Search, and Cart destinations and capture reproducible evidence for any issue found.',
    allowedExternalCommands: ['mkdir'],
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'usesDogfoodEvidence',
      'opensAndCloses',
    ],
    matchers: [
      { id: 'opensKnownDogfoodApp', pattern: /\bagent-device\s+open\s+com\.example\.shop\b/i },
      {
        id: 'capturesStrongIssueEvidence',
        pattern: /\b(?:screenshot\b[^\n]*--overlay-refs|record\s+start\b|logs\s+mark\b)/i,
      },
    ],
  },
  {
    id: 'engineering-validate-mode',
    docs: ['--help:first30', 'validate'],
    task: 'Plan commands to validate a TypeScript-only CLI/runtime change to settled press output against the already installed iOS Settings app. Use the known General control, prove current built output is running, and clean up. Swift runner code did not change.',
    allowedExternalCommands: ['pnpm'],
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSnapshotI',
      'usesSettleOnMutations',
      'usesValidationPrep',
      'opensAndCloses',
    ],
    matchers: [
      {
        id: 'opensSettings',
        pattern: /\bagent-device\s+open\s+(?:settings|com\.apple\.Preferences)\b/i,
      },
    ],
    forbidden: [
      {
        id: 'avoidsUnrelatedPlatformBuild',
        pattern: /\bpnpm\s+(?:run\s+)?build:(?:android|xcuitest)\b/i,
      },
    ],
  },
  {
    id: 'tv-focus-first-remote',
    docs: ['--help:first30', 'tv'],
    task: 'On an Android TV emulator, open the installed app com.example.tvhub, move focus to the "Continue watching" tile two positions to the right of the initially focused tile, activate it, verify the player screen appeared, and close. Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSnapshotI', 'opensAndCloses'],
    matchers: [
      { id: 'movesFocusWithRemote', pattern: /\btv-remote\s+press\s+right\b/i },
      { id: 'activatesWithSelect', pattern: /\btv-remote\s+press\s+select\b/i },
      { id: 'verifiesOutcome', pattern: /\b(?:is\s+focused|wait\b|find\b)/i },
    ],
    forbidden: [
      // Focus-first surface: activation goes through tv-remote select, not a
      // coordinate/element tap (help tv "Do not assume press/click @ref works").
      {
        id: 'noDirectTapActivation',
        pattern: /(?:^|\n)agent-device\s+(?:press|click|tap)\s/i,
      },
      { id: 'noRawAdbKeyevent', pattern: /\badb\s+shell\s+input\b/i },
    ],
  },
  {
    id: 'ios-system-ui-widget-flow',
    docs: ['--help:first30', 'ios-system-ui'],
    task: 'On an iOS simulator, add the Calendar widget from SpringBoard, capture visual evidence of the placed widget, return to the installed app com.example.calendar, and close. Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSnapshotI', 'opensAndCloses'],
    matchers: [
      {
        id: 'bindsSessionToSpringBoard',
        pattern: /\bagent-device\s+open\s+com\.apple\.springboard\b[^\n]*--platform\s+ios\b/i,
      },
      {
        id: 'entersEditModeWithCoordinateLongpress',
        pattern: /\bagent-device\s+longpress\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\b/i,
      },
      {
        id: 'refreshesSnapshotAfterEnteringEditMode',
        pattern: /\blongpress\b[\s\S]*\n[^\n]*\bsnapshot\s+-i\b/i,
      },
      {
        id: 'usesScreenshotForSparseGalleryResult',
        pattern:
          /\bagent-device\s+screenshot\b[\s\S]*\n[^\n]*\bagent-device\s+press\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\b/i,
      },
      {
        id: 'returnsToAppUnderTest',
        pattern: /\bagent-device\s+open\s+com\.example\.calendar\b[^\n]*--platform\s+ios\b/i,
      },
    ],
    forbidden: [
      {
        id: 'noRawSimulatorControl',
        pattern: /(?:^|\n)(?:xcrun\s+simctl|idb|maestro)\b/i,
      },
    ],
  },
  {
    id: 'web-managed-backend-loop',
    docs: ['--help:first30', 'web'],
    task: 'On a fresh machine that has never run web automation, plan commands to set up and verify the managed web backend, open https://shop.example/login, fill the Email field with "qa@example.com", press the "Sign in" button, verify the "Welcome back" text appears, capture a screenshot to ./artifacts/web-login.png, and close. Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSnapshotI', 'opensAndCloses'],
    matchers: [
      {
        id: 'setsUpBackendBeforeOpen',
        pattern: /\bagent-device\s+web\s+setup\b[\s\S]*\n[^\n]*\bopen\s+https:\/\//i,
      },
      { id: 'verifiesBackendWithDoctor', pattern: /\bagent-device\s+web\s+doctor\b/i },
      { id: 'usesWebPlatform', pattern: /--platform\s+web\b/i },
      { id: 'verifiesWelcomeText', pattern: /\b(?:wait|is|find)\b[^\n]*welcome/i },
    ],
    forbidden: [
      // help web: native mobile/desktop setup commands are out of scope for
      // --platform web sessions.
      {
        id: 'noNativeSetupCommands',
        pattern: /(?:^|\n)agent-device\s+(?:boot|apps|install|alert|keyboard|perf|logs)\b/i,
      },
      { id: 'noStandaloneAgentBrowser', pattern: /(?:^|\n)agent-browser\b/i },
    ],
  },
  {
    id: 'react-native-overlay-before-tap',
    docs: ['--help:first30', 'react-native'],
    task: 'An Expo dev-client app on the iOS simulator shows a React Native warning overlay in the latest snapshot. Plan the commands that safely get past it and then press the control with id "submit-order". Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSettleOnMutations'],
    matchers: [
      {
        id: 'usesDismissOverlayCommand',
        pattern: /(?:^|\n)agent-device\s+react-native\s+dismiss-overlay\b/i,
      },
      {
        id: 'refreshesRefsAfterDismiss',
        pattern: /dismiss-overlay\b[\s\S]*\n[^\n]*\bsnapshot\s+-i\b/i,
      },
      { id: 'pressesSubmitTarget', pattern: /(?:^|\n)agent-device\s+press\s+[^\n]*submit-order/i },
    ],
    forbidden: [
      // help react-native: never press warning/error overlay text manually;
      // the dismiss-overlay command owns LogBox/RedBox targeting.
      {
        id: 'noManualOverlayPress',
        pattern: /(?:^|\n)agent-device\s+(?:press|click)\s+[^\n]*(?:warning|error|logbox|redbox)/i,
      },
      { id: 'noPlainReloadCommand', pattern: /(?:^|\n)agent-device\s+reload\b/i },
    ],
  },
  {
    id: 'debugging-small-log-window',
    docs: ['--help:first30', 'debugging'],
    task: 'The "Load diagnostics" control (id "load-diagnostics") in the already-open iOS app intermittently fails. Plan commands to capture a small fresh log window plus request/response metadata around one reproduction. Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'clearsAndRestartsLogs',
        pattern: /(?:^|\n)agent-device\s+logs\s+clear\s+--restart\b/i,
      },
      { id: 'marksBeforeRepro', pattern: /\blogs\s+mark\b/i },
      {
        id: 'reproducesTargetPress',
        pattern: /(?:^|\n)agent-device\s+press\s+[^\n]*load-diagnostics/i,
      },
      { id: 'readsLogPath', pattern: /\blogs\s+path\b/i },
      { id: 'dumpsNetworkMetadata', pattern: /\bnetwork\s+dump\b/i },
    ],
    forbidden: [
      { id: 'noSessionReopen', pattern: /(?:^|\n)agent-device\s+open\b/i },
      { id: 'noSplitLogRestart', pattern: /\blogs\s+stop\b/i },
    ],
  },
  {
    id: 'workflow-install-artifact-before-open',
    docs: ['--help:first30', 'workflow'],
    task: 'A local Android build artifact ./dist/app-release.apk contains the app com.example.orders, which is not yet on the emulator. Plan commands to get it running with fresh state and confirm its first screen shows "Orders". Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSnapshotI'],
    matchers: [
      {
        id: 'installsIdThenArtifact',
        pattern: /(?:^|\n)agent-device\s+install\s+com\.example\.orders\s+\S*app-release\.apk/i,
      },
      {
        id: 'opensFreshAfterInstall',
        pattern: /\binstall\b[\s\S]*\n[^\n]*\bopen\s+com\.example\.orders\b[^\n]*--relaunch\b/i,
      },
      { id: 'verifiesFirstScreen', pattern: /\b(?:wait|find|is|get)\b[^\n]*orders/i },
    ],
    forbidden: [
      // help workflow: install for a first install; reinstall only when
      // explicitly requested; never open an artifact path.
      { id: 'noReinstall', pattern: /(?:^|\n)agent-device\s+reinstall\b/i },
      { id: 'noOpenArtifactPath', pattern: /(?:^|\n)agent-device\s+open\s+[^\n]*\.apk\b/i },
    ],
  },
  {
    // Review of the compact workflow card's && guidance found the plan
    // validator failed a plan that followed it (unquoted && classified as
    // shell-projection). Both target elements are already named/unambiguous
    // here, which is exactly the "confident consecutive steps" case the card
    // describes, so usesConfidentChaining is a real (not just possible)
    // expectation, and validPlanCommands proves the fixed validator accepts
    // the chained shape end to end.
    id: 'chains-confident-consecutive-settle-steps',
    docs: ['--help:first30', 'workflow'],
    task: 'The Search tab is visible, labeled "Search", and known to reveal a search field also labeled "Search" with no other candidate on screen. Plan commands to press the Search tab and fill that field with "react native", settling after each step, then close. Plan commands only.',
    expectations: [
      'validPlanCommands',
      'fullPrefix',
      'usesSettleOnMutations',
      'usesConfidentChaining',
    ],
    matchers: [
      {
        id: 'pressesSearchTab',
        pattern: /\bagent-device\s+press\b[^\n]*label="?search"?[^\n]*--settle\b/i,
      },
      {
        id: 'fillsSearchField',
        pattern:
          /\bagent-device\s+fill\b[^\n]*label="?search"?[^\n]*(?:"react native"|'react native')[^\n]*--settle\b/i,
      },
    ],
  },
  {
    // help scripting owns --record-as secret-safe fills and save-script
    // authoring now that this content left the mandatory workflow card;
    // this proves an agent can actually plan the loop from the topic alone.
    id: 'scripting-secret-safe-recorded-login',
    docs: ['--help:first30', 'scripting'],
    task: 'Author a reusable login script for the installed app com.example.app that never records the literal password. The AD_VAR_PASSWORD environment variable is already set in your shell, so do not plan a shell export line. Arm recording on open with --save-script=login.ad, fill the password field (id="password") from AD_VAR_PASSWORD using --record-as, verify the login succeeded, then publish the script without closing the session. Plan agent-device commands only.',
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'armsSaveScriptOnOpen',
        pattern: /\bagent-device\s+open\s+com\.example\.app\b[^\n]*--save-script[=\s]*login\.ad/i,
      },
      {
        id: 'recordsSecretSafeFill',
        pattern:
          /\bagent-device\s+fill\s+(?:'|")?id="?password"?(?:'|")?\s+"?\$AD_VAR_PASSWORD"?[^\n]*--record-as\s+PASSWORD\b/i,
      },
      {
        id: 'verifiesLoginSucceeded',
        pattern: /\b(?:wait|is|get|find)\b/i,
      },
      { id: 'publishesWithoutClosing', pattern: /\bagent-device\s+session\s+save-script\b/i },
    ],
    forbidden: [
      { id: 'noBareClose', pattern: /(?:^|\n)agent-device\s+close\b/i },
      { id: 'noNoRecordOnSecretFill', pattern: /--no-record/i },
    ],
  },
  {
    // help gestures owns multi-touch shapes now that this content left the
    // mandatory workflow card. The exact verification text ("pan changed
    // yes") only appears in the gestures topic's own example, so a correct
    // plan proves the model actually read it rather than guessing a shape.
    id: 'gestures-android-transform-then-verify',
    docs: ['--help:first30', 'gestures'],
    task: 'On the already-open Android app, plan a combined pan/scale/rotate transform gesture centered at (200, 420) with dx=80, dy=-40, scale=2, rotate=35 degrees over 700ms, then verify the app-reported pan change using the exact confirmation text shown in the gesture reference. Plan commands only.',
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'runsAndroidTransform',
        pattern:
          /\bagent-device\s+gesture\s+transform\s+200\s+420\s+80\s+-40\s+2\s+35\s+700\b[^\n]*--platform\s+android\b/i,
      },
      {
        id: 'verifiesSemanticPanChange',
        pattern: /\bagent-device\s+wait\s+text\s+"pan changed yes"[^\n]*--platform\s+android\b/i,
      },
    ],
    forbidden: [{ id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET }],
  },
  // Next-command quiz cases: captured output (pinned to the real renderer by
  // scripts/__tests__/help-conformance-sample-outputs.test.ts) plus a task,
  // scored by regex instead of the named expectation scorers above.
  {
    id: 'settle-diff-is-observation',
    docs: ['--help:first30'],
    task: `You already ran this command and observed its settled output:

${sampleText(SETTLE_TAIL_SAMPLE)}

Use the output already shown to determine whether the feed-search UI is present, then close the session. What command should run next?`,
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [{ id: 'plansClose', pattern: /(?:^|\n)(?:agent-device\s+)?close\b/i }],
    forbidden: [
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noWait', pattern: /\bwait\b/i },
      { id: 'noFind', pattern: /\bfind\b/i },
      { id: 'noGet', pattern: /\bget\b/i },
      { id: 'noIs', pattern: /\bis\b/i },
      { id: 'noPressOrClick', pattern: /\b(?:press|click)\b/i },
    ],
  },
  {
    id: 'sample-output-settled-diff-next-target',
    docs: ['--help:first30'],
    task: quiz(
      SETTLE_DIFF_SAMPLE,
      'The task is to open the matching account result. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      { id: 'pressOrClickOrTap', pattern: /\b(?:press|click|tap)\b/i },
      { id: 'usesE64RefOrLabel', pattern: /@e64\b|label=(?:["']?@callstack\.com["']?)/i },
      { id: 'usesSettleFlag', pattern: /--settle\b/i },
    ],
    forbidden: [
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noWaitStable', pattern: /wait\s+stable/i },
      { id: 'noFill', pattern: /\bfill\b/i },
      { id: 'noBareRefTarget', pattern: BARE_REF_TARGET },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'metamorphic-settled-diff-next-target-notes',
    docs: ['--help:first30'],
    task: quiz(
      SETTLE_DIFF_SAMPLE_NOTES,
      'The task is to open the matching list result. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      { id: 'pressOrClickOrTap', pattern: /\b(?:press|click|tap)\b/i },
      { id: 'usesE21RefOrLabel', pattern: /@e21\b|label=(?:["']?groceries list["']?)/i },
      { id: 'usesSettleFlag', pattern: /--settle\b/i },
    ],
    forbidden: [
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noWaitStable', pattern: /wait\s+stable/i },
      { id: 'noFill', pattern: /\bfill\b/i },
      { id: 'noCallstackLeakage', pattern: /(?:callstack|@e64)/i },
      { id: 'noBareRefTarget', pattern: BARE_REF_TARGET },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    // ADR 0014: settled tails pin unchanged interactive refs because the
    // partial frame admits only refs copied with the response generation.
    id: 'sample-output-settle-tail-pinned-ref-copied-exactly',
    docs: ['--help:first30'],
    task: quiz(
      SETTLE_TAIL_SAMPLE,
      'The task is to open the Profile tab. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'pressesPinnedTailRefOrExactLabel',
        pattern:
          /(?:^|\n)agent-device\s+(?:press|click)\s+(?:@e40~s5\b|'?label="?Profile"?'?)[^\n]*--settle\b/i,
      },
    ],
    forbidden: [
      { id: 'noUnpinnedRef', pattern: /@e40(?!~s5\b)/i },
      { id: 'noBareRefTarget', pattern: BARE_REF_TARGET },
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    // #1638/#1650: the closed --settle grammar grew scroll and back, and this
    // extension IS the feature's payoff — collapsing scroll-then-observe into
    // one call. The old guidance framed settle as a mutation suffix, and
    // scroll reads as navigation, so eligibility generalizing is exactly what
    // this case checks. The task deliberately does not mention settle: the
    // wanted row is off-screen with no ref anywhere in the output, the
    // tempting pre-#1638 plan is `scroll` + a separate `snapshot -i`, and
    // acceptance is the single settled call.
    id: 'sample-output-offscreen-target-scrolls-settled',
    docs: ['--help:first30'],
    task: quiz(
      OFFSCREEN_TARGET_SNAPSHOT_SAMPLE,
      'The task is to open the Notifications row of this list. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'scrollsDownSettled',
        pattern: /(?:^|\n)(?:agent-device\s+)?scroll\s+down\b[^\n]*--settle\b/i,
      },
    ],
    forbidden: [
      // The two-call habit this case exists to catch: a scroll line without
      // --settle means a separate observation call is coming.
      {
        id: 'noUnsettledScroll',
        pattern: /(?:^|\n)(?:agent-device\s+)?scroll\b(?:(?!--settle)[^\n])*(?=\n|$)/i,
      },
      { id: 'noSnapshot', pattern: /\bsnapshot\b/i },
      { id: 'noWaitStable', pattern: /wait\s+stable/i },
      // Notifications never appears in the output, so any bare @eN press is a
      // guessed ref, not a resolved target.
      {
        id: 'noGuessedRef',
        pattern: /(?:^|\n)(?:agent-device\s+)?(?:press|click|fill|longpress)\s+@e\d/i,
      },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-not-settled-needs-observe',
    docs: ['--help:first30'],
    task: quiz(
      NOT_SETTLED_SAMPLE,
      'The next target is not known yet. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'observesBeforeActing',
        pattern: /(?:^|\n)(?:agent-device\s+)?(?:wait\b|snapshot\b[^\n]*-i\b)/i,
      },
    ],
    forbidden: [
      {
        id: 'noBareRefMutation',
        pattern: /(?:^|\n)(?:agent-device\s+)?(?:press|click|fill|longpress)\s+@e\d+/i,
      },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-device-in-use-reuses-session',
    docs: ['--help:first30'],
    recovery: { code: 'DEVICE_IN_USE', sample: DEVICE_IN_USE_SAMPLE },
    task: quiz(
      DEVICE_IN_USE_SAMPLE,
      'You are continuing the checkout flow that the "checkout" session was already running on this device. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'retriesWithOwningSession',
        pattern: /(?:^|\n)agent-device\s+press\b[^\n]*--session\s+checkout\b/i,
      },
      { id: 'keepsSettle', pattern: /--settle\b/i },
    ],
    forbidden: [
      { id: 'noClose', pattern: /(?:^|\n)agent-device\s+close\b/i },
      { id: 'noReopen', pattern: /(?:^|\n)agent-device\s+open\b/i },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-stale-ref-resnapshots',
    docs: ['--help:first30'],
    recovery: { code: 'COMMAND_FAILED', sample: STALE_REF_SAMPLE },
    task: quiz(
      STALE_REF_SAMPLE,
      'The Continue control this ref pointed at may have moved. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      { id: 'refreshesInteractiveRefs', pattern: /(?:^|\n)agent-device\s+snapshot\s+-i\b/i },
    ],
    forbidden: [
      {
        id: 'noBareRefRetry',
        pattern: /(?:^|\n)agent-device\s+(?:press|click|fill|longpress)\s+@e\d/i,
      },
      { id: 'noReopen', pattern: /(?:^|\n)agent-device\s+open\b/i },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-ambiguous-match-reobserves',
    docs: ['--help:first30'],
    recovery: { code: 'AMBIGUOUS_MATCH', sample: AMBIGUOUS_MATCH_SAMPLE },
    task: quiz(
      AMBIGUOUS_MATCH_SAMPLE,
      'The intent is to follow the @callstack.com account row. The candidate refs shown (@e2, @e5, @e9) all carry the identical "Follow" label, so this output alone cannot tell them apart. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'reobservesOrNarrows',
        pattern:
          /(?:^|\n)agent-device\s+(?:snapshot\s+-i\b|(?:find|press|click)\s+[^\n]*(?:role=|id=|label="?@callstack\.com))/i,
      },
    ],
    forbidden: [
      // #1597: candidates now print (ref, role, label), but all 3 here share
      // the exact same "Follow" label — picking any single @eN from this
      // output alone would still be an unverified guess, not a resolved match.
      { id: 'noGuessedRef', pattern: /(?:^|\n)agent-device\s+(?:press|click)\s+@e\d/i },
      {
        id: 'noVerbatimRetry',
        pattern: /(?:^|\n)agent-device\s+find\s+text\s+"?follow"?\s*(?:\n|$)/i,
      },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-app-not-installed-discovers-first',
    docs: ['--help:first30'],
    recovery: { code: 'APP_NOT_INSTALLED', sample: APP_NOT_INSTALLED_SAMPLE },
    task: quiz(
      APP_NOT_INSTALLED_SAMPLE,
      'The goal is still to open the shop app on this simulator; no build artifact was provided. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [{ id: 'discoversInstalledApps', pattern: /(?:^|\n)agent-device\s+apps\b/i }],
    forbidden: [
      { id: 'noBlindReopen', pattern: /(?:^|\n)agent-device\s+open\s+"?shoply\b/i },
      // No artifact exists to install; inventing one is the failure mode help
      // workflow forbids ("Do not open artifact paths or invent package ids").
      {
        id: 'noInventedInstall',
        pattern: /(?:^|\n)agent-device\s+(?:install|install-from-source)\b/i,
      },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'sample-output-browserstack-connect-opens-known-package',
    docs: ['--help:first30', 'remote'],
    task: quiz(
      BROWSERSTACK_CONNECT_SAMPLE,
      'The uploaded app has package id com.example.demo. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'opensKnownPackage',
        pattern: /(?:^|\n)agent-device\s+open\s+com\.example\.demo\b[^\n]*--relaunch\b/i,
      },
      {
        id: 'keepsConnectedSession',
        pattern: /(?:^|\n)agent-device\s+open\b[^\n]*--session\s+adc-browserstack\b/i,
      },
    ],
    forbidden: [
      {
        id: 'noPreallocationCatalogProbe',
        pattern: /(?:^|\n)agent-device\s+(?:devices|apps)\b/i,
      },
      {
        id: 'noArtifactAsAppId',
        pattern: /(?:^|\n)agent-device\s+open\s+(?:sample\.apk|bs:\/\/app-id)\b/i,
      },
      { id: 'noRedundantInstall', pattern: /(?:^|\n)agent-device\s+install\b/i },
    ],
  },
  {
    id: 'foreground-attach-single-sim',
    docs: ['--help:first30', 'workflow'],
    task: 'You are starting fresh with no active session. The configured iOS target already has com.example.demo in the foreground. Plan the command that keeps this deterministic app/device selection and gets its initial interactive snapshot in a single call, then press the visible Continue control and close the session.',
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSettleOnMutations', 'opensAndCloses'],
    matchers: [
      {
        id: 'startsWithForegroundOpen',
        // Flag order is not semantically meaningful; require the known app
        // and --foreground on the first command, in either order.
        pattern:
          /^agent-device\s+open\b(?=[^\n]*\bcom\.example\.demo\b)(?=[^\n]*--foreground\b)[^\n]*$/i,
      },
      {
        id: 'pressesContinueAfterAttach',
        pattern: /agent-device\s+press\s+[^\n]*continue[^\n]*--settle\b/i,
      },
    ],
    forbidden: [{ id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET }],
  },
  {
    id: 'merged-card-actions-not-directly-invokable',
    docs: ['--help:first30', 'workflow'],
    task: quiz(
      MERGED_CARD_ACTIONS_SAMPLE,
      'The goal is to reply to this post. The actions list names "Reply" as a hidden affordance on @e72, but that name is not a pressable selector. What command should run next?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix'],
    matchers: [
      {
        id: 'opensCardToReachReply',
        pattern: /(?:^|\n)agent-device\s+(?:press|click)\s+@e72\b[^\n]*--settle\b/i,
      },
    ],
    forbidden: [
      {
        id: 'noPressingActionNameAsSelector',
        pattern: /(?:^|\n)agent-device\s+(?:press|click|find)\b[^\n]*(?:label|text)="?reply"?/i,
      },
      { id: 'noSnapshotDetour', pattern: /\bsnapshot\b/i },
      { id: 'noBareRefTarget', pattern: BARE_REF_TARGET },
      { id: 'noRawCoordinateTarget', pattern: RAW_COORDINATE_TARGET },
    ],
  },
  {
    id: 'foreground-attach-snapshot-recovery',
    docs: ['--help:first30', 'workflow'],
    task: quiz(
      FOREGROUND_SNAPSHOT_FAILURE_SAMPLE,
      'The foreground attach succeeded and the session is still open, but its initial snapshot failed. What command should run next to get interactive refs?',
    ),
    expectations: ['validPlanCommands', 'fullPrefix', 'usesSnapshotI'],
    matchers: [
      {
        id: 'retriesSnapshotInOpenSession',
        pattern: /(?:^|\n)agent-device\s+snapshot\s+-i\b/i,
      },
    ],
    forbidden: [
      { id: 'noSecondOpen', pattern: /(?:^|\n)agent-device\s+open\b/i },
      { id: 'noPrematureClose', pattern: /(?:^|\n)agent-device\s+close\b/i },
    ],
  },
];
