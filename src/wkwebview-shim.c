/*
 * wkwebview-shim.c — header-free AppKit/WKWebView host for BunDesk (macOS).
 *
 * Bun's embedded C compiler builds this file at runtime. AppKit and WebKit are
 * loaded with dlopen and all Objective-C calls go through objc_msgSend, so the
 * provider needs neither Xcode headers nor a separately shipped native helper.
 * The JavaScript event loop pumps AppKit/CFRunLoop through macwk_pump().
 *
 * A small runtime-created delegate implements NSWindowDelegate,
 * WKNavigationDelegate and WKScriptMessageHandler callbacks. The page bridge
 * mirrors WebView2's window.chrome.webview API. Script results use a dedicated
 * script-message channel instead of Objective-C blocks, which keeps the shim
 * plain C and permits asynchronous JavaScript results.
 */

typedef void* id;
typedef void* Class;
typedef void* SEL;
typedef void (*IMP)(void);
typedef signed char BOOL;
typedef unsigned long NSUInteger;
typedef long NSInteger;

typedef struct { double x; double y; } NSPoint;
typedef struct { double width; double height; } NSSize;
typedef struct { NSPoint origin; NSSize size; } NSRect;

extern void* dlopen(const char*, int);
extern Class objc_getClass(const char*);
extern SEL sel_registerName(const char*);
/* Matches the public objc/message.h declaration; every call site casts it to
   the exact ABI required by the selected Objective-C method. */
extern void objc_msgSend(void);
extern Class objc_allocateClassPair(Class, const char*, unsigned long);
extern BOOL class_addMethod(Class, SEL, IMP, const char*);
extern void objc_registerClassPair(Class);

#define RTLD_NOW 2
#define RTLD_GLOBAL 8

/* NSWindowStyleMaskTitled | Closable | Miniaturizable | Resizable */
#define WINDOW_STYLE_MASK 15UL
#define NS_BACKING_STORE_BUFFERED 2UL
#define VIEW_AUTOSIZING_MASK 18UL
#define NS_APPLICATION_ACTIVATION_POLICY_REGULAR 0L
#define NS_EVENT_MASK_ANY (~0UL)

typedef void (*str_cb)(void*);
typedef void (*nav_cb)(int, int);

static str_cb cb_msg;
static str_cb cb_exec;
static nav_cb cb_nav;
static void (*cb_close)(void);

static void* g_appkit;
static void* g_webkit;
static int g_diag;
static id g_pool;
static id g_app;
static id g_window;
static id g_webview;
static id g_config;
static id g_manager;
static id g_delegate;
static id g_run_loop_mode;
static Class g_delegate_class;
static int g_window_closed;

static SEL selector(const char* name) {
  return sel_registerName(name);
}

static id send_id(id receiver, const char* name) {
  return ((id (*)(id, SEL))objc_msgSend)(receiver, selector(name));
}

static id send_id_id(id receiver, const char* name, id value) {
  return ((id (*)(id, SEL, id))objc_msgSend)(receiver, selector(name), value);
}

static id send_id_cstr(id receiver, const char* name, const char* value) {
  return ((id (*)(id, SEL, const char*))objc_msgSend)(receiver, selector(name), value);
}

static id send_id_rect_id(id receiver, const char* name, NSRect rect, id value) {
  return ((id (*)(id, SEL, NSRect, id))objc_msgSend)(receiver, selector(name), rect, value);
}

static id send_id_rect_ul_ul_bool(
  id receiver,
  const char* name,
  NSRect rect,
  NSUInteger first,
  NSUInteger second,
  BOOL third
) {
  return ((id (*)(id, SEL, NSRect, NSUInteger, NSUInteger, BOOL))objc_msgSend)(
    receiver, selector(name), rect, first, second, third
  );
}

static id send_id_id_long_bool(id receiver, const char* name, id value, NSInteger number, BOOL flag) {
  return ((id (*)(id, SEL, id, NSInteger, BOOL))objc_msgSend)(
    receiver, selector(name), value, number, flag
  );
}

static id send_id_ul_id_id_bool(
  id receiver,
  const char* name,
  NSUInteger mask,
  id date,
  id mode,
  BOOL dequeue
) {
  return ((id (*)(id, SEL, NSUInteger, id, id, BOOL))objc_msgSend)(
    receiver, selector(name), mask, date, mode, dequeue
  );
}

static void send_void(id receiver, const char* name) {
  ((void (*)(id, SEL))objc_msgSend)(receiver, selector(name));
}

static void send_void_id(id receiver, const char* name, id value) {
  ((void (*)(id, SEL, id))objc_msgSend)(receiver, selector(name), value);
}

