/**
 * 更新中心的本地状态：快照磁盘缓存 + 「装好了要重启才生效」清单。
 *
 * 为什么要落盘：
 *   1. 一次完整扫描要跑十几次 `pnpm view`（~30s）。面板打开时才扫，用户就得干等。
 *      把上一次的快照写盘，进程重启后也能先把旧数据画出来，再后台刷新。
 *   2. 需要重启的包是**跨会话**的事实：更新完服务没重启，那个包就一直没生效。
 *      记到盘上，面板一打开就能提醒，而不是只留在某一次请求的返回值里。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PendingRestartItem, PendingRestartState, Snapshot } from '../shared/types.js'
import { updateCenterHome } from './core.js'

const PENDING_KEEP = 50

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(updateCenterHome(), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

// ── 快照磁盘缓存 ────────────────────────────────────────────────────────────

export function snapshotCachePath(): string {
  return join(updateCenterHome(), 'snapshot.json')
}

export function readSnapshotCache(): { at: number; snapshot: Snapshot } | undefined {
  const path = snapshotCachePath()
  if (!existsSync(path)) return undefined
  const raw = readJson(path)
  if (raw === undefined || raw.snapshot === undefined || raw.snapshot.core === undefined) return undefined
  const at = typeof raw.at === 'number' ? raw.at : Date.parse(String(raw.snapshot.generatedAt ?? ''))
  if (Number.isNaN(at)) return undefined
  return { at, snapshot: raw.snapshot as Snapshot }
}

export function writeSnapshotCache(snapshot: Snapshot): void {
  // partial 快照没有上游版本，写盘会覆盖掉有用的旧数据。
  if (snapshot.partial === true) return
  writeJson(snapshotCachePath(), { at: Date.now(), snapshot })
}

// ── 待重启清单 ──────────────────────────────────────────────────────────────

export function pendingRestartPath(): string {
  return join(updateCenterHome(), 'pending-restart.json')
}

export function readPendingRestart(): PendingRestartState {
  const raw = readJson(pendingRestartPath())
  if (raw === undefined || raw === null || typeof raw !== 'object') return { items: [] }
  const items: PendingRestartItem[] = Array.isArray(raw.items)
    ? raw.items
        .filter((item: any) => item !== null && typeof item === 'object' && typeof item.name === 'string')
        .map((item: any) => ({
          name: item.name as string,
          at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
          ...(typeof item.from === 'string' ? { from: item.from } : {}),
          ...(typeof item.to === 'string' ? { to: item.to } : {}),
          ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
        }))
    : []
  return {
    items,
    ...(typeof raw.at === 'string' ? { at: raw.at } : {}),
    ...(typeof raw.clearedAt === 'string' ? { clearedAt: raw.clearedAt } : {}),
    ...(typeof raw.clearedBy === 'string' ? { clearedBy: raw.clearedBy } : {}),
  }
}

/** 记下「这个包装好了但要重启」。同名条目覆盖，不重复堆。 */
export function addPendingRestart(items: PendingRestartItem[]): PendingRestartState {
  if (items.length === 0) return readPendingRestart()
  const current = readPendingRestart()
  const merged = current.items.filter((existing) => items.every((item) => item.name !== existing.name))
  const next: PendingRestartState = {
    items: [...merged, ...items].slice(-PENDING_KEEP),
    at: new Date().toISOString(),
  }
  writeJson(pendingRestartPath(), next)
  return next
}

export function clearPendingRestart(by: string): PendingRestartState {
  const next: PendingRestartState = {
    items: [],
    clearedAt: new Date().toISOString(),
    clearedBy: by,
  }
  writeJson(pendingRestartPath(), next)
  return next
}

/**
 * 服务重启过了就自动销账：`systemctl show -p ActiveEnterTimestamp` 晚于记录时间，
 * 说明那些包已经在新进程里生效，清单不该再提醒。
 */
export function settlePendingRestart(serviceSince: string | undefined): PendingRestartState {
  const state = readPendingRestart()
  if (state.items.length === 0 || state.at === undefined || serviceSince === undefined) return state
  const since = Date.parse(serviceSince)
  const recorded = Date.parse(state.at)
  if (Number.isNaN(since) || Number.isNaN(recorded)) return state
  // 留 5s 余量：记录时间与服务启动时间的边界不值得较真。
  if (since <= recorded + 5000) return state
  return clearPendingRestart('service-restarted@' + serviceSince)
}
