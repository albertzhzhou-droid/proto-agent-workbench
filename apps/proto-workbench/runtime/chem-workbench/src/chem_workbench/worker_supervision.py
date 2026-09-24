"""Windows suspended-process resume and bounded pipe capture helpers."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from threading import Event
from typing import BinaryIO


def resume_suspended_process(pid: int) -> None:
    """Resume the sole initial thread only after its process joined the job."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class ThreadEntry(ctypes.Structure):
        _fields_ = [
            ("size", wintypes.DWORD),
            ("usage", wintypes.DWORD),
            ("thread_id", wintypes.DWORD),
            ("owner", wintypes.DWORD),
            ("base_priority", wintypes.LONG),
            ("delta_priority", wintypes.LONG),
            ("flags", wintypes.DWORD),
        ]

    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(4, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise OSError("JOB_OBJECT_FAILED: thread snapshot failed")
    thread_ids = []
    try:
        entry = ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        available = kernel.Thread32First(snapshot, ctypes.byref(entry))
        while available:
            if entry.owner == pid:
                thread_ids.append(entry.thread_id)
            available = kernel.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    if len(thread_ids) != 1:
        raise OSError("JOB_OBJECT_FAILED: expected one suspended initial thread")
    thread = kernel.OpenThread(2, False, thread_ids[0])
    if not thread:
        raise OSError("JOB_OBJECT_FAILED: cannot open suspended thread")
    try:
        if kernel.ResumeThread(thread) != 1:
            raise OSError("JOB_OBJECT_FAILED: unexpected suspend count")
    finally:
        kernel.CloseHandle(thread)


def capture_pipe(stream: BinaryIO, buffer: bytearray, limit: int, exceeded: Event) -> None:
    try:
        while chunk := stream.read(4096):
            remaining = limit - len(buffer)
            buffer.extend(chunk[:remaining])
            if len(chunk) > remaining:
                exceeded.set()
    finally:
        stream.close()
