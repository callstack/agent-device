#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/*
 * The first of `executables` with a process running for the Simulator `simulatorUdid`, or nil.
 * When it returns nil, `unverified` reports that the scan proved nothing: the process table could
 * not be read, or a live candidate process could not be placed on a Simulator. A candidate that
 * exited, gone or a zombie, presents nothing and reads as absent.
 */
NSString *_Nullable runningSurfaceHost(NSArray<NSString *> *executables,
                                       NSString *simulatorUdid,
                                       BOOL *unverified);

NS_ASSUME_NONNULL_END
