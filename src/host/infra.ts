import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir, hostname } from 'node:os'
import type {
  AptNodeSummary,
  AptPackageRow,
  CleanupItemRow,
  DockerContainerRow,
  GitRepoRow,
  InfraSnapshot,
  ProjectVenvRow,
  SystemdUnitRow,
  ToolchainRow,
  VenvPackageItem,
} from '../shared/types.js'

const INFRA_CACHE_PATH = join(homedir(), '.dsh', 'update-center', 'infra-snapshot.json')
const INFRA_CONFIG_PATH = join(homedir(), '.dsh', 'update-center', 'infra-config.json')

/**
 * 用户可选扩展配置文件（~/.dsh/update-center/infra-config.json）：
 * 在任何机器上零配置即可自动扫描本机 Docker、APT、全局 CLI、uv tools 与常见工作区下的 Python .venv；
 * 如有多节点集群（SSH 远端、软路由、Proxmox VE qm guest exec）或自定义锁定项，可通过此文件扩展。
 */
export interface InfraDockerNodeConfig {
  id: string
  label: string
  mode: 'local' | 'ssh' | 'pve-qm'
  sshHost?: string
  pveHost?: string
  vmid?: number
}

export interface InfraAptNodeConfig {
  id: string
  label: string
  mode: 'local' | 'ssh'
  sshHost?: string
  isProxmox?: boolean
  useSudo?: boolean
}

export interface InfraUserConfig {
  dockerNodes?: InfraDockerNodeConfig[]
  aptNodes?: InfraAptNodeConfig[]
  lockedDockerContainers?: Record<string, string>
  standaloneDockerRecreate?: Record<string, string>
  venvSearchRoots?: string[]
  venvProjects?: Array<{ id: string; project: string; venvPath: string }>
  venvPinnedPackages?: Record<string, Record<string, string>>
  protectedPackages?: string[]
}

/** 默认容器保护锁名单（留空以保持开源通用性；自动检测 label / @sha256 / 无 RepoDigests 本地镜像，并支持 ~/.dsh/update-center/infra-config.json 覆盖） */
export const DEFAULT_LOCKED_DOCKER_CONTAINERS: Record<string, string> = {}

export const LOCKED_DOCKER_CONTAINERS = DEFAULT_LOCKED_DOCKER_CONTAINERS

/** PVE 需人工 DKMS 网卡驱动门禁的内核/虚拟化核心包前缀 */
const PVE_KERNEL_LOCKED_PREFIXES = [
  'proxmox-kernel',
  'proxmox-headers',
  'proxmox-default-kernel',
  'pve-kernel',
  'pve-headers',
  'pve-qemu-kvm',
  'qemu-server',
  'pve-manager',
  'pve-cluster',
  'pve-container',
  'pve-firewall',
  'pve-ha-manager',
  'pve-firmware',
  'proxmox-backup-restore-image',
  'proxmox-',
  'libproxmox-',
  'libpve-',
  'grub-',
  'grub2-',
  'proxmox-grub',
  'r8125',
  'dkms',
]

export function isPveKernelLockedPackage(pkgName: string): string | undefined {
  for (const prefix of PVE_KERNEL_LOCKED_PREFIXES) {
    if (pkgName === prefix || pkgName.startsWith(prefix)) {
      return '涉及 PVE 内核/虚拟化或引导层，受 DKMS 网卡驱动与虚拟化门禁保护，需单独维护窗口'
    }
  }
  return undefined
}

export function loadInfraUserConfig(): InfraUserConfig {
  try {
    if (existsSync(INFRA_CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(INFRA_CONFIG_PATH, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed as InfraUserConfig
    }
  } catch {
    /* ignore */
  }
  return {}
}

function runCmd(cmd: string, args: string[], timeoutMs = 25000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** 解析 ~/.ssh/config 中定义的 Host 别名，辅助自动发现常用局域网节点 */
function listSshConfigHosts(): Set<string> {
  const hosts = new Set<string>()
  try {
    const sshCfg = join(homedir(), '.ssh', 'config')
    if (!existsSync(sshCfg)) return hosts
    const text = readFileSync(sshCfg, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^Host\s+(.+)$/i)
      if (!m) continue
      for (const token of m[1]!.split(/\s+/)) {
        if (token && !token.includes('*') && !token.includes('?')) hosts.add(token)
      }
    }
  } catch {
    /* ignore */
  }
  return hosts
}

/** 自动发现当前环境的 Docker 节点（本机 + 可选 SSH / PVE 节点） */
export async function resolveDockerNodes(): Promise<InfraDockerNodeConfig[]> {
  const cfg = loadInfraUserConfig()
  if (Array.isArray(cfg.dockerNodes) && cfg.dockerNodes.length > 0) {
    return cfg.dockerNodes
  }
  const sshHosts = listSshConfigHosts()
  const host = hostname()
  // 若检测到经典的 pve / istoreos 多节点拓扑，自动挂载三节点；否则默认挂载本机节点
  if (sshHosts.has('istoreos') && sshHosts.has('pve')) {
    return [
      { id: 'vm100', label: `VM100 (${host} 本机)`, mode: 'local' },
      { id: 'istoreos', label: 'iStoreOS (软路由)', mode: 'ssh', sshHost: 'istoreos' },
      { id: 'fnos', label: 'fnOS (飞牛 NAS)', mode: 'pve-qm', pveHost: 'pve', vmid: 101 },
    ]
  }
  return [{ id: 'local', label: `${host} (本机)`, mode: 'local' }]
}

/** 自动发现当前环境的 APT 节点（本机 + 可选 PVE 宿主机） */
export async function resolveAptNodes(): Promise<InfraAptNodeConfig[]> {
  const cfg = loadInfraUserConfig()
  if (Array.isArray(cfg.aptNodes) && cfg.aptNodes.length > 0) {
    return cfg.aptNodes
  }
  const sshHosts = listSshConfigHosts()
  const host = hostname()
  const localIsPve = existsSync('/usr/bin/pveversion')
  if (sshHosts.has('pve') && !localIsPve) {
    return [
      { id: 'vm100', label: `VM100 (${host} 本机)`, mode: 'local', isProxmox: false, useSudo: true },
      { id: 'pve', label: 'PVE 宿主机', mode: 'ssh', sshHost: 'pve', isProxmox: true, useSudo: false },
    ]
  }
  return [
    {
      id: localIsPve ? 'pve' : 'local',
      label: localIsPve ? `${host} (PVE 本机)` : `${host} (本机)`,
      mode: 'local',
      isProxmox: localIsPve,
      useSudo: !localIsPve,
    },
  ]
}

const remoteDigestCache = new Map<string, { at: number; digests: Set<string>; primary?: string }>()

async function getRemoteDigests(imageRef: string): Promise<{ digests: Set<string>; primary?: string }> {
  const cleanRef = imageRef.includes('@sha256:') ? imageRef.split('@sha256:')[0]! : imageRef
  if (!/^[a-zA-Z0-9._/:@-]+$/.test(cleanRef)) {
    return { digests: new Set() }
  }
  const now = Date.now()
  const cached = remoteDigestCache.get(cleanRef)
  if (cached && now - cached.at < 10 * 60 * 1000) {
    return { digests: cached.digests, ...(cached.primary === undefined ? {} : { primary: cached.primary }) }
  }

  let outText = ''
  // 1. 优先尝试本机 docker buildx imagetools inspect
  const localBuildx = await runCmd('docker', ['buildx', 'imagetools', 'inspect', cleanRef], 12000)
  if (localBuildx.code === 0 && localBuildx.stdout.includes('sha256:')) {
    outText = localBuildx.stdout
  }

  // 2. 若本机未装 buildx 且存在 pve-qm 节点（如 fnOS），借用其 buildx 查询多架构索引与平台摘要
  if (!outText.includes('sha256:') && listSshConfigHosts().has('pve')) {
    const fnosRes = await runCmd(
      'ssh',
      ['-o', 'ConnectTimeout=5', 'pve', `qm guest exec 101 -- docker buildx imagetools inspect ${cleanRef}`],
      20000,
    )
    if (fnosRes.code === 0) {
      try {
        const parsed = JSON.parse(fnosRes.stdout)
        outText = String(parsed?.['out-data'] ?? '')
      } catch {
        outText = fnosRes.stdout
      }
    }
  }

  // 3. 通用回退：本机 docker manifest inspect -v
  if (!outText.includes('sha256:')) {
    const localRes = await runCmd('docker', ['manifest', 'inspect', '-v', cleanRef], 15000)
    if (localRes.code === 0) outText = localRes.stdout
  }

  const digests = new Set<string>()
  let primary: string | undefined
  if (outText) {
    const matches = outText.matchAll(/sha256:[0-9a-f]{64}/g)
    for (const m of matches) {
      if (primary === undefined) primary = m[0]
      digests.add(m[0])
    }
  }
  remoteDigestCache.set(cleanRef, { at: now, digests, ...(primary === undefined ? {} : { primary }) })
  return { digests, ...(primary === undefined ? {} : { primary }) }
}

interface RawContainerLine {
  name: string
  image: string
  statusText: string
  repoDigests: string
  composeDir: string
  composeService: string
  composeConfig: string
  customLock: string
}

function parseContainerLines(raw: string): RawContainerLine[] {
  const out: RawContainerLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('||')) continue
    const parts = trimmed.split('||')
    if (parts.length < 7) continue
    out.push({
      name: (parts[0] ?? '').replace(/^\//, '').trim(),
      image: (parts[1] ?? '').trim(),
      statusText: (parts[2] ?? '').trim(),
      repoDigests: (parts[3] ?? '').trim(),
      composeDir: (parts[4] ?? '').trim(),
      composeService: (parts[5] ?? '').trim(),
      composeConfig: (parts[6] ?? '').trim(),
      customLock: (parts[7] ?? '').trim(),
    })
  }
  return out
}

async function execOnDockerNode(nodeCfg: InfraDockerNodeConfig, script: string, timeoutMs = 25000): Promise<{ code: number; stdout: string; stderr: string }> {
  if (nodeCfg.mode === 'local') {
    return runCmd('bash', ['-c', script], timeoutMs)
  }
  if (nodeCfg.mode === 'ssh' && nodeCfg.sshHost) {
    return runCmd('ssh', ['-o', 'ConnectTimeout=6', nodeCfg.sshHost, script], timeoutMs)
  }
  if (nodeCfg.mode === 'pve-qm' && nodeCfg.pveHost && nodeCfg.vmid !== undefined) {
    const b64 = Buffer.from(script, 'utf8').toString('base64')
    const r = await runCmd(
      'ssh',
      ['-o', 'ConnectTimeout=6', nodeCfg.pveHost, `qm guest exec ${nodeCfg.vmid} -- bash -c "echo ${b64} | base64 -d | bash"`],
      timeoutMs,
    )
    if (r.code === 0) {
      try {
        const parsed = JSON.parse(r.stdout)
        return {
          code: typeof parsed?.exitcode === 'number' ? parsed.exitcode : 0,
          stdout: String(parsed?.['out-data'] ?? ''),
          stderr: String(parsed?.['err-data'] ?? ''),
        }
      } catch {
        return r
      }
    }
    return r
  }
  return { code: 1, stdout: '', stderr: `Unsupported node mode: ${nodeCfg.mode}` }
}

async function collectNodeContainers(
  nodeCfg: InfraDockerNodeConfig,
): Promise<{ engine: string; rows: RawContainerLine[] }> {
  const script = [
    `ver=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unavailable)`,
    `echo "ENGINE:$ver"`,
    `for cid in $(docker ps -q 2>/dev/null); do`,
    `  name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null)`,
    `  cimg=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null)`,
    `  st=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)`,
    `  img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)`,
    `  rd=$(docker image inspect -f '{{json .RepoDigests}}' "$img" 2>/dev/null)`,
    `  wdir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid" 2>/dev/null)`,
    `  svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid" 2>/dev/null)`,
    `  cfg=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid" 2>/dev/null)`,
    `  lck=$(docker inspect -f '{{index .Config.Labels "dsh.update-center.lock"}}' "$cid" 2>/dev/null)`,
    `  echo "\${name}||\${cimg}||\${st}||\${rd}||\${wdir}||\${svc}||\${cfg}||\${lck}"`,
    `done`,
  ].join('\n')

  const res = await execOnDockerNode(nodeCfg, script, 25000)
  let engine = 'unavailable'
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('ENGINE:')) {
      engine = line.slice('ENGINE:'.length).trim()
    }
  }
  return { engine, rows: parseContainerLines(res.stdout) }
}

