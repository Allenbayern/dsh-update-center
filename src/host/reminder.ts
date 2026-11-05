/**
 * 提醒（侧栏角标 + 面板状态条）的判定逻辑：纯函数，方便单测。
 *
 * 口径（2026-11-04 用户定）：
 *   ① **只提醒「有新版」**：DSH 本体有可升级版本 → 状态提示；registry 插件有可更新 → 数字角标；
 *   ② **可转线上（本地源 → registry）不进提醒**：那是可选动作，不是「新版本可用」；
 *   ③ 「大版本」判定按 semver：major 变化，或 0.x 下 minor 变化（0.x 的 minor 是 breaking）。
 */
import type { ReminderState, Snapshot } from '../shared/types.js'
import { compareVersions } from './semver.js'

export type VersionLevel = 'major' | 'minor' | 'patch' | 'prerelease' | 'same'

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: boolean
}

function parseVersion(version: string | undefined): ParsedVersion | undefined {
  if (version === undefined) return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  }
}

/** from → to 的升级级别；to 不高于 from 返回 same。 */
export function versionLevel(from: string | undefined, to: string | undefined): VersionLevel {
  if (from === undefined || to === undefined) return 'same'
  if (compareVersions(to, from) <= 0) return 'same'
  const a = parseVersion(from)
  const b = parseVersion(to)
  if (a === undefined || b === undefined) return 'patch'
  if (b.major > a.major) return 'major'
  // 0.x：minor 就是 breaking（semver 约定），按「大版本」提醒。
  if (a.major === 0 && b.minor > a.minor) return 'major'
  if (b.minor > a.minor) return 'minor'
  if (b.patch > a.patch) return 'patch'
  return 'prerelease'
}

export function levelLabel(level: VersionLevel): string {
  switch (level) {
    case 'major':
      return '大版本'
    case 'minor':
      return '次版本'
    case 'patch':
      return '补丁版'
    case 'prerelease':
      return '预发布'
    default:
      return ''
  }
}

export interface ReminderContext {
  /** 现在是否有扫描在跑（角标可以先显示上次结果，同时说明还在刷新）。 */
  scanning?: boolean
  ageSeconds?: number
}

/** 从快照算出提醒。快照可能是 undefined（还没扫过）。 */
export function reminderFrom(snapshot: Snapshot | undefined, context: ReminderContext = {}): ReminderState {
  const base: ReminderState = {
    hasData: snapshot !== undefined,
    scanning: context.scanning === true,
    ...(context.ageSeconds === undefined ? {} : { ageSeconds: context.ageSeconds }),
    core: { hasUpdate: false },
    plugins: { count: 0, previewOnly: 0, names: [] },
    pendingRestart: 0,
    convertible: 0,
  }
  if (snapshot === undefined) return base

  const core = snapshot.core
  const stableTarget = core.channels?.stable?.version
  const previewTarget = core.channels?.preview?.version
  const current = core.version
  // 优先正式版；正式版没有更新时再看预览版（与面板的 coreCandidate 同口径）。
  const useStable = stableTarget !== undefined && current !== undefined && compareVersions(stableTarget, current) > 0
  const usePreview =
    !useStable && previewTarget !== undefined && current !== undefined && compareVersions(previewTarget, current) > 0
  const target = useStable ? stableTarget : usePreview ? previewTarget : undefined
  const level = target === undefined ? 'same' : versionLevel(current, target)

  const plugins = snapshot.bundles.filter((row) => row.providedByCore !== true)
  const updates = plugins.filter((row) => row.status === 'update')
  const previewOnly = plugins.filter((row) => row.status === 'preview-only')
  const pending = snapshot.pendingRestart ?? []
  const convertible = [...plugins, ...(snapshot.injected ?? [])].filter((row) => row.upstream?.convertible === true).length

  return {
    hasData: true,
    scanning: context.scanning === true,
    ...(context.ageSeconds === undefined ? {} : { ageSeconds: context.ageSeconds }),
    ...(snapshot.generatedAt === undefined ? {} : { generatedAt: snapshot.generatedAt }),
    core: {
      hasUpdate: target !== undefined,
      ...(current === undefined ? {} : { current }),
      ...(target === undefined ? {} : { target }),
      ...(target === undefined ? {} : { channel: useStable ? ('stable' as const) : ('preview' as const) }),
      ...(target === undefined ? {} : { level }),
      ...(target === undefined ? {} : { label: levelLabel(level) }),
    },
    plugins: {
      // 角标只算「有正式版可更新」的：仅预览版是可选，不打扰。
      count: updates.length,
      previewOnly: previewOnly.length,
      names: updates.slice(0, 8).map((row) => row.name),
    },
    pendingRestart: pending.length,
    convertible,
  }
}