static void send_void_id_id(id receiver, const char* name, id first, id second) {
  ((void (*)(id, SEL, id, id))objc_msgSend)(receiver, selector(name), first, second);
}

static void send_void_bool(id receiver, const char* name, BOOL value) {
  ((void (*)(id, SEL, BOOL))objc_msgSend)(receiver, selector(name), value);
}

static void send_void_long(id receiver, const char* name, NSInteger value) {
  ((void (*)(id, SEL, NSInteger))objc_msgSend)(receiver, selector(name), value);
}

static void send_void_ul(id receiver, const char* name, NSUInteger value) {
  ((void (*)(id, SEL, NSUInteger))objc_msgSend)(receiver, selector(name), value);
}

static NSInteger send_long(id receiver, const char* name) {
  return ((NSInteger (*)(id, SEL))objc_msgSend)(receiver, selector(name));
}

static const char* send_cstr(id receiver, const char* name) {
  return ((const char* (*)(id, SEL))objc_msgSend)(receiver, selector(name));
}

static BOOL send_bool_id_id(id receiver, const char* name, id first, id second) {
  return ((BOOL (*)(id, SEL, id, id))objc_msgSend)(receiver, selector(name), first, second);
}

static BOOL send_bool_sel(id receiver, const char* name, SEL value) {
  return ((BOOL (*)(id, SEL, SEL))objc_msgSend)(receiver, selector(name), value);
}

static id ns_string(const char* value) {
  Class cls = objc_getClass("NSString");
  if (!cls || !value) return 0;
  return send_id_cstr((id)cls, "stringWithUTF8String:", value);
}

static const char* object_utf8(id value) {
  id text;
  if (!value) return "null";
  text = send_id(value, "description");
  if (!text) return "";
  return send_cstr(text, "UTF8String");
}

void macwk_set_handlers(void* msg, void* nav, void* exec, void* close) {
  cb_msg = (str_cb)msg;
  cb_nav = (nav_cb)nav;
  cb_exec = (str_cb)exec;
  cb_close = (void (*)(void))close;
}

/* ---- dynamically registered delegate methods ---- */

static void delegate_window_will_close(id self, SEL command, id notification) {
  (void)self;
  (void)command;
  (void)notification;
  g_window_closed = 1;
  if (cb_close) cb_close();
}

static void delegate_did_finish(id self, SEL command, id webview, id navigation) {
  (void)self;
  (void)command;
  (void)webview;
  (void)navigation;
  if (cb_nav) cb_nav(1, 0);
}

static void delegate_did_fail(id self, SEL command, id webview, id navigation, id error) {
  NSInteger code = 0;
  (void)self;
  (void)command;
  (void)webview;
  (void)navigation;
  if (error) code = send_long(error, "code");
  if (cb_nav) cb_nav(0, (int)code);
}

static void delegate_script_message(id self, SEL command, id manager, id message) {
  id name;
  id body;
  const char* name_utf8;
  const char* body_utf8;
  (void)self;
  (void)command;
  (void)manager;
  if (!message) return;
  name = send_id(message, "name");
  body = send_id(message, "body");
  name_utf8 = name ? send_cstr(name, "UTF8String") : "";
  body_utf8 = object_utf8(body);
  if (name_utf8 && name_utf8[0] == 'b' && name_utf8[7] == 'E') {
    if (cb_exec) cb_exec((void*)body_utf8);
  } else if (cb_msg) {
    cb_msg((void*)body_utf8);
  }
}

static void delegate_class_name(char* output) {
  const char* prefix = "BunDeskWKWebViewDelegate_";
  const char* hex = "0123456789abcdef";
  NSUInteger address = (NSUInteger)(void*)&g_delegate_class;
  int index = 0;
  int shift;
  while (prefix[index]) {
    output[index] = prefix[index];
    index++;
  }
  for (shift = (int)(sizeof(NSUInteger) * 8) - 4; shift >= 0; shift -= 4) {
    output[index++] = hex[(address >> shift) & 15];
  }
  output[index] = 0;
}

