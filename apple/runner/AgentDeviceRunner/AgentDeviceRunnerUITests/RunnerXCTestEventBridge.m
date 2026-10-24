#import "RunnerXCTestEventBridge.h"
#import "RunnerObjCExceptionCatcher.h"
#import <CoreGraphics/CoreGraphics.h>
#import <XCTest/XCTest.h>
#import <math.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#endif

// AGENT_DEVICE_FULL_SCREEN_RULE_BEGIN
// One rule, two targets. The Simulator snapshot bridge refuses a capture whose app window does not
// fill the screen (`app-window-not-full-screen`, #3844), and the runner refuses to route a
// window-less gesture onto a screen it cannot prove the app fills. The two builds read disjoint
// source roots whose packaged layouts differ, so no include path reaches both; this block is
// carried by both sources and pinned byte-identical by
// `test/repo-guards/full-screen-rule-parity.test.ts`. Each caller keeps its own unknown policy.
@protocol AgentDeviceForegroundElement <NSObject>
+ (nullable id<AgentDeviceForegroundElement>)primaryApp;
+ (nullable id<AgentDeviceForegroundElement>)systemApplication;
- (pid_t)pid;
- (CGRect)frame;
@end

// While a system surface owns the foreground, no screen is the target app's to fill and no tree is
// the target app's to capture (ADR 0004, foreground ownership).
static BOOL AgentDeviceForegroundOwnershipMatches(pid_t primaryProcessID, pid_t targetProcessID) {
  return primaryProcessID == targetProcessID;
}

// Sub-pixel layout rounding is not a window; anything past this is one that shows the app in part
// of the screen (Windowed Apps or Stage Manager).
static const CGFloat AgentDeviceFullScreenFrameTolerance = 0.5;

static BOOL AgentDeviceForegroundWindowFillsScreen(CGRect window, CGRect screen) {
  return fabs(window.origin.x - screen.origin.x) <= AgentDeviceFullScreenFrameTolerance &&
      fabs(window.origin.y - screen.origin.y) <= AgentDeviceFullScreenFrameTolerance &&
      fabs(window.size.width - screen.size.width) <= AgentDeviceFullScreenFrameTolerance &&
      fabs(window.size.height - screen.size.height) <= AgentDeviceFullScreenFrameTolerance;
}
// AGENT_DEVICE_FULL_SCREEN_RULE_END

NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  NSString *surface,
  RunnerXCTestEventBridge *bridge
) {
  Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
  Class pathClass = NSClassFromString(@"XCPointerEventPath");
  SEL addPathSelector = NSSelectorFromString(@"addPointerEventPath:");
  SEL setTargetProcessIDSelector = NSSelectorFromString(@"setTargetProcessID:");
  SEL synthesizeSelector = NSSelectorFromString(@"synthesizeWithError:");
  SEL processIDSelector = NSSelectorFromString(@"processID");

  NSString *missing = RunnerRequireClass(recordClass, @"XCSynthesizedEventRecord", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireClass(pathClass, @"XCPointerEventPath", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, addPathSelector, @"addPointerEventPath:", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    recordClass, setTargetProcessIDSelector, @"setTargetProcessID:", surface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, synthesizeSelector, @"synthesizeWithError:", surface);
  if (missing != nil) return missing;
  missing = RunnerRequireApplicationSelector(application, processIDSelector, @"processID", surface);
  if (missing != nil) return missing;

  *bridge = (RunnerXCTestEventBridge){
    .recordClass = recordClass,
    .pathClass = pathClass,
    .addPathSelector = addPathSelector,
    .setTargetProcessIDSelector = setTargetProcessIDSelector,
    .synthesizeSelector = synthesizeSelector,
    .processIDSelector = processIDSelector,
  };
  return nil;
}

NSString * _Nullable RunnerRequireClass(Class cls, NSString *className, NSString *surface) {
  if (cls == Nil) {
    return [NSString stringWithFormat:
      @"private XCTest %@ synthesis unavailable: missing %@",
      surface,
      className
    ];
  }
  return nil;
}

NSString * _Nullable RunnerRequireSelector(
  Class cls,
  SEL selector,
  NSString *selectorName,
  NSString *surface
) {
  if (![cls instancesRespondToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest %@ synthesis unavailable: %@ missing %@",
      surface,
      NSStringFromClass(cls),
      selectorName
    ];
  }
  return nil;
}

NSString * _Nullable RunnerRequireApplicationSelector(
  id application,
  SEL selector,
  NSString *selectorName,
  NSString *surface
) {
  if (![application respondsToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest %@ synthesis unavailable: XCUIApplication missing %@",
      surface,
      selectorName
    ];
  }
  return nil;
}

NSString *RunnerFormatXCTestException(NSException *exception, NSString *fallbackReason) {
  NSString *name = exception.name ?: @"NSException";
  NSString *reason = exception.reason ?: fallbackReason;
  return [NSString stringWithFormat:@"%@: %@", name, reason];
}

static BOOL RunnerUsableWindowFrame(CGRect frame) {
  if (CGRectIsEmpty(frame) || CGRectIsInfinite(frame) || CGRectIsNull(frame)) {
    return NO;
  }
  return isfinite(frame.origin.x) && isfinite(frame.origin.y)
    && isfinite(frame.size.width) && isfinite(frame.size.height);
}

static NSString *RunnerApplicationScreenFailureDescription(
  RunnerApplicationScreenFailure failure
) {
  switch (failure) {
    case RunnerApplicationScreenFailureUnresolvedWindow:
      return @"no resolved application window";
    case RunnerApplicationScreenFailureUnresolvedScreen:
      return @"no resolved window display ID";
    case RunnerApplicationScreenFailureNone:
      return @"application screen resolved";
  }
}

// One window read. XCTest answers with a value or raises. The window object is handed back because
// resolving this instance is what its `screen` will answer from — re-querying `firstMatch` would
// return an unresolved element that still names the main screen.
//
// Both answers are required. An app with no window answers `frame` with `(0,0 0x0)` without raising,
// which geometry alone would read as a window the runtime has not measured, and only the query
// itself says whether it has one. Measured on a live Duo: the runner host process, which has no
// window, answers `exists` NO and `frame` `(0,0 0x0)` (#2728).
//
// The frame the read produced is reported even when it is refused: a capture that fails closed has
// to say what it looked at, or the reason code cannot be told apart from a stale device.
static RunnerApplicationScreenFailure RunnerResolveUsableWindow(
  id application,
  id _Nullable *window,
  CGRect *observedFrame
) {
  __block id readWindow = nil;
  __block CGRect frame = CGRectNull;
  __block BOOL resolved = NO;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id candidate = [[application valueForKey:@"windows"] valueForKey:@"firstMatch"];
    NSNumber *present = [candidate valueForKey:@"exists"];
    resolved = [present isKindOfClass:NSNumber.class] && present.boolValue;
    NSValue *frameValue = [candidate valueForKey:@"frame"];
    [frameValue getValue:&frame size:sizeof(frame)];
    readWindow = candidate;
  }];
  *observedFrame = frame;
  if (exception != nil || !resolved || !RunnerUsableWindowFrame(frame)) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=window frame=(%g,%g %gx%g) raised=%@ resolved=%@",
      frame.origin.x,
      frame.origin.y,
      frame.size.width,
      frame.size.height,
      exception != nil ? @"yes" : @"no",
      resolved ? @"yes" : @"no"
    );
    return RunnerApplicationScreenFailureUnresolvedWindow;
  }
  *window = readWindow;
  return RunnerApplicationScreenFailureNone;
}

