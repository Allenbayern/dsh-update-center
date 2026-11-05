/**
 * 转线上（本地源 → registry 依赖）逻辑冒烟测试：用假 pluginManager 跑真实 convert.ts，
 * 不碰线上 profile、不跑 pnpm。验证四件事：
 *   ① link 依赖：先 removeBundle 再 installBundle(name@ver)；
 *   ② install 失败：必须把原规格（link:…）装回去；
 *   ③ 已经是 registry 依赖：直接拒绝；
 *   ④ 注入条目：只装不摘，并要求解除注入。
 * 用法：node scripts/smoke-convert.mjs
 */
import { convertToRegistry } from '../lib/types/host/convert.js'

const results = []
const check = (label, cond, extra) => {
  results.push({ label, ok: !!cond, extra })
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' :: ' + extra))
}

function makeManager(overrides = {}) {
  const calls = []
  const bundles = [
    {
      name: 'demo-link',
      version: '1.2.3',
      source: 'link:/home/allen/dsh-plugins/demo-link',
      updatable: false,
      official: false,
      availability: 'profile',
      readOnlyReason: undefined,
    },
    { name: 'demo-npm', version: '1.0.0', source: undefined, updatable: true, official: false, availability: 'profile' },
  ]
  const manager = {
    calls,
    async listBundles() {
      return bundles
    },
    async removeBundle(name) {
      calls.push(['remove', name])
      return overrides.removeResult ?? { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, options) {
      calls.push(['install', spec, options?.saveExact])
      if (overrides.installImpl !== undefined) return overrides.installImpl(spec, calls)
      return { changed: true, application: 'applied', stage: 'install', target: spec, version: '1.2.3' }
    },
  }
  return manager
}

const base = {
  registry: 'https://registry.npmjs.org',
  timeoutMs: 1000,
  // 不联网：探测与比对都注入假实现（真实现另有 smoke 覆盖）。
  probeUpstreamImpl: async (registry, name, installed) => ({
    found: true,
    version: '1.2.3',
    bundle: true,
    position: 'same',
    convertible: true,
    tarballUrl: 'https://example.invalid/x.tgz',
  }),
  compareLocalImpl: async (options) =>
    options.name === 'demo-link'
      ? { status: 'identical', version: '1.2.3', changedCount: 0, modifiedCount: 0, localOnlyCount: 0, upstreamOnlyCount: 0, changedFiles: [] }
      : { status: 'identical', version: '1.2.3', changedCount: 0, modifiedCount: 0, localOnlyCount: 0, upstreamOnlyCount: 0, changedFiles: [] },
}

// ① link → registry 正常路径
{
  const manager = makeManager()
  const out = await convertToRegistry(manager, { ...base, name: 'demo-link' })
  check('① link 转线上成功', out.ok === true, out.message)
  check('① 先摘后装', manager.calls[0]?.[0] === 'remove' && manager.calls[1]?.[0] === 'install', JSON.stringify(manager.calls))
  check('① 存范围版本（saveExact=false）', manager.calls[1]?.[2] === false)
}

// ② 装失败 → 恢复原 link 规格
{
  const manager = makeManager({
    installImpl: (spec, calls) => {
      if (spec.startsWith('demo-link@')) return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'network', diagnostic: 'boom' } }
      return { changed: true, application: 'applied', stage: 'install', target: spec }
    },
  })
  const out = await convertToRegistry(manager, { ...base, name: 'demo-link' })
  check('② 失败时 ok=false', out.ok === false, out.message)
  check('② 失败后恢复原规格', manager.calls.some(([kind, spec]) => kind === 'install' && spec === 'link:/home/allen/dsh-plugins/demo-link'), JSON.stringify(manager.calls))
  check('② 消息里说明已恢复', String(out.message).includes('已恢复原来源'))
}

// ③ 已经是 registry 依赖 → 拒绝，且不动任何东西
{
  const manager = makeManager()
  const out = await convertToRegistry(manager, { ...base, name: 'demo-npm', version: '1.1.0' })
  check('③ registry 依赖被拒', out.ok === false && String(out.message).includes('registry 依赖'), out.message)
  check('③ 未发生任何调用', manager.calls.length === 0, JSON.stringify(manager.calls))
}

// ④ 注入条目：只装不摘，提示解除注入
{
  const manager = makeManager()
  const out = await convertToRegistry(manager, { ...base, name: 'demo-injected', injected: true })
  check('④ 注入条目装成功', out.ok === true, out.message)
  check('④ 注入条目不摘除', manager.calls.every(([kind]) => kind !== 'remove'), JSON.stringify(manager.calls))
  check('④ 要求解除注入', out.needsUninject === true && String(out.message).includes('dev_uninject_plugin'))
}

// ⑤ 摘除失败 → 不继续装
{
  const manager = makeManager({ removeResult: { changed: false, application: 'failed', stage: 'remove', target: 'demo-link', error: { code: 'bundle-in-use' } } })
  const out = await convertToRegistry(manager, { ...base, name: 'demo-link' })
  check('⑤ 摘除失败即止', out.ok === false && manager.calls.length === 1, JSON.stringify(manager.calls))
}

// ⑥ 本地有改动且未确认 → 拒绝，且不动任何东西
{
  const manager = makeManager()
  const out = await convertToRegistry(manager, {
    ...base,
    name: 'demo-link',
    compareLocalImpl: async () => ({
      status: 'modified',
      version: '1.2.3',
      changedCount: 7,
      modifiedCount: 3,
      localOnlyCount: 4,
      upstreamOnlyCount: 0,
      changedFiles: ['src/index.ts', 'src/client/service.ts', 'README.md'],
    }),
  })
  check('⑥ 有本地改动未确认即拒绝', out.ok === false && String(out.message).includes('confirmOverwrite'), out.message)
  check('⑥ 拒绝时未动依赖', manager.calls.length === 0, JSON.stringify(manager.calls))
  check('⑥ 结果里带比对细节', out.localDelta?.modifiedCount === 3)
}

// ⑦ 本地有改动 + 已确认 → 继续转换
{
  const manager = makeManager()
  const out = await convertToRegistry(manager, {
    ...base,
    name: 'demo-link',
    confirmOverwrite: true,
    compareLocalImpl: async () => ({
      status: 'modified',
      version: '1.2.3',
      changedCount: 1,
      modifiedCount: 1,
      localOnlyCount: 0,
      upstreamOnlyCount: 0,
      changedFiles: ['src/index.ts'],
    }),
  })
  check('⑦ 确认后照常转换', out.ok === true && manager.calls.length === 2, JSON.stringify(manager.calls))
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED') + ' (' + results.length + ' checks)')
process.exit(failed.length === 0 ? 0 : 1)
