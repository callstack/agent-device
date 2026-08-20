#import "RunnerSynthesizedGesture.h"
#import "RunnerXCTestEventBridge.h"

#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>

static NSString *const RunnerGestureSynthesisSurface = @"event";

typedef id (*RunnerMsgSendInitRecord)(id, SEL, NSString *, NSInteger);
typedef id (*RunnerMsgSendInitPath)(id, SEL, CGPoint, NSTimeInterval);
typedef void (*RunnerMsgSendPathMove)(id, SEL, CGPoint, NSTimeInterval);
typedef void (*RunnerMsgSendPathOffset)(id, SEL, NSTimeInterval);

// Gesture-specific extension of the shared bridge: the 2-arg
// `initWithName:interfaceOrientation:` record initializer and the touch-path
// factory/mutator selectors, none of which text-entry synthesis needs.
typedef struct {
  RunnerXCTestEventBridge core;
  SEL initRecordSelector;
  SEL interfaceOrientationSelector;
  SEL initPathSelector;
  SEL moveSelector;
  SEL liftSelector;
} RunnerGestureEventBridge;

typedef id (*RunnerDragPointerPathFactory)(
  const RunnerGestureEventBridge *,
  CGPoint,
  CGPoint,
  double
);
typedef double (*RunnerDragProgressFunction)(double);

static NSString * _Nullable RunnerResolveGestureEventBridge(
  id application,
  RunnerGestureEventBridge *bridge
);
static NSString * _Nullable RunnerCreateEventRecord(
  id application,
  NSString *recordName,
  RunnerGestureEventBridge *bridge,
  id *record
);
static NSString * _Nullable RunnerSynthesizeEventRecord(
  const RunnerGestureEventBridge *bridge,
  id record
);
static id RunnerSwipePointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
);
static id RunnerContinuousDragPointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
);
static id RunnerControlledScrollPointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
);
static id RunnerSampledDragPointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs,
  RunnerDragProgressFunction progress,
  NSInteger frameCount
);
static double RunnerSmoothstepProgress(double t);
static NSString * _Nullable RunnerTrySynthesizeDrag(
  id application,
  CGPoint start,
  CGPoint end,
  double durationMs,
  NSString *recordName,
  RunnerDragPointerPathFactory pathFactory
);
static NSString * _Nullable RunnerTrySynthesizeTap(id application, CGPoint point);
// XCTest's proven swipe profile reaches the endpoint in 100 ms, then holds for the planned
// fling duration. Fast movement is what lets UIKit distinguish a fling from a timed pan.
static const NSTimeInterval RunnerSwipeMovementDurationSeconds = 0.1;
static const double RunnerDragSampleIntervalMs = 16.0;
static const NSInteger RunnerControlledScrollMaxFrameCount = 30;
static id RunnerTapPointerPath(
  const RunnerGestureEventBridge *bridge,
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
    return RunnerFormatXCTestException(exception, @"private XCTest event synthesis failed");
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
    return RunnerFormatXCTestException(exception, @"private XCTest event synthesis failed");
  }
}

+ (NSString * _Nullable)synthesizeControlledScrollWithApplication:(id)application
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
      @"agent-device-controlled-scroll",
      RunnerControlledScrollPointerPath
    );
  } @catch (NSException *exception) {
    return RunnerFormatXCTestException(exception, @"private XCTest event synthesis failed");
  }
}

+ (NSString * _Nullable)synthesizeTapWithApplication:(id)application
                                                   x:(double)x
                                                   y:(double)y {
  @try {
    return RunnerTrySynthesizeTap(application, CGPointMake(x, y));
  } @catch (NSException *exception) {
    return RunnerFormatXCTestException(exception, @"private XCTest event synthesis failed");
  }
}

