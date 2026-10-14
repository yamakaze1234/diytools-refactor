# 将 SQL 连接凭据交给当前 Windows 用户的 DPAPI 加密保存；文件位置由宿主指定，不接受业务请求改写。
"""Machine-local, current-user Windows DPAPI vault. No legacy member import."""

import base64
import ctypes
import json
import os
import tempfile
import threading
from ctypes import wintypes
from pathlib import Path

from sql_service import SqlError, settings

ENTROPY = b"DIYTools:SQL:machine-local:current-user:v1"
PROTECTION = "windows-dpapi-current-user-v1"
_lock = threading.RLock()


# 对应 Windows DATA_BLOB 的内存布局，供 DPAPI 读写二进制缓冲区。
class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


# 使用固定用途熵和当前用户保护范围；Windows 分配的输出缓冲区必须在 finally 中释放。
def dpapi(data, *, encrypt=False):
    if os.name != "nt":
        raise SqlError("本机加密连接仅支持 Windows", "SQL_CREDENTIALS_UNAVAILABLE")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt32.CryptProtectData if encrypt else crypt32.CryptUnprotectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob),
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buffer, entropy_buffer = ctypes.create_string_buffer(data), ctypes.create_string_buffer(ENTROPY)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    entropy = Blob(len(ENTROPY), ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    if not function(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(output)):
        raise SqlError("Windows 本机凭据保护失败", "SQL_CREDENTIALS_FAILED")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel32.LocalFree(output.data)


# 只认可宿主环境给出的绝对路径，避免来自界面的请求选择任意凭据文件。
def _path():
    value = os.environ.get("DIYTOOLS_SQL_VAULT")
    if not value or not Path(value).is_absolute():
        raise SqlError("本机连接保存位置未配置", "SQL_CREDENTIALS_UNAVAILABLE")
    return Path(value)


# 先落盘加密信封或清除标记，再原子替换正式文件；中途失败保留旧凭据。
def _atomic_write(path, envelope):
    """Only replace after DPAPI/envelope are ready; failures preserve prior file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".pending", dir=path.parent)
    # A pending file contains only encrypted data or a tombstone, never plaintext.
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(envelope, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)


# 限制文件大小并检查信封版本及保护范围，损坏或解密失败统一要求重新填写。
def load():
    with _lock:
        path = _path()
        try:
            if not path.exists():
                return {"saved": False, "settings": None, "password": ""}
            if path.stat().st_size > 65536:
                raise ValueError()
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if envelope.get("version") != 1 or envelope.get("scope") != "machine-local" or type(envelope.get("saved")) is not bool:
                raise ValueError()
            if not envelope["saved"]:
                if set(envelope) != {"version", "scope", "saved"}:
                    raise ValueError()
                return {"saved": False, "settings": None, "password": ""}
            if envelope.get("protection") != PROTECTION:
                raise ValueError()
            plain = dpapi(base64.b64decode(envelope["ciphertext"], validate=True))
            value = json.loads(plain)
            if value.get("version") != 1 or value.get("scope") != "machine-local":
                raise ValueError()
            password = value.get("password")
            if not isinstance(password, str) or not 0 < len(password) <= 1024:
                raise ValueError()
            return {"saved": True, "settings": settings(value["settings"]), "password": password}
        except Exception:
            raise SqlError("无法读取本机加密连接，请重新填写或清除保存", "SQL_CREDENTIALS_FAILED") from None


# 先校验连接参数，再在锁内加密和替换；明文密码不会写入临时文件。
def save(config, password):
    config = settings(config)
    if not isinstance(password, str) or not 0 < len(password) <= 1024:
        raise SqlError("请输入数据库密码", "INVALID_REQUEST")
    with _lock:
        path = _path()
        try:
            value = {"version": 1, "scope": "machine-local", "settings": config, "password": password}
            encrypted = dpapi(json.dumps(value, ensure_ascii=False).encode("utf-8"), encrypt=True)
            _atomic_write(path, {"version": 1, "scope": "machine-local", "saved": True,
                                 "protection": PROTECTION, "ciphertext": base64.b64encode(encrypted).decode("ascii")})
        except Exception:
            raise SqlError("本机连接保存失败，原保存未改动", "SQL_CREDENTIALS_FAILED") from None


# 写入不含密文的未保存标记，保持与保存相同的原子替换和失败保留语义。
def clear():
    with _lock:
        path = _path()
        try:
            _atomic_write(path, {"version": 1, "scope": "machine-local", "saved": False})
        except Exception:
            raise SqlError("清除本机连接失败，原保存未改动", "SQL_CREDENTIALS_FAILED") from None
    return {"saved": False}
