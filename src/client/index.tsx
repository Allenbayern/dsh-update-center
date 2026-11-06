/**
 * 左侧栏「更新中心」面板。
 *
 * 版式原则（2026-11-04 重排）：**一屏只留三件事**——有什么能更新、需要重启的在哪、下一步点哪个按钮。
 * 版本号与来源压成一行小字，技术细节全部收进可展开区；主操作按钮至少 32px 高，一眼能找到。
 *
 * 加载策略：先画本机事实（装了什么 / 什么源 / 什么版本，几百毫秒），上游版本由宿主后台补齐，
 * 面板轮询到新快照再替换——所以点开就有东西看，不再等一次十几秒的全量扫描。
 *
 * 本体更新会重启 dsh.service，重启期间所有 fetch 都会失败——这不是错误，面板显示「服务重启中」并继续轮询。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ApplyResult,
  AptPackageRow,
  BatchState,
  CleanupItemRow,
  ConvertResult,
  CoreRunState,
  DockerContainerRow,
  EnvFacts,
  GitRepoRow,
  HistoryEntry,
  InfraSnapshot,
  PendingRestartItem,
  ProjectVenvRow,
  ReminderState,
  Snapshot,
  SystemdUnitRow,
  ToolchainRow,
  UpdateRow,
} from '../shared/types.js'
import { reminderFrom } from '../host/reminder.js'
import { HERO_BANNER_DATA_URL } from './heroBanner.js'

export const name = '@dsh-external/dsh-update-center/client'
export const inject = ['slots']

const PANEL_ID = 'dsh-update-center'
const API = 'api/dsh-update-center'
const PANEL_ORDER = 15

const C = {
  base: 'var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-0, #111318))',
  text: 'var(--dsw-alias-label-primary, #111827)',
  dim: 'var(--dsw-alias-label-secondary, #6b7280)',
  line: 'var(--dsw-alias-border-l1, rgba(120,120,120,.22))',
  line2: 'var(--dsw-alias-border-l2, rgba(120,120,120,.42))',
  layer1: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))',
  layer2: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))',
  brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
  ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
  err: 'var(--dsw-alias-state-error-primary, #dc2626)',
  idle: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
  onBrand: '#ffffff',
} as const

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

const SOURCE_TEXT: Record<string, string> = {
  core: '本体',
  npm: 'npm',
  link: '本地链接',
  git: 'git',
  tarball: '压缩包',
  local: '本地目录',
  injected: '注入',
}

// ── 基础控件 ────────────────────────────────────────────────────────────────

type BtnTone = 'primary' | 'default' | 'danger' | 'ghost'

function Btn({
  children,
  onClick,
  disabled,
  tone = 'default',
  size = 'md',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: BtnTone
  size?: 'md' | 'lg' | 'sm'
  title?: string
}) {
  const height = size === 'lg' ? 36 : size === 'sm' ? 28 : 32
  const font = size === 'lg' ? 13.5 : size === 'sm' ? 12 : 12.5
  const filled = tone === 'primary' && disabled !== true
  const color = disabled === true ? C.dim : filled ? '#ffffff' : tone === 'danger' ? C.err : C.text
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        WebkitAppearance: 'none',
        height,
        padding: size === 'sm' ? '0 11px' : '0 15px',
        borderRadius: 8,
        border: '1px solid ' + (disabled === true ? C.line : filled ? '#2563eb' : tone === 'danger' ? C.err : C.line2),
        backgroundColor:
          disabled === true
            ? C.layer1
            : filled
              ? '#2563eb'
              : tone === 'ghost'
                ? 'transparent'
                : C.layer2,
        backgroundImage: filled ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)' : 'none',
        color,
        fontSize: font,
        fontWeight: filled ? 600 : 500,
        lineHeight: 1,
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
        opacity: disabled === true ? 0.55 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        boxShadow: filled ? '0 2px 8px rgba(37,99,235,.28)' : 'none',
        transition: 'all .15s ease',
      }}
    >
      {children}
    </button>
  )
}

function Tag({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 550,
        lineHeight: '15px',
        letterSpacing: 0.2,
        color: tone,
        border: `1px solid ${tone}`,
        backgroundColor: C.layer1,
        background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      style={{
        border: '1px solid ' + C.line,
        borderRadius: 14,
        background: C.layer1,
        color: C.text,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 2px 10px rgba(0,0,0,.04)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px 10px',
          borderBottom: '1px solid ' + C.line,
          background: `color-mix(in srgb, ${C.layer2} 55%, transparent)`,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 650, letterSpacing: 0.2, color: C.text }}>{title}</h3>
        {count === undefined ? null : (
          <span
            style={{
              fontSize: 11,
              color: C.dim,
              padding: '1px 7px',
              borderRadius: 999,
              background: C.layer2,
              border: '1px solid ' + C.line,
            }}
          >
            {count}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{action}</span>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 16px 12px', color: C.text }}>{children}</div>
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
  hint,
  icon,
  active,
  onClick,
}: {
  label: string
  value: string | number
  tone: string
  hint?: string
  icon?: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      style={{
        flex: '1 1 0',
        minWidth: 135,
        border: '1px solid ' + (active ? '#2563eb' : C.line),
        borderTop: `3px solid ${active ? '#2563eb' : tone}`,
        borderRadius: 12,
        backgroundColor: C.layer1,
        background: active ? `color-mix(in srgb, ${C.brand} 14%, ${C.layer1})` : C.layer1,
        color: C.text,
        padding: '11px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: active ? '0 4px 14px rgba(59,130,246,.16)' : '0 1px 4px rgba(0,0,0,.03)',
        transition: 'all .16s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 11.5, color: active ? C.brand : C.dim, fontWeight: active ? 650 : 500 }}>{label}</span>
        {icon ? <span style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span> : null}
      </div>
      <span style={{ fontSize: 20, fontWeight: 700, color: tone, lineHeight: '26px', letterSpacing: -0.2 }}>{value}</span>
      {hint === undefined ? null : (
        <span style={{ fontSize: 11, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</span>
      )}
    </div>
  )
}

function Row({ children, last }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 0',
        borderBottom: last === true ? 'none' : '1px solid ' + C.line,
        flexWrap: 'wrap',
        color: C.text,
      }}
    >
      {children}
    </div>
  )
}

function Name({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontFamily: MONO,
        fontSize: 13,
        fontWeight: 600,
        color: C.text,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
      }}
    >
      {children}
    </span>
  )
}

function Meta({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 11.5,
        color: C.dim,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{children}</span>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: C.dim, padding: '8px 0' }}>{children}</div>
}

// ── 状态文案 ────────────────────────────────────────────────────────────────

function rowLine(row: UpdateRow): string {
  const local = row.installed ?? '未知'
  if (row.status === 'update' && row.stable !== undefined) return '本地 ' + local + ' → ' + row.stable.version
  if (row.status === 'preview-only' && row.preview !== undefined) return '本地 ' + local + ' → ' + row.preview.version + '（仅预览版）'
  if (row.status === 'latest') return local + ' · 已是最新'
  if (row.status === 'local-ahead') return local + ' · 本地领先上游'
  if (row.status === 'unknown') return local + ' · 上游待查' + (row.detail === undefined ? '' : '（' + row.detail + '）')
  return local
}

function sourceTone(kind: string): string {
  if (kind === 'npm') return C.ok
  if (kind === 'injected') return C.warn
  return C.idle
}

/**
 * 侧栏角标的数据源：轻量轮询 `/badge`（几百字节，命中缓存，不触发同步扫描）。
 * 60 秒一次；服务重启中断时静默跳过，下次再取。
 */
function useReminder(): ReminderState | undefined {
  const [state, setState] = useState<ReminderState | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const data = await apiJson('/badge')
        if (alive && data !== null && typeof data === 'object' && data.core !== undefined) {
          setState(data as ReminderState)
        }
      } catch {
        /* 服务重启期间连不上：保留旧角标，下次再试 */
      }
    }
    void pull()
    const timer = setInterval(pull, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return state
}

/** 角标/状态条的一句话说明。 */
function reminderText(reminder: ReminderState | undefined): string {
  if (reminder === undefined || reminder.hasData !== true) return '更新中心'
  const parts: string[] = []
  if (reminder.core.hasUpdate) {
    parts.push(
      'DSH 本体可升级到 ' +
        (reminder.core.target ?? '') +
        (reminder.core.label === undefined ? '' : '（' + reminder.core.label + '）'),
    )
  }
  if (reminder.plugins.count > 0) {
    parts.push(
      reminder.plugins.count +
        ' 个插件可更新' +
        (reminder.plugins.names.length === 0 ? '' : '：' + reminder.plugins.names.slice(0, 5).join('、')),
    )
  }
  if (reminder.pendingRestart > 0) parts.push(reminder.pendingRestart + ' 个需重启才生效')
  return parts.length === 0 ? '已是最新' : parts.join(' · ')
}

function fmtTime(iso: string | undefined): string {
  if (iso === undefined) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

function fmtAge(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  if (seconds < 60) return seconds + ' 秒前'
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前'
  return Math.round(seconds / 3600) + ' 小时前'
}

const CORE_PHASE_TEXT: Record<string, string> = {
  launching: '启动更新单元',
  preflight: '预检',
  backup: '备份配置',
  stop: '停止服务',
  install: '安装新版本',
  start: '启动服务',
  health: '健康检查',
  rollback: '失败回滚',
  done: '完成',
  failed: '失败',
}

function isCoreRunning(run: CoreRunState | undefined): boolean {
  if (run === undefined) return false
  return run.phase !== 'done' && run.phase !== 'failed'
}

async function apiJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(API + path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...init?.headers },
  })
  const text = await response.text()
  let body: any
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    body = { error: text.slice(0, 500) }
  }
  if (!response.ok) throw new Error(String(body?.error ?? body?.message ?? 'HTTP ' + response.status))
  return body
}

interface Outcome {
  ok: boolean
  title: string
  detail?: string
  output?: string
}

// ── 需要重启的横幅 ──────────────────────────────────────────────────────────

function RestartBanner({
  items,
  restarting,
  busy,
  allow,
  onRestart,
  onLater,
}: {
  items: PendingRestartItem[]
  restarting: boolean
  busy: boolean
  allow: boolean
  onRestart: () => void
  onLater: () => void
}) {
  return (
    <div
      style={{
        border: '1px solid ' + C.warn,
        borderLeft: '4px solid ' + C.warn,
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: C.layer1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 650, color: C.warn }}>
          {restarting ? '服务正在重启，等它回来…' : items.length + ' 个包已装好，但需要重启 DSH 才生效'}
        </span>
        <Actions>
          <Btn tone="primary" disabled={restarting || busy || !allow} onClick={onRestart} title="脚本跑在独立 systemd 单元里，停服不会杀掉它自己">
            {restarting ? '重启中…' : '立即重启 dsh.service'}
          </Btn>
          <Btn tone="ghost" size="sm" disabled={restarting} onClick={onLater}>
            稍后
          </Btn>
        </Actions>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
        {items.map((item) => (
          <span key={item.name} style={{ fontFamily: MONO, fontSize: 11.5, color: C.dim }}>
            {item.name} {item.from ?? '?'} → {item.to ?? '?'}
          </span>
        ))}
      </div>
      {restarting ? null : (
        <Meta>
          重启会中断当前会话与隧道 10–30 秒；不想现在重启就点「稍后」，包会在下次重启后自然生效。
        </Meta>
      )}
    </div>
  )
}

// ── 本体 ────────────────────────────────────────────────────────────────────

function coreCandidate(core: Snapshot['core']): { version: string; channel: 'stable' | 'preview' } | undefined {
  if (core.status === 'update' && core.channels.stable !== undefined) return { version: core.channels.stable.version, channel: 'stable' }
  if (core.status === 'preview-only' && core.channels.preview !== undefined) return { version: core.channels.preview.version, channel: 'preview' }
  return undefined
}

function CoreLogBox({ runId, path, kind }: { runId: string; path: string; kind: 'core' | 'restart' }) {
  const [text, setText] = useState('')
  const load = useCallback(async () => {
    try {
      const data =
        kind === 'core'
          ? await apiJson('/core-update/log?runId=' + encodeURIComponent(runId))
          : await apiJson('/restart-service?runId=' + encodeURIComponent(runId))
      setText(String(data?.log ?? ''))
    } catch (error) {
      setText(String(error))
    }
  }, [runId, kind])
  return (
    <details
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load()
      }}
    >
      <summary style={{ cursor: 'pointer', color: C.dim, fontSize: 11.5 }}>看日志</summary>
      <pre
        style={{
          margin: '6px 0 0',
          maxHeight: 180,
          overflow: 'auto',
          fontFamily: MONO,
          fontSize: 11,
          color: C.dim,
          background: C.layer2,
          borderRadius: 6,
          padding: 8,
          whiteSpace: 'pre-wrap',
        }}
      >
        {text === '' ? path : text}
      </pre>
    </details>
  )
}

