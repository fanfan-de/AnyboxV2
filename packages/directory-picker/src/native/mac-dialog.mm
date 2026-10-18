#import <Cocoa/Cocoa.h>
#include <node_api.h>

#include <cstring>

namespace {

napi_value CancelDirectoryPanel(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to read native directory cancellation arguments");
    return nullptr;
  }
  bool is_buffer = false;
  if (argc != 1 || napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer) {
    napi_throw_type_error(env, nullptr, "Native directory cancellation requires one window handle Buffer");
    return nullptr;
  }
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length != sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "Invalid native directory window handle");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Native directory cancellation requires the main thread");
    return nullptr;
  }

  bool cancelled = false;
  @try {
    void* pointer = nullptr;
    std::memcpy(&pointer, data, sizeof(pointer));
    if (pointer) {
      // Electron's macOS handle is its NSView. Resolve only that view's owner;
      // never search application-wide windows or the global responder chain.
      NSView* view = (__bridge NSView*)pointer;
      NSWindow* owner = view.window;
      NSWindow* sheet = owner.attachedSheet;
      if ([sheet isKindOfClass:[NSOpenPanel class]]) {
        [(NSOpenPanel*)sheet cancel:nil];
        cancelled = true;
      }
    }
  } @catch (NSException* exception) {
    (void)exception;
    napi_throw_error(env, nullptr, "Native directory cancellation failed");
    return nullptr;
  }

  napi_value result;
  if (napi_get_boolean(env, cancelled, &result) != napi_ok) return nullptr;
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor property = {
    "cancelDirectoryPanel", nullptr, CancelDirectoryPanel, nullptr, nullptr,
    nullptr, napi_default, nullptr,
  };
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(mac_dialog, Initialize)
