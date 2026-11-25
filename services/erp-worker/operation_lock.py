"""本机 ERP 操作互斥：库存、成本读取与套餐匹配共用同一操作锁。"""
import os
from pathlib import Path


class OperationBusy(Exception):
    pass


class OperationLock:
    def __init__(self, root):
        self.root, self.stream = Path(root), None

    def __enter__(self):
        self.root.mkdir(parents=True, exist_ok=True)
        # 锁文件长期保留，互斥由操作系统持有，进程退出后自动释放，不能以文件存在判断忙碌。
        self.stream = (self.root / 'operation.lock').open('a+b')
        try:
            if os.fstat(self.stream.fileno()).st_size == 0:
                self.stream.write(b'0')
                self.stream.flush()
            self.stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            self.stream = None
            raise OperationBusy('ERP 正在同步库存、读取成本或匹配套餐，请等待当前操作结束。') from None
        return self

    def __exit__(self, *_):
        if self.stream:
            self.stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            self.stream.close()
