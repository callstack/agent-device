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
    case RunnerApplicationScreenFailureOffLitPanel:
      return @"every application window is off the lit panel";
    case RunnerApplicationScreenFailureNone:
      return @"application screen resolved";
  }
}

// One window read. Both answers are required: an app with no window answers `frame` with
// `(0,0 0x0)` without raising, so only `exists` says whether the window is there. The window
// object is handed back because resolving this instance is what its `screen` will answer from.
// The frame is reported even when refused, so a refusal names what it looked at.
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

// The screen read that must follow window resolution on that same window instance: before the frame
// is asked for, `screen` can still name main, so this never merges into the read ahead of it.
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

static BOOL RunnerFrameFillsLitPanel(CGRect frame, RunnerLitPanel panel) {
  const CGFloat tolerance = 0.5;
  if (fabs(frame.origin.x) > tolerance || fabs(frame.origin.y) > tolerance) {
    return NO;
  }
  BOOL upright = fabs(frame.size.width - panel.widthPt) <= tolerance &&
    fabs(frame.size.height - panel.heightPt) <= tolerance;
  BOOL turned = fabs(frame.size.width - panel.heightPt) <= tolerance &&
    fabs(frame.size.height - panel.widthPt) <= tolerance;
  return upright || turned;
}

// One window: whether it is there, its frame, and the display showing it. `frame` is not asked of a
// window that says it is gone, because that read records an XCTest issue (#2995).
static RunnerApplicationScreenFailure RunnerReadLitPanelCandidate(
  id candidate,
  CGRect *frame,
  id _Nullable *screen,
  NSUInteger *displayID
) {
  __block CGRect readFrame = CGRectNull;
  __block BOOL present = NO;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    NSNumber *exists = [candidate valueForKey:@"exists"];
    present = [exists isKindOfClass:NSNumber.class] && exists.boolValue;
    if (present) {
      [[candidate valueForKey:@"frame"] getValue:&readFrame size:sizeof(readFrame)];
    }
  }];
  *frame = readFrame;
  if (exception != nil || !present || !AgentDeviceForegroundFrameIsMeasurable(readFrame)) {
    return RunnerApplicationScreenFailureUnresolvedWindow;
  }
  return RunnerReadResolvedWindowScreen(candidate, readFrame, screen, displayID);
}

// The application's window list, or nil when the query raises or answers no list.
static NSArray *_Nullable RunnerCopyWindowList(id application) {
  __block NSArray *windows = nil;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id elements = [[application valueForKey:@"windows"] valueForKey:@"allElementsBoundByIndex"];
    windows = [elements isKindOfClass:NSArray.class] ? elements : nil;
  }];
  return exception == nil ? windows : nil;
}

RunnerApplicationScreenFailure RunnerResolveLitPanelWindow(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *window,
  CGRect *windowFrame,
  id _Nullable *screen
) {
  *window = nil;
  *windowFrame = CGRectNull;
  *screen = nil;
  // An unread list is not an app without windows, so it never reaches the system-surface fallback.
  NSArray *windows = RunnerCopyWindowList(application);
  if (windows == nil) {
    return RunnerApplicationScreenFailureUnresolvedScreen;
  }
  // A window the walk could not place may be the panel's surface, so it refuses every booking. A
  // list past the cap refuses only when no full-panel window was found before it.
  BOOL unplaced = NO;
  BOOL truncated = windows.count > AGENT_DEVICE_MAX_LIT_PANEL_WINDOWS;
  BOOL placedAny = NO;
  id chosen = nil;
  id chosenScreen = nil;
  CGRect chosenFrame = CGRectNull;
  RunnerApplicationScreenFailure outcome = RunnerApplicationScreenFailureUnresolvedWindow;
  NSUInteger count = MIN(windows.count, (NSUInteger)AGENT_DEVICE_MAX_LIT_PANEL_WINDOWS);
  for (NSUInteger index = 0; index < count; index += 1) {
    id candidate = windows[index];
    CGRect frame = CGRectNull;
    id candidateScreen = nil;
    NSUInteger displayID = 0;
    RunnerApplicationScreenFailure read =
      RunnerReadLitPanelCandidate(candidate, &frame, &candidateScreen, &displayID);
    if (read == RunnerApplicationScreenFailureUnresolvedWindow) {
      continue;
    }
    if (read != RunnerApplicationScreenFailureNone) {
      unplaced = YES;
      continue;
    }
    placedAny = YES;
    if (displayID != litPanel.displayID) {
      continue;
    }
    if (RunnerFrameFillsLitPanel(frame, litPanel)) {
      chosen = candidate;
      chosenScreen = candidateScreen;
      chosenFrame = frame;
      truncated = NO;
      break;
    }
    if (chosen == nil ||
        frame.size.width * frame.size.height > chosenFrame.size.width * chosenFrame.size.height) {
      chosen = candidate;
      chosenScreen = candidateScreen;
      chosenFrame = frame;
    }
  }
  if (unplaced || truncated) {
    outcome = RunnerApplicationScreenFailureUnresolvedScreen;
  } else if (chosen != nil) {
    outcome = RunnerApplicationScreenFailureNone;
    *window = chosen;
    *windowFrame = chosenFrame;
    *screen = chosenScreen;
  } else if (placedAny) {
    outcome = RunnerApplicationScreenFailureOffLitPanel;
  }
  NSLog(
    @"AGENT_DEVICE_RUNNER_LIT_PANEL_WINDOW lit=%lu(%gx%g) windows=%lu outcome=%@ frame=(%g,%g %gx%g)",
    (unsigned long)litPanel.displayID,
    litPanel.widthPt,
    litPanel.heightPt,
    (unsigned long)windows.count,
    RunnerApplicationScreenFailureDescription(outcome),
    chosenFrame.origin.x,
    chosenFrame.origin.y,
    chosenFrame.size.width,
    chosenFrame.size.height
  );
  return outcome;
}

