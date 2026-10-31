#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
// The `RunnerLitPanel` the screen resolvers take, and the panel rule their walk applies.
#import "RunnerPanelSurface.h"

NS_ASSUME_NONNULL_BEGIN

// Shared reflection core for XCTest's private event-synthesis API (XCSynthesizedEventRecord /
// XCPointerEventPath). Gesture and text-entry synthesis each resolve on top of this core the
// record-init overload and mutator selectors their own event kind needs, so a rename in the part
// they share is found in one place.
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
// on the message, so a refusal keeps its reason across the language boundary.
typedef NS_ENUM(NSUInteger, RunnerApplicationScreenFailure) {
  RunnerApplicationScreenFailureNone,
  // No window with a usable frame, so nothing resolves and its screen would only report main.
  RunnerApplicationScreenFailureUnresolvedWindow,
  // A resolved window whose screen or display identity the XCTest runtime would not answer.
  RunnerApplicationScreenFailureUnresolvedScreen,
  // The request named a lit panel and every window the app reported is on the other one, so no
  // surface on the screen the user is looking at exists to book against.
  RunnerApplicationScreenFailureOffLitPanel,
};

// Resolves the shared core against the live XCTest runtime. Returns nil on success, or a
// "private XCTest <surface> synthesis unavailable: ..." message when a class or selector the
// private API is expected to expose is missing. `surface` names the calling feature.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  NSString *surface,
  RunnerXCTestEventBridge *bridge
);

// Resolves the application's surface window and returns it, so every consumer of the resolved window
// — the capture's display, the interaction anchor and reference frame, the snapshot viewport, and the
// synthesized record's display — books against one window that one rule chose.
//
// `litPanel` is the panel the request named, or a `displayID` of 0 when it named none. With no panel
// this is the historic read: the first window the application reports with a usable frame, and no
// display identity is read at all, so a single-panel device pays nothing it did not pay before. With a
// panel, the walk reads each candidate's frame and display and keeps the window
// `RunnerPanelSurfaceSelectWindow` names, which is how a foldable home screen stops resolving to
// SpringBoard's status-bar window on whichever panel the runtime happens to list first.
//
// `*window` is the window element the runtime handed out, ready for `RunnerReadResolvedWindowScreen`
// or `RunnerResolveWindowDisplayID`; `*windowFrame` is the box the rule booked it for. `*observedFrame`
// is the last frame the walk looked at, so a refusal names what it refused. Private KVC raises rather
// than returns nil, so every read is guarded here and any failure surfaces as the typed `failure`,
// never an exception. The walk is bounded: reading a window that has just vanished makes XCTest record
// an issue that outlives the call (#2995).
FOUNDATION_EXPORT RunnerApplicationScreenFailure RunnerResolveSurfaceWindow(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *window,
  CGRect *windowFrame,
  CGRect *observedFrame
);

// Reads the `XCUIScreen` and `displayID` of a window the caller has already resolved and measured.
// The panel walk holds the frame; asking a window it just measured for the same measurement again
// would only add a read of a window that may already be gone. `screen` may be NULL for a caller that
// routes by display identity alone.
FOUNDATION_EXPORT RunnerApplicationScreenFailure RunnerReadResolvedWindowScreen(
  id window,
  CGRect observedFrame,
  id _Nullable * _Nullable screen,
  NSUInteger *displayID
);

// The application's window elements, at most `maxCount` of them, read through the query the runtime
// exposes rather than a typed property, so a renamed key answers nothing instead of raising. Returns
// nil when the query itself cannot be answered, which a caller reads as an application with no
// windows. `reportedCount`, when asked for, is how many the query named before the cap, so a device
// the cap would silently shorten stays visible. Only the panel walk reads from this list, and it
// reads each element's attributes at most once, so a candidate the rule discards is never asked
// anything again (#2995).
FOUNDATION_EXPORT NSArray * _Nullable RunnerCopyApplicationWindowElements(
  id application,
  NSUInteger maxCount,
  NSUInteger * _Nullable reportedCount
);

// Resolves the display hosting the application's surface window: the surface window, then the
// `XCUIScreen` that window reports and its `displayID` — the only display identity that follows an
// app to the panel it lights. Reading the window frame must precede reading its screen, and neither
// read is ever selected by number or position. A request that names no panel reads the historic first
// window and still asks that window for its screen, so single-panel captures are unchanged.
FOUNDATION_EXPORT BOOL RunnerResolveApplicationScreen(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
);

// One window read: does it exist, and what box does it occupy. Both answers are required — an
// application with no window answers `frame` with `(0,0 0x0)` without raising, so only `exists` says
// whether the window is there. The frame is reported even when refused. Returns whether the window is
// there with a measurable box.
FOUNDATION_EXPORT BOOL RunnerReadWindowExistsAndFrame(
  id window,
  CGRect *observedFrame
);


// Reads the display ID off an already-resolved window, keeping a synthesized record's display and
// the caller's booked reference frame on the same window. The frame is still read before the
// screen; a window that answers empty or raises fails closed with a refusal message naming the
// same reason the application walk gives.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveWindowDisplayID(
  id window,
  NSUInteger *displayID
);

// Resolves the device's only screen and its `displayID` under the sole-screen rule that synthesis
// and capture share: an iPhone with one screen always, an iPad only while the AXRuntime probe
// proves the app fills that screen. Returns nil on success; on refusal it returns a message,
// empties `screen`, and leaves `displayID` untouched.
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

// Decides the evidence from the values the AXRuntime probe reads, which AXRuntime reports in one
// native space (ADR 0004). Neither read walks the app's tree, so the decision survives a tree
// XCTest cannot serialize. An unreadable pid or frame answers Unknown, never a guess.
FOUNDATION_EXPORT RunnerFullScreenEvidence RunnerFullScreenEvidenceFromForeground(
  pid_t targetProcessID,
  pid_t primaryProcessID,
  CGRect appFrame,
  CGRect screenFrame
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
