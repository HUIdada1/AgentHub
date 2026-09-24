; AgentHub 自定义 NSIS 钩子（经 electron-builder nsis.include 注入）
; customCheckAppRunning：更新/卸载前强杀全部 AgentHub.exe（含 /T 进程树）。
; 背景：记忆仓库的 MCP 桥由外部客户端（zcode/codex）以 ELECTRON_RUN_AS_NODE 方式
; 从安装目录跑 AgentHub.exe，这些常驻进程握着主程序 exe 的镜像锁；默认实现用
; tasklist|find 探测 + 非强制 taskkill，会漏杀/杀不干净，残留镜像锁让旧版卸载器的
; 原子重命名失败（Abort 退出码 2 → "Failed to uninstall old application files.: 2"）。
; 改为无条件强杀两轮并等待：探测环节整个去掉，杀不存在的进程只是 taskkill 报错，无害。
!macro customCheckAppRunning
  DetailPrint `Closing running AgentHub processes (including MCP bridge)...`
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 2000
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 500
!macroend
