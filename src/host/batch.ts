/**
 * 一键更新所有插件：串行队列。
 *
 * 串行不是保守，是必需：pluginManager 的 updateBundle 内部会 remove + install 并触发 HMR，
 * 两个包同时走这条路径会互相踩 profile 的 node_modules 与 patch 重载。一次只动一个，
 * 出错能立刻定位是哪个包，也方便中途叫停。
 */
import type { ApplyResult, BatchChannel, BatchItem, BatchState } from '../shared/types.js'

export interface BatchPlanItem {
  name: string
  from?: string
  to: string
  channel: BatchChannel
}

export interface BatchDeps {
  apply: (name: string, version: string) => Promise<ApplyResult>
  /** 每次更新后让快照缓存失效（下次读盘时重扫）。 */
  invalidate?: () => void
  /** 一项失败后是否立刻停（true = 严格；默认 false = 继续跑完剩下的）。 */
  stopOnError: boolean
  /**
   * 连续失败到这个数就收手：单项失败（bundle-in-use 之类）继续跑，
   * 连续失败通常意味着 registry 断网或 pnpm 挂了，继续只会白等。
   */
  abortAfterConsecutiveFailures: number
  onItemDone?: (item: BatchItem, state: BatchState) => void
}

export class BatchRunner {
  private state: BatchState | undefined

  constructor(private readonly deps: BatchDeps) {}

  current(): BatchState | undefined {
    return this.state
  }

  running(): boolean {
    return this.state?.running === true
  }

  cancel(): boolean {
    if (this.state === undefined || this.state.running !== true) return false
    this.state.cancelled = true
    return true
  }

  /** 启动队列；立刻返回初始状态，实际执行在后台推进。 */
  start(plan: BatchPlanItem[], channel: BatchChannel): BatchState {
    const items: BatchItem[] = plan.map((entry) => ({
      name: entry.name,
      ...(entry.from === undefined ? {} : { from: entry.from }),
      to: entry.to,
      channel: entry.channel,
      status: 'pending',
    }))
    const state: BatchState = {
      id: new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'),
      startedAt: Date.now(),
      running: true,
      cancelled: false,
      channel,
      total: items.length,
      done: 0,
      items,
      summary: { ok: 0, warn: 0, failed: 0, skipped: 0 },
    }
    this.state = state
    void this.run(state)
    return state
  }

  private async run(state: BatchState): Promise<void> {
    let consecutiveFailures = 0
    for (const item of state.items) {
      if (state.cancelled) {
        item.status = 'skipped'
        item.message = '已叫停'
        state.summary.skipped += 1
        state.done += 1
        continue
      }
      item.status = 'running'
      state.current = item.name
      try {
        const result = await this.deps.apply(item.name, item.to)
        if (result.ok) {
          item.status = 'ok'
          consecutiveFailures = 0
        } else if (result.application === 'restart-required') {
          // 装好了、要重启才生效：既不算热更新成功，也不是失败。
          item.status = 'warn'
          consecutiveFailures = 0
        } else {
          item.status = 'failed'
          consecutiveFailures += 1
        }
        item.message = result.message ?? ''
        if (result.application !== undefined) item.application = result.application
        if (item.status === 'ok') state.summary.ok += 1
        else if (item.status === 'warn') state.summary.warn += 1
        else state.summary.failed += 1
      } catch (error) {
        item.status = 'failed'
        item.message = '更新异常：' + String(error)
        state.summary.failed += 1
        consecutiveFailures += 1
      }
      state.done += 1
      this.deps.invalidate?.()
      this.deps.onItemDone?.(item, state)

      const shouldStop =
        (item.status === 'failed' && this.deps.stopOnError) ||
        consecutiveFailures >= Math.max(1, this.deps.abortAfterConsecutiveFailures)
      if (shouldStop) {
        const reason =
          item.status === 'failed' && this.deps.stopOnError
            ? '前一项失败，已停止'
            : '连续 ' + consecutiveFailures + ' 项失败，疑似上游或 pnpm 异常，已停止'
        for (const rest of state.items) {
          if (rest.status === 'pending') {
            rest.status = 'skipped'
            rest.message = reason
            state.summary.skipped += 1
            state.done += 1
          }
        }
        break
      }
    }
    state.current = undefined
    state.running = false
    state.finishedAt = Date.now()
  }
}
