/*
 * webview2-shim.c — header-free WebView2 COM host for bundesk.
 *
 * Compiled at runtime by bun:ffi's embedded TinyCC (`cc`), linked against
 * kernel32/user32/ole32. All COM interfaces are hand-declared with vtable
 * layouts verified against the official WebView2.h (Microsoft.Web.WebView2
 * NuGet, 1.0.4129.50). Only the bounded slice used by the framework is
 * declared; never call a slot beyond the declared struct size.
 *
 * Conventions: x64 Windows has a single calling convention, so no __stdcall
 * is needed (tinycc rejects the keyword anyway). Objects we hold past a
 * completed callback MUST be AddRef'd — the loader releases its own
 * references after each completed handler, which otherwise leaves the
 * environment/controller dangling and silently breaks the browser spawn.
 */

typedef long HRESULT;
typedef unsigned long DWORD;
typedef unsigned int UINT;
typedef int BOOL;
typedef void* HWND;
typedef void* HINSTANCE;
typedef void* HMODULE;
typedef unsigned short wchar_t; /* Windows wchar_t is 16-bit; C has no builtin */

#define S_OK 0L
#define COINIT_APARTMENTTHREADED 0x2L
#define CP_UTF8 65001
#define WM_SIZE 0x0005
#define WM_CLOSE 0x0010
#define SW_SHOW 5

/* ---- kernel32 / user32 / ole32 externs ---- */
extern void* LoadLibraryW(const wchar_t*);
extern void* GetProcAddress(void*, const char*);
extern void* GetModuleHandleW(const wchar_t*);
extern int GetModuleFileNameW(void*, wchar_t*, int);
extern unsigned long GetCurrentProcessId(void);
extern int WideCharToMultiByte(UINT, DWORD, const wchar_t*, int, char*, int, const char*, int*);
extern long CoInitializeEx(void*, DWORD);
extern void CoUninitialize(void);
extern unsigned short RegisterClassW(const void*);
extern void* CreateWindowExW(UINT, const wchar_t*, const wchar_t*, DWORD, int, int, int, int, HWND, void*, HINSTANCE, void*);
extern long DefWindowProcW(HWND, UINT, void*, void*);
extern long SendMessageW(HWND, UINT, void*, void*);
extern unsigned int ExtractIconExW(const wchar_t*, int, void**, void**, unsigned int);
extern int DestroyWindow(HWND);
extern int GetClientRect(HWND, void*);
extern int SetWindowPos(HWND, HWND, int, int, int, int, unsigned int);
extern int wsprintfW(wchar_t*, const wchar_t*, ...);

/* ---- minimal structures ---- */
typedef struct {
  UINT style;
  void* wndproc;
  int cbClsExtra;
  int cbWndExtra;
  void* hInstance;
  void* hIcon;
  void* hCursor;
  void* hbrBg;
  const wchar_t* menu;
  const wchar_t* cls;
} WNDCLASSW;

typedef struct { long left, top, right, bottom; } RECT;

/* ---- COM: IUnknown ---- */
typedef struct IUnknownVtbl IUnknownVtbl;
typedef struct IUnknown { IUnknownVtbl* lpVtbl; } IUnknown;
struct IUnknownVtbl {
  HRESULT (*QueryInterface)(IUnknown*, const void*, void**);
  unsigned long (*AddRef)(IUnknown*);
  unsigned long (*Release)(IUnknown*);
};

/* ---- ICoreWebView2Environment (8 slots) ---- */
typedef struct ICoreWebView2Environment ICoreWebView2Environment;
typedef struct ICoreWebView2EnvironmentVtbl {
  HRESULT (*QueryInterface)(ICoreWebView2Environment*, const void*, void**);
  unsigned long (*AddRef)(ICoreWebView2Environment*);
  unsigned long (*Release)(ICoreWebView2Environment*);
  HRESULT (*CreateCoreWebView2Controller)(ICoreWebView2Environment*, HWND, void*);
  HRESULT (*CreateWebResourceResponse)(ICoreWebView2Environment*, void*, int, const wchar_t*, const wchar_t*, void**);
  HRESULT (*get_BrowserVersionString)(ICoreWebView2Environment*, wchar_t**);
  HRESULT (*add_NewBrowserVersionAvailable)(ICoreWebView2Environment*, void*, void**);
  HRESULT (*remove_NewBrowserVersionAvailable)(ICoreWebView2Environment*, void*);
} ICoreWebView2EnvironmentVtbl;
struct ICoreWebView2Environment { ICoreWebView2EnvironmentVtbl* lpVtbl; };

