/**
 * @dsh-external/dsh-update-center — 宿主半边。
 *
 * 一张跨会话复用的更新总览：DSH 本体 / 已装插件（npm·link·git·tarball）/ 套件与注入插件 /
 * 本机环境。扫描全部只读；写入路径有三条，都带护栏：
 *   1. 单个套件：pluginManager.updateBundle（官方热更新，不重启）；
 *   2. 一键更新所有插件：BatchRunner 串行跑同一路径，可中途叫停；
 *   3. 一键更新 DSH 本体：写一份自包含脚本交给**独立 systemd 瞬态单元**执行
 *      （备份 → 停服 → 安装 → 起服 → 健康检查 → 失败自动回滚），因为重启 dsh.service
 *      会连坐杀掉发起更新的进程，脚本必须活在自己的 cgroup 里。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApplyResult, BatchChannel, ConvertResult, LogEntry, ReminderState, Snapshot } from './shared/types.js'
import { scan } from './host/scan.js'
import { convertToRegistry } from './host/convert.js'
import { compareVersions } from './host/semver.js'
import { BatchRunner, type BatchPlanItem } from './host/batch.js'
import {
  coreUpdateInFlight,
  isSafeVersion,
  launchCoreUpdate,
  launchServiceRestart,
  listCoreRuns,
  listRestartRuns,
  readCoreLog,
  readCoreRun,
  readRestartLog,
  readRestartRun,
} from './host/core.js'
import {
  addPendingRestart,
  clearPendingRestart,
  readPendingRestart,
  readSnapshotCache,
  settlePendingRestart,
  writeSnapshotCache,
} from './host/state.js'
import { appendHistory, readHistory } from './host/history.js'
import { reminderFrom } from './host/reminder.js'
import {
  scanInfra,
  updateDockerContainer,
  updateSafeApt,
  updateToolchainItem,
  updateProjectVenv,
} from './host/infra.js'

export const name = '@dsh-external/dsh-update-center'
export const inject: string[] = []

export interface Config {
  /** 查询上游用的 registry。 */
  registry: string
  /** 快照缓存秒数；0 表示每次重扫。 */
  cacheSeconds: number
  /** 单个网络 / 命令探测的超时。 */
  timeoutMs: number
  /** 本体更新时停起的 systemd 单元名。 */
  serviceName: string
  /** 本体更新后的健康检查地址。 */
  healthUrl: string
  /** 是否允许面板执行本体更新（含重启）；关掉就只读。 */
  allowCoreUpdate: boolean
  /** 是否允许面板一键重启 dsh.service（用于让「需重启」的更新生效）。 */
  allowServiceRestart: boolean
  /** 一键重启前的余量秒数（让面板把状态落下来）。 */
  restartGraceSeconds: number
  /** 停服前留的余量秒数（让面板把状态落下来，避免刚点完就断线）。 */
  coreGraceSeconds: number
  /** 后台预热扫描间隔秒数；0 = 只在面板打开时按需扫描。 */
  backgroundRefreshSeconds: number
  /** 侧栏提醒触发后台刷新的最小间隔秒数（比面板缓存长得多，避免角标把扫描打成高频）。 */
  reminderRefreshSeconds: number
  /** 批量更新时一项失败是否立即停。 */
  batchStopOnError: boolean
  /** 连续失败多少项就自动收手（防 registry 断网时白等）。 */
  batchAbortAfterConsecutiveFailures: number
  /** 永不批量更新的包名（人工 pin）。 */
  pinned: string[]
  /** 更新历史保留条数。 */
  historyLimit: number
}

export const Config = z.object({
  registry: z.string().default('https://registry.npmjs.org'),
  cacheSeconds: z.number().min(0).default(120),
  timeoutMs: z.number().min(1000).default(8000),
  serviceName: z.string().default('dsh.service'),
  healthUrl: z.string().default('http://127.0.0.1:3080/'),
  allowCoreUpdate: z.boolean().default(true),
  allowServiceRestart: z.boolean().default(true),
  restartGraceSeconds: z.number().min(0).default(8),
  coreGraceSeconds: z.number().min(0).default(10),
  backgroundRefreshSeconds: z.number().min(0).default(0),
  reminderRefreshSeconds: z.number().min(60).default(900),
  batchStopOnError: z.boolean().default(false),
  batchAbortAfterConsecutiveFailures: z.number().min(1).default(3),
  pinned: z.array(z.string()).default([]),
  historyLimit: z.number().min(20).default(400),
})

const API = '/api/dsh-update-center'
const LOG_LIMIT = 400

interface Logger {
  info?: (message: string, ...rest: unknown[]) => void
  warn?: (message: string, ...rest: unknown[]) => void
}

function json(res: any, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req: any, limit = 64 * 1024): Promise<any> {
  let text = ''
  let size = 0
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    size += Buffer.byteLength(piece)
    if (size > limit) throw new Error('body-too-large')
    text += piece
  }
  if (text === '') return {}
  return JSON.parse(text)
}

