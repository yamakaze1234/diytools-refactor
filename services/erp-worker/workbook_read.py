"""以共享只读句柄获取工作簿快照，不改变正在编辑的文件。"""

import os


def _open_readonly(path):
    if os.name != "nt":
        return path.open("rb")

    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    create.restype = wintypes.HANDLE
    # GENERIC_READ + 读、写、删除共享，可在 Excel 保存替换文件时继续读原句柄。
    handle = create(str(path), 0x80000000, 0x07, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except BaseException:
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(handle)
        raise
    return os.fdopen(fd, "rb")


def read_workbook_bytes(path, max_mib):
    # 解析和指纹使用同一次读取的字节；解析后由调用方回读摘要验证版本。
    limit = max_mib * 1024 * 1024
    with _open_readonly(path) as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            raise ValueError(f"工作簿超过 {max_mib} MiB 限制")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"工作簿超过 {max_mib} MiB 限制")
    return data
