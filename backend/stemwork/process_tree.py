"""Windows cleanup for the child tree owned by one Popen invocation.

Native handles avoid dependence on taskkill's broader process-enumeration
permissions. No privilege changes, executable-name matching, or service-wide
process termination are used.
"""

from __future__ import annotations

import subprocess
import time


def terminate_windows_process_tree(root: subprocess.Popen, timeout: float = 3) -> None:
    """Snapshot descendants, terminate children before the root, then wait.

    The root Popen owns its existing handle. This function closes only snapshot
    and descendant handles that it opens. A failed descendant cleanup is an
    error, never a successful cancellation of only the venv redirector.
    """
    import ctypes
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32FirstW.restype = wintypes.BOOL
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    children: dict[int, list[int]] = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(ProcessEntry)
        found = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        if not found and ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ctypes.WinError(ctypes.get_last_error())
        while found:
            children.setdefault(entry.th32ParentProcessID, []).append(entry.th32ProcessID)
            found = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(snapshot)

    descendants = []
    seen = {root.pid}
    pending = [root.pid]
    while pending:
        parent = pending.pop(0)
        for pid in children.get(parent, []):
            if pid not in seen:
                seen.add(pid)
                descendants.append(pid)
                pending.append(pid)

    handles = []
    errors = []
    try:
        for pid in descendants:
            handle = kernel.OpenProcess(0x00100001, False, pid)  # SYNCHRONIZE | PROCESS_TERMINATE
            if handle:
                handles.append((pid, handle))
            else:
                error = ctypes.get_last_error()
                if error != 87:  # ERROR_INVALID_PARAMETER: process already exited.
                    errors.append(f"PID {pid}: {ctypes.WinError(error)}")
        # Preserve the parent chain until the full tree has been collected.
        for pid, handle in reversed(handles):
            if kernel.WaitForSingleObject(handle, 0) == 258:  # WAIT_TIMEOUT: alive
                if not kernel.TerminateProcess(handle, 1):
                    error = ctypes.get_last_error()
                    if kernel.WaitForSingleObject(handle, 0) != 0:
                        errors.append(f"PID {pid}: {ctypes.WinError(error)}")
        if root.poll() is None:
            root.kill()
        deadline = time.monotonic() + timeout
        for pid, handle in reversed(handles):
            remaining_ms = max(0, round((deadline - time.monotonic()) * 1000))
            result = kernel.WaitForSingleObject(handle, remaining_ms)
            if result != 0:
                errors.append(f"PID {pid} did not exit (wait result {result})")
        root.wait(timeout=max(0.001, deadline - time.monotonic()))
    finally:
        for _, handle in handles:
            kernel.CloseHandle(handle)
    if errors:
        raise OSError("; ".join(errors))
