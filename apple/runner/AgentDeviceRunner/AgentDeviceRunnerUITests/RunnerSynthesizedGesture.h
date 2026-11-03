#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSInteger RunnerControlledScrollFrameCount(double durationMs);
FOUNDATION_EXPORT double RunnerControlledScrollProgress(double t);

typedef NS_ENUM(NSInteger, RunnerTapSynthesisStatus) {
  RunnerTapSynthesisStatusSucceeded,
  RunnerTapSynthesisStatusDeadlineExceeded,
  RunnerTapSynthesisStatusFailed,
};

typedef struct {
  CGPoint start;
  CGPoint end;
  double durationMs;
  BOOL controlledScroll;
} RunnerSynthesizedDrag;

@interface RunnerSynthesizedGesture : NSObject

// `resolvedWindow` is the app window the caller already resolved for the gesture's reference
// frame, so the record's display ID is read from that same window. Pass nil for the sole-screen
// route: the app's tree could not name its window and the screen is proven instead.
// `interfaceOrientation` is the orientation used to convert the supplied points.
+ (NSString * _Nullable)synthesizeDragWithApplication:(id)application
                                      resolvedWindow:(id _Nullable)resolvedWindow
                                interfaceOrientation:(NSInteger)interfaceOrientation
                                                drag:(RunnerSynthesizedDrag)drag;

+ (RunnerTapSynthesisStatus)synthesizeTapWithApplication:(id)application
                                      resolvedWindow:(id _Nullable)resolvedWindow
                                interfaceOrientation:(NSInteger)interfaceOrientation
                                               point:(CGPoint)point
                                            deadline:(NSDate * _Nullable)deadline
                                        errorMessage:(NSString * _Nullable * _Nullable)errorMessage;

// Each pointer is an ordered array of { x, y, offsetMs } samples. The first sample
// starts contact; subsequent samples move it; all pointers lift at their final offset.
+ (NSString * _Nullable)synthesizeGestureWithApplication:(id)application
                                          resolvedWindow:(id _Nullable)resolvedWindow
                                    interfaceOrientation:(NSInteger)interfaceOrientation
                                          pointerSamples:(NSArray<NSArray<NSDictionary<NSString *, NSNumber *> *> *> *)pointerSamples;

// UIInterfaceOrientation of the app (1 portrait, 2 upsideDown, 3 landscapeRight,
// 4 landscapeLeft), or 0 if unreadable.
+ (NSInteger)interfaceOrientationForApplication:(id)application;

@end

NS_ASSUME_NONNULL_END
