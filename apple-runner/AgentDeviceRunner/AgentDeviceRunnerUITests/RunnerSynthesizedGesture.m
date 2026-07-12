#import "RunnerSynthesizedGesture.h"

#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>

typedef NSInteger (*RunnerMsgSendInteger)(id, SEL);
typedef id (*RunnerMsgSendInitRecord)(id, SEL, NSString *, NSInteger);
typedef id (*RunnerMsgSendInitPath)(id, SEL, CGPoint, NSTimeInterval);
typedef void (*RunnerMsgSendPathMove)(id, SEL, CGPoint, NSTimeInterval);
typedef void (*RunnerMsgSendPathOffset)(id, SEL, NSTimeInterval);
typedef void (*RunnerMsgSendAddPath)(id, SEL, id);
typedef void (*RunnerMsgSendSetInteger)(id, SEL, NSInteger);
typedef BOOL (*RunnerMsgSendSynthesize)(id, SEL, NSError **);

typedef struct {
  Class recordClass;
  Class pathClass;
  SEL initRecordSelector;
  SEL addPathSelector;
  SEL setTargetProcessIDSelector;
  SEL synthesizeSelector;
  SEL interfaceOrientationSelector;
  SEL processIDSelector;
  SEL initPathSelector;
  SEL moveSelector;
  SEL liftSelector;
} RunnerXCTestEventBridge;

typedef id (*RunnerDragPointerPathFactory)(
  const RunnerXCTestEventBridge *,
  CGPoint,
  CGPoint,
  double
);

static NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  RunnerXCTestEventBridge *bridge
);
static NSString * _Nullable RunnerRequireClass(Class cls, NSString *className);
static NSString * _Nullable RunnerRequireSelector(Class cls, SEL selector, NSString *selectorName);
static NSString * _Nullable RunnerRequireApplicationSelector(id application, SEL selector, NSString *selectorName);
static id RunnerSwipePointerPath(
  const RunnerXCTestEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
);
static id RunnerContinuousDragPointerPath(
  const RunnerXCTestEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
);
static NSString * _Nullable RunnerTrySynthesizeDrag(
  id application,
  CGPoint start,
  CGPoint end,
  double durationMs,
  NSString *recordName,
  RunnerDragPointerPathFactory pathFactory
);
// XCTest's proven swipe profile reaches the endpoint in 100 ms, then holds for the planned
// fling duration. Fast movement is what lets UIKit distinguish a fling from a timed pan.
static const NSTimeInterval RunnerSwipeMovementDurationSeconds = 0.1;
static id RunnerTapPointerPath(
  const RunnerXCTestEventBridge *bridge,
  CGPoint point
);

@implementation RunnerSynthesizedGesture

