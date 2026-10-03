// 安装器「等主程序解锁」行为探针（需要本机跑过一次打包，NSIS 缓存已在）。
//
// 为什么要有这个：build/installer.nsh 的 customCheckAppRunning 曾经是固定
// Sleep 2000 + Sleep 500，而这个宏一次安装要跑好几遍（安装段一遍、旧版静默卸载器
// un.onInit 一遍）。本机拿「宏整个空掉」的对照包实测：固定盲等多花 5.6~6.3 秒，
// 比搬完 271MB 的归档+解压+拷贝还久；而锁超过 2.5 秒才放的机器上，固定等待又会撞上
// "Failed to uninstall old application files.: 2"。
//
// 四把尺子（少一把都能藏住问题）：
//   全新安装（主程序不存在）              → 整段跳过，<300ms
//   主程序在、没人锁（重装常态）          → 杀完等到「放开观察满 1 秒」即走：600~2200ms
//   镜像锁（进程真在跑）                  → 强杀到放开，随后 Rename 必须成功
//   独占句柄锁 20 秒（杀不掉的那类）      → 必须按 6 秒上限放行，Rename 失败但不挂死
// 外加一份「退回盲等」的变异对照，必须被第三条尺子抓红。
//
// ⚠ 计时用的寄存器：System::Call 的 i.rN 写的是 $N（不是 $RN）。本探针用 $8/$9，
// 所以被测宏必须自己保存/恢复 $7/$8——早先宏用 i.r7/i.r8 配 $R7/$R8，把这里的基准
// 冲成 0，「等满上限」被读成「0ms 放行」，据此得出的结论全是假信号。
//
// 安全边界：APP_EXECUTABLE_FILENAME 被 define 成 ahprobe.exe，宏里那句
// taskkill /F /T /IM 只命中本探针自造的假进程（cmd.exe 的副本），不可能打到用户
// 正在用的 AgentHub 或以 AgentHub.exe 常驻的 MCP 桥。
//
// 用法：node tools/installer-wait-probe.cjs [被测 .nsh 路径]
//   （要横向比较候选实现时，把候选文件路径传进来各跑一次）
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = 'ahprobe.exe';
const ROOT = path.join(os.tmpdir(), `agenthub-installer-wait-${process.pid}`);
const REPO = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || path.join(REPO, 'build', 'installer.nsh');
const NL = '$' + String.fromCharCode(92) + 'r$' + String.fromCharCode(92) + 'n';
const CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findMakensis() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis');
  if (!fs.existsSync(base)) return null;
  const vers = fs.readdirSync(base).filter((d) => /^nsis-\d/.test(d)).sort();
  for (let i = vers.length - 1; i >= 0; i--) {
    const exe = path.join(base, vers[i], 'makensis.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

const NSIS = findMakensis();
if (!NSIS) {
  console.error('RED: 找不到 makensis（NSIS 缓存未生成）。先跑一次 npm run electron:build 再执行本探针。');
  process.exit(1);
}

// 变异对照：历史上真用过的固定盲等
const MUTANT_SLEEP = `!macro customCheckAppRunning
  IfFileExists "$INSTDIR\\${EXE}" 0 Done
  nsExec::Exec \`taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}"\`
  Pop $0
  Sleep 2000
  nsExec::Exec \`taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}"\`
  Pop $0
  Sleep 500
  Done:
!macroend
`;

const SC = {
  noexe: { id: 'noexe', desc: '主程序不存在（全新安装）' },
  idle: { id: 'idle', desc: '主程序在、没人锁（重装常态）' },
  running: { id: 'running', run: true, desc: '镜像锁：假进程真在跑' },
  handle20s: { id: 'handle20s', lock: 20000, desc: '独占句柄握 20s：taskkill 杀不掉' },
};

function nsiText(nsh, instdir, outFile, resultFile) {
  return [
    'Name "ahprobe"',
    `OutFile "${outFile}"`,
    `InstallDir "${instdir}"`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    `!define APP_EXECUTABLE_FILENAME "${EXE}"`,
    `!include "${nsh}"`,
    'Section',
    `  FileOpen $6 "${resultFile}" w`,
    // 计时用 $8/$9（$6 是结果文件句柄）。被测宏若不动 $8/$9 就能对上。
    "  System::Call 'kernel32::GetTickCount() i.r9'",
    '  StrCpy $8 $9',
    '  !insertmacro customCheckAppRunning',
    "  System::Call 'kernel32::GetTickCount() i.r9'",
    '  IntOp $9 $9 - $8',
    `  FileWrite $6 "MACRO_MS=$9${NL}"`,
    // 宏放行后安装段紧接着要做的动作：改名主程序（旧版卸载器靠原子 rename 换文件）
    '  ClearErrors',
    `  Rename "$INSTDIR\\${EXE}" "$INSTDIR\\${EXE}.renamed"`,
    '  IfErrors renameFail renameOk',
    '  renameFail:',
    `  FileWrite $6 "RENAME=FAIL${NL}"`,
    '  Goto renameDone',
    '  renameOk:',
    `  FileWrite $6 "RENAME=OK${NL}"`,
    '  Goto renameDone',
    '  renameDone:',
    '  FileClose $6',
    'SectionEnd',
    '',
  ].join('\r\n');
}

function bomCopy(text, tag) {
  const dst = path.join(ROOT, `inc-${tag}.nsh`);
  // NSIS 3 要求含非 ASCII 的脚本带 UTF-8 BOM；加 BOM 后宏体逐字节不变
  fs.writeFileSync(dst, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
  return dst;
}

function compile(inc, instdir, outFile, resultFile) {
  const script = path.join(ROOT, 'probe.nsi');
  fs.writeFileSync(script, nsiText(inc, instdir, outFile, resultFile));
  const out = execFileSync(NSIS, ['-V2', script], { encoding: 'utf8' });
  if (/error/i.test(out)) throw new Error('makensis 编译失败：\n' + out);
}

async function arm(scenario, instdir) {
  fs.rmSync(instdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(instdir, { recursive: true });
  if (scenario.id === 'noexe') return null;
  const exe = path.join(instdir, EXE);
  fs.copyFileSync(CMD, exe);
  if (scenario.run) {
    const p = spawn(exe, ['/c', 'ping -n 90 127.0.0.1'], { stdio: 'ignore', detached: true });
    p.unref();
    await sleep(600);
    // 真空判定用 tasklist：NSIS 的 FileOpen 'a' 与 node 的 'a' 申请的访问位不同，
    // 拿写打开当「进程在不在」的复核会自相矛盾。
    const listing = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    if (!listing.toLowerCase().includes(EXE.toLowerCase())) throw new Error(`场景 running 无效：tasklist 里没有 ${EXE}`);
    return null;
  }
  const marker = path.join(instdir, 'lock.marker');
  const q = (s) => "'" + s.replace(/'/g, "''") + "'";
  const ps = [
    `$f=[System.IO.File]::Open(${q(exe)},'Open','Write','Read')`,
    `Set-Content -NoNewline -Path ${q(marker)} -Value locked`,
    `Start-Sleep -Milliseconds ${scenario.lock}`,
    '$f.Close()',
  ].join('; ');
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await sleep(50);
    try {
      if (fs.readFileSync(marker, 'utf8').trim() === 'locked') break;
    } catch {}
  }
  if (Date.now() - t0 >= 15000) throw new Error(`场景 ${scenario.id} 无效：句柄未建立。${err}`);
  // 复核锁真在：node 以 r+ 打开必须失败（这个原语上 node 与 NSIS 结论一致）
  try {
    const h = fs.openSync(exe, 'r+');
    fs.closeSync(h);
    throw new Error(`场景 ${scenario.id} 无效：arm 时文件仍可写打开`);
  } catch (e) {
    if (String(e.message).includes('无效')) throw e;
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw new Error(`arm 复核异常 ${e.code}`);
  }
  return p;
}

function parse(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(\d+|\w+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function runVariant(tag, text) {
  const inc = bomCopy(text, tag);
  const outFile = path.join(ROOT, `probe-${tag}.exe`);
  const resultFile = path.join(ROOT, `result-${tag}.txt`);
  const res = {};
  for (const sc of Object.values(SC)) {
    const instdir = path.join(ROOT, `inst-${tag}-${sc.id}`);
    compile(inc, instdir, outFile, resultFile);
    const holder = await arm(sc, instdir);
    fs.writeFileSync(resultFile, '');
    execFileSync(outFile, ['/S'], { stdio: 'ignore' });
    const r = parse(resultFile);
    res[sc.id] = { ms: Number(r.MACRO_MS), rename: r.RENAME };
    console.log(`  [${tag}] ${sc.id.padEnd(10)} macro=${String(r.MACRO_MS).padStart(5)}ms  rename=${r.RENAME}  ${sc.desc}`);
    // 收尾按 pid 精确杀自己造的锁，绝不高举宽杀
    if (holder) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(holder.pid)], { stdio: 'ignore' });
      } catch {}
    }
    try {
      execFileSync('taskkill', ['/F', '/T', '/IM', EXE], { stdio: 'ignore' });
    } catch {}
    await sleep(300);
  }
  return res;
}

const WINDOW = {
  noexe: [0, 300],
  idle: [600, 2200],
  running: [600, 2600],
  handle20s: [5500, 9000],
};
const inWin = (r, k) => !!r[k] && r[k].ms >= WINDOW[k][0] && r[k].ms <= WINDOW[k][1];

const checks = [];
function expect(name, ok, detail) {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'RED '} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  let crash = 0;
  try {
    console.log(`makensis: ${NSIS}\n被测: ${TARGET}\n`);
    const real = await runVariant('target', fs.readFileSync(TARGET, 'utf8'));
    const mut = await runVariant('mut-sleep', MUTANT_SLEEP);
    console.log('');
    expect('全新安装即刻跳过 (<300ms)', inWin(real, 'noexe'), `${real.noexe.ms}ms`);
    expect('没人锁时杀完即走 (600~2200ms) 且能改名', inWin(real, 'idle') && real.idle.rename === 'OK', `${real.idle.ms}ms ${real.idle.rename}`);
    expect('镜像锁杀到放开 (≤2600ms) 且能改名', inWin(real, 'running') && real.running.rename === 'OK', `${real.running.ms}ms ${real.running.rename}`);
    expect(
      '杀不掉的锁按 6s 上限放行、不挂死',
      inWin(real, 'handle20s') && real.handle20s.rename === 'FAIL',
      `${real.handle20s.ms}ms ${real.handle20s.rename}`,
    );
    expect('对照：退回固定盲等会被「没人锁时杀完即走」抓红', !inWin(mut, 'idle'), `idle=${mut.idle.ms}ms`);
  } catch (e) {
    console.error('探针自身异常：' + (e.stack || e.message));
    crash = 1;
  } finally {
    try {
      execFileSync('taskkill', ['/F', '/T', '/IM', EXE], { stdio: 'ignore' });
    } catch {}
    await sleep(500);
    try {
      fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
    } catch (e) {
      console.log(`（收尾未净 ${ROOT}: ${e.code}，可手工删除）`);
    }
  }
  const bad = crash + checks.filter((v) => !v).length;
  console.log(bad ? `\nRED: ${bad} 项不成立` : `\nGREEN: ${checks.length} 项全成立`);
  process.exit(bad ? 1 : 0);
})();
