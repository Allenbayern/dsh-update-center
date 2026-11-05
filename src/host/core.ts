/**
 * DSH 本体更新：把「预检 → 备份 → 停服 → 装新版 → 起服 → 健康检查 → 失败回滚」写成一份
 * 自包含脚本，交给**独立的 systemd 瞬态单元**执行。
 *
 * 为什么必须脱离 dsh 自己的 cgroup：`systemctl stop dsh.service` 默认 KillMode=control-group，
 * 会把发起更新的进程一起杀掉。脚本若跑在 dsh 的 cgroup 里，跑到「停服」这一步自己就没了，
 * 结果是一个停着的服务 + 一个永远停在 install 阶段的状态文件。瞬态单元有自己的 cgroup，
 * dsh.service 停了它还在，能把收尾和回滚做完。
 *
 * 状态回读全部走磁盘（result.json），因为更新完成后 dsh 进程已经换了一代，内存态没有意义。
 */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { CoreRunState } from '../shared/types.js'

/** 已经跑完的阶段：只有这两个算终态，其余都还在过程中。 */
const TERMINAL_PHASES = new Set(['done', 'failed'])

/** 一次更新超过这个时长还没终态，就认为脚本已经死了（避免按钮永久锁死）。 */
const STALE_MS = 20 * 60 * 1000

export function isTerminalPhase(phase: string | undefined): boolean {
  return phase !== undefined && TERMINAL_PHASES.has(phase)
}