function extractDigest(text: string): string | undefined {
  const m = text.match(/sha256:[0-9a-f]{64}/)
  return m ? m[0] : undefined
}

function shortDigest(d: string | undefined): string | undefined {
  if (!d) return undefined
  return d.replace(/^sha256:/, '').slice(0, 12)
}

/** 自动判定容器是否应被锁定保护（配置名单 + label + @sha256 钉死 + 本地构建无 RepoDigests） */
function detectContainerLockReason(nodeId: string, raw: RawContainerLine, userLocks: Record<string, string>): string | undefined {
  const key = `${nodeId}:${raw.name}`
  if (userLocks[key]) return userLocks[key]
  if (userLocks[raw.name]) return userLocks[raw.name]
  if (DEFAULT_LOCKED_DOCKER_CONTAINERS[key]) return DEFAULT_LOCKED_DOCKER_CONTAINERS[key]
  if (DEFAULT_LOCKED_DOCKER_CONTAINERS[raw.name]) return DEFAULT_LOCKED_DOCKER_CONTAINERS[raw.name]
  if (raw.customLock && raw.customLock !== '<no value>') return raw.customLock
  if (raw.image.includes('@sha256:')) {
    return '容器已通过 @sha256 摘要显式固定版本，自动锁定防止破坏上游版本约束'
  }
  // 本地源码 build 出来的镜像没有远端 RepoDigests（如 [] 或 null）
  const localDigest = extractDigest(raw.repoDigests)
  if (!localDigest) {
    return '本地构建镜像（无远端 Registry RepoDigests），自动锁定防止误拉取覆盖'
  }
  return undefined
}

async function scanAllDocker(): Promise<InfraSnapshot['docker']> {
  const nodes = await resolveDockerNodes()
  const userCfg = loadInfraUserConfig()
  const userLocks = userCfg.lockedDockerContainers ?? {}
  const collected = await Promise.all(nodes.map((n) => collectNodeContainers(n)))
  const engines: Record<string, string> = {}
  const containers: DockerContainerRow[] = []

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const data = collected[i]!
    engines[n.id] = data.engine
    for (const raw of data.rows) {
      const lockReason = detectContainerLockReason(n.id, raw, userLocks)
      const localFull = extractDigest(raw.repoDigests) ?? extractDigest(raw.image)
      const localShort = shortDigest(localFull)
      if (lockReason !== undefined) {
        containers.push({
          node: n.id,
          nodeLabel: n.label,
          name: raw.name,
          image: raw.image,
          statusText: raw.statusText,
          ...(localShort === undefined ? {} : { localDigest: localShort }),
          ...(raw.composeDir ? { composeDir: raw.composeDir } : {}),
          ...(raw.composeService ? { composeService: raw.composeService } : {}),
          ...(raw.composeConfig ? { composeConfig: raw.composeConfig } : {}),
          status: 'locked',
          lockReason,
          detail: lockReason,
        })
        continue
      }

      const remote = await getRemoteDigests(raw.image)
      const remoteShort = shortDigest(remote.primary)
      if (remote.digests.size === 0 || localFull === undefined) {
        containers.push({
          node: n.id,
          nodeLabel: n.label,
          name: raw.name,
          image: raw.image,
          statusText: raw.statusText,
          ...(localShort === undefined ? {} : { localDigest: localShort }),
          ...(raw.composeDir ? { composeDir: raw.composeDir } : {}),
          ...(raw.composeService ? { composeService: raw.composeService } : {}),
          ...(raw.composeConfig ? { composeConfig: raw.composeConfig } : {}),
          status: 'error',
          detail: '无法查询上游镜像摘要',
        })
        continue
      }

      const isUpToDate = remote.digests.has(localFull)
      containers.push({
        node: n.id,
        nodeLabel: n.label,
        name: raw.name,
        image: raw.image,
        statusText: raw.statusText,
        ...(localShort === undefined ? {} : { localDigest: localShort }),
        ...(remoteShort === undefined ? {} : { remoteDigest: remoteShort }),
        ...(raw.composeDir ? { composeDir: raw.composeDir } : {}),
        ...(raw.composeService ? { composeService: raw.composeService } : {}),
        ...(raw.composeConfig ? { composeConfig: raw.composeConfig } : {}),
        status: isUpToDate ? 'latest' : 'update',
        detail: isUpToDate ? '已与上游镜像摘要一致' : `有新镜像层 (${localShort} → ${remoteShort})`,
      })
    }
  }

  return {
    engines,
    containers,
    updatableCount: containers.filter((c) => c.status === 'update').length,
    lockedCount: containers.filter((c) => c.status === 'locked').length,
  }
}

function parseAptListOutput(nodeId: string, nodeLabel: string, isProxmox: boolean, stdout: string): AptPackageRow[] {
  const rows: AptPackageRow[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('Listing...') || trimmed.startsWith('正在列表') || !trimmed.includes('/')) continue
    const m = trimmed.match(/^([^\s/]+)\/\S+\s+(\S+)\s+\S+\s+\[(?:upgradable from:|可从该版本升级[：:])\s*([^\]]+)\]/)
    if (!m) continue
    const name = m[1]!
    const candidate = m[2]!
    const installed = m[3]!.trim()
    const lockReason = isProxmox ? isPveKernelLockedPackage(name) : undefined
    rows.push({
      node: nodeId,
      nodeLabel,
      name,
      installed,
      candidate,
      locked: lockReason !== undefined,
      ...(lockReason === undefined ? {} : { lockReason }),
    })
  }
  return rows
}