+ (NSString * _Nullable)synthesizeSwipeWithApplication:(id)application
                                                    x:(double)x
                                                    y:(double)y
                                                   x2:(double)x2
                                                   y2:(double)y2
                                            durationMs:(double)durationMs {
  @try {
    return RunnerTrySynthesizeDrag(
      application,
      CGPointMake(x, y),
      CGPointMake(x2, y2),
      durationMs,
      @"agent-device-swipe",
      RunnerSwipePointerPath
    );
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest event synthesis failed";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
}

+ (NSString * _Nullable)synthesizeContinuousDragWithApplication:(id)application
                                                             x:(double)x
                                                             y:(double)y
                                                            x2:(double)x2
                                                            y2:(double)y2
                                                     durationMs:(double)durationMs {
  @try {
    return RunnerTrySynthesizeDrag(
      application,
      CGPointMake(x, y),
      CGPointMake(x2, y2),
      durationMs,
      @"agent-device-continuous-drag",
      RunnerContinuousDragPointerPath
    );
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest event synthesis failed";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
}

+ (NSString * _Nullable)synthesizeTapWithApplication:(id)application
                                                   x:(double)x
                                                   y:(double)y {
  @try {
    return [self trySynthesizeTapWithApplication:application x:x y:y];
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest event synthesis failed";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
}

+ (NSString * _Nullable)synthesizeGestureWithApplication:(id)application
                                          pointerSamples:(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *)pointerSamples {
  @try {
    RunnerXCTestEventBridge bridge;
    NSString *missing = RunnerResolveXCTestEventBridge(application, &bridge);
    if (missing != nil) return missing;

    NSInteger interfaceOrientation =
      ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.interfaceOrientationSelector);
    NSInteger targetProcessID =
      ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.processIDSelector);
    if (targetProcessID <= 0) {
      return @"private XCTest event synthesis unavailable: could not resolve target process ID";
    }

    id record = ((RunnerMsgSendInitRecord)objc_msgSend)(
      [bridge.recordClass alloc],
      bridge.initRecordSelector,
      @"agent-device-gesture-plan",
      interfaceOrientation
    );
    if (record == nil) {
      return @"private XCTest event synthesis failed: could not create event record";
    }
    ((RunnerMsgSendSetInteger)objc_msgSend)(record, bridge.setTargetProcessIDSelector, targetProcessID);

    for (NSArray<NSDictionary<NSString *, NSNumber *> *> *samples in pointerSamples) {
      NSDictionary<NSString *, NSNumber *> *first = samples.firstObject;
      if (first == nil) return @"private XCTest event synthesis failed: empty pointer path";
      CGPoint start = CGPointMake(first[@"x"].doubleValue, first[@"y"].doubleValue);
      id path = ((RunnerMsgSendInitPath)objc_msgSend)(
        [bridge.pathClass alloc],
        bridge.initPathSelector,
        start,
        first[@"offsetMs"].doubleValue / 1000.0
      );
      if (path == nil) {
        return @"private XCTest event synthesis failed: could not create pointer path";
      }
      for (NSUInteger index = 1; index < samples.count; index += 1) {
        NSDictionary<NSString *, NSNumber *> *sample = samples[index];
        CGPoint point = CGPointMake(sample[@"x"].doubleValue, sample[@"y"].doubleValue);
        ((RunnerMsgSendPathMove)objc_msgSend)(
          path,
          bridge.moveSelector,
          point,
          sample[@"offsetMs"].doubleValue / 1000.0
        );
      }
      NSDictionary<NSString *, NSNumber *> *last = samples.lastObject;
      ((RunnerMsgSendPathOffset)objc_msgSend)(
        path,
        bridge.liftSelector,
        last[@"offsetMs"].doubleValue / 1000.0
      );
      ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.addPathSelector, path);
    }

    NSError *error = nil;
    BOOL ok = ((RunnerMsgSendSynthesize)objc_msgSend)(record, bridge.synthesizeSelector, &error);
    if (!ok) {
      NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
      return [NSString stringWithFormat:@"private XCTest event synthesis failed: %@", detail];
    }
    return nil;
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest event synthesis failed";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
}

+ (NSInteger)interfaceOrientationForApplication:(id)application {
  SEL selector = NSSelectorFromString(@"interfaceOrientation");
  if (![application respondsToSelector:selector]) {
    return 0;  // UIInterfaceOrientationUnknown
  }
  return ((RunnerMsgSendInteger)objc_msgSend)(application, selector);
}

static NSString * _Nullable RunnerTrySynthesizeDrag(
  id application,
  CGPoint start,
  CGPoint end,
  double durationMs,
  NSString *recordName,
  RunnerDragPointerPathFactory pathFactory
) {
  RunnerXCTestEventBridge bridge;
  NSString *missing = RunnerResolveXCTestEventBridge(application, &bridge);
  if (missing != nil) {
    return missing;
  }

  NSInteger interfaceOrientation =
    ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.interfaceOrientationSelector);
  NSInteger targetProcessID = ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.processIDSelector);
  if (targetProcessID <= 0) {
    return @"private XCTest event synthesis unavailable: could not resolve target process ID";
  }

  id record = ((RunnerMsgSendInitRecord)objc_msgSend)(
    [bridge.recordClass alloc],
    bridge.initRecordSelector,
    recordName,
    interfaceOrientation
  );
  if (record == nil) {
    return @"private XCTest event synthesis failed: could not create event record";
  }
  ((RunnerMsgSendSetInteger)objc_msgSend)(record, bridge.setTargetProcessIDSelector, targetProcessID);

  id path = pathFactory(&bridge, start, end, durationMs);
  if (path == nil) {
    return @"private XCTest event synthesis failed: could not create pointer path";
  }
  ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.addPathSelector, path);

  NSError *error = nil;
  BOOL ok = ((RunnerMsgSendSynthesize)objc_msgSend)(record, bridge.synthesizeSelector, &error);
  if (!ok) {
    NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
    return [NSString stringWithFormat:@"private XCTest event synthesis failed: %@", detail];
  }
  return nil;
}

