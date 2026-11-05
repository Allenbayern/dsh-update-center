/** 更新中心在宿主与浏览器之间共享的数据形状（纯类型，无运行时依赖）。 */

export type SourceKind = 'core' | 'npm' | 'link' | 'git' | 'tarball' | 'local' | 'injected'

export const SOURCE_LABEL: Record<SourceKind, string> = {
  core: '本体',
  npm: 'npm',
  link: '本地链接',
  git: 'git',
  tarball: '压缩包',
  local: '本地目录',
  injected: '注入',
}

/** 一个通道上可落到的那一版。 */
export interface ChannelHit {
  version: string
  tags: string[]
  publishedAt?: string
  deprecated?: string
}

export type RowStatus =
  /** 已是最新（没有更新的版本）。 */
  | 'latest'
  /** 有更新的正式版可装。 */
  | 'update'
  /** 正式版没有更新，只有预览版更新。 */
  | 'preview-only'
  /** 本地版本已领先上游（比最新发布还新）。 */
  | 'local-ahead'
  /** 上游不可查（未联网 / 私有包）。 */
  | 'unknown'
  /** 非 registry 源，本插件不查上游。 */
  | 'not-registry'

/**
 * 上游（registry）对这个非 npm 条目的回答：能不能一键转成线上依赖。
 *
 * 本地链接 / git / 压缩包 / 注入这四种源，只要同名包在上游发布过、且版本不低于本地，
 * 就能用 `pluginManager.installBundle('<name>@<version>')` 把依赖规格改写成 registry 版本。
 */
export interface UpstreamProbe {
  /** 上游查得到同名包。 */
  found: boolean
  /** 上游最新版本（`latest` 优先）。 */
  version?: string
  /** 上游这一版是否声明 `dsh.bundle`（能作为套件装上）。 */
  bundle?: boolean
  /** 上游版本相对本地：newer / same / older。 */
  position?: 'newer' | 'same' | 'older' | 'unknown'
  /** 能不能一键转线上——也就是按钮出不出现。 */
  convertible: boolean
  /** 不能转时给用户看的一句话。 */
  reason?: string
  /** 上游这一版的 tarball 地址（本地改动比对用）。 */
  tarballUrl?: string
}

/**
 * 本地目录 vs 上游同版本 tarball 的逐文件比对结果。
 *
 * 为什么要有这个：`link:` / 注入这些源，版本号可能跟上游一模一样，但内容早就被本地改过
 * （打补丁、改构建产物、加功能）。只看版本号就点「转线上」，等于把本地改动静默扔掉。
 */
export interface LocalDelta {
  /** identical = 与上游逐文件一致；modified = 有本地改动；unknown = 没比成。 */
  status: 'identical' | 'modified' | 'unknown'
  /** 比对的上游版本。 */
  version?: string
  /** 差异文件（内容不同的优先，最多列 12 个）。 */
  changedFiles?: string[]
  /** 差异总数（内容不同 + 仅本地有 + 仅上游有）。 */
  changedCount?: number
  /** 同路径但内容不同的文件数——这是「本地改过」的硬证据。 */
  modifiedCount?: number
  /** 只在本地目录里有的文件数（文档、测试、本地新增）。 */
  localOnlyCount?: number
  /** 只在上游包里的文件数（本地删过，或上游新加）。 */
  upstreamOnlyCount?: number
  /** 没比成的原因。 */
  reason?: string
}

export interface UpdateRow {
  name: string
  kind: 'core' | 'bundle' | 'injected'
  installed?: string
  sourceKind: SourceKind
  source?: string
  enabled?: boolean
  /** pluginManager 是否接受对它执行 updateBundle。 */
  updatable: boolean
  /** 正式版（无 prerelease 后缀的最新版）。 */
  stable?: ChannelHit
  /** 预览版（含 alpha / beta / rc 的最新版）。 */
  preview?: ChannelHit
  /** 上游还有多少版比本地新（含被省略的）。 */
  newerCount?: number
  status: RowStatus
  detail?: string
  fiberPhase?: string | null
  diagnostic?: string
  /** 由 DSH 安装本体提供（management-required），随本体升级，不单独更新。 */
  providedByCore?: boolean
  /** 非 npm 源的上游探测结果（npm 源本来就能查，这里留空）。 */
  upstream?: UpstreamProbe
  /** 本地目录与上游同版本的逐文件比对（只在可转线上时才算）。 */
  localDelta?: LocalDelta
}

