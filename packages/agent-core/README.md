# diytools-agent-core

桌面 Agent 的独立 Rust 协议与本地传输库。无数据库、任意 SQL、TCP 或自动实例发现能力。

`instance_for_pid(pid)` 返回 `desktop-PID`。调用方必须显式提供实例名称。
`transport::serve(instance, handler)` 同步创建管道，返回的 `ServerHandle` 负责后台服务生命周期；
`transport::call(instance, &request)` 同步调用并核验响应版本和 requestId。

Windows 管道名称包含当前用户 SID，显式 ACL 只允许该用户与 SYSTEM，拒绝远程连接。
帧采用 4 字节 little-endian 长度加 UTF-8 JSON，JSON 最大 1MiB；请求整体时限 5 秒，
读写与连接等待均可在服务退出时中断。每个实例同时处理一个连接。

业务回调在单独线程顺序执行；Drop 不等待已开始的回调，回调需自行限制业务操作耗时。
已过期或服务关闭后的排队请求不会补执行。非 Windows 调用返回 `UNSUPPORTED_PLATFORM`。

验证：`cargo test --manifest-path packages/agent-core/Cargo.toml`。
