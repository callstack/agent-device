#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

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
  // The application has windows, and every one of them is on a display other than the lit panel.
  RunnerApplicationScreenFailureOffLitPanel,
};

// The panel the host reports as lit (ADR 0025): its display and its native box in points. The
// system presents a panel turned, so a window on it may report the box with its sides swapped.
typedef struct {
  NSUInteger displayID;
  CGFloat widthPt;
  CGFloat heightPt;
} RunnerLitPanel;

// The walk reads at most this many windows: each read of a window that has vanished records an
// XCTest issue (#2995), and SpringBoard lists about forty.
#define AGENT_DEVICE_MAX_LIT_PANEL_WINDOWS 8

// Resolves the window on `litPanel`: the first window on that display whose frame is the panel's
// box either way up, else the largest window on that display. An unreadable list, an unplaced
// window, or a list past the cap with no full-panel window in it, is `UnresolvedScreen`. Windows
// that are all on another display are `OffLitPanel`; no window at all is `UnresolvedWindow`.
FOUNDATION_EXPORT RunnerApplicationScreenFailure RunnerResolveLitPanelWindow(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *window,
  CGRect *windowFrame
);

// Resolves the shared core against the live XCTest runtime. Returns nil on success, or a
// "private XCTest <surface> synthesis unavailable: ..." message when a class or selector the
// private API is expected to expose is missing. `surface` names the calling feature.
FOUNDATION_EXPORT NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  NSString *surface,
  RunnerXCTestEventBridge *bridge
);

// Resolves the `XCUIScreen` hosting the application's window and its `displayID`, the only display
// identity that follows an app to the panel it lights. Reading the window frame must precede
// reading its screen: an unresolved element still reports the main screen, and neither read is
// ever selected by number or position. Private KVC raises rather than returns nil, so both reads
// are guarded here and any failure surfaces as the typed `failure`, never an exception.
FOUNDATION_EXPORT BOOL RunnerResolveApplicationScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
);

// The application's windows that report `litPanel`'s display, in list order; a window that is gone
// or names no display is left out. Nil when the window list itself cannot be read.
FOUNDATION_EXPORT NSArray * _Nullable RunnerCopyLitPanelWindows(id application, RunnerLitPanel litPanel);

// `RunnerResolveApplicationScreen` for a multi-panel device: the window comes from
// `RunnerResolveLitPanelWindow` instead of the application's first window.
FOUNDATION_EXPORT BOOL RunnerResolveLitPanelScreen(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
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

// The sole XCTest display's pixel bounds divided by its scale, in points. Neither the runner's
// compatibility-mode `UIScreen` nor the system application's possibly empty AX frame supplies
// this measurement. Any failed read or a screen count other than one answers `CGSizeZero`.
#if TARGET_OS_IOS
FOUNDATION_EXPORT CGSize RunnerSoleScreenSize(void);
#endif

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