NSArray *RunnerCopyLitPanelWindows(id application, NSUInteger litDisplayID) {
  NSArray *windows = RunnerCopyWindowList(application);
  if (windows == nil) {
    return nil;
  }
  NSMutableArray *lit = [NSMutableArray array];
  for (id candidate in windows) {
    CGRect frame = CGRectNull;
    id screen = nil;
    NSUInteger displayID = 0;
    if (RunnerReadLitPanelCandidate(candidate, &frame, &screen, &displayID) ==
          RunnerApplicationScreenFailureNone &&
        displayID == litDisplayID) {
      [lit addObject:candidate];
    }
  }
  return lit;
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

RunnerFullScreenEvidence RunnerFullScreenEvidenceFromForeground(
  pid_t targetProcessID,
  pid_t primaryProcessID,
  CGRect appFrame,
  CGRect screenFrame
) {
  if (targetProcessID <= 0 || primaryProcessID <= 0) {
    return RunnerFullScreenEvidenceUnknown;
  }
  if (primaryProcessID != targetProcessID) {
    return RunnerFullScreenEvidenceNotPrimaryApp;
  }
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
  // Cache the answer including its absence; code availability is all that is cached — the probe
  // re-measures every attempt because a resize changes the answer.
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

CGSize RunnerSoleScreenSize(void) {
  __block NSUInteger screenCount = 0;
  __block CGRect bounds = CGRectNull;
  __block CGFloat scale = 0;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    NSArray<XCUIScreen *> *screens = XCUIScreen.screens;
    screenCount = screens.count;
    if (screenCount != 1) return;
    XCUIScreen *screen = screens.firstObject;
    NSValue *boundsValue = [screen valueForKey:@"bounds"];
    [boundsValue getValue:&bounds size:sizeof(bounds)];
    NSNumber *scaleValue = [screen valueForKey:@"scale"];
    if ([scaleValue isKindOfClass:NSNumber.class]) scale = scaleValue.doubleValue;
  }];
  if (exception != nil || screenCount != 1 ||
      !AgentDeviceForegroundFrameIsMeasurable(bounds) || !isfinite(scale) || scale <= 0) {
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=sole-screen-size screens=%lu bounds=(%g,%g %gx%g) scale=%g raised=%@",
      (unsigned long)screenCount,
      bounds.origin.x,
      bounds.origin.y,
      bounds.size.width,
      bounds.size.height,
      scale,
      exception != nil ? @"yes" : @"no"
    );
    return CGSizeZero;
  }
  return CGSizeMake(bounds.size.width / scale, bounds.size.height / scale);
}

// One contained probe: it checks each selector before sending it and reads the target pid and both
// frames inside one exception scope, so any failed read answers Unknown. The target pid comes from
// the existing runner owner for that read (RunnerAXSnapshotBridge).
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
  // An iPhone keeps every app full-screen, so its idiom answers the rule and admission never pays
  // for the fills-screen probe. Off the phone idiom the route opens only on that proof. The display
  // size is a separate XCTest screen read the caller makes after admission, the first time
  // a command needs the box; a command keeps a successful read, and the next gesture retries a failed
  // one.
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
