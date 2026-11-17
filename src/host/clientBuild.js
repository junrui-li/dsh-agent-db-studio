/**
 * Client 运行时单文件的按需构建（插件激活时调用，不依赖子进程）。
 *
 * 源码在 `src/client/parts/*.js`（多个小文件，便于人和 AI 阅读），运行时文件在
 * `dist/client/index.js`（dist/ 不入库，仓库里只保留源码一份）。DSH 的 Client 半片必须是
 * 单个模块，所以激活时确保 bundle 是新的：
 *   - dist 不存在 → 构建；
 *   - 任一 part（或构建核心）比 dist 新 → 重新构建；
 *   - 构建失败只记日志不抛，插件其余部分照常工作（面板会缺，但工具/后端不受影响）。
 *
 * 拼接实现与 CLI（scripts/build-client.mjs）共用 `clientBundleCore.js`，不存在两份外壳。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildClientSource } from './clientBundleCore.js'

const PARTS_REL = join('src', 'client', 'parts')
const CORE_REL = join('src', 'host', 'clientBundleCore.js')
const BUNDLE_REL = join('dist', 'client', 'index.js')

function listParts(partsDir) {
  return readdirSync(partsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name)
    .sort()
}

/** 需要构建的原因；null = 已是最新/不是插件源码目录。 */
function staleReason(repoRoot) {
  const partsDir = join(repoRoot, PARTS_REL)
  if (!existsSync(partsDir)) return null // 测试用的临时 repoRoot：跳过
  const bundlePath = join(repoRoot, BUNDLE_REL)
  if (!existsSync(bundlePath)) return 'dist/client/index.js 不存在'
  const bundleMtime = statSync(bundlePath).mtimeMs
  let newest = 0
  for (const name of listParts(partsDir)) {
    newest = Math.max(newest, statSync(join(partsDir, name)).mtimeMs)
  }
  const corePath = join(repoRoot, CORE_REL)
  if (existsSync(corePath)) newest = Math.max(newest, statSync(corePath).mtimeMs)
  if (newest > bundleMtime) return 'parts 比 dist 新'
  return null
}

/**
 * @param {string} repoRoot 插件根目录
 * @param {{info?:Function, warn?:Function}} [log]
 * @returns {{built:boolean, reason?:string, error?:string}}
 */
export function ensureClientBundle(repoRoot, log = {}) {
  const info = typeof log.info === 'function' ? log.info : () => {}
  const warn = typeof log.warn === 'function' ? log.warn : () => {}
  try {
    const reason = staleReason(repoRoot)
    if (!reason) return { built: false }
    const partsDir = join(repoRoot, PARTS_REL)
    const names = listParts(partsDir)
    if (!names.length) return { built: false, error: 'parts 目录为空' }
    const sources = names.map(name => readFileSync(join(partsDir, name), 'utf8'))
    const output = buildClientSource(sources)
    const bundlePath = join(repoRoot, BUNDLE_REL)
    mkdirSync(dirname(bundlePath), { recursive: true })
    writeFileSync(bundlePath, output, 'utf8')
    info('[dsh-db-studio] client bundle 已重建（' + reason + '，' + names.length + ' parts）')
    return { built: true, reason }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    warn('[dsh-db-studio] client bundle 构建失败：' + message)
    return { built: false, error: message }
  }
}