export interface CoreFacts {
  name: string
  version?: string
  root?: string
  /** 运行时目录（含 package.json 的安装根，如 ~/dsh-runtime）。 */
  runtimeDir?: string
  /** 是否具备一键更新条件（运行时目录可写 + 服务名可停起）。 */
  updatable?: boolean
  registry?: string
  /** npm dist-tags 原样回传（latest / alpha / next …）。 */
  distTags?: Record<string, string>
  /** 按 dist-tag 推导出的两条通道。 */
  channels: { stable?: ChannelHit; preview?: ChannelHit }
  reachable: boolean
  /** 本地相对上游的位置：local-ahead / update / preview-only / latest / unknown。 */
  status: RowStatus
}

export interface EnvFacts {
  node: string
  platform: string
  arch: string
  dshHome: string
  profileDir?: string
  pnpm?: string
  git?: string
  service: { name: string; active?: string; since?: string }
  os?: string
  upgradable?: { count?: number; sample: string[]; error?: string }
  /** 只有点了“深度检查”才跑系统包查询。 */
  deepChecked: boolean
}

export interface InjectionFacts {
  registryPath: string
  entries: { name: string; version?: string; dir?: string; injectedAt?: string }[]
}

export interface Snapshot {
  generatedAt: string
  cached: boolean
  registry: string
  core: CoreFacts
  bundles: UpdateRow[]
  /** DSH 安装本体自带的包：随本体升级，不由用户单独更新。 */
  coreProvided: UpdateRow[]
  injected: UpdateRow[]
  env: EnvFacts
  summary: {
    stableUpdates: number
    previewUpdates: number
    scannedBundles: number
    skippedBundles: number
    /** 非 registry 条目里能一键转线上的个数。 */
    convertible?: number
    /** 已装好但需要重启才生效的个数。 */
    pendingRestart?: number
  }
  /**
   * true = 只读了本机事实（装了什么、什么源、什么版本），上游版本还没查。
   * 面板靠它先画出骨架，再补上「有没有新版」。
   */
  partial?: boolean
  /** true = 后台正在刷新完整快照，客户端过一两秒重取即可。 */
  refreshing?: boolean
  /** 这份快照已经放了多久（秒）。 */
  ageSeconds?: number
  /** 已装好但需要重启 DSH 才生效的条目。 */
  pendingRestart?: PendingRestartItem[]
  warnings: string[]
}

/** 侧栏角标与面板状态条共用的一份轻量提醒（不含版本明细，只有「有没有 / 有几个」）。 */
export interface ReminderState {
  /** 是否已经有扫描数据（false = 还没扫过，角标先不显示）。 */
  hasData: boolean
  /** 后台是否正在刷新（角标先显示上次结果）。 */
  scanning: boolean
  /** 上次扫描距今多少秒。 */
  ageSeconds?: number
  generatedAt?: string
  core: {
    hasUpdate: boolean
    current?: string
    target?: string
    channel?: 'stable' | 'preview'
    level?: 'major' | 'minor' | 'patch' | 'prerelease' | 'same'
    label?: string
  }
  plugins: {
    /** 有正式版可更新的插件数（角标数字）。 */
    count: number
    /** 仅预览版可更新的插件数（不打扰，只在面板里说）。 */
    previewOnly: number
    /** 前几个包名（悬停提示用）。 */
    names: string[]
  }
  /** 装好了但要重启才生效的个数。 */
  pendingRestart: number
  /** 可转线上的个数——**只统计、不提醒**（用户明确要求可转的不提示）。 */
  convertible: number
}

/** 一条「装好了，但要重启 DSH 才生效」的记录。 */
export interface PendingRestartItem {
  name: string
  from?: string
  to?: string
  at: string
  /** 为什么必须重启（pluginManager 的 restartReason）。 */
  reason?: string
}

export interface PendingRestartState {
  items: PendingRestartItem[]
  /** 最近一次记录时间；服务启动时间晚于它，就说明重启过了。 */
  at?: string
  clearedAt?: string
  clearedBy?: string
}

/** 非 registry 条目 → 线上（registry）依赖的结果。 */
export interface ConvertResult {
  ok: boolean
  name?: string
  from?: string
  to?: string
  application?: string
  restartReason?: string
  message?: string
  /** 注入条目转线上后，注入那一份还在，需要用户手动解除（重复加载会打架）。 */
  needsUninject?: boolean
  /** 转换前的本地改动比对结果（本地有改动时要求 confirmOverwrite）。 */
  localDelta?: LocalDelta
  packageResult?: { exitCode: number; kind?: string; output?: string; logPath?: string }
}

