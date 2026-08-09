/*
 * webkit-shim.c — header-free WebKitGTK window host for bundesk (Linux).
 *
 * Compiled at runtime by bun:ffi's embedded TinyCC (`cc`); no dev headers and
 * no link-time dependencies. Every symbol is resolved with dlopen/dlsym at
 * wk_init, so the only runtime requirement is the WebKit2GTK stack installed
 * on the system: libwebkit2gtk-4.1.so.0 (or -4.0), libjavascriptcoregtk
 * (-4.1/-4.0), the matching libgtk and the GLib stack. If those are missing,
 * wk_init returns 0 (with a diagnostic code) and the app falls back to the
 * browser provider — the provider dispatch decides.
 *
 * GTK base detection: distros disagree about which GTK the 4.1 API is built
 * on — Arch's webkit2gtk-4.1 links GTK3 (pkg-config emits -lgtk-3), while
 * Debian/Ubuntu's links GTK4. Loading the WRONG base makes GTK4 abort
 * ("GTK 2/3 symbols detected") or corrupts the type registry ("cannot
 * register existing type GtkWidget"), so after dlopen(webkit) forces its
 * dependencies in, the loaded base is probed (RTLD_NOLOAD) and the matching
 * widget API (gtk_window_set_child vs gtk_container_add, gtk_window_destroy
 * vs gtk_widget_destroy, ...) is used.
 *
 * The GLib main loop is pumped from JS (wk_pump -> g_main_context_iteration),
 * mirroring the WebView2 message pump on Windows; every GTK/WebKit call and
 * every signal callback therefore runs on the JS thread.
 *
 * Page bridge: the shim registers a script-message handler named "bundesk"
 * and injects (document start, top frame) `window.chrome.webview` with
 * postMessage forwarding to
 * window.webkit.messageHandlers.bundesk.postMessage(JSON.stringify(m)) and
 * addEventListener('message', ...) subscribing to a synthetic
 * 'bundesk-message' MessageEvent dispatched by wk_post_json. Pages written
 * for the WebView2 provider work unchanged.
 *
 * Script evaluation: webkit_web_view_run_javascript (5-arg, deprecated but
 * still exported in 2.52) is used in preference to evaluate_javascript
 * (7-arg) — the 7-arg variant crashes inside g_task_new on the GTK3 build
 * (verified 2026-08-06 on webkit2gtk-4.1 2.52.3/GTK3: g_object_ref receives a
 * garbage source object); the 5-arg variant round-trips cleanly. If a future
 * webkit removes run_javascript, evaluate_javascript is used as fallback.
 *
 * tcc constraints carried over from the win32 shim: keep stack frames small
 * (tcc miscompiles functions with >~2KB of locals), resolve dlsym results
 * with plain direct cast assignments (the (void**)(&fn) write pattern crashes
 * on Linux tcc), and all result strings are copied into the static g_resbuf
 * read synchronously by the JSCallback.
 */

typedef void (*jscb)(void*);

/* ---- dlopen/dlsym (merged into libc on modern glibc; resolved at runtime) ---- */
extern void* dlopen(const char*, int);
extern void* dlsym(void*, const char*);
extern char* getenv(const char*);
extern int setenv(const char*, const char*, int);

#define RTLD_NOW 2
#define RTLD_NOLOAD 4

static void* g_glib;
static void* g_gobj;
static void* g_gtk;
static void* g_jsc;
static void* g_wk;
static int g_gtk_mode; /* GTK major version webkit is built against: 3 or 4 */

