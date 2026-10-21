# Windows 桌面 Agent 启动入口

桌面快捷方式通过系统 `wscript.exe` 执行 `start-workbench-agent.vbs`，由 VBS 以隐藏方式创建 PowerShell 7 进程。直接将快捷方式指向 `pwsh.exe -WindowStyle Hidden` 时，控制台可能在 PowerShell 应用隐藏设置前短暂出现。

在 PowerShell 7 中执行 `tools/install-agent-desktop-launcher.ps1`，传入现有安装目录、桌面快捷方式和一个尚不存在的备份目录。`PowerShellPath` 默认使用运行安装脚本的 PowerShell 7 路径，也可显式指定。安装脚本仅复制两个启动脚本、更新现有快捷方式，并保存原快捷方式、原启动脚本、快捷方式元数据及工作台 EXE 摘要；不会启动或停止工作台。

启动脚本按安装目录复用唯一已运行实例；没有实例时设置 `DIYTOOLS_AGENT_ENABLED=1` 再启动工作台。它更新安装目录的 `agent-connection.json`，保留现有 Agent 连接约定。重复实例或启动失败返回非零码；VBS 显示错误提示，详细异常保存在安装目录 `agent-launch-error.log`。日志属于失败时的最近记录，应结合时间查看。此入口依赖系统 Windows Script Host 和安装时指定的 PowerShell 7 路径。

验收时双击桌面快捷方式，检查是否仍出现终端、工作台是否复用、连接文件 PID 是否与当前实例一致；通过 Agent `doctor` 核对连接。程序未运行时的启动与 Agent 启用应另行验收，不能仅凭已有实例复用宣称通过。

回滚时将备份目录中的 `original-shortcut.lnk` 复制回原桌面快捷方式路径，将原 `start-workbench-agent.ps1` 复制回安装目录。新增 VBS 可保留；若需移除，按项目约定放入回收站。无需替换 EXE 或操作业务数据。
