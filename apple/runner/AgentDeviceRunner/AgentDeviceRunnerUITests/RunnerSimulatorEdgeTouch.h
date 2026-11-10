#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <TargetConditionals.h>

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

// Dispatches one touch that UIKit marks as a screen-edge touch, so
// UIScreenEdgePanGestureRecognizer and the navigation back gesture can begin.
// XCTest synthesized touches never carry the digitizer edge mask that UIKit reads.
@interface RunnerSimulatorEdgeTouch : NSObject

// The touch goes to the touchscreen of the display that hosts the app: `resolvedWindow`'s display,
// or the sole screen when it is nil, as for XCTest synthesis. `samples` is the ordered
// { x, y, offsetMs } path of one contact in portrait screen points, and `screenSize` is that
// screen's portrait size in points. The call returns after the contact lifts.
// Returns nil on success, or the reason the touch could not be dispatched.
+ (NSString * _Nullable)dispatchWithApplication:(id)application
                                 resolvedWindow:(id _Nullable)resolvedWindow
                                        samples:(NSArray<NSDictionary<NSString *, NSNumber *> *> *)samples
                                     screenSize:(CGSize)screenSize;

@end

#endif

NS_ASSUME_NONNULL_END
