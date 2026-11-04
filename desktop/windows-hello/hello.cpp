// Chicory's Windows Hello prompt, owned by the Chicory window.
//
// UserConsentVerifier::RequestVerificationAsync is meant for UWP apps. From a
// desktop process its dialog has no owner window, so it can open behind
// Chicory or on another monitor. IUserConsentVerifierInterop takes the window
// that owns the dialog instead, so it opens in front of Chicory, on the same
// monitor.
//
//   chicory-hello.exe check
//   chicory-hello.exe verify <window handle> <message>
//
// The window handle is the decimal HWND of Chicory's main window. The helper
// prints one UserConsentVerifierAvailability or UserConsentVerificationResult
// name, such as Available or Verified, and exits 0. Anything else, including
// a nonzero exit, is a failure. desktop/os-auth.cjs runs it and maps the
// answer. It never chooses prompt text: the message comes from the main
// process's fixed list.
//
// Built by scripts/desktop/build-windows-hello.mjs during npm run
// runtime:prepare on Windows.

#include <windows.h>
#include <UserConsentVerifierInterop.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <cwchar>

namespace ui = winrt::Windows::Security::Credentials::UI;
using winrt::Windows::Foundation::AsyncStatus;
using winrt::Windows::Foundation::IAsyncOperation;

namespace {

// The main process kills the helper after 120 seconds, which would leave the
// dialog open. Cancel it before then.
constexpr ULONGLONG kVerifyDeadlineMs = 110000;
constexpr ULONGLONG kCheckDeadlineMs = 10000;
constexpr ULONGLONG kCancelSettleMs = 2000;
constexpr DWORD kPollMs = 50;
// The dialog appears a moment after the request. Look for it this long.
constexpr ULONGLONG kFocusSearchMs = 5000;
constexpr size_t kMaxMessage = 256;
constexpr wchar_t kPromptClass[] = L"Credential Dialog Xaml Host";

constexpr int kAnswered = 0;
constexpr int kFailed = 1;
constexpr int kUsage = 2;

const char* Name(ui::UserConsentVerifierAvailability value) {
  switch (value) {
    case ui::UserConsentVerifierAvailability::Available: return "Available";
    case ui::UserConsentVerifierAvailability::DeviceNotPresent: return "DeviceNotPresent";
    case ui::UserConsentVerifierAvailability::NotConfiguredForUser: return "NotConfiguredForUser";
    case ui::UserConsentVerifierAvailability::DisabledByPolicy: return "DisabledByPolicy";
    case ui::UserConsentVerifierAvailability::DeviceBusy: return "DeviceBusy";
  }
  return "Unknown";
}

const char* Name(ui::UserConsentVerificationResult value) {
  switch (value) {
    case ui::UserConsentVerificationResult::Verified: return "Verified";
    case ui::UserConsentVerificationResult::DeviceNotPresent: return "DeviceNotPresent";
    case ui::UserConsentVerificationResult::NotConfiguredForUser: return "NotConfiguredForUser";
    case ui::UserConsentVerificationResult::DisabledByPolicy: return "DisabledByPolicy";
    case ui::UserConsentVerificationResult::DeviceBusy: return "DeviceBusy";
    case ui::UserConsentVerificationResult::RetriesExhausted: return "RetriesExhausted";
    case ui::UserConsentVerificationResult::Canceled: return "Canceled";
  }
  return "Unknown";
}

bool Write(DWORD stream, const char* text) {
  HANDLE handle = GetStdHandle(stream);
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE) return false;
  const DWORD length = static_cast<DWORD>(std::strlen(text));
  DWORD written = 0;
  return WriteFile(handle, text, length, &written, nullptr) && written == length;
}

int Answer(const char* word) { return Write(STD_OUTPUT_HANDLE, word) ? kAnswered : kFailed; }

int Fail(const char* what, HRESULT code) {
  char line[96];
  std::snprintf(line, sizeof line, "%s failed: 0x%08lX\n", what, static_cast<unsigned long>(code));
  Write(STD_ERROR_HANDLE, line);
  return kFailed;
}

int Usage(const char* why) {
  Write(STD_ERROR_HANDLE, why);
  Write(STD_ERROR_HANDLE, "\n");
  return kUsage;
}

// Polls instead of blocking so the deadline, the owner window and the dialog's
// focus are checked while the prompt is open. Returns the final status.
template <typename Operation, typename Tick>
AsyncStatus Wait(Operation const& operation, ULONGLONG deadline, Tick&& tick) {
  for (;;) {
    const AsyncStatus status = operation.Status();
    if (status != AsyncStatus::Started) return status;
    if (GetTickCount64() >= deadline || !tick()) {
      operation.Cancel();
      const ULONGLONG settle = GetTickCount64() + kCancelSettleMs;
      while (operation.Status() == AsyncStatus::Started && GetTickCount64() < settle) Sleep(kPollMs);
      return AsyncStatus::Canceled;
    }
    Sleep(kPollMs);
  }
}

template <typename Operation>
int Unfinished(Operation const& operation, AsyncStatus status, const char* what) {
  if (status == AsyncStatus::Error) return Fail(what, static_cast<HRESULT>(operation.ErrorCode()));
  return Fail(what, HRESULT_FROM_WIN32(ERROR_TIMEOUT));
}

winrt::com_ptr<IUserConsentVerifierInterop> Interop() {
  return winrt::get_activation_factory<ui::UserConsentVerifier, IUserConsentVerifierInterop>();
}

