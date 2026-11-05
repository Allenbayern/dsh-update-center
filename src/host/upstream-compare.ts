/**
 * 本地目录 vs 上游同版本 tarball 的逐文件比对。
 *
 * 用途：`link:` / 注入这些本地源的版本号常常跟上游一模一样，但内容可能早被本地改过
 * （打补丁、改构建产物、加功能）。只看版本号就点「转线上」，会把本地改动静默扔掉。
 * 所以在给出「转为线上」按钮之前，先把本地目录和上游那一版的 tarball 对一遍。
 *
 * 口径：
 *   - 比相对路径 + 文件 sha256，跳过 node_modules / .git；
 *   - 上游 tarball 按 `<name>@<version>` 缓存到 `~/.dsh/update-center/upstream-cache/`，
 *     同一版本只下载一次（发布版不可变，缓存永远有效）；
 *   - 比对失败（下载不了 / 解包失败 / 目录不存在）就返回 unknown，**不猜**。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { LocalDelta } from '../shared/types.js'
import { updateCenterHome } from './core.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.turbo'])
/** 单个 tarball 上限：超过就不比了（真出现这么大的包，转线上本来就该人工确认）。 */
const MAX_TARBALL_BYTES = 40 * 1024 * 1024
const MAX_LISTED_FILES = 12

function cacheDirFor(name: string, version: string): string {
  return join(updateCenterHome(), 'upstream-cache', name.replace(/[/@]/g, '_') + '@' + version)
}

function walkFiles(root: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  let entries: string[]
  try {
    entries = readdirSync(join(root, prefix))
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry : prefix + sep + entry
    const abs = join(root, rel)
    let stats
    try {
      stats = statSync(abs)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      for (const [key, value] of walkFiles(root, rel)) out.set(key, value)
      continue
    }
    if (!stats.isFile()) continue
    try {
      out.set(rel.split(sep).join('/'), createHash('sha256').update(new Uint8Array(readFileSync(abs))).digest('hex'))
    } catch {
      /* 读不了就当没有 */
    }
  }
  return out
}

function download(url: string, target: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    fetch(url, { signal: controller.signal, headers: { accept: 'application/octet-stream' } })
      .then(async (response) => {
        if (!response.ok) {
          done(false)
          return
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_TARBALL_BYTES) {
          done(false)
          return
        }
        writeFileSync(target, bytes)
        done(true)
      })
      .catch(() => done(false))
      .finally(() => clearTimeout(timer))
  })
}

function extract(tarball: string, into: string): Promise<boolean> {
  return new Promise<boolean>((done) => {
    execFile('tar', ['-xzf', tarball, '-C', into, '--strip-components=1'], { timeout: 60_000 }, (error) => {
      done(error === null)
    })
  })
}

/** 拿到（必要时下载并解包的）上游同版本目录；失败返回 undefined。 */
async function upstreamDir(
  name: string,
  version: string,
  tarballUrl: string,
  timeoutMs: number,
): Promise<{ dir: string } | { reason: string }> {
  const cacheDir = cacheDirFor(name, version)
  const pkgDir = join(cacheDir, 'pkg')
  const marker = join(cacheDir, '.complete')
  if (existsSync(marker) && existsSync(pkgDir)) return { dir: pkgDir }
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (error) {
    return { reason: '建缓存目录失败：' + String(error) }
  }
  const tarball = join(cacheDir, 'package.tgz')
  const ok = await download(tarballUrl, tarball, Math.max(15_000, timeoutMs * 4))
  if (!ok) return { reason: '上游 tarball 下载失败（网络或体积超限）' }
  try {
    rmSync(pkgDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  mkdirSync(pkgDir, { recursive: true })
  const extracted = await extract(tarball, pkgDir)
  if (!extracted) return { reason: '上游 tarball 解包失败' }
  try {
    writeFileSync(marker, new Date().toISOString())
    rmSync(tarball, { force: true })
  } catch {
    /* 缓存标记写不了就下次重下 */
  }
  return { dir: pkgDir }
}

export interface CompareOptions {
  /** 本地包目录（`link:` 的绝对路径，或注入条目的 dir）。 */
  dir: string | undefined
  name: string
  version: string
  tarballUrl: string | undefined
  timeoutMs: number
}

export async function compareLocalWithUpstream(options: CompareOptions): Promise<LocalDelta> {
  const { dir, name, version, tarballUrl, timeoutMs } = options
  if (dir === undefined || dir === '') return { status: 'unknown', version, reason: '没有本地目录可比对' }
  if (!existsSync(dir)) return { status: 'unknown', version, reason: '本地目录不存在：' + dir }
  if (tarballUrl === undefined || tarballUrl === '') return { status: 'unknown', version, reason: '上游没有给出 tarball 地址' }

  const upstream = await upstreamDir(name, version, tarballUrl, timeoutMs)
  if ('reason' in upstream) return { status: 'unknown', version, reason: upstream.reason }

  const localFiles = walkFiles(dir)
  const upstreamFiles = walkFiles(upstream.dir)
  const modified: string[] = []
  const localOnly: string[] = []
  const upstreamOnly: string[] = []
  for (const [rel, hash] of localFiles) {
    const other = upstreamFiles.get(rel)
    if (other === undefined) localOnly.push(rel)
    else if (other !== hash) modified.push(rel)
  }
  for (const rel of upstreamFiles.keys()) {
    if (!localFiles.has(rel)) upstreamOnly.push(rel)
  }
  modified.sort()
  localOnly.sort()
  upstreamOnly.sort()
  const changed = [...modified, ...localOnly, ...upstreamOnly]
  if (changed.length === 0) {
    return { status: 'identical', version, changedCount: 0, modifiedCount: 0, localOnlyCount: 0, upstreamOnlyCount: 0, changedFiles: [] }
  }
  return {
    status: 'modified',
    version,
    changedCount: changed.length,
    modifiedCount: modified.length,
    localOnlyCount: localOnly.length,
    upstreamOnlyCount: upstreamOnly.length,
    changedFiles: changed.slice(0, MAX_LISTED_FILES),
  }
}

/** 给面板/工具用的一句话。 */
export function describeDelta(delta: LocalDelta | undefined): string {
  if (delta === undefined) return ''
  if (delta.status === 'identical') return '与上游 ' + (delta.version ?? '') + ' 逐文件一致（转换无损）'
  if (delta.status === 'modified') {
    const parts: string[] = []
    if ((delta.modifiedCount ?? 0) > 0) parts.push('内容不同 ' + delta.modifiedCount + ' 个')
    if ((delta.localOnlyCount ?? 0) > 0) parts.push('仅本地有 ' + delta.localOnlyCount + ' 个')
    if ((delta.upstreamOnlyCount ?? 0) > 0) parts.push('仅上游有 ' + delta.upstreamOnlyCount + ' 个')
    return '本地与上游 ' + (delta.version ?? '') + ' 不同（' + parts.join(' / ') + '），转线上后生效的是上游版本'
  }
  return '无法与上游比对' + (delta.reason === undefined ? '' : '：' + delta.reason)
}

/** 只给相对路径做展示，避免把用户家目录拼进 UI。 */
export function shortPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

export { relative as relativePath }