// The screen read that must follow window resolution on that same window instance. Before the
// frame above is asked for, the window's `screen` can still name main, so this is never merged
// into the read ahead of it.
static RunnerApplicationScreenFailure RunnerReadResolvedWindowScreen(
  id window,
  CGRect windowFrame,
  id _Nullable *screen,
  NSUInteger *displayID
) {
  __block id readScreen = nil;
  __block NSUInteger readDisplayID = 0;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id windowScreen = [window valueForKey:@"screen"];
    NSNumber *identifier = [windowScreen valueForKey:@"displayID"];
    if (![identifier isKindOfClass:NSNumber.class] || identifier.unsignedIntegerValue == 0) {
      return;
    }
    readScreen = windowScreen;
    readDisplayID = identifier.unsignedIntegerValue;
  }];
  if (exception != nil || readScreen == nil) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=screen frame=(%g,%g %gx%g) raised=%@",
      windowFrame.origin.x,
      windowFrame.origin.y,
      windowFrame.size.width,
      windowFrame.size.height,
      exception != nil ? @"yes" : @"no"
    );
    return RunnerApplicationScreenFailureUnresolvedScreen;
  }
  *screen = readScreen;
  *displayID = readDisplayID;
  return RunnerApplicationScreenFailureNone;
}

BOOL RunnerResolveApplicationScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
) {
  *screen = nil;
  *displayID = 0;
  id window = nil;
  CGRect windowFrame = CGRectNull;
  *failure = RunnerResolveUsableWindow(application, &window, &windowFrame);
  if (*failure != RunnerApplicationScreenFailureNone) {
    return NO;
  }
  *failure = RunnerReadResolvedWindowScreen(window, windowFrame, screen, displayID);
  return *failure == RunnerApplicationScreenFailureNone;
}

// Reads the display ID off a window the caller already resolved, so a synthesized record can be
// routed by the same window its reference frame was measured on. The window still resolves here:
// its frame is read before its screen, and a window that answers empty or raises fails closed with
// the same reasons the application walk gives.
NSString * _Nullable RunnerResolveSoleScreenDisplayID(id application, NSUInteger *displayID) {
  id screen = nil;
  return RunnerResolveSoleScreen(application, &screen, displayID);
}

RunnerFullScreenEvidence RunnerFullScreenEvidenceFromForeground(
  pid_t targetProcessID,
  pid_t primaryProcessID,
  CGRect appFrame,
  CGRect screenFrame
) {
  // A pid that could not be read (or cannot own a process) proves nothing about ownership, so the
  // answer is Unknown, never a guess that the app is not the primary app.
  if (targetProcessID <= 0 || primaryProcessID <= 0) {
    return RunnerFullScreenEvidenceUnknown;
  }
  if (!AgentDeviceForegroundOwnershipMatches(primaryProcessID, targetProcessID)) {
    return RunnerFullScreenEvidenceNotPrimaryApp;
  }
  if (CGRectIsNull(appFrame) || CGRectIsNull(screenFrame) ||
      CGRectIsEmpty(appFrame) || CGRectIsEmpty(screenFrame)) {
    return RunnerFullScreenEvidenceUnknown;
  }
  return AgentDeviceForegroundWindowFillsScreen(appFrame, screenFrame)
    ? RunnerFullScreenEvidenceFillsScreen
    : RunnerFullScreenEvidenceWindowed;
}

BOOL RunnerSoleScreenRouteOpensForEvidence(
  BOOL isPhoneIdiom,
  RunnerFullScreenEvidence evidence
) {
  // An iPhone keeps every app full-screen, so its sole screen is that app's frame whatever the
  // probe reports. An iPad can show an app in part of its only screen, so the route opens only
  // while the proof says fills-screen.
  return isPhoneIdiom || evidence == RunnerFullScreenEvidenceFillsScreen;
}

#if TARGET_OS_IOS

// The Simulator AX bridge guest loads these two private frameworks and reaches the primary app and
// the system app through the AXElement class the first one defines. The runner reaches the same two
// frames the same way, through the protocol in the shared block above.
static NSString *const RunnerAXRuntimePath =
  @"/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime";
static NSString *const RunnerXCTAutomationSupportPath =
  @"/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework/XCTAutomationSupport";

