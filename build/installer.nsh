; AgentHub 自定义 NSIS 钩子（经 electron-builder nsis.include 注入）
; customCheckAppRunning：更新/卸载前把握着主程序 exe 的进程强杀掉，并等到镜像锁放开。
;
; 为什么不能沿用安装器的默认实现：记忆中枢的 MCP 桥由外部客户端（zcode/codex）以
; ELECTRON_RUN_AS_NODE 方式从安装目录跑 AgentHub.exe，这些常驻进程握着主程序 exe 的
; 镜像锁；默认实现用 tasklist|find 探测 + 非强制 taskkill，会漏杀/杀不干净，残留镜像锁
; 让旧版卸载器的原子重命名失败（Abort 退出码 2 → "Failed to uninstall old application
; files.: 2"）。所以强杀必须是 /F /T 两轮，而且要**杀到没有同名进程为止**，不是一轮了事。
;
; 这里只改等待，不改强杀：
;   * 历史上是固定 Sleep 2000 + Sleep 500。这个宏一次安装要跑好几遍（安装段
;     CHECK_APP_RUNNING 一遍、旧版静默卸载器 un.onInit 又一遍），本机拿「宏整个空掉」
;     的对照包实测多花 5.6~6.3 秒，比搬完 271MB 的归档+解压+拷贝还久。
;   * 反过来，锁超过 2.5 秒才放开的机器上，固定等待又会撞上上面那个 Abort。
; 于是：先强杀，再按**时间**等——主程序写打开重新成功且这样的状态持续满 1 秒才放行
; （给进程终止留时间），总时长封顶 6 秒后照旧放行。有界，绝不无限挂。
;
; 两个 NSIS 坑（都是本机实测出来的，改这段前先看）：
;   1. System::Call 的 i.rN 写的是 **$N，不是 $RN**。所以计时寄存器必须显式 Push/Pop
;      $7 $8，别「顺手」写成 $R7/$R8——那样会静默冲掉调用方的 $8（含探针的计时基准，
;      曾经把「等满 6 秒」读成「0ms 放行」）。
;   2. IntCmp 的三个跳转分支实测是 **等于 / 小于 / 大于**（不是通常记的「小于/大于/等于」）。
;      记反过一次：锁仍在时 elapsed 远小于 6000 却跳进了第二个分支，等于「直接放弃等待」。
;      下面两处 IntCmp 的分支顺序都是照这个实测语义排的，改完请跑
;      node tools/installer-wait-probe.cjs（handle20s 那格专门盯这条）。
; 上限也不能按迭代次数算：每轮迭代含两次 taskkill 进程创建 ≈0.7 秒，早期写成
; 「30 次 × Sleep 200」，实测最坏等了 10.8 秒，比盲等还久。
; 主程序不存在（全新安装）时整段跳过：既没有镜像锁要处理，也不该顺手杀掉别处的同名进程。
!macro customCheckAppRunning
  Push $R6
  Push $7
  Push $8
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 AgentHubProbeDone
  DetailPrint `Closing running AgentHub processes (including MCP bridge)...`
  System::Call 'kernel32::GetTickCount() i.r7'
  AgentHubProbeKill:
    nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    Sleep 300
  AgentHubProbeReprobe:
    ClearErrors
    FileOpen $R6 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    IfErrors 0 AgentHubProbeMaybeFree
    ; 还锁着：再补杀一轮。$8 = 已等毫秒；>=6000 走 Timeout，仍小于 6000 继续杀
    System::Call 'kernel32::GetTickCount() i.r8'
    IntOp $8 $8 - $7
    IntCmp $8 6000 AgentHubProbeTimeout AgentHubProbeKill AgentHubProbeTimeout
  AgentHubProbeMaybeFree:
    ; 写打开又成功了＝锁放开。但必须连续观察到满 1 秒才算数，否则只复探、不补杀
    FileClose $R6
    System::Call 'kernel32::GetTickCount() i.r8'
    IntOp $8 $8 - $7
    IntCmp $8 1000 AgentHubProbeDone AgentHubProbeReprobe AgentHubProbeDone
  AgentHubProbeTimeout:
    DetailPrint `Still locked after about 6s, continuing anyway.`
  AgentHubProbeDone:
    Pop $8
    Pop $7
    Pop $R6
!macroend