/* ---- ICoreWebView2Controller (26 slots) ---- */
typedef struct ICoreWebView2Controller ICoreWebView2Controller;
typedef struct ICoreWebView2ControllerVtbl {
  HRESULT (*QueryInterface)(ICoreWebView2Controller*, const void*, void**);
  unsigned long (*AddRef)(ICoreWebView2Controller*);
  unsigned long (*Release)(ICoreWebView2Controller*);
  HRESULT (*get_IsVisible)(ICoreWebView2Controller*, BOOL*);
  HRESULT (*put_IsVisible)(ICoreWebView2Controller*, BOOL);
  HRESULT (*get_Bounds)(ICoreWebView2Controller*, RECT*);
  HRESULT (*put_Bounds)(ICoreWebView2Controller*, const RECT*);
  HRESULT (*get_ZoomFactor)(ICoreWebView2Controller*, double*);
  HRESULT (*put_ZoomFactor)(ICoreWebView2Controller*, double);
  HRESULT (*add_ZoomFactorChanged)(ICoreWebView2Controller*, void*, void**);
  HRESULT (*remove_ZoomFactorChanged)(ICoreWebView2Controller*, void*);
  HRESULT (*SetBoundsAndZoomFactor)(ICoreWebView2Controller*, const RECT*, double);
  HRESULT (*MoveFocus)(ICoreWebView2Controller*, int);
  HRESULT (*add_MoveFocusRequested)(ICoreWebView2Controller*, void*, void**);
  HRESULT (*remove_MoveFocusRequested)(ICoreWebView2Controller*, void*);
  HRESULT (*add_GotFocus)(ICoreWebView2Controller*, void*, void**);
  HRESULT (*remove_GotFocus)(ICoreWebView2Controller*, void*);
  HRESULT (*add_LostFocus)(ICoreWebView2Controller*, void*, void**);
  HRESULT (*remove_LostFocus)(ICoreWebView2Controller*, void*);
  HRESULT (*add_AcceleratorKeyPressed)(ICoreWebView2Controller*, void*, void**);
  HRESULT (*remove_AcceleratorKeyPressed)(ICoreWebView2Controller*, void*);
  HRESULT (*get_ParentWindow)(ICoreWebView2Controller*, HWND*);
  HRESULT (*put_ParentWindow)(ICoreWebView2Controller*, HWND);
  HRESULT (*NotifyParentWindowPositionChanged)(ICoreWebView2Controller*);
  HRESULT (*Close)(ICoreWebView2Controller*);
  HRESULT (*get_CoreWebView2)(ICoreWebView2Controller*, void**);
} ICoreWebView2ControllerVtbl;
struct ICoreWebView2Controller { ICoreWebView2ControllerVtbl* lpVtbl; };