/** 重启 dsh.service 的一次执行。 */
export interface ServiceRestartRun {
  runId: string
  phase: 'launching' | 'restarting' | 'health' | 'done' | 'failed' | string
  ok?: boolean
  message?: string
  startedAt: string
  updatedAt?: string
  finishedAt?: string
  logPath?: string
  unit?: string
  serviceName?: string
}

export interface ApplyResult {
  ok: boolean
  name?: string
  from?: string
  to?: string
  application?: string
  restartReason?: string
  message?: string
  packageResult?: { exitCode: number; kind?: string; output?: string; logPath?: string }
}

export interface LogEntry {
  seq: number
  at: number
  kind: 'log' | 'state'
  stream?: string
  text: string
}

// ── 一键更新所有插件：串行队列 ──────────────────────────────────────────────

export type BatchChannel = 'stable' | 'preview'

export interface BatchItem {
  name: string
  from?: string
  to: string
  channel: BatchChannel
  /** warn = 已装好但要重启才生效（不是失败，也不算热更新成功）。 */
  status: 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped'
  message?: string
  application?: string
}

export interface BatchState {
  id: string
  startedAt: number
  finishedAt?: number
  running: boolean
  cancelled: boolean
  channel: BatchChannel
  total: number
  done: number
  current?: string
  items: BatchItem[]
  summary: { ok: number; warn: number; failed: number; skipped: number }
}

// ── 一键更新 DSH 本体：瞬态单元执行 + 失败回滚 ──────────────────────────────

export type CorePhase =
  | 'launching'
  | 'preflight'
  | 'backup'
  | 'stop'
  | 'install'
  | 'start'
  | 'health'
  | 'rollback'
  | 'done'
  | 'failed'

export interface CoreRunState {
  runId: string
  target: string
  from?: string
  phase: CorePhase | string
  ok?: boolean
  message?: string
  rolledBack?: boolean
  startedAt: string
  updatedAt?: string
  finishedAt?: string
  logPath?: string
  runtimeDir?: string
  unit?: string
}

export interface HistoryEntry {
  at: string
  kind: 'single' | 'batch' | 'core' | 'convert' | 'restart' | 'docker' | 'apt' | 'toolchain' | 'venv'
  name?: string
  from?: string
  to?: string
  ok: boolean
  application?: string
  message?: string
}

// ── 跨节点 Docker 容器与 APT 系统补丁管理 ───────────────────────────────────

export type DockerContainerStatus = 'latest' | 'update' | 'locked' | 'error'

export interface DockerContainerRow {
  node: string
  nodeLabel: string
  name: string
  image: string
  statusText: string
  localDigest?: string
  remoteDigest?: string
  composeDir?: string
  composeService?: string
  composeConfig?: string
  status: DockerContainerStatus
  lockReason?: string
  detail?: string
}

export interface AptPackageRow {
  node: string
  nodeLabel?: string
  name: string
  installed: string
  candidate: string
  locked: boolean
  lockReason?: string
}

export interface AptNodeSummary {
  node: string
  label: string
  isProxmox?: boolean
  packages: AptPackageRow[]
  safeUpdatableCount: number
  lockedCount: number
}

export interface ToolchainRow {
  id: string
  name: string
  category: 'cli' | 'npm-global' | 'uv-tool' | 'desktop'
  installed: string
  latest?: string
  status: 'latest' | 'update' | 'locked' | 'error'
  detail?: string
}

export interface VenvPackageItem {
  name: string
  installed: string
  latest: string
  safe: boolean
  lockReason?: string
}

export interface ProjectVenvRow {
  id: string
  project: string
  venvPath: string
  pythonVersion: string
  outdatedCount: number
  safeUpdatableCount: number
  packages: VenvPackageItem[]
}

export interface InfraSnapshot {
  generatedAt: string
  docker: {
    engines: Record<string, string>
    containers: DockerContainerRow[]
    updatableCount: number
    lockedCount: number
  }
  apt: {
    vm100: AptPackageRow[]
    pve: AptPackageRow[]
    nodes?: AptNodeSummary[]
    safeUpdatableCount: number
    lockedCount: number
  }
  toolchain?: {
    items: ToolchainRow[]
    updatableCount: number
  }
  venvs?: {
    projects: ProjectVenvRow[]
    totalSafeUpdatable: number
  }
}
