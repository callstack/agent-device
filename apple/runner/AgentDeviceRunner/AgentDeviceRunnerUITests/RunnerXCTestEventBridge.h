#import <Foundation/Foundation.h>

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