/* ---- ICoreWebView2 (35 slots: IUnknown + 3..34, through add_WebMessageReceived) ---- */
typedef struct ICoreWebView2 ICoreWebView2;
typedef struct ICoreWebView2Vtbl {
  HRESULT (*QueryInterface)(ICoreWebView2*, const void*, void**);
  unsigned long (*AddRef)(ICoreWebView2*);
  unsigned long (*Release)(ICoreWebView2*);
  HRESULT (*get_Settings)(ICoreWebView2*, void**);
  HRESULT (*get_Source)(ICoreWebView2*, wchar_t**);
  HRESULT (*Navigate)(ICoreWebView2*, const wchar_t*);
  HRESULT (*NavigateToString)(ICoreWebView2*, const wchar_t*);
  HRESULT (*add_NavigationStarting)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_NavigationStarting)(ICoreWebView2*, void*);
  HRESULT (*add_ContentLoading)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_ContentLoading)(ICoreWebView2*, void*);
  HRESULT (*add_SourceChanged)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_SourceChanged)(ICoreWebView2*, void*);
  HRESULT (*add_HistoryChanged)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_HistoryChanged)(ICoreWebView2*, void*);
  HRESULT (*add_NavigationCompleted)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_NavigationCompleted)(ICoreWebView2*, void*);
  HRESULT (*add_FrameNavigationStarting)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_FrameNavigationStarting)(ICoreWebView2*, void*);
  HRESULT (*add_FrameNavigationCompleted)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_FrameNavigationCompleted)(ICoreWebView2*, void*);
  HRESULT (*add_ScriptDialogOpening)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_ScriptDialogOpening)(ICoreWebView2*, void*);
  HRESULT (*add_PermissionRequested)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_PermissionRequested)(ICoreWebView2*, void*);
  HRESULT (*add_ProcessFailed)(ICoreWebView2*, void*, void**);
  HRESULT (*remove_ProcessFailed)(ICoreWebView2*, void*);
  HRESULT (*AddScriptToExecuteOnDocumentCreated)(ICoreWebView2*, const wchar_t*, void*);
  HRESULT (*RemoveScriptToExecuteOnDocumentCreated)(ICoreWebView2*, const wchar_t*);
  HRESULT (*ExecuteScript)(ICoreWebView2*, const wchar_t*, void*);
  HRESULT (*CapturePreview)(ICoreWebView2*, void*, void*);
  HRESULT (*Reload)(ICoreWebView2*);
  HRESULT (*PostWebMessageAsJson)(ICoreWebView2*, const wchar_t*);
  HRESULT (*PostWebMessageAsString)(ICoreWebView2*, const wchar_t*);
  HRESULT (*add_WebMessageReceived)(ICoreWebView2*, void*, void**);
} ICoreWebView2Vtbl;
struct ICoreWebView2 { ICoreWebView2Vtbl* lpVtbl; };

/* ---- event args (6 slots each) ---- */
typedef struct ICoreWebView2WebMessageReceivedEventArgs ICoreWebView2WebMessageReceivedEventArgs;
typedef struct ICoreWebView2WebMessageReceivedEventArgsVtbl {
  HRESULT (*QueryInterface)(ICoreWebView2WebMessageReceivedEventArgs*, const void*, void**);
  unsigned long (*AddRef)(ICoreWebView2WebMessageReceivedEventArgs*);
  unsigned long (*Release)(ICoreWebView2WebMessageReceivedEventArgs*);
  HRESULT (*get_Source)(ICoreWebView2WebMessageReceivedEventArgs*, wchar_t**);
  HRESULT (*get_WebMessageAsJson)(ICoreWebView2WebMessageReceivedEventArgs*, wchar_t**);
  HRESULT (*get_WebMessageAsString)(ICoreWebView2WebMessageReceivedEventArgs*, wchar_t**);
} ICoreWebView2WebMessageReceivedEventArgsVtbl;
struct ICoreWebView2WebMessageReceivedEventArgs { ICoreWebView2WebMessageReceivedEventArgsVtbl* lpVtbl; };

typedef struct ICoreWebView2NavigationCompletedEventArgs ICoreWebView2NavigationCompletedEventArgs;
typedef struct ICoreWebView2NavigationCompletedEventArgsVtbl {
  HRESULT (*QueryInterface)(ICoreWebView2NavigationCompletedEventArgs*, const void*, void**);
  unsigned long (*AddRef)(ICoreWebView2NavigationCompletedEventArgs*);
  unsigned long (*Release)(ICoreWebView2NavigationCompletedEventArgs*);
  HRESULT (*get_IsSuccess)(ICoreWebView2NavigationCompletedEventArgs*, BOOL*);
  HRESULT (*get_WebErrorStatus)(ICoreWebView2NavigationCompletedEventArgs*, long*);
  HRESULT (*get_NavigationId)(ICoreWebView2NavigationCompletedEventArgs*, unsigned long long*);
} ICoreWebView2NavigationCompletedEventArgsVtbl;
struct ICoreWebView2NavigationCompletedEventArgs { ICoreWebView2NavigationCompletedEventArgsVtbl* lpVtbl; };

/* ---- JS callbacks (set once from JS) ---- */
typedef void (*jscb)(void*);
typedef void (*jscb2)(void*, void*);
static jscb2 cb_env;
static jscb2 cb_ctrl;
static jscb cb_msg;
static jscb2 cb_nav;
static jscb cb_exec;
static jscb cb_close;

