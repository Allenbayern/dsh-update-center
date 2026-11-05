/**
 * 提醒口径冒烟测试（纯函数，不联网）：
 *   ① 本体 major 变化 → 大版本；② 0.x 的 minor 变化也算大版本；
 *   ③ 插件角标只算「正式版可更新」；仅预览版单独计数；
 *   ④ 可转线上（convertible）只统计、不进提醒数量；
 *   ⑤ 没有数据时不误报。
 * 用法：node scripts/smoke-reminder.mjs
 */
import { reminderFrom, versionLevel, levelLabel } from '../lib/types/host/reminder.js'

const results = []
const check = (label, ok, extra) => {
  results.push({ label, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' :: ' + extra))
}

// ① 版本级别
check('① 1.2.3 → 2.0.0 是大版本', versionLevel('1.2.3', '2.0.0') === 'major')
check('② 0.2.1 → 0.3.0 在 0.x 下也算大版本', versionLevel('0.2.1', '0.3.0') === 'major', versionLevel('0.2.1', '0.3.0'))
check('1.2.3 → 1.3.0 是次版本', versionLevel('1.2.3', '1.3.0') === 'minor')
check('1.2.3 → 1.2.4 是补丁', versionLevel('1.2.3', '1.2.4') === 'patch')
check('同版本返回 same', versionLevel('0.2.2-alpha.3', '0.2.2-alpha.3') === 'same')
check('降级返回 same', versionLevel('0.3.0', '0.2.0') === 'same')
check('标签文案', levelLabel('major') === '大版本' && levelLabel('patch') === '补丁版')

const row = (name, status, extra = {}) => ({ name, kind: 'bundle', sourceKind: 'npm', updatable: true, enabled: true, status, ...extra })

const snapshot = (over = {}) => ({
  generatedAt: new Date().toISOString(),
  cached: false,
  registry: 'https://registry.npmjs.org',
  core: {
    name: '@deepseek-ai/dsh',
    version: '0.2.1',
    channels: { stable: { version: '0.3.0', tags: ['latest'] }, preview: { version: '0.3.0-alpha.1', tags: ['alpha'] } },
    reachable: true,
    status: 'update',
  },
  bundles: [
    row('a', 'update'),
    row('b', 'update'),
    row('c', 'preview-only'),
    row('d', 'latest'),
    row('e', 'not-registry', { upstream: { found: true, version: '1.0.0', convertible: true } }),
    row('core-pkg', 'not-registry', { providedByCore: true }),
  ],
  coreProvided: [],
  injected: [{ name: 'inj', kind: 'injected', sourceKind: 'injected', updatable: false, status: 'not-registry', upstream: { found: true, version: '2.0.0', convertible: true } }],
  env: { node: 'v24', platform: 'linux', arch: 'x64', dshHome: '/x', service: { name: 'dsh.service', active: 'active' }, deepChecked: false },
  summary: { stableUpdates: 2, previewUpdates: 3, scannedBundles: 4, skippedBundles: 0 },
  pendingRestart: [{ name: 'a', at: new Date().toISOString() }],
  warnings: [],
  ...over,
})

const r1 = reminderFrom(snapshot())
check('本体有更新且标为大版本', r1.core.hasUpdate === true && r1.core.level === 'major' && r1.core.target === '0.3.0', JSON.stringify(r1.core))
check('③ 角标只算正式版可更新（=2）', r1.plugins.count === 2, JSON.stringify(r1.plugins))
check('③ 仅预览版单独计数（=1）', r1.plugins.previewOnly === 1)
check('④ 可转线上只统计（=2）不进提醒', r1.convertible === 2 && r1.plugins.count === 2)
check('需重启计数', r1.pendingRestart === 1)
check('本体自带包不混进插件数', r1.plugins.names.includes('core-pkg') === false)

// 仅预览版有新版 → 本体仍算有更新，但通道是 preview
const r2 = reminderFrom(
  snapshot({
    core: {
      name: '@deepseek-ai/dsh',
      version: '0.2.1',
      channels: { stable: { version: '0.2.1', tags: ['latest'] }, preview: { version: '0.2.2-alpha.4', tags: ['alpha'] } },
      reachable: true,
      status: 'preview-only',
    },
  }),
)
check('仅预览版有新版也算有更新（preview 通道）', r2.core.hasUpdate === true && r2.core.channel === 'preview', JSON.stringify(r2.core))

// 全都最新 → 不提醒
const r3 = reminderFrom(
  snapshot({
    core: { name: '@deepseek-ai/dsh', version: '0.3.0', channels: { stable: { version: '0.3.0', tags: ['latest'] } }, reachable: true, status: 'latest' },
    bundles: [row('a', 'latest'), row('e', 'not-registry', { upstream: { found: true, version: '1.0.0', convertible: true } })],
    injected: [],
    pendingRestart: [],
  }),
)
check('⑤ 全最新时不提醒（本体无更新、角标 0、可转不计）', r3.core.hasUpdate === false && r3.plugins.count === 0 && r3.convertible === 1, JSON.stringify({ core: r3.core, plugins: r3.plugins }))

// 没数据
const r4 = reminderFrom(undefined, { scanning: true })
check('⑤ 没数据时不误报', r4.hasData === false && r4.core.hasUpdate === false && r4.plugins.count === 0)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED') + ' (' + results.length + ' checks)')
process.exit(failed.length === 0 ? 0 : 1)
