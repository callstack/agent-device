#import "RunnerXCTestEventBridge.h"
#import "RunnerObjCExceptionCatcher.h"
#import "RunnerAXSnapshotBridge.h"
// The shared full-screen rule, from the snapshot bridge; found via HEADER_SEARCH_PATHS.
#import "ForegroundApplicationGeometry.h"
#import <CoreGraphics/CoreGraphics.h>
#import <XCTest/XCTest.h>
#import <math.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#endif

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
  if (exception != nil || !resolved || !AgentDeviceForegroundFrameIsMeasurable(frame)) {
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
  // A frame that is not a usable measurement is a runtime that said nothing, not a window that
  // differs, so the answer is Unknown, never the Windowed a comparison of the numbers would read as.
  if (!AgentDeviceForegroundFramesAreMeasurable(appFrame, screenFrame)) {
    return RunnerFullScreenEvidenceUnknown;
  }
  return AgentDeviceForegroundWindowFillsScreen(appFrame, screenFrame)
    ? RunnerFullScreenEvidenceFillsScreen
    : RunnerFullScreenEvidenceWindowed;
}

#if TARGET_OS_IOS

// The private AXElement class the shared protocol describes comes from AXRuntime; the bridge guest
// loads the same pair of private frameworks to reach it.
static NSString *const RunnerAXRuntimePath =
  @"/System/Library/PrivateFrameworks/AXRuntime.framework/AXRuntime";
static NSString *const RunnerXCTAutomationSupportPath =
  @"/Developer/Library/PrivateFrameworks/XCTAutomationSupport.framework/XCTAutomationSupport";

static Class<AgentDeviceForegroundElement> _Nullable RunnerForegroundElementClass(void) {
  // Cache the answer including its absence: a runtime without the class would otherwise pay two
  // RTLD_NOW lookups per window-less gesture forever. Code availability is the only thing cached
  // here — the probe re-measures every attempt, because a resize changes the answer.
  static BOOL resolved = NO;
  static Class<AgentDeviceForegroundElement> _Nullable cached = Nil;
  if (!resolved) {
    Class element = objc_lookUpClass("AXElement");
    if (element == Nil) {
      dlopen(RunnerAXRuntimePath.UTF8String, RTLD_NOW);
      dlopen(RunnerXCTAutomationSupportPath.UTF8String, RTLD_NOW);
      element = objc_lookUpClass("AXElement");
    }
    cached = (Class<AgentDeviceForegroundElement>)element;
    resolved = YES;
  }
  return cached;
}

// One contained probe: it checks each selector before sending it and reads the target pid, the
// primary app's frame, and the system app's frame inside one exception scope, so any failed read
// answers Unknown — the same typed nothing-a-guess the decision seam already reports. The target
// pid comes from the existing runner owner for that read (RunnerAXSnapshotBridge), which picks the
// correctly sized send for the pid_t return through the method signature.
static RunnerFullScreenEvidence RunnerProbeApplicationFillsScreen(id application) {
  if (application == nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  Class<AgentDeviceForegroundElement> element = RunnerForegroundElementClass();
  if (element == Nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  if (![element respondsToSelector:@selector(primaryApp)] ||
      ![element respondsToSelector:@selector(systemApplication)]) {
    return RunnerFullScreenEvidenceUnknown;
  }
  __block pid_t targetProcessID = 0;
  __block pid_t primaryProcessID = 0;
  __block CGRect window = CGRectNull;
  __block CGRect screen = CGRectNull;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id<AgentDeviceForegroundElement> primaryApp = [element primaryApp];
    id<AgentDeviceForegroundElement> systemApp = [element systemApplication];
    if (primaryApp == nil || systemApp == nil ||
        ![primaryApp respondsToSelector:@selector(pid)] ||
        ![primaryApp respondsToSelector:@selector(frame)] ||
        ![systemApp respondsToSelector:@selector(frame)]) {
      return;
    }
    targetProcessID = (pid_t)[RunnerAXSnapshotBridge
      processIdentifierForApplication:(XCUIApplication *)application];
    primaryProcessID = [primaryApp pid];
    window = [primaryApp frame];
    screen = [systemApp frame];
  }];
  if (exception != nil) {
    return RunnerFullScreenEvidenceUnknown;
  }
  return RunnerFullScreenEvidenceFromForeground(targetProcessID, primaryProcessID, window, screen);
}

#endif

NSString * _Nullable RunnerResolveSoleScreen(
  id application,
  id _Nullable *screen,
  NSUInteger *displayID
) {
  *screen = nil;
#if TARGET_OS_IOS
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
  // An iPhone keeps every app full-screen, so its idiom answers the rule and the route never pays
  // for the probe. Off the phone idiom the route opens only on the fills-screen proof — an iPad can
  // show an app in part of its only screen — and windowed or unknown evidence keeps requiring a
  // window. The probe answers only what it proved or failed to prove, never "not probed".
  if (UIDevice.currentDevice.userInterfaceIdiom != UIUserInterfaceIdiomPhone &&
      RunnerProbeApplicationFillsScreen(application) != RunnerFullScreenEvidenceFillsScreen) {
    return @"private XCTest event synthesis unavailable: no resolved application window, and the sole screen is not provably the app's full-screen frame";
  }
  *screen = soleScreen;
  *displayID = readDisplayID;
  return nil;
#else
  return @"private XCTest event synthesis unavailable: no resolved application window";
#endif
}

NSString * _Nullable RunnerResolveWindowDisplayID(id window, NSUInteger *displayID) {
  __block CGRect frame = CGRectNull;
  NSString *frameException = [RunnerObjCExceptionCatcher catchException:^{
    NSValue *frameValue = [window valueForKey:@"frame"];
    [frameValue getValue:&frame size:sizeof(frame)];
  }];
  if (frameException != nil || !AgentDeviceForegroundFrameIsMeasurable(frame)) {
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