void set_handlers(void* env, void* ctrl, void* msg, void* nav, void* exec, void* close) {
  cb_env = (jscb2)env;
  cb_ctrl = (jscb2)ctrl;
  cb_msg = (jscb)msg;
  cb_nav = (jscb2)nav;
  cb_exec = (jscb)exec;
  cb_close = (jscb)close;
}

/* ---- shared handler implementations ---- */
static void* hk_query(void* self, const void* riid, void** out) {
  *out = self;
  return (void*)(unsigned long long)S_OK;
}
static unsigned long hk_addref(void* self) { return 1; }
static unsigned long hk_release(void* self) { return 1; }

static char g_utf8buf[65536];
static char* to_utf8(const wchar_t* w) {
  if (!w) return (char*)"";
  WideCharToMultiByte(CP_UTF8, 0, w, -1, g_utf8buf, (int)sizeof(g_utf8buf), 0, 0);
  return g_utf8buf;
}

/* CreateWebViewEnvironmentWithOptionsInternal (undocumented; de-facto stable,
 * same dependency the official loader has):
 *   HRESULT (bool unknown, WebView2RunTimeType runtimeType, PCWSTR userDataDir,
 *            IUnknown* environmentOptions, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*)
 * Cross-checked against jchv/OpenWebView2Loader. `unknown` is passed as true
 * by the loader; runtimeType = kInstalled(0) for the system runtime,
 * kRedistributable(1) for an embedded client DLL. */
typedef long (*create_env_fn)(int, int, const wchar_t*, void*, void*);
static create_env_fn g_create_env;

/* ---- handler objects: { vtable*, refs } ---- */
static void* env_handler_obj[2];
static void* ctrl_handler_obj[2];
static void* msg_handler_obj[2];
static void* nav_handler_obj[2];
static void* exec_handler_obj[2];

static long env_invoke(void* self, long err, void* env) {
  if (cb_env) cb_env((void*)(unsigned long long)(unsigned)err, env);
  return S_OK;
}
static long ctrl_invoke(void* self, long err, void* ctrl) {
  if (cb_ctrl) cb_ctrl((void*)(unsigned long long)(unsigned)err, ctrl);
  return S_OK;
}
static long msg_invoke(void* self, void* wv, void* args) {
  wchar_t* jsonw = 0;
  ((ICoreWebView2WebMessageReceivedEventArgs*)args)->lpVtbl->get_WebMessageAsJson(
    (ICoreWebView2WebMessageReceivedEventArgs*)args, &jsonw);
  if (cb_msg && jsonw) cb_msg((void*)to_utf8(jsonw));
  return S_OK;
}
static long nav_invoke(void* self, void* wv, void* args) {
  int ok = 0;
  long status = 0;
  ((ICoreWebView2NavigationCompletedEventArgs*)args)->lpVtbl->get_IsSuccess(
    (ICoreWebView2NavigationCompletedEventArgs*)args, &ok);
  ((ICoreWebView2NavigationCompletedEventArgs*)args)->lpVtbl->get_WebErrorStatus(
    (ICoreWebView2NavigationCompletedEventArgs*)args, &status);
  if (cb_nav) cb_nav((void*)(unsigned long long)ok, (void*)(unsigned long long)status);
  return S_OK;
}
static long exec_invoke(void* self, long err, const wchar_t* result) {
  if (cb_exec) cb_exec((void*)to_utf8(result ? result : L"null"));
  return S_OK;
}

static void* handler_vtbl(int kind) {
  static void* vtables[5][4];
  static int initialized;
  if (!initialized) {
    int i;
    for (i = 0; i < 5; i++) {
      vtables[i][0] = (void*)hk_query;
      vtables[i][1] = (void*)hk_addref;
      vtables[i][2] = (void*)hk_release;
    }
    vtables[0][3] = (void*)env_invoke;
    vtables[1][3] = (void*)ctrl_invoke;
    vtables[2][3] = (void*)msg_invoke;
    vtables[3][3] = (void*)nav_invoke;
    vtables[4][3] = (void*)exec_invoke;
    initialized = 1;
  }
  return vtables[kind];
}

