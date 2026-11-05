/**
 * 把一条**非 registry** 的本地源换成线上（registry）依赖。
 *
 * 本地链接（`link:`）/ git / 压缩包这三种，在 profile 的 package.json 里都是一条依赖规格；
 * `pluginManager.installBundle('<name>@<version>')` 跑的是同一条 `pnpm add`，会把那条规格
 * 改写成 registry 版本，失败时官方实现自己会恢复 package.json / pnpm-lock.yaml。
 * 所以这里不自己改文件、不自己跑 pnpm，只做三件事：查、判、调。
 *
 * 运行时注入（超级注入器）不是 profile 依赖，装成线上套件后注入那一份仍然在跑，
 * 两份同名插件同时注册会打架——所以这种转换只装，然后要求用户解除注入。
 */
import type { ConvertResult } from '../shared/types.js'
import { isLocalProtectedPackage, localDirOf, probeUpstream, readInjections } from './scan.js'
import { compareLocalWithUpstream } from './upstream-compare.js'

export interface ConvertOptions {
  name: string
  /** 目标版本；缺省用上游最新版。 */
  version?: string
  registry: string
  timeoutMs: number
  /** 调用方说这是运行时注入条目（它不在 listBundles 里）。 */
  injected?: boolean
  /** 本地包目录（用于「本地有没有改动」的比对）。 */
  dir?: string
  /** 用户已经确认「覆盖本地改动」。没确认时，本地有改动一律拒绝。 */
  confirmOverwrite?: boolean
  /** 测试注入点：上游探测（默认查真实 registry）。 */
  probeUpstreamImpl?: typeof probeUpstream
  /** 测试注入点：本地改动比对（默认下载上游 tarball 逐文件比）。 */
  compareLocalImpl?: typeof compareLocalWithUpstream
}

type AnyService = Record<string, any> | undefined