/* ---- resolved function pointers ---- */
static int (*gtk_init_check_fn)(int*, char***);
static void* (*gtk_window_new_fn)(int); /* gtk3: (GtkWindowType); gtk4 ignores the arg */
static void (*gtk_window_set_title_fn)(void*, const char*);
static void (*gtk_window_set_default_size_fn)(void*, int, int);
static void (*gtk_window_set_child_fn)(void*, void*);   /* gtk4 only */
static void (*gtk_container_add_fn)(void*, void*);      /* gtk3 only */
static void (*gtk_window_destroy_fn)(void*);            /* gtk4 only */
static void (*gtk_widget_destroy_fn)(void*);            /* gtk3 only */
static void (*gtk_window_present_fn)(void*);
static void (*gtk_widget_show_fn)(void*);
static int (*g_main_context_iteration_fn)(void*, int);
static unsigned long (*g_signal_connect_data_fn)(void*, const char*, void*, void*, void*, int);
static void (*g_object_unref_fn)(void*);
static void (*g_free_fn)(void*);
static void* (*webkit_web_view_new_with_user_content_manager_fn)(void*);
static void (*webkit_web_view_load_uri_fn)(void*, const char*);
static void (*webkit_web_view_run_javascript_fn)(void*, const char*, void*, void*, void*);
static void* (*webkit_web_view_run_javascript_finish_fn)(void*, void*, void**);
static void (*webkit_web_view_evaluate_javascript_fn)(void*, const char*, long, const char*, void*, void*, void*);
static void* (*webkit_web_view_evaluate_javascript_finish_fn)(void*, void*, void**);
static void* (*webkit_user_content_manager_new_fn)(void);
static int (*webkit_user_content_manager_register_script_message_handler_fn)(void*, const char*);
static void (*webkit_user_content_manager_add_script_fn)(void*, void*);
static void* (*webkit_user_script_new_fn)(const char*, int, int, void*, void*);
static void (*webkit_user_script_unref_fn)(void*);
static void* (*webkit_javascript_result_get_js_value_fn)(void*);
static void (*webkit_javascript_result_unref_fn)(void*);
static char* (*jsc_value_to_string_fn)(void*);

/* 1 = evaluate_javascript (run_javascript unavailable), 0 = run_javascript */
static int g_use_evaluate;

/* diagnostic code: 0 = ok, 1..5 = dlopen of libs, 10+ = symbol resolve index,
 * 90 = gtk_init_check, 91 = both gtk3+gtk4 loaded (broken env) */
int g_diag;

static int resolve_gtk(void) {
  int g3 = dlopen("libgtk-3.so.0", RTLD_NOW | RTLD_NOLOAD) != 0;
  int g4 = dlopen("libgtk-4.so.1", RTLD_NOW | RTLD_NOLOAD) != 0;
  if (g3 && g4) {
    g_diag = 91;
    return 0;
  }
  g_gtk_mode = g3 ? 3 : 4;
  g_gtk = dlopen(g3 ? "libgtk-3.so.0" : "libgtk-4.so.1", RTLD_NOW);
  if (!g_gtk) {
    g_diag = 3;
    return 0;
  }

  gtk_init_check_fn = (int (*)(int*, char***))dlsym(g_gtk, "gtk_init_check");
  if (!gtk_init_check_fn) { g_diag = 14; return 0; }
  gtk_window_new_fn = (void* (*)(int))dlsym(g_gtk, "gtk_window_new");
  if (!gtk_window_new_fn) { g_diag = 15; return 0; }
  gtk_window_set_title_fn = (void (*)(void*, const char*))dlsym(g_gtk, "gtk_window_set_title");
  if (!gtk_window_set_title_fn) { g_diag = 16; return 0; }
  gtk_window_set_default_size_fn = (void (*)(void*, int, int))dlsym(g_gtk, "gtk_window_set_default_size");
  if (!gtk_window_set_default_size_fn) { g_diag = 17; return 0; }
  gtk_window_present_fn = (void (*)(void*))dlsym(g_gtk, "gtk_window_present");
  if (!gtk_window_present_fn) { g_diag = 20; return 0; }
  gtk_widget_show_fn = (void (*)(void*))dlsym(g_gtk, "gtk_widget_show");
  if (!gtk_widget_show_fn) { g_diag = 21; return 0; }
  if (g_gtk_mode == 4) {
    gtk_window_set_child_fn = (void (*)(void*, void*))dlsym(g_gtk, "gtk_window_set_child");
    if (!gtk_window_set_child_fn) { g_diag = 18; return 0; }
    gtk_window_destroy_fn = (void (*)(void*))dlsym(g_gtk, "gtk_window_destroy");
    if (!gtk_window_destroy_fn) { g_diag = 19; return 0; }
  } else {
    gtk_container_add_fn = (void (*)(void*, void*))dlsym(g_gtk, "gtk_container_add");
    if (!gtk_container_add_fn) { g_diag = 18; return 0; }
    gtk_widget_destroy_fn = (void (*)(void*))dlsym(g_gtk, "gtk_widget_destroy");
    if (!gtk_widget_destroy_fn) { g_diag = 19; return 0; }
  }
  return 1;
}