/* ---- runtime discovery without the official loader ---- */
/*
 * The unified WebView2 runtime hosts from
 * <runtime>\EBWebView\x64\EmbeddedBrowserWebView.dll and exports the
 * environment-creation entry as `CreateWebViewEnvironmentWithOptionsInternal`.
 * It is undocumented but de-facto ABI-stable: the official loader's entire
 * env-creation path is GetProcAddress on this export plus a direct call, so
 * we share the loader's exact dependency — a frozen binary fails identically
 * whether it embeds the loader or this shim.
 *
 * Discovery mirrors the official loader (jchv/OpenWebView2Loader documents
 * the same logic; the loader binary itself is not reverse-engineered):
 * EdgeUpdate records the runtime install folder in
 * HKCU|HKLM\Software\Microsoft\EdgeUpdate\ClientState\{F3017226-...}\EBWebView
 * (REG_SZ, full base path). Probe both hives and both registry views
 * (WOW6432Node/native — the loader is 32-bit and gets redirected
 * implicitly), then fall back to enumerating the standard install bases.
 */
#define KEY_READ 0x20019
#define HKEY_CURRENT_USER ((void*)0x80000001)
#define HKEY_LOCAL_MACHINE ((void*)0x80000002)
extern long RegOpenKeyExW(void*, const wchar_t*, DWORD, UINT, void**);
extern long RegQueryValueExW(void*, const wchar_t*, void*, UINT*, unsigned char*, unsigned long*);
extern void RegCloseKey(void*);
extern void* FindFirstFileW(const wchar_t*, void*);
extern int FindNextFileW(void*, void*);
extern int FindClose(void*);

static int try_load_runtime(const wchar_t* baseDir) {
  wchar_t path[260];
  wsprintfW(path, L"%s\\EBWebView\\x64\\EmbeddedBrowserWebView.dll", baseDir);
  HMODULE mod = LoadLibraryW(path);
  if (!mod) return 0;
  g_create_env = (create_env_fn)GetProcAddress(mod, "CreateWebViewEnvironmentWithOptionsInternal");
  return g_create_env ? 1 : 0;
}

/* reads <hive>\Software\...\EdgeUpdate\ClientState\{GUID}\EBWebView into out
 * (REG_SZ base path); returns 1 on success. The official loader is a 32-bit
 * DLL, so its plain-key reads land in the 32-bit view automatically; this
 * 64-bit shim probes the WOW6432Node (32-bit) and native (64-bit) views
 * explicitly, for both per-user (HKCU) and per-machine (HKLM) installs. */
static int read_runtime_path(void* hive, const wchar_t* middle, wchar_t* out) {
  void* key = 0;
  wchar_t keyPath[300];
  wsprintfW(keyPath, L"Software\\%sMicrosoft\\EdgeUpdate\\ClientState\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", middle);
  if (RegOpenKeyExW(hive, keyPath, 0, KEY_READ, &key) != 0) return 0;
  unsigned long size = 260 * 2;
  long r = RegQueryValueExW(key, L"EBWebView", 0, 0, (unsigned char*)out, &size);
  RegCloseKey(key);
  return r == 0;
}

static int try_runtime_from_registry(void) {
  wchar_t base[260];
  if (read_runtime_path(HKEY_CURRENT_USER, L"WOW6432Node\\", base)) {
    if (try_load_runtime(base)) return 1;
  }
  if (read_runtime_path(HKEY_CURRENT_USER, L"", base)) {
    if (try_load_runtime(base)) return 1;
  }
  if (read_runtime_path(HKEY_LOCAL_MACHINE, L"WOW6432Node\\", base)) {
    if (try_load_runtime(base)) return 1;
  }
  if (read_runtime_path(HKEY_LOCAL_MACHINE, L"", base)) {
    if (try_load_runtime(base)) return 1;
  }
  return 0;
}

typedef struct {
  unsigned long attrs;
  unsigned long long createTime;
  unsigned long long accessTime;
  unsigned long long writeTime;
  unsigned long sizeHigh;
  unsigned long sizeLow;
  unsigned long reserved0;
  unsigned long reserved1;
  wchar_t name[260];
  wchar_t altName[14];
} FIND_DATA;