struct PromptSearch {
  HWND owner;
  HWND found;
};

// Only a credential dialog owned by Chicory's window is ever brought forward.
BOOL CALLBACK FindPrompt(HWND candidate, LPARAM context) {
  auto* search = reinterpret_cast<PromptSearch*>(context);
  if (GetWindow(candidate, GW_OWNER) != search->owner) return TRUE;
  wchar_t name[64] = {};
  if (GetClassNameW(candidate, name, ARRAYSIZE(name)) == 0 || std::wcscmp(name, kPromptClass) != 0) return TRUE;
  search->found = candidate;
  return FALSE;
}

bool ParseWindow(const wchar_t* text, HWND* window) {
  const size_t length = std::wcslen(text);
  if (length == 0 || length > 20) return false;
  for (size_t i = 0; i < length; ++i) {
    if (text[i] < L'0' || text[i] > L'9') return false;
  }
  wchar_t* end = nullptr;
  errno = 0;
  const unsigned long long value = std::wcstoull(text, &end, 10);
  if (errno != 0 || end != text + length || value == 0) return false;
  const UINT_PTR handle = static_cast<UINT_PTR>(value);
  if (static_cast<unsigned long long>(handle) != value) return false;
  *window = reinterpret_cast<HWND>(handle);
  // Chicory passes its own top-level window. Anything else is refused before
  // any prompt opens.
  return IsWindow(*window) && GetAncestor(*window, GA_ROOT) == *window;
}

bool ValidMessage(const wchar_t* text) {
  const size_t length = std::wcslen(text);
  if (length == 0 || length > kMaxMessage) return false;
  for (size_t i = 0; i < length; ++i) {
    if (text[i] < L' ' || text[i] == 0x7f) return false;
  }
  return true;
}

// The interop interface is what owns the dialog. A system without it offers
// no app lock rather than an unowned prompt.
int Check() {
  const auto operation = ui::UserConsentVerifier::CheckAvailabilityAsync();
  const AsyncStatus status = Wait(operation, GetTickCount64() + kCheckDeadlineMs, [] { return true; });
  if (status != AsyncStatus::Completed) return Unfinished(operation, status, "CheckAvailabilityAsync");
  const auto availability = operation.GetResults();
  if (availability == ui::UserConsentVerifierAvailability::Available) {
    try { Interop(); } catch (winrt::hresult_error const& error) {
      Fail("IUserConsentVerifierInterop", error.code());
      return Answer("InteropUnavailable");
    }
  }
  return Answer(Name(availability));
}

int Verify(HWND window, const wchar_t* message) {
  // No prompt opens unless it can be completed.
  const auto availability = ui::UserConsentVerifier::CheckAvailabilityAsync();
  const AsyncStatus checked = Wait(availability, GetTickCount64() + kCheckDeadlineMs, [] { return true; });
  if (checked != AsyncStatus::Completed) return Unfinished(availability, checked, "CheckAvailabilityAsync");
  if (availability.GetResults() != ui::UserConsentVerifierAvailability::Available) return Answer(Name(availability.GetResults()));

  const winrt::hstring text{ message };
  IAsyncOperation<ui::UserConsentVerificationResult> operation{ nullptr };
  const HRESULT requested = Interop()->RequestVerificationForWindowAsync(window,
    reinterpret_cast<HSTRING>(winrt::get_abi(text)),
    winrt::guid_of<IAsyncOperation<ui::UserConsentVerificationResult>>(), winrt::put_abi(operation));
  if (FAILED(requested)) return Fail("RequestVerificationForWindowAsync", requested);

  const ULONGLONG started = GetTickCount64();
  bool focused = false;
  bool closed = false;
  const AsyncStatus status = Wait(operation, started + kVerifyDeadlineMs, [&] {
    // Chicory quit or its window closed, so nobody is waiting for the answer.
    if (!IsWindow(window)) { closed = true; return false; }
    // Face and fingerprint need the dialog in the foreground. This process was
    // started by Chicory while it was in front, so it may hand focus to the
    // dialog Chicory owns.
    if (!focused && GetTickCount64() - started < kFocusSearchMs) {
      PromptSearch search{ window, nullptr };
      EnumWindows(FindPrompt, reinterpret_cast<LPARAM>(&search));
      if (search.found != nullptr) {
        focused = true;
        if (GetForegroundWindow() != search.found) SetForegroundWindow(search.found);
      }
    }
    return true;
  });
  if (closed) return Fail("Owner window", HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE));
  if (status != AsyncStatus::Completed) return Unfinished(operation, status, "RequestVerificationForWindowAsync");
  return Answer(Name(operation.GetResults()));
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  // A crash fails closed in the main process. It never shows an error dialog.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (argc == 2 && std::wcscmp(argv[1], L"check") == 0) return Check();
    if (argc == 4 && std::wcscmp(argv[1], L"verify") == 0) {
      HWND window = nullptr;
      if (!ParseWindow(argv[2], &window)) return Usage("The window handle is not a top-level window.");
      if (!ValidMessage(argv[3])) return Usage("The message is empty, too long or has control characters.");
      return Verify(window, argv[3]);
    }
    return Usage("Usage: chicory-hello.exe check | verify <window handle> <message>");
  } catch (winrt::hresult_error const& error) {
    return Fail("Windows Hello", error.code());
  } catch (...) {
    return Fail("Windows Hello", E_UNEXPECTED);
  }
}