+ (NSString * _Nullable)synthesizeGestureWithApplication:(id)application
                                          pointerSamples:(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *)pointerSamples {
  @try {
    RunnerGestureEventBridge bridge;
    id record = nil;
    NSString *error = RunnerCreateEventRecord(
      application,
      @"agent-device-gesture-plan",
      &bridge,
      &record
    );
    if (error != nil) return error;

    for (NSArray<NSDictionary<NSString *, NSNumber *> *> *samples in pointerSamples) {
      NSDictionary<NSString *, NSNumber *> *first = samples.firstObject;
      if (first == nil) return @"private XCTest event synthesis failed: empty pointer path";
      CGPoint start = CGPointMake(first[@"x"].doubleValue, first[@"y"].doubleValue);
      id path = ((RunnerMsgSendInitPath)objc_msgSend)(
        [bridge.core.pathClass alloc],
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
      ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.core.addPathSelector, path);
    }

    return RunnerSynthesizeEventRecord(&bridge, record);
  } @catch (NSException *exception) {
    return RunnerFormatXCTestException(exception, @"private XCTest event synthesis failed");
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
  RunnerGestureEventBridge bridge;
  id record = nil;
  NSString *error = RunnerCreateEventRecord(application, recordName, &bridge, &record);
  if (error != nil) return error;

  id path = pathFactory(&bridge, start, end, durationMs);
  if (path == nil) {
    return @"private XCTest event synthesis failed: could not create pointer path";
  }
  ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.core.addPathSelector, path);

  return RunnerSynthesizeEventRecord(&bridge, record);
}

static NSString * _Nullable RunnerTrySynthesizeTap(id application, CGPoint point) {
  RunnerGestureEventBridge bridge;
  id record = nil;
  NSString *error = RunnerCreateEventRecord(
    application,
    @"agent-device-tap",
    &bridge,
    &record
  );
  if (error != nil) return error;

  id path = RunnerTapPointerPath(&bridge, point);
  if (path == nil) {
    return @"private XCTest event synthesis failed: could not create pointer path";
  }
  ((RunnerMsgSendAddPath)objc_msgSend)(record, bridge.core.addPathSelector, path);
  return RunnerSynthesizeEventRecord(&bridge, record);
}

static NSString * _Nullable RunnerResolveGestureEventBridge(
  id application,
  RunnerGestureEventBridge *bridge
) {
  RunnerXCTestEventBridge core;
  NSString *missing = RunnerResolveXCTestEventBridge(application, RunnerGestureSynthesisSurface, &core);
  if (missing != nil) return missing;

  SEL initRecordSelector = NSSelectorFromString(@"initWithName:interfaceOrientation:");
  SEL interfaceOrientationSelector = NSSelectorFromString(@"interfaceOrientation");
  SEL initPathSelector = NSSelectorFromString(@"initForTouchAtPoint:offset:");
  SEL moveSelector = NSSelectorFromString(@"moveToPoint:atOffset:");
  SEL liftSelector = NSSelectorFromString(@"liftUpAtOffset:");

  missing = RunnerRequireSelector(
    core.recordClass, initRecordSelector, @"initWithName:interfaceOrientation:", RunnerGestureSynthesisSurface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    core.pathClass, initPathSelector, @"initForTouchAtPoint:offset:", RunnerGestureSynthesisSurface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    core.pathClass, moveSelector, @"moveToPoint:atOffset:", RunnerGestureSynthesisSurface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireSelector(
    core.pathClass, liftSelector, @"liftUpAtOffset:", RunnerGestureSynthesisSurface
  );
  if (missing != nil) return missing;
  missing = RunnerRequireApplicationSelector(
    application, interfaceOrientationSelector, @"interfaceOrientation", RunnerGestureSynthesisSurface
  );
  if (missing != nil) return missing;

  *bridge = (RunnerGestureEventBridge){
    .core = core,
    .initRecordSelector = initRecordSelector,
    .interfaceOrientationSelector = interfaceOrientationSelector,
    .initPathSelector = initPathSelector,
    .moveSelector = moveSelector,
    .liftSelector = liftSelector,
  };
  return nil;
}

static NSString * _Nullable RunnerCreateEventRecord(
  id application,
  NSString *recordName,
  RunnerGestureEventBridge *bridge,
  id *record
) {
  NSString *missing = RunnerResolveGestureEventBridge(application, bridge);
  if (missing != nil) return missing;

  NSInteger interfaceOrientation =
    ((RunnerMsgSendInteger)objc_msgSend)(application, bridge->interfaceOrientationSelector);
  NSInteger targetProcessID =
    ((RunnerMsgSendInteger)objc_msgSend)(application, bridge->core.processIDSelector);
  if (targetProcessID <= 0) {
    return @"private XCTest event synthesis unavailable: could not resolve target process ID";
  }

  id eventRecord = ((RunnerMsgSendInitRecord)objc_msgSend)(
    [bridge->core.recordClass alloc],
    bridge->initRecordSelector,
    recordName,
    interfaceOrientation
  );
  if (eventRecord == nil) {
    return @"private XCTest event synthesis failed: could not create event record";
  }
  ((RunnerMsgSendSetInteger)objc_msgSend)(
    eventRecord,
    bridge->core.setTargetProcessIDSelector,
    targetProcessID
  );
  *record = eventRecord;
  return nil;
}

static NSString * _Nullable RunnerSynthesizeEventRecord(
  const RunnerGestureEventBridge *bridge,
  id record
) {
  NSError *error = nil;
  BOOL ok = ((RunnerMsgSendSynthesize)objc_msgSend)(record, bridge->core.synthesizeSelector, &error);
  if (!ok) {
    NSString *detail = error.localizedDescription ?: @"synthesizeWithError returned false";
    return [NSString stringWithFormat:@"private XCTest event synthesis failed: %@", detail];
  }
  return nil;
}

static id RunnerSwipePointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
) {
  id path =
    ((RunnerMsgSendInitPath)objc_msgSend)([bridge->core.pathClass alloc], bridge->initPathSelector, start, 0.0);
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
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
) {
  // This is velocity shaping, not just interpolation density: smoothstep's endpoint slope is zero,
  // while a planned linear segment reaches lift with nonzero velocity unless a destination hold
  // follows it. UIKit uses finger-up velocity for scroll deceleration. See ADR 0013 and issue #1586.
  return RunnerSampledDragPointerPath(
    bridge,
    start,
    end,
    durationMs,
    RunnerSmoothstepProgress,
    RunnerContinuousDragFrameCount(durationMs)
  );
}