+ (NSString * _Nullable)trySynthesizeTapWithApplication:(id)application
                                                      x:(double)x
                                                      y:(double)y {
  RunnerXCTestEventBridge bridge;
  NSString *missing = RunnerResolveXCTestEventBridge(application, &bridge);
  if (missing != nil) {
    return missing;
  }

  NSInteger interfaceOrientation =
    ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.interfaceOrientationSelector);
  NSInteger targetProcessID = ((RunnerMsgSendInteger)objc_msgSend)(application, bridge.processIDSelector);
  if (targetProcessID <= 0) {
    return @"private XCTest event synthesis unavailable: could not resolve target process ID";
  }

  id record = ((RunnerMsgSendInitRecord)objc_msgSend)(
    [bridge.recordClass alloc],
    bridge.initRecordSelector,
    @"agent-device-tap",
    interfaceOrientation
  );
  if (record == nil) {
    return @"private XCTest event synthesis failed: could not create event record";
  }
  ((RunnerMsgSendSetInteger)objc_msgSend)(record, bridge.setTargetProcessIDSelector, targetProcessID);

  id path = RunnerTapPointerPath(&bridge, CGPointMake(x, y));
  if (path == nil) {
    return @"private XCTest event synthesis failed: could not create pointer path";
  }
  ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.addPathSelector, path);

  NSError *error = nil;
  BOOL ok = ((RunnerMsgSendSynthesize)objc_msgSend)(record, bridge.synthesizeSelector, &error);
  if (!ok) {
    NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
    return [NSString stringWithFormat:@"private XCTest event synthesis failed: %@", detail];
  }
  return nil;
}

static NSString * _Nullable RunnerResolveXCTestEventBridge(
  id application,
  RunnerXCTestEventBridge *bridge
) {
  Class recordClass = NSClassFromString(@"XCSynthesizedEventRecord");
  Class pathClass = NSClassFromString(@"XCPointerEventPath");
  SEL initRecordSelector = NSSelectorFromString(@"initWithName:interfaceOrientation:");
  SEL addPathSelector = NSSelectorFromString(@"addPointerEventPath:");
  SEL setTargetProcessIDSelector = NSSelectorFromString(@"setTargetProcessID:");
  SEL synthesizeSelector = NSSelectorFromString(@"synthesizeWithError:");
  SEL interfaceOrientationSelector = NSSelectorFromString(@"interfaceOrientation");
  SEL processIDSelector = NSSelectorFromString(@"processID");
  SEL initPathSelector = NSSelectorFromString(@"initForTouchAtPoint:offset:");
  SEL moveSelector = NSSelectorFromString(@"moveToPoint:atOffset:");
  SEL liftSelector = NSSelectorFromString(@"liftUpAtOffset:");

  NSString *missing = RunnerRequireClass(recordClass, @"XCSynthesizedEventRecord");
  if (missing != nil) return missing;
  missing = RunnerRequireClass(pathClass, @"XCPointerEventPath");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, initRecordSelector, @"initWithName:interfaceOrientation:");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, addPathSelector, @"addPointerEventPath:");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, setTargetProcessIDSelector, @"setTargetProcessID:");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(recordClass, synthesizeSelector, @"synthesizeWithError:");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(pathClass, initPathSelector, @"initForTouchAtPoint:offset:");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(pathClass, moveSelector, @"moveToPoint:atOffset:");
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(pathClass, liftSelector, @"liftUpAtOffset:");
  if (missing != nil) return missing;
  missing = RunnerRequireApplicationSelector(application, interfaceOrientationSelector, @"interfaceOrientation");
  if (missing != nil) return missing;
  missing = RunnerRequireApplicationSelector(application, processIDSelector, @"processID");
  if (missing != nil) return missing;

  *bridge = (RunnerXCTestEventBridge){
    .recordClass = recordClass,
    .pathClass = pathClass,
    .initRecordSelector = initRecordSelector,
    .addPathSelector = addPathSelector,
    .setTargetProcessIDSelector = setTargetProcessIDSelector,
    .synthesizeSelector = synthesizeSelector,
    .interfaceOrientationSelector = interfaceOrientationSelector,
    .processIDSelector = processIDSelector,
    .initPathSelector = initPathSelector,
    .moveSelector = moveSelector,
    .liftSelector = liftSelector,
  };
  return nil;
}