static int register_delegate_class(void) {
  Class base;
  char name[64];
  if (g_delegate_class) return 1;
  delegate_class_name(name);
  g_delegate_class = objc_getClass(name);
  if (g_delegate_class) return 1;
  base = objc_getClass("NSObject");
  if (!base) return 0;
  g_delegate_class = objc_allocateClassPair(base, name, 0);
  if (!g_delegate_class) return 0;
  if (!class_addMethod(
    g_delegate_class,
    selector("windowWillClose:"),
    (IMP)delegate_window_will_close,
    "v@:@"
  )) return 0;
  if (!class_addMethod(
    g_delegate_class,
    selector("webView:didFinishNavigation:"),
    (IMP)delegate_did_finish,
    "v@:@@"
  )) return 0;
  if (!class_addMethod(
    g_delegate_class,
    selector("webView:didFailNavigation:withError:"),
    (IMP)delegate_did_fail,
    "v@:@@@"
  )) return 0;
  if (!class_addMethod(
    g_delegate_class,
    selector("webView:didFailProvisionalNavigation:withError:"),
    (IMP)delegate_did_fail,
    "v@:@@@"
  )) return 0;
  if (!class_addMethod(
    g_delegate_class,
    selector("userContentController:didReceiveScriptMessage:"),
    (IMP)delegate_script_message,
    "v@:@@"
  )) return 0;
  objc_registerClassPair(g_delegate_class);
  return 1;
}

int macwk_init(void) {
  g_diag = 0;
  if (!g_appkit) {
    g_appkit = dlopen(
      "/System/Library/Frameworks/AppKit.framework/AppKit",
      RTLD_NOW | RTLD_GLOBAL
    );
    if (!g_appkit) { g_diag = 1; return 0; }
  }
  if (!g_webkit) {
    g_webkit = dlopen(
      "/System/Library/Frameworks/WebKit.framework/WebKit",
      RTLD_NOW | RTLD_GLOBAL
    );
    if (!g_webkit) { g_diag = 2; return 0; }
  }
  if (!objc_getClass("NSApplication") || !objc_getClass("NSWindow") ||
      !objc_getClass("WKWebView") || !objc_getClass("WKWebViewConfiguration")) {
    g_diag = 3;
    return 0;
  }
  if (!register_delegate_class()) {
    g_diag = 4;
    return 0;
  }
  return 1;
}

int macwk_diag(void) { return g_diag; }

int macwk_create_window(const char* title, const char* url, int width, int height) {
  NSRect rect;
  id script;
  id request_url;
  id request;
  const char* bridge =
    "(()=>{"
    "const listeners=new Set();"
    "if(!window.chrome)window.chrome={};"
    "window.chrome.webview={"
    "postMessage(m){window.webkit.messageHandlers.bundesk.postMessage(JSON.stringify(m));},"
    "addEventListener(t,fn){if(t==='message')listeners.add(fn);},"
    "removeEventListener(t,fn){if(t==='message')listeners.delete(fn);}};"
    "window.addEventListener('bundesk-message',e=>{"
    "let data=null;try{data=JSON.parse(e.data||'null')}catch{data=e.data}"
    "for(const fn of listeners)fn({data});});"
    "})();";

  if (!macwk_init()) return 0;
  if (g_window) return 0;
  g_window_closed = 0;
  if (width <= 0) width = 900;
  if (height <= 0) height = 640;
  rect.origin.x = 0;
  rect.origin.y = 0;
  rect.size.width = (double)width;
  rect.size.height = (double)height;

  if (!g_pool) g_pool = send_id((id)objc_getClass("NSAutoreleasePool"), "new");
  g_app = send_id((id)objc_getClass("NSApplication"), "sharedApplication");
  if (!g_app) { g_diag = 10; return 0; }
  send_void_long(g_app, "setActivationPolicy:", NS_APPLICATION_ACTIVATION_POLICY_REGULAR);
  send_void(g_app, "finishLaunching");

  g_delegate = send_id((id)g_delegate_class, "new");
  g_config = send_id(send_id((id)objc_getClass("WKWebViewConfiguration"), "alloc"), "init");
  if (!g_delegate || !g_config) { g_diag = 11; return 0; }
  g_manager = send_id(g_config, "userContentController");
  if (!g_manager) { g_diag = 12; return 0; }
  send_void_id_id(g_manager, "addScriptMessageHandler:name:", g_delegate, ns_string("bundesk"));
  send_void_id_id(g_manager, "addScriptMessageHandler:name:", g_delegate, ns_string("bundeskExec"));

  script = send_id_id_long_bool(
    send_id((id)objc_getClass("WKUserScript"), "alloc"),
    "initWithSource:injectionTime:forMainFrameOnly:",
    ns_string(bridge),
    0,
    1
  );
  if (!script) { g_diag = 13; return 0; }
  send_void_id(g_manager, "addUserScript:", script);
  send_void(script, "release");

  g_webview = send_id_rect_id(
    send_id((id)objc_getClass("WKWebView"), "alloc"),
    "initWithFrame:configuration:",
    rect,
    g_config
  );
  if (!g_webview) { g_diag = 14; return 0; }
  send_void_id(g_webview, "setNavigationDelegate:", g_delegate);
  send_void_ul(g_webview, "setAutoresizingMask:", VIEW_AUTOSIZING_MASK);
  /* WKWebView.isInspectable is available on macOS 13.3+. Enabling it keeps
     the native provider compatible with Safari's Develop-menu workflow. */
  if (send_bool_sel(g_webview, "respondsToSelector:", selector("setInspectable:"))) {
    send_void_bool(g_webview, "setInspectable:", 1);
  }

  g_window = send_id_rect_ul_ul_bool(
    send_id((id)objc_getClass("NSWindow"), "alloc"),
    "initWithContentRect:styleMask:backing:defer:",
    rect,
    WINDOW_STYLE_MASK,
    NS_BACKING_STORE_BUFFERED,
    0
  );
  if (!g_window) { g_diag = 15; return 0; }
  send_void_bool(g_window, "setReleasedWhenClosed:", 0);
  send_void_id(g_window, "setDelegate:", g_delegate);
  send_void_id(g_window, "setTitle:", ns_string(title ? title : "BunDesk"));
  send_void_id(g_window, "setContentView:", g_webview);
  send_void(g_window, "center");
  send_void_id(g_window, "makeKeyAndOrderFront:", 0);
  send_void_bool(g_app, "activateIgnoringOtherApps:", 1);

  request_url = send_id_id((id)objc_getClass("NSURL"), "URLWithString:", ns_string(url));
  if (!request_url) { g_diag = 16; return 0; }
  request = send_id_id((id)objc_getClass("NSURLRequest"), "requestWithURL:", request_url);
  if (!request) { g_diag = 17; return 0; }
  send_id_id(g_webview, "loadRequest:", request);
  return 1;
}

