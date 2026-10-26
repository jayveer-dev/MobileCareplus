// ddphotos: deletes photos and videos on a connected iPhone through ImageCaptureCore (the camera
// protocol Image Capture uses), so the phone's Photos app removes them itself.
//   ddphotos <udid> list                    prints "<folder>/<name>\t<size>" for every item
//   ddphotos <udid> delete <size>:<ext>...  items by original file size and extension, e.g. 2464524:heic
// The camera protocol shows items under made-up names in month folders, so the library's own paths
// don't match; size + extension does. Only a unique match is deleted.
// Prints "deleted|missing|ambiguous|failed <size>:<ext>" lines; exit 1 if the phone wasn't usable.
#import <Foundation/Foundation.h>
#import <ImageCaptureCore/ImageCaptureCore.h>

@interface Runner : NSObject <ICDeviceBrowserDelegate, ICCameraDeviceDelegate>
@property NSString *udid;
@property NSArray<NSString *> *args;
@property ICDeviceBrowser *browser;
@property ICCameraDevice *camera;
@property int status;
@property BOOL locked;
@property BOOL done;
@end

// ImageCaptureCore reports the UDID with leading zeros of its second part dropped
// (00008101-0012AB… for 00008101-00012AB…), so compare each part without leading zeros.
static NSString *normalize(NSString *s) {
  NSMutableArray *parts = [NSMutableArray array];
  for (NSString *part in [s.uppercaseString componentsSeparatedByString:@"-"]) {
    NSUInteger i = 0;
    while (i + 1 < part.length && [part characterAtIndex:i] == (unichar)0x30) i++;
    [parts addObject:[part substringFromIndex:i]];
  }
  return [parts componentsJoinedByString:@"-"];
}

// Folder chain from the camera root, e.g. "DCIM/100APPLE/IMG_0001.HEIC".
static NSString *itemPath(ICCameraItem *item) {
  NSMutableArray *parts = [NSMutableArray arrayWithObject:item.name];
  for (ICCameraFolder *f = item.parentFolder; f; f = f.parentFolder) [parts insertObject:f.name atIndex:0];
  return [parts componentsJoinedByString:@"/"];
}

static NSString *fileKey(ICCameraFile *f) { return [NSString stringWithFormat:@"%lld:%@", (long long)f.fileSize, f.name.pathExtension.lowercaseString]; }

static void collect(NSArray<ICCameraItem *> *items, NSMutableArray<ICCameraFile *> *out) {
  for (ICCameraItem *i in items) {
    if ([i isKindOfClass:ICCameraFolder.class]) collect(((ICCameraFolder *)i).contents, out);
    else if ([i isKindOfClass:ICCameraFile.class]) [out addObject:(ICCameraFile *)i];
  }
}