function CoreSection({
  snapshot,
  coreRun,
  restartRun,
  confirming,
  launching,
  anyBusy,
  onAskCore,
  onCancelCore,
  onLaunchCore,
}: {
  snapshot: Snapshot
  coreRun: CoreRunState | undefined
  restartRun: any
  confirming: string | undefined
  launching: boolean
  anyBusy: boolean
  onAskCore: (version: string) => void
  onCancelCore: () => void
  onLaunchCore: (version: string) => void
}) {
  const core = snapshot.core
  const installed = core.version
  const candidate = coreCandidate(core)
  const running = isCoreRunning(coreRun)
  const versionText = (value: string | undefined, tone: string) => (
    <span style={{ fontFamily: MONO, fontSize: 15, color: value === undefined ? C.idle : tone }}>{value ?? '—'}</span>
  )

  return (
    <Section
      title="DSH 本体"
      count={core.reachable ? undefined : '上游未查'}
      action={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {versionText(installed, C.text)}
          {candidate === undefined ? (
            <Tag tone={C.ok}>已最新</Tag>
          ) : (
            <Btn
              tone="primary"
              disabled={anyBusy}
              onClick={() => onAskCore(candidate.version)}
              title="备份 → 停服 → 安装 → 重启 → 健康检查 → 失败自动回滚"
            >
              {launching || running ? '⏳ 更新本体中…' : anyBusy ? '⏸ 等待当前任务…' : `更新到 ${candidate.version}`}
            </Btn>
          )}
        </span>
      }
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingBottom: 10 }}>
        <div style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 11.5, color: C.dim }}>当前安装</span>
          {versionText(installed, C.text)}
        </div>
        <div style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 11.5, color: C.dim }}>上游正式版</span>
          {versionText(core.channels.stable?.version, C.brand)}
        </div>
        <div style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 11.5, color: C.dim }}>上游预览版</span>
          {versionText(core.channels.preview?.version, C.warn)}
        </div>
      </div>

      {running ? (
        <div style={{ border: '1px solid ' + C.brand, borderRadius: 8, padding: '10px 12px', fontSize: 12.5 }}>
          <div style={{ color: C.brand, fontWeight: 600 }}>
            {coreRun?.from ?? installed} → {coreRun?.target ?? ''}：{CORE_PHASE_TEXT[coreRun?.phase ?? ''] ?? coreRun?.phase ?? ''}
          </div>
          <Meta>服务会重启，期间连不上属正常；恢复后本页自动读回结果。</Meta>
        </div>
      ) : coreRun?.phase === 'done' || coreRun?.phase === 'failed' ? (
        <div
          style={{
            border: '1px solid ' + (coreRun.ok === true ? C.ok : C.err),
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 12.5,
          }}
        >
          <span style={{ color: coreRun.ok === true ? C.ok : C.err, fontWeight: 600 }}>
            上次本体更新 {coreRun.from ?? '?'} → {coreRun.target}：{coreRun.ok === true ? '成功' : '失败'}
            {coreRun.rolledBack === true ? '（已自动回滚）' : ''}
          </span>
          <Meta>
            {(coreRun.message ?? '') + ' · ' + fmtTime(coreRun.finishedAt ?? coreRun.updatedAt)}
          </Meta>
          <CoreLogBox runId={coreRun.runId} path={coreRun.logPath ?? ''} kind="core" />
        </div>
      ) : restartRun?.phase === 'done' || restartRun?.phase === 'failed' ? (
        <Meta>
          上次重启：{restartRun.phase === 'done' ? '成功' : '失败'} · {String(restartRun.message ?? '')} · {fmtTime(String(restartRun.finishedAt ?? restartRun.updatedAt ?? ''))}
        </Meta>
      ) : null}

      {confirming === undefined ? null : (
        <div
          style={{
            border: '1px solid ' + C.err,
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginTop: 10,
          }}
        >
          <span style={{ fontSize: 13.5, fontWeight: 600, color: C.err }}>确认把本体更新到 {confirming}？</span>
          <Meta>
            备份 → 停止 {snapshot.env.service.name} → 安装 → 启动 → 健康检查；期间服务中断 10–30 秒，当前会话会断，失败自动回滚到 {installed ?? '旧版本'}。
          </Meta>
          <span style={{ display: 'flex', gap: 8 }}>
            <Btn tone="primary" disabled={launching} onClick={() => onLaunchCore(confirming)}>
              {launching ? '启动中…' : '确认执行'}
            </Btn>
            <Btn tone="ghost" disabled={launching} onClick={onCancelCore}>
              取消
            </Btn>
          </span>
        </div>
      )}
    </Section>
  )
}

// ── 批量进度 ────────────────────────────────────────────────────────────────

function BatchCard({ batch, onCancel }: { batch: BatchState; onCancel: () => void }) {
  const percent = batch.total === 0 ? 0 : Math.round((batch.done / batch.total) * 100)
  const tone = batch.summary.failed > 0 ? C.err : batch.summary.warn > 0 ? C.warn : batch.running ? C.brand : C.ok
  return (
    <Section
      title={batch.running ? '批量更新中' : '上次批量更新'}
      count={
        batch.done +
        '/' +
        batch.total +
        ' · 成功 ' +
        batch.summary.ok +
        (batch.summary.warn > 0 ? ' · 需重启 ' + batch.summary.warn : '') +
        (batch.summary.failed > 0 ? ' · 失败 ' + batch.summary.failed : '')
      }
      action={batch.running ? <Btn size="sm" onClick={onCancel}>叫停</Btn> : <Tag tone={tone}>{batch.summary.failed > 0 ? '有失败项' : '已结束'}</Tag>}
    >
      <div style={{ height: 6, borderRadius: 999, background: C.layer2, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ width: percent + '%', height: '100%', background: tone, transition: 'width .3s' }} />
      </div>
      {batch.items.map((item) => {
        const color =
          item.status === 'ok' ? C.ok : item.status === 'warn' ? C.warn : item.status === 'failed' ? C.err : item.status === 'running' ? C.brand : C.dim
        const label =
          item.status === 'running' ? '更新中' : item.status === 'ok' ? '成功' : item.status === 'warn' ? '需重启' : item.status === 'failed' ? '失败' : item.status === 'skipped' ? '跳过' : '待处理'
        return (
          <Row key={item.name}>
            <span style={{ color, fontSize: 12, width: 48, flexShrink: 0 }}>{label}</span>
            <Name>{item.name}</Name>
            <Meta>
              {item.from ?? '?'} → {item.to}
            </Meta>
          </Row>
        )
      })}
    </Section>
  )
}

// ── 历史 ────────────────────────────────────────────────────────────────────

const HISTORY_KIND: Record<string, { text: string; tone: string }> = {
  core: { text: '本体', tone: C.warn },
  batch: { text: '批量', tone: C.brand },
  single: { text: '单项', tone: C.idle },
  convert: { text: '转线上', tone: C.brand },
  restart: { text: '重启', tone: C.warn },
  docker: { text: '容器', tone: C.brand },
  apt: { text: '系统包', tone: C.ok },
  toolchain: { text: '工具链', tone: C.brand },
  venv: { text: 'Python环境', tone: C.ok },
  git: { text: 'Git仓库', tone: C.brand },
  cleanup: { text: '瘦身清理', tone: C.ok },
  systemd: { text: 'Systemd', tone: C.warn },
}

function HistoryCard({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) return null
  return (
    <details style={{ border: '1px solid ' + C.line, borderRadius: 12, background: C.layer1, color: C.text, padding: '10px 16px' }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text }}>更新历史（最近 {entries.length} 条）</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {entries.map((entry, index) => {
          const kind = HISTORY_KIND[entry.kind] ?? { text: entry.kind, tone: C.idle }
          return (
            <div key={entry.at + index} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: MONO, color: C.dim }}>{entry.at.replace('T', ' ').slice(5, 19)}</span>
              <Tag tone={kind.tone}>{kind.text}</Tag>
              <Name>{entry.name ?? ''}</Name>
              <Meta>
                {entry.from ?? ''}
                {entry.from === undefined ? '' : ' → '}
                {entry.to ?? ''}
              </Meta>
              <span style={{ color: entry.ok ? C.ok : C.err, marginLeft: 'auto' }}>{entry.ok ? 'OK' : 'FAIL'}</span>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function LogBox() {
  const [text, setText] = useState('')
  const load = useCallback(async () => {
    try {
      const data = await apiJson('/log?since=0')
      const entries: { at: number; text: string }[] = data?.entries ?? []
      setText(entries.slice(-150).map((entry) => '[' + fmtTime(new Date(entry.at).toISOString()) + '] ' + entry.text).join(''))
    } catch (error) {
      setText(String(error))
    }
  }, [])
  return (
    <details
      style={{ border: '1px solid ' + C.line, borderRadius: 12, background: C.layer1, color: C.text, padding: '10px 16px' }}
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load()
      }}
    >
      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text }}>安装日志（pnpm 输出）</summary>
      <pre
        style={{
          margin: '8px 0 0',
          maxHeight: 200,
          overflow: 'auto',
          fontFamily: MONO,
          fontSize: 11,
          color: C.dim,
          background: C.layer2,
          borderRadius: 6,
          padding: 8,
          whiteSpace: 'pre-wrap',
        }}
      >
        {text === '' ? '（展开后读取）' : text}
      </pre>
    </details>
  )
}

// ── 环境 ────────────────────────────────────────────────────────────────────

function EnvSection({ env, deepLoading, onDeep }: { env: EnvFacts; deepLoading: boolean; onDeep: () => void }) {
  const item = (label: string, value: string | undefined, tone?: string) => (
    <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 140 }}>
      <span style={{ fontSize: 11, color: C.dim, width: 56, flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 12, color: tone ?? C.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value ?? '—'}</span>
    </div>
  )
  const active = env.service.active
  const serviceTone = active === 'active' ? C.ok : active === undefined ? C.idle : C.err
  return (
    <Section
      title="本机环境"
      action={
        <Btn size="sm" onClick={onDeep} disabled={deepLoading}>
          {deepLoading ? '检查中…' : '检查系统包'}
        </Btn>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', paddingBottom: 6 }}>
        {item('Node', env.node)}
        {item('pnpm', env.pnpm, env.pnpm === undefined ? C.err : C.text)}
        {item('服务', env.service.active, serviceTone)}
        {item('启动于', env.service.since)}
        {item('系统', env.os)}
        {item('家目录', env.dshHome)}
      </div>
      {env.upgradable === undefined ? null : env.upgradable.error !== undefined ? (
        <Empty>系统包检查失败：{env.upgradable.error}</Empty>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <Tag tone={(env.upgradable.count ?? 0) > 0 ? C.warn : C.ok}>可升级系统包 {env.upgradable.count ?? 0}</Tag>
          <Meta>可在下方「跨节点系统安全补丁 (APT)」一键安全更新</Meta>
        </div>
      )}
    </Section>
  )
}

type ViewTab =
  | 'overview'
  | 'dsh'
  | 'docker'
  | 'apt'
  | 'toolchain'
  | 'venv'
  | 'git'
  | 'cleanup'
  | 'systemd'
  | 'history'

