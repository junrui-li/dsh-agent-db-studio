#!/usr/bin/env node
/**
 * 把 src/client/parts/*.js 拼成 dist/client/index.js（dist/ 不入库，仓库里只保留源码一份）。
 *
 * 为什么需要构建：DSH 的 Client 半片必须是单个模块（factory 里只能拿宿主注入的 react，
 * 不能 import 相对文件），所以源码拆成多个 part，运行时文件由本脚本生成。
 * 模块外壳在 src/host/clientBundleCore.js（插件激活时按需重建也用它，两边只有一份实现）。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 生成 dist/client/index.js
 *   node scripts/build-client.mjs --check   # 只校验是否与 parts 一致（不写文件）
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClientSource } from '../src/host/clientBundleCore.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PARTS_DIR = join(REPO, 'src', 'client', 'parts')
const OUTPUT = join(REPO, 'dist', 'client', 'index.js')

const checkMode = process.argv.includes('--check')

const files = (await readdir(PARTS_DIR)).filter(name => name.endsWith('.js')).sort()
if (!files.length) {
  console.error('[build-client] src/client/parts 下没有 .js 文件')
  process.exit(1)
}

const partSources = []
for (const file of files) partSources.push(await readFile(join(PARTS_DIR, file), 'utf8'))
const output = buildClientSource(partSources)

let current = ''
try {
  current = await readFile(OUTPUT, 'utf8')
} catch {
  current = ''
}

if (checkMode) {
  if (current === output) {
    console.log('[build-client] OK: dist/client/index.js 与 parts 一致 (' + files.length + ' parts)')
    process.exit(0)
  }
  const a = current.split('\n')
  const b = output.split('\n')
  let firstDiff = -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) { firstDiff = index + 1; break }
  }
  console.error('[build-client] 过期：dist/client/index.js 与 parts 不一致，首个差异在第 ' + firstDiff + ' 行')
  console.error('[build-client] 请运行: node scripts/build-client.mjs')
  process.exit(1)
}

if (current === output) {
  console.log('[build-client] 无变化 (' + files.length + ' parts)')
} else {
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, output, 'utf8')
  console.log('[build-client] 已生成 dist/client/index.js ('
    + files.length + ' parts, ' + output.split('\n').length + ' lines)')
}
