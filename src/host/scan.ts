/**
 * 只读扫描：把"本机装了什么、上游有什么"整理成一份快照。
 *
 * 数据来源三层：
 * 1. pluginManager（宿主官方服务）——已装套件/插件的版本、来源与可更新性；
 * 2. npm registry dist-tags + pnpm view（经 pluginManager.listVersions）——上游版本；
 * 3. 本机文件与命令——DSH 本体安装位置、注入插件注册表、node/pnpm/服务状态。
 *
 * 这里不做任何写入：唯一写路径是 index.ts 里的 updateBundle。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  ChannelHit,
  CoreFacts,
  EnvFacts,
  Snapshot,
  UpdateRow,
  UpstreamProbe,
} from '../shared/types.js'
import { compareVersions, isPrerelease } from './semver.js'
import { compareLocalWithUpstream } from './upstream-compare.js'

export interface ScanConfig {
  registry: string
  timeoutMs: number
}

type AnyService = Record<string, any> | undefined

interface PublishedVersionLike {
  version: string
  publishedAt?: string
  tags?: readonly string[]
  prerelease: boolean
  deprecated?: string
  bundle: boolean
  incompatible?: unknown
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function dshHome(): string {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** 从运行中的入口脚本往上找到 @deepseek-ai/dsh 包根，再兜底常见安装位置。 */
export function findCoreRoot(): string | undefined {
  let dir: string | undefined
  const entry = process.argv[1]
  if (entry !== undefined) dir = dirname(resolve(entry))
  while (dir !== undefined) {
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest?.name === '@deepseek-ai/dsh') return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const candidates = [
    join(homedir(), 'dsh-runtime/node_modules/@deepseek-ai/dsh'),
    join(dshHome(), 'runtime/node_modules/@deepseek-ai/dsh'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** 本体安装的运行时根（`…/node_modules/@deepseek-ai/dsh` 往上三层）。 */
export function coreRuntimeDir(): string | undefined {
  const root = findCoreRoot()
  if (root === undefined) return undefined
  const dir = dirname(dirname(dirname(root)))
  return existsSync(join(dir, 'package.json')) ? dir : undefined
}

function findProfileDir(): string | undefined {
  const explicit = process.env.DSH_PROFILE
  const profilesDir = join(dshHome(), 'profiles')
  if (explicit !== undefined && existsSync(join(profilesDir, explicit, 'package.json'))) {
    return join(profilesDir, explicit)
  }
  const guess = join(profilesDir, 'web')
  if (existsSync(join(guess, 'package.json'))) return guess
  return undefined
}

/** npm 的 dist-tags 端点：只回几十字节，比拉整包文档轻得多。 */
async function fetchDistTags(
  registry: string,
  name: string,
  timeoutMs: number,
): Promise<Record<string, string> | undefined> {
  const encoded = name.startsWith('@')
    ? '@' + encodeURIComponent(name.slice(1))
    : encodeURIComponent(name)
  const url = registry.replace(/\/+$/, '') + '/-/package/' + encoded + '/dist-tags'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const body = (await response.json()) as unknown
    if (body === null || typeof body !== 'object') return undefined
    const tags: Record<string, string> = {}
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'string') tags[key] = value
    }
    return Object.keys(tags).length > 0 ? tags : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 单个版本的 manifest：只用来读 `dsh.bundle` 声明，几百字节到几 KB。 */
async function fetchVersionManifest(
  registry: string,
  name: string,
  version: string,
  timeoutMs: number,
): Promise<any | undefined> {
  const encodedName = name.startsWith('@')
    ? '@' + encodeURIComponent(name.slice(1))
    : encodeURIComponent(name)
  const url = registry.replace(/\/+$/, '') + '/' + encodedName + '/' + encodeURIComponent(version)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    return (await response.json()) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 上游有没有同名包、能不能把这条本地源换成线上依赖。
 *
 * 只做只读判断，真正的转换在 host/convert.ts。判定口径：
 *   - 上游查不到（404 / 私有 401）→ 不可转；
 *   - 上游最新版低于本地 → 不可转（那是降级）；
 *   - 上游这一版没有 `dsh.bundle` → 不可转（装上不会生效）。
 */
/**
 * 本地自研受保护包判定：
 *   1. `@dsh-external/` 命名空间下的本地外置扩展；
 *   2. `~/.dsh/update-center/infra-config.json` 中 `protectedPackages` 配置的包名；
 *   3. 本地源码目录（`link:` / `file:`）下的 `package.json` 含 `"private": true` 或 `"dshProtected": true`；
 *   4. 内置默认受保护包白名单。
 */
export const LOCAL_PROTECTED_PACKAGES = new Set<string>([
  '@dsh-external/dsh-update-center',
  'dsh-update-center',
])

function readUserProtectedPackages(): Set<string> {
  const cfg = readJson(join(dshHome(), 'update-center', 'infra-config.json'))
  const set = new Set<string>(LOCAL_PROTECTED_PACKAGES)
  if (Array.isArray(cfg?.protectedPackages)) {
    for (const item of cfg.protectedPackages) {
      if (typeof item === 'string' && item.trim() !== '') set.add(item.trim())
    }
  }
  return set
}

export function isLocalProtectedPackage(name: string, localDir?: string): boolean {
  if (name.startsWith('@dsh-external/')) return true
  if (readUserProtectedPackages().has(name)) return true
  if (localDir !== undefined && localDir !== '') {
    const pkg = readJson(join(localDir, 'package.json'))
    if (pkg?.private === true || pkg?.dshProtected === true || pkg?.dsh?.protected === true) {
      return true
    }
  }
  return false
}

export async function probeUpstream(
  registry: string,
  name: string,
  installed: string | undefined,
  timeoutMs: number,
  localDir?: string,
): Promise<UpstreamProbe> {
  if (isLocalProtectedPackage(name, localDir)) {
    return {
      found: false,
      convertible: false,
      reason: '本地自研受保护包（白名单/private 锁定，不转公共 npm 源）',
    }
  }
  const tags = await fetchDistTags(registry, name, timeoutMs)
  if (tags === undefined) {
    return { found: false, convertible: false, reason: '上游查不到同名包（未发布或私有源）' }
  }
  const tagVersions = Object.values(tags)
  const latest =
    tags.latest ??
    tagVersions.sort((left, right) => compareVersions(right, left))[0]
  if (latest === undefined) {
    return { found: false, convertible: false, reason: '上游没有可用的版本标签' }
  }
  const manifest = await fetchVersionManifest(registry, name, latest, timeoutMs)
  const bundle = manifest === undefined ? undefined : manifest?.dsh?.bundle !== undefined && manifest?.dsh?.bundle !== null
  const tarballUrl = typeof manifest?.dist?.tarball === 'string' ? manifest.dist.tarball : undefined
  const position =
    installed === undefined || installed === ''
      ? 'unknown'
      : compareVersions(latest, installed) > 0
        ? 'newer'
        : compareVersions(latest, installed) === 0
          ? 'same'
          : 'older'
  const base: UpstreamProbe = {
    found: true,
    version: latest,
    ...(bundle === undefined ? {} : { bundle }),
    position,
    convertible: false,
    ...(tarballUrl === undefined ? {} : { tarballUrl }),
  }
  if (position === 'older') {
    return { ...base, reason: '上游最新 ' + latest + ' 低于本地 ' + String(installed) + '（转过去等于降级）' }
  }
  if (bundle === false) {
    return { ...base, reason: '上游这一版没有 dsh.bundle 声明，装上不会作为套件生效' }
  }
  return { ...base, convertible: true }
}

/** 通道候选：正式版取"最新且非 prerelease"，预览版取"最新（prerelease 也算）"。 */function pickChannels(
  versions: { version: string; publishedAt?: string; deprecated?: string }[],
  tagsOf: (version: string) => string[],
): { stable?: ChannelHit; preview?: ChannelHit } {
  const sorted = [...versions].sort((left, right) => compareVersions(right.version, left.version))
  const toHit = (entry: { version: string; publishedAt?: string; deprecated?: string }): ChannelHit => ({
    version: entry.version,
    tags: tagsOf(entry.version),
    ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
    ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
  })
  const stable = sorted.find((entry) => !isPrerelease(entry.version))
  const preview = sorted[0]
  return {
    ...(stable === undefined ? {} : { stable: toHit(stable) }),
    ...(preview === undefined ? {} : { preview: toHit(preview) }),
  }
}

function statusOf(installed: string | undefined, channels: { stable?: ChannelHit; preview?: ChannelHit }): UpdateRow['status'] {
  if (channels.stable === undefined && channels.preview === undefined) return 'latest'
  const target = channels.preview
  if (installed === undefined || target === undefined) return 'unknown'
  if (compareVersions(target.version, installed) <= 0) return 'local-ahead'
  if (channels.stable !== undefined && compareVersions(channels.stable.version, installed) > 0) return 'update'
  return 'preview-only'
}

/** 本地源对应的绝对目录：`link:` 去掉前缀，`file:` / 裸路径直接用。 */
export function localDirOf(source: string | undefined): string | undefined {
  if (source === undefined || source === '') return undefined
  if (source.startsWith('link:')) return source.slice('link:'.length)
  if (source.startsWith('file:')) return source.slice('file:'.length)
  if (source.startsWith('/')) return source
  return undefined
}

function classifySource(source: string | undefined): UpdateRow['sourceKind'] {
  if (source === undefined || source === '') return 'npm'
  if (source.startsWith('link:')) return 'link'
  if (source.startsWith('file:')) return 'local'
  if (source.startsWith('github:') || source.includes('git+') || source.endsWith('.git')) return 'git'
  if (source.startsWith('http') && (source.endsWith('.tgz') || source.includes('.tgz?'))) return 'tarball'
  return 'npm'
}

async function execText(command: string, args: string[], timeout: number): Promise<string | undefined> {
  return await new Promise<string | undefined>((done) => {
    execFile(command, args, { timeout, maxBuffer: 1 << 20, env: process.env }, (error, stdout) => {
      if (error !== null) {
        done(undefined)
        return
      }
      done(String(stdout).trim())
    })
  })
}

async function probeEnv(deep: boolean, timeoutMs: number): Promise<EnvFacts> {
  const [pnpm, git, active, since, os] = await Promise.all([
    execText('pnpm', ['--version'], timeoutMs),
    execText('git', ['--version'], timeoutMs),
    execText('systemctl', ['is-active', 'dsh.service'], timeoutMs),
    execText('systemctl', ['show', 'dsh.service', '-p', 'ActiveEnterTimestamp', '--value'], timeoutMs),
    execText('bash', ['-lc', '. /etc/os-release 2>/dev/null && printf "%s" "${PRETTY_NAME:-}"'], timeoutMs),
  ])
  const facts: EnvFacts = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dshHome: dshHome(),
    ...(findProfileDir() === undefined ? {} : { profileDir: findProfileDir() }),
    ...(pnpm === undefined ? {} : { pnpm }),
    ...(git === undefined ? {} : { git }),
    service: {
      name: 'dsh.service',
      ...(active === undefined ? {} : { active }),
      ...(since === undefined || since === '' ? {} : { since }),
    },
    ...(os === undefined || os === '' ? {} : { os }),
    deepChecked: false,
  }
  if (deep) {
    facts.deepChecked = true
    const listing = await execText('bash', ['-lc', 'apt list --upgradable 2>/dev/null'], 20_000)
    if (listing === undefined) {
      facts.upgradable = { sample: [], error: 'apt 不可用或超时' }
    } else {
      const lines = listing.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('Listing'))
      facts.upgradable = {
        count: lines.length,
        sample: lines.slice(0, 8).map((line) => line.split(' ')[0] ?? line),
      }
    }
  }
  return facts
}

export function readInjections(): { registryPath: string; entries: { name: string; version?: string; dir?: string; injectedAt?: string }[] } {
  const registryPath = join(dshHome(), 'super-injector', 'registry.json')
  const raw = readJson(registryPath)
  if (!Array.isArray(raw)) return { registryPath, entries: [] }
  const entries = raw
    .filter((entry: any) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string')
    .map((entry: any) => {
      const manifest = typeof entry.dir === 'string' ? readJson(join(entry.dir, 'package.json')) : undefined
      return {
        name: entry.name as string,
        ...(typeof manifest?.version === 'string' ? { version: manifest.version } : {}),
        ...(typeof entry.dir === 'string' ? { dir: entry.dir } : {}),
        ...(typeof entry.at === 'string' ? { injectedAt: entry.at } : {}),
      }
    })
  return { registryPath, entries }
}

async function scanBundles(
  pluginManager: AnyService,
  config: ScanConfig,
  warnings: string[],
  options: { probe: boolean },
): Promise<{ rows: UpdateRow[]; scanned: number; skipped: number }> {
  if (pluginManager === undefined || typeof pluginManager.listBundles !== 'function') {
    warnings.push('pluginManager 不可用：套件与插件清单无法读取')
    return { rows: [], scanned: 0, skipped: 0 }
  }
  let bundles: any[] = []
  try {
    bundles = (await pluginManager.listBundles()) ?? []
  } catch (error) {
    warnings.push('listBundles 失败：' + String(error))
    return { rows: [], scanned: 0, skipped: 0 }
  }
  const rows: UpdateRow[] = []
  let scanned = 0
  let skipped = 0
  const queue = bundles.filter((bundle) => bundle !== null && typeof bundle.name === 'string')

  const runOne = async (bundle: any): Promise<UpdateRow> => {
    const sourceKind = classifySource(typeof bundle.source === 'string' ? bundle.source : undefined)
    const base: UpdateRow = {
      name: bundle.name,
      kind: 'bundle',
      ...(typeof bundle.version === 'string' ? { installed: bundle.version } : {}),
      sourceKind,
      ...(typeof bundle.source === 'string' ? { source: bundle.source } : {}),
      enabled: bundle.enabled === true,
      updatable: bundle.updatable === true,
      // 下面每个分支都会覆盖它；这里只是给类型一个占位。
      status: 'unknown',
    }
    if (bundle.updatable !== true) {
      // installation / official / management-required = 装 DSH 时就带上的包，随本体版本走。
      if (
        bundle.availability === 'installation' ||
        bundle.official === true ||
        bundle.readOnlyReason === 'management-required'
      ) {
        return {
          ...base,
          status: 'not-registry',
          providedByCore: true,
          detail: 'DSH 安装本体自带，随本体升级',
        }
      }
      // 本地链接 / git / 压缩包：不查上游版本，但查「上游有没有同名包」，能转就转。
      if (!options.probe) {
        return { ...base, status: 'not-registry', detail: '本地源（上游待查）' }
      }
      const localDir = localDirOf(base.source)
      const upstream = await probeUpstream(config.registry, bundle.name, base.installed, config.timeoutMs, localDir)
      const localDelta =
        upstream.convertible && upstream.version !== undefined
          ? await compareLocalWithUpstream({
              dir: localDir,
              name: bundle.name,
              version: upstream.version,
              tarballUrl: upstream.tarballUrl,
              timeoutMs: config.timeoutMs,
            })
          : undefined
      return {
        ...base,
        status: 'not-registry',
        upstream,
        ...(localDelta === undefined ? {} : { localDelta }),
        detail:
          upstream.convertible && upstream.version !== undefined
            ? '上游有 ' + upstream.version + '，可转为线上依赖'
            : (upstream.reason ?? '非 registry 源（本地链接 / git / 压缩包）'),
      }
    }
    if (!options.probe) {
      // 首屏快路径：本机事实先给，上游留空，不碰网络。
      return { ...base, status: 'unknown', detail: '上游待查' }
    }
    scanned += 1
    /**
     * 快筛：先用 dist-tags（几十字节）判断「上游到底有没有比本地新的」。
     * 绝大多数包都是最新的，这一跳就能定案；只有真发现有新版才付 pnpm view 的代价
     * （一次 listVersions ≈ 2–4s，19 个包串下来就是二十几秒）。
     */
    const tags = await fetchDistTags(config.registry, bundle.name, config.timeoutMs)
    if (tags !== undefined && base.installed !== undefined) {
      const stableTag = tags.latest !== undefined && !isPrerelease(tags.latest) ? tags.latest : undefined
      const previewTag = tags.alpha ?? tags.next ?? tags.beta ?? tags.canary
      const newest = [stableTag, previewTag]
        .filter((value): value is string => value !== undefined)
        .sort((left, right) => compareVersions(right, left))[0]
      if (newest !== undefined && compareVersions(newest, base.installed) <= 0) {
        const hit = (version: string | undefined): ChannelHit | undefined =>
          version === undefined ? undefined : { version, tags: Object.entries(tags).filter(([, value]) => value === version).map(([key]) => key) }
        return {
          ...base,
          ...(hit(stableTag) === undefined ? {} : { stable: hit(stableTag) }),
          ...(hit(previewTag ?? stableTag) === undefined ? {} : { preview: hit(previewTag ?? stableTag) }),
          newerCount: 0,
          status: newest === base.installed ? 'latest' : 'local-ahead',
          detail: '上游没有比本地更新的版本',
        }
      }
    }
    try {
      const listing = await pluginManager.listVersions(bundle.name)
      if (listing?.status !== 'listed') {
        return { ...base, status: 'unknown', detail: '上游查询被拒：' + String(listing?.problem ?? listing?.reason ?? '未知') }
      }
      const published = (listing.versions ?? []) as PublishedVersionLike[]
      const usable = published.filter((entry) => entry.bundle !== false && entry.incompatible === undefined)
      const channels = pickChannels(usable, (version) => {
        const found = published.find((entry) => entry.version === version)
        return found?.tags === undefined ? [] : [...found.tags]
      })
      const status = statusOf(base.installed, channels)
      const omitted = typeof listing.omitted === 'number' ? listing.omitted : 0
      return {
        ...base,
        ...channels,
        newerCount: usable.length + omitted,
        status,
        ...(usable.length === 0 ? { detail: '上游没有比本地更新的版本' } : {}),
      }
    } catch (error) {
      return { ...base, status: 'unknown', detail: '上游查询失败：' + String(error).slice(0, 200) }
    }
  }

  // 全并发：每条现在只发 1–2 个几十 KB 以内的 HTTP 请求（dist-tags + 版本 manifest），
  // 排队反而把 8 秒变成 8 秒×N——实测 19 个包全并发 ≈2s，分 8 路批处理 ≈9s。
  const settled = await Promise.all(queue.map((bundle) => runOne(bundle)))
  rows.push(...settled)
  skipped = bundles.length - queue.length
  return { rows, scanned, skipped }
}

async function scanCore(config: ScanConfig, warnings: string[], probe = true): Promise<CoreFacts> {
  const root = findCoreRoot()
  const manifest = root === undefined ? undefined : readJson(join(root, 'package.json'))
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined
  const distTags = probe ? await fetchDistTags(config.registry, '@deepseek-ai/dsh', config.timeoutMs) : undefined
  const channels: CoreFacts['channels'] = {}
  if (distTags !== undefined) {
    const stableTag = distTags.latest
    if (stableTag !== undefined) {
      channels.stable = { version: stableTag, tags: Object.entries(distTags).filter(([, value]) => value === stableTag).map(([key]) => key) }
    }
    // 预览：alpha 优先，其次 next，再次 beta / canary 等任何 prerelease 指向
    const previewTag = distTags.alpha ?? distTags.next ?? distTags.beta ?? distTags.canary
    if (previewTag !== undefined && previewTag !== stableTag) {
      channels.preview = { version: previewTag, tags: Object.entries(distTags).filter(([, value]) => value === previewTag).map(([key]) => key) }
    }
  } else {
    if (probe) warnings.push('npm dist-tags 查询失败：DSH 本体上游版本未知')
  }
  const runtimeDir = coreRuntimeDir()
  return {
    name: '@deepseek-ai/dsh',
    ...(version === undefined ? {} : { version }),
    ...(root === undefined ? {} : { root }),
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
    updatable: runtimeDir !== undefined && version !== undefined,
    registry: config.registry,
    ...(distTags === undefined ? {} : { distTags }),
    channels,
    reachable: distTags !== undefined,
    // scan() 拿到本体与插件两份结果后再统一判定相对位置。
    status: 'unknown',
  }
}

export async function scan(
  pluginManager: AnyService,
  config: ScanConfig,
  options: {
    deep?: boolean
    injections?: ReturnType<typeof readInjections>
    /** true = 只读本机事实（装了什么、什么源），不查上游：面板首屏秒开用。 */
    partial?: boolean
  } = {},
): Promise<Snapshot> {
  const warnings: string[] = []
  const partial = options.partial === true
  const probe = !partial
  const injections = options.injections ?? readInjections()
  const [core, bundleScan, env] = await Promise.all([
    scanCore(config, warnings, probe),
    scanBundles(pluginManager, config, warnings, { probe }),
    probeEnv(options.deep === true, config.timeoutMs),
  ])

  const injected: UpdateRow[] = await Promise.all(
    injections.entries.map(async (entry) => {
      const upstream = probe
        ? await probeUpstream(config.registry, entry.name, entry.version, config.timeoutMs, entry.dir)
        : undefined
      const localDelta =
        upstream?.convertible === true && upstream.version !== undefined
          ? await compareLocalWithUpstream({
              dir: entry.dir,
              name: entry.name,
              version: upstream.version,
              tarballUrl: upstream.tarballUrl,
              timeoutMs: config.timeoutMs,
            })
          : undefined
      return {
        name: entry.name,
        kind: 'injected' as const,
        ...(entry.version === undefined ? {} : { installed: entry.version }),
        sourceKind: 'injected' as const,
        ...(entry.dir === undefined ? {} : { source: entry.dir }),
        updatable: false,
        status: 'not-registry' as const,
        ...(upstream === undefined ? {} : { upstream }),
        ...(localDelta === undefined ? {} : { localDelta }),
        detail:
          upstream?.convertible === true && upstream.version !== undefined
            ? '上游有 ' + upstream.version + '，可转线上（需先解除注入）'
            : '运行时注入（超级注入器），更新走 dev_inject_plugin / dev_reload_package',
      }
    }),
  )

  const coreRowStatus = (() => {
    if (!core.reachable) return 'unknown' as const
    if (core.channels.preview === undefined) return 'latest' as const
    if (core.version === undefined) return 'unknown' as const
    if (compareVersions(core.channels.preview.version, core.version) <= 0) return 'local-ahead' as const
    if (core.channels.stable !== undefined && compareVersions(core.channels.stable.version, core.version) > 0) return 'update' as const
    return 'preview-only' as const
  })()
  core.status = coreRowStatus

  const stableUpdates =
    bundleScan.rows.filter((row) => row.status === 'update').length +
    (core.channels.stable !== undefined && core.version !== undefined && compareVersions(core.channels.stable.version, core.version) > 0 ? 1 : 0)
  const previewUpdates =
    bundleScan.rows.filter((row) => row.status === 'preview-only').length +
    (core.channels.preview !== undefined && core.version !== undefined && compareVersions(core.channels.preview.version, core.version) > 0 ? 1 : 0)
  const convertible = [...bundleScan.rows, ...injected].filter((row) => row.upstream?.convertible === true).length

  return {
    generatedAt: new Date().toISOString(),
    cached: false,
    registry: config.registry,
    core,
    bundles: bundleScan.rows
      .filter((row) => row.providedByCore !== true)
      .sort((left, right) => left.name.localeCompare(right.name)),
    coreProvided: bundleScan.rows
      .filter((row) => row.providedByCore === true)
      .sort((left, right) => left.name.localeCompare(right.name)),
    injected,
    env,
    summary: {
      stableUpdates,
      previewUpdates,
      scannedBundles: bundleScan.scanned,
      skippedBundles: bundleScan.skipped,
      convertible,
    },
    ...(partial ? { partial: true } : {}),
    warnings,
  }
}