function InfraSection({
  infra,
  loading,
  busyKey,
  anyBusy,
  completedKeys,
  activeTab,
  onlyActionable,
  onScan,
  onUpdateDocker,
  onUpdateApt,
  onUpdateToolchain,
  onUpdateVenv,
  onPullGit,
  onRunCleanup,
  onFixSystemd,
}: {
  infra: InfraSnapshot | undefined
  loading: boolean
  busyKey: string | undefined
  anyBusy: boolean
  completedKeys: Record<string, string>
  activeTab: ViewTab
  onlyActionable: boolean
  onScan: (refresh: boolean) => void
  onUpdateDocker: (node: string, name: string) => void
  onUpdateApt: (node: string) => void
  onUpdateToolchain: (id: string, name: string) => void
  onUpdateVenv: (projectId: string, projectName: string) => void
  onPullGit: (id: string, name: string) => void
  onRunCleanup: (id: string, name: string) => void
  onFixSystemd: (id: string, name: string) => void
}) {
  const [showLockedApt, setShowLockedApt] = useState(false)
  const containersAll = infra?.docker.containers ?? []
  const containers = onlyActionable ? containersAll.filter((c) => c.status !== 'latest') : containersAll
  const aptNodes = infra?.apt.nodes
  const aptAll: AptPackageRow[] =
    infra === undefined
      ? []
      : aptNodes !== undefined
        ? aptNodes.flatMap((n) => n.packages)
        : [...infra.apt.vm100, ...infra.apt.pve]
  const aptSafeList = aptAll.filter((p) => !p.locked)
  const aptLockedList = aptAll.filter((p) => p.locked)
  const updatableAptNodes: Array<{ node: string; label: string; count: number }> =
    aptNodes !== undefined
      ? aptNodes
          .filter((n) => n.safeUpdatableCount > 0)
          .map((n) => ({ node: n.node, label: n.label, count: n.safeUpdatableCount }))
      : [
          { node: 'vm100', label: 'VM100', count: infra?.apt.vm100.filter((p) => !p.locked).length ?? 0 },
          { node: 'pve', label: 'PVE', count: infra?.apt.pve.filter((p) => !p.locked).length ?? 0 },
        ].filter((x) => x.count > 0)
  const toolchainAll: ToolchainRow[] = infra?.toolchain?.items ?? []
  const toolchainItems = onlyActionable ? toolchainAll.filter((t) => t.status === 'update') : toolchainAll
  const toolchainUpdatable = infra?.toolchain?.updatableCount ?? 0
  const venvProjectsAll: ProjectVenvRow[] = infra?.venvs?.projects ?? []
  const venvProjects = onlyActionable
    ? venvProjectsAll.filter((v) => v.safeUpdatableCount > 0 || v.outdatedCount > 0)
    : venvProjectsAll
  const venvTotalSafe = infra?.venvs?.totalSafeUpdatable ?? 0

  const gitReposAll: GitRepoRow[] = infra?.gitRepos?.repos ?? []
  const gitRepos = onlyActionable ? gitReposAll.filter((r) => r.status !== 'latest') : gitReposAll
  const gitUpdatable = infra?.gitRepos?.updatableCount ?? 0
  const gitLocked = infra?.gitRepos?.lockedCount ?? 0

  const cleanupItemsAll: CleanupItemRow[] = infra?.cleanups?.items ?? []
  const cleanupItems = onlyActionable ? cleanupItemsAll.filter((c) => c.actionable) : cleanupItemsAll
  const cleanupActionable = infra?.cleanups?.actionableCount ?? 0
  const cleanupReclaimText = infra?.cleanups?.totalReclaimableText ?? '0 B'

  const systemdFailedAll: SystemdUnitRow[] = infra?.systemdHealth?.failedUnits ?? []
  const systemdTimersCount = infra?.systemdHealth?.activeTimersCount ?? 0

  const showDocker = activeTab === 'overview' || activeTab === 'docker'
  const showApt = activeTab === 'overview' || activeTab === 'apt'
  const showToolchain = activeTab === 'overview' || activeTab === 'toolchain'
  const showVenv = activeTab === 'overview' || activeTab === 'venv'
  const showGit = activeTab === 'overview' || activeTab === 'git'
  const showCleanup = activeTab === 'overview' || activeTab === 'cleanup'
  const showSystemd = activeTab === 'overview' || activeTab === 'systemd'

  const renderAptRow = (pkg: AptPackageRow, idx: number, total: number) => (
    <Row key={`${pkg.node}:${pkg.name}`} last={idx === total - 1}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180, flex: '1 1 200px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Tag tone={pkg.node === 'pve' ? C.warn : C.brand}>{pkg.nodeLabel ?? pkg.node.toUpperCase()}</Tag>
          <Name>{pkg.name}</Name>
          <Meta>
            {pkg.installed} → {pkg.candidate}
          </Meta>
        </span>
        {pkg.lockReason ? <Meta>{pkg.lockReason}</Meta> : null}
      </span>
      <Actions>
        <Tag tone={pkg.locked ? C.warn : C.brand}>{pkg.locked ? '门禁锁定' : '安全可更'}</Tag>
      </Actions>
    </Row>
  )

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: activeTab === 'overview' ? 'repeat(auto-fit, minmax(420px, 1fr))' : '1fr',
        gap: 14,
        alignItems: 'start',
      }}
    >
      {showDocker ? (
        <Section
          title="🐳 Docker 容器镜像审计 (自动发现本机与多节点)"
          count={
            infra === undefined
              ? '未加载'
              : `${containersAll.length} 个 · ${infra.docker.updatableCount} 可更 · ${infra.docker.lockedCount} 保护锁`
          }
          action={
            <Btn size="sm" onClick={() => onScan(true)} disabled={loading || anyBusy}>
              {loading ? '⏳ 探测中…' : '全量扫描运维组件'}
            </Btn>
          }
        >
          {infra === undefined ? (
            <Empty>点击右上角「全量扫描运维组件」自动探测本机与集群节点 Docker、APT、CLI 工具链与项目 .venv。</Empty>
          ) : containers.length === 0 ? (
            <Empty>{onlyActionable ? `所有非锁定容器均已是最新（切换上方「显示全部」可查看 ${containersAll.length} 个容器详情）。` : '未发现运行中的容器。'}</Empty>
          ) : (
            containers.map((row, idx) => {
              const key = `docker:${row.node}:${row.name}`
              const isBusy = busyKey === key
              const isCompleted = completedKeys[key] !== undefined
              const effectiveStatus = isCompleted ? 'latest' : row.status
              const tone =
                effectiveStatus === 'update' ? C.brand : effectiveStatus === 'locked' ? C.warn : effectiveStatus === 'latest' ? C.ok : C.err
              const label =
                effectiveStatus === 'update' ? '有新镜像' : effectiveStatus === 'locked' ? '已加锁保护' : effectiveStatus === 'latest' ? '已最新' : '探测异常'
              return (
                <Row key={`${row.node}:${row.name}`} last={idx === containers.length - 1}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 180, flex: '1 1 200px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={C.dim}>{row.nodeLabel}</Tag>
                      <Name>{row.name}</Name>
                      <Meta>{row.image}</Meta>
                    </span>
                    <Meta>{isCompleted ? '刚刚已完成拉取并重建，当前已是最新镜像' : (row.detail ?? row.statusText)}</Meta>
                  </span>
                  <Actions>
                    {isBusy ? (
                      <Btn size="sm" disabled title="当前容器正在拉取镜像并重建中，请稍候…">
                        ⏳ 拉取重建中…
                      </Btn>
                    ) : effectiveStatus === 'update' ? (
                      <Btn
                        tone="primary"
                        size="sm"
                        disabled={anyBusy}
                        title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : '拉取最新镜像并按原编排安全重建容器'}
                        onClick={() => onUpdateDocker(row.node, row.name)}
                      >
                        {anyBusy ? '⏸ 等待当前任务…' : '拉取并重建'}
                      </Btn>
                    ) : (
                      <Tag tone={tone}>{label}</Tag>
                    )}
                  </Actions>
                </Row>
              )
            })
          )}
        </Section>
      ) : null}

      {showApt ? (
        <Section
          title="🛡️ 系统安全补丁 (APT · 内核门禁保护)"
          count={
            infra === undefined
              ? '未加载'
              : `安全可更 ${infra.apt.safeUpdatableCount} 个 · 门禁锁定 ${infra.apt.lockedCount} 个`
          }
          action={
            <span style={{ display: 'flex', gap: 6 }}>
              {updatableAptNodes.map((n) => {
                const aptKey = `apt:${n.node}`
                const isAptBusy = busyKey === aptKey
                const isAptDone = completedKeys[aptKey] !== undefined
                if (isAptDone) {
                  return (
                    <Tag key={n.node} tone={C.ok}>
                      ✓ {n.label} 已升级
                    </Tag>
                  )
                }
                return (
                  <Btn
                    key={n.node}
                    size="sm"
                    tone="primary"
                    disabled={anyBusy}
                    title={isAptBusy ? `${n.label} 正在执行 APT 升级…` : anyBusy ? '当前有其他更新任务正在执行，请稍候' : `升级 ${n.label} 安全 APT 包`}
                    onClick={() => onUpdateApt(n.node)}
                  >
                    {isAptBusy ? `⏳ 更新 ${n.label} 中…` : anyBusy ? `⏸ 等待任务 (${n.label})` : `更新 ${n.label} (${n.count})`}
                  </Btn>
                )
              })}
            </span>
          }
        >
          {infra === undefined ? (
            <Empty>随运维组件扫描一并加载本机及宿主机 APT 软件包状态。</Empty>
          ) : aptAll.length === 0 ? (
            <Empty>所有系统软件包均为最新。</Empty>
          ) : (
            <>
              {aptSafeList.length === 0 ? (
                <Empty>✓ 所有用户态安全包均已是最新（0 待更）。</Empty>
              ) : (
                aptSafeList.map((pkg, idx) => renderAptRow(pkg, idx, aptSafeList.length))
              )}
              {aptLockedList.length > 0 ? (
                <div style={{ marginTop: 6, borderTop: '1px dashed ' + C.line, paddingTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12, color: C.warn, fontWeight: 500 }}>
                      🔒 内核/虚拟化/引导层门禁保护（{aptLockedList.length} 个包已锁定，需独立维护窗口）
                    </span>
                    <Btn size="sm" tone="ghost" onClick={() => setShowLockedApt((v) => !v)}>
                      {showLockedApt ? '收起锁定列表' : `展开查看 (${aptLockedList.length})`}
                    </Btn>
                  </div>
                  {showLockedApt ? (
                    <div style={{ marginTop: 6, maxHeight: 260, overflowY: 'auto', paddingRight: 4 }}>
                      {aptLockedList.map((pkg, idx) => renderAptRow(pkg, idx, aptLockedList.length))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </Section>
      ) : null}

      {showToolchain ? (
        <Section
          title="🧰 本机核心工具链与全局 CLI"
          count={
            infra?.toolchain === undefined
              ? '未加载'
              : `${toolchainAll.length} 项 · ${toolchainUpdatable} 可更新`
          }
        >
          {infra?.toolchain === undefined ? (
            <Empty>随运维组件扫描一并加载 uv、pnpm、litellm、全局 CLI 与 Obsidian 桌面版状态。</Empty>
          ) : toolchainItems.length === 0 ? (
            <Empty>{onlyActionable ? '所有本机工具链与 CLI 均已是最新。' : '未发现已登记的工具链条目。'}</Empty>
          ) : (
            toolchainItems.map((item, idx) => {
              const key = `toolchain:${item.id}`
              const isBusy = busyKey === key
              const isCompleted = completedKeys[key] !== undefined
              const effectiveStatus = isCompleted ? 'latest' : item.status
              return (
                <Row key={item.id} last={idx === toolchainItems.length - 1}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180, flex: '1 1 200px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={C.dim}>{item.category}</Tag>
                      <Name>{item.name}</Name>
                      <Meta>
                        {isCompleted ? `${item.latest ?? item.installed} · 已是最新` : `${item.installed} → ${item.latest ?? '—'}`}
                      </Meta>
                    </span>
                    {item.detail ? <Meta>{item.detail}</Meta> : null}
                  </span>
                  <Actions>
                    {isBusy ? (
                      <Btn size="sm" disabled title="当前工具正在升级中，请稍候…">
                        ⏳ 正在升级…
                      </Btn>
                    ) : effectiveStatus === 'update' ? (
                      <Btn
                        tone="primary"
                        size="sm"
                        disabled={anyBusy}
                        title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : `一键升级 ${item.name}`}
                        onClick={() => onUpdateToolchain(item.id, item.name)}
                      >
                        {anyBusy ? '⏸ 等待当前任务…' : '一键升级'}
                      </Btn>
                    ) : (
                      <Tag tone={C.ok}>已最新</Tag>
                    )}
                  </Actions>
                </Row>
              )
            })
          )}
        </Section>
      ) : null}

      {showVenv ? (
        <Section
          title="🐍 项目 Python 虚拟环境 (.venv · 同主版本安全升级)"
          count={
            infra?.venvs === undefined
              ? '未加载'
              : `${venvProjectsAll.length} 个环境 · 同主版本可更 ${venvTotalSafe} 个包`
          }
        >
          {infra?.venvs === undefined ? (
            <Empty>随运维组件扫描一并加载各项目 .venv 过期包列表。</Empty>
          ) : venvProjects.length === 0 ? (
            <Empty>{onlyActionable ? '所有项目 .venv 同主版本安全依赖均已是最新。' : '未检测到项目 Python 虚拟环境。'}</Empty>
          ) : (
            venvProjects.map((proj, idx) => {
              const key = `venv:${proj.id}`
              const isBusy = busyKey === key
              const isCompleted = completedKeys[key] !== undefined
              const effectiveSafeCount = isCompleted ? 0 : proj.safeUpdatableCount
              return (
                <Row key={proj.id} last={idx === venvProjects.length - 1}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200, flex: '1 1 240px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={C.dim}>Python {proj.pythonVersion}</Tag>
                      <Name>{proj.project}</Name>
                      <Meta>{proj.venvPath}</Meta>
                    </span>
                    {proj.packages.length === 0 ? (
                      <Meta>✓ 所有依赖均为最新。</Meta>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
                        {proj.packages.map((p) => (
                          <Tag key={p.name} tone={p.safe ? (isCompleted ? C.ok : C.brand) : C.warn}>
                            {p.name} {p.installed}→{p.latest}
                            {p.safe ? (isCompleted ? ' ✓已更' : '') : ' 🔒锁定'}
                          </Tag>
                        ))}
                      </div>
                    )}
                  </span>
                  <Actions>
                    {isBusy ? (
                      <Btn size="sm" disabled title="当前项目虚拟环境正在升级中，请稍候…">
                        ⏳ 正在升级…
                      </Btn>
                    ) : effectiveSafeCount > 0 ? (
                      <Btn
                        tone="primary"
                        size="sm"
                        disabled={anyBusy}
                        title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : `升级 ${proj.project} 同主版本安全包`}
                        onClick={() => onUpdateVenv(proj.id, proj.project)}
                      >
                        {anyBusy ? '⏸ 等待当前任务…' : `升级安全包 (${effectiveSafeCount})`}
                      </Btn>
                    ) : (
                      <Tag tone={C.ok}>安全包已最新</Tag>
                    )}
                  </Actions>
                </Row>
              )
            })
          )}
        </Section>
      ) : null}

      {showGit ? (
        <Section
          title="🌿 Git 上游仓库与 Agent Skills 追更 (仅快进同步)"
          count={
            infra?.gitRepos === undefined
              ? '未加载'
              : `${gitReposAll.length} 个仓库 · ${gitUpdatable} 可快进 · ${gitLocked} 改动锁定`
          }
        >
          {infra?.gitRepos === undefined ? (
            <Empty>随运维组件扫描一并检测 ~/.agents/skills、~/dsh-plugins 与项目目录的 Git 上游提交。</Empty>
          ) : gitRepos.length === 0 ? (
            <Empty>{onlyActionable ? '所有受管 Git 仓库与 Agent Skills 均已与上游同步。' : '未检测到带远程源的 Git 仓库。'}</Empty>
          ) : (
            gitRepos.map((repo, idx) => {
              const key = `git:${repo.id}`
              const isBusy = busyKey === key
              const isCompleted = completedKeys[key] !== undefined
              const effectiveStatus = isCompleted ? 'latest' : repo.status
              const kindLabel = repo.category === 'skill' ? 'Agent Skill' : repo.category === 'dsh-plugin' ? 'DSH 插件' : '工程仓库'
              return (
                <Row key={repo.id} last={idx === gitRepos.length - 1}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 200, flex: '1 1 240px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={C.dim}>{kindLabel}</Tag>
                      <Name>{repo.name}</Name>
                      <Meta>
                        {repo.branch} @ {isCompleted ? (repo.remoteCommit ?? repo.localCommit) : repo.localCommit}
                        {!isCompleted && repo.remoteCommit && repo.remoteCommit !== repo.localCommit ? ` → ${repo.remoteCommit}` : ''}
                      </Meta>
                    </span>
                    <Meta>{isCompleted ? '刚刚已完成快进同步，当前已是最新提交' : (repo.lockReason ?? repo.detail ?? repo.repoPath)}</Meta>
                  </span>
                  <Actions>
                    {isBusy ? (
                      <Btn size="sm" disabled title="当前仓库正在拉取并编译中，请稍候…">
                        ⏳ 拉取同步中…
                      </Btn>
                    ) : effectiveStatus === 'update' ? (
                      <Btn
                        tone="primary"
                        size="sm"
                        disabled={anyBusy}
                        title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : `一键 git pull --ff-only 同步 ${repo.name}`}
                        onClick={() => onPullGit(repo.id, repo.name)}
                      >
                        {anyBusy ? '⏸ 等待当前任务…' : `快进拉取 (+${repo.behindCount})`}
                      </Btn>
                    ) : effectiveStatus === 'locked' ? (
                      <Tag tone={C.warn}>本地改动锁定</Tag>
                    ) : (
                      <Tag tone={C.ok}>已最新</Tag>
                    )}
                  </Actions>
                </Row>
              )
            })
          )}
        </Section>
      ) : null}

      {showCleanup ? (
        <Section
          title="🧹 跨节点存储与缓存瘦身 GC (悬空镜像 / 构建缓存 / 旧版内核)"
          count={
            infra?.cleanups === undefined
              ? '未加载'
              : `可清理 ${cleanupActionable} 项 · 预计可释放 ${cleanupReclaimText}`
          }
        >
          {infra?.cleanups === undefined ? (
            <Empty>随运维组件扫描一并统计各节点 Docker 悬空镜像、pnpm/uv 缓存、Playwright 旧浏览器与 Journald 日志。</Empty>
          ) : cleanupItems.length === 0 ? (
            <Empty>{onlyActionable ? '所有节点存储与缓存均处于健康水位，无需清理。' : '未发现可统计的缓存目录。'}</Empty>
          ) : (
            cleanupItems.map((item, idx) => {
              const key = `cleanup:${item.id}`
              const isBusy = busyKey === key
              const isCompleted = completedKeys[key] !== undefined
              const effectiveActionable = isCompleted ? false : item.actionable
              return (
                <Row key={item.id} last={idx === cleanupItems.length - 1}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 200, flex: '1 1 240px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={C.dim}>{item.nodeLabel}</Tag>
                      <Name>{item.name}</Name>
                      <Tag tone={effectiveActionable ? C.brand : C.ok}>
                        {isCompleted ? '已释放完成' : `可释放 ${item.reclaimableText} / 总计 ${item.sizeText}`}
                      </Tag>
                    </span>
                    <Meta>{isCompleted ? '刚刚已完成安全瘦身清理，在用容器与活跃依赖不受影响' : item.detail}</Meta>
                  </span>
                  <Actions>
                    {isBusy ? (
                      <Btn size="sm" disabled title="当前正在执行安全清理中，请稍候…">
                        ⏳ 正在清理…
                      </Btn>
                    ) : effectiveActionable ? (
                      <Btn
                        tone="primary"
                        size="sm"
                        disabled={anyBusy}
                        title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : `安全清理 ${item.name}`}
                        onClick={() => onRunCleanup(item.id, item.name)}
                      >
                        {anyBusy ? '⏸ 等待当前任务…' : `一键清理 (${item.reclaimableText})`}
                      </Btn>
                    ) : (
                      <Tag tone={C.ok}>清爽健康</Tag>
                    )}
                  </Actions>
                </Row>
              )
            })
          )}
        </Section>
      ) : null}

      {showSystemd ? (
        <Section
          title="🩺 Systemd 守护进程与定时任务巡检"
          count={
            infra?.systemdHealth === undefined
              ? '未加载'
              : `异常单元 ${systemdFailedAll.length} 个 · 活跃定时器 ${systemdTimersCount} 个`
          }
          action={
            systemdFailedAll.length > 0 && completedKeys['systemd:all'] === undefined ? (
              <Btn
                tone="primary"
                size="sm"
                disabled={anyBusy || busyKey === 'systemd:all'}
                onClick={() => onFixSystemd('all', '全部异常 Systemd 单元')}
              >
                {busyKey === 'systemd:all'
                  ? '⏳ 重置中…'
                  : anyBusy
                    ? '⏸ 等待…'
                    : `一键重置异常单元 (${systemdFailedAll.length})`}
              </Btn>
            ) : null
          }
        >
          {infra?.systemdHealth === undefined ? (
            <Empty>随运维组件扫描一并巡检本机 system 与 user 级 Systemd 服务及定时器。</Empty>
          ) : systemdFailedAll.length === 0 || completedKeys['systemd:all'] !== undefined ? (
            <Empty>✓ 本机所有 Systemd 守护进程与 {systemdTimersCount} 个定时任务均运行正常（0 异常单元）。</Empty>
          ) : (
            systemdFailedAll.map((u, idx) => {
              const key = `systemd:${u.id}`
              const isBusy = busyKey === key || busyKey === 'systemd:all'
              const isCompleted = completedKeys[key] !== undefined || completedKeys['systemd:all'] !== undefined
              return (
                <Row key={u.id} last={idx === systemdFailedAll.length - 1}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 200, flex: '1 1 240px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={isCompleted ? C.ok : C.err}>{u.scope === 'system' ? '系统级' : '用户级'}</Tag>
                      <Name>{u.unit}</Name>
                      <Meta>
                        {u.activeState} / {u.subState}
                      </Meta>
                    </span>
                    <Meta>{isCompleted ? '已重置失败状态' : u.description}</Meta>
                  </span>
                  <Actions>
                    {isBusy ? (
                      <Btn size="sm" disabled>
                        ⏳ 重置中…
                      </Btn>
                    ) : !isCompleted ? (
                      <Btn
                        tone="primary"
                        size="sm"
                        disabled={anyBusy}
                        onClick={() => onFixSystemd(u.id, u.unit)}
                      >
                        {anyBusy ? '⏸ 等待…' : '重置状态'}
                      </Btn>
                    ) : (
                      <Tag tone={C.ok}>已恢复</Tag>
                    )}
                  </Actions>
                </Row>
              )
            })
          )}
        </Section>
      ) : null}
    </div>
  )
}

// ── 主面板 ──────────────────────────────────────────────────────────────────

export function PanelPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined)
  const [scanning, setScanning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [deepLoading, setDeepLoading] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined)
  const [batch, setBatch] = useState<BatchState | undefined>(undefined)
  const [coreRun, setCoreRun] = useState<CoreRunState | undefined>(undefined)
  const [restartRun, setRestartRun] = useState<any>(undefined)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [launching, setLaunching] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [confirmConvert, setConfirmConvert] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [infra, setInfra] = useState<InfraSnapshot | undefined>(undefined)
  const [infraLoading, setInfraLoading] = useState(false)
  const [infraBusy, setInfraBusy] = useState<string | undefined>(undefined)
  const [completedKeys, setCompletedKeys] = useState<Record<string, string>>({})
  const [activeTab, setActiveTab] = useState<ViewTab>('overview')
  const [onlyActionable, setOnlyActionable] = useState(false)
  const [fullPipeline, setFullPipeline] = useState<{
    running: boolean
    total: number
    done: number
    currentLabel: string
    items: Array<{
      key: string
      label: string
      category: string
      status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
      message?: string
    }>
  } | undefined>(undefined)
  const fullCancelRef = useRef(false)
  const actionMutexRef = useRef(false)

  const load = useCallback(async (options: { refresh?: boolean; deep?: boolean; mode?: 'local' } = {}) => {
    const params: string[] = []
    if (options.refresh === true) params.push('refresh=1')
    if (options.deep === true) params.push('deep=1')
    if (options.mode === 'local') params.push('mode=local')
    if (options.refresh === true) setScanning(true)
    try {
      const data = (await apiJson('/snapshot' + (params.length > 0 ? '?' + params.join('&') : ''))) as Snapshot
      if (data !== undefined && data !== null && data.core !== undefined) {
        setSnapshot(data)
        setRefreshing(data.refreshing === true)
        setError(undefined)
        if (options.refresh === true) setCompletedKeys((prev) => {
          // 显式全量刷新后，若后端快照已 반영，清理对应插件锁
          const next = { ...prev }
          for (const k of Object.keys(next)) {
            if (k.startsWith('bundle:')) delete next[k]
          }
          return next
        })
        if (restarting) setRestarting(false)
      } else {
        setError('快照为空：宿主路由未就绪')
      }
    } catch (caught) {
      setError(String(caught))
    } finally {
      if (options.refresh === true) setScanning(false)
    }
  }, [restarting])

  const loadHistory = useCallback(async () => {
    try {
      const data = await apiJson('/history?limit=20')
      setHistory((data?.entries ?? []) as HistoryEntry[])
    } catch {
      /* 历史是辅助信息 */
    }
  }, [])

  const loadInfra = useCallback(async (refresh = false) => {
    setInfraLoading(true)
    try {
      const data = await apiJson('/infra' + (refresh ? '?refresh=1' : ''))
      if (data?.ok === true && data.infra !== undefined) {
        setInfra(data.infra as InfraSnapshot)
        if (refresh) {
          setCompletedKeys((prev) => {
            const next = { ...prev }
            for (const k of Object.keys(next)) {
              if (!k.startsWith('bundle:')) delete next[k]
            }
            return next
          })
        }
      }
    } catch {
      /* 忽略首屏缓存未就绪 */
    } finally {
      setInfraLoading(false)
    }
  }, [])

  const handleUpdateDocker = useCallback(
    async (node: string, name: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `docker:${node}:${name}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/docker-update', {
          method: 'POST',
          body: JSON.stringify({ node, name }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `容器更新 ${node}:${name}`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `容器更新 ${node}:${name}`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const handleUpdateApt = useCallback(
    async (node: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `apt:${node}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/apt-update', {
          method: 'POST',
          body: JSON.stringify({ node }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `APT 安全包更新 (${node.toUpperCase()})`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `APT 安全包更新 (${node.toUpperCase()})`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const handleUpdateToolchain = useCallback(
    async (id: string, name: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `toolchain:${id}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/toolchain-update', {
          method: 'POST',
          body: JSON.stringify({ id }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `工具链升级 (${name})`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `工具链升级 (${name})`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const handleUpdateVenv = useCallback(
    async (projectId: string, projectName: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `venv:${projectId}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/venv-update', {
          method: 'POST',
          body: JSON.stringify({ projectId }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `虚拟环境升级 (${projectName})`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `虚拟环境升级 (${projectName})`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const handlePullGit = useCallback(
    async (id: string, name: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `git:${id}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/git-pull', {
          method: 'POST',
          body: JSON.stringify({ id }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `Git 上游快进同步 (${name})`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `Git 上游快进同步 (${name})`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const handleRunCleanup = useCallback(
    async (id: string, name: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `cleanup:${id}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/cleanup', {
          method: 'POST',
          body: JSON.stringify({ id }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `存储与缓存清理 (${name})`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `存储与缓存清理 (${name})`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const handleFixSystemd = useCallback(
    async (id: string, name: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      const key = `systemd:${id}`
      setInfraBusy(key)
      setOutcome(undefined)
      try {
        const data = await apiJson('/infra/systemd-fix', {
          method: 'POST',
          body: JSON.stringify({ id }),
        })
        if (data?.infra !== undefined) setInfra(data.infra as InfraSnapshot)
        if (data?.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [key]: 'latest' }))
        }
        setOutcome({
          ok: data?.ok === true,
          title: `Systemd 异常重置 (${name})`,
          detail: String(data?.message ?? ''),
          ...(data?.output ? { output: String(data.output) } : {}),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: `Systemd 异常重置 (${name})`, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setInfraBusy(undefined)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const loadCoreRun = useCallback(async () => {
    try {
      const data = await apiJson('/core-update')
      setCoreRun((data?.latest ?? undefined) as CoreRunState | undefined)
    } catch {
      /* 服务可能正在重启 */
    }
  }, [])

  const loadRestartRun = useCallback(async () => {
    try {
      const data = await apiJson('/restart-service')
      setRestartRun(data?.latest ?? undefined)
    } catch {
      /* 同上 */
    }
  }, [])

  // 首屏：先要本机事实（几百毫秒），再补上游版本。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await load({ mode: 'local' })
      } catch {
        /* load 内部已记 error */
      }
      if (cancelled) return
      void load()
      void loadHistory()
      void loadCoreRun()
      void loadRestartRun()
      void loadInfra(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 宿主还在后台刷新：每 2 秒取一次，直到 refreshing 变 false。
  useEffect(() => {
    if (!refreshing) return
    const timer = setInterval(() => {
      void load()
    }, 2000)
    return () => clearInterval(timer)
  }, [refreshing, load])

  // 批量更新进行中：1.5s 轮询进度。
  const batchRunning = batch?.running === true
  useEffect(() => {
    if (!batchRunning) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const data = await apiJson('/batch')
          const next = (data?.batch ?? undefined) as BatchState | undefined
          setBatch(next)
          if (next !== undefined && next.running !== true) {
            await load()
            await loadHistory()
          }
        } catch {
          /* 下次再试 */
        }
      })()
    }, 1500)
    return () => clearInterval(timer)
  }, [batchRunning, load, loadHistory])

  // 本体更新进行中：2s 轮询；连不上就当成「服务重启中」。
  const coreRunning = isCoreRunning(coreRun)
  useEffect(() => {
    if (!coreRunning) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const data = await apiJson('/core-update')
          setRestarting(false)
          const latest = (data?.latest ?? undefined) as CoreRunState | undefined
          setCoreRun(latest)
          if (latest !== undefined && (latest.phase === 'done' || latest.phase === 'failed')) {
            await load({ refresh: true })
            await loadHistory()
          }
        } catch {
          setRestarting(true)
        }
      })()
    }, 2000)
    return () => clearInterval(timer)
  }, [coreRunning, load, loadHistory])

  // 点了「立即重启」：等新进程回来，再刷新快照。
  useEffect(() => {
    if (!restarting) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const data = await apiJson('/snapshot?mode=local')
          if (data?.core?.version !== undefined) {
            setRestarting(false)
            await load({ refresh: true })
            await loadHistory()
            await loadRestartRun()
          }
        } catch {
          /* 还在重启，继续等 */
        }
      })()
    }, 2500)
    return () => clearInterval(timer)
  }, [restarting, load, loadHistory, loadRestartRun])

  const apply = useCallback(
    async (target: string, version: string) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      setBusy(target)
      setOutcome(undefined)
      try {
        const data = (await apiJson('/update', { method: 'POST', body: JSON.stringify({ name: target, version }) })) as ApplyResult
        if (data.ok === true) {
          setCompletedKeys((prev) => ({ ...prev, [`bundle:${target}`]: data.to ?? version }))
        }
        setOutcome({
          ok: data.ok,
          title: target + ' ' + (data.from ?? '') + ' → ' + (data.to ?? version),
          detail: data.message,
          ...(data.packageResult?.output === undefined ? {} : { output: data.packageResult.output }),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: target, detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setBusy(undefined)
        await load()
        await loadHistory()
      }
    },
    [load, loadHistory],
  )

  const convert = useCallback(
    async (row: UpdateRow, confirmOverwrite = false) => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      setBusy(row.name)
      setOutcome(undefined)
      setConfirmConvert(undefined)
      try {
        const body = JSON.stringify({
          name: row.name,
          ...(row.upstream?.version === undefined ? {} : { version: row.upstream.version }),
          ...(row.kind === 'injected' ? { injected: true } : {}),
          ...(confirmOverwrite ? { confirmOverwrite: true } : {}),
        })
        const data = (await apiJson('/convert', { method: 'POST', body })) as ConvertResult
        if (data.ok === true) {
          setCompletedKeys((prev) => ({
            ...prev,
            [`bundle:${row.name}`]: data.to ?? row.upstream?.version ?? 'latest',
            [`convert:${row.name}`]: data.to ?? row.upstream?.version ?? 'latest',
          }))
        }
        setOutcome({
          ok: data.ok,
          title: row.name + ' 转为线上 ' + (data.to ?? ''),
          detail: data.message,
          ...(data.packageResult?.output === undefined ? {} : { output: data.packageResult.output }),
        })
      } catch (caught) {
        setOutcome({ ok: false, title: row.name + ' 转为线上', detail: String(caught) })
      } finally {
        actionMutexRef.current = false
        setBusy(undefined)
        await load()
        await loadHistory()
      }
    },
    [load, loadHistory],
  )

  const updateAll = useCallback(
    async (channel: 'stable' | 'preview') => {
      if (actionMutexRef.current) return
      actionMutexRef.current = true
      setNotice(undefined)
      setOutcome(undefined)
      try {
        const data = await apiJson('/update-all', { method: 'POST', body: JSON.stringify({ channel }) })
        if (data?.started === true) {
          setBatch(data.batch as BatchState)
          setNotice('已开始批量更新 ' + (data.batch?.total ?? 0) + ' 个套件（串行执行）')
        } else {
          setNotice(String(data?.message ?? '没有需要更新的条目'))
        }
      } catch (caught) {
        setNotice(String(caught))
      } finally {
        actionMutexRef.current = false
      }
    },
    [],
  )

  const cancelBatch = useCallback(async () => {
    try {
      const data = await apiJson('/batch/cancel', { method: 'POST', body: '{}' })
      setBatch((data?.batch ?? undefined) as BatchState | undefined)
      setNotice(data?.cancelled === true ? '已请求叫停：当前项跑完后停止' : '当前没有在跑的批量更新')
    } catch (caught) {
      setNotice(String(caught))
    }
  }, [])

  const launchCore = useCallback(
    async (version: string) => {
      setLaunching(true)
      setNotice(undefined)
      try {
        const data = await apiJson('/core-update', { method: 'POST', body: JSON.stringify({ version }) })
        setCoreRun((data?.latest ?? undefined) as CoreRunState | undefined)
        setConfirming(undefined)
        setNotice(String(data?.message ?? '已启动本体更新'))
      } catch (caught) {
        setNotice('启动失败：' + String(caught))
      } finally {
        setLaunching(false)
        await loadHistory()
      }
    },
    [loadHistory],
  )

  const restartService = useCallback(async () => {
    setNotice(undefined)
    try {
      const data = await apiJson('/restart-service', { method: 'POST', body: '{}' })
      if (data?.ok === true) {
        setRestarting(true)
        setNotice('已发出重启指令，服务会在几秒内中断再恢复…')
      } else {
        setNotice(String(data?.message ?? '重启失败'))
      }
    } catch (caught) {
      setNotice('重启失败：' + String(caught))
    }
    await loadHistory()
  }, [loadHistory])

  const dismissRestart = useCallback(async () => {
    try {
      await apiJson('/pending-restart', { method: 'POST', body: '{}' })
      setNotice('已收起重启提醒；这些包会在下次重启后生效')
      await load()
    } catch (caught) {
      setNotice(String(caught))
    }
  }, [load])

  const deep = useCallback(async () => {
    setDeepLoading(true)
    try {
      await load({ deep: true })
    } finally {
      setDeepLoading(false)
    }
  }, [load])

  const runFullSequentialUpdate = useCallback(async () => {
    if (actionMutexRef.current) return
    const queue: Array<{
      key: string
      label: string
      category: string
      run: () => Promise<{ ok: boolean; message: string; nextInfra?: InfraSnapshot }>
    }> = []

    const regCandidates =
      snapshot === undefined
        ? []
        : snapshot.bundles.filter(
            (r) =>
              r.status === 'update' &&
              r.providedByCore !== true &&
              r.stable?.version !== undefined &&
              completedKeys[`bundle:${r.name}`] === undefined,
          )
    for (const r of regCandidates) {
      const targetVer = r.stable!.version
      queue.push({
        key: `bundle:${r.name}`,
        label: `DSH 插件 ${r.name} → ${targetVer}`,
        category: '🧩 DSH 插件',
        run: async () => {
          setBusy(r.name)
          try {
            const data = await apiJson('/update', {
              method: 'POST',
              body: JSON.stringify({ name: r.name, version: targetVer }),
            })
            const res = data?.result ?? {}
            const ok = res.ok === true
            if (ok) {
              setCompletedKeys((prev) => ({ ...prev, [`bundle:${r.name}`]: res.to ?? targetVer }))
            }
            return { ok, message: String(res.message ?? (ok ? '更新成功' : '更新失败')) }
          } finally {
            setBusy(undefined)
          }
        },
      })
    }

    if (infra !== undefined) {
      for (const c of infra.docker.containers) {
        const k = `docker:${c.node}:${c.name}`
        if (c.status === 'update' && completedKeys[k] === undefined) {
          queue.push({
            key: k,
            label: `Docker 容器 [${c.nodeLabel ?? c.node}] ${c.name}`,
            category: '🐳 Docker 容器',
            run: async () => {
              setInfraBusy(k)
              try {
                const data = await apiJson('/infra/docker-update', {
                  method: 'POST',
                  body: JSON.stringify({ node: c.node, name: c.name }),
                })
                const ok = data?.ok === true
                if (ok) setCompletedKeys((prev) => ({ ...prev, [k]: 'latest' }))
                return {
                  ok,
                  message: String(data?.message ?? ''),
                  ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
                }
              } finally {
                setInfraBusy(undefined)
              }
            },
          })
        }
      }

      const aptNodesList = infra.apt.nodes ?? [
        { node: 'local', label: '本机', safeUpdatableCount: infra.apt.vm100.filter((p) => !p.locked).length },
        { node: 'pve', label: 'PVE', safeUpdatableCount: infra.apt.pve.filter((p) => !p.locked).length },
      ]
      for (const n of aptNodesList) {
        const k = `apt:${n.node}`
        if (n.safeUpdatableCount > 0 && completedKeys[k] === undefined) {
          queue.push({
            key: k,
            label: `系统安全包 APT (${n.label ?? n.node} · ${n.safeUpdatableCount} 个)`,
            category: '🛡️ 系统 APT',
            run: async () => {
              setInfraBusy(k)
              try {
                const data = await apiJson('/infra/apt-update', {
                  method: 'POST',
                  body: JSON.stringify({ node: n.node }),
                })
                const ok = data?.ok === true
                if (ok) setCompletedKeys((prev) => ({ ...prev, [k]: 'latest' }))
                return {
                  ok,
                  message: String(data?.message ?? ''),
                  ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
                }
              } finally {
                setInfraBusy(undefined)
              }
            },
          })
        }
      }

      for (const t of infra.toolchain?.items ?? []) {
        const k = `toolchain:${t.id}`
        if (t.status === 'update' && completedKeys[k] === undefined) {
          queue.push({
            key: k,
            label: `核心工具链 ${t.name} (${t.installed} → ${t.latest})`,
            category: '🧰 工具链',
            run: async () => {
              setInfraBusy(k)
              try {
                const data = await apiJson('/infra/toolchain-update', {
                  method: 'POST',
                  body: JSON.stringify({ id: t.id }),
                })
                const ok = data?.ok === true
                if (ok) setCompletedKeys((prev) => ({ ...prev, [k]: 'latest' }))
                return {
                  ok,
                  message: String(data?.message ?? ''),
                  ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
                }
              } finally {
                setInfraBusy(undefined)
              }
            },
          })
        }
      }

      for (const v of infra.venvs?.projects ?? []) {
        const k = `venv:${v.id}`
        if (v.safeUpdatableCount > 0 && completedKeys[k] === undefined) {
          queue.push({
            key: k,
            label: `Python 虚拟环境 ${v.project} (${v.safeUpdatableCount} 个安全包)`,
            category: '🐍 Python .venv',
            run: async () => {
              setInfraBusy(k)
              try {
                const data = await apiJson('/infra/venv-update', {
                  method: 'POST',
                  body: JSON.stringify({ projectId: v.id }),
                })
                const ok = data?.ok === true
                if (ok) setCompletedKeys((prev) => ({ ...prev, [k]: 'latest' }))
                return {
                  ok,
                  message: String(data?.message ?? ''),
                  ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
                }
              } finally {
                setInfraBusy(undefined)
              }
            },
          })
        }
      }

      for (const g of infra.gitRepos?.repos ?? []) {
        const k = `git:${g.id}`
        if (g.status === 'update' && completedKeys[k] === undefined) {
          queue.push({
            key: k,
            label: `Git 仓库快进同步 ${g.name} (落后 ${g.behindCount} 个提交)`,
            category: '🌿 Git 与技能',
            run: async () => {
              setInfraBusy(k)
              try {
                const data = await apiJson('/infra/git-pull', {
                  method: 'POST',
                  body: JSON.stringify({ id: g.id }),
                })
                const ok = data?.ok === true
                if (ok) setCompletedKeys((prev) => ({ ...prev, [k]: 'latest' }))
                return {
                  ok,
                  message: String(data?.message ?? ''),
                  ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
                }
              } finally {
                setInfraBusy(undefined)
              }
            },
          })
        }
      }

      for (const c of infra.cleanups?.items ?? []) {
        const k = `cleanup:${c.id}`
        if (c.actionable && completedKeys[k] === undefined) {
          queue.push({
            key: k,
            label: `存储缓存清理 ${c.name} (可省 ${c.reclaimableText})`,
            category: '🧹 缓存瘦身 GC',
            run: async () => {
              setInfraBusy(k)
              try {
                const data = await apiJson('/infra/cleanup', {
                  method: 'POST',
                  body: JSON.stringify({ id: c.id }),
                })
                const ok = data?.ok === true
                if (ok) setCompletedKeys((prev) => ({ ...prev, [k]: 'latest' }))
                return {
                  ok,
                  message: String(data?.message ?? ''),
                  ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
                }
              } finally {
                setInfraBusy(undefined)
              }
            },
          })
        }
      }

      const failedUnits = (infra.systemdHealth?.failedUnits ?? []).filter(
        (u) => completedKeys['systemd:all'] === undefined && completedKeys[`systemd:${u.id}`] === undefined,
      )
      if (failedUnits.length > 0) {
        queue.push({
          key: 'systemd:all',
          label: `Systemd 异常单元重置 (${failedUnits.length} 个单元)`,
          category: '🩺 Systemd 巡检',
          run: async () => {
            setInfraBusy('systemd:all')
            try {
              const data = await apiJson('/infra/systemd-fix', {
                method: 'POST',
                body: JSON.stringify({ id: 'all' }),
              })
              const ok = data?.ok === true
              if (ok) setCompletedKeys((prev) => ({ ...prev, 'systemd:all': 'latest' }))
              return {
                ok,
                message: String(data?.message ?? ''),
                ...(data?.infra ? { nextInfra: data.infra as InfraSnapshot } : {}),
              }
            } finally {
              setInfraBusy(undefined)
            }
          },
        })
      }
    }

    if (queue.length === 0) {
      setOutcome({
        ok: true,
        title: '全栈一键顺序更新',
        detail: '当前所有 9 大维度均无待处理更新或清理项，全栈已处于最新健康状态。',
      })
      return
    }

    actionMutexRef.current = true
    fullCancelRef.current = false
    setOutcome(undefined)
    setFullPipeline({
      running: true,
      total: queue.length,
      done: 0,
      currentLabel: queue[0]!.label,
      items: queue.map((q) => ({
        key: q.key,
        label: q.label,
        category: q.category,
        status: 'pending' as const,
      })),
    })

    let okCount = 0
    let failCount = 0
    let lastInfra: InfraSnapshot | undefined = undefined

    try {
      for (let i = 0; i < queue.length; i++) {
        if (fullCancelRef.current) {
          setFullPipeline((prev) =>
            prev === undefined
              ? undefined
              : {
                  ...prev,
                  items: prev.items.map((it, idx) => (idx >= i ? { ...it, status: 'skipped', message: '已手动停止后续队列' } : it)),
                },
          )
          break
        }
        const task = queue[i]!
        setFullPipeline((prev) =>
          prev === undefined
            ? undefined
            : {
                ...prev,
                done: i,
                currentLabel: task.label,
                items: prev.items.map((it, idx) => (idx === i ? { ...it, status: 'running' } : it)),
              },
        )
        try {
          const res = await task.run()
          if (res.nextInfra !== undefined) {
            lastInfra = res.nextInfra
            setInfra(res.nextInfra)
          }
          if (res.ok) okCount++
          else failCount++
          setFullPipeline((prev) =>
            prev === undefined
              ? undefined
              : {
                  ...prev,
                  done: i + 1,
                  items: prev.items.map((it, idx) =>
                    idx === i ? { ...it, status: res.ok ? 'ok' : 'failed', message: res.message } : it,
                  ),
                },
          )
        } catch (err) {
          failCount++
          setFullPipeline((prev) =>
            prev === undefined
              ? undefined
              : {
                  ...prev,
                  done: i + 1,
                  items: prev.items.map((it, idx) =>
                    idx === i ? { ...it, status: 'failed', message: String(err) } : it,
                  ),
                },
          )
        }
      }
    } finally {
      actionMutexRef.current = false
      setFullPipeline((prev) =>
        prev === undefined
          ? undefined
          : {
              ...prev,
              running: false,
              currentLabel: fullCancelRef.current ? '队列已停止' : '全部队列执行完毕',
            },
      )
      setOutcome({
        ok: failCount === 0,
        title: `全栈一键顺序更新完成（成功 ${okCount} 项${failCount > 0 ? `，失败 ${failCount} 项` : ''}）`,
        detail: `已按次序逐项执行完毕 ${okCount + failCount} / ${queue.length} 个运维任务。`,
      })
      if (regCandidates.length > 0) await load()
      if (lastInfra === undefined) await loadInfra(false)
      await loadHistory()
    }
  }, [snapshot, infra, completedKeys, load, loadInfra, loadHistory])

  const registryRows = useMemo(
    () => (snapshot === undefined ? [] : snapshot.bundles.filter((row) => row.status !== 'not-registry' && row.providedByCore !== true)),
    [snapshot],
  )
  const localRows = useMemo(
    () => (snapshot === undefined ? [] : snapshot.bundles.filter((row) => row.status === 'not-registry' && row.providedByCore !== true)),
    [snapshot],
  )
  const coreRows = useMemo(() => (snapshot === undefined ? [] : (snapshot.coreProvided ?? [])), [snapshot])
  const injectedRows = useMemo(() => (snapshot === undefined ? [] : snapshot.injected), [snapshot])
  const stableUpdates = registryRows.filter(
    (row) => row.status === 'update' && completedKeys[`bundle:${row.name}`] === undefined,
  ).length
  const previewUpdates = registryRows.filter(
    (row) =>
      (row.status === 'update' || row.status === 'preview-only') &&
      completedKeys[`bundle:${row.name}`] === undefined,
  ).length
  // 面板内的提醒口径与侧栏角标一致（同一个纯函数），但直接用快照算，不再多一轮请求。
  const reminder = useMemo(() => (snapshot === undefined ? undefined : reminderFrom(snapshot)), [snapshot])
  const pendingRestart = snapshot?.pendingRestart ?? []
  const batchItemRunning = batch?.running === true ? batch.current : undefined
  const fullRunning = fullPipeline?.running === true
  const anyBusy =
    busy !== undefined ||
    infraBusy !== undefined ||
    batchRunning ||
    fullRunning ||
    coreRunning ||
    launching ||
    restarting
  const localTotal = localRows.length + injectedRows.length

  const dockerUpdatable =
    infra?.docker.containers.filter(
      (c) => c.status === 'update' && completedKeys[`docker:${c.node}:${c.name}`] === undefined,
    ).length ?? 0
  const dockerLocked = infra?.docker.lockedCount ?? 0
  const dockerTotal = infra?.docker.containers.length ?? 0
  const aptSafeCount =
    infra === undefined
      ? 0
      : (infra.apt.nodes ?? [
          { node: 'local', safeUpdatableCount: infra.apt.vm100.filter((p) => !p.locked).length },
          { node: 'pve', safeUpdatableCount: infra.apt.pve.filter((p) => !p.locked).length },
        ]).reduce(
          (sum, n) => sum + (completedKeys[`apt:${n.node}`] !== undefined ? 0 : n.safeUpdatableCount),
          0,
        )
  const aptLockedCount = infra?.apt.lockedCount ?? 0
  const toolchainUpdatable =
    infra?.toolchain?.items.filter(
      (t) => t.status === 'update' && completedKeys[`toolchain:${t.id}`] === undefined,
    ).length ?? 0
  const toolchainTotal = infra?.toolchain?.items.length ?? 0
  const venvSafeCount =
    infra?.venvs?.projects.reduce(
      (sum, v) => sum + (completedKeys[`venv:${v.id}`] !== undefined ? 0 : v.safeUpdatableCount),
      0,
    ) ?? 0
  const venvTotal = infra?.venvs?.projects.length ?? 0

  const gitUpdatableCount =
    infra?.gitRepos?.repos.filter(
      (r) => r.status === 'update' && completedKeys[`git:${r.id}`] === undefined,
    ).length ?? 0
  const gitLockedCount = infra?.gitRepos?.lockedCount ?? 0
  const gitTotalCount = infra?.gitRepos?.repos.length ?? 0

  const cleanupActionableCount =
    infra?.cleanups?.items.filter(
      (c) => c.actionable && completedKeys[`cleanup:${c.id}`] === undefined,
    ).length ?? 0
  const cleanupTotalReclaimText = infra?.cleanups?.totalReclaimableText ?? '0 B'

  const systemdFailedCount =
    completedKeys['systemd:all'] !== undefined
      ? 0
      : (infra?.systemdHealth?.failedUnits.filter(
          (u) => completedKeys[`systemd:${u.id}`] === undefined,
        ).length ?? 0)
  const systemdTimersCount = infra?.systemdHealth?.activeTimersCount ?? 0

  const filteredRegistryRows = onlyActionable
    ? registryRows.filter(
        (r) =>
          ((r.status === 'update' || r.status === 'preview-only') &&
            completedKeys[`bundle:${r.name}`] === undefined) ||
          busy === r.name ||
          batchItemRunning === r.name,
      )
    : registryRows
  const filteredLocalRows = onlyActionable
    ? [...localRows, ...injectedRows].filter(
        (r) =>
          (r.upstream?.convertible === true && completedKeys[`convert:${r.name}`] === undefined) ||
          busy === r.name,
      )
    : [...localRows, ...injectedRows]

  const showDsh = activeTab === 'overview' || activeTab === 'dsh'
  const showInfra =
    activeTab === 'overview' ||
    activeTab === 'docker' ||
    activeTab === 'apt' ||
    activeTab === 'toolchain' ||
    activeTab === 'venv' ||
    activeTab === 'git' ||
    activeTab === 'cleanup' ||
    activeTab === 'systemd'
  const showHistory = activeTab === 'overview' || activeTab === 'history'

  const tabRowPrimary: { id: ViewTab; label: string; badge?: number; tone?: string }[] = [
    { id: 'overview', label: '🌐 全景工作台' },
    { id: 'dsh', label: '🧩 DSH 本体与插件', badge: stableUpdates + pendingRestart.length, tone: stableUpdates > 0 ? C.brand : C.warn },
    { id: 'docker', label: `🐳 容器 (${dockerTotal})`, badge: dockerUpdatable, tone: C.brand },
    { id: 'apt', label: '🛡️ 系统 APT', badge: aptSafeCount, tone: C.brand },
    { id: 'toolchain', label: `🧰 工具链 (${toolchainTotal})`, badge: toolchainUpdatable, tone: C.brand },
  ]

  const tabRowSecondary: { id: ViewTab; label: string; badge?: number; tone?: string }[] = [
    { id: 'venv', label: `🐍 Python .venv (${venvTotal})`, badge: venvSafeCount, tone: C.brand },
    { id: 'git', label: `🌿 Git 与技能 (${gitTotalCount})`, badge: gitUpdatableCount, tone: C.brand },
    { id: 'cleanup', label: '🧹 缓存瘦身 GC', badge: cleanupActionableCount, tone: C.brand },
    { id: 'systemd', label: '🩺 Systemd 巡检', badge: systemdFailedCount, tone: C.err },
    { id: 'history', label: `📜 日志与历史 (${history.length})` },
  ]

  const tabs = [...tabRowPrimary, ...tabRowSecondary]

  const totalActionable =
    stableUpdates +
    pendingRestart.length +
    dockerUpdatable +
    aptSafeCount +
    toolchainUpdatable +
    venvSafeCount +
    gitUpdatableCount +
    cleanupActionableCount +
    systemdFailedCount

  const sequentialActionableCount =
    stableUpdates +
    dockerUpdatable +
    (aptSafeCount > 0
      ? (infra?.apt.nodes ?? [
          { node: 'local', safeUpdatableCount: infra?.apt.vm100.filter((p) => !p.locked).length ?? 0 },
          { node: 'pve', safeUpdatableCount: infra?.apt.pve.filter((p) => !p.locked).length ?? 0 },
        ]).filter((n) => n.safeUpdatableCount > 0 && completedKeys[`apt:${n.node}`] === undefined).length
      : 0) +
    toolchainUpdatable +
    (infra?.venvs?.projects.filter((v) => v.safeUpdatableCount > 0 && completedKeys[`venv:${v.id}`] === undefined)
      .length ?? 0) +
    gitUpdatableCount +
    cleanupActionableCount +
    (systemdFailedCount > 0 ? 1 : 0)

  return (
    <div
      data-dsh-plugin="dsh-update-center"
      data-dsh-update-center-view=""
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '0 22px 36px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        background: C.base,
        color: C.text,
        fontSize: 13,
      }}
    >
      {/* 吸顶全景导航与操作栏：修复暗色模式白底白字，统一使用 --dsw-alias-bg-base + 毛玻璃 */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          backgroundColor: C.base,
          background: `color-mix(in srgb, ${C.base} 92%, transparent)`,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          paddingTop: 14,
          paddingBottom: 10,
          borderBottom: '1px solid ' + C.line,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          color: C.text,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: totalActionable > 0 ? '#3b82f6' : '#22c55e',
                boxShadow: totalActionable > 0 ? '0 0 10px #3b82f6' : '0 0 10px #22c55e',
                flexShrink: 0,
              }}
            />
            <h2 style={{ margin: 0, fontSize: 17.5, fontWeight: 700, letterSpacing: 0.2, color: C.text }}>全栈运维更新中心</h2>
            <Tag tone={totalActionable > 0 ? C.brand : C.ok}>
              {totalActionable > 0 ? `${totalActionable} 项可处理` : '全栈健康 · 0 待更'}
            </Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <Btn
              size="sm"
              tone={onlyActionable ? 'primary' : 'default'}
              onClick={() => setOnlyActionable((v) => !v)}
              title="切换是否隐藏已是最新状态的条目，聚焦待处理项与门禁锁定项"
            >
              {onlyActionable ? '🔍 仅看待处理/锁定 (已开启)' : '🔍 仅看待处理/锁定'}
            </Btn>
            <Btn
              size="sm"
              onClick={() => {
                void load({ refresh: true })
                void loadInfra(true)
              }}
              disabled={scanning || infraLoading || anyBusy}
              title="同时刷新 DSH 上游版本与跨节点 Docker/APT/工具链/.venv 状态"
            >
              {scanning || infraLoading ? '⏳ 全栈扫描中…' : '🔄 全栈刷新'}
            </Btn>
            <Btn
              tone="primary"
              size="md"
              disabled={scanning || infraLoading || anyBusy || sequentialActionableCount === 0}
              onClick={() => void runFullSequentialUpdate()}
              title="按安全顺序依次自动执行全栈所有可处理项：DSH插件 → Docker容器 → 系统APT → 工具链 → Python .venv → Git同步 → 缓存瘦身 → Systemd重置"
            >
              {fullRunning
                ? `⏳ 顺序更新中 (${fullPipeline?.done ?? 0}/${fullPipeline?.total ?? 0})…`
                : anyBusy
                  ? '⏸ 等待当前任务…'
                  : `⚡ 一键更新全部（${sequentialActionableCount}）`}
            </Btn>
            <Btn
              size="sm"
              disabled={scanning || anyBusy || stableUpdates === 0}
              onClick={() => void updateAll('stable')}
              title="仅串行更新所有有正式版更新的 DSH 套件，不重启服务"
            >
              {batchRunning ? '⏳ 批量进行中…' : anyBusy ? '⏸ 等待…' : '仅更插件（' + stableUpdates + '）'}
            </Btn>
            {previewUpdates > stableUpdates ? (
              <Btn size="sm" disabled={scanning || anyBusy} onClick={() => void updateAll('preview')} title="把仅预览版更新的套件也算进来">
                {anyBusy ? '⏸ 等待…' : `含预览（${previewUpdates}）`}
              </Btn>
            ) : null}
          </div>
        </header>

        {/* 分区快捷切换胶囊条（分两层展示：上层系统与容器核心，下层工程与系统维护 + 一键顺序更新胶囊） */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[
            { tag: '核心层', items: tabRowPrimary, showQuickAll: true },
            { tag: '维护层', items: tabRowSecondary, showQuickAll: false },
          ].map((rowGroup) => (
            <div key={rowGroup.tag} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: C.dim,
                  padding: '2px 7px',
                  borderRadius: 6,
                  background: C.layer2,
                  border: '1px solid ' + C.line,
                  minWidth: 48,
                  textAlign: 'center',
                  flexShrink: 0,
                }}
              >
                {rowGroup.tag}
              </span>
              {rowGroup.items.map((tab) => {
                const isAct = activeTab === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 999,
                      border: '1px solid ' + (isAct ? '#2563eb' : C.line2),
                      backgroundColor: isAct ? '#2563eb' : C.layer2,
                      backgroundImage: isAct ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)' : 'none',
                      color: isAct ? '#ffffff' : C.text,
                      fontSize: 12,
                      fontWeight: isAct ? 650 : 500,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      boxShadow: isAct ? '0 2px 8px rgba(37,99,235,.28)' : 'none',
                      transition: 'all .15s ease',
                    }}
                  >
                    <span style={{ color: isAct ? '#ffffff' : C.text }}>{tab.label}</span>
                    {tab.badge !== undefined && tab.badge > 0 ? (
                      <span
                        style={{
                          padding: '0 6px',
                          borderRadius: 999,
                          fontSize: 10.5,
                          lineHeight: '16px',
                          fontWeight: 700,
                          background: isAct ? '#ffffff' : (tab.tone ?? C.brand),
                          color: isAct ? '#1d4ed8' : '#ffffff',
                        }}
                      >
                        {tab.badge}
                      </span>
                    ) : null}
                  </button>
                )
              })}
              {rowGroup.showQuickAll ? (
                <button
                  type="button"
                  disabled={scanning || infraLoading || anyBusy || sequentialActionableCount === 0}
                  onClick={() => void runFullSequentialUpdate()}
                  title="点击后按次序自动一个接一个更新所有可处理项，无需逐个分区点击"
                  style={{
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    marginLeft: 'auto',
                    height: 28,
                    padding: '0 14px',
                    borderRadius: 999,
                    border:
                      sequentialActionableCount > 0 && !anyBusy
                        ? '1px solid #10b981'
                        : '1px solid ' + C.line2,
                    backgroundColor:
                      sequentialActionableCount > 0 && !anyBusy
                        ? '#059669'
                        : C.layer2,
                    backgroundImage:
                      sequentialActionableCount > 0 && !anyBusy
                        ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)'
                        : 'none',
                    color: sequentialActionableCount > 0 && !anyBusy ? '#ffffff' : C.dim,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor:
                      scanning || infraLoading || anyBusy || sequentialActionableCount === 0
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      scanning || infraLoading || anyBusy || sequentialActionableCount === 0
                        ? 0.65
                        : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow:
                      sequentialActionableCount > 0 && !anyBusy
                        ? '0 2px 10px rgba(16,185,129,.32)'
                        : 'none',
                    transition: 'all .15s ease',
                  }}
                >
                  <span>
                    {fullRunning
                      ? `⏳ 正在顺序更新 (${fullPipeline?.done ?? 0}/${fullPipeline?.total ?? 0})…`
                      : anyBusy
                        ? '⏸ 队列繁忙中…'
                        : sequentialActionableCount > 0
                          ? `⚡ 一键顺序更新 (${sequentialActionableCount})`
                          : '✓ 全栈已最新'}
                  </span>
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* AI 视觉主控台 Hero 横幅（明暗双模式高对比自适应，固定深邃黑曜石渐变底衬托纯白文字） */}
      <div
        style={{
          position: 'relative',
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid rgba(59,130,246,.32)',
          background: '#0b0f19',
          backgroundImage: `linear-gradient(90deg, rgba(9,13,24,0.95) 0%, rgba(9,13,24,0.82) 48%, rgba(9,13,24,0.25) 100%), url("${HERO_BANNER_DATA_URL}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'right center',
          padding: '18px 22px',
          color: '#f8fafc',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          boxShadow: '0 6px 20px rgba(0,0,0,.18)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 640 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(59,130,246,.24)',
                border: '1px solid rgba(96,165,250,.45)',
                color: '#93c5fd',
              }}
            >
              DSH OPS COMMAND CENTER
            </span>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>
              VM100 · PVE · iStoreOS · fnOS 四节点全栈协同
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', letterSpacing: 0.2 }}>
            {totalActionable === 0
              ? '✨ 全栈 9 大维度组件均已对齐最新安全基线'
              : `⚡ 检测到 ${totalActionable} 项待处理更新、清理或巡检项`}
          </div>
          <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: '18px' }}>
            {snapshot === undefined
              ? '正在拉取本机与跨节点状态快照…'
              : snapshot.partial === true
                ? '本机事实已就绪 · 上游版本后台查询中'
                : `DSH 扫描于 ${fmtAge(snapshot.ageSeconds)}${refreshing ? '（后台刷新中）' : ''}${
                    infra?.generatedAt ? ` ｜ 跨节点快照：${infra.generatedAt.replace('T', ' ').slice(0, 19)}` : ''
                  }`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            disabled={scanning || infraLoading || anyBusy || sequentialActionableCount === 0}
            onClick={() => void runFullSequentialUpdate()}
            title="点击后按安全次序依次执行全栈所有可处理更新与清理任务"
            style={{
              appearance: 'none',
              WebkitAppearance: 'none',
              height: 44,
              padding: '0 18px',
              borderRadius: 10,
              border:
                sequentialActionableCount > 0 && !anyBusy
                  ? '1px solid #34d399'
                  : '1px solid rgba(148,163,184,.3)',
              backgroundColor:
                sequentialActionableCount > 0 && !anyBusy
                  ? '#059669'
                  : 'rgba(15,23,42,.8)',
              backgroundImage:
                sequentialActionableCount > 0 && !anyBusy
                  ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)'
                  : 'none',
              color: '#ffffff',
              fontSize: 13.5,
              fontWeight: 700,
              cursor:
                scanning || infraLoading || anyBusy || sequentialActionableCount === 0
                  ? 'not-allowed'
                  : 'pointer',
              opacity:
                scanning || infraLoading || anyBusy || sequentialActionableCount === 0
                  ? 0.72
                  : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              boxShadow:
                sequentialActionableCount > 0 && !anyBusy
                  ? '0 4px 16px rgba(16,185,129,.4)'
                  : 'none',
              transition: 'all .15s ease',
            }}
          >
            <span>
              {fullRunning
                ? `⏳ 顺序更新中 (${fullPipeline?.done ?? 0}/${fullPipeline?.total ?? 0})…`
                : anyBusy
                  ? '⏸ 正在执行任务…'
                  : sequentialActionableCount > 0
                    ? `⚡ 一键顺序更新全部 (${sequentialActionableCount})`
                    : '✨ 全栈已最新 (0 待处理)'}
            </span>
          </button>
          <div
            style={{
              background: 'rgba(15,23,42,.75)',
              backdropFilter: 'blur(8px)',
              border: '1px solid rgba(148,163,184,.25)',
              borderRadius: 10,
              padding: '8px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <span style={{ fontSize: 10.5, color: '#94a3b8' }}>安全护栏</span>
            <span style={{ fontSize: 12.5, fontWeight: 650, color: '#4ade80' }}>
              🔒 {dockerLocked} 容器锁 · {aptLockedCount} 内核锁
            </span>
          </div>
          <div
            style={{
              background: 'rgba(15,23,42,.75)',
              backdropFilter: 'blur(8px)',
              border: '1px solid rgba(148,163,184,.25)',
              borderRadius: 10,
              padding: '8px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <span style={{ fontSize: 10.5, color: '#94a3b8' }}>当前视图</span>
            <span style={{ fontSize: 12.5, fontWeight: 650, color: '#60a5fa' }}>
              {tabs.find((t) => t.id === activeTab)?.label ?? '全景工作台'}
            </span>
          </div>
        </div>
      </div>

      {/* 全栈一键顺序更新队列实时进度面板 */}
      {fullPipeline === undefined ? null : (
        <div
          style={{
            border: '1px solid ' + (fullPipeline.running ? C.brand : C.ok),
            borderLeft: '4px solid ' + (fullPipeline.running ? C.brand : C.ok),
            borderRadius: 12,
            padding: '12px 16px',
            background: C.layer1,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 13.5, color: C.text }}>
                {fullPipeline.running ? '⚡ 全栈顺序更新队列正在逐项执行' : '✓ 全栈顺序更新队列执行记录'}
              </span>
              <Tag tone={fullPipeline.running ? C.brand : C.ok}>
                进度 {fullPipeline.done} / {fullPipeline.total}
              </Tag>
              <Meta>{fullPipeline.currentLabel}</Meta>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {fullPipeline.running ? (
                <Btn
                  size="sm"
                  tone="danger"
                  onClick={() => {
                    fullCancelRef.current = true
                  }}
                  title="当前正在执行的单个任务完成后，停止后续排队的任务"
                >
                  ⏹ 停止后续队列
                </Btn>
              ) : (
                <Btn size="sm" tone="ghost" onClick={() => setFullPipeline(undefined)}>
                  收起队列详情
                </Btn>
              )}
            </div>
          </div>

          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: C.layer2,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${fullPipeline.total > 0 ? Math.round((fullPipeline.done / fullPipeline.total) * 100) : 100}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #2563eb 0%, #10b981 100%)',
                transition: 'width .25s ease',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {fullPipeline.items.map((item, idx) => {
              const icon =
                item.status === 'running'
                  ? '⏳'
                  : item.status === 'ok'
                    ? '✓'
                    : item.status === 'failed'
                      ? '✕'
                      : item.status === 'skipped'
                        ? '⏭'
                        : '•'
              const color =
                item.status === 'running'
                  ? C.brand
                  : item.status === 'ok'
                    ? C.ok
                    : item.status === 'failed'
                      ? C.err
                      : C.dim
              return (
                <div
                  key={item.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '4px 8px',
                    borderRadius: 6,
                    background: item.status === 'running' ? C.layer2 : 'transparent',
                    fontSize: 12,
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, color, width: 16, textAlign: 'center' }}>{icon}</span>
                    <span style={{ color: C.dim, fontFamily: MONO, fontSize: 11 }}>#{idx + 1}</span>
                    <Tag tone={color}>{item.category}</Tag>
                    <span style={{ fontWeight: item.status === 'running' ? 650 : 500, color: C.text }}>
                      {item.label}
                    </span>
                  </span>
                  <span style={{ fontSize: 11.5, color, flexShrink: 0 }}>
                    {item.status === 'running'
                      ? '正在执行…'
                      : item.status === 'ok'
                        ? '已完成'
                        : item.status === 'failed'
                          ? item.message || '执行失败'
                          : item.status === 'skipped'
                            ? '已跳过'
                            : '排队等待'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 置顶操作反馈横幅（无论在哪个分区执行操作，结果立即显示在顶部） */}
      {outcome === undefined ? null : (
        <div
          style={{
            border: '1px solid ' + (outcome.ok ? C.ok : C.err),
            borderLeft: '4px solid ' + (outcome.ok ? C.ok : C.err),
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 12.5,
            background: C.layer1,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600, color: outcome.ok ? C.ok : C.err }}>
              {outcome.ok ? '✓ ' : '✕ '}
              {outcome.title}
            </span>
            <Btn size="sm" tone="ghost" onClick={() => setOutcome(undefined)}>
              关闭
            </Btn>
          </div>
          {outcome.detail === undefined ? null : <Meta>{outcome.detail}</Meta>}
          {outcome.output === undefined ? null : (
            <pre
              style={{
                margin: 0,
                maxHeight: 160,
                overflow: 'auto',
                fontFamily: MONO,
                fontSize: 11,
                color: C.dim,
                background: C.layer2,
                borderRadius: 6,
                padding: 8,
                whiteSpace: 'pre-wrap',
              }}
            >
              {outcome.output}
            </pre>
          )}
        </div>
      )}

      {reminder?.core.hasUpdate === true && confirming === undefined ? (
        <div
          style={{
            border: '1px solid ' + (reminder.core.level === 'major' ? C.err : C.brand),
            borderLeft: '4px solid ' + (reminder.core.level === 'major' ? C.err : C.brand),
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            background: C.layer1,
          }}
        >
          <Tag tone={reminder.core.level === 'major' ? C.err : C.brand}>{reminder.core.label ?? '有更新'}</Tag>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            DSH 本体可升级：{reminder.core.current ?? '?'} → {reminder.core.target ?? '?'}
          </span>
          <Meta>
            {reminder.core.channel === 'preview' ? '预览通道' : '正式通道'} · 更新会重启服务（备份 → 停服 → 安装 → 健康检查 → 失败自动回滚）
          </Meta>
          <Actions>
            <Btn
              tone={reminder.core.level === 'major' ? 'danger' : 'primary'}
              disabled={anyBusy}
              onClick={() => setConfirming(reminder.core.target ?? '')}
            >
              {anyBusy ? '⏸ 等待当前任务…' : `更新本体到 ${reminder.core.target}`}
            </Btn>
          </Actions>
        </div>
      ) : null}

      {restarting ? (
        <div style={{ fontSize: 12.5, color: C.warn, border: '1px solid ' + C.warn, borderRadius: 8, padding: '8px 12px' }}>
          服务重启中，等新进程回来…（这期间连不上是正常的）
        </div>
      ) : null}

      {error === undefined ? null : (
        <div style={{ fontSize: 12, color: C.err, border: '1px solid ' + C.err, borderRadius: 8, padding: '8px 12px' }}>{error}</div>
      )}
      {notice === undefined ? null : (
        <div style={{ fontSize: 12, color: C.dim, border: '1px solid ' + C.line, borderRadius: 8, padding: '8px 12px' }}>{notice}</div>
      )}

      {snapshot === undefined ? (
        <Empty>读取本机插件清单…</Empty>
      ) : (
        <>
          {pendingRestart.length === 0 && !restarting ? null : (
            <RestartBanner
              items={pendingRestart}
              restarting={restarting}
              busy={anyBusy}
              allow={true}
              onRestart={() => void restartService()}
              onLater={() => void dismissRestart()}
            />
          )}

          {/* 首屏 9 大全栈状态卡片：显式分为上下两层（第一层：5 项核心运行与基础设施；第二层：4 项工程仓库与系统治理） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 10 }}>
              <Stat
                label="DSH 本体"
                icon="🧠"
                value={reminder?.core.hasUpdate === true ? '有更新' : '已最新'}
                tone={reminder?.core.hasUpdate !== true ? C.ok : reminder.core.level === 'major' ? C.err : C.brand}
                hint={`当前 ${snapshot.core.version ?? '?'} · 需重启 ${pendingRestart.length}`}
                active={activeTab === 'dsh'}
                onClick={() => setActiveTab(activeTab === 'dsh' ? 'overview' : 'dsh')}
              />
              <Stat
                label="DSH 插件套件"
                icon="🧩"
                value={stableUpdates > 0 ? `${stableUpdates} 可更` : '已最新'}
                tone={stableUpdates > 0 ? C.brand : C.ok}
                hint={`${registryRows.length} 线上 · ${localTotal} 本地定制`}
                active={activeTab === 'dsh'}
                onClick={() => setActiveTab(activeTab === 'dsh' ? 'overview' : 'dsh')}
              />
              <Stat
                label="三节点 Docker"
                icon="🐳"
                value={infra === undefined ? '待加载' : dockerUpdatable > 0 ? `${dockerUpdatable} 可更` : '已最新'}
                tone={dockerUpdatable > 0 ? C.brand : C.ok}
                hint={infra === undefined ? '点击查看' : `共 ${dockerTotal} 个 · ${dockerLocked} 个保护锁`}
                active={activeTab === 'docker'}
                onClick={() => setActiveTab(activeTab === 'docker' ? 'overview' : 'docker')}
              />
              <Stat
                label="双节点系统 APT"
                icon="🛡️"
                value={infra === undefined ? '待加载' : aptSafeCount > 0 ? `${aptSafeCount} 可更` : '已最新'}
                tone={aptSafeCount > 0 ? C.brand : C.ok}
                hint={infra === undefined ? 'VM100 + PVE' : `PVE 门禁锁 ${aptLockedCount} 个`}
                active={activeTab === 'apt'}
                onClick={() => setActiveTab(activeTab === 'apt' ? 'overview' : 'apt')}
              />
              <Stat
                label="本机 CLI 工具链"
                icon="🧰"
                value={infra?.toolchain === undefined ? '待加载' : toolchainUpdatable > 0 ? `${toolchainUpdatable} 可更` : '已最新'}
                tone={toolchainUpdatable > 0 ? C.brand : C.ok}
                hint={infra?.toolchain === undefined ? 'uv/pnpm/CLI/Obsidian' : `${toolchainTotal} 项受控工具均最新`}
                active={activeTab === 'toolchain'}
                onClick={() => setActiveTab(activeTab === 'toolchain' ? 'overview' : 'toolchain')}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
              <Stat
                label="Python 虚拟环境"
                icon="🐍"
                value={infra?.venvs === undefined ? '待加载' : venvSafeCount > 0 ? `${venvSafeCount} 可更` : '已最新'}
                tone={venvSafeCount > 0 ? C.brand : C.ok}
                hint={infra?.venvs === undefined ? '项目 .venv' : `${venvTotal} 个环境同主版本已最新`}
                active={activeTab === 'venv'}
                onClick={() => setActiveTab(activeTab === 'venv' ? 'overview' : 'venv')}
              />
              <Stat
                label="Git 仓库与技能"
                icon="🌿"
                value={infra?.gitRepos === undefined ? '待加载' : gitUpdatableCount > 0 ? `${gitUpdatableCount} 可同步` : '已最新'}
                tone={gitUpdatableCount > 0 ? C.brand : C.ok}
                hint={infra?.gitRepos === undefined ? 'Skills / 插件 / 工程' : `共 ${gitTotalCount} 个 · ${gitLockedCount} 改动锁`}
                active={activeTab === 'git'}
                onClick={() => setActiveTab(activeTab === 'git' ? 'overview' : 'git')}
              />
              <Stat
                label="存储与缓存 GC"
                icon="🧹"
                value={infra?.cleanups === undefined ? '待加载' : cleanupActionableCount > 0 ? `可省 ${cleanupTotalReclaimText}` : '清爽健康'}
                tone={cleanupActionableCount > 0 ? C.brand : C.ok}
                hint={infra?.cleanups === undefined ? 'Docker/pnpm/uv/日志' : `${cleanupActionableCount} 项建议清理`}
                active={activeTab === 'cleanup'}
                onClick={() => setActiveTab(activeTab === 'cleanup' ? 'overview' : 'cleanup')}
              />
              <Stat
                label="Systemd 巡检"
                icon="🩺"
                value={infra?.systemdHealth === undefined ? '待加载' : systemdFailedCount > 0 ? `${systemdFailedCount} 异常` : '全绿健康'}
                tone={systemdFailedCount > 0 ? C.err : C.ok}
                hint={infra?.systemdHealth === undefined ? '服务与定时器' : `${systemdTimersCount} 个活跃定时器运行中`}
                active={activeTab === 'systemd'}
                onClick={() => setActiveTab(activeTab === 'systemd' ? 'overview' : 'systemd')}
              />
            </div>
          </div>

          {showDsh ? (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
                  gap: 14,
                  alignItems: 'start',
                }}
              >
                <CoreSection
                  snapshot={snapshot}
                  coreRun={coreRun}
                  restartRun={restartRun}
                  confirming={confirming}
                  launching={launching}
                  anyBusy={anyBusy}
                  onAskCore={(version) => setConfirming(version)}
                  onCancelCore={() => setConfirming(undefined)}
                  onLaunchCore={(version) => void launchCore(version)}
                />
                <EnvSection env={snapshot.env} deepLoading={deepLoading} onDeep={() => void deep()} />
              </div>

              {batch === undefined ? null : <BatchCard batch={batch} onCancel={() => void cancelBatch()} />}

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
                  gap: 14,
                  alignItems: 'start',
                }}
              >
                <Section title="🧩 可更新的线上套件" count={registryRows.length + ' 个 registry 源'}>
                  {filteredRegistryRows.length === 0 ? (
                    <Empty>{onlyActionable ? '所有线上 registry 套件均已是最新。' : '没有可从 registry 查询的插件。'}</Empty>
                  ) : (
                    filteredRegistryRows.map((row, index) => {
                      const isCompleted = completedKeys[`bundle:${row.name}`]
                      const effectiveRow: UpdateRow =
                        isCompleted !== undefined
                          ? { ...row, installed: isCompleted, status: 'latest' }
                          : row
                      const stableTarget = effectiveRow.status === 'update' ? effectiveRow.stable?.version : undefined
                      const previewTarget =
                        effectiveRow.preview !== undefined &&
                        effectiveRow.preview.version !== effectiveRow.stable?.version &&
                        effectiveRow.preview.version !== effectiveRow.installed
                          ? effectiveRow.preview.version
                          : undefined
                      const isBusy = busy === row.name || batchItemRunning === row.name
                      return (
                        <Row key={row.name} last={index === filteredRegistryRows.length - 1}>
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 180, flex: '1 1 200px' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <Name title={row.source ?? row.name}>{row.name}</Name>
                              <Tag tone={sourceTone(effectiveRow.sourceKind)}>{SOURCE_TEXT[effectiveRow.sourceKind] ?? effectiveRow.sourceKind}</Tag>
                            </span>
                            <Meta title={row.detail}>{rowLine(effectiveRow)}</Meta>
                          </span>
                          <Actions>
                            {isBusy ? (
                              <Btn size="sm" disabled title="当前插件正在安装并热重载中，请稍候…">
                                ⏳ 正在更新…
                              </Btn>
                            ) : (
                              <>
                                {stableTarget === undefined ? null : (
                                  <Btn
                                    tone="primary"
                                    disabled={anyBusy}
                                    onClick={() => void apply(row.name, stableTarget)}
                                    title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : '热更新到正式版 ' + stableTarget}
                                  >
                                    {anyBusy ? '⏸ 等待当前任务…' : '更新到 ' + stableTarget}
                                  </Btn>
                                )}
                                {previewTarget === undefined ? null : (
                                  <Btn
                                    size="sm"
                                    disabled={anyBusy}
                                    onClick={() => void apply(row.name, previewTarget)}
                                    title={anyBusy ? '当前有其他更新任务正在执行，请等待完成后再操作' : '热更新到预览版 ' + previewTarget}
                                  >
                                    {anyBusy ? '⏸ 等待…' : '预览 ' + previewTarget}
                                  </Btn>
                                )}
                                {stableTarget === undefined && previewTarget === undefined ? (
                                  <Tag tone={effectiveRow.status === 'local-ahead' ? C.ok : effectiveRow.status === 'unknown' ? C.idle : C.ok}>
                                    {effectiveRow.status === 'local-ahead' ? '本地领先' : effectiveRow.status === 'unknown' ? '上游未知' : '已最新'}
                                  </Tag>
                                ) : null}
                              </>
                            )}
                          </Actions>
                        </Row>
                      )
                    })
                  )}
                </Section>

                <Section
                  title="🔒 非线上来源 (本地定制保护)"
                  count={localTotal === 0 ? '没有本地源' : localTotal + ' 项（本地链接 / git / 压缩包 / 注入）'}
                >
                  {filteredLocalRows.length === 0 ? (
                    <Empty>{onlyActionable ? '所有本地定制插件均受白名单保护，无待转换项。' : '全部来自 registry。'}</Empty>
                  ) : (
                    filteredLocalRows.map((row, index) => {
                      const upstream = row.upstream
                      const delta = row.localDelta
                      const isBusy = busy === row.name
                      const isConverted = completedKeys[`convert:${row.name}`]
                      const canConvert = isConverted === undefined && upstream?.convertible === true && upstream.version !== undefined
                      const clean = delta?.status === 'identical'
                      const confirmingThis = confirmConvert === row.name
                      const deltaText =
                        delta === undefined
                          ? ''
                          : delta.status === 'identical'
                            ? '与上游逐文件一致，转换无损'
                            : delta.status === 'modified'
                              ? '本地与上游不同（' +
                                [
                                  (delta.modifiedCount ?? 0) > 0 ? '内容不同 ' + delta.modifiedCount : '',
                                  (delta.localOnlyCount ?? 0) > 0 ? '仅本地有 ' + delta.localOnlyCount : '',
                                  (delta.upstreamOnlyCount ?? 0) > 0 ? '仅上游有 ' + delta.upstreamOnlyCount : '',
                                ]
                                  .filter((part) => part !== '')
                                  .join(' / ') +
                                '），转线上后生效的是上游版本'
                              : '无法比对本地改动：' + String(delta.reason ?? '')
                      return (
                        <Row key={row.name} last={index === filteredLocalRows.length - 1}>
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 180, flex: '1 1 200px' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <Name title={row.source ?? row.name}>{row.name}</Name>
                              <Tag tone={isConverted ? C.ok : sourceTone(row.sourceKind)}>
                                {isConverted ? '已转线上' : (SOURCE_TEXT[row.sourceKind] ?? row.sourceKind)}
                              </Tag>
                              <Meta>{isConverted ?? row.installed ?? '—'}</Meta>
                            </span>
                            <Meta title={row.detail}>
                              {isConverted
                                ? `已成功切换为线上版本 ${isConverted}`
                                : canConvert
                                  ? '上游有 ' + upstream.version + (deltaText === '' ? '' : ' · ' + deltaText)
                                  : (upstream?.reason ?? row.detail ?? '本地源，上游无同名包')}
                            </Meta>
                          </span>
                          <Actions>
                            {isBusy ? (
                              <Btn size="sm" disabled title="当前插件正在转换为线上版本，请稍候…">
                                ⏳ 正在转换…
                              </Btn>
                            ) : isConverted !== undefined ? (
                              <Tag tone={C.ok}>已最新</Tag>
                            ) : canConvert ? (
                              clean ? (
                                <Btn
                                  tone="primary"
                                  disabled={anyBusy}
                                  onClick={() => void convert(row)}
                                  title={
                                    anyBusy
                                      ? '当前有其他更新任务正在执行，请等待完成后再操作'
                                      : '与上游 ' + upstream.version + ' 逐文件一致；先摘掉本地来源再从上游装，失败自动恢复'
                                  }
                                >
                                  {anyBusy ? '⏸ 等待当前任务…' : '转为线上 ' + upstream.version}
                                </Btn>
                              ) : (
                                <Btn
                                  tone="danger"
                                  disabled={anyBusy}
                                  onClick={() => setConfirmConvert(confirmingThis ? undefined : row.name)}
                                  title={
                                    anyBusy
                                      ? '当前有其他更新任务正在执行，请等待完成后再操作'
                                      : '本地与上游 ' + upstream.version + ' 不一致，点开确认后再转'
                                  }
                                >
                                  {anyBusy ? '⏸ 等待当前任务…' : '转为线上（本地有改动）'}
                                </Btn>
                              )
                            ) : (
                              <Tag tone={C.idle}>定制受保护</Tag>
                            )}
                          </Actions>
                          {confirmingThis ? (
                            <div
                              style={{
                                flexBasis: '100%',
                                border: '1px solid ' + C.err,
                                borderRadius: 8,
                                padding: '10px 12px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                                marginTop: 4,
                              }}
                            >
                              <span style={{ fontSize: 12.5, color: C.err, fontWeight: 600 }}>
                                转线上后生效的是上游 {upstream?.version}，你本地的改动不再生效（本地目录不会被删除）。确认继续？
                              </span>
                              {delta?.changedFiles === undefined || delta.changedFiles.length === 0 ? null : (
                                <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim, lineHeight: '17px', wordBreak: 'break-all' }}>
                                  {delta.changedFiles.join('、')}
                                  {(delta.changedCount ?? 0) > delta.changedFiles.length ? ' …共 ' + delta.changedCount + ' 个文件' : ''}
                                </span>
                              )}
                              <span style={{ display: 'flex', gap: 8 }}>
                                <Btn tone="danger" disabled={anyBusy} onClick={() => void convert(row, true)}>
                                  {isBusy ? '⏳ 转换中…' : '确认覆盖并转换'}
                                </Btn>
                                <Btn tone="ghost" disabled={anyBusy} onClick={() => setConfirmConvert(undefined)}>
                                  取消
                                </Btn>
                              </span>
                            </div>
                          ) : null}
                        </Row>
                      )
                    })
                  )}
                </Section>
              </div>
            </>
          ) : null}

          {showInfra ? (
            <InfraSection
              infra={infra}
              loading={infraLoading}
              busyKey={infraBusy}
              anyBusy={anyBusy}
              completedKeys={completedKeys}
              activeTab={activeTab}
              onlyActionable={onlyActionable}
              onScan={(refresh) => void loadInfra(refresh)}
              onUpdateDocker={(node, name) => void handleUpdateDocker(node, name)}
              onUpdateApt={(node) => void handleUpdateApt(node)}
              onUpdateToolchain={(id, name) => void handleUpdateToolchain(id, name)}
              onUpdateVenv={(projectId, projectName) => void handleUpdateVenv(projectId, projectName)}
              onPullGit={(id, name) => void handlePullGit(id, name)}
              onRunCleanup={(id, name) => void handleRunCleanup(id, name)}
              onFixSystemd={(id, name) => void handleFixSystemd(id, name)}
            />
          ) : null}

          {showHistory ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14, alignItems: 'start' }}>
                <HistoryCard entries={history} />
                <LogBox />
              </div>

              <details style={{ border: '1px solid ' + C.line, borderRadius: 12, background: C.layer1, color: C.text, padding: '10px 16px' }}>
                <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text }}>侧栏入口太多？</summary>
                <div style={{ fontSize: 12, color: C.dim, lineHeight: '19px', marginTop: 8 }}>
                  点侧栏底部的「更多」按钮，里面有「侧栏入口」开关：把「自动化任务」「技能中心」这类不常用的入口收进那里，
                  侧栏就只剩常用的几个（选择会被记住）。收起的入口仍在这个菜单里，随时点开。
                  <br />
                  「插件」入口由平台固定显示，目前无法收起。
                </div>
              </details>
            </>
          ) : null}

          {snapshot.warnings.length === 0 ? null : (
            <div style={{ fontSize: 11, color: C.warn, lineHeight: '18px' }}>
              {snapshot.warnings.map((warning) => (
                <div key={warning}>· {warning}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function PanelIcon({ size }: { size: number; active?: boolean }) {
  const reminder = useReminder()
  const count = reminder?.plugins.count ?? 0
  const core = reminder?.core
  const coreUpdate = core?.hasUpdate === true
  const major = core?.level === 'major'
  const dotColor = major ? C.err : C.brand
  const text = reminderText(reminder)

  return (
    <span
      data-dsh-panel-entry={PANEL_ID}
      title={text}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
      }}
    >
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.15" />
        <path d="M13.6 2.2v3.1h-3.1" />
        <path d="M8 5.2v4.1" />
        <path d="M6.3 7.8 8 9.5l1.7-1.7" />
      </svg>
      {count > 0 ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -5,
            right: -7,
            minWidth: 14,
            height: 14,
            padding: '0 3px',
            borderRadius: 999,
            background: C.err,
            color: '#fff',
            fontSize: 9,
            fontWeight: 600,
            lineHeight: '14px',
            textAlign: 'center',
            boxShadow: '0 0 0 1.5px var(--dsw-specific-sidebar-fill, #fff)',
            pointerEvents: 'none',
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : coreUpdate ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -1,
            right: -2,
            width: major ? 8 : 7,
            height: major ? 8 : 7,
            borderRadius: 999,
            background: dotColor,
            boxShadow: '0 0 0 1.5px var(--dsw-specific-sidebar-fill, #fff)',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {coreUpdate && count > 0 ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: -1,
            left: -1,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor,
            boxShadow: '0 0 0 1.5px var(--dsw-specific-sidebar-fill, #fff)',
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </span>
  )
}


// ── 侧栏入口收纳（官方 pin 机制） ──────────────────────────────────────────
//
// 平台没有「删除别人注册的侧栏入口」的 API；唯一官方开关是 `sidebar.panellist.actions`
// 这一格里的 `onPinnedChange(id, pinned)`：unpin 只是把那一行从侧栏挪进「更多」菜单，
// 页面本身、注册与选中状态都不变（见 ui-sidebar README）。
//
// 限制（如实写死在这里，免得以后又去试）：① 这个回调只在「更多」菜单打开时可用
// （菜单内容是 open && 渲染的）；② pin 状态是内存态，页面刷新/插件重载后重置，
// 所以偏好存在 localStorage，每次打开菜单时重放一次；③ 平台硬编码 `plugins` 入口
// 不可 unpin（setPinned 内部直接 return），它只能靠停用插件管理界面来移除。

const HIDDEN_PANELS_KEY = 'dsh-update-center.hidden-panels'

interface PanelActionEntry {
  id: string
  label: string
  pinned: boolean
  active: boolean
}

function readHiddenPanels(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_PANELS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function writeHiddenPanels(ids: string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_PANELS_KEY, JSON.stringify(ids))
  } catch {
    /* 隐私模式下写不进去：本次会话仍然生效 */
  }
}

function EntryToggle({
  entry,
  hidden,
  onToggle,
}: {
  entry: PanelActionEntry
  hidden: boolean
  onToggle: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', color: C.text }}>
      <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text }}>
        {entry.label}
      </span>
      {entry.active ? <Tag tone={C.brand}>当前</Tag> : null}
      <button
        type="button"
        onClick={onToggle}
        title={hidden ? '收进「更多」菜单' : '显示在侧栏'}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          height: 22,
          padding: '0 10px',
          borderRadius: 6,
          border: '1px solid ' + (hidden ? C.line2 : '#2563eb'),
          backgroundColor: hidden ? 'transparent' : '#2563eb',
          color: hidden ? C.dim : '#ffffff',
          fontSize: 11.5,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {hidden ? '已收起' : '显示中'}
      </button>
    </div>
  )
}

/** 「更多」菜单里的「侧栏入口」管理区：开关即效，偏好持久化。 */
function PanelEntryMenu({
  entries,
  onPinnedChange,
}: {
  entries: readonly PanelActionEntry[]
  onPinnedChange: (id: string, pinned: boolean) => void
  onOpen?: (id: string) => void
  onDismiss?: () => void
}) {
  // 菜单每次打开都会重新挂载：这是唯一能拿到回调的时机，顺便把偏好重放一遍。
  // 展示状态一律以 entry.pinned 为准（localStorage 只是「期望」，可能还没落地）。
  useEffect(() => {
    const wanted = readHiddenPanels()
    for (const entry of entries) {
      const shouldShow = !wanted.includes(entry.id)
      if (entry.pinned !== shouldShow) onPinnedChange(entry.id, shouldShow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (entries.length === 0) return null

  const toggle = (entry: PanelActionEntry) => {
    const wanted = readHiddenPanels()
    // 当前是「显示中」→ 收起来；否则放回来。
    const next = entry.pinned
      ? wanted.includes(entry.id)
        ? wanted
        : [...wanted, entry.id]
      : wanted.filter((id) => id !== entry.id)
    writeHiddenPanels(next)
    onPinnedChange(entry.id, !entry.pinned)
  }

  return (
    <div style={{ borderTop: '1px solid ' + C.line, marginTop: 6, paddingTop: 6 }}>
      <div style={{ padding: '2px 10px 4px', fontSize: 11, color: C.dim }}>
        侧栏入口（收起的会留在这个菜单里）
      </div>
      {entries.map((entry) => (
        <EntryToggle key={entry.id} entry={entry} hidden={entry.pinned !== true} onToggle={() => toggle(entry)} />
      ))}
      <div style={{ padding: '4px 10px 2px', fontSize: 10.5, color: C.idle, lineHeight: '15px' }}>
        「插件」入口由平台固定显示，无法收起。
      </div>
    </div>
  )
}

export function apply(ctx: any): void {
  const slots = ctx?.slots
  if (slots === undefined || slots === null || typeof slots.register !== 'function') return
  const register = slots.register.bind(slots) as (options: object, component: unknown) => () => void
  const injectSlot = slots.inject.bind(slots) as (name: string, callback: () => () => void) => () => void
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    disposers.push(
      injectSlot('sidebar.panellist', () =>
        register({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => '更新中心' }, PanelIcon),
      ),
    )
    disposers.push(injectSlot('main', () => register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, PanelPage)))
    // 侧栏「更多」菜单里的入口管理（官方 pin 机制：unpin = 收进这个菜单）
    disposers.push(
      injectSlot('sidebar.panellist.actions', () =>
        register({ name: 'sidebar.panellist.actions', id: 'dsh-update-center-panels', order: 40 }, PanelEntryMenu),
      ),
    )
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch {
          /* 已释放 */
        }
      }
    }
  }, 'dsh-update-center: panel seats')
}