export async function convertToRegistry(manager: AnyService, options: ConvertOptions): Promise<ConvertResult> {
  const name = options.name.trim()
  if (name === '') return { ok: false, message: '缺少包名' }
  if (isLocalProtectedPackage(name)) {
    return { ok: false, name, message: name + ' 为本地自研受保护包（白名单锁定），禁止转为公共 npm 依赖' }
  }
  if (manager === undefined || typeof manager.listBundles !== 'function') {
    return { ok: false, name, message: 'pluginManager 不可用，无法执行转换' }
  }

  let row: any
  try {
    const bundles: any[] = (await manager.listBundles()) ?? []
    row = bundles.find((bundle) => bundle?.name === name)
  } catch (error) {
    return { ok: false, name, message: '读取套件清单失败：' + String(error) }
  }
  const injected = options.injected === true || row === undefined
  if (row === undefined && options.injected !== true) {
    return { ok: false, name, message: '清单里没有 ' + name + '（可能已经卸载）' }
  }
  if (row !== undefined) {
    if (row.official === true || row.availability === 'installation' || row.readOnlyReason === 'management-required') {
      return { ok: false, name, message: '这是 DSH 安装本体自带的包，随本体升级，不需要转线上' }
    }
    if (row.updatable === true) {
      return { ok: false, name, message: '它已经是 registry 依赖了，直接用「更新」即可' }
    }
  }

  const installed = typeof row?.version === 'string' ? row.version : undefined
  // 本地目录：link:/file: 依赖直接取规格里的路径；注入条目从注入器注册表里取 dir。
  const dir =
    options.dir ??
    localDirOf(typeof row?.source === 'string' ? row.source : undefined) ??
    (injected ? readInjections().entries.find((entry) => entry.name === name)?.dir : undefined)

  // 上游探测：既决定目标版本，也拿到 tarball 地址去比「本地有没有改动」。
  const probeUpstreamFn = options.probeUpstreamImpl ?? probeUpstream
  const compareLocalFn = options.compareLocalImpl ?? compareLocalWithUpstream
  const probe = await probeUpstreamFn(options.registry, name, installed, options.timeoutMs)
  if (probe.found !== true || probe.version === undefined) {
    return { ok: false, name, from: installed, message: probe.reason ?? '上游查不到同名包，无法转线上' }
  }
  if (probe.convertible !== true) {
    return { ok: false, name, from: installed, to: probe.version, message: probe.reason ?? '上游这一版不能转线上' }
  }
  const requested = options.version?.trim() ?? ''
  const target = requested === '' ? probe.version : requested
  if (target !== probe.version) {
    return {
      ok: false,
      name,
      from: installed,
      to: target,
      message: '目标版本 ' + target + ' 不是上游最新版 ' + probe.version + '（转换只装上游最新版）',
    }
  }

  // 本地改动比对：版本号一样不代表内容一样（本地补丁 / 改过的构建产物）。
  const localDelta =
    dir === undefined || dir === ''
      ? undefined
      : await compareLocalFn({
          dir,
          name,
          version: target,
          tarballUrl: probe.tarballUrl,
          timeoutMs: options.timeoutMs,
        })
  if (localDelta !== undefined && localDelta.status === 'modified' && options.confirmOverwrite !== true) {
    return {
      ok: false,
      name,
      from: installed,
      to: target,
      localDelta,
      message:
        '本地有 ' +
        String(localDelta.changedCount ?? 0) +
        ' 处与上游 ' +
        target +
        ' 不同（' +
        (localDelta.changedFiles ?? []).slice(0, 6).join('、') +
        '…）：转线上后生效的是上游版本，本地改动不再生效（本地目录不会被删除）；确认请带 confirmOverwrite=true',
    }
  }

  if (typeof manager.installBundle !== 'function') {
    return { ok: false, name, message: 'pluginManager 没有 installBundle，无法执行转换' }
  }

  /**
   * 关键：HMR 在线时 `installBundle` 对「已经存在的依赖」会直接抛 `already-installed`
   * （见 pluginManager 源码），所以不能直接 install，必须像官方 updateBundle 那样
   * **先摘后装**，失败再把原规格装回去。原规格 = 当前那条 link:/git/tarball 字符串，
   * 所以回滚是逐字恢复，不是猜出来的。
   */
  const previous = typeof row?.source === 'string' && row.source !== '' ? row.source : `${name}@${installed ?? target}`
  const payloadBase: ConvertResult = {
    ok: false,
    name,
    ...(installed === undefined ? {} : { from: installed }),
    to: target,
    ...(injected ? { needsUninject: true } : {}),
    ...(localDelta === undefined ? {} : { localDelta }),
  }

  const describe = (result: any): ConvertResult['packageResult'] => {
    const packageResult = result?.packageResult
    if (packageResult === undefined) return undefined
    return {
      exitCode: Number(packageResult.exitCode ?? -1),
      ...(packageResult.kind === undefined ? {} : { kind: String(packageResult.kind) }),
      ...(typeof packageResult.output === 'string' ? { output: packageResult.output.slice(-2000) } : {}),
      ...(typeof packageResult.logPath === 'string' ? { logPath: packageResult.logPath } : {}),
    }
  }

  try {
    // 1. 摘掉旧来源（注入条目不在 profile 依赖里，不用摘）。
    if (!injected) {
      if (typeof manager.removeBundle !== 'function') {
        return { ...payloadBase, message: 'pluginManager 没有 removeBundle，无法先摘旧来源' }
      }
      const removal = await manager.removeBundle(name)
      if (removal?.application === 'failed' || removal?.application === 'cancelled') {
        return {
          ...payloadBase,
          application: String(removal?.application ?? 'failed'),
          message:
            '摘除旧来源失败：' +
            String(removal?.error?.code ?? removal?.application ?? 'unknown') +
            (removal?.error?.diagnostic === undefined ? '' : '（' + String(removal.error.diagnostic).slice(0, 200) + '）') +
            '；依赖未改动',
        }
      }
    }

    // 2. 从上游装。
    const result = await manager.installBundle(name + '@' + target, {
      registry: options.registry,
      // 存范围版本（^x.y.z）而不是精确版本：之后还能正常收到上游小版本更新。
      saveExact: false,
      enabled: true,
    })
    const application = String(result?.application ?? 'unknown')
    const ok = application === 'applied' || application === 'overridden' || application === 'restart-required'
    if (!ok) {
      // 3. 失败 → 把原来的本地规格装回去（官方实现只保证 install 失败时恢复 package.json，
      //    这里已经先摘过一次，必须自己把依赖恢复，否则插件就没了）。
      let restored = false
      if (!injected) {
        try {
          const restore = await manager.installBundle(previous, { registry: options.registry, enabled: true })
          restored = restore?.application !== 'failed' && restore?.application !== 'cancelled'
        } catch {
          restored = false
        }
      }
      return {
        ...payloadBase,
        application,
        message:
          '转线上失败：' +
          String(result?.error?.code ?? application) +
          (result?.error?.diagnostic === undefined ? '' : '（' + String(result.error.diagnostic).slice(0, 200) + '）') +
          (injected ? '' : restored ? '；已恢复原来源 ' + previous : '；原来源恢复失败，需要手动 pnpm add ' + previous),
        ...(describe(result) === undefined ? {} : { packageResult: describe(result) }),
      }
    }

    const payload: ConvertResult = {
      ...payloadBase,
      ok: true,
      application,
      ...(result?.restartReason === undefined ? {} : { restartReason: String(result.restartReason) }),
      message:
        application === 'restart-required'
          ? '已换成线上 ' + target + '，但这个包要重启 DSH 才生效'
          : '已换成线上 ' + target + '，依赖规格已改写为 registry 版本',
      ...(describe(result) === undefined ? {} : { packageResult: describe(result) }),
    }
    if (injected) {
      payload.message =
        payload.message +
        '｜注意：注入的那一份还在跑，请在会话里执行 dev_uninject_plugin ' +
        name +
        ' 解除注入（同名插件重复注册会互相打架）'
    }
    return payload
  } catch (error) {
    // 异常路径同样要保证依赖还在：能恢复就恢复。
    let restored = false
    if (!injected) {
      try {
        const restore = await manager.installBundle(previous, { registry: options.registry, enabled: true })
        restored = restore?.application !== 'failed' && restore?.application !== 'cancelled'
      } catch {
        restored = false
      }
    }
    return {
      ...payloadBase,
      message:
        '转换异常：' +
        String(error) +
        (injected ? '' : restored ? '；已恢复原来源 ' + previous : '；原来源可能已摘除，请手动 pnpm add ' + previous),
    }
  }
}