export function dshHome(): string {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

export function updateCenterHome(): string {
  return join(dshHome(), 'update-center')
}

export function coreRunsDir(): string {
  return join(updateCenterHome(), 'core-runs')
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** 只接受严格的 semver：这个值会被拼进 bash 与 pnpm 命令行。 */
export function isSafeVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?(\+[0-9A-Za-z.]+)?$/.test(version)
}

/** 单个值的 bash 单引号转义。 */
function q(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

export interface CoreUpdateOptions {
  runtimeDir: string
  from: string
  target: string
  registry: string
  serviceName: string
  healthUrl: string
  /** 只跑到预检就收工：不备份、不停服、不安装。用来验证链路而不动系统。 */
  dryRun?: boolean
  /** 停服前留的余量秒数：让面板把「已启动」状态落下来，操作者也有个准备。 */
  graceSeconds?: number
}

export interface LaunchResult {
  ok: boolean
  runId?: string
  runDir?: string
  logPath?: string
  unit?: string
  message: string
}

const WRITE_RESULT_MJS = `import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const phase = process.argv[3] ?? ''
const okRaw = process.argv[4] ?? ''
const message = process.argv[5] ?? ''
const extraRaw = process.argv[6] ?? ''
let meta = {}
try {
  meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
} catch {}
const out = { ...meta, phase, updatedAt: new Date().toISOString() }
if (okRaw === 'true' || okRaw === 'false') out.ok = okRaw === 'true'
if (message !== '') out.message = message
if (extraRaw !== '') {
  try {
    Object.assign(out, JSON.parse(extraRaw))
  } catch {}
}
if (phase === 'done' || phase === 'failed') out.finishedAt = out.updatedAt
writeFileSync(join(dir, 'result.json'), JSON.stringify(out, null, 2))
`

function buildScript(options: CoreUpdateOptions, runDir: string, runId: string, unit: string): string {
  const targetUrl =
    options.registry.replace(/\/+$/, '') +
    '/@deepseek-ai%2Fdsh/' +
    encodeURIComponent(options.target)
  const binPath = [
    join(homedir(), '.local/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':')

  return [
    '#!/bin/bash',
    '# 由 @dsh-external/dsh-update-center 生成：DSH 本体更新（独立瞬态单元执行）',
    '# 每一阶段都往 result.json 落一次状态，面板靠它显示进度；进程被杀也不会留下"假进行中"。',
    'set -uo pipefail',
    'export PATH=' + q(binPath),
    'export HOME=' + q(homedir()),
    'RUN_DIR=' + q(runDir),
    'RESULT="$RUN_DIR/result.json"',
    'LOG="$RUN_DIR/update.log"',
    'RUNTIME=' + q(options.runtimeDir),
    'PKG=' + q('@deepseek-ai/dsh'),
    'TARGET=' + q(options.target),
    'OLD=' + q(options.from),
    'SERVICE=' + q(options.serviceName),
    'HEALTH=' + q(options.healthUrl),
    'TARGET_URL=' + q(targetUrl),
    'DRY_RUN=' + q(options.dryRun === true ? '1' : '0'),
    'GRACE=' + q(String(Math.max(0, Math.floor(options.graceSeconds ?? 10)))),
    'MANIFEST="$RUNTIME/node_modules/@deepseek-ai/dsh/package.json"',
    'exec >>"$LOG" 2>&1',
    '',
    'say() { echo "[$(date \'+%H:%M:%S\')] $*"; }',
    'res() { node "$RUN_DIR/write-result.mjs" "$RUN_DIR" "$1" "${2:-}" "${3:-}" "${4:-}"; }',
    'installed_version() { node -e \'try{process.stdout.write(require(process.argv[1]).version)}catch(e){}\' "$MANIFEST"; }',
    'LAST_STATE=unknown',
    'LAST_CODE=000',
    '# 健康判定：DSH 的根路径要登录，正常也返回 401；只有「连不上(000)」和 5xx 才算没起来。',
    '# 2026-11-03 教训：早先只认 2xx/3xx，把一次成功的更新误判成失败并回滚了。',
    'health_ok() {',
    '  local i',
    '  for i in $(seq 1 45); do',
    '    LAST_STATE=$(systemctl is-active "$SERVICE" 2>/dev/null)',
    '    LAST_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$HEALTH" 2>/dev/null)',
    '    if [ "$LAST_STATE" = "active" ]; then',
    '      case "${LAST_CODE:-000}" in',
    '        2*|3*|401|403) return 0 ;;',
    '      esac',
    '    fi',
    '    sleep 2',
    '  done',
    '  return 1',
    '}',
    '',
    'say "== DSH 本体更新：$OLD -> $TARGET =="',
    'res preflight "" "开始预检"',
    '',
    '# 1. 预检：磁盘余量 + 上游版本可达',
    'free_kb=$(df -Pk "$RUNTIME" 2>/dev/null | awk \'NR==2 {print $4}\')',
    'if [ -z "${free_kb:-}" ] || [ "$free_kb" -lt 2097152 ]; then',
    '  say "预检失败：磁盘可用空间不足 2GB（${free_kb:-0}KB）"',
    '  res failed false "磁盘可用空间不足 2GB"',
    '  exit 1',
    'fi',
    'say "磁盘可用：$((free_kb / 1024)) MB"',
    'if ! curl -fsS --max-time 25 -o /dev/null "$TARGET_URL"; then',
    '  say "预检失败：上游查不到 $TARGET"',
    '  res failed false "上游 registry 查不到 $TARGET（网络或版本号有误）"',
    '  exit 1',
    'fi',
    'say "上游 $TARGET 可达"',
    'if [ "$DRY_RUN" = "1" ]; then',
    '  say "dry-run：预检通过，未备份、未停服、未安装"',
    '  res done true "预检通过（dry-run：未停服、未安装）"',
    '  exit 0',
    'fi',
    '',
    '# 2. 备份',
    'res backup "" "备份 package.json / pnpm-lock.yaml / pnpm-workspace.yaml"',
    'cp -a "$RUNTIME/package.json" "$RUN_DIR/package.json.bak" || true',
    'if [ -f "$RUNTIME/pnpm-lock.yaml" ]; then cp -a "$RUNTIME/pnpm-lock.yaml" "$RUN_DIR/pnpm-lock.yaml.bak" || true; fi',
    '# pnpm 12 会往 workspace 文件里追加 minimumReleaseAgeExclude，必须一起备份',
    'if [ -f "$RUNTIME/pnpm-workspace.yaml" ]; then cp -a "$RUNTIME/pnpm-workspace.yaml" "$RUN_DIR/pnpm-workspace.yaml.bak" || true; fi',
    '',
    '# 3. 停服',
    '# 停服前留余量：面板能先把「更新中」状态和日志落下来，操作者也有个准备。',
    'if [ "$GRACE" -gt 0 ]; then',
    '  say "等待 ${GRACE}s 后停服…"',
    '  sleep "$GRACE"',
    'fi',
    'res stop "" "停止 $SERVICE"',
    'sudo -n systemctl stop "$SERVICE"',
    'for i in $(seq 1 40); do',
    '  state=$(systemctl is-active "$SERVICE" 2>/dev/null)',
    '  if [ "$state" != "active" ] && [ "$state" != "activating" ]; then break; fi',
    '  sleep 1',
    'done',
    'say "服务状态：$(systemctl is-active "$SERVICE" 2>/dev/null)"',
    '',
    '# 4. 安装',
    'res install "" "pnpm add $PKG@$TARGET"',
    'install_ok=1',
    'if ! pnpm --dir "$RUNTIME" add "$PKG@$TARGET" --reporter=append-only; then install_ok=0; fi',
    'got=$(installed_version)',
    'say "磁盘上的版本：${got:-未知}"',
    'if [ "$got" != "$TARGET" ]; then install_ok=0; fi',
    '',
    'rollback() {',
    '  res rollback "" "回滚到 $OLD"',
    '  say "开始回滚：pnpm add $PKG@$OLD"',
    '  pnpm --dir "$RUNTIME" add "$PKG@$OLD" --reporter=append-only || say "回滚安装失败，需要人工介入"',
    '  say "回滚后磁盘版本：$(installed_version)"',
    '  # 必须 restart 而不是 start：失败时服务往往还是 active（跑着新版代码），',
    '  # start 是空操作，进程会继续跑内存里的新版，磁盘却是旧版——两边不一致。',
    '  sudo -n systemctl restart "$SERVICE" || true',
    '  if health_ok; then say "回滚后服务已恢复（state=$LAST_STATE code=$LAST_CODE）"; else say "回滚后服务未恢复健康（state=$LAST_STATE code=$LAST_CODE），需要人工介入"; fi',
    '}',
    '',
    'if [ "$install_ok" -ne 1 ]; then',
    '  say "安装 $TARGET 失败，进入回滚"',
    '  rollback',
    '  res failed false "安装 $TARGET 失败，已回滚到 $OLD" \'{"rolledBack":true}\'',
    '  exit 1',
    'fi',
    '',
    '# 5. 起服 + 健康检查',
    'res start "" "启动 $SERVICE"',
    'sudo -n systemctl start "$SERVICE"',
    'res health "" "等待 $HEALTH 健康检查"',
    'if health_ok; then',
    '  say "健康检查通过（state=$LAST_STATE code=$LAST_CODE）：$TARGET 已生效"',
    '  res done true "已更新到 $TARGET 并重启完成（HTTP $LAST_CODE）"',
    '  exit 0',
    'fi',
    'say "健康检查超时（state=$LAST_STATE code=$LAST_CODE），进入回滚"',
    'say "最近 30 行服务日志："',
    'journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null || true',
    'rollback',
    'res failed false "$TARGET 启动后健康检查超时（state=$LAST_STATE code=$LAST_CODE），已回滚到 $OLD" \'{"rolledBack":true}\'',
    'exit 1',
  ].join('\n')
}

/** 列出所有本体更新 run（新→旧）。 */
export function listCoreRuns(): CoreRunState[] {
  const dir = coreRunsDir()
  if (!existsSync(dir)) return []
  const runs: CoreRunState[] = []
  for (const name of readdirSync(dir).sort().reverse()) {
    const state = readCoreRun(name)
    if (state !== undefined) runs.push(state)
  }
  return runs
}

export function readCoreRun(runId: string): CoreRunState | undefined {
  const runDir = join(coreRunsDir(), runId)
  const result = readJson(join(runDir, 'result.json'))
  const meta = readJson(join(runDir, 'meta.json'))
  if (result === undefined && meta === undefined) return undefined
  const merged: CoreRunState = {
    runId,
    target: String(result?.target ?? meta?.target ?? ''),
    from: result?.from ?? meta?.from,
    phase: String(result?.phase ?? 'launching'),
    startedAt: String(result?.startedAt ?? meta?.startedAt ?? ''),
    ...(result === undefined ? {} : result),
  }
  return merged
}

/** 最近一次更新是不是还在跑（供面板锁按钮）。 */
export function coreUpdateInFlight(run: CoreRunState | undefined): boolean {
  if (run === undefined) return false
  if (isTerminalPhase(run.phase)) return false
  const at = Date.parse(run.updatedAt ?? run.startedAt)
  if (Number.isNaN(at)) return true
  return Date.now() - at < STALE_MS
}

function sudoAvailable(): Promise<boolean> {
  return new Promise<boolean>((done) => {
    execFile('sudo', ['-n', 'true'], { timeout: 5000 }, (error) => done(error === null))
  })
}

function systemdRunAvailable(): Promise<boolean> {
  return new Promise<boolean>((done) => {
    execFile('systemd-run', ['--version'], { timeout: 5000 }, (error) => done(error === null))
  })
}

/**
 * 发射一次本体更新：写脚本 + meta，然后用 `sudo systemd-run` 起一个瞬态单元跑它。
 * 立刻返回，不等更新结束（也等不到——服务会重启）。
 */
export async function launchCoreUpdate(options: CoreUpdateOptions): Promise<LaunchResult> {
  if (!isSafeVersion(options.target) || !isSafeVersion(options.from)) {
    return { ok: false, message: '版本号不合法，拒绝执行' }
  }
  if (!existsSync(join(options.runtimeDir, 'package.json'))) {
    return { ok: false, message: '运行时目录不可用：' + options.runtimeDir }
  }
  if (!(await sudoAvailable())) {
    return { ok: false, message: '需要免密 sudo 才能停起 dsh.service（sudo -n 不可用）' }
  }
  if (!(await systemdRunAvailable())) {
    return { ok: false, message: '找不到 systemd-run，无法把更新放到独立单元里执行' }
  }

  const runId = timestamp()
  const runDir = join(coreRunsDir(), runId)
  mkdirSync(runDir, { recursive: true })
  const unit = 'dsh-core-update-' + runId.toLowerCase().replace(/[^a-z0-9]/g, '')

  const meta = {
    runId,
    target: options.target,
    from: options.from,
    phase: 'launching',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runtimeDir: options.runtimeDir,
    serviceName: options.serviceName,
    healthUrl: options.healthUrl,
    unit,
    dryRun: options.dryRun === true,
    logPath: join(runDir, 'update.log'),
  }
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2))
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ ...meta, phase: 'launching' }, null, 2))
  writeFileSync(join(runDir, 'write-result.mjs'), WRITE_RESULT_MJS)

  const scriptPath = join(runDir, 'update.sh')
  writeFileSync(scriptPath, buildScript(options, runDir, runId, unit))
  chmodSync(scriptPath, 0o755)

  const user = userInfo().username
  const args = [
    '-n',
    'systemd-run',
    '--collect',
    '--quiet',
    '--unit=' + unit,
    '--description=DSH core update ' + options.from + ' -> ' + options.target,
    '--uid=' + user,
    '--setenv=HOME=' + homedir(),
    '--setenv=PATH=' + join(homedir(), '.local/bin') + ':/usr/local/bin:/usr/bin:/bin',
    '--working-directory=' + homedir(),
    '/bin/bash',
    scriptPath,
  ]

  return await new Promise<LaunchResult>((done) => {
    execFile('sudo', args, { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = (String(stderr ?? '') + String(stdout ?? '')).trim().slice(0, 400)
        writeFileSync(
          join(runDir, 'result.json'),
          JSON.stringify(
            { ...meta, phase: 'failed', ok: false, message: '无法启动更新单元：' + (detail === '' ? String(error) : detail), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
            null,
            2,
          ),
        )
        done({
          ok: false,
          runId,
          runDir,
          logPath: meta.logPath,
          message: '无法启动更新单元：' + (detail === '' ? String(error) : detail),
        })
        return
      }
      done({
        ok: true,
        runId,
        runDir,
        logPath: meta.logPath,
        unit,
        message: '已启动更新单元 ' + unit + '（' + options.from + ' → ' + options.target + '）',
      })
    })
  })
}