int wk_init(void) {
  g_diag = 0;
  g_glib = dlopen("libglib-2.0.so.0", RTLD_NOW); if (!g_glib) { g_diag = 1; return 0; }
  g_gobj = dlopen("libgobject-2.0.so.0", RTLD_NOW); if (!g_gobj) { g_diag = 2; return 0; }
  g_jsc = dlopen("libjavascriptcoregtk-4.1.so.0", RTLD_NOW);
  if (!g_jsc) g_jsc = dlopen("libjavascriptcoregtk-4.0.so.18", RTLD_NOW);
  if (!g_jsc) { g_diag = 4; return 0; }
  g_wk = dlopen("libwebkit2gtk-4.1.so.0", RTLD_NOW);
  if (!g_wk) g_wk = dlopen("libwebkit2gtk-4.0.so.37", RTLD_NOW);
  if (!g_wk) { g_diag = 5; return 0; }
  if (!resolve_gtk()) return 0;

  g_main_context_iteration_fn = (int (*)(void*, int))dlsym(g_glib, "g_main_context_iteration");
  if (!g_main_context_iteration_fn) { g_diag = 10; return 0; }
  g_free_fn = (void (*)(void*))dlsym(g_glib, "g_free");
  if (!g_free_fn) { g_diag = 11; return 0; }
  g_signal_connect_data_fn = (unsigned long (*)(void*, const char*, void*, void*, void*, int))dlsym(g_gobj, "g_signal_connect_data");
  if (!g_signal_connect_data_fn) { g_diag = 12; return 0; }
  g_object_unref_fn = (void (*)(void*))dlsym(g_gobj, "g_object_unref");
  if (!g_object_unref_fn) { g_diag = 13; return 0; }
  jsc_value_to_string_fn = (char* (*)(void*))dlsym(g_jsc, "jsc_value_to_string");
  if (!jsc_value_to_string_fn) { g_diag = 22; return 0; }
  webkit_web_view_new_with_user_content_manager_fn = (void* (*)(void*))dlsym(g_wk, "webkit_web_view_new_with_user_content_manager");
  if (!webkit_web_view_new_with_user_content_manager_fn) { g_diag = 24; return 0; }
  webkit_web_view_load_uri_fn = (void (*)(void*, const char*))dlsym(g_wk, "webkit_web_view_load_uri");
  if (!webkit_web_view_load_uri_fn) { g_diag = 25; return 0; }
  webkit_web_view_run_javascript_fn = (void (*)(void*, const char*, void*, void*, void*))dlsym(g_wk, "webkit_web_view_run_javascript");
  webkit_web_view_run_javascript_finish_fn = (void* (*)(void*, void*, void**))dlsym(g_wk, "webkit_web_view_run_javascript_finish");
  webkit_web_view_evaluate_javascript_fn = (void (*)(void*, const char*, long, const char*, void*, void*, void*))dlsym(g_wk, "webkit_web_view_evaluate_javascript");
  webkit_web_view_evaluate_javascript_finish_fn = (void* (*)(void*, void*, void**))dlsym(g_wk, "webkit_web_view_evaluate_javascript_finish");
  g_use_evaluate = !(webkit_web_view_run_javascript_fn && webkit_web_view_run_javascript_finish_fn);
  if (g_use_evaluate && !(webkit_web_view_evaluate_javascript_fn && webkit_web_view_evaluate_javascript_finish_fn)) {
    g_diag = 26;
    return 0;
  }
  webkit_user_content_manager_new_fn = (void* (*)(void))dlsym(g_wk, "webkit_user_content_manager_new");
  if (!webkit_user_content_manager_new_fn) { g_diag = 28; return 0; }
  webkit_user_content_manager_register_script_message_handler_fn = (int (*)(void*, const char*))dlsym(g_wk, "webkit_user_content_manager_register_script_message_handler");
  if (!webkit_user_content_manager_register_script_message_handler_fn) { g_diag = 29; return 0; }
  webkit_user_content_manager_add_script_fn = (void (*)(void*, void*))dlsym(g_wk, "webkit_user_content_manager_add_script");
  if (!webkit_user_content_manager_add_script_fn) { g_diag = 30; return 0; }
  webkit_user_script_new_fn = (void* (*)(const char*, int, int, void*, void*))dlsym(g_wk, "webkit_user_script_new");
  if (!webkit_user_script_new_fn) { g_diag = 31; return 0; }
  webkit_user_script_unref_fn = (void (*)(void*))dlsym(g_wk, "webkit_user_script_unref");
  if (!webkit_user_script_unref_fn) { g_diag = 34; return 0; }
  webkit_javascript_result_get_js_value_fn = (void* (*)(void*))dlsym(g_wk, "webkit_javascript_result_get_js_value");
  if (!webkit_javascript_result_get_js_value_fn) { g_diag = 32; return 0; }
  webkit_javascript_result_unref_fn = (void (*)(void*))dlsym(g_wk, "webkit_javascript_result_unref");
  if (!webkit_javascript_result_unref_fn) { g_diag = 33; return 0; }

  /* gtk_init_check owns the GLib main context; safe on the JS thread */
  {
    int argc = 1;
    char arg0[] = "bundesk";
    char* argv[1] = { arg0 };
    char** argvp = argv;
    if (!gtk_init_check_fn(&argc, &argvp)) {
      g_diag = 90;
      return 0;
    }
  }
  return 1;
}