@implementation Runner
- (void)finish:(int)code {
  if (self.done) return; // closing the session reports the device as removed too
  self.done = YES;
  self.status = code;
  if (self.camera) [self.camera requestCloseSession];
  CFRunLoopStop(CFRunLoopGetMain());
}
- (void)deviceBrowser:(ICDeviceBrowser *)b didAddDevice:(ICDevice *)d moreComing:(BOOL)more {
  if (getenv("DDPHOTOS_TRACE")) fprintf(stderr, "device %s serial=%s uuid=%s\n", d.name.UTF8String, d.serialNumberString.UTF8String, d.UUIDString.UTF8String);
  if (self.camera || ![d isKindOfClass:ICCameraDevice.class]) return;
  if (![normalize(d.serialNumberString ?: @"") isEqualToString:normalize(self.udid)]) return;
  self.camera = (ICCameraDevice *)d;
  self.camera.delegate = self;
  [self.camera requestOpenSession];
}
- (void)deviceBrowser:(ICDeviceBrowser *)b didRemoveDevice:(ICDevice *)d moreGoing:(BOOL)more {}
- (void)didRemoveDevice:(ICDevice *)d { [self finish:1]; }
- (void)device:(ICDevice *)d didOpenSessionWithError:(NSError *)e {
  if (e && self.locked) return; // reopened once the phone is unlocked
  if (e) { fprintf(stderr, "Could not open the phone: %s\n", e.localizedDescription.UTF8String); [self finish:1]; }
}
- (void)device:(ICDevice *)d didCloseSessionWithError:(NSError *)e {}
- (void)deviceDidBecomeReadyWithCompleteContentCatalog:(ICCameraDevice *)camera {
  NSMutableArray<ICCameraFile *> *files = [NSMutableArray array];
  collect(camera.contents, files);
  if ([self.args.firstObject isEqualToString:@"list"]) {
    for (ICCameraFile *f in files) printf("%s\t%lld\n", itemPath(f).UTF8String, (long long)f.fileSize);
    [self finish:0];
    return;
  }
  NSMutableDictionary<NSString *, NSMutableArray<ICCameraFile *> *> *byKey = [NSMutableDictionary dictionary];
  for (ICCameraFile *f in files) {
    NSString *k = fileKey(f);
    if (!byKey[k]) byKey[k] = [NSMutableArray array];
    [byKey[k] addObject:f];
  }
  NSMutableArray<ICCameraFile *> *targets = [NSMutableArray array];
  for (NSString *want in [self.args subarrayWithRange:NSMakeRange(1, self.args.count - 1)]) {
    NSArray *hits = byKey[want.lowercaseString];
    if (hits.count == 1) [targets addObject:hits.firstObject];
    else printf("%s %s\n", hits.count ? "ambiguous" : "missing", want.UTF8String);
  }
  if (targets.count == 0) { [self finish:0]; return; }
  [camera requestDeleteFiles:targets
                deleteFailed:^(NSDictionary<NSString *, ICCameraItem *> *failed) {
                  for (ICCameraItem *i in failed.allValues) printf("failed %s\n", fileKey((ICCameraFile *)i).UTF8String);
                }
                  completion:^(NSDictionary<NSString *, id> *result, NSError *error) {
                    NSArray *gone = result[ICDeleteSuccessful] ?: @[];
                    for (ICCameraItem *i in gone) printf("deleted %s\n", fileKey((ICCameraFile *)i).UTF8String);
                    for (ICCameraItem *i in (NSArray *)(result[ICDeleteFailed] ?: @[])) printf("failed %s\n", fileKey((ICCameraFile *)i).UTF8String);
                    if (error) fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
                    fflush(stdout);
                    [self finish:0];
                  }];
}
- (void)cameraDevice:(ICCameraDevice *)c didAddItems:(NSArray<ICCameraItem *> *)items {}
- (void)cameraDevice:(ICCameraDevice *)c didRemoveItems:(NSArray<ICCameraItem *> *)items {}
- (void)cameraDevice:(ICCameraDevice *)c didRenameItems:(NSArray<ICCameraItem *> *)items {}
- (void)cameraDevice:(ICCameraDevice *)c didReceiveThumbnail:(CGImageRef)t forItem:(ICCameraItem *)i error:(NSError *)e {}
- (void)cameraDevice:(ICCameraDevice *)c didReceiveMetadata:(NSDictionary *)m forItem:(ICCameraItem *)i error:(NSError *)e {}
- (void)cameraDeviceDidChangeCapability:(ICCameraDevice *)c {}
- (void)cameraDevice:(ICCameraDevice *)c didReceivePTPEvent:(NSData *)e {}
- (void)cameraDeviceDidRemoveAccessRestriction:(ICDevice *)d {
  if (!self.locked) return;
  self.locked = NO;
  [self.camera requestOpenSession];
}
- (void)cameraDeviceDidEnableAccessRestriction:(ICDevice *)d {
  if (self.locked) return;
  self.locked = YES;
  fprintf(stderr, "waiting for unlock\n");
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (self.locked) { fprintf(stderr, "The iPhone stayed locked. Unlock it and try again.\n"); [self finish:1]; }
  });
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3 || (strcmp(argv[2], "list") && strcmp(argv[2], "delete"))) {
      fprintf(stderr, "usage: ddphotos <udid> list | delete <path>...\n");
      return 2;
    }
    Runner *r = [Runner new];
    r.status = 1;
    r.udid = @(argv[1]);
    NSMutableArray *args = [NSMutableArray array];
    for (int i = 2; i < argc; i++) [args addObject:@(argv[i])];
    r.args = args;
    r.browser = [ICDeviceBrowser new];
    r.browser.delegate = r;
    r.browser.browsedDeviceTypeMask = ICDeviceTypeMaskCamera | ICDeviceLocationTypeMaskLocal;
    [r.browser start];
    // The phone must show up within 20 s; reading a large library's catalog can take minutes.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      if (!r.camera) { fprintf(stderr, "The iPhone wasn't found. Unlock it, tap Trust, and try again.\n"); [r finish:1]; }
    });
    CFRunLoopRun();
    [r.browser stop];
    return r.status;
  }
}