static int enumerate_base(const wchar_t* base) {
  wchar_t pattern[260];
  FIND_DATA fd;
  wsprintfW(pattern, L"%s*", base);
  void* find = FindFirstFileW(pattern, &fd);
  if (find == (void*)-1) return 0;
  do {
    if (fd.name[0] == '.') continue;
    wchar_t dir[260];
    wsprintfW(dir, L"%s%s", base, fd.name);
    if (try_load_runtime(dir)) {
      FindClose(find);
      return 1;
    }
  } while (FindNextFileW(find, &fd) != 0);
  FindClose(find);
  return 0;
}

int wv_use_runtime(void) {
  /* primary: EdgeUpdate's own record of the install path */
  if (try_runtime_from_registry()) return 1;
  /* registry miss: enumerate the standard bases for any installed version */
  if (enumerate_base(L"C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\")) return 1;
  if (enumerate_base(L"C:\\Program Files\\Microsoft\\EdgeWebView\\Application\\")) return 1;
  return 0;
}

/* ---- window + controller + webview state ---- */
static HWND g_hwnd;
static ICoreWebView2Environment* g_env;
static ICoreWebView2Controller* g_ctrl;
static ICoreWebView2* g_wv;

static long wnd_proc(HWND hwnd, unsigned int msg, void* wp, void* lp) {
  if (msg == WM_SIZE) {
    unsigned long long lv = (unsigned long long)lp;
    int w = (int)(lv & 0xffff);
    int h = (int)((lv >> 16) & 0xffff);
    if (g_ctrl) {
      RECT rc = { 0, 0, w, h };
      g_ctrl->lpVtbl->put_Bounds(g_ctrl, &rc);
    }
    return 0;
  }
  if (msg == WM_CLOSE) {
    if (cb_close) cb_close(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

void* wv_create_window(int w, int h, const wchar_t* title) {
  HINSTANCE inst = GetModuleHandleW(0);
  wchar_t cls[64];
  wsprintfW(cls, L"BunDeskWV_%lu", GetCurrentProcessId());
  /* exe 图标：任务栏会用 exe 的图标，但标题栏/Alt-Tab 需要类图标或
   * WM_SETICON——类图标为 NULL 时标题栏显示空白默认图标。 */
  void* iconBig = 0;
  void* iconSmall = 0;
  wchar_t exePath[260];
  if (GetModuleFileNameW(0, exePath, 260) > 0) {
    ExtractIconExW(exePath, 0, &iconBig, &iconSmall, 1);
  }
  WNDCLASSW wc;
  wc.style = 0;
  wc.wndproc = (void*)wnd_proc;
  wc.cbClsExtra = 0;
  wc.cbWndExtra = 0;
  wc.hInstance = inst;
  wc.hIcon = (void*)iconBig;
  wc.hCursor = 0;
  wc.hbrBg = 0;
  wc.menu = 0;
  wc.cls = cls;
  RegisterClassW(&wc);
  g_hwnd = CreateWindowExW(0, cls, title, 0x00CF0000 /*WS_OVERLAPPEDWINDOW*/,
                           100, 100, w, h, 0, 0, inst, 0);
  if (g_hwnd) {
    /* ICON_BIG=1（标题栏/Alt-Tab 大图标）、ICON_SMALL=0（标题栏小图标） */
    if (iconBig) SendMessageW(g_hwnd, 0x0080 /*WM_SETICON*/, (void*)1, iconBig);
    if (iconSmall) SendMessageW(g_hwnd, 0x0080 /*WM_SETICON*/, 0, iconSmall);
  }
  return (void*)g_hwnd;
}

int wv_show(void) {
  /* TinyCC 直调 ShowWindow 实测无效（rc=0 但窗口仍不可见，JS 侧同句柄
   * 同线程调用有效）；SetWindowPos 的 SWP_SHOWWINDOW 是等价替代。 */
  if (!g_hwnd) return -1;
  return SetWindowPos(g_hwnd, 0, 0, 0, 0, 0,
    0x0001 /*SWP_NOSIZE*/ | 0x0002 /*SWP_NOMOVE*/ | 0x0040 /*SWP_SHOWWINDOW*/);
}

int wv_init(void) {
  /* DPI：unaware 会被系统位图放大导致文字模糊；进程级只能设置一次，
   * 必须在任何 HWND 创建之前。 */
  {
    HMODULE user32 = LoadLibraryW(L"user32.dll");
    if (user32) {
      typedef BOOL (*SetDpiAwarenessContextFn)(void*);
      SetDpiAwarenessContextFn setAwareness = (SetDpiAwarenessContextFn)GetProcAddress(
        user32, "SetProcessDpiAwarenessContext");
      if (setAwareness) {
        setAwareness((void*)-4L); /* DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */
      }
      else {
        /* Windows 10 1703 之前的系统：退回 shcore 的进程级 API。 */
        HMODULE shcore = LoadLibraryW(L"shcore.dll");
        if (shcore) {
          typedef long (*SetProcessDpiAwarenessFn)(int);
          SetProcessDpiAwarenessFn setPda = (SetProcessDpiAwarenessFn)GetProcAddress(
            shcore, "SetProcessDpiAwareness");
          if (setPda) setPda(2); /* PROCESS_PER_MONITOR_DPI_AWARE */
        }
      }
    }
  }
  /* 返回 CoInitializeEx 的 HRESULT：S_OK=本线程新建 STA，S_FALSE=COM 已被
   * 该线程初始化（apartment 可能不符）。dev 的 bun.exe 可能预初始化过 COM。 */
  return CoInitializeEx(0, COINIT_APARTMENTTHREADED);
}

long wv_create_environment(const wchar_t* userDataFolder) {
  env_handler_obj[0] = handler_vtbl(0);
  ctrl_handler_obj[0] = handler_vtbl(1);
  msg_handler_obj[0] = handler_vtbl(2);
  nav_handler_obj[0] = handler_vtbl(3);
  exec_handler_obj[0] = handler_vtbl(4);
  if (!g_create_env) return -1;
  /* (unknown=true, kInstalled, userDataFolder, options=NULL, handler) */
  return g_create_env(1, 0, userDataFolder, 0, env_handler_obj);
}

long wv_create_controller(void* env, HWND hwnd) {
  /* Keep the environment alive: the loader releases its reference after the
   * completed callback, leaving the pointer dangling without AddRef. */
  g_env = (ICoreWebView2Environment*)env;
  if (g_env) g_env->lpVtbl->AddRef(g_env);
  return g_env->lpVtbl->CreateCoreWebView2Controller(
    g_env, hwnd, ctrl_handler_obj);
}

long wv_setup(void* ctrl) {
  g_ctrl = (ICoreWebView2Controller*)ctrl;
  if (g_ctrl) g_ctrl->lpVtbl->AddRef(g_ctrl);
  RECT rc;
  GetClientRect(g_hwnd, &rc);
  long hr = g_ctrl->lpVtbl->put_Bounds(g_ctrl, &rc);
  long visHr = g_ctrl->lpVtbl->put_IsVisible(g_ctrl, 1);
  hr = g_ctrl->lpVtbl->get_CoreWebView2(g_ctrl, (void**)&g_wv);
  if (g_wv) g_wv->lpVtbl->AddRef(g_wv);
  hr = g_wv->lpVtbl->add_WebMessageReceived(g_wv, msg_handler_obj, 0);
  hr = g_wv->lpVtbl->add_NavigationCompleted(g_wv, nav_handler_obj, 0);
  return hr || visHr;
}

long wv_navigate(const wchar_t* url) {
  return g_wv ? g_wv->lpVtbl->Navigate(g_wv, url) : -1;
}

long wv_post_json(const wchar_t* json) {
  return g_wv ? g_wv->lpVtbl->PostWebMessageAsJson(g_wv, json) : -1;
}

void wv_execute_script(const wchar_t* js) {
  if (g_wv) g_wv->lpVtbl->ExecuteScript(g_wv, js, exec_handler_obj);
}

void wv_close(void) {
  /* Skip ICoreWebView2Controller::Close: on hosts whose browser process never
   * attached (broken/Edge-unified runtimes) it can crash the in-process
   * runtime. DestroyWindow + CoUninitialize releases the view; the COM objects
   * leak until process exit, which the process teardown handles. */
  if (g_hwnd) DestroyWindow(g_hwnd);
  g_ctrl = 0;
  g_wv = 0;
  g_hwnd = 0;
  CoUninitialize();
}