static Class<AgentDeviceForegroundElement> _Nullable RunnerForegroundElementClass(void) {
  // Cache the answer including its absence: a runtime without the class would otherwise pay two
  // RTLD_NOW lookups per window-less gesture forever.
  static BOOL resolved = NO;
  static Class<AgentDeviceForegroundElement> _Nullable cached = Nil;
  if (!resolved) {
    Class element = objc_lookUpClass("AXElement");
    if (element == Nil) {
      // Loading the frameworks is what registers the class; the bridge guest loads the same pair.
      dlopen(RunnerAXRuntimePath.UTF8String, RTLD_NOW);
      dlopen(RunnerXCTAutomationSupportPath.UTF8String, RTLD_NOW);
      element = objc_lookUpClass("AXElement");
    }
    cached = (Class<AgentDeviceForegroundElement>)element;
    resolved = YES;
  }
  return cached;
}

static id<AgentDeviceForegroundElement> _Nullable RunnerForegroundElement(
  Class<AgentDeviceForegroundElement> element,
  SEL selector
) {
  if (![element respondsToSelector:selector]) {
    return nil;
  }
  __block id<AgentDeviceForegroundElement> value = nil;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    value = ((id (*)(id, SEL))objc_msgSend)(element, selector);
  }];
  return exception != nil ? nil : value;
}

static CGRect RunnerForegroundElementFrame(id<AgentDeviceForegroundElement> element) {
  if (![element respondsToSelector:@selector(frame)]) {
    return CGRectNull;
  }
  __block CGRect frame = CGRectNull;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    frame = ((CGRect (*)(id, SEL))objc_msgSend)(element, @selector(frame));
  }];
  return exception != nil ? CGRectNull : frame;
}

// A pid that cannot be read ends as 0, which the decision seam already maps to Unknown: pid 0 is
// never a real process.
static pid_t RunnerForegroundElementPid(id<AgentDeviceForegroundElement> element) {
  if (![element respondsToSelector:@selector(pid)]) {
    return 0;
  }
  __block pid_t value = 0;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    value = (pid_t)((int (*)(id, SEL))objc_msgSend)(element, @selector(pid));
  }];
  return exception != nil ? 0 : value;
}

