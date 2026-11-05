/**
 * 版本比较与通道判定。
 *
 * semver 子集：major.minor.patch[-prerelease][+build]。
 * prerelease 按 semver 规则逐段比较（数字段比数值，字母段比字典序，缺 prerelease 者更大）。
 * 目的只有一个：把 npm 上的一串版本排成"谁更新"，不追求完整的 range 语义。
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(input: string): ParsedVersion | undefined {
  const match = VERSION_RE.exec(input.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      continue
    }
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** a < b 返回负数，a > b 返回正数，相等返回 0。无法解析的版本一律视为"更旧"。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** 是否带 prerelease 后缀（alpha / beta / rc / next…）。 */
export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version)
  if (parsed === undefined) return version.includes('-')
  return parsed.prerelease.length > 0
}