static id RunnerControlledScrollPointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs
) {
  // A stationary hold is not a reliable zero-velocity release in XCTest. Cubic ease-out decreases
  // velocity from the first movement and reaches near zero before lift. Profiles that accelerate
  // after pan recognition can still be classified as flings despite a slow final sample.
  return RunnerSampledDragPointerPath(
    bridge,
    start,
    end,
    durationMs,
    RunnerControlledScrollProgress,
    RunnerControlledScrollFrameCount(durationMs)
  );
}

static id RunnerSampledDragPointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint start,
  CGPoint end,
  double durationMs,
  RunnerDragProgressFunction progress,
  NSInteger frameCount
) {
  id path =
    ((RunnerMsgSendInitPath)objc_msgSend)([bridge->core.pathClass alloc], bridge->initPathSelector, start, 0.0);
  if (path == nil) {
    return nil;
  }

  NSTimeInterval durationSeconds = durationMs / 1000.0;
  for (NSInteger index = 1; index <= frameCount; index += 1) {
    double t = (double)index / (double)frameCount;
    double easedT = progress(t);
    CGPoint point = CGPointMake(
      start.x + (end.x - start.x) * easedT,
      start.y + (end.y - start.y) * easedT
    );
    ((RunnerMsgSendPathMove)objc_msgSend)(path, bridge->moveSelector, point, durationSeconds * t);
  }

  ((RunnerMsgSendPathOffset)objc_msgSend)(path, bridge->liftSelector, durationSeconds);
  return path;
}

static double RunnerSmoothstepProgress(double t) {
  return t * t * (3.0 - 2.0 * t);
}

NSInteger RunnerContinuousDragFrameCount(double durationMs) {
  return MAX(3, (NSInteger)(durationMs / RunnerDragSampleIntervalMs));
}

NSInteger RunnerControlledScrollFrameCount(double durationMs) {
  return MIN(
    RunnerControlledScrollMaxFrameCount,
    MAX(3, (NSInteger)ceil(durationMs / RunnerDragSampleIntervalMs) - 1)
  );
}

double RunnerControlledScrollProgress(double t) {
  double remaining = 1.0 - t;
  return 1.0 - remaining * remaining * remaining;
}

static id RunnerTapPointerPath(
  const RunnerGestureEventBridge *bridge,
  CGPoint point
) {
  id path =
    ((RunnerMsgSendInitPath)objc_msgSend)([bridge->core.pathClass alloc], bridge->initPathSelector, point, 0.0);
  if (path == nil) {
    return nil;
  }
  ((RunnerMsgSendPathOffset)objc_msgSend)(path, bridge->liftSelector, 0.05);
  return path;
}

@end
