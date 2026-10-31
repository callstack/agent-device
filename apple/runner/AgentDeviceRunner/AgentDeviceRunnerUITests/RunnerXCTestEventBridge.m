#import "RunnerXCTestEventBridge.h"
#import "RunnerObjCExceptionCatcher.h"
#import "RunnerAXSnapshotBridge.h"
// The shared full-screen rule, from the snapshot bridge; found via HEADER_SEARCH_PATHS.
#import "ForegroundApplicationGeometry.h"
// The panel rule this file's window walk applies.
#import "RunnerPanelSurface.h"
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

BOOL RunnerReadWindowExistsAndFrame(id window, CGRect *observedFrame) {
  __block CGRect frame = CGRectNull;
  __block BOOL resolved = NO;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    NSNumber *present = [window valueForKey:@"exists"];
    resolved = [present isKindOfClass:NSNumber.class] && present.boolValue;
    // A window that says it is not there is not asked for its frame. XCTest records an issue for a
    // frame read on a vanished element, an unmuted issue ends the runner session, and the walk asks
    // several candidates (#2995).
    if (!resolved) {
      return;
    }
    NSValue *frameValue = [window valueForKey:@"frame"];
    [frameValue getValue:&frame size:sizeof(frame)];
  }];
  *observedFrame = frame;
  if (exception != nil) {
    NSLog(@"AGENT_DEVICE_RUNNER_APP_WINDOW_FRAME_RAISED frame raised=%@", exception);
    return NO;
  }
  return resolved && AgentDeviceForegroundFrameIsMeasurable(frame);
}

NSArray *RunnerCopyApplicationWindowElements(
  id application,
  NSUInteger maxCount,
  NSUInteger *reportedCount
) {
  if (reportedCount != NULL) {
    *reportedCount = 0;
  }
  __block NSArray *windows = nil;
  NSString *exception = [RunnerObjCExceptionCatcher catchException:^{
    id elements = [[application valueForKey:@"windows"] valueForKey:@"allElementsBoundByIndex"];
    if ([elements isKindOfClass:NSArray.class]) {
      windows = elements;
    }
  }];
  if (exception != nil) {
    NSLog(@"AGENT_DEVICE_RUNNER_APP_WINDOWS_UNRESOLVED raised=%@", exception);
    return nil;
  }
  if (windows == nil) {
    return nil;
  }
  // The count is the list the query named, before the cap trims it, so a device whose window list
  // outgrows the walk is visible to whoever reads the marker.
  if (reportedCount != NULL) {
    *reportedCount = windows.count;
  }
  return windows.count <= maxCount ? windows : [windows subarrayWithRange:NSMakeRange(0, maxCount)];
}

// The screen read that must follow window resolution on that same window instance: before the frame
// is asked for, `screen` can still name main, so this never merges into the read ahead of it.
RunnerApplicationScreenFailure RunnerReadResolvedWindowScreen(
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
  if (screen != NULL) {
    *screen = readScreen;
  }
  *displayID = readDisplayID;
  return RunnerApplicationScreenFailureNone;
}

static RunnerApplicationScreenFailure RunnerSurfaceFailureFromPanelSelection(
  RunnerPanelSurfaceSelection selection
) {
  switch (selection) {
    case RunnerPanelSurfaceSelectionLitPanelWindow:
    case RunnerPanelSurfaceSelectionLitDisplayWindow:
      return RunnerApplicationScreenFailureNone;
    case RunnerPanelSurfaceSelectionOffLitPanel:
      return RunnerApplicationScreenFailureOffLitPanel;
    case RunnerPanelSurfaceSelectionNoWindow:
      return RunnerApplicationScreenFailureUnresolvedWindow;
  }
}