async function scanAllApt(): Promise<InfraSnapshot['apt']> {
  const aptNodes = await resolveAptNodes()
  const nodeSummaries: AptNodeSummary[] = await Promise.all(
    aptNodes.map(async (n) => {
      const cmdRes =
        n.mode === 'local'
          ? await runCmd('bash', ['-c', 'LC_ALL=C apt list --upgradable 2>/dev/null'], 15000)
          : await runCmd('ssh', ['-o', 'ConnectTimeout=5', n.sshHost ?? n.id, 'LC_ALL=C apt list --upgradable 2>/dev/null'], 15000)
      const pkgs = parseAptListOutput(n.id, n.label, n.isProxmox === true, cmdRes.stdout)
      return {
        node: n.id,
        label: n.label,
        ...(n.isProxmox !== undefined ? { isProxmox: n.isProxmox } : {}),
        packages: pkgs,
        safeUpdatableCount: pkgs.filter((p) => !p.locked).length,
        lockedCount: pkgs.filter((p) => p.locked).length,
      }
    }),
  )

  const all = nodeSummaries.flatMap((s) => s.packages)
  const vm100Compat =
    nodeSummaries.find((s) => s.node === 'vm100' || s.node === 'local')?.packages ??
    nodeSummaries.find((s) => !s.isProxmox)?.packages ??
    []
  const pveCompat =
    nodeSummaries.find((s) => s.node === 'pve' || s.isProxmox)?.packages ?? []

  return {
    vm100: vm100Compat,
    pve: pveCompat,
    nodes: nodeSummaries,
    safeUpdatableCount: all.filter((p) => !p.locked).length,
    lockedCount: all.filter((p) => p.locked).length,
  }
}

let cachedInfra: InfraSnapshot | undefined

export function readCachedInfraSnapshot(): InfraSnapshot | undefined {
  if (cachedInfra !== undefined) return cachedInfra
  try {
    if (existsSync(INFRA_CACHE_PATH)) {
      cachedInfra = JSON.parse(readFileSync(INFRA_CACHE_PATH, 'utf8')) as InfraSnapshot
      return cachedInfra
    }
  } catch {
    /* ignore */
  }
  return undefined
}

