import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-update-center'

/** 宿主运行时已提供的模块：client bundle 里不打进去，交给 __ModuleLoader__ 的 require。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** 宿主半边：tsc 产物 lib/types/index.js → 单文件 lib/index.js（ESM / node）。 */
const hostBundle: UserConfig = {
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'index.js' },
}

/** 浏览器半边：打进 __ModuleLoader__ 工厂，只留 react 为外部依赖。 */
const clientBundle: UserConfig = {
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [hostBundle, clientBundle] satisfies UserConfig[]