RunnerApplicationScreenFailure RunnerResolveSurfaceWindow(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *window,
  CGRect *windowFrame,
  CGRect *observedFrame
) {
  *window = nil;
  *windowFrame = CGRectNull;
  *observedFrame = CGRectNull;

  if (!RunnerLitPanelIsNamed(litPanel)) {
    // The historic read, and the only one a single-panel device ever takes: the first window the
    // query names that exists with a measurable box, and no display identity is asked for at all.
    // Each candidate is asked twice at most, and the walk stops at the answer, so a transient window
    // that vanishes mid-read is the only thing that can widen it (#2995).
    __block CGRect refusedFrame = CGRectNull;
    for (id candidate in RunnerCopyApplicationWindowElements(
           application, AGENT_DEVICE_MAX_PANEL_SURFACE_WINDOWS, NULL)) {
      CGRect frame = CGRectNull;
      if (!RunnerReadWindowExistsAndFrame(candidate, &frame)) {
        refusedFrame = frame;
        continue;
      }
      *window = candidate;
      *windowFrame = frame;
      *observedFrame = frame;
      return RunnerApplicationScreenFailureNone;
    }
    NSLog(
      @"AGENT_DEVICE_RUNNER_APP_SCREEN_UNRESOLVED stage=window frame=(%g,%g %gx%g) resolved=no",
      refusedFrame.origin.x,
      refusedFrame.origin.y,
      refusedFrame.size.width,
      refusedFrame.size.height
    );
    *observedFrame = refusedFrame;
    return RunnerApplicationScreenFailureUnresolvedWindow;
  }

  NSUInteger reported = 0;
  NSArray *candidates = RunnerCopyApplicationWindowElements(
    application,
    AGENT_DEVICE_MAX_PANEL_SURFACE_WINDOWS,
    &reported
  );
  NSMutableArray<id> *placed = [NSMutableArray array];
  RunnerPanelWindowFact facts[AGENT_DEVICE_MAX_PANEL_SURFACE_WINDOWS];
  NSUInteger factCount = 0;
  BOOL sawUnplaceableWindow = NO;
  for (id candidate in candidates) {
    if (factCount == AGENT_DEVICE_MAX_PANEL_SURFACE_WINDOWS) {
      break;
    }
    CGRect frame = CGRectNull;
    if (!RunnerReadWindowExistsAndFrame(candidate, &frame)) {
      continue;
    }
    NSUInteger displayID = 0;
    if (RunnerReadResolvedWindowScreen(candidate, frame, NULL, &displayID) !=
        RunnerApplicationScreenFailureNone) {
      // The window is there but the runtime will not say which display shows it, so the panel rule
      // cannot place it. The rest of the walk still gets its chance.
      sawUnplaceableWindow = YES;
      *observedFrame = frame;
      continue;
    }
    facts[factCount] = (RunnerPanelWindowFact){.displayID = displayID, .frame = frame};
    factCount += 1;
    [placed addObject:candidate];
  }

  RunnerPanelWindowFact chosen = {.displayID = 0, .frame = CGRectNull};
  NSUInteger chosenIndex = NSUIntegerMax;
  RunnerPanelSurfaceSelection selection = RunnerPanelSurfaceSelectionNoWindow;
  if (factCount > 0) {
    selection = RunnerPanelSurfaceSelectWindow(
      facts,
      factCount,
      litPanel,
      &chosen,
      &chosenIndex
    );
  }
  NSLog(
    @"AGENT_DEVICE_RUNNER_PANEL_SURFACE lit=%lu(%.1fx%.1f) reported=%lu placed=%lu unplaceable=%@ selection=%lu frame=(%g,%g %gx%g)",
    (unsigned long)litPanel.displayID,
    litPanel.widthPt,
    litPanel.heightPt,
    (unsigned long)reported,
    (unsigned long)factCount,
    sawUnplaceableWindow ? @"yes" : @"no",
    (unsigned long)selection,
    chosen.frame.origin.x,
    chosen.frame.origin.y,
    chosen.frame.size.width,
    chosen.frame.size.height
  );
  // `observedFrame` keeps the last frame the walk measured, so on a refusal it names what the walk
  // refused instead of a null box.
  RunnerApplicationScreenFailure failure = RunnerSurfaceFailureFromPanelSelection(selection);
  if (failure != RunnerApplicationScreenFailureNone) {
    if (factCount == 0 && sawUnplaceableWindow) {
      return RunnerApplicationScreenFailureUnresolvedScreen;
    }
    return failure;
  }
  *observedFrame = chosen.frame;
  // The rule indexes the windows it was handed, so this cannot trip; it bounds the subscript that
  // follows rather than trusting the index across the rule boundary.
  if (chosenIndex >= placed.count) {
    return RunnerApplicationScreenFailureUnresolvedWindow;
  }
  *window = placed[chosenIndex];
  *windowFrame = chosen.frame;
  return RunnerApplicationScreenFailureNone;
}

BOOL RunnerResolveApplicationScreen(
  id application,
  RunnerLitPanel litPanel,
  id _Nullable *screen,
  NSUInteger *displayID,
  RunnerApplicationScreenFailure *failure
) {
  *screen = nil;
  *displayID = 0;
  id window = nil;
  CGRect windowFrame = CGRectNull;
  CGRect observedFrame = CGRectNull;
  *failure = RunnerResolveSurfaceWindow(application, litPanel, &window, &windowFrame, &observedFrame);
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
  // An iPhone keeps every app full-screen, so its idiom answers the rule and the route never pays
  // for the probe. Off the phone idiom the route opens only on the fills-screen proof.
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