int wk_diag(void) { return g_diag; }

/* Bun's JS process.env mutation is not inherited by native child processes.
   Set the compatibility flag through libc before WebKit is initialized so
   WebKitWebProcess receives it. Return 1 only when the default was applied. */
int wk_configure_environment(void) {
  if (getenv("WAYLAND_DISPLAY") && !getenv("WEBKIT_DISABLE_DMABUF_RENDERER")) {
    return setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1", 0) == 0;
  }
  return 0;
}

/* ---- JS callbacks (set once from JS) ---- */
static jscb cb_msg;
static jscb cb_nav;
static jscb cb_exec;
static jscb cb_exec_raw;
static void (*cb_close)(void);

void set_handlers(void* msg, void* nav, void* exec, void* exec_raw, void* close) {
  cb_msg = (jscb)msg;
  cb_nav = (jscb)nav;
  cb_exec = (jscb)exec;
  cb_exec_raw = (jscb)exec_raw;
  cb_close = (void (*)(void))close;
}

static char g_resbuf[262144];

static void copy_utf8(char* s) {
  int n = 0;
  while (s[n] && n < (int)sizeof(g_resbuf) - 1) {
    g_resbuf[n] = s[n];
    n++;
  }
  g_resbuf[n] = 0;
}

/* ---- window state ---- */
static void* g_win;
static void* g_webview;
static void* g_manager;

/* Prevent GTK's default destroy; JS owns teardown and resolves window.exited. */
static int close_gtk3_cb(void* win, void* event, void* ud) {
  (void)win;
  (void)event;
  (void)ud;
  if (cb_close) cb_close();
  return 1;
}

static int close_gtk4_cb(void* win, void* ud) {
  (void)win;
  (void)ud;
  if (cb_close) cb_close();
  return 1;
}

/* load-changed: GCallback(void* webview, int event, void* ud) */
static void load_cb(void* wv, int event, void* ud) {
  (void)wv;
  (void)ud;
  if (cb_nav) cb_nav((void*)(unsigned long long)event);
}

/* script-message-received::bundesk: GCallback(void* manager, void* jsresult, void* ud) */
static void msg_cb(void* manager, void* jsresult, void* ud) {
  (void)manager;
  (void)ud;
  if (jsresult) {
    void* value = webkit_javascript_result_get_js_value_fn(jsresult);
    if (value) {
      char* s = jsc_value_to_string_fn(value);
      if (s) {
        copy_utf8(s);
        g_free_fn(s);
      }
    }
    webkit_javascript_result_unref_fn(jsresult);
  }
  if (cb_msg) cb_msg((void*)g_resbuf);
}