static RunnerFullScreenEvidence RunnerProbeApplicationFillsScreen(id application) {
  if (application == nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  Class<AgentDeviceForegroundElement> element = RunnerForegroundElementClass();
  if (element == Nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  id<AgentDeviceForegroundElement> primaryApp =
    RunnerForegroundElement(element, @selector(primaryApp));
  id<AgentDeviceForegroundElement> systemApp =
    RunnerForegroundElement(element, @selector(systemApplication));
  if (primaryApp == nil || systemApp == nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  // processID returns pid_t (int32); cast the send through `int` so only the defined low 32 bits
  // are read on arm64.
  __block NSInteger targetProcessID = 0;
  NSString *processIDException = [RunnerObjCExceptionCatcher catchException:^{
    if ([application respondsToSelector:@selector(processID)]) {
      targetProcessID =
        (NSInteger)((int (*)(id, SEL))objc_msgSend)(application, @selector(processID));
    }
  }];
  if (processIDException != nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  pid_t primaryProcessID = RunnerForegroundElementPid(primaryApp);
  CGRect window = RunnerForegroundElementFrame(primaryApp);
  CGRect screen = RunnerForegroundElementFrame(systemApp);
  RunnerFullScreenEvidence evidence = RunnerFullScreenEvidenceFromForeground(
    (pid_t)targetProcessID,
    primaryProcessID,
    window,
    screen
  );
  // The flag covers the fills-screen line only: the nightly iPad leg greps for it, so a first
  // windowed or unknown answer must not spend the one-shot flag and hide a later fill. A refusal
  // stays worth a line each time it routes a gesture away, so it logs every time.
  static BOOL loggedFills = NO;
  if (evidence == RunnerFullScreenEvidenceFillsScreen && loggedFills) {
    return evidence;
  }
  loggedFills = loggedFills || evidence == RunnerFullScreenEvidenceFillsScreen;
  NSLog(
      @"AGENT_DEVICE_RUNNER_FULL_SCREEN_EVIDENCE result=%@ targetPid=%d primaryPid=%d window=(%g,%g %gx%g) screen=(%g,%g %gx%g)",
      evidence == RunnerFullScreenEvidenceFillsScreen ? @"fills-screen"
        : evidence == RunnerFullScreenEvidenceWindowed ? @"windowed"
        : evidence == RunnerFullScreenEvidenceNotPrimaryApp ? @"not-primary-app" : @"unknown",
      (int)targetProcessID, (int)primaryProcessID,
      window.origin.x, window.origin.y, window.size.width, window.size.height,
      screen.origin.x, screen.origin.y, screen.size.width, screen.size.height
    );
  return evidence;
}

#endif

NSString * _Nullable RunnerResolveSoleScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID
) {
  *screen = nil;
#if TARGET_OS_IOS
  // An iPhone keeps every app full-screen, so its idiom answers the rule and the route never pays
  // for the probe; off the phone idiom the evidence seam decides. `RunnerProbeApplicationFillsScreen`
  // therefore only ever reports what it proved or failed to prove, never "not probed".
  if (UIDevice.currentDevice.userInterfaceIdiom != UIUserInterfaceIdiomPhone) {
    const RunnerFullScreenEvidence evidence = RunnerProbeApplicationFillsScreen(application);
    if (!RunnerSoleScreenRouteOpensForEvidence(NO, evidence)) {
      return @"private XCTest event synthesis unavailable: no resolved application window, and the sole screen is not provably the app's full-screen frame";
    }
  }
#else
  return @"private XCTest event synthesis unavailable: no resolved application window";
#endif
  __block NSUInteger screenCount = 0;
  __block NSUInteger readDisplayID = 0;
  __block XCUIScreen *soleScreen = nil;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    NSArray<XCUIScreen *> *screens = XCUIScreen.screens;
    screenCount = screens.count;
    if (screenCount != 1) return;
    NSNumber *identifier = [screens.firstObject valueForKey:@"displayID"];
    if ([identifier isKindOfClass:NSNumber.class]) {
      readDisplayID = identifier.unsignedIntegerValue;
      soleScreen = screens.firstObject;
    }
  }];
  if (exception != nil || screenCount != 1 || readDisplayID == 0) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=sole-screen screens=%lu raised=%@",
      (unsigned long)screenCount,
      exception != nil ? @"yes" : @"no"
    );
    return @"private XCTest event synthesis unavailable: no resolved application window and no sole screen to route to";
  }
  *screen = soleScreen;
  *displayID = readDisplayID;
  return nil;
}

NSString * _Nullable RunnerResolveWindowDisplayID(id window, NSUInteger *displayID) {
  __block CGRect frame = CGRectNull;
  NSString *frameException = [RunnerObjCExceptionCatcher catchException:^{
    NSValue *frameValue = [window valueForKey:@"frame"];
    [frameValue getValue:&frame size:sizeof(frame)];
  }];
  if (frameException != nil || !RunnerUsableWindowFrame(frame)) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=window frame=(%g,%g %gx%g) raised=%@",
      frame.origin.x,
      frame.origin.y,
      frame.size.width,
      frame.size.height,
      frameException != nil ? @"yes" : @"no"
    );
    return [NSString stringWithFormat:
      @"private XCTest event synthesis unavailable: %@",
      RunnerApplicationScreenFailureDescription(RunnerApplicationScreenFailureUnresolvedWindow)
    ];
  }
  id screen = nil;
  NSUInteger resolvedDisplayID = 0;
  RunnerApplicationScreenFailure failure =
    RunnerReadResolvedWindowScreen(window, frame, &screen, &resolvedDisplayID);
  if (failure != RunnerApplicationScreenFailureNone) {
    return [NSString stringWithFormat:
      @"private XCTest event synthesis unavailable: %@",
      RunnerApplicationScreenFailureDescription(failure)
    ];
  }
  *displayID = resolvedDisplayID;
  return nil;
}