/** 服务就绪后再跑回调：声明式等 webServer / tools 出现，不依赖启动顺序。 */
function whenReady(ctx: Context, services: string[], run: (owner: any) => (() => void) | void): () => void {
  const injectFn = (ctx as any).inject
  if (typeof injectFn === 'function') {
    const dispose = injectFn.call(ctx, services, (owner: any) => run(owner))
    return () => {
      try {
        dispose?.()
      } catch {
        /* 已释放 */
      }
    }
  }
  const owner = ctx as any
  const dispose = owner.effect(() => {
    const missing = services.filter((key) => owner.get(key) === undefined)
    if (missing.length > 0) return
    return run(owner)
  }, 'dsh-update-center: ' + services.join(','))
  return () => {
    try {
      dispose?.()
    } catch {
      /* 已释放 */
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = (ctx as any).logger as Logger | undefined
  const disposers: (() => void)[] = []
  const logs: LogEntry[] = []
  let logSeq = 0
  let cached: { at: number; snapshot: Snapshot } | undefined
  /** 后台刷新（单飞）：面板打开时旧数据先上屏，这份 Promise 在背后把新数据补上。 */
  let refreshing: Promise<Snapshot | undefined> | undefined
  /** 全局执行锁：防止用户在某项更新进行中并发点击其它更新按钮导致状态覆盖或冲突。 */
  let activeOperation: { key: string; label: string; startedAt: number } | null = null

  /** 单项更新或转线上成功后，立即原地更新缓存快照中的对应条目状态，避免下次读取返回旧的“可更新”状态。 */
  const markBundleUpdatedInCache = (targetName: string, toVersion: string, convertedToRegistry = false): void => {
    if (cached === undefined) return
    const nextBundles = cached.snapshot.bundles.map((row) => {
      if (row.name !== targetName) return row
      const nextSource = convertedToRegistry ? 'registry' : row.source
      const stillHasPreview =
        row.preview !== undefined && compareVersions(row.preview.version, toVersion) > 0
      return {
        ...row,
        installed: toVersion,
        source: nextSource,
        updatable: true,
        status: stillHasPreview ? ('preview-only' as const) : ('latest' as const),
      }
    })
    const stableUpdates = nextBundles.filter((b) => b.status === 'update').length
    const previewUpdates = nextBundles.filter((b) => b.status === 'update' || b.status === 'preview-only').length
    const nextSnapshot: Snapshot = {
      ...cached.snapshot,
      bundles: nextBundles,
      summary: {
        ...cached.snapshot.summary,
        stableUpdates,
        previewUpdates,
      },
    }
    cached = { at: Date.now(), snapshot: nextSnapshot }
    writeSnapshotCache(nextSnapshot)
  }

  const pushLog = (entry: Omit<LogEntry, 'seq'>): void => {
    logSeq += 1
    logs.push({ seq: logSeq, ...entry })
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
  }

  const pluginManager = (): any => {
    try {
      const service = (ctx as any).get('pluginManager')
      return service === null || service === undefined ? undefined : service
    } catch {
      return undefined
    }
  }

  const ageOf = (at: number): number => Math.max(0, Math.round((Date.now() - at) / 1000))

  /**
   * 每条出站快照都过一遍：把「装好了但没重启」的清单贴上去。
   * 服务重启过（ActiveEnterTimestamp 晚于记录时间）就自动销账，不用人工点。
   */
  const decorate = (snapshot: Snapshot): Snapshot => {
    let pending: { items: Snapshot['pendingRestart'] } = { items: [] }
    try {
      pending = settlePendingRestart(snapshot.env?.service?.since)
    } catch {
      /* 状态文件坏了就当没有待重启 */
    }
    const items = pending.items ?? []
    return {
      ...snapshot,
      pendingRestart: items,
      summary: { ...snapshot.summary, pendingRestart: items.length },
    }
  }

  const runFullScan = async (options: { deep?: boolean } = {}): Promise<Snapshot> => {
    const snapshot = await scan(
      pluginManager(),
      { registry: config.registry, timeoutMs: config.timeoutMs },
      options.deep === true ? { deep: true } : {},
    )
    cached = { at: Date.now(), snapshot }
    writeSnapshotCache(snapshot)
    if (snapshot.warnings.length > 0) logger?.warn?.('[update-center] ' + snapshot.warnings.join(' | '))
    return snapshot
  }

  /** 后台刷新：已经有在跑的就不再排第二个（一次完整扫描要十几秒，排队只会更慢）。 */
  const startRefresh = (): void => {
    if (refreshing !== undefined) return
    const task = runFullScan()
      .catch((error) => {
        logger?.warn?.('[update-center] 后台刷新失败：' + String(error))
        return undefined
      })
      .finally(() => {
        refreshing = undefined
      })
    refreshing = task
  }

  /** 让缓存立刻失效，但**不丢**旧数据：下次读到的还是它（带 refreshing 标记），后台再补新的。 */
  const invalidate = (): void => {
    if (cached !== undefined) cached = { at: 0, snapshot: cached.snapshot }
  }

  /** 首屏快照：只读本机事实（装了什么 / 什么源 / 什么版本），不碰网络。 */
  const buildFastSnapshot = async (): Promise<Snapshot> => {
    const snapshot = await scan(
      pluginManager(),
      { registry: config.registry, timeoutMs: config.timeoutMs },
      { partial: true },
    )
    const ttl = Math.max(0, config.cacheSeconds) * 1000
    if (cached === undefined || Date.now() - cached.at >= ttl) startRefresh()
    return decorate({ ...snapshot, refreshing: refreshing !== undefined })
  }

  /**
   * 侧栏角标 / 面板状态条用的提醒：**只读缓存与磁盘快照，绝不阻塞**。
   * 快照太旧就在后台排一次刷新（单飞），本次先回上次结果 + `scanning: true`。
   */
  const buildReminder = (): ReminderState => {
    if (cached === undefined) {
      const disk = readSnapshotCache()
      if (disk !== undefined) cached = disk
    }
    const window = Math.max(60_000, config.reminderRefreshSeconds * 1000)
    const stale = cached === undefined || Date.now() - cached.at >= window
    if (stale) startRefresh()
    return reminderFrom(cached?.snapshot, {
      scanning: refreshing !== undefined,
      ...(cached === undefined ? {} : { ageSeconds: ageOf(cached.at) }),
    })
  }

  const buildSnapshot = async (options: { refresh?: boolean; deep?: boolean; wait?: boolean } = {}): Promise<Snapshot> => {
    const ttl = Math.max(0, config.cacheSeconds) * 1000
    if (cached === undefined) {
      // 进程刚起来：先吃上一次落盘的快照，别让用户等一次完整扫描。
      const disk = readSnapshotCache()
      if (disk !== undefined) cached = disk
    }
    if (options.deep === true) return decorate(await runFullScan({ deep: true }))
    if (options.refresh === true) return decorate(await runFullScan())
    if (cached !== undefined) {
      const age = Date.now() - cached.at
      if (age < ttl) return decorate({ ...cached.snapshot, cached: true, ageSeconds: ageOf(cached.at) })
      // 过期但还在手上：先给旧的，后台刷新；客户端看到 refreshing 会再来取。
      startRefresh()
      return decorate({ ...cached.snapshot, cached: true, refreshing: true, ageSeconds: ageOf(cached.at) })
    }
    // 什么缓存都没有：调用方愿意等（agent 工具）就等完整扫描，否则先给本机事实。
    if (options.wait === true) return decorate(await runFullScan())
    return decorate(await buildFastSnapshot())
  }

  // 安装/升级过程的日志与阶段：页面实时展示，不必切终端。
  const offLog = (ctx as any).on?.('plugin-manager/install-log', (chunk: any) => {
    if (typeof chunk?.text !== 'string') return
    pushLog({
      at: Date.now(),
      kind: 'log',
      stream: typeof chunk.stream === 'string' ? chunk.stream : 'stdout',
      text: chunk.text,
    })
  })
  if (typeof offLog === 'function') disposers.push(offLog)
  const offState = (ctx as any).on?.('plugin-manager/update-state', (progress: any) => {
    if (typeof progress?.step !== 'string') return
    pushLog({ at: Date.now(), kind: 'state', stream: 'state', text: '更新阶段：' + progress.step })
  })
  if (typeof offState === 'function') disposers.push(offState)

  const applyUpdate = async (target: string, version: string): Promise<ApplyResult> => {
    const manager = pluginManager()
    if (manager === undefined || typeof manager.updateBundle !== 'function') {
      return { ok: false, name: target, message: 'pluginManager 不可用，无法执行更新' }
    }
    let updatable = false
    let installed: string | undefined
    try {
      const bundles: any[] = (await manager.listBundles()) ?? []
      const found = bundles.find((bundle) => bundle?.name === target)
      updatable = found?.updatable === true
      installed = typeof found?.version === 'string' ? found.version : undefined
    } catch (error) {
      return { ok: false, name: target, message: '读取套件清单失败：' + String(error) }
    }
    if (!updatable) {
      return { ok: false, name: target, message: '该条目不由 pluginManager 管理（本地链接 / git / 注入），请用对应方式更新' }
    }
    // 兜住"目标版本不高于本地"：pluginManager 只会回一句 invalid-spec，看不出原因。
    if (installed !== undefined && compareVersions(version, installed) <= 0) {
      return {
        ok: false,
        name: target,
        from: installed,
        to: version,
        message: '目标版本 ' + version + ' 不高于本地 ' + installed + '，跳过（上游已无更新，或版本号取错）',
      }
    }
    pushLog({ at: Date.now(), kind: 'state', stream: 'state', text: '开始更新 ' + target + ' → ' + version })
    try {
      const result = await manager.updateBundle(target, version, { registry: config.registry })
      const packageResult = result?.result?.packageResult
      const application = String(result?.result?.application ?? 'unknown')
      const message =
        application === 'applied'
          ? '已安装并热重载生效'
          : application === 'restart-required'
            ? '已下载安装，但这个包需要重启 DSH 才生效（本插件不会重启）'
            : '更新未完全成功：' + String(result?.result?.error?.code ?? application)
      const payload: ApplyResult = {
        ok: application === 'applied' || application === 'overridden' || application === 'restart-required',
        name: target,
        from: String(result?.from ?? ''),
        to: String(result?.to ?? version),
        application,
        ...(result?.result?.restartReason === undefined ? {} : { restartReason: String(result.result.restartReason) }),
        message,
        ...(packageResult === undefined
          ? {}
          : {
              packageResult: {
                exitCode: Number(packageResult.exitCode ?? -1),
                ...(packageResult.kind === undefined ? {} : { kind: String(packageResult.kind) }),
                ...(typeof packageResult.output === 'string' ? { output: packageResult.output.slice(-4000) } : {}),
                ...(typeof packageResult.logPath === 'string' ? { logPath: packageResult.logPath } : {}),
              },
            }),
      }
      if (payload.ok && payload.to !== undefined) {
        markBundleUpdatedInCache(target, payload.to, false)
      } else {
        invalidate()
      }
      startRefresh()
      if (application === 'restart-required') {
        // 装好了但要重启：记进待重启清单，面板一打开就提醒（跨会话有效）。
        addPendingRestart([
          {
            name: target,
            at: new Date().toISOString(),
            ...(payload.from === undefined || payload.from === '' ? {} : { from: payload.from }),
            to: payload.to,
            ...(payload.restartReason === undefined ? {} : { reason: payload.restartReason }),
          },
        ])
      }
      pushLog({ at: Date.now(), kind: 'state', stream: 'state', text: '更新结束 ' + target + '：' + message })
      appendHistory(
        {
          at: new Date().toISOString(),
          kind: 'single',
          name: target,
          from: payload.from,
          to: payload.to,
          ok: payload.ok,
          application,
          message,
        },
        config.historyLimit,
      )
      return payload
    } catch (error) {
      invalidate()
      pushLog({ at: Date.now(), kind: 'state', stream: 'state', text: '更新失败 ' + target + '：' + String(error) })
      appendHistory(
        { at: new Date().toISOString(), kind: 'single', name: target, to: version, ok: false, message: '更新异常：' + String(error) },
        config.historyLimit,
      )
      return { ok: false, name: target, message: '更新异常：' + String(error) }
    }
  }

  // ── 批量更新队列 ──
  const batch = new BatchRunner({
    apply: applyUpdate,
    invalidate: () => {
      invalidate()
    },
    stopOnError: config.batchStopOnError,
    abortAfterConsecutiveFailures: config.batchAbortAfterConsecutiveFailures,
    onItemDone: (item) => {
      appendHistory(
        {
          at: new Date().toISOString(),
          kind: 'batch',
          name: item.name,
          from: item.from,
          to: item.to,
          ok: item.status === 'ok',
          application: item.application,
          message: item.message,
        },
        config.historyLimit,
      )
    },
  })

  /**
   * 从快照推出批量计划。
   * stable 通道只动「有更新的正式版」的包；preview 通道才碰预览版（含仅预览版更新的包）。
   */
  const buildPlan = (
    snapshot: Snapshot,
    channel: BatchChannel,
    only?: string[],
  ): { plan: BatchPlanItem[]; skipped: { name: string; reason: string }[] } => {
    const plan: BatchPlanItem[] = []
    const skipped: { name: string; reason: string }[] = []
    const wanted = only === undefined ? undefined : new Set(only)
    for (const row of snapshot.bundles) {
      if (wanted !== undefined && !wanted.has(row.name)) continue
      if (row.updatable !== true) continue
      if (config.pinned.includes(row.name)) {
        skipped.push({ name: row.name, reason: '在 pinned 名单里，跳过' })
        continue
      }
      if (row.status === 'update') {
        const target = channel === 'preview' ? (row.preview ?? row.stable) : row.stable
        if (target === undefined) {
          skipped.push({ name: row.name, reason: '没有可用的目标版本' })
          continue
        }
        plan.push({
          name: row.name,
          ...(row.installed === undefined ? {} : { from: row.installed }),
          to: target.version,
          channel: channel === 'preview' && row.preview !== undefined ? 'preview' : 'stable',
        })
        continue
      }
      if (row.status === 'preview-only' && channel === 'preview' && row.preview !== undefined) {
        plan.push({
          name: row.name,
          ...(row.installed === undefined ? {} : { from: row.installed }),
          to: row.preview.version,
          channel: 'preview',
        })
      }
    }
    return { plan, skipped }
  }

  // ── HTTP 路由（面板读这里） ──
  disposers.push(
    whenReady(ctx, ['webServer'], (owner) => {
      const webServer = owner.webServer
      const routes = [
        {
          kind: 'exact',
          path: API + '/snapshot',
          handler: async (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const mode = url.searchParams.get('mode')
              const snapshot =
                mode === 'local'
                  ? await buildFastSnapshot()
                  : await buildSnapshot({
                      refresh: url.searchParams.get('refresh') === '1',
                      deep: url.searchParams.get('deep') === '1',
                    })
              json(res, 200, snapshot)
            } catch (error) {
              json(res, 500, { ok: false, error: String(error) })
            }
          },
        },
        {
          // 侧栏角标轮询这里：几百字节，命中内存/磁盘缓存，从不触发同步扫描。
          kind: 'exact',
          path: API + '/badge',
          handler: (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            try {
              json(res, 200, buildReminder())
            } catch (error) {
              json(res, 500, { ok: false, error: String(error) })
            }
          },
        },
        {
          kind: 'exact',
          path: API + '/update',
          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (activeOperation !== null || batch.running()) {
              return json(res, 409, {
                ok: false,
                message: `当前正在执行「${activeOperation?.label ?? '批量更新'}」，请等待完成后再操作`,
                activeOperation,
              })
            }
            let body: any
            try {
              body = await readBody(req)
            } catch (error) {
              return json(res, 400, { ok: false, error: String(error) })
            }
            const target = typeof body?.name === 'string' ? body.name : ''
            const version = typeof body?.version === 'string' ? body.version : ''
            if (target === '' || version === '') return json(res, 400, { ok: false, error: 'name 与 version 必填' })
            activeOperation = { key: `${target}@${version}`, label: `${target} → ${version}`, startedAt: Date.now() }
            try {
              const result = await applyUpdate(target, version)
              json(res, result.ok ? 200 : 409, result)
            } finally {
              activeOperation = null
            }
          },
        },
        {
          // 本地链接 / git / 压缩包 / 注入 → 线上（registry）依赖
          kind: 'exact',
          path: API + '/convert',
          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (activeOperation !== null || batch.running()) {
              return json(res, 409, {
                ok: false,
                message: `当前正在执行「${activeOperation?.label ?? '批量更新'}」，请等待完成后再操作`,
                activeOperation,
              })
            }
            let body: any
            try {
              body = await readBody(req)
            } catch (error) {
              return json(res, 400, { ok: false, error: String(error) })
            }
            const name = typeof body?.name === 'string' ? body.name.trim() : ''
            if (name === '') return json(res, 400, { ok: false, error: 'name 必填' })
            const version = typeof body?.version === 'string' ? body.version.trim() : ''
            if (version !== '' && !isSafeVersion(version)) {
              return json(res, 400, { ok: false, error: 'version 必须是合法 semver' })
            }
            activeOperation = { key: `convert:${name}`, label: `转为线上 ${name}`, startedAt: Date.now() }
            try {
              pushLog({ at: Date.now(), kind: 'state', stream: 'state', text: '开始转线上 ' + name })
              const result = await convertToRegistry(pluginManager(), {
                name,
                ...(version === '' ? {} : { version }),
                registry: config.registry,
                timeoutMs: config.timeoutMs,
                injected: body?.injected === true,
                confirmOverwrite: body?.confirmOverwrite === true,
              })
              if (result.ok && result.to !== undefined) {
                markBundleUpdatedInCache(name, String(result.to), true)
              } else {
                invalidate()
              }
              startRefresh()
              if (result.ok && result.application === 'restart-required') {
                addPendingRestart([
                  {
                    name,
                    at: new Date().toISOString(),
                    ...(result.from === undefined ? {} : { from: result.from }),
                    to: String(result.to ?? version),
                    ...(result.restartReason === undefined ? {} : { reason: result.restartReason }),
                  },
                ])
              }
              pushLog({ at: Date.now(), kind: 'state', stream: 'state', text: '转线上结束 ' + name + '：' + String(result.message ?? '') })
              appendHistory(
                {
                  at: new Date().toISOString(),
                  kind: 'convert',
                  name,
                  ...(result.from === undefined ? {} : { from: result.from }),
                  ...(result.to === undefined ? {} : { to: result.to }),
                  ok: result.ok,
                  ...(result.application === undefined ? {} : { application: result.application }),
                  ...(result.message === undefined ? {} : { message: result.message }),
                },
                config.historyLimit,
              )
              json(res, result.ok ? 200 : 409, result)
            } finally {
              activeOperation = null
            }
          },
        },
        {
          // 「装好了但没重启」清单：GET 读，DELETE/POST 清（用户点「稍后」或「已重启」）。
          kind: 'exact',
          path: API + '/pending-restart',
          handler: async (req: any, res: any) => {
            if (req.method === 'GET') {
              const state = readPendingRestart()
              return json(res, 200, { ok: true, ...state })
            }
            if (req.method !== 'POST' && req.method !== 'DELETE') {
              return json(res, 405, { ok: false, error: 'method-not-allowed' })
            }
            const state = clearPendingRestart('user')
            json(res, 200, { ok: true, ...state })
          },
        },
        {
          // 一键重启 dsh.service：只重启，不装东西。脚本跑在独立瞬态单元里（否则会杀掉自己）。
          kind: 'exact',
          path: API + '/restart-service',
          handler: async (req: any, res: any) => {
            if (req.method === 'GET') {
              const runs = listRestartRuns()
              const latest = runs[0] ?? null
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const runId = url.searchParams.get('runId') ?? (latest?.runId as string | undefined) ?? ''
              const log = runId === '' ? '' : readRestartLog(runId)
              return json(res, 200, {
                ok: true,
                allowServiceRestart: config.allowServiceRestart,
                serviceName: config.serviceName,
                latest,
                runs: runs.slice(0, 5),
                ...(runId === '' ? {} : { runId, log }),
              })
            }
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (!config.allowServiceRestart) {
              return json(res, 403, { ok: false, error: '配置里关掉了一键重启（allowServiceRestart=false）' })
            }
            const graceRaw = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('grace') ?? '')
            const graceSeconds = Number.isFinite(graceRaw) && graceRaw >= 0 ? Math.min(120, Math.floor(graceRaw)) : config.restartGraceSeconds
            const launched = await launchServiceRestart({
              serviceName: config.serviceName,
              healthUrl: config.healthUrl,
              graceSeconds,
            })
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'restart',
                name: config.serviceName,
                ok: launched.ok,
                message: launched.message,
              },
              config.historyLimit,
            )
            json(res, launched.ok ? 200 : 500, {
              ...launched,
              latest: launched.runId === undefined ? null : (readRestartRun(launched.runId) ?? null),
            })
          },
        },
        {
          kind: 'exact',
          path: API + '/update-all',          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (batch.running()) return json(res, 409, { ok: false, error: '已有批量更新在执行', batch: batch.current() })
            let body: any
            try {
              body = await readBody(req)
            } catch (error) {
              return json(res, 400, { ok: false, error: String(error) })
            }
            const channel: BatchChannel = body?.channel === 'preview' ? 'preview' : 'stable'
            const only =
              Array.isArray(body?.names) && body.names.every((name: unknown) => typeof name === 'string')
                ? (body.names as string[])
                : undefined
            try {
              const snapshot = await buildSnapshot({ refresh: true })
              const { plan, skipped } = buildPlan(snapshot, channel, only)
              if (plan.length === 0) {
                return json(res, 200, {
                  ok: true,
                  started: false,
                  message: channel === 'stable' ? '没有需要更新的正式版' : '没有需要更新的版本',
                  skipped,
                  batch: null,
                })
              }
              const state = batch.start(plan, channel)
              json(res, 200, { ok: true, started: true, batch: state, skipped })
            } catch (error) {
              json(res, 500, { ok: false, error: String(error) })
            }
          },
        },
        {
          kind: 'exact',
          path: API + '/batch',
          handler: (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            json(res, 200, { batch: batch.current() ?? null })
          },
        },
        {
          kind: 'exact',
          path: API + '/batch/cancel',
          handler: (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            const cancelled = batch.cancel()
            json(res, 200, { ok: true, cancelled, batch: batch.current() ?? null })
          },
        },
        {
          kind: 'exact',
          path: API + '/core-update',
          handler: async (req: any, res: any) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (req.method === 'GET') {
              const runs = listCoreRuns()
              const latest = runs[0]
              return json(res, 200, {
                ok: true,
                allowCoreUpdate: config.allowCoreUpdate,
                serviceName: config.serviceName,
                healthUrl: config.healthUrl,
                inFlight: coreUpdateInFlight(latest),
                latest: latest ?? null,
                runs: runs.slice(0, 10),
              })
            }
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (!config.allowCoreUpdate) {
              return json(res, 403, { ok: false, error: '配置里关掉了本体更新（allowCoreUpdate=false）' })
            }
            let body: any
            try {
              body = await readBody(req)
            } catch (error) {
              return json(res, 400, { ok: false, error: String(error) })
            }
            const version = typeof body?.version === 'string' ? body.version.trim() : ''
            if (version === '' || !isSafeVersion(version)) {
              return json(res, 400, { ok: false, error: 'version 必填且必须是合法 semver' })
            }
            if (coreUpdateInFlight(listCoreRuns()[0])) {
              return json(res, 409, { ok: false, error: '已有本体更新在执行', latest: listCoreRuns()[0] ?? null })
            }
            let snapshot: Snapshot
            try {
              snapshot = await buildSnapshot({ refresh: true })
            } catch (error) {
              return json(res, 500, { ok: false, error: '扫描失败：' + String(error) })
            }
            const core = snapshot.core
            const allowed = [core.channels.stable?.version, core.channels.preview?.version].filter(
              (value): value is string => value !== undefined,
            )
            if (!allowed.includes(version)) {
              return json(res, 400, {
                ok: false,
                error: '只接受扫描结果里的正式版或预览版版本号（' + (allowed.join(' / ') || '上游不可查') + '）',
              })
            }
            if (core.runtimeDir === undefined || core.version === undefined) {
              return json(res, 400, { ok: false, error: '定位不到本体运行时目录，无法一键更新' })
            }
            const dryRun = body?.dryRun === true
            const graceSeconds =
              typeof body?.graceSeconds === 'number' && Number.isFinite(body.graceSeconds)
                ? Math.min(120, Math.max(0, Math.floor(body.graceSeconds)))
                : config.coreGraceSeconds
            // 不接受降级：stable 通道常常比当前预览版更旧，误点一次就是回退一个大版本。
            if (!dryRun && compareVersions(version, core.version) <= 0) {
              return json(res, 400, {
                ok: false,
                error: '目标版本 ' + version + ' 不高于当前 ' + core.version + '，拒绝降级',
              })
            }
            const launched = await launchCoreUpdate({
              runtimeDir: core.runtimeDir,
              from: core.version,
              target: version,
              registry: config.registry,
              serviceName: config.serviceName,
              healthUrl: config.healthUrl,
              dryRun,
              graceSeconds,
            })
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'core',
                name: core.name,
                from: core.version,
                to: version,
                ok: launched.ok,
                message: launched.message,
              },
              config.historyLimit,
            )
            json(res, launched.ok ? 200 : 500, {
              ...launched,
              latest: launched.runId === undefined ? null : (readCoreRun(launched.runId) ?? null),
            })
          },
        },
        {
          kind: 'exact',
          path: API + '/core-update/log',
          handler: (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const runId = url.searchParams.get('runId') ?? listCoreRuns()[0]?.runId ?? ''
            if (runId === '') return json(res, 404, { ok: false, error: '没有可读的 run' })
            json(res, 200, { ok: true, runId, log: readCoreLog(runId) })
          },
        },
        {
          kind: 'exact',
          path: API + '/history',
          handler: (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const limitRaw = Number(url.searchParams.get('limit') ?? '30')
            const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 30
            json(res, 200, { ok: true, entries: readHistory(limit) })
          },
        },
        {
          kind: 'exact',
          path: API + '/log',
          handler: (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const since = Number(url.searchParams.get('since') ?? '0')
            const entries = logs.filter((entry) => entry.seq > (Number.isFinite(since) ? since : 0))
            json(res, 200, { entries, lastSeq: logSeq })
          },
        },
        {
          kind: 'exact',
          path: API + '/infra',
          handler: async (req: any, res: any) => {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const refresh = url.searchParams.get('refresh') === '1'
            try {
              const infra = await scanInfra({ refresh })
              json(res, 200, { ok: true, infra })
            } catch (err: any) {
              json(res, 500, { ok: false, message: String(err?.message ?? err) })
            }
          },
        },
        {
          kind: 'exact',
          path: API + '/infra/docker-update',
          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (activeOperation !== null || batch.running()) {
              return json(res, 409, {
                ok: false,
                message: `当前正在执行「${activeOperation?.label ?? '批量更新'}」，请等待完成后再操作`,
                activeOperation,
              })
            }
            const body = await readBody(req)
            const node = String(body?.node ?? 'local').trim()
            const name = String(body?.name ?? '').trim()
            if (!node || !name) {
              return json(res, 400, { ok: false, message: '需要合法的 node 与容器 name' })
            }
            activeOperation = { key: `docker:${node}:${name}`, label: `更新容器 ${node}:${name}`, startedAt: Date.now() }
            try {
              pushLog({ at: Date.now(), kind: 'state', text: `[infra] 开始更新容器 ${node}:${name}` })
              const result = await updateDockerContainer(node, name)
              pushLog({ at: Date.now(), kind: result.ok ? 'state' : 'log', text: `[infra] ${result.message}` })
              appendHistory(
                {
                  at: new Date().toISOString(),
                  kind: 'docker',
                  name: `${node}:${name}`,
                  ok: result.ok,
                  message: result.message,
                },
                config.historyLimit,
              )
              const infra = await scanInfra({ refresh: true })
              json(res, result.ok ? 200 : 500, { ...result, infra })
            } finally {
              activeOperation = null
            }
          },
        },
        {
          kind: 'exact',
          path: API + '/infra/apt-update',
          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (activeOperation !== null || batch.running()) {
              return json(res, 409, {
                ok: false,
                message: `当前正在执行「${activeOperation?.label ?? '批量更新'}」，请等待完成后再操作`,
                activeOperation,
              })
            }
            const body = await readBody(req)
            const node = String(body?.node ?? 'local').trim()
            if (!node) {
              return json(res, 400, { ok: false, message: '需要合法的 node 标识' })
            }
            activeOperation = { key: `apt:${node}`, label: `升级 ${node.toUpperCase()} 安全 APT 包`, startedAt: Date.now() }
            try {
              pushLog({ at: Date.now(), kind: 'state', text: `[infra] 开始更新 ${node.toUpperCase()} 安全 APT 包` })
              const result = await updateSafeApt(node)
              pushLog({ at: Date.now(), kind: result.ok ? 'state' : 'log', text: `[infra] ${result.message}` })
              appendHistory(
                {
                  at: new Date().toISOString(),
                  kind: 'apt',
                  name: `${node}:safe-apt`,
                  ok: result.ok,
                  message: result.message,
                },
                config.historyLimit,
              )
              const infra = await scanInfra({ refresh: true })
              json(res, result.ok ? 200 : 500, { ...result, infra })
            } finally {
              activeOperation = null
            }
          },
        },
        {
          kind: 'exact',
          path: API + '/infra/toolchain-update',
          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (activeOperation !== null || batch.running()) {
              return json(res, 409, {
                ok: false,
                message: `当前正在执行「${activeOperation?.label ?? '批量更新'}」，请等待完成后再操作`,
                activeOperation,
              })
            }
            const body = await readBody(req)
            const id = String(body?.id ?? '').trim()
            if (!id) {
              return json(res, 400, { ok: false, message: '需要工具链条目 id (如 uv / pnpm / litellm / obsidian / npm:catbus-cli)' })
            }
            activeOperation = { key: `toolchain:${id}`, label: `升级本机工具 ${id}`, startedAt: Date.now() }
            try {
              pushLog({ at: Date.now(), kind: 'state', text: `[infra] 开始更新本机工具 ${id}` })
              const result = await updateToolchainItem(id)
              pushLog({ at: Date.now(), kind: result.ok ? 'state' : 'log', text: `[infra] ${result.message}` })
              appendHistory(
                {
                  at: new Date().toISOString(),
                  kind: 'toolchain',
                  name: `toolchain:${id}`,
                  ok: result.ok,
                  message: result.message,
                },
                config.historyLimit,
              )
              const infra = await scanInfra({ refresh: true })
              json(res, result.ok ? 200 : 500, { ...result, infra })
            } finally {
              activeOperation = null
            }
          },
        },
        {
          kind: 'exact',
          path: API + '/infra/venv-update',
          handler: async (req: any, res: any) => {
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
            if (activeOperation !== null || batch.running()) {
              return json(res, 409, {
                ok: false,
                message: `当前正在执行「${activeOperation?.label ?? '批量更新'}」，请等待完成后再操作`,
                activeOperation,
              })
            }
            const body = await readBody(req)
            const projectId = String(body?.projectId ?? '').trim()
            if (!projectId) {
              return json(res, 400, { ok: false, message: '需要项目虚拟环境 projectId（来自 infra-scan 自动发现的项目 id）' })
            }
            activeOperation = { key: `venv:${projectId}`, label: `升级虚拟环境 ${projectId}`, startedAt: Date.now() }
            try {
              pushLog({ at: Date.now(), kind: 'state', text: `[infra] 开始升级项目虚拟环境 ${projectId} 同主版本安全包` })
              const result = await updateProjectVenv(projectId)
              pushLog({ at: Date.now(), kind: result.ok ? 'state' : 'log', text: `[infra] ${result.message}` })
              appendHistory(
                {
                  at: new Date().toISOString(),
                  kind: 'venv',
                  name: `venv:${projectId}`,
                  ok: result.ok,
                  message: result.message,
                },
                config.historyLimit,
              )
              const infra = await scanInfra({ refresh: true })
              json(res, result.ok ? 200 : 500, { ...result, infra })
            } finally {
              activeOperation = null
            }
          },
        },
      ]
      const registered = routes.map((route) => webServer.register(route))
      logger?.info?.('[update-center] 已注册 ' + routes.length + ' 条路由于 ' + API)
      return () => {
        for (const dispose of registered) {
          try {
            dispose?.()
          } catch {
            /* 已释放 */
          }
        }
      }
    }),
  )

  // ── 给 agent 一个工具（没有 UI 时也走同一套扫描/更新） ──
  disposers.push(
    whenReady(ctx, ['tools'], (owner) => {
      const definition = defineTool({
        name: 'dsh_update_center',
        description:
          '扫描并更新本机与跨节点运维组件：DSH 本体、已装插件与套件（npm / 本地链接 / git / 压缩包 / 注入）、三节点 Docker 容器（VM100 / iStoreOS / fnOS）、双节点 APT 系统安全包（VM100 / PVE）、本机核心工具链（uv / pnpm / litellm / 全局 CLI / Obsidian）与项目 Python 虚拟环境（.venv）。action=scan 返回 DSH 总览；action=infra-scan 返回跨节点 Docker、APT、工具链与项目 .venv 审计快照；action=docker-update 更新指定节点的非锁定容器；action=apt-update 更新指定节点的安全非内核 APT 包；action=toolchain-update 更新本机指定 CLI/桌面工具；action=venv-update 更新指定项目 .venv 的同主版本安全包；action=update 升级单个套件（热更新，不重启）；action=convert 把本地链接/git/压缩包/注入的条目换成上游 registry 依赖；action=update-all 串行更新所有可更新套件；action=batch 查批量进度；action=core-update 一键更新 DSH 本体；action=history 查更新历史。',
        parameters: {
          action: {
            type: 'string',
            enum: ['scan', 'infra-scan', 'docker-update', 'apt-update', 'toolchain-update', 'venv-update', 'update', 'convert', 'update-all', 'batch', 'core-update', 'history'],
            required: true,
            description: 'scan=DSH总览；infra-scan=跨节点Docker/APT/工具链/venv审计；docker-update=更新容器；apt-update=更新安全APT包；toolchain-update=更新本机工具；venv-update=更新项目Python虚拟环境；update=升级单个套件；convert=本地源转线上；update-all=批量升级；batch=批量进度；core-update=更新 DSH 本体；history=更新历史',
          },
          node: { type: 'string', description: 'docker-update / apt-update 时的目标节点 id（默认本机 local，或已发现的 vm100 / istoreos / fnos / pve 等）' },
          name: { type: 'string', description: 'update / convert 时的套件包名，docker-update 时的容器名，toolchain-update 时的工具 id（如 uv/pnpm/litellm/obsidian/npm:<pkg>/uv-tool:<tool>），或 venv-update 时的项目 id' },
          version: { type: 'string', description: 'update / core-update / convert 时的目标版本（取 scan 结果里的 stable/preview 版本号；convert 省略则用上游最新版）' },
          injected: { type: 'boolean', description: 'convert 时说明这是运行时注入条目（超级注入器），装成线上依赖后还需 dev_uninject_plugin 解除注入' },
          confirmOverwrite: {
            type: 'boolean',
            description: 'convert 时确认覆盖本地改动：本地目录与上游同版本不一致时，不带这个参数一律拒绝（先看 scan 报出的「本地改动」）',
          },
          channel: { type: 'string', enum: ['stable', 'preview'], description: 'update-all 时的通道，默认 stable（只更正式版）' },
          dryRun: { type: 'boolean', description: 'core-update 时只跑预检（不停服、不安装），用于验证链路是否通' },
          refresh: { type: 'boolean', description: 'scan 时忽略缓存重新扫描' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { report: { type: 'string', required: true } },
          },
          render: (_args: unknown, value: { report: string }) => [{ type: 'text' as const, text: value.report }],
        },
        async execute(args: any) {
          const action = String(args?.action ?? 'scan')

          if (action === 'infra-scan') {
            const infra = await scanInfra({ refresh: args?.refresh === true })
            const lines: string[] = [
              `跨节点 Docker 容器（可更新 ${infra.docker.updatableCount} 个 / 锁定保护 ${infra.docker.lockedCount} 个）：`,
            ]
            for (const c of infra.docker.containers) {
              const tag = c.status === 'update' ? '🟡可更新' : c.status === 'locked' ? '🔒已锁定' : c.status === 'latest' ? '🟢最新' : '⚠️异常'
              lines.push(`- [${c.nodeLabel}] ${c.name} (${c.image}) → ${tag} ｜ ${c.detail ?? ''}`)
            }
            lines.push(
              `\n跨节点 APT 软件包（安全可更 ${infra.apt.safeUpdatableCount} 个 / 门禁锁定 ${infra.apt.lockedCount} 个）：`,
            )
            const aptRows = infra.apt.nodes
              ? infra.apt.nodes.flatMap((n) => n.packages)
              : [...infra.apt.vm100, ...infra.apt.pve]
            for (const p of aptRows) {
              const tag = p.locked ? '🔒门禁锁定' : '🟡安全可更'
              lines.push(`- [${(p.nodeLabel ?? p.node).toUpperCase()}] ${p.name}: ${p.installed} → ${p.candidate} (${tag}${p.lockReason ? '：' + p.lockReason : ''})`)
            }
            if (infra.toolchain) {
              lines.push(
                `\n本机核心工具链与全局 CLI（可更新 ${infra.toolchain.updatableCount} 个 / 共 ${infra.toolchain.items.length} 个）：`,
              )
              for (const t of infra.toolchain.items) {
                const tag = t.status === 'update' ? '🟡可更新' : '🟢最新'
                lines.push(`- [${t.id}] ${t.name}: ${t.installed} → ${t.latest ?? '—'} (${tag}) ｜ ${t.detail ?? ''}`)
              }
            }
            if (infra.venvs) {
              lines.push(
                `\n项目 Python 虚拟环境 .venv（安全可更 ${infra.venvs.totalSafeUpdatable} 个包）：`,
              )
              for (const v of infra.venvs.projects) {
                lines.push(
                  `- [${v.id}] ${v.project} (Python ${v.pythonVersion}): 待升级 ${v.outdatedCount} 个（同主版本安全可更 ${v.safeUpdatableCount} 个）`,
                )
                for (const p of v.packages) {
                  lines.push(
                    `    · ${p.name}: ${p.installed} → ${p.latest} (${p.safe ? '🟡安全可更' : '🔒锁定：' + (p.lockReason ?? '跨大版本')})`,
                  )
                }
              }
            }
            return { report: lines.join('\n') }
          }

          if (action === 'toolchain-update') {
            const id = String(args?.name ?? '').trim()
            if (!id) {
              return { report: 'toolchain-update 需要 name 参数指定工具链 id（如 uv / pnpm / litellm / obsidian / npm:catbus-cli）' }
            }
            const res = await updateToolchainItem(id)
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'toolchain',
                name: `toolchain:${id}`,
                ok: res.ok,
                message: res.message,
              },
              config.historyLimit,
            )
            return { report: `${res.ok ? 'OK' : 'FAIL'} | ${res.message}${res.output ? '\n' + res.output : ''}` }
          }

          if (action === 'venv-update') {
            const projectId = String(args?.name ?? '').trim()
            if (!projectId) {
              return { report: 'venv-update 需要 name 参数指定项目 id（来自 infra-scan 自动发现的虚拟环境 id）' }
            }
            const res = await updateProjectVenv(projectId)
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'venv',
                name: `venv:${projectId}`,
                ok: res.ok,
                message: res.message,
              },
              config.historyLimit,
            )
            return { report: `${res.ok ? 'OK' : 'FAIL'} | ${res.message}${res.output ? '\n' + res.output : ''}` }
          }

          if (action === 'docker-update') {
            const node = String(args?.node ?? 'local').trim()
            const name = String(args?.name ?? '').trim()
            if (!node || !name) {
              return { report: 'docker-update 需要合法的 node 与容器 name' }
            }
            const res = await updateDockerContainer(node, name)
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'docker',
                name: `${node}:${name}`,
                ok: res.ok,
                message: res.message,
              },
              config.historyLimit,
            )
            return { report: `${res.ok ? 'OK' : 'FAIL'} | ${res.message}${res.output ? '\n' + res.output : ''}` }
          }

          if (action === 'apt-update') {
            const node = String(args?.node ?? 'local').trim()
            if (!node) {
              return { report: 'apt-update 需要合法的 node 标识' }
            }
            const res = await updateSafeApt(node)
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'apt',
                name: `${node}:safe-apt`,
                ok: res.ok,
                message: res.message,
              },
              config.historyLimit,
            )
            return { report: `${res.ok ? 'OK' : 'FAIL'} | ${res.message}${res.output ? '\n' + res.output : ''}` }
          }

          if (action === 'update') {
            const target = String(args?.name ?? '')
            const version = String(args?.version ?? '')
            if (target === '' || version === '') return { report: 'update 需要 name 与 version' }
            const result = await applyUpdate(target, version)
            return { report: [target, result.message ?? '', result.application ?? ''].filter((part) => part !== '').join(' | ') }
          }

          if (action === 'convert') {
            const target = String(args?.name ?? '').trim()
            if (target === '') return { report: 'convert 需要 name' }
            const version = String(args?.version ?? '').trim()
            const result = await convertToRegistry(pluginManager(), {
              name: target,
              ...(version === '' ? {} : { version }),
              registry: config.registry,
              timeoutMs: config.timeoutMs,
              injected: args?.injected === true,
              confirmOverwrite: args?.confirmOverwrite === true,
            })
            invalidate()
            if (result.ok && result.application === 'restart-required') {
              addPendingRestart([
                {
                  name: target,
                  at: new Date().toISOString(),
                  ...(result.from === undefined ? {} : { from: result.from }),
                  to: String(result.to ?? version),
                  ...(result.restartReason === undefined ? {} : { reason: result.restartReason }),
                },
              ])
            }
            return {
              report: [target, result.ok ? 'OK' : 'FAIL', result.message ?? ''].filter((part) => part !== '').join(' | '),
            }
          }

          if (action === 'update-all') {            if (batch.running()) return { report: '已有批量更新在执行，先用 action=batch 看进度' }
            const channel: BatchChannel = args?.channel === 'preview' ? 'preview' : 'stable'
            const snapshot = await buildSnapshot({ refresh: true })
            const { plan, skipped } = buildPlan(snapshot, channel)
            if (plan.length === 0) return { report: '没有需要更新的条目（通道 ' + channel + '）' }
            const state = batch.start(plan, channel)
            const lines = [
              '已开始批量更新 ' + state.total + ' 个套件（通道 ' + channel + '，串行）：',
              ...plan.map((item) => '- ' + item.name + ' → ' + item.to),
            ]
            if (skipped.length > 0) lines.push('跳过 ' + skipped.length + ' 个：' + skipped.map((entry) => entry.name + '（' + entry.reason + '）').join('；'))
            lines.push('进度用 action=batch 查。')
            return { report: lines.join('\n') }
          }

          if (action === 'batch') {
            const state = batch.current()
            if (state === undefined) return { report: '还没有批量更新记录' }
            const lines = [
              '批量更新 ' +
                (state.running ? '进行中' : '已结束') +
                '：' +
                state.done +
                '/' +
                state.total +
                '，成功 ' +
                state.summary.ok +
                '，需重启 ' +
                state.summary.warn +
                '，失败 ' +
                state.summary.failed +
                '，跳过 ' +
                state.summary.skipped +
                (state.cancelled ? '（已叫停）' : ''),
            ]
            for (const item of state.items) {
              lines.push(
                '- [' +
                  (item.status === 'warn' ? '需重启' : item.status) +
                  '] ' +
                  item.name +
                  ' → ' +
                  item.to +
                  (item.message === undefined ? '' : '：' + item.message),
              )
            }
            return { report: lines.join('\n') }
          }

          if (action === 'core-update') {
            if (!config.allowCoreUpdate) return { report: '配置里关掉了本体更新（allowCoreUpdate=false）' }
            const version = String(args?.version ?? '')
            if (version === '' || !isSafeVersion(version)) return { report: 'core-update 需要合法的 version（取 scan 结果里的 stable/preview 版本号）' }
            if (coreUpdateInFlight(listCoreRuns()[0])) return { report: '已有本体更新在执行，先看 GET /api/dsh-update-center/core-update' }
            const snapshot = await buildSnapshot({ refresh: true })
            const core = snapshot.core
            const allowed = [core.channels.stable?.version, core.channels.preview?.version].filter(
              (value): value is string => value !== undefined,
            )
            if (!allowed.includes(version)) return { report: '只接受扫描结果里的版本号：' + (allowed.join(' / ') || '上游不可查') }
            if (core.runtimeDir === undefined || core.version === undefined) return { report: '定位不到本体运行时目录' }
            const dryRun = args?.dryRun === true
            if (!dryRun && compareVersions(version, core.version) <= 0) {
              return { report: '目标版本 ' + version + ' 不高于当前 ' + core.version + '，拒绝降级' }
            }
            const launched = await launchCoreUpdate({
              runtimeDir: core.runtimeDir,
              from: core.version,
              target: version,
              registry: config.registry,
              serviceName: config.serviceName,
              healthUrl: config.healthUrl,
              dryRun,
              graceSeconds: config.coreGraceSeconds,
            })
            appendHistory(
              {
                at: new Date().toISOString(),
                kind: 'core',
                name: core.name,
                from: core.version,
                to: version,
                ok: launched.ok,
                message: launched.message,
              },
              config.historyLimit,
            )
            return {
              report: launched.message + (launched.logPath === undefined ? '' : '\n日志：' + launched.logPath) + '\n注意：服务会重启，当前会话会中断，恢复后到更新中心面板看结果。',
            }
          }

          if (action === 'history') {
            const entries = readHistory(30)
            if (entries.length === 0) return { report: '没有更新历史' }
            return {
              report: entries
                .map(
                  (entry) =>
                    entry.at.replace('T', ' ').slice(0, 19) +
                    ' | ' +
                    entry.kind +
                    ' | ' +
                    (entry.name ?? '') +
                    ' ' +
                    (entry.from ?? '') +
                    '→' +
                    (entry.to ?? '') +
                    ' | ' +
                    (entry.ok ? 'OK' : 'FAIL') +
                    (entry.message === undefined ? '' : ' | ' + entry.message),
                )
                .join('\n'),
            }
          }

          const snapshot = await buildSnapshot({ refresh: args?.refresh === true, wait: true })
          const core = snapshot.core
          const lines: string[] = [
            'DSH 本体：本地 ' +
              (core.version ?? '未知') +
              ' ｜ 正式版 ' +
              (core.channels.stable?.version ?? '—') +
              ' ｜ 预览版 ' +
              (core.channels.preview?.version ?? '—') +
              '（' +
              core.status +
              '）',
          ]
          const rows = snapshot.bundles.filter((row) => row.status === 'update' || row.status === 'preview-only')
          lines.push('可更新套件 ' + rows.length + ' 个（已查 ' + snapshot.summary.scannedBundles + ' 个 registry 包）：')
          for (const row of rows) {
            lines.push(
              '- ' +
                row.name +
                '  本地 ' +
                (row.installed ?? '?') +
                ' → 正式版 ' +
                (row.stable?.version ?? '—') +
                ' / 预览版 ' +
                (row.preview?.version ?? '—') +
                '（' +
                row.status +
                '）',
            )
          }
          lines.push(
            '注入插件 ' + snapshot.injected.length + ' 个 ｜ node ' + snapshot.env.node + ' ｜ pnpm ' + (snapshot.env.pnpm ?? '未装') + ' ｜ dsh.service ' + (snapshot.env.service.active ?? '未知'),
          )
          const convertible = [...snapshot.bundles, ...snapshot.injected].filter(
            (row) => row.upstream?.convertible === true && row.upstream.version !== undefined,
          )
          if (convertible.length > 0) {
            lines.push('可转线上（本地源 → registry 依赖）' + convertible.length + ' 个：')
            for (const row of convertible) {
              lines.push(
                '- ' +
                  row.name +
                  '  本地 ' +
                  (row.installed ?? '?') +
                  ' → 上游 ' +
                  String(row.upstream?.version ?? '') +
                  '（' +
                  row.sourceKind +
                  '）' +
                  (row.kind === 'injected' ? '｜注入条目，装完需 dev_uninject_plugin 解除注入' : '') +
                  (row.localDelta === undefined
                    ? ''
                    : '｜' +
                      (row.localDelta.status === 'identical'
                        ? '与上游一致（无损）'
                        : row.localDelta.status === 'modified'
                          ? '本地与上游不同（内容不同 ' +
                            String(row.localDelta.modifiedCount ?? 0) +
                            ' / 仅本地有 ' +
                            String(row.localDelta.localOnlyCount ?? 0) +
                            ' / 仅上游有 ' +
                            String(row.localDelta.upstreamOnlyCount ?? 0) +
                            '）：' +
                            (row.localDelta.changedFiles ?? []).slice(0, 5).join('、') +
                            '（转线上后生效的是上游版本；确认覆盖需 confirmOverwrite=true）'
                          : '无法比对：' + String(row.localDelta.reason ?? ''))),
              )
            }
          }
          const pending = snapshot.pendingRestart ?? []
          if (pending.length > 0) {
            lines.push(
              '需重启 DSH 才生效 ' +
                pending.length +
                ' 个（面板可一键重启，或 sudo systemctl restart ' +
                snapshot.env.service.name +
                '）：',
            )
            for (const item of pending) {
              lines.push('- ' + item.name + ' ' + (item.from ?? '?') + ' → ' + (item.to ?? '?') + '（' + item.at + '）')
            }
          }
          return { report: lines.join('\n') }
        },
      })
      const dispose = owner.tools.register(definition)
      return () => {
        try {
          dispose?.()
        } catch {
          /* 已释放 */
        }
      }
    }),
  )

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    'dsh-update-center: teardown',
  )

  logger?.info?.('[update-center] 启动，registry=' + config.registry)
}