/** 读某次 run 的日志尾巴（面板展开看）。 */
export function readCoreLog(runId: string, lines = 80): string {
  const path = join(coreRunsDir(), runId, 'update.log')
  if (!existsSync(path)) return ''
  try {
    const all = readFileSync(path, 'utf8').split('\n')
    return all.slice(-lines).join('\n')
  } catch {
    return ''
  }
}

// ── 只重启 dsh.service（不装任何东西） ─────────────────────────────────────
//
// 场景：套件更新返回 `restart-required`（没有 HMR 或包位置变了），装是装好了，
// 但要重启进程才生效。这里复用本体更新那套「独立瞬态单元」机制——不能在 dsh 自己的
// cgroup 里跑，否则 `systemctl restart` 会把自己一起杀掉，重启就断在半路。

export function restartRunsDir(): string {
  return join(updateCenterHome(), 'restart-runs')
}

export interface ServiceRestartOptions {
  serviceName: string
  healthUrl: string
  graceSeconds?: number
}

export function buildRestartScript(options: ServiceRestartOptions, runDir: string): string {
  const binPath = [join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':')
  return [
    '#!/bin/bash',
    '# 由 @dsh-external/dsh-update-center 生成：只重启 dsh.service（独立瞬态单元执行）',
    'set -uo pipefail',
    'export PATH=' + q(binPath),
    'export HOME=' + q(homedir()),
    'RUN_DIR=' + q(runDir),
    'RESULT="$RUN_DIR/result.json"',
    'LOG="$RUN_DIR/restart.log"',
    'SERVICE=' + q(options.serviceName),
    'HEALTH=' + q(options.healthUrl),
    'GRACE=' + q(String(Math.max(0, Math.floor(options.graceSeconds ?? 8)))),
    'exec >>"$LOG" 2>&1',
    '',
    'say() { echo "[$(date \'+%H:%M:%S\')] $*"; }',
    'res() { node "$RUN_DIR/write-result.mjs" "$RUN_DIR" "$1" "${2:-}" "${3:-}" "${4:-}"; }',
    'LAST_STATE=unknown',
    'LAST_CODE=000',
    '# 根路径要登录，正常也回 401；只有连不上(000)与 5xx 才算没起来。',
    'health_ok() {',
    '  local i',
    '  for i in $(seq 1 45); do',
    '    LAST_STATE=$(systemctl is-active "$SERVICE" 2>/dev/null)',
    '    LAST_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$HEALTH" 2>/dev/null)',
    '    if [ "$LAST_STATE" = "active" ]; then',
    '      case "${LAST_CODE:-000}" in',
    '        2*|3*|401|403) return 0 ;;',
    '      esac',
    '    fi',
    '    sleep 2',
    '  done',
    '  return 1',
    '}',
    '',
    'say "== 重启 $SERVICE（grace ${GRACE}s） =="',
    'res restarting "" "等待 ${GRACE}s 后重启 $SERVICE"',
    'sleep "$GRACE"',
    'if ! sudo -n systemctl restart "$SERVICE"; then',
    '  say "systemctl restart 失败"',
    '  res failed false "systemctl restart $SERVICE 失败（需要免密 sudo）"',
    '  exit 1',
    'fi',
    'res health "" "等待 $HEALTH 健康检查"',
    'if health_ok; then',
    '  say "重启完成（state=$LAST_STATE code=$LAST_CODE）"',
    '  res done true "服务已重启并恢复（HTTP $LAST_CODE）"',
    '  exit 0',
    'fi',
    'say "健康检查超时（state=$LAST_STATE code=$LAST_CODE）"',
    'journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null || true',
    'res failed false "重启后健康检查超时（state=$LAST_STATE code=$LAST_CODE）"',
    'exit 1',
  ].join('\n')
}

