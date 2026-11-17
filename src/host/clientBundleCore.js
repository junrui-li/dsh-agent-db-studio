/**
 * Client 单文件拼接的**唯一实现**：模块外壳 + part 顺序拼接。
 *
 * 被两处共用，避免两份 HEADER/FOOTER 走样：
 *   - scripts/build-client.mjs（CLI：构建 / --check）
 *   - src/host/clientBuild.js（插件激活时按需重建 dist，不依赖子进程）
 *
 * 运行时约束：DSH 的 Client 半片必须是单个模块（factory 里只能拿宿主注入的 react，
 * 不能 import 相对文件），所以源码拆成 parts、运行时拼成一个文件。
 */

export const CLIENT_HEADER = [
  'window.__ModuleLoader__.load({',
  "  id: 'dsh-db-studio',",
  '  factory(require) {',
  "    const React = require('react')",
  '    const h = React.createElement',
  '    const { useState, useEffect, useRef, useCallback } = React',
  '',
  '',
].join('\n')

export const CLIENT_FOOTER = ['', '    return plugin', '  },', '})', ''].join('\n')

/**
 * @param {string[]} partSources 已按文件名排序的 part 源码
 * @returns {string} 运行时单文件内容
 */
export function buildClientSource(partSources) {
  return CLIENT_HEADER + partSources.join('') + CLIENT_FOOTER
}