void macwk_navigate(const char* url) {
  id request_url;
  id request;
  if (!g_webview || !url) return;
  request_url = send_id_id((id)objc_getClass("NSURL"), "URLWithString:", ns_string(url));
  if (!request_url) return;
  request = send_id_id((id)objc_getClass("NSURLRequest"), "requestWithURL:", request_url);
  if (request) send_id_id(g_webview, "loadRequest:", request);
}

void macwk_run_js(const char* script) {
  if (!g_webview || !script) return;
  send_void_id_id(g_webview, "evaluateJavaScript:completionHandler:", ns_string(script), 0);
}

void macwk_pump(void) {
  id event;
  id distant_past;
  id run_loop;
  id limit;
  if (!g_app) return;
  distant_past = send_id((id)objc_getClass("NSDate"), "distantPast");
  while ((event = send_id_ul_id_id_bool(
    g_app,
    "nextEventMatchingMask:untilDate:inMode:dequeue:",
    NS_EVENT_MASK_ANY,
    distant_past,
    g_run_loop_mode ? g_run_loop_mode : ns_string("kCFRunLoopDefaultMode"),
    1
  ))) {
    send_void_id(g_app, "sendEvent:", event);
  }
  send_void(g_app, "updateWindows");
  run_loop = send_id((id)objc_getClass("NSRunLoop"), "currentRunLoop");
  limit = ((id (*)(id, SEL, double))objc_msgSend)(
    (id)objc_getClass("NSDate"),
    selector("dateWithTimeIntervalSinceNow:"),
    0.001
  );
  if (!g_run_loop_mode) g_run_loop_mode = ns_string("kCFRunLoopDefaultMode");
  if (run_loop && limit) send_bool_id_id(run_loop, "runMode:beforeDate:", g_run_loop_mode, limit);
}

void macwk_close(void) {
  id window = g_window;
  if (window) {
    send_void_id(window, "setDelegate:", 0);
    if (!g_window_closed) send_void(window, "close");
  }
  if (g_manager) {
    send_void_id(g_manager, "removeScriptMessageHandlerForName:", ns_string("bundesk"));
    send_void_id(g_manager, "removeScriptMessageHandlerForName:", ns_string("bundeskExec"));
  }
  if (g_webview) send_void_id(g_webview, "setNavigationDelegate:", 0);
  if (window) send_void_id(window, "setContentView:", 0);
  if (g_webview) send_void(g_webview, "release");
  if (g_config) send_void(g_config, "release");
  if (g_delegate) send_void(g_delegate, "release");
  if (window) send_void(window, "release");
  g_window = 0;
  g_webview = 0;
  g_manager = 0;
  g_config = 0;
  g_delegate = 0;
  g_window_closed = 0;
}