export async function scanInfra(options: { refresh?: boolean } = {}): Promise<InfraSnapshot> {
  if (!options.refresh) {
    const cached = readCachedInfraSnapshot()
    if (cached !== undefined && cached.toolchain !== undefined && cached.venvs !== undefined) return cached
  }
  remoteDigestCache.clear()
  const [docker, apt, toolchain, venvs, gitRepos, cleanups, systemdHealth] = await Promise.all([
    scanAllDocker(),
    scanAllApt(),
    scanAllToolchain(),
    scanAllVenvs(),
    scanAllGitRepos(),
    scanAllCleanups(),
    scanSystemdHealth(),
  ])
  const snapshot: InfraSnapshot = {
    generatedAt: new Date().toISOString(),
    docker,
    apt,
    toolchain,
    venvs,
    gitRepos,
    cleanups,
    systemdHealth,
  }
  cachedInfra = snapshot
  try {
    mkdirSync(dirname(INFRA_CACHE_PATH), { recursive: true })
    writeFileSync(INFRA_CACHE_PATH, JSON.stringify(snapshot, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  return snapshot
}

// ── 本机核心工具链（自动发现 uv / pnpm / uv tools / 全局 npm CLI / Obsidian） ──

async function fetchJson(url: string, timeoutMs = 6000): Promise<any> {
  const res = await runCmd('curl', ['-s', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000)), url], timeoutMs + 2000)
  if (res.code !== 0 || !res.stdout.trim()) return undefined
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}

async function resolveUvBin(): Promise<string> {
  const localUv = join(homedir(), '.local', 'bin', 'uv')
  if (existsSync(localUv)) return localUv
  const whichRes = await runCmd('bash', ['-lc', 'command -v uv'], 3000)
  return whichRes.stdout.trim() || localUv
}

/** 自动扫描 ~/.local/lib/node_modules 下安装的所有顶层 npm CLI 包（排除 .retired 归档目录与隐藏目录） */
function discoverGlobalNpmPackages(): Array<{ id: string; pkgName: string; label: string; pkgJsonPath: string }> {
  const root = join(homedir(), '.local', 'lib', 'node_modules')
  if (!existsSync(root)) return []
  const out: Array<{ id: string; pkgName: string; label: string; pkgJsonPath: string }> = []

  const inspectPkg = (pkgName: string, dirPath: string) => {
    if (pkgName.includes('.retired')) return
    const pkgJsonPath = join(dirPath, 'package.json')
    if (!existsSync(pkgJsonPath)) return
    try {
      const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      // 跳过纯平台二进制子包（如 *-linux-x64）或无 bin 可执行文件的纯库目录
      if (!meta?.bin) return
      const desc = typeof meta?.description === 'string' && meta.description.trim()
        ? meta.description.trim().slice(0, 38)
        : undefined
      out.push({
        id: `npm:${pkgName}`,
        pkgName,
        label: desc ? `${pkgName} (${desc})` : pkgName,
        pkgJsonPath,
      })
    } catch {
      /* ignore invalid package.json */
    }
  }

  try {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue
      const full = join(root, entry)
      if (!statSync(full).isDirectory()) continue
      if (entry.startsWith('@')) {
        for (const sub of readdirSync(full)) {
          if (sub.startsWith('.')) continue
          const subFull = join(full, sub)
          if (statSync(subFull).isDirectory()) {
            inspectPkg(`${entry}/${sub}`, subFull)
          }
        }
      } else {
        inspectPkg(entry, full)
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

export async function scanAllToolchain(): Promise<{ items: ToolchainRow[]; updatableCount: number }> {
  const items: ToolchainRow[] = []
  const uvBin = await resolveUvBin()

  // 1. uv (若已安装)
  const uvLocalRes = await runCmd(uvBin, ['--version'], 5000)
  if (uvLocalRes.code === 0 && uvLocalRes.stdout.trim()) {
    const uvInstalled = uvLocalRes.stdout.trim().match(/uv\s+([0-9.]+)/)?.[1] ?? 'unknown'
    const uvGithub = await fetchJson('https://api.github.com/repos/astral-sh/uv/releases/latest')
    const uvLatest = typeof uvGithub?.tag_name === 'string' ? uvGithub.tag_name.replace(/^v/, '') : undefined
    items.push({
      id: 'uv',
      name: 'uv (Python 极速包与虚拟环境管理)',
      category: 'cli',
      installed: uvInstalled,
      ...(uvLatest ? { latest: uvLatest } : {}),
      status: uvLatest && uvInstalled !== 'unknown' && uvLatest !== uvInstalled ? 'update' : 'latest',
      detail: `${uvBin} (uv self update)`,
    })

    // 2. 自动发现所有 uv tool 独立工具（如 litellm、ruff 等）
    const uvToolRes = await runCmd(uvBin, ['tool', 'list'], 8000)
    if (uvToolRes.code === 0) {
      const toolMatches = [...uvToolRes.stdout.matchAll(/^([a-zA-Z0-9._-]+)\s+v([0-9a-zA-Z.+_-]+)/gm)]
      await Promise.all(
        toolMatches.map(async (m) => {
          const toolName = m[1]!
          const toolVer = m[2]!
          const toolPy = join(homedir(), '.local', 'share', 'uv', 'tools', toolName, 'bin', 'python')
          let latest: string | undefined
          if (existsSync(toolPy)) {
            const outRes = await runCmd(uvBin, ['pip', 'list', '--outdated', '--format=json', '--python', toolPy], 10000)
            try {
              const outList = JSON.parse(outRes.stdout) as Array<{ name: string; latest_version: string }>
              latest = outList.find((x) => x.name.toLowerCase() === toolName.toLowerCase())?.latest_version ?? toolVer
            } catch {
              /* fallback to pypi */
            }
          }
          if (!latest) {
            const pypi = await fetchJson(`https://pypi.org/pypi/${toolName}/json`)
            latest = typeof pypi?.info?.version === 'string' ? pypi.info.version : undefined
          }
          items.push({
            id: toolName === 'litellm' ? 'litellm' : `uv-tool:${toolName}`,
            name: `${toolName} (uv tool 独立环境)`,
            category: 'uv-tool',
            installed: toolVer,
            ...(latest ? { latest } : {}),
            status: latest && latest !== toolVer ? 'update' : 'latest',
            detail: `uv tool upgrade ${toolName}`,
          })
        }),
      )
    }
  }

  // 3. pnpm (若已安装)
  const pnpmBin = existsSync('/usr/bin/pnpm') ? '/usr/bin/pnpm' : 'pnpm'
  const pnpmLocalRes = await runCmd(pnpmBin, ['--version'], 5000)
  if (pnpmLocalRes.code === 0 && pnpmLocalRes.stdout.trim()) {
    const pnpmInstalled = pnpmLocalRes.stdout.trim()
    const pnpmRegistry = await fetchJson('https://registry.npmjs.org/pnpm/latest')
    const pnpmLatest = typeof pnpmRegistry?.version === 'string' ? pnpmRegistry.version : undefined
    items.push({
      id: 'pnpm',
      name: 'pnpm (Node 包管理器)',
      category: 'cli',
      installed: pnpmInstalled,
      ...(pnpmLatest ? { latest: pnpmLatest } : {}),
      status: pnpmLatest && pnpmInstalled !== 'unknown' && pnpmLatest !== pnpmInstalled ? 'update' : 'latest',
      detail: existsSync(join(homedir(), '.local', 'bin', 'pnpm'))
        ? '/usr/local/lib/pnpm-<ver>/pnpm + ~/.local/bin/pnpm 内存护栏'
        : pnpmBin,
    })
  }

    // 4. 自动发现 ~/.local/lib/node_modules 下的全局 npm CLI 工具（仅纳入声明了 bin 可执行入口的独立 CLI 包）
  const discoveredNpm = discoverGlobalNpmPackages()
  await Promise.all(
    discoveredNpm.map(async (entry) => {
      let installed = 'unknown'
      try {
        installed = JSON.parse(readFileSync(entry.pkgJsonPath, 'utf8')).version ?? 'unknown'
      } catch {
        /* ignore */
      }
      const reg = await fetchJson(`https://registry.npmjs.org/${entry.pkgName}/latest`)
      const latest = typeof reg?.version === 'string' ? reg.version : undefined
      items.push({
        id: entry.id,
        name: entry.label,
        category: 'npm-global',
        installed,
        ...(latest ? { latest } : {}),
        status: latest && installed !== 'unknown' && latest !== installed ? 'update' : 'latest',
        detail: `~/.local/lib/node_modules/${entry.pkgName}`,
      })
    }),
  )

  // 5. Obsidian Desktop AppImage（仅当本机存在 ~/.local/opt/Obsidian-AppImage-* 时展示）
  try {
    const optDir = join(homedir(), '.local', 'opt')
    if (existsSync(optDir)) {
      const dirs = readdirSync(optDir)
        .filter((d) => d.startsWith('Obsidian-AppImage-'))
        .map((d) => d.replace('Obsidian-AppImage-', ''))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      if (dirs.length > 0) {
        const obsidianInstalled = dirs[dirs.length - 1]!
        const obsGithub = await fetchJson('https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest')
        const obsLatest = typeof obsGithub?.tag_name === 'string' ? obsGithub.tag_name.replace(/^v/, '') : undefined
        items.push({
          id: 'obsidian',
          name: 'Obsidian 桌面端 (AppImage 解压版)',
          category: 'desktop',
          installed: obsidianInstalled,
          ...(obsLatest ? { latest: obsLatest } : {}),
          status: obsLatest && obsLatest !== obsidianInstalled ? 'update' : 'latest',
          detail: '~/.local/opt/Obsidian-AppImage-<ver> (不触碰 .obsidian/)',
        })
      }
    }
  } catch {
    /* ignore */
  }

  // 6. 基础设施独立二进制（Node.js / Caddy / Tailscale / Chrome）
  await Promise.all([
    (async () => {
      const nodeRes = await runCmd('node', ['--version'], 4000)
      if (nodeRes.code !== 0 || !nodeRes.stdout.trim()) return
      const installed = nodeRes.stdout.trim().replace(/^v/, '')
      const major = installed.split('.')[0]
      const distList = await fetchJson('https://nodejs.org/dist/index.json')
      let latest: string | undefined
      if (Array.isArray(distList)) {
        const sameMajor = distList.find((x: any) => typeof x?.version === 'string' && x.version.startsWith(`v${major}.`))
        latest = sameMajor?.version?.replace(/^v/, '')
      }
      const isStandalone = existsSync('/usr/local/bin/node')
      items.push({
        id: 'infra:node',
        name: `Node.js 运行时 (v${major}.x 同主版本线)`,
        category: 'infra-bin',
        installed,
        ...(latest ? { latest } : {}),
        status:
          latest && latest !== installed
            ? isStandalone
              ? 'update'
              : 'locked'
            : 'latest',
        detail: isStandalone ? '/usr/local/bin/node (官方 linux-x64 发行包)' : '系统包管理器托管 Node.js',
      })
    })(),
    (async () => {
      const caddyBin = existsSync('/usr/local/bin/caddy') ? '/usr/local/bin/caddy' : 'caddy'
      const caddyRes = await runCmd(caddyBin, ['version'], 4000)
      if (caddyRes.code !== 0 || !caddyRes.stdout.trim()) return
      const installed = caddyRes.stdout.trim().match(/v?([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? 'unknown'
      const gh = await fetchJson('https://api.github.com/repos/caddyserver/caddy/releases/latest')
      const latest = typeof gh?.tag_name === 'string' ? gh.tag_name.replace(/^v/, '') : undefined
      items.push({
        id: 'infra:caddy',
        name: 'Caddy Web Server (反向代理与 HTTPS 网关)',
        category: 'infra-bin',
        installed,
        ...(latest ? { latest } : {}),
        status: latest && installed !== 'unknown' && latest !== installed ? 'update' : 'latest',
        detail: `${caddyBin} (caddy upgrade / GitHub Release)`,
      })
    })(),
    (async () => {
      const tsRes = await runCmd('tailscale', ['version'], 4000)
      if (tsRes.code !== 0 || !tsRes.stdout.trim()) return
      const installed = tsRes.stdout.trim().split('\n')[0]?.trim() ?? 'unknown'
      const gh = await fetchJson('https://api.github.com/repos/tailscale/tailscale/releases/latest')
      const latest = typeof gh?.tag_name === 'string' ? gh.tag_name.replace(/^v/, '') : undefined
      items.push({
        id: 'infra:tailscale',
        name: 'Tailscale (Mesh 组网守护进程)',
        category: 'infra-bin',
        installed,
        ...(latest ? { latest } : {}),
        status: latest && installed !== 'unknown' && latest !== installed ? 'update' : 'latest',
        detail: 'tailscale update --yes',
      })
    })(),
    (async () => {
      const chrRes = await runCmd('google-chrome', ['--version'], 4000)
      if (chrRes.code !== 0 || !chrRes.stdout.trim()) return
      const installed = chrRes.stdout.trim().match(/([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? 'unknown'
      items.push({
        id: 'infra:chrome',
        name: 'Google Chrome (CDP 浏览器内核)',
        category: 'infra-bin',
        installed,
        latest: installed,
        status: 'latest',
        detail: '/usr/bin/google-chrome (随系统 APT 通道维护)',
      })
    })(),
  ])

  const updatableCount = items.filter((i) => i.status === 'update').length
  return { items, updatableCount }
}

export async function updateToolchainItem(id: string): Promise<{ ok: boolean; message: string; output?: string }> {
  const uvBin = await resolveUvBin()
  if (id === 'uv') {
    const res = await runCmd(uvBin, ['self', 'update'], 120000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'uv 已自升级至最新版本' : `uv 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'litellm' || id.startsWith('uv-tool:')) {
    const toolName = id === 'litellm' ? 'litellm' : id.slice('uv-tool:'.length)
    if (!/^[a-zA-Z0-9._-]+$/.test(toolName)) {
      return { ok: false, message: `非法 uv tool 名称: ${toolName}` }
    }
    const res = await runCmd(uvBin, ['tool', 'upgrade', toolName], 180000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? `${toolName} (uv tool) 已升级至最新版本` : `${toolName} 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'pnpm') {
    const reg = await fetchJson('https://registry.npmjs.org/pnpm/latest')
    const ver = typeof reg?.version === 'string' ? reg.version : ''
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) {
      return { ok: false, message: '无法获取上游 pnpm 最新版本号' }
    }
    const script = `set -e
TARGET_DIR="/usr/local/lib/pnpm-${ver}"
sudo mkdir -p "$TARGET_DIR"
curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v${ver}/pnpm-linux-x64.tar.gz" | sudo tar -xz -C "$TARGET_DIR"
sudo chmod +x "$TARGET_DIR/pnpm"
sudo ln -sfn "$TARGET_DIR/pnpm" /usr/bin/pnpm
/usr/bin/pnpm --version`
    const res = await runCmd('bash', ['-c', script], 180000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? `pnpm 已安全升级至 v${ver}` : `pnpm 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'obsidian') {
    const obsGithub = await fetchJson('https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest')
    const ver = typeof obsGithub?.tag_name === 'string' ? obsGithub.tag_name.replace(/^v/, '') : ''
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) {
      return { ok: false, message: '无法获取上游 Obsidian 最新版本号' }
    }
    const script = `set -e
DEST="$HOME/.local/opt/Obsidian-AppImage-${ver}"
mkdir -p "$DEST"
curl -fsSL "https://github.com/obsidianmd/obsidian-releases/releases/download/v${ver}/obsidian-${ver}.tar.gz" | tar -xz --strip-components=1 -C "$DEST"
chmod +x "$DEST/obsidian"
DESKTOP="$HOME/.local/share/applications/obsidian-appimage.desktop"
if [ -f "$DESKTOP" ]; then
  sed -i "s|Obsidian-AppImage-[0-9.]*|Obsidian-AppImage-${ver}|g" "$DESKTOP"
fi
echo "Obsidian ${ver} installed to $DEST"`
    const res = await runCmd('bash', ['-c', script], 240000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? `Obsidian 已升级至 v${ver} 并更新桌面启动器（未触碰 .obsidian/）` : `Obsidian 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id.startsWith('npm:')) {
    const pkgName = id.slice(4)
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkgName)) {
      return { ok: false, message: `非法 npm 包名: ${pkgName}` }
    }
    const reg = await fetchJson(`https://registry.npmjs.org/${pkgName}/latest`)
    const tarball = reg?.dist?.tarball
    const latestVer = reg?.version
    if (typeof tarball !== 'string' || typeof latestVer !== 'string') {
      return { ok: false, message: `无法获取 ${pkgName} 的最新 tarball 地址` }
    }
    const targetDir = join(homedir(), '.local', 'lib', 'node_modules', pkgName)
    const script = `set -e
TMP_DIR=$(mktemp -d)
trap "rm -rf '$TMP_DIR'" EXIT
curl -fsSL "${tarball}" | tar -xz -C "$TMP_DIR"
mkdir -p "${dirname(targetDir)}"
if [ -d "${targetDir}/node_modules" ]; then
  cp -a "${targetDir}/node_modules" "$TMP_DIR/package/" 2>/dev/null || true
fi
rm -rf "${targetDir}"
mv "$TMP_DIR/package" "${targetDir}"
cd "${targetDir}"
if [ -f package.json ]; then
  (command -v pnpm >/dev/null 2>&1 && pnpm install --prod --ignore-scripts --no-lockfile) || ~/.local/bin/pnpm install --prod --ignore-scripts --no-lockfile 2>&1 || true
fi
echo "Updated ${pkgName} to ${latestVer}"`
    const res = await runCmd('bash', ['-c', script], 240000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? `全局 CLI 工具 ${pkgName} 已升级至 v${latestVer}` : `${pkgName} 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'infra:node') {
    const nodeRes = await runCmd('node', ['--version'], 4000)
    const installed = nodeRes.stdout.trim().replace(/^v/, '')
    const major = installed.split('.')[0] || '24'
    const distList = await fetchJson('https://nodejs.org/dist/index.json')
    const sameMajor = Array.isArray(distList)
      ? distList.find((x: any) => typeof x?.version === 'string' && x.version.startsWith(`v${major}.`))
      : undefined
    const ver = typeof sameMajor?.version === 'string' ? sameMajor.version.replace(/^v/, '') : ''
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) {
      return { ok: false, message: '无法获取上游 Node.js 同主版本最新发行号' }
    }
    const script = `set -e
TMP_DIR=$(mktemp -d)
trap "rm -rf '$TMP_DIR'" EXIT
curl -fsSL "https://nodejs.org/dist/v${ver}/node-v${ver}-linux-x64.tar.xz" | tar -xJ --strip-components=1 -C "$TMP_DIR"
sudo cp -f "$TMP_DIR/bin/node" /usr/local/bin/node
/usr/local/bin/node --version`
    const res = await runCmd('bash', ['-c', script], 240000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? `Node.js 已安全升级至 v${ver}` : `Node.js 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'infra:caddy') {
    const caddyBin = existsSync('/usr/local/bin/caddy') ? '/usr/local/bin/caddy' : 'caddy'
    const res = await runCmd('sudo', [caddyBin, 'upgrade'], 180000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'Caddy 已完成原地升级' : `Caddy 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'infra:tailscale') {
    const res = await runCmd('sudo', ['tailscale', 'update', '--yes'], 240000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'Tailscale 已升级至最新版本' : `Tailscale 升级失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  return { ok: false, message: `未知的工具链条目: ${id}` }
}

// ── 项目 Python .venv 自动发现、依赖审计与安全更新 ──────────────────────────

function extractProjectSummary(projectDir: string, fallbackName: string): string {
  // 1. 尝试从 pyproject.toml 提取 description
  const pyproject = join(projectDir, 'pyproject.toml')
  if (existsSync(pyproject)) {
    try {
      const text = readFileSync(pyproject, 'utf8')
      const m = text.match(/^\s*description\s*=\s*["']([^"']+)["']/m)
      if (m?.[1]?.trim()) {
        return `${fallbackName} (${m[1].trim().slice(0, 36)})`
      }
    } catch {
      /* ignore */
    }
  }
  // 2. 尝试从 README.zh-CN.md 或 README.md 提取首行标题
  for (const readmeName of ['README.zh-CN.md', 'README.md']) {
    const rp = join(projectDir, readmeName)
    if (existsSync(rp)) {
      try {
        const text = readFileSync(rp, 'utf8')
        const h1 = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
        if (h1 && h1.toLowerCase() !== fallbackName.toLowerCase()) {
          return `${fallbackName} (${h1.slice(0, 32)})`
        }
      } catch {
        /* ignore */
      }
    }
  }
  return fallbackName
}

/**
 * 自动扫描本机工作区下的所有 Python 虚拟环境（`<project>/.venv` 或 `<project>/venv`）：
 * - 若 `~/.dsh/update-center/infra-config.json` 显式配置了 `venvProjects`，优先合并使用；
 * - 否则自动扫描 `~/Projects`、`~/workspace`、`~/code`、`~/dev`、`~/repos` 及当前工作目录。
 */
export function discoverProjectVenvs(): Array<{ id: string; project: string; venvPath: string }> {
  const cfg = loadInfraUserConfig()
  if (Array.isArray(cfg.venvProjects) && cfg.venvProjects.length > 0) {
    return cfg.venvProjects
  }

  const home = homedir()
  const roots = cfg.venvSearchRoots ?? [
    join(home, 'Projects'),
    join(home, 'projects'),
    join(home, 'workspace'),
    join(home, 'code'),
    join(home, 'dev'),
    join(home, 'repos'),
    process.cwd(),
  ]

  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()
  const out: Array<{ id: string; project: string; venvPath: string }> = []

  const checkProjectDir = (projDir: string) => {
    for (const venvDirName of ['.venv', 'venv']) {
      const vPath = resolve(projDir, venvDirName)
      const pyBin = join(vPath, 'bin', 'python')
      if (!existsSync(pyBin) || seenPaths.has(vPath)) continue
      seenPaths.add(vPath)
      const baseId = basename(projDir)
      const id = seenIds.has(baseId) ? `${basename(dirname(projDir))}-${baseId}` : baseId
      seenIds.add(id)
      out.push({
        id,
        project: extractProjectSummary(projDir, baseId),
        venvPath: vPath,
      })
    }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      if (!statSync(root).isDirectory()) continue
      // 检查 root 自身是否就是一个带 .venv 的项目
      checkProjectDir(root)
      // 检查 root 下一级子目录
      for (const child of readdirSync(root)) {
        if (child.startsWith('.') || child === 'node_modules') continue
        const childFull = join(root, child)
        try {
          if (statSync(childFull).isDirectory()) {
            checkProjectDir(childFull)
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  return out
}

function isMajorBump(installed: string, latest: string): boolean {
  const m1 = installed.match(/^(\d+)\./)
  const m2 = latest.match(/^(\d+)\./)
  if (!m1 || !m2) return false
  // 日历版本（如 2026.x -> 2026.y）不算破坏性跨大版本
  if (Number(m1[1]) >= 2020 && Number(m2[1]) >= 2020) return false
  return m1[1] !== m2[1]
}

export async function scanAllVenvs(): Promise<{ projects: ProjectVenvRow[]; totalSafeUpdatable: number }> {
  const uvBin = await resolveUvBin()
  const discovered = discoverProjectVenvs()
  const userCfg = loadInfraUserConfig()
  const projects: ProjectVenvRow[] = []

  for (const cfg of discovered) {
    const pyBin = join(cfg.venvPath, 'bin', 'python')
    if (!existsSync(pyBin)) continue
    const [pyVerRes, allInstalledRes, outdatedRes] = await Promise.all([
      runCmd(pyBin, ['--version'], 5000),
      existsSync(uvBin)
        ? runCmd(uvBin, ['pip', 'list', '--format=json', '--python', pyBin], 15000)
        : runCmd(pyBin, ['-m', 'pip', 'list', '--format=json'], 20000),
      existsSync(uvBin)
        ? runCmd(uvBin, ['pip', 'list', '--outdated', '--format=json', '--python', pyBin], 20000)
        : runCmd(pyBin, ['-m', 'pip', 'list', '--outdated', '--format=json'], 25000),
    ])
    const pythonVersion = pyVerRes.stdout.trim().replace(/^Python\s+/, '') || 'unknown'
    let allList: Array<{ name: string; version: string }> = []
    let rawList: Array<{ name: string; version: string; latest_version: string }> = []
    try {
      allList = JSON.parse(allInstalledRes.stdout)
    } catch {
      /* ignore */
    }
    try {
      rawList = JSON.parse(outdatedRes.stdout)
    } catch {
      /* ignore */
    }

    // 针对同主版本候选包，将环境内所有当前最新未过期的包作为固定约束，
    // 调用 uv pip install --dry-run 自动探测是否存在上层版本上限冲突，无需硬编码任何包名
    const sameMajorCandidates = rawList.filter((item) => !isMajorBump(item.version, item.latest_version))
    const outdatedNames = new Set(rawList.map((item) => item.name))
    const fixedPins = allList
      .filter((item) => !outdatedNames.has(item.name))
      .map((item) => `${item.name}==${item.version}`)
    const autoConflictReasons: Record<string, string> = {}
    if (existsSync(uvBin) && sameMajorCandidates.length > 0) {
      await Promise.all(
        sameMajorCandidates.map(async (cand) => {
          const dryRes = await runCmd(
            uvBin,
            ['pip', 'install', '--dry-run', '--python', pyBin, ...fixedPins, `${cand.name}==${cand.latest_version}`],
            10000,
          )
          if (dryRes.code !== 0) {
            autoConflictReasons[cand.name] = `受虚拟环境内已安装依赖的版本上限约束（当前兼容上限 ${cand.version}），已自动锁定`
          }
        }),
      )
    }

    const customPinned: Record<string, string> = {
      ...(userCfg.venvPinnedPackages?.['*'] ?? {}),
      ...(userCfg.venvPinnedPackages?.[cfg.id] ?? {}),
    }

    const packages: VenvPackageItem[] = rawList.map((item) => {
      const major = isMajorBump(item.version, item.latest_version)
      const pinReason = customPinned[item.name] ?? autoConflictReasons[item.name]
      const isLocked = major || Boolean(pinReason)
      return {
        name: item.name,
        installed: item.version,
        latest: item.latest_version,
        safe: !isLocked,
        ...(isLocked
          ? {
              lockReason: pinReason ?? `跨主版本 (${item.version} → ${item.latest_version})，为防 API 破坏性变更已锁定`,
            }
          : {}),
      }
    })
    projects.push({
      id: cfg.id,
      project: cfg.project,
      venvPath: cfg.venvPath,
      pythonVersion,
      outdatedCount: packages.length,
      safeUpdatableCount: packages.filter((p) => p.safe).length,
      packages,
    })
  }

  const totalSafeUpdatable = projects.reduce((acc, p) => acc + p.safeUpdatableCount, 0)
  return { projects, totalSafeUpdatable }
}

export async function updateProjectVenv(
  projectId: string,
): Promise<{ ok: boolean; message: string; updatedPackages: string[]; output?: string }> {
  const venvData = await scanAllVenvs()
  const proj = venvData.projects.find((p) => p.id === projectId)
  if (!proj) {
    return { ok: false, message: `未找到项目虚拟环境: ${projectId}`, updatedPackages: [] }
  }
  const safePkgs = proj.packages.filter((p) => p.safe).map((p) => p.name)
  if (safePkgs.length === 0) {
    return { ok: true, message: `项目 ${projectId} 当前没有待升级的同主版本安全包`, updatedPackages: [] }
  }
  const uvBin = await resolveUvBin()
  const pyBin = join(proj.venvPath, 'bin', 'python')
  const res = existsSync(uvBin)
    ? await runCmd(uvBin, ['pip', 'install', '-U', '--python', pyBin, ...safePkgs], 240000)
    : await runCmd(pyBin, ['-m', 'pip', 'install', '-U', ...safePkgs], 240000)
  const ok = res.code === 0
  return {
    ok,
    message: ok
      ? `项目 ${projectId} 已安全升级 ${safePkgs.length} 个依赖包（${safePkgs.join(', ')}）`
      : `项目 ${projectId} 依赖升级失败 (exit ${res.code})`,
    updatedPackages: ok ? safePkgs : [],
    output: (res.stdout + '\n' + res.stderr).trim().slice(-2000),
  }
}

export async function updateDockerContainer(
  node: string,
  name: string,
): Promise<{ ok: boolean; message: string; output?: string }> {
  const key = `${node}:${name}`
  const userCfg = loadInfraUserConfig()
  const lockMsg =
    userCfg.lockedDockerContainers?.[key] ??
    userCfg.lockedDockerContainers?.[name] ??
    DEFAULT_LOCKED_DOCKER_CONTAINERS[key] ??
    DEFAULT_LOCKED_DOCKER_CONTAINERS[name]
  if (lockMsg !== undefined) {
    return { ok: false, message: `拒绝更新受保护容器 ${key}：${lockMsg}` }
  }
  const snap = readCachedInfraSnapshot() ?? (await scanInfra({ refresh: true }))
  const row = snap.docker.containers.find((c) => c.node === node && c.name === name)
  if (!row) {
    return { ok: false, message: `未找到容器 ${key}` }
  }
  if (row.status === 'locked') {
    return { ok: false, message: `容器 ${key} 已锁定：${row.lockReason ?? '禁止更新'}` }
  }

  const dockerNodes = await resolveDockerNodes()
  const nodeCfg = dockerNodes.find((n) => n.id === node)
  if (!nodeCfg) {
    return { ok: false, message: `未找到 Docker 节点配置: ${node}` }
  }

  let script = ''
  const customRecreate = userCfg.standaloneDockerRecreate?.[key] ?? userCfg.standaloneDockerRecreate?.[name]
  if (customRecreate) {
    script = customRecreate
  } else if (row.composeDir && row.composeService) {
    const cfgFlag = row.composeConfig && row.composeConfig.includes('/') ? `-f "${row.composeConfig.split(',')[0]}"` : ''
    script = `cd "${row.composeDir}" && (docker compose ${cfgFlag} pull "${row.composeService}" && docker compose ${cfgFlag} up -d "${row.composeService}" || (docker-compose ${cfgFlag} pull "${row.composeService}" && docker-compose ${cfgFlag} up -d "${row.composeService}")) && docker image prune -f`
  } else {
    return { ok: false, message: `容器 ${key} 无 docker-compose 元数据且未配置 standaloneDockerRecreate 规则，出于安全拒绝盲目重建` }
  }

  const res = await execOnDockerNode(nodeCfg, script, 360000)
  const ok = res.code === 0
  return {
    ok,
    message: ok ? `${nodeCfg.label} 容器 ${name} 更新并清理旧层完成` : `容器 ${name} 更新失败 (exit ${res.code})`,
    output: (res.stdout + '\n' + res.stderr).trim().slice(-2000),
  }
}

export async function updateSafeApt(
  node: string,
): Promise<{ ok: boolean; message: string; updatedPackages: string[]; output?: string }> {
  const snap = await scanInfra({ refresh: true })
  const aptNodes = await resolveAptNodes()
  const nodeCfg = aptNodes.find((n) => n.id === node) ?? (node === 'vm100' ? aptNodes.find((n) => n.id === 'local') : undefined)
  if (!nodeCfg) {
    return { ok: false, message: `未找到 APT 节点: ${node}`, updatedPackages: [] }
  }

  const nodeSummary = snap.apt.nodes?.find((s) => s.node === nodeCfg.id)
  const list = nodeSummary ? nodeSummary.packages : node === 'pve' ? snap.apt.pve : snap.apt.vm100
  const safePkgs = list.filter((p) => !p.locked).map((p) => p.name)
  if (safePkgs.length === 0) {
    return { ok: true, message: `${nodeCfg.label} 当前没有需要更新的安全软件包`, updatedPackages: [] }
  }

  for (const pkg of safePkgs) {
    if (!/^[a-zA-Z0-9.+_-]+$/.test(pkg)) {
      return { ok: false, message: `非法包名: ${pkg}`, updatedPackages: [] }
    }
    if (nodeCfg.isProxmox && isPveKernelLockedPackage(pkg) !== undefined) {
      return { ok: false, message: `拦截受保护 PVE 包: ${pkg}`, updatedPackages: [] }
    }
  }

  const pkgArgs = safePkgs.join(' ')
  const sudoPrefix = nodeCfg.useSudo ? 'sudo ' : ''
  const aptCmd = `${sudoPrefix}DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade --no-install-recommends -y ${pkgArgs}`
  const res =
    nodeCfg.mode === 'local'
      ? await runCmd('bash', ['-c', aptCmd], 360000)
      : await runCmd('ssh', ['-o', 'ConnectTimeout=10', nodeCfg.sshHost ?? nodeCfg.id, aptCmd], 360000)

  const ok = res.code === 0
  return {
    ok,
    message: ok
      ? `${nodeCfg.label} 已完成 ${safePkgs.length} 个安全包更新（${safePkgs.join(', ')}）`
      : `${nodeCfg.label} APT 更新失败 (exit ${res.code})`,
    updatedPackages: ok ? safePkgs : [],
    output: (res.stdout + '\n' + res.stderr).trim().slice(-2000),
  }
}

// ── Git 上游仓库与 Agent Skills 追更（自动扫描 + git fetch + git pull --ff-only） ──

function discoverGitRepos(): Array<{ id: string; name: string; category: 'skill' | 'dsh-plugin' | 'project'; repoPath: string }> {
  const home = homedir()
  const scanTargets: Array<{ root: string; category: 'skill' | 'dsh-plugin' | 'project'; prefix: string }> = [
    { root: join(home, '.agents', 'skills'), category: 'skill', prefix: 'skill' },
    { root: join(home, 'dsh-plugins'), category: 'dsh-plugin', prefix: 'plugin' },
    { root: join(home, 'Projects'), category: 'project', prefix: 'project' },
    { root: join(home, 'projects'), category: 'project', prefix: 'project' },
    { root: join(home, 'workspace'), category: 'project', prefix: 'project' },
  ]

  const seenPaths = new Set<string>()
  const out: Array<{ id: string; name: string; category: 'skill' | 'dsh-plugin' | 'project'; repoPath: string }> = []

  for (const target of scanTargets) {
    if (!existsSync(target.root)) continue
    try {
      for (const entry of readdirSync(target.root)) {
        if (entry.startsWith('.') || entry.includes('.retired') || entry === 'node_modules') continue
        const full = resolve(target.root, entry)
        if (seenPaths.has(full)) continue
        try {
          if (!statSync(full).isDirectory()) continue
          if (!existsSync(join(full, '.git'))) continue
          seenPaths.add(full)
          out.push({
            id: `${target.prefix}:${entry}`,
            name: entry,
            category: target.category,
            repoPath: full,
          })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out
}

export async function scanAllGitRepos(): Promise<{
  repos: GitRepoRow[]
  updatableCount: number
  lockedCount: number
}> {
  const candidates = discoverGitRepos()
  const repos: GitRepoRow[] = []

  await Promise.all(
    candidates.map(async (cand) => {
      const remoteRes = await runCmd('git', ['-C', cand.repoPath, 'remote', 'get-url', 'origin'], 4000)
      const remoteUrl = remoteRes.stdout.trim()
      if (remoteRes.code !== 0 || !remoteUrl) return
      // 仅追踪公开 HTTP(S) 上游仓库（如 GitHub / GitLab / Codeberg），跳过无上游或私有内网备份裸仓
      if (!/^https?:\/\//i.test(remoteUrl)) return

      await runCmd('git', ['-C', cand.repoPath, 'fetch', '--quiet', 'origin'], 12000)

      const [branchRes, headRes, statusRes] = await Promise.all([
        runCmd('git', ['-C', cand.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], 4000),
        runCmd('git', ['-C', cand.repoPath, 'rev-parse', '--short', 'HEAD'], 4000),
        runCmd('git', ['-C', cand.repoPath, 'status', '--porcelain'], 5000),
      ])

      const branch = branchRes.stdout.trim() || 'main'
      const localCommit = headRes.stdout.trim() || 'unknown'
      const dirtyLines = statusRes.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const dirtyCount = dirtyLines.length

      const upstreamRef = `origin/${branch}`
      const [remoteCommitRes, revListRes] = await Promise.all([
        runCmd('git', ['-C', cand.repoPath, 'rev-parse', '--short', upstreamRef], 4000),
        runCmd('git', ['-C', cand.repoPath, 'rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`], 4000),
      ])

      const remoteCommit = remoteCommitRes.code === 0 ? remoteCommitRes.stdout.trim() : undefined
      let aheadCount = 0
      let behindCount = 0
      if (revListRes.code === 0 && revListRes.stdout.trim()) {
        const parts = revListRes.stdout.trim().split(/\s+/)
        aheadCount = Number(parts[0]) || 0
        behindCount = Number(parts[1]) || 0
      }

      let status: GitRepoRow['status'] = 'latest'
      let lockReason: string | undefined
      if (behindCount > 0) {
        if (dirtyCount > 0) {
          status = 'locked'
          lockReason = `工作区有 ${dirtyCount} 处本地未提交改动，为防止覆盖本地修改已自动锁定（请先 stash 或 commit）`
        } else if (aheadCount > 0) {
          status = 'locked'
          lockReason = `本地领先 ${aheadCount} 个提交且远端领先 ${behindCount} 个提交（存在分叉），需手动 rebase`
        } else {
          status = 'update'
        }
      }

      repos.push({
        id: cand.id,
        name: cand.name,
        category: cand.category,
        repoPath: cand.repoPath,
        branch,
        remoteUrl,
        localCommit,
        ...(remoteCommit ? { remoteCommit } : {}),
        behindCount,
        aheadCount,
        dirtyCount,
        status,
        ...(lockReason ? { lockReason } : {}),
        detail: `${cand.repoPath} (${branch})`,
      })
    }),
  )

  const catOrder: Record<GitRepoRow['category'], number> = { skill: 0, 'dsh-plugin': 1, project: 2 }
  repos.sort((a, b) => catOrder[a.category] - catOrder[b.category] || a.name.localeCompare(b.name))

  return {
    repos,
    updatableCount: repos.filter((r) => r.status === 'update').length,
    lockedCount: repos.filter((r) => r.status === 'locked').length,
  }
}

export async function pullGitRepo(
  id: string,
): Promise<{ ok: boolean; message: string; output?: string }> {
  const data = await scanAllGitRepos()
  const repo = data.repos.find((r) => r.id === id)
  if (!repo) {
    return { ok: false, message: `未找到 Git 仓库: ${id}` }
  }
  if (repo.status === 'locked') {
    return { ok: false, message: `拒绝拉取 ${repo.name}：${repo.lockReason ?? '工作区存在未提交改动'}` }
  }
  const pullRes = await runCmd('git', ['-C', repo.repoPath, 'pull', '--ff-only', 'origin', repo.branch], 60000)
  let extraOut = ''
  if (pullRes.code === 0 && repo.category === 'dsh-plugin' && existsSync(join(repo.repoPath, 'scripts', 'build.sh'))) {
    const buildRes = await runCmd('bash', ['./scripts/build.sh'], 120000)
    extraOut = `\n${buildRes.stdout}\n${buildRes.stderr}`
  }
  const headRes = await runCmd('git', ['-C', repo.repoPath, 'rev-parse', '--short', 'HEAD'], 4000)
  const newCommit = headRes.stdout.trim() || repo.remoteCommit || repo.localCommit
  const ok = pullRes.code === 0
  return {
    ok,
    message: ok
      ? `仓库 ${repo.name} 已快进同步至最新提交 (${repo.localCommit} → ${newCommit})`
      : `仓库 ${repo.name} 拉取失败 (exit ${pullRes.code})`,
    output: (pullRes.stdout + '\n' + pullRes.stderr + extraOut).trim().slice(-2000),
  }
}

// ── 跨节点存储与缓存瘦身（Docker 悬空镜像 / pnpm store / uv cache / Playwright 旧内核 / Journal 日志） ──

function parseSizeToBytes(text: string): number {
  const m = text.trim().match(/^([0-9.]+)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i)
  if (!m) return 0
  const val = parseFloat(m[1]!)
  const unit = m[2]!.toUpperCase()
  if (unit === 'B') return val
  if (unit === 'KB' || unit === 'KIB') return val * 1024
  if (unit === 'MB' || unit === 'MIB') return val * 1024 * 1024
  if (unit === 'GB' || unit === 'GIB') return val * 1024 * 1024 * 1024
  if (unit === 'TB' || unit === 'TIB') return val * 1024 * 1024 * 1024 * 1024
  return 0
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export async function scanAllCleanups(): Promise<{
  items: CleanupItemRow[]
  actionableCount: number
  totalReclaimableBytes: number
  totalReclaimableText: string
}> {
  const items: CleanupItemRow[] = []
  const dockerNodes = await resolveDockerNodes()

  // 1. 各节点 Docker 悬空镜像与构建缓存
  await Promise.all(
    dockerNodes.map(async (node) => {
      const dfRes = await execOnDockerNode(
        node,
        `docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}'`,
        12000,
      )
      if (dfRes.code !== 0 || !dfRes.stdout.trim()) return
      let totalSizeBytes = 0
      let reclaimableBytes = 0
      const parts: string[] = []
      for (const line of dfRes.stdout.trim().split('\n')) {
        const [type, size, reclaim] = line.split('|')
        if (!type || !size || !reclaim) continue
        if (type === 'Images' || type === 'Build Cache') {
          const cleanReclaim = reclaim.replace(/\s*\([^)]*\)/, '').trim()
          const rBytes = parseSizeToBytes(cleanReclaim)
          const sBytes = parseSizeToBytes(size)
          totalSizeBytes += sBytes
          reclaimableBytes += rBytes
          parts.push(`${type}: 总计 ${size}, 可回收 ${reclaim}`)
        }
      }
      const actionable = reclaimableBytes > 32 * 1024 * 1024 // > 32MB 提示可清理
      items.push({
        id: `docker-prune:${node.id}`,
        name: `${node.label} Docker 悬空镜像与构建缓存`,
        category: 'docker',
        node: node.id,
        nodeLabel: node.label,
        sizeText: formatBytes(totalSizeBytes),
        reclaimableText: formatBytes(reclaimableBytes),
        reclaimableBytes,
        actionable,
        detail: parts.join(' · ') || 'docker image prune -f && docker builder prune -f',
      })
    }),
  )

  const home = homedir()

  // 2. pnpm 全局内容寻址缓存 (~/.local/share/pnpm/store)
  const pnpmStoreDir = join(home, '.local', 'share', 'pnpm', 'store')
  if (existsSync(pnpmStoreDir)) {
    const duRes = await runCmd('du', ['-sb', pnpmStoreDir], 8000)
    const bytes = Number(duRes.stdout.trim().split(/\s+/)[0]) || 0
    items.push({
      id: 'cache:pnpm-store',
      name: 'pnpm 全局内容寻址存储 (pnpm store prune)',
      category: 'package-cache',
      node: 'local',
      nodeLabel: `本机 (${hostname()})`,
      sizeText: formatBytes(bytes),
      reclaimableText: bytes > 500 * 1024 * 1024 ? '支持修剪孤立包' : '体积健康',
      reclaimableBytes: 0,
      actionable: bytes > 500 * 1024 * 1024,
      detail: `${pnpmStoreDir} (清理未被任何项目硬链接引用的孤立包)`,
    })
  }

  // 3. uv 全局 Wheel 与源码构建缓存 (~/.cache/uv)
  const uvCacheDir = join(home, '.cache', 'uv')
  if (existsSync(uvCacheDir)) {
    const duRes = await runCmd('du', ['-sb', uvCacheDir], 8000)
    const bytes = Number(duRes.stdout.trim().split(/\s+/)[0]) || 0
    items.push({
      id: 'cache:uv-prune',
      name: 'uv Python 全局缓存 (uv cache prune)',
      category: 'package-cache',
      node: 'local',
      nodeLabel: `本机 (${hostname()})`,
      sizeText: formatBytes(bytes),
      reclaimableText: bytes > 500 * 1024 * 1024 ? '支持修剪过期轮子' : '体积健康',
      reclaimableBytes: 0,
      actionable: bytes > 500 * 1024 * 1024,
      detail: `${uvCacheDir} (uv cache prune 安全移除未引用缓存层)`,
    })
  }

  // 4. Playwright 历史旧版浏览器内核 (~/.cache/ms-playwright)
  const pwDir = join(home, '.cache', 'ms-playwright')
  if (existsSync(pwDir)) {
    try {
      const entries = readdirSync(pwDir)
      const groups: Record<string, Array<{ dir: string; rev: number; bytes: number }>> = {}
      let totalPwBytes = 0
      for (const entry of entries) {
        const m = entry.match(/^(chromium|chromium_headless_shell|firefox|webkit)-(\d+)$/)
        const full = join(pwDir, entry)
        const duRes = await runCmd('du', ['-sb', full], 6000)
        const bytes = Number(duRes.stdout.trim().split(/\s+/)[0]) || 0
        totalPwBytes += bytes
        if (m) {
          const prefix = m[1]!
          const rev = Number(m[2])
          groups[prefix] = groups[prefix] ?? []
          groups[prefix]!.push({ dir: entry, rev, bytes })
        }
      }
      let oldBytes = 0
      const oldDirs: string[] = []
      for (const list of Object.values(groups)) {
        if (list.length <= 1) continue
        list.sort((a, b) => b.rev - a.rev)
        for (const stale of list.slice(1)) {
          oldBytes += stale.bytes
          oldDirs.push(stale.dir)
        }
      }
      items.push({
        id: 'cache:playwright-old',
        name: 'Playwright 历史旧版浏览器内核',
        category: 'browser-cache',
        node: 'local',
        nodeLabel: `本机 (${hostname()})`,
        sizeText: formatBytes(totalPwBytes),
        reclaimableText: oldDirs.length > 0 ? `${formatBytes(oldBytes)} (${oldDirs.length} 个旧版)` : '0 B (仅保留最新)',
        reclaimableBytes: oldBytes,
        actionable: oldDirs.length > 0,
        detail:
          oldDirs.length > 0
            ? `可安全移除旧内核: ${oldDirs.join(', ')}（保留每个系列的最高版本）`
            : `${pwDir} 当前无冗余历史内核`,
      })
    } catch {
      /* ignore */
    }
  }

  // 5. Systemd Journal 系统日志归档
  const jRes = await runCmd('journalctl', ['--disk-usage'], 5000)
  if (jRes.code === 0 && jRes.stdout.trim()) {
    const m = jRes.stdout.match(/take up\s+([0-9.]+\s*[A-Za-z]+)/i)
    const sizeStr = m?.[1] ?? 'unknown'
    const bytes = parseSizeToBytes(sizeStr)
    const reclaim = Math.max(0, bytes - 200 * 1024 * 1024)
    items.push({
      id: 'log:journal-vacuum',
      name: 'Systemd Journal 系统日志归档',
      category: 'system-log',
      node: 'local',
      nodeLabel: `本机 (${hostname()})`,
      sizeText: sizeStr,
      reclaimableText: reclaim > 0 ? formatBytes(reclaim) : '0 B (≤200MB)',
      reclaimableBytes: reclaim,
      actionable: bytes > 250 * 1024 * 1024,
      detail: 'journalctl --vacuum-size=200M (保留最近 200MB 日志)',
    })
  }

  const totalReclaimableBytes = items.reduce((sum, i) => sum + i.reclaimableBytes, 0)
  return {
    items,
    actionableCount: items.filter((i) => i.actionable).length,
    totalReclaimableBytes,
    totalReclaimableText: formatBytes(totalReclaimableBytes),
  }
}

export async function runCleanupItem(
  id: string,
): Promise<{ ok: boolean; message: string; output?: string }> {
  if (id.startsWith('docker-prune:')) {
    const nodeId = id.slice('docker-prune:'.length)
    const dockerNodes = await resolveDockerNodes()
    const nodeCfg = dockerNodes.find((n) => n.id === nodeId)
    if (!nodeCfg) return { ok: false, message: `未找到 Docker 节点: ${nodeId}` }
    const res = await execOnDockerNode(nodeCfg, 'docker image prune -f && docker builder prune -f', 180000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? `${nodeCfg.label} Docker 悬空镜像与构建缓存已清理` : `Docker 清理失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'cache:pnpm-store') {
    const pnpmBin = existsSync('/usr/bin/pnpm') ? '/usr/bin/pnpm' : 'pnpm'
    const res = await runCmd(pnpmBin, ['store', 'prune'], 180000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'pnpm store 孤立包缓存已修剪完成' : `pnpm store prune 失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'cache:uv-prune') {
    const uvBin = await resolveUvBin()
    const res = await runCmd(uvBin, ['cache', 'prune'], 180000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'uv 过期缓存层已修剪完成' : `uv cache prune 失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  if (id === 'cache:playwright-old') {
    const pwDir = join(homedir(), '.cache', 'ms-playwright')
    if (!existsSync(pwDir)) return { ok: true, message: 'Playwright 缓存目录不存在，无需清理' }
    const entries = readdirSync(pwDir)
    const groups: Record<string, Array<{ dir: string; rev: number }>> = {}
    for (const entry of entries) {
      const m = entry.match(/^(chromium|chromium_headless_shell|firefox|webkit)-(\d+)$/)
      if (m) {
        const prefix = m[1]!
        groups[prefix] = groups[prefix] ?? []
        groups[prefix]!.push({ dir: entry, rev: Number(m[2]) })
      }
    }
    const toRemove: string[] = []
    for (const list of Object.values(groups)) {
      if (list.length <= 1) continue
      list.sort((a, b) => b.rev - a.rev)
      for (const stale of list.slice(1)) {
        toRemove.push(stale.dir)
      }
    }
    if (toRemove.length === 0) {
      return { ok: true, message: '当前没有冗余的旧版 Playwright 浏览器内核' }
    }
    const targetPaths = toRemove.map((d) => join(pwDir, d))
    const res = await runCmd('rm', ['-rf', ...targetPaths], 60000)
    return {
      ok: res.code === 0,
      message:
        res.code === 0
          ? `已清理 ${toRemove.length} 个旧版 Playwright 内核（${toRemove.join(', ')}）`
          : `清理 Playwright 旧内核失败 (exit ${res.code})`,
      output: toRemove.join('\n'),
    }
  }

  if (id === 'log:journal-vacuum') {
    const res = await runCmd('sudo', ['journalctl', '--vacuum-size=200M'], 60000)
    return {
      ok: res.code === 0,
      message: res.code === 0 ? 'Systemd Journal 日志已压缩至 200MB 以内' : `Journal 清理失败 (exit ${res.code})`,
      output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
    }
  }

  return { ok: false, message: `未知的清理项: ${id}` }
}

// ── Systemd 守护进程与定时任务健康巡检（Failed Units & Timers） ─────────────

export async function scanSystemdHealth(): Promise<{
  failedUnits: SystemdUnitRow[]
  failedCount: number
  activeTimersCount: number
}> {
  const failedUnits: SystemdUnitRow[] = []

  const parseUnits = (raw: string, scope: 'system' | 'user') => {
    try {
      const arr = JSON.parse(raw) as Array<{
        unit?: string
        load?: string
        active?: string
        sub?: string
        description?: string
      }>
      if (!Array.isArray(arr)) return
      for (const u of arr) {
        if (!u?.unit) continue
        failedUnits.push({
          id: `${scope}:${u.unit}`,
          unit: u.unit,
          scope,
          loadState: u.load ?? 'loaded',
          activeState: u.active ?? 'failed',
          subState: u.sub ?? 'failed',
          description: u.description ?? u.unit,
          actionable: true,
        })
      }
    } catch {
      /* ignore */
    }
  }

  const [sysFailedRes, userFailedRes, timersRes] = await Promise.all([
    runCmd('systemctl', ['list-units', '--state=failed', '--output=json', '--no-pager'], 5000),
    runCmd('systemctl', ['--user', 'list-units', '--state=failed', '--output=json', '--no-pager'], 5000),
    runCmd('systemctl', ['list-timers', '--all', '--output=json', '--no-pager'], 5000),
  ])

  if (sysFailedRes.code === 0 && sysFailedRes.stdout.trim()) {
    parseUnits(sysFailedRes.stdout, 'system')
  }
  if (userFailedRes.code === 0 && userFailedRes.stdout.trim()) {
    parseUnits(userFailedRes.stdout, 'user')
  }

  let activeTimersCount = 0
  try {
    const timers = JSON.parse(timersRes.stdout)
    if (Array.isArray(timers)) activeTimersCount = timers.length
  } catch {
    /* ignore */
  }

  return {
    failedUnits,
    failedCount: failedUnits.length,
    activeTimersCount,
  }
}

export async function fixSystemdUnit(
  id: string,
): Promise<{ ok: boolean; message: string; output?: string }> {
  if (id === 'all') {
    const [sysRes, userRes] = await Promise.all([
      runCmd('sudo', ['systemctl', 'reset-failed'], 15000),
      runCmd('systemctl', ['--user', 'reset-failed'], 15000),
    ])
    const ok = sysRes.code === 0
    return {
      ok,
      message: ok ? '已重置所有残留的 Systemd failed 状态单元' : `重置失败状态单元出错 (exit ${sysRes.code})`,
      output: (sysRes.stdout + '\n' + sysRes.stderr + '\n' + userRes.stderr).trim().slice(-1500),
    }
  }

  const [scope, ...rest] = id.split(':')
  const unit = rest.join(':')
  if (!unit || !/^[a-zA-Z0-9@_.:-]+$/.test(unit)) {
    return { ok: false, message: `非法的 Systemd 单元标识: ${id}` }
  }
  const res =
    scope === 'user'
      ? await runCmd('systemctl', ['--user', 'reset-failed', unit], 15000)
      : await runCmd('sudo', ['systemctl', 'reset-failed', unit], 15000)
  return {
    ok: res.code === 0,
    message: res.code === 0 ? `已重置异常单元 ${unit} 的报错状态` : `重置 ${unit} 失败 (exit ${res.code})`,
    output: (res.stdout + '\n' + res.stderr).trim().slice(-1500),
  }
}