export async function launchServiceRestart(options: ServiceRestartOptions): Promise<LaunchResult> {
  if (!(await sudoAvailable())) {
    return { ok: false, message: '需要免密 sudo 才能重启 dsh.service（sudo -n 不可用）' }
  }
  if (!(await systemdRunAvailable())) {
    return { ok: false, message: '找不到 systemd-run，无法把重启放到独立单元里执行' }
  }
  const runId = timestamp()
  const runDir = join(restartRunsDir(), runId)
  mkdirSync(runDir, { recursive: true })
  const unit = 'dsh-service-restart-' + runId.toLowerCase().replace(/[^a-z0-9]/g, '')
  const meta = {
    runId,
    phase: 'launching',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceName: options.serviceName,
    healthUrl: options.healthUrl,
    unit,
    logPath: join(runDir, 'restart.log'),
  }
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2))
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(meta, null, 2))
  writeFileSync(join(runDir, 'write-result.mjs'), WRITE_RESULT_MJS)
  const scriptPath = join(runDir, 'restart.sh')
  writeFileSync(scriptPath, buildRestartScript(options, runDir))
  chmodSync(scriptPath, 0o755)

  const args = [
    '-n',
    'systemd-run',
    '--collect',
    '--quiet',
    '--unit=' + unit,
    '--description=DSH service restart',
    '--uid=' + userInfo().username,
    '--setenv=HOME=' + homedir(),
    '--setenv=PATH=' + join(homedir(), '.local/bin') + ':/usr/local/bin:/usr/bin:/bin',
    '--working-directory=' + homedir(),
    '/bin/bash',
    scriptPath,
  ]
  return await new Promise<LaunchResult>((done) => {
    execFile('sudo', args, { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = (String(stderr ?? '') + String(stdout ?? '')).trim().slice(0, 400)
        writeFileSync(
          join(runDir, 'result.json'),
          JSON.stringify(
            { ...meta, phase: 'failed', ok: false, message: '无法启动重启单元：' + (detail === '' ? String(error) : detail), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
            null,
            2,
          ),
        )
        done({ ok: false, runId, runDir, logPath: meta.logPath, message: '无法启动重启单元：' + (detail === '' ? String(error) : detail) })
        return
      }
      done({ ok: true, runId, runDir, logPath: meta.logPath, unit, message: '已启动重启单元 ' + unit })
    })
  })
}

export function readRestartRun(runId: string): Record<string, any> | undefined {
  const runDir = join(restartRunsDir(), runId)
  const result = readJson(join(runDir, 'result.json'))
  const meta = readJson(join(runDir, 'meta.json'))
  if (result === undefined && meta === undefined) return undefined
  return { runId, ...meta, ...result }
}

export function listRestartRuns(): Record<string, any>[] {
  const dir = restartRunsDir()
  if (!existsSync(dir)) return []
  const runs: Record<string, any>[] = []
  for (const name of readdirSync(dir).sort().reverse()) {
    const run = readRestartRun(name)
    if (run !== undefined) runs.push(run)
  }
  return runs
}

export function readRestartLog(runId: string, lines = 80): string {
  const path = join(restartRunsDir(), runId, 'restart.log')
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}
