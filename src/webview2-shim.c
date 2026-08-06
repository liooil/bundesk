/*
 * webview2-shim.c — header-free WebView2 COM host for bundesk.
 *
 * Compiled at runtime by bun:ffi's embedded TinyCC (`cc`), linked against
 * kernel32/user32/ole32/advapi32. All COM interfaces are hand-declared with
 * vtable layouts verified against the official WebView2.h (Microsoft.Web.WebView2
 * NuGet, 1.0.2957.106). Only the bounded slice used by the framework is
 * declared; never call a slot beyond the declared struct size.
 *
 * Conventions: x64 Windows has a single calling convention, so no __stdcall
 * is needed (tinycc rejects the keyword anyway).
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
#define KEY_READ 0x20019
#define HKEY_LOCAL_MACHINE ((void*)0x80000002)

/* ---- kernel32 / user32 / ole32 / advapi32 externs ---- */
extern void* LoadLibraryW(const wchar_t*);
extern void* GetProcAddress(void*, const char*);
extern void* GetModuleHandleW(const wchar_t*);
extern unsigned long GetCurrentProcessId(void);
extern int WideCharToMultiByte(UINT, DWORD, const wchar_t*, int, char*, int, const char*, int*);
extern void* CoInitializeEx(void*, DWORD);
extern void CoUninitialize(void);
extern unsigned short RegisterClassW(const void*);
extern void* CreateWindowExW(UINT, const wchar_t*, const wchar_t*, DWORD, int, int, int, int, HWND, void*, HINSTANCE, void*);
extern long DefWindowProcW(HWND, UINT, void*, void*);
extern int DestroyWindow(HWND);
extern int ShowWindow(HWND, int);
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

typedef long (*create_env_fn)(const wchar_t*, const wchar_t*, void*, void*);
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

/* ---- runtime discovery via the official WebView2Loader.dll ---- */
/*
 * The WebView2 runtime no longer ships WebView2.dll at a discoverable path
 * (Edge-unified runtimes are hosted by msedgewebview2.exe), so hand-rolled
 * registry lookup is not viable. The SDK's WebView2Loader.dll does the whole
 * discovery; bundesk embeds it (base64) and extracts it at runtime.
 */
int wv_use_loader(const wchar_t* loaderPath) {
  HMODULE mod = LoadLibraryW(loaderPath);
  if (!mod) return 0;
  g_create_env = (create_env_fn)GetProcAddress(mod, "CreateCoreWebView2EnvironmentWithOptions");
  return g_create_env ? 1 : 0;
}

/* ---- window + controller + webview state ---- */
static HWND g_hwnd;
static ICoreWebView2Controller* g_ctrl;
static ICoreWebView2* g_wv;
static int g_pump_msgs;

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
  WNDCLASSW wc;
  wc.style = 0;
  wc.wndproc = (void*)wnd_proc;
  wc.cbClsExtra = 0;
  wc.cbWndExtra = 0;
  wc.hInstance = inst;
  wc.hIcon = 0;
  wc.hCursor = 0;
  wc.hbrBg = 0;
  wc.menu = 0;
  wc.cls = cls;
  RegisterClassW(&wc);
  g_hwnd = CreateWindowExW(0, cls, title, 0x00CF0000 /*WS_OVERLAPPEDWINDOW*/,
                           100, 100, w, h, 0, 0, inst, 0);
  return (void*)g_hwnd;
}

void wv_show(void) {
  if (g_hwnd) ShowWindow(g_hwnd, SW_SHOW);
}

int wv_init(void) {
  CoInitializeEx(0, COINIT_APARTMENTTHREADED);
  return 1;
}

long wv_create_environment(const wchar_t* userDataFolder) {
  env_handler_obj[0] = handler_vtbl(0);
  ctrl_handler_obj[0] = handler_vtbl(1);
  msg_handler_obj[0] = handler_vtbl(2);
  nav_handler_obj[0] = handler_vtbl(3);
  exec_handler_obj[0] = handler_vtbl(4);
  if (!g_create_env) return -1;
  /* (browserExecutableFolder=NULL -> system runtime, userDataFolder, options, handler) */
  return g_create_env(0, userDataFolder, 0, env_handler_obj);
}

long wv_create_controller(void* env, HWND hwnd) {
  return ((ICoreWebView2Environment*)env)->lpVtbl->CreateCoreWebView2Controller(
    (ICoreWebView2Environment*)env, hwnd, ctrl_handler_obj);
}

long wv_setup(void* ctrl) {
  g_ctrl = (ICoreWebView2Controller*)ctrl;
  long hr = g_ctrl->lpVtbl->put_IsVisible(g_ctrl, 1);
  hr = g_ctrl->lpVtbl->get_CoreWebView2(g_ctrl, (void**)&g_wv);
  hr = g_wv->lpVtbl->add_WebMessageReceived(g_wv, msg_handler_obj, 0);
  hr = g_wv->lpVtbl->add_NavigationCompleted(g_wv, nav_handler_obj, 0);
  return hr;
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

char* wv_diag_source(void) {
  if (!g_wv) return (char*)"(no webview)";
  wchar_t* src = 0;
  long hr = g_wv->lpVtbl->get_Source(g_wv, &src);
  if (hr != 0 || !src) return (char*)"(get_Source failed)";
  return to_utf8(src);
}

extern void* GetCurrentProcess(void);
extern int EnumProcessModulesEx(void*, void*, unsigned long, unsigned long*, unsigned long);
extern unsigned long GetModuleFileNameExW(void*, void*, wchar_t*, unsigned long);

char* wv_diag_modules(void) {
  void* modules[512];
  unsigned long needed = 0;
  if (!EnumProcessModulesEx(GetCurrentProcess(), modules, sizeof(modules), &needed, 3)) return (char*)"(enum failed)";
  int count = needed / (unsigned long)sizeof(void*);
  int i;
  for (i = 0; i < count && i < 512; i++) {
    wchar_t path[512];
    if (GetModuleFileNameExW(GetCurrentProcess(), modules[i], path, 512) == 0) continue;
    /* crude 'contains Edge or WebView' check on the wide string */
    int j;
    for (j = 0; path[j] && j < 500; j++) {
      if ((path[j] == 'E' || path[j] == 'e') && path[j+1] == 'd' && path[j+2] == 'g' && path[j+3] == 'e') {
        return to_utf8(path);
      }
    }
  }
  return (char*)"(no Edge/WebView module loaded)";
}

long wv_diag_navstring(const wchar_t* html) {
  if (!g_wv) return -1;
  return g_wv->lpVtbl->NavigateToString(g_wv, html);
}

long wv_diag_watch_events(void) {
  if (!g_wv) return -1;
  long hr = g_wv->lpVtbl->add_NavigationStarting(g_wv, nav_handler_obj, 0);
  if (hr != 0) return hr;
  hr = g_wv->lpVtbl->add_SourceChanged(g_wv, nav_handler_obj, 0);
  return hr;
}

void wv_close(void) {
  if (g_ctrl) g_ctrl->lpVtbl->Close(g_ctrl);
  if (g_hwnd) DestroyWindow(g_hwnd);
  g_ctrl = 0;
  g_wv = 0;
  g_hwnd = 0;
  CoUninitialize();
}

void wv_pump_messages(void) {
  /* no-op placeholder; message pump runs on the JS side */
}