/* script evaluation completion: GAsyncReadyCallback(void* src, void* res, void* ud) */
static void exec_cb(void* src, void* res, void* ud) {
  (void)src;
  void* value = 0;
  void* jr = 0;
  void* errp = 0;
  if (g_use_evaluate) {
    value = webkit_web_view_evaluate_javascript_finish_fn(g_webview, res, &errp);
  } else {
    jr = webkit_web_view_run_javascript_finish_fn(g_webview, res, &errp);
    if (jr) value = webkit_javascript_result_get_js_value_fn(jr);
  }
  if (value) {
    char* s = jsc_value_to_string_fn(value);
    if (s) {
      copy_utf8(s);
      g_free_fn(s);
    }
    /* evaluate_javascript_finish returns an owned JSCValue; the legacy
       run_javascript result exposes a borrowed value owned by jr. */
    if (g_use_evaluate) g_object_unref_fn(value);
  } else if (errp) {
    /* GError { guint domain; gint code; gchar* message; } — message at +8 */
    char* m = *(char**)((char*)errp + 8);
    if (m) copy_utf8(m);
  } else {
    g_resbuf[0] = 0;
  }
  if (jr) webkit_javascript_result_unref_fn(jr);
  if (ud) {
    if (cb_exec_raw) cb_exec_raw((void*)g_resbuf);
  } else if (cb_exec) {
    cb_exec((void*)g_resbuf);
  }
}

int wk_create_window(const char* title, const char* url, int w, int h) {
  g_manager = webkit_user_content_manager_new_fn();
  if (!g_manager) return 0;
  if (!webkit_user_content_manager_register_script_message_handler_fn(g_manager, "bundesk")) return 0;
  g_signal_connect_data_fn(g_manager, "script-message-received::bundesk", (void*)msg_cb, 0, 0, 0);

  /* chrome.webview bridge, injected at document start */
  {
    const char* bridge =
      "if(!window.chrome)window.chrome={};"
      "window.chrome.webview={"
      "postMessage:function(m){window.webkit.messageHandlers.bundesk.postMessage(JSON.stringify(m));},"
      "addEventListener:function(t,fn){if(t==='message')window.addEventListener('bundesk-message',function(e){fn({data:JSON.parse(e.data||'null')});});},"
      "removeEventListener:function(){}};";
    void* us = webkit_user_script_new_fn(bridge, 0, 0, 0, 0);
    if (!us) return 0;
    webkit_user_content_manager_add_script_fn(g_manager, us);
    /* WebKitUserScript is a refcounted boxed type (not a GObject) in 4.1 */
    webkit_user_script_unref_fn(us);
  }

  g_win = gtk_window_new_fn(0); /* GTK_WINDOW_TOPLEVEL; gtk4 ignores the arg */
  if (!g_win) return 0;
  gtk_window_set_title_fn(g_win, title);
  if (w > 0 && h > 0) gtk_window_set_default_size_fn(g_win, w, h);

  g_webview = webkit_web_view_new_with_user_content_manager_fn(g_manager);
  if (!g_webview) return 0;
  if (g_gtk_mode == 4) {
    gtk_window_set_child_fn(g_win, g_webview);
    g_signal_connect_data_fn(g_win, "close-request", (void*)close_gtk4_cb, 0, 0, 0);
  } else {
    gtk_container_add_fn(g_win, g_webview);
    g_signal_connect_data_fn(g_win, "delete-event", (void*)close_gtk3_cb, 0, 0, 0);
  }

  g_signal_connect_data_fn(g_webview, "load-changed", (void*)load_cb, 0, 0, 0);

  /* GTK3's gtk_widget_show() does not recursively show child widgets. The
     web view can load and execute while remaining invisible unless it is
     explicitly shown. GTK4 accepts the same call. */
  gtk_widget_show_fn(g_webview);
  gtk_widget_show_fn(g_win);
  gtk_window_present_fn(g_win);
  webkit_web_view_load_uri_fn(g_webview, url);
  return 1;
}

void wk_navigate(const char* url) {
  if (g_webview) webkit_web_view_load_uri_fn(g_webview, url);
}

static void run_script(const char* script, int raw) {
  if (!g_webview) return;
  if (g_use_evaluate) {
    webkit_web_view_evaluate_javascript_fn(g_webview, script, -1, 0, 0, (void*)exec_cb, raw ? (void*)1 : 0);
  } else {
    webkit_web_view_run_javascript_fn(g_webview, script, 0, (void*)exec_cb, raw ? (void*)1 : 0);
  }
}

void wk_run_js(const char* script) {
  run_script(script, 0);
}

void wk_run_js_raw(const char* script) {
  run_script(script, 1);
}

void wk_pump(void) {
  g_main_context_iteration_fn(0, 0);
}

void wk_close(void) {
  if (g_win) {
    if (g_gtk_mode == 4) {
      gtk_window_destroy_fn(g_win);
    } else {
      gtk_widget_destroy_fn(g_win);
    }
  }
  g_win = 0;
  g_webview = 0;
  g_manager = 0;
}
