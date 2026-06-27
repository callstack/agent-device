#import <TargetConditionals.h>

#if TARGET_OS_OSX
#import <Cocoa/Cocoa.h>

@interface AgentDeviceRunnerAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@end

@implementation AgentDeviceRunnerAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;

  NSRect frame = NSMakeRect(0, 0, 360, 220);
  self.window = [[NSWindow alloc] initWithContentRect:frame
                                            styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                       NSWindowStyleMaskMiniaturizable)
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.title = @"Agent Device Runner";

  NSTextField *label = [NSTextField labelWithString:@"Agent Device Runner"];
  label.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
  label.translatesAutoresizingMaskIntoConstraints = NO;

  NSView *contentView = [[NSView alloc] initWithFrame:frame];
  [contentView addSubview:label];
  self.window.contentView = contentView;

  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:contentView.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:contentView.centerYAnchor],
  ]];

  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    AgentDeviceRunnerAppDelegate *delegate = [[AgentDeviceRunnerAppDelegate alloc] init];
    application.delegate = delegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application run];
  }

  return 0;
}

#else
#import <UIKit/UIKit.h>

@interface AgentDeviceRunnerViewController : UIViewController
@end

@implementation AgentDeviceRunnerViewController

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = UIColor.whiteColor;

  UILabel *label = [[UILabel alloc] init];
  label.text = @"Agent Device Runner";
  label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
  label.textAlignment = NSTextAlignmentCenter;
  label.translatesAutoresizingMaskIntoConstraints = NO;

  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];
}

@end

@interface AgentDeviceRunnerAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AgentDeviceRunnerAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary<UIApplicationLaunchOptionsKey, id> *)launchOptions {
  (void)application;
  (void)launchOptions;

  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [[AgentDeviceRunnerViewController alloc] init];
  [self.window makeKeyAndVisible];

  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(AgentDeviceRunnerAppDelegate.class));
  }
}

#endif