static NSString * _Nullable RunnerRequireClass(Class cls, NSString *className) {
  if (cls == Nil) {
    return [NSString stringWithFormat:@"private XCTest event synthesis unavailable: missing %@", className];
  }
  return nil;
}

static NSString * _Nullable RunnerRequireSelector(Class cls, SEL selector, NSString *selectorName) {
  if (![cls instancesRespondToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest event synthesis unavailable: %@ missing %@",
      NSStringFromClass(cls),
      selectorName
    ];
  }
  return nil;
}

static NSString * _Nullable RunnerRequireApplicationSelector(
  id application,
  SEL selector,
  NSString *selectorName
) {
  if (![application respondsToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest event synthesis unavailable: XCUIApplication missing %@",
      selectorName
    ];
  }
  return nil;
}


static id RunnerSwipePointerPath(
  const RunnerXCTestEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
) {
  id path =
    ((RunnerMsgSendInitPath)objc_msgSend)([bridge->pathClass alloc], bridge->initPathSelector, start, 0.0);
  if (path == nil) {
    return nil;
  }

  NSTimeInterval durationSeconds = durationMs / 1000.0;
  ((RunnerMsgSendPathMove)objc_msgSend)(
    path,
    bridge->moveSelector,
    end,
    RunnerSwipeMovementDurationSeconds
  );
  ((RunnerMsgSendPathOffset)objc_msgSend)(
    path,
    bridge->liftSelector,
    RunnerSwipeMovementDurationSeconds + durationSeconds
  );
  return path;
}

static id RunnerContinuousDragPointerPath(
  const RunnerXCTestEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
) {
  id path =
    ((RunnerMsgSendInitPath)objc_msgSend)([bridge->pathClass alloc], bridge->initPathSelector, start, 0.0);
  if (path == nil) {
    return nil;
  }

  int frameCount = MAX(3, (int)(durationMs / 16.0));
  NSTimeInterval durationSeconds = durationMs / 1000.0;
  for (int index = 1; index <= frameCount; index += 1) {
    double t = (double)index / (double)frameCount;
    double easedT = t * t * (3.0 - 2.0 * t);
    CGPoint point = CGPointMake(
      start.x + (end.x - start.x) * easedT,
      start.y + (end.y - start.y) * easedT
    );
    ((RunnerMsgSendPathMove)objc_msgSend)(path, bridge->moveSelector, point, durationSeconds * t);
  }

  ((RunnerMsgSendPathOffset)objc_msgSend)(path, bridge->liftSelector, durationSeconds);
  return path;
}

static id RunnerTapPointerPath(
  const RunnerXCTestEventBridge *bridge,
  CGPoint point
) {
  id path =
    ((RunnerMsgSendInitPath)objc_msgSend)([bridge->pathClass alloc], bridge->initPathSelector, point, 0.0);
  if (path == nil) {
    return nil;
  }
  ((RunnerMsgSendPathOffset)objc_msgSend)(path, bridge->liftSelector, 0.05);
  return path;
}

@end
