#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

// Shared reflection surface for XCTest's private event-synthesis API
// (XCSynthesizedEventRecord / XCPointerEventPath). Both gesture synthesis
// (RunnerSynthesizedGesture) and text-entry synthesis (RunnerSynthesizedTextEntry)
// reflect into this same private API; resolving the part they have in common here
// means a selector rename only has to be found in one place.
//
// Each caller additionally resolves whichever XCSynthesizedEventRecord init
// overload and XCPointerEventPath factory/mutator selectors its own event kind
// needs: gesture uses `initWithName:displayID:interfaceOrientation:` plus
// touch-path selectors (`initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`,
// `liftUpAtOffset:`); text entry uses the 1-arg `initWithName:` plus text-input
// selectors (`initForTextInput`, `typeText:atOffset:typingSpeed:shouldRedact:`,
// `typeKey:modifiers:atOffset:`). Those genuinely differ and are resolved by
// each caller on top of this shared core, not forced into one shape here.
typedef struct {
  Class recordClass;  // XCSynthesizedEventRecord
  Class pathClass;  // XCPointerEventPath
  SEL addPathSelector;  // addPointerEventPath: (on recordClass)
  SEL setTargetProcessIDSelector;  // setTargetProcessID: (on recordClass)
  SEL synthesizeSelector;  // synthesizeWithError: (on recordClass)
  SEL processIDSelector;  // processID, read on the XCUIApplication
} RunnerXCTestEventBridge;

typedef NSInteger (*RunnerMsgSendInteger)(id, SEL);
typedef void (*RunnerMsgSendSetInteger)(id, SEL, NSInteger);
typedef void (*RunnerMsgSendAddPath)(id, SEL, id);
typedef BOOL (*RunnerMsgSendSynthesize)(id, SEL, NSError **);

// Why the display hosting the target app could not be named. Callers branch on this rather than
// on the message, so a refusal keeps its reason across the language boundary (#2728).
typedef NS_ENUM(NSUInteger, RunnerApplicationScreenFailure) {
  RunnerApplicationScreenFailureNone,
  // No window with a usable frame, so nothing resolves and its screen would only report main.
  RunnerApplicationScreenFailureUnresolvedWindow,
  // A resolved window whose screen or display identity the XCTest runtime would not answer.
  RunnerApplicationScreenFailureUnresolvedScreen,
};

// Resolves the shared core described above against the live XCTest runtime.
// Returns nil and populates `bridge` on success. Returns a non-nil
// "private XCTest <surface> synthesis unavailable: ..." message and leaves
// `bridge` unspecified when a class or selector the private API is expected to
// expose is missing (the API changed, or is unavailable on this OS/Xcode).
// `surface` names the calling feature ("event" or "text") so the message text
// matches what that caller has always reported.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  NSString *surface,
  RunnerXCTestEventBridge *bridge
);

// Resolves the `XCUIScreen` hosting the application's window and that screen's `displayID`, which
// is the only display identity that follows a foldable app to whichever panel it currently lights.
// Reading the window frame must precede reading its screen: an unresolved element still reports the
// main screen. Never selects a screen by number or by position in `XCUIScreen.screens`.
// Returns YES and writes the screen to capture into `screen` and its identity into `displayID`.
// Otherwise returns NO, leaves both empty, and names the reason in `failure` so callers branch on
// the reason rather than on message text (#2728). Private KVC raises rather than returns nil when
// XCTest has no such value, so both reads are guarded here and surface as a typed failure instead
// of an exception reaching the caller.
FOUNDATION_EXPORT BOOL RunnerResolveApplicationScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
);

// Reads the display ID off an already-resolved window. When a caller has resolved the app window
// for geometry, routing the synthesized gesture by this window keeps the record's display and the
// booked reference frame on the same window instead of re-walking `windows.firstMatch`.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveWindowDisplayID(
  id window,
  NSUInteger *displayID
);

// Reads the display ID of the device's only screen, for a gesture whose app window XCTest cannot
// resolve because the app's accessibility tree is too deep to serialize. On an iPhone with exactly
// one screen that screen hosts the full-screen app, so no window is needed to name it. On an iPad
// the same route opens only while the app provably fills that screen, decided in-process by the
// evidence seam below without the app's tree. Anywhere else this returns a message and leaves
// `displayID` untouched: a windowed iPad app sits in part of its screen, and only a window can say
// which panel lights a foldable's app.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveSoleScreenDisplayID(
  id application,
  NSUInteger *displayID
);

// Resolves the screen and display identity under the same sole-screen rule used by synthesis.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveSoleScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID
);

// What the full-screen proof concluded. The decision is a function of these values, so a test
// supplies them directly instead of restating the device rule.
typedef NS_ENUM(NSUInteger, RunnerFullScreenEvidence) {
  // The target app is the accessibility primary app and its frame is the screen's frame.
  RunnerFullScreenEvidenceFillsScreen,
  // The target app is not the accessibility primary app, so no screen belongs to it to fill.
  RunnerFullScreenEvidenceNotPrimaryApp,
  // The primary app's frame differs from the system app's frame: an iPad window that shows the app
  // in part of the screen (Windowed Apps or Stage Manager).
  RunnerFullScreenEvidenceWindowed,
  // The runtime, the app, or the system app would not report a usable frame, which proves nothing.
  RunnerFullScreenEvidenceUnknown,
};

// Decides the evidence from the values the AXRuntime probe reads. AXRuntime reports the primary
// app's window and the system app, which spans the screen, in one native space; this is the same
// comparison the Simulator snapshot bridge refuses a capture on (`app-window-not-full-screen`,
// ADR 0004). Neither read walks the app's tree, so the decision survives a tree XCTest cannot
// serialize. A pid that cannot name a process (<= 0) or an unreadable frame answers Unknown, never
// a guess.
FOUNDATION_EXPORT RunnerFullScreenEvidence RunnerFullScreenEvidenceFromForeground(
  pid_t targetProcessID,
  pid_t primaryProcessID,
  CGRect appFrame,
  CGRect screenFrame
);

// The off-phone half of the sole-screen rule: the route opens only while the evidence proves the
// app fills its screen. The phone idiom never reaches this decision — its caller short-circuits
// before the probe, because an iPhone keeps every app full-screen.
FOUNDATION_EXPORT BOOL RunnerSoleScreenRouteOpensForEvidence(
  RunnerFullScreenEvidence evidence
);

FOUNDATION_EXPORT NSString * _Nullable RunnerRequireClass(
  Class cls,
  NSString *className,
  NSString *surface
);
FOUNDATION_EXPORT NSString * _Nullable RunnerRequireSelector(
  Class cls,
  SEL selector,
  NSString *selectorName,
  NSString *surface
);
FOUNDATION_EXPORT NSString * _Nullable RunnerRequireApplicationSelector(
  id application,
  SEL selector,
  NSString *selectorName,
  NSString *surface
);

// Formats an NSException the way every synthesis @catch block reports failure:
// "<name>: <reason>", falling back to "NSException" / `fallbackReason` when
// either is nil.
FOUNDATION_EXPORT NSString *RunnerFormatXCTestException(
  NSException *exception,
  NSString *fallbackReason
);

NS_ASSUME_NONNULL_END
