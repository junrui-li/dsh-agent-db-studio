
    // ======================================================================
    // 13. 样式：全部走 --dsw-alias-* 主题变量，类名统一 dbs- 前缀
    // ======================================================================

    const CSS = `
.dbs-root {
  --dbs-bg: var(--dsw-alias-bg-base, Canvas);
  --dbs-layer: var(--dsw-alias-bg-layer-2, Canvas);
  --dbs-ink: var(--dsw-alias-label-primary, CanvasText);
  --dbs-ink-2: var(--dsw-alias-label-secondary, GrayText);
  --dbs-ink-3: var(--dsw-alias-label-tertiary, GrayText);
  --dbs-ink-4: var(--dsw-alias-label-caption, GrayText);
  --dbs-on-primary: var(--dsw-alias-label-primary-inverted, Canvas);
  --dbs-line: var(--dsw-alias-border-l2, color-mix(in srgb, GrayText 30%, transparent));
  --dbs-line-strong: var(--dsw-alias-border-l4, color-mix(in srgb, GrayText 55%, transparent));
  --dbs-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, CanvasText 7%, transparent));
  --dbs-active: var(--dsw-alias-interactive-bg-active, color-mix(in srgb, CanvasText 12%, transparent));
  --dbs-primary: var(--dsw-alias-button-primary-fill, CanvasText);
  --dbs-primary-hover: var(--dsw-alias-button-primary-hover, CanvasText);
  --dbs-link: var(--dsw-alias-link, LinkText);
  --dbs-danger: var(--dsw-alias-danger, LinkText);
  --dbs-r-sm: var(--dsw-radius-sm, 8px);
  --dbs-r-md: var(--dsw-radius-md, 12px);
  --dbs-font: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
  --dbs-mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  --dbs-shadow: var(--dsw-elevation-soft, 0 1px 2px color-mix(in srgb, CanvasText 12%, transparent));
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dbs-bg);
  color: var(--dbs-ink);
  font-family: var(--dbs-font);
  font-size: 13px;
  line-height: 20px;
  -webkit-font-smoothing: antialiased;
}
.dbs-root *, .dbs-root *::before, .dbs-root *::after { box-sizing: border-box; }
.dbs-root :where(button) { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
.dbs-root :where(button):disabled { cursor: default; opacity: .5; }
.dbs-root :where(p, h1, h2, h3, pre) { margin: 0; }
.dbs-root :focus-visible { outline: 2px solid var(--dbs-link); outline-offset: 1px; border-radius: var(--dbs-r-sm); }
.dbs-root .dbs-grow { flex: 1; }
.dbs-root .dbs-mono { font-family: var(--dbs-mono); }
.dbs-root .dbs-muted { color: var(--dbs-ink-3); }
.dbs-root .dbs-pad { padding: 10px 12px; }
.dbs-root .dbs-note { padding: 5px 12px; font-size: 11.5px; color: var(--dbs-link); background: color-mix(in srgb, var(--dbs-link) 9%, transparent); }
.dbs-root .dbs-sep { width: 1px; height: 16px; background: var(--dbs-line); }
.dbs-root .dbs-count { font-size: 10.5px; line-height: 16px; padding: 0 6px; border-radius: 8px; color: var(--dbs-ink-3); background: var(--dbs-hover); }

/* 头部 */
.dbs-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--dbs-line); }
.dbs-title { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
.dbs-health { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dbs-ink-3); }
.dbs-health .dbs-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dbs-ink-4); }
.dbs-health.is-ready { color: var(--dbs-link); }
.dbs-health.is-ready .dbs-dot { background: var(--dbs-link); }
.dbs-health.is-down { color: var(--dbs-danger); }
.dbs-health.is-down .dbs-dot { background: var(--dbs-danger); }
.dbs-banner { flex: none; display: flex; align-items: flex-start; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--dbs-line);
  color: var(--dbs-danger); background: color-mix(in srgb, var(--dbs-danger) 8%, transparent); font-size: 12.5px; }
.dbs-banner-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dbs-banner-body b { font-weight: 600; }
.dbs-banner-body span { color: var(--dbs-ink-2); }

/* 标签 / 按钮 / 输入 */
.dbs-tag { display: inline-flex; align-items: center; font-size: 10.5px; line-height: 17px; padding: 0 6px; border-radius: 9px;
  border: 1px solid var(--dbs-line-strong); color: var(--dbs-ink-3); white-space: nowrap; font-family: var(--dbs-font); }
.dbs-tag.is-link { color: var(--dbs-link); border-color: color-mix(in srgb, var(--dbs-link) 45%, transparent); }
.dbs-tag.is-danger { color: var(--dbs-danger); border-color: color-mix(in srgb, var(--dbs-danger) 45%, transparent); }
.dbs-tag.is-warn { color: var(--dbs-link); border-color: color-mix(in srgb, var(--dbs-link) 45%, transparent); }
.dbs-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; padding: 0 10px;
  border-radius: var(--dbs-r-sm); border: 1px solid var(--dbs-line-strong); background: transparent; color: var(--dbs-ink);
  font-size: 12.5px; white-space: nowrap; transition: background .15s; }
.dbs-btn:hover:not(:disabled) { background: var(--dbs-hover); }
.dbs-btn.is-primary { background: var(--dbs-primary); color: var(--dbs-on-primary); border-color: transparent; }
.dbs-btn.is-primary:hover:not(:disabled) { background: var(--dbs-primary-hover); }
.dbs-btn.is-small { height: 24px; padding: 0 8px; font-size: 12px; }
.dbs-btn.is-ghost { border-color: transparent; color: var(--dbs-ink-3); }
.dbs-btn.is-ghost:hover:not(:disabled) { color: var(--dbs-ink); background: var(--dbs-hover); }
.dbs-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--dbs-r-sm); color: var(--dbs-ink-3); }
.dbs-iconbtn:hover:not(:disabled) { background: var(--dbs-hover); color: var(--dbs-ink); }
.dbs-btn.is-on { color: var(--dbs-link); background: var(--dbs-active); }
.dbs-select { height: 26px; max-width: 220px; padding: 0 6px; border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-sm);
  background: var(--dbs-layer); color: var(--dbs-ink); font: inherit; font-size: 12px; }
.dbs-input { height: 26px; flex: 1; min-width: 120px; max-width: 420px; padding: 0 8px; border: 1px solid var(--dbs-line-strong);
  border-radius: var(--dbs-r-sm); background: var(--dbs-layer); color: var(--dbs-ink); font: inherit; font-size: 12px; outline: none; }
.dbs-input:focus { border-color: var(--dbs-link); }
.dbs-input::placeholder, .dbs-editor::placeholder { color: var(--dbs-ink-4); }
.dbs-kbd { font-family: var(--dbs-mono); font-size: 10px; line-height: 16px; padding: 0 5px; border-radius: 4px;
  border: 1px solid var(--dbs-line-strong); color: var(--dbs-ink-3); }

/* 分区 */
.dbs-section { display: flex; flex-direction: column; min-height: 0; }
/* 左栏上下比例固定 3:7（连接区 30% / 元数据区 70%）：两侧都以 flex-basis:0 参与分配，
   内部滚动条各自负责；不再用 max-height 卡百分比条数，连接多了就在连接区里滚。
   连接区的 min-height 只是极端矮面板的下限（保证「新建连接」和至少一行可见），不影响正常比例。 */
.dbs-conn-section { flex: 3 1 0; min-height: 104px; overflow: hidden; border-bottom: 1px solid var(--dbs-line); }
.dbs-tree-section { flex: 7 1 0; min-height: 0; overflow: hidden; }
/* 空态 / 错误态直接作为分区 body 时也要能滚，否则 30% 高度里会被裁掉 */
.dbs-conn-section > .dbs-empty, .dbs-conn-section > .dbs-pad,
.dbs-tree-section > .dbs-empty, .dbs-tree-section > .dbs-pad { min-height: 0; overflow: auto; }
.dbs-section-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px; }
/* 元数据区表名模糊搜索框（第 55 轮）：标题行与树 body 之间的整行输入框 */
.dbs-meta-search { flex: none; padding: 0 10px 6px; }
.dbs-section-title { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dbs-ink-3); }
.dbs-body { flex: 1; min-height: 0; display: flex; }
.dbs-side { flex: none; width: 286px; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--dbs-line); }
.dbs-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* 连接列表：连接区高度固定为左栏的 30%，行数超出时在本区内滚动（用户要求「连接区要有下拉滚动条」） */
.dbs-conn-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 0 6px 8px; }
.dbs-conn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: var(--dbs-r-sm); color: var(--dbs-ink-2); }
.dbs-conn:hover { background: var(--dbs-hover); }
.dbs-conn.is-on { background: var(--dbs-active); color: var(--dbs-ink); }
.dbs-conn.is-on svg { color: var(--dbs-link); }
.dbs-conn-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dbs-conn-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-conn-sub { font-size: 10.5px; line-height: 15px; color: var(--dbs-ink-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 元数据树 */
.dbs-tree { flex: 1; min-height: 0; overflow: auto; padding: 0 6px 10px; }
.dbs-tree-node { display: block; }
.dbs-tree-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border-radius: 6px;
  font-size: 12.5px; color: var(--dbs-ink-2); }
.dbs-tree-row:hover { background: var(--dbs-hover); color: var(--dbs-ink); }
.dbs-tree-row.is-on { background: var(--dbs-active); color: var(--dbs-ink); }
.dbs-tree-row.is-on svg { color: var(--dbs-link); }
.dbs-tree-table { padding-left: 28px; }
.dbs-tree-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-tree-sub { font-size: 10px; color: var(--dbs-ink-4); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dbs-tree-group { padding: 6px 6px 2px 28px; font-size: 10px; letter-spacing: .04em; color: var(--dbs-ink-4); }
.dbs-tree-note { display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 28px; font-size: 12px; color: var(--dbs-ink-4); }
.dbs-tree-error { padding: 4px 6px 4px 24px; }
.dbs-chevron { display: inline-flex; transition: transform .15s; color: var(--dbs-ink-4); }
.dbs-chevron.is-open { transform: rotate(90deg); }

/* 工作区 */
.dbs-workbench { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-runbar { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--dbs-line); }
.dbs-editor-wrap { flex: none; padding: 8px 12px 6px; border-bottom: 1px solid var(--dbs-line); display: flex; flex-direction: column; gap: 4px; }
.dbs-editor { width: 100%; height: auto; min-height: 0; max-height: none; padding: 8px 10px; resize: none;
  border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-sm); background: var(--dbs-layer); color: var(--dbs-ink);
  font-family: var(--dbs-mono); font-size: 12.5px; line-height: 19px; tab-size: 2; outline: none; white-space: pre; overflow: auto; }
/* 编辑器高度（第 34 轮）：由分隔比例决定（默认 6:4，拖分隔条调整），textarea 填满 region，内容超出内部滚动 */
.dbs-editor:focus { border-color: var(--dbs-link); }
.dbs-editor-foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dbs-ink-4); }
.dbs-results { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-results-scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.dbs-tabbar { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--dbs-line); min-height: 34px; }
.dbs-tab { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; font-size: 12.5px; color: var(--dbs-ink-3);
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.dbs-tab:hover { color: var(--dbs-ink); }
.dbs-tab.is-on { color: var(--dbs-ink); border-bottom-color: var(--dbs-link); }
.dbs-tab-note { font-family: var(--dbs-mono); font-size: 11px; color: var(--dbs-ink-4); margin-left: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 结果 */
.dbs-result-list { display: flex; flex-direction: column; gap: 12px; padding: 10px 12px 16px; }
.dbs-result { flex: none; border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }
.dbs-result.is-error { border-color: color-mix(in srgb, var(--dbs-danger) 45%, transparent); }
.dbs-result-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 5px 10px; border-bottom: 1px solid var(--dbs-line);
  font-size: 12px; color: var(--dbs-ink-2); }
.dbs-result-index { font-family: var(--dbs-mono); font-size: 11px; color: var(--dbs-ink-4); }
.dbs-result-sql { margin-left: 8px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--dbs-mono); font-size: 10.5px; color: var(--dbs-ink-4); }
.dbs-error-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--dbs-mono); font-size: 12px;
  line-height: 18px; color: var(--dbs-danger); }
.dbs-pre { margin: 0; padding: 10px 12px; overflow: auto; max-height: 460px; white-space: pre-wrap; word-break: break-word;
  font-family: var(--dbs-mono); font-size: 12px; line-height: 18px; color: var(--dbs-ink); background: var(--dbs-layer); }

/* 网格 */
.dbs-grid-wrap { overflow: auto; max-height: 442px; }
.dbs-grid { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; font-family: var(--dbs-mono); font-size: 12px; }
.dbs-grid th { position: sticky; top: 0; z-index: 1; text-align: left; padding: 4px 10px; background: var(--dbs-layer);
  border-bottom: 1px solid var(--dbs-line-strong); font-weight: 600; color: var(--dbs-ink-2); white-space: nowrap; }
.dbs-th-name { display: block; }
.dbs-th-type { display: block; font-size: 9.5px; line-height: 13px; font-weight: 400; color: var(--dbs-ink-4); }
.dbs-grid td { padding: 4px 10px; border-bottom: 1px solid var(--dbs-line); max-width: 420px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
.dbs-grid tbody tr:hover td { background: var(--dbs-hover); }
.dbs-grid .is-num { text-align: right; font-variant-numeric: tabular-nums; }
.dbs-grid .dbs-rownum { width: 1%; text-align: right; color: var(--dbs-ink-4); user-select: none; }
.dbs-null { color: var(--dbs-ink-4); font-style: italic; }

/* 表详情 */
.dbs-tabledetail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-td-head { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--dbs-line); }
.dbs-td-name { font-family: var(--dbs-mono); font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.dbs-td-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.dbs-tabledetail > .dbs-grid-wrap { flex: 1; min-height: 0; max-height: none; }
.dbs-ddl-box { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-ddl-bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--dbs-line); }
.dbs-ddl-box .dbs-pre { flex: 1; max-height: none; background: transparent; }

/* Redis */
.dbs-redis { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-redis-split { flex: 1; min-height: 0; display: flex; }
.dbs-keys-pane { flex: none; width: 320px; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--dbs-line); }
.dbs-keys { flex: 1; min-height: 0; overflow: auto; padding: 4px 6px 10px; }
.dbs-key-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; border-radius: 6px; font-size: 12px; color: var(--dbs-ink-2); }
.dbs-key-row:hover { background: var(--dbs-hover); }
.dbs-key-row.is-on { background: var(--dbs-active); color: var(--dbs-ink); }
.dbs-key-name { flex: 1; min-width: 0; font-family: var(--dbs-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-key-ttl { font-size: 10px; color: var(--dbs-ink-4); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dbs-detail-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dbs-redis-detail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-redis-detail-head { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--dbs-line); }
.dbs-key-title { font-size: 12.5px; font-weight: 600; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-redis-detail-body { flex: 1; min-height: 0; overflow: auto; }
.dbs-redis-value { display: flex; flex-direction: column; }
.dbs-redis-value-bar { flex: none; padding: 5px 12px; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dbs-ink-4); }
.dbs-redis-value .dbs-grid-wrap { max-height: none; }

/* 空态 / 骨架 / 错误 / 加载 */
.dbs-empty { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 28px 22px; color: var(--dbs-ink-3); text-align: center; }
.dbs-empty.is-small { padding: 18px 14px; gap: 6px; }
.dbs-empty-title { font-size: 14px; font-weight: 600; color: var(--dbs-ink); }
.dbs-empty-text { font-size: 12.5px; line-height: 19px; max-width: 520px; }
.dbs-empty-hint { font-size: 11.5px; line-height: 17px; color: var(--dbs-ink-4); max-width: 520px; }
.dbs-empty-actions { display: flex; gap: 8px; margin-top: 4px; }
.dbs-guide-wide { width: 100%; max-width: 560px; margin-top: 8px; text-align: left; }
.dbs-statuscard { width: 100%; max-width: 420px; margin-top: 6px; border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm);
  padding: 6px 12px; text-align: left; background: var(--dbs-layer); }
.dbs-statusrow { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 12px; }
.dbs-statusrow > span:last-child { color: var(--dbs-ink-2); text-align: right; }
.dbs-skeleton-list { display: flex; flex-direction: column; }
.dbs-skeleton { height: 11px; border-radius: 6px; background: linear-gradient(90deg, var(--dbs-hover) 25%, var(--dbs-active) 37%, var(--dbs-hover) 63%);
  background-size: 400% 100%; animation: dbs-shimmer 1.4s ease infinite; }
@keyframes dbs-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.dbs-spinner { flex: none; display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 1.5px solid var(--dbs-line-strong); border-top-color: var(--dbs-link); animation: dbs-spin .7s linear infinite; }
.dbs-spinner.is-large { width: 20px; height: 20px; border-width: 2px; }
@keyframes dbs-spin { to { transform: rotate(360deg); } }
.dbs-error { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: var(--dbs-r-sm);
  border: 1px solid color-mix(in srgb, var(--dbs-danger) 40%, transparent);
  background: color-mix(in srgb, var(--dbs-danger) 8%, transparent); color: var(--dbs-danger); font-size: 12.5px; }
.dbs-error.is-compact { padding: 5px 8px; font-size: 11.5px; }
.dbs-error-text { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
.dbs-error .dbs-btn.is-ghost { align-self: center; }

/* ================= 第 2 轮新增：SQL 补全 / 结果 tab / 连接管理 / AI 对话 ================= */

/* ---- SQL 补全 ---- */
.dbs-editor-wrap { position: relative; }
/* 关键字单色高亮层（第 26/31 轮）：与 textarea 同框（stack + inset:0），高度恒等于 textarea
   （含 resize 拖拽跟随），不再按内容自然高把面板铺满；文字透明由本层着色 */
/* stack 撑满 wrap 剩余高度（第 34 轮）：textarea 才能填满 region——第 31 轮 stack 是 block，
   textarea 高度塌成内容高，这正是「编辑器只剩一行」的根因之一 */
.dbs-editor-stack { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-editor-highlight { position: absolute; inset: 0; padding: 8px 10px;
  border: 1px solid transparent; font-family: var(--dbs-mono); font-size: 12.5px; line-height: 19px;
  letter-spacing: normal; tab-size: 2; white-space: pre; word-break: normal; overflow-wrap: normal;
  overflow: hidden; pointer-events: none; color: var(--dbs-ink); }
.dbs-token-kw { color: var(--dbs-link); }
/* 注释置灰：ink-3 再叠 30% 透明（比 ink-3 更退后，仍保持可读——不用 ink-4 以免贴近消失） */
.dbs-token-comment { color: color-mix(in srgb, var(--dbs-ink-3) 70%, transparent); }
/* textarea 文字透明（高亮层着色），光标保持可见 */
.dbs-editor-text { color: transparent; caret-color: var(--dbs-ink); background: transparent;
  position: relative; z-index: 1; }
/* 行号槽（第 35 轮）：叠在 textarea 左侧留白上（z-index 高于 textarea，pointer-events 放行点击），
   宽度随行数位数内联设置；scrollTop 由 JS 与编辑器同步；内缩 1px 露出 textarea 左边框 */
.dbs-editor-gutter { position: absolute; top: 1px; bottom: 1px; left: 1px; z-index: 2; overflow: hidden;
  border-right: 1px solid var(--dbs-line); background: var(--dbs-bg); color: var(--dbs-ink-4);
  font-family: var(--dbs-mono); font-size: 12.5px; line-height: 19px; text-align: right;
  user-select: none; pointer-events: none; }
.dbs-editor-gutter-inner { padding: 8px 8px 8px 0; white-space: pre; }
.dbs-editor-mirror { position: absolute; left: 12px; right: 12px; top: 8px; padding: 8px 10px;
  border: 1px solid transparent; font-family: var(--dbs-mono); font-size: 12.5px; line-height: 19px;
  letter-spacing: normal; tab-size: 2; white-space: pre; word-break: normal; overflow-wrap: normal;
  overflow: hidden; visibility: hidden; pointer-events: none; }
.dbs-caret-marker { display: inline-block; width: 0; height: 1em; }
.dbs-complete { position: absolute; z-index: 40; width: 288px; max-height: 238px; display: flex; flex-direction: column;
  background: var(--dbs-layer); border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-sm);
  box-shadow: var(--dbs-shadow); overflow: hidden; }
.dbs-complete-list { flex: 1; min-height: 0; overflow: auto; padding: 4px; }
.dbs-complete-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border-radius: 5px;
  font-size: 12px; color: var(--dbs-ink-2); }
.dbs-complete-item:hover, .dbs-complete-item.is-on { background: var(--dbs-active); color: var(--dbs-ink); }
.dbs-complete-label { flex: 1; min-width: 0; font-family: var(--dbs-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-complete-kind { flex: none; font-size: 9.5px; line-height: 15px; padding: 0 5px; border-radius: 8px;
  border: 1px solid var(--dbs-line); color: var(--dbs-ink-4); }
.dbs-complete-detail { flex: none; max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--dbs-ink-4); }
.dbs-complete-empty { display: flex; align-items: center; gap: 6px; padding: 8px; font-size: 11.5px; color: var(--dbs-ink-4); }
.dbs-complete-hint { flex: none; border-top: 1px solid var(--dbs-line); padding: 3px 8px; font-size: 10px; color: var(--dbs-ink-4); }

/* ---- 多结果集 tab ---- */
.dbs-result-panel { display: flex; flex-direction: column; }
.dbs-result-tabs { position: sticky; top: 0; z-index: 2; flex: none; display: flex; align-items: center; gap: 6px;
  padding: 6px 10px 0; border-bottom: 1px solid var(--dbs-line); background: var(--dbs-bg); }
.dbs-result-tabs-scroll { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 2px;
  overflow-x: auto; overflow-y: hidden; }
.dbs-result-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px;
  border: 1px solid transparent; border-bottom: 0; border-radius: var(--dbs-r-sm) var(--dbs-r-sm) 0 0;
  color: var(--dbs-ink-3); font-size: 12px; white-space: nowrap; }
.dbs-result-tab:hover { color: var(--dbs-ink); background: var(--dbs-hover); }
.dbs-result-tab.is-on { color: var(--dbs-ink); background: var(--dbs-layer); border-color: var(--dbs-line-strong); margin-bottom: -1px; }
.dbs-result-tab.is-error { color: var(--dbs-danger); }
.dbs-result-tab-label { font-family: var(--dbs-mono); font-size: 11.5px; }
.dbs-result-tab-badge { font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 8px;
  background: var(--dbs-hover); color: var(--dbs-ink-3); }
.dbs-result-tab-badge.is-danger { color: var(--dbs-danger); background: color-mix(in srgb, var(--dbs-danger) 12%, transparent); }
.dbs-result-tab-actions { flex: none; display: flex; align-items: center; gap: 6px; padding-bottom: 4px; flex-wrap: wrap; }
.dbs-result-tab-wrap { flex: none; display: inline-flex; align-items: flex-end; }
.dbs-result-tab-close { flex: none; width: 18px; height: 22px; line-height: 18px; text-align: center; margin-bottom: -1px;
  border-radius: 4px; color: var(--dbs-ink-4); font-size: 12px; }
.dbs-result-tab-close:hover { background: var(--dbs-active); color: var(--dbs-danger); }
.dbs-result-close { flex: none; width: 20px; height: 20px; line-height: 18px; text-align: center; border-radius: 4px;
  color: var(--dbs-ink-4); font-size: 13px; }
.dbs-result-close:hover { background: var(--dbs-active); color: var(--dbs-danger); }
.dbs-grid-select { width: 1%; padding: 0 6px !important; text-align: center; }
.dbs-grid-select input { margin: 0; cursor: pointer; }
.dbs-export { position: relative; flex: none; display: inline-flex; }
.dbs-export-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 45; width: 240px;
  background: var(--dbs-layer); border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-sm);
  box-shadow: var(--dbs-shadow); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.dbs-export-group { display: flex; flex-direction: column; gap: 3px; padding: 3px 2px; }
.dbs-export-label { font-size: 10.5px; color: var(--dbs-ink-4); }
.dbs-export-formats { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dbs-export-option { padding: 3px 7px; border-radius: 5px; border: 1px solid var(--dbs-line); font-size: 11px;
  color: var(--dbs-ink-2); background: var(--dbs-bg); }
.dbs-export-option:hover:not(:disabled) { background: var(--dbs-hover); border-color: var(--dbs-line-strong); }
.dbs-export-option:disabled { opacity: .5; cursor: default; }
.dbs-export-error { font-size: 10.5px; color: var(--dbs-danger); flex: none;
  display: inline-flex; align-items: center; gap: 2px; }
.dbs-export-notice.is-ok { font-size: 10.5px; color: var(--dbs-link); flex: none;
  display: inline-flex; align-items: center; gap: 2px; }

/* 第 48 轮：编辑器查找替换浮层 */
.dbs-editor-search { position: absolute; right: 10px; top: 6px; z-index: 40;
  display: flex; flex-direction: column; gap: 4px; padding: 6px 8px;
  border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-md);
  background: var(--dbs-layer); box-shadow: 0 10px 28px color-mix(in srgb, CanvasText 22%, transparent); }
.dbs-editor-search-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dbs-editor-search-input { width: 190px; }
.dbs-editor-search-count { font-size: 10.5px; color: var(--dbs-ink-3); min-width: 34px; text-align: center; }
.dbs-editor-search-opt { font-size: 10.5px; white-space: nowrap; }
.dbs-editor-search-msg { font-size: 10.5px; color: var(--dbs-link); }

/* 编辑器查找命中标记（画在高亮层：textarea 文字透明，命中底色只能落在本层）。
   全部命中：浅底 + 下缘线；当前命中：深底 + 1px 描边——浅深两主题下都能一眼定位 */
.dbs-editor-highlight .dbs-editor-match { border-radius: 2px;
  background: color-mix(in srgb, var(--dbs-accent) 20%, transparent);
  box-shadow: inset 0 -1.5px 0 color-mix(in srgb, var(--dbs-accent) 55%, transparent); }
.dbs-editor-highlight .dbs-editor-match.is-active { background: color-mix(in srgb, var(--dbs-accent) 45%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dbs-accent) 80%, transparent); }

/* 独立语句线框（按分号切分，字符串/注释里的分号不算切分点，单语句不画）：
   一语句一框——框样式只画在「语句区间×行」的行带 span 上（JS 已把样式小段嵌套进行带），
   相邻行带同色底自然接成连续区域，首行带上边线、含分号的末行行带下边线收口。
   只能用背景/阴影/上下边线——inline 元素的左右 border/padding 会推移字形，
   破坏高亮层与 textarea 的逐字符对齐 */
.dbs-editor-highlight .dbs-sql-stmt { background: color-mix(in srgb, var(--dbs-ink) 4%, transparent); }
.dbs-editor-highlight .dbs-sql-stmt.is-stmt-first { border-top: 1px solid color-mix(in srgb, var(--dbs-ink) 16%, transparent);
  border-top-left-radius: 3px; border-top-right-radius: 3px; }
.dbs-editor-highlight .dbs-sql-stmt.is-stmt-last { border-bottom: 1px solid color-mix(in srgb, var(--dbs-ink) 16%, transparent);
  border-bottom-left-radius: 3px; border-bottom-right-radius: 3px; }

/* 第 48 轮：结果集行编辑态 */
.dbs-grid.is-editing .dbs-cell { padding: 2px 4px; }
.dbs-edit-reason { font-size: 10.5px; color: var(--dbs-ink-3); flex: none; }
.dbs-grid-edit { width: 34px; text-align: center; color: var(--dbs-ink-3); }
.dbs-grid tr.is-deleted .dbs-cell-input,
.dbs-grid tr.is-deleted .dbs-rownum { text-decoration: line-through; opacity: .55; }
.dbs-grid tr.is-new-row .dbs-cell-input { border-color: color-mix(in srgb, var(--dbs-link) 45%, transparent); }
.dbs-cell-input { width: 100%; min-width: 72px; padding: 2px 5px; font: inherit; font-size: 11.5px;
  border: 1px solid var(--dbs-line); border-radius: 4px; background: var(--dbs-canvas, Canvas);
  color: inherit; }
.dbs-cell-input:focus { outline: none; border-color: var(--dbs-link); }
.dbs-cell-input.is-dirty { border-color: var(--dbs-link);
  background: color-mix(in srgb, var(--dbs-link) 8%, transparent); }

/* 第 48 轮：单行详情 */
.dbs-row-detail-wrap { max-height: 380px; overflow: auto; border: 1px solid var(--dbs-line);
  border-radius: var(--dbs-r-sm); }
.dbs-row-detail { width: 100%; border-collapse: collapse; font-size: 12px; }
.dbs-row-detail th, .dbs-row-detail td { text-align: left; padding: 4px 8px;
  border-bottom: 1px solid var(--dbs-line); vertical-align: top; }
.dbs-row-detail td.dbs-row-detail-name { white-space: nowrap; }
.dbs-row-detail td.dbs-row-detail-value { word-break: break-all; white-space: pre-wrap; }

/* 第 48 轮：行编辑提交弹窗的 SQL 预览 */
.dbs-edit-preview { max-height: 220px; overflow: auto; font-size: 11.5px; }
.dbs-result-tab-body { padding-bottom: 12px; }

/* ---- 连接管理 ---- */
.dbs-conn-item { border-radius: var(--dbs-r-sm); }
.dbs-conn-item.is-on { background: var(--dbs-active); }
.dbs-conn-line { display: flex; align-items: center; gap: 2px; }
.dbs-conn { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; width: auto; padding: 6px; border-radius: var(--dbs-r-sm); color: var(--dbs-ink-2); }
.dbs-conn:hover { background: var(--dbs-hover); }
.dbs-conn-item.is-on .dbs-conn svg { color: var(--dbs-link); }
.dbs-conn-more { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 3px;
  min-width: 22px; height: 22px; padding: 0 6px; font-size: 10.5px; border-radius: 5px; color: var(--dbs-ink-3); }
.dbs-conn-more:hover { background: var(--dbs-hover); color: var(--dbs-ink); }
.dbs-conn-menu { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; padding: 2px 6px 6px 10px; }
.dbs-conn-menu-item { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 5px;
  font-size: 11.5px; color: var(--dbs-ink-2); }
.dbs-conn-menu-item:hover:not(:disabled) { background: var(--dbs-hover); color: var(--dbs-ink); }
.dbs-conn-menu-item.is-danger { color: var(--dbs-danger); }
.dbs-conn-menu-confirm { flex-basis: 100%; font-size: 11px; color: var(--dbs-ink-3); padding: 2px 2px 0; }
.dbs-conn-test { margin: 0 6px 4px 10px; padding: 3px 7px; border-radius: 5px; font-size: 11px;
  display: flex; align-items: center; gap: 5px; }
.dbs-conn-test .dbs-conn-test-text { flex: 1; min-width: 0; word-break: break-word; }
.dbs-conn-test.is-ok { color: var(--dbs-link); background: color-mix(in srgb, var(--dbs-link) 10%, transparent); }
.dbs-conn-test.is-bad { color: var(--dbs-danger); background: color-mix(in srgb, var(--dbs-danger) 10%, transparent); }
.dbs-conn-footer { flex: none; padding: 4px 8px 8px; }
.dbs-conn-new { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; padding: 5px;
  border: 1px dashed var(--dbs-line-strong); border-radius: var(--dbs-r-sm); color: var(--dbs-ink-3); font-size: 12px; }
.dbs-conn-new:hover { color: var(--dbs-link); border-color: var(--dbs-link); }

/* ---- 弹层表单 ---- */
.dbs-modal-mask.is-blocked { cursor: progress; }
.dbs-modal.is-blocked { position: relative; }
.dbs-modal-block { position: absolute; inset: 0; z-index: 10; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; background: color-mix(in srgb, var(--dbs-bg) 82%, transparent);
  border-radius: var(--dbs-r-md); cursor: progress; }
.dbs-modal-block-text { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dbs-ink-2); }
.dbs-ai-stats { color: var(--dbs-ink-3); overflow-wrap: anywhere; }
.dbs-modal-mask { position: absolute; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: var(--dsw-alias-bg-mask-1, color-mix(in srgb, CanvasText 42%, transparent)); }
.dbs-modal { width: 560px; max-width: 100%; max-height: calc(100% - 24px); display: flex; flex-direction: column;
  background: var(--dbs-layer); border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-md);
  box-shadow: var(--dsw-elevation-prominent, 0 18px 48px color-mix(in srgb, CanvasText 24%, transparent)); overflow: hidden; }
.dbs-modal.is-wide { width: 640px; }
.dbs-modal-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dbs-line); }
.dbs-modal-title { flex: 1; font-size: 13.5px; font-weight: 600; }
.dbs-modal-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.dbs-form { display: flex; flex-direction: column; gap: 10px; }
.dbs-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.dbs-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dbs-field.is-wide { grid-column: 1 / -1; }
.dbs-field-label { font-size: 11px; color: var(--dbs-ink-3); }
.dbs-field-hint { font-size: 10.5px; color: var(--dbs-ink-4); }
.dbs-input.is-full, .dbs-select.is-full { width: 100%; max-width: none; }
.dbs-form-check { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.dbs-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dbs-ink-2); cursor: pointer; }
.dbs-check input { accent-color: var(--dbs-link); }
.dbs-form-test { padding: 6px 9px; border-radius: var(--dbs-r-sm); font-size: 12px; overflow-wrap: anywhere; }
.dbs-form-test.is-ok { color: var(--dbs-link); background: color-mix(in srgb, var(--dbs-link) 10%, transparent); }
.dbs-form-test.is-bad { color: var(--dbs-danger); background: color-mix(in srgb, var(--dbs-danger) 10%, transparent); }
.dbs-form-actions { display: flex; align-items: center; gap: 8px; padding-top: 2px; }

/* 工作区 */
.dbs-workbench-body { flex: 1; min-height: 0; display: flex; }
.dbs-workbench-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dbs-chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--dbs-line-strong); background: transparent; color: var(--dbs-ink-2); font-size: 11px; white-space: nowrap; }
.dbs-chip:hover:not(:disabled) { border-color: var(--dbs-link); color: var(--dbs-link); }

/* ================= 第 3 轮新增：顶部导航 / 工单 / 执行历史 / 模型选择 ================= */

.dbs-nav { flex: none; display: flex; align-items: center; gap: 2px; padding: 4px 12px 0; border-bottom: 1px solid var(--dbs-line); }
.dbs-nav-item { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12.5px; color: var(--dbs-ink-3);
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.dbs-nav-item:hover { color: var(--dbs-ink); }
.dbs-nav-item.is-on { color: var(--dbs-ink); border-bottom-color: var(--dbs-link); }
.dbs-nav-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px;
  padding: 0 4px; border-radius: 8px; background: var(--dbs-danger); color: var(--dbs-on-primary);
  font-size: 9.5px; line-height: 16px; font-variant-numeric: tabular-nums; }
.dbs-content { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.dbs-body.is-hidden { display: none; }
.dbs-view { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 14px 14px; gap: 8px; }
.dbs-view-head { flex: none; display: flex; align-items: flex-start; gap: 8px; }
.dbs-view-heading { display: flex; flex-direction: column; gap: 1px; }
.dbs-view-title { font-size: 14px; font-weight: 600; }
.dbs-view-sub { font-size: 11.5px; color: var(--dbs-ink-4); }
.dbs-view-chips { flex: none; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dbs-chip.is-on { background: var(--dbs-active); border-color: var(--dbs-ink-3); color: var(--dbs-ink); }
.dbs-chip-count { margin-left: 4px; font-size: 9.5px; color: var(--dbs-ink-3); }
.dbs-view-split { flex: 1; min-height: 0; display: flex; gap: 10px; }
.dbs-ticket-list-pane { flex: none; width: 44%; min-width: 320px; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }
.dbs-ticket-detail-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }
.dbs-ticket-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.dbs-ticket-row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 10px;
  border-bottom: 1px solid var(--dbs-line); text-align: left; }
.dbs-ticket-row:hover { background: var(--dbs-hover); }
.dbs-ticket-row.is-on { background: var(--dbs-active); }
.dbs-ticket-row-status { display: flex; gap: 4px; }
.dbs-ticket-row-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dbs-ticket-row-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-ticket-row-sql { font-family: var(--dbs-mono); font-size: 11px; color: var(--dbs-ink-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-ticket-row-meta { font-size: 10.5px; color: var(--dbs-ink-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-ticket-row-est { font-size: 10.5px; color: var(--dbs-ink-3); }
.dbs-ticket-detail-inner { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 14px; }
.dbs-ticket-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbs-ticket-detail-title { font-size: 13.5px; font-weight: 600; }
.dbs-ticket-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbs-btn.is-danger { color: var(--dbs-danger); border-color: color-mix(in srgb, var(--dbs-danger) 40%, transparent); }
.dbs-btn.is-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dbs-danger) 10%, transparent); }
.dbs-ticket-meta { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-bg); }
.dbs-meta-row { display: flex; gap: 10px; font-size: 11.5px; padding: 1px 0; }
.dbs-meta-key { flex: none; width: 78px; color: var(--dbs-ink-4); }
.dbs-meta-value { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--dbs-ink-2); }
.dbs-ticket-label { flex: none; }
.dbs-ticket-background { font-size: 12px; line-height: 19px; color: var(--dbs-ink-2); padding: 6px 8px;
  border: 1px dashed var(--dbs-line-strong); border-radius: var(--dbs-r-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.dbs-ticket-sql-head { display: flex; align-items: center; gap: 8px; }
.dbs-ticket-sql { border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); max-height: 480px; min-height: 160px;
  background: var(--dbs-bg); flex-shrink: 0; }  /* 详情页是定高列向 flex：带 overflow 的子项会被 flex-shrink 压成一行，禁掉 + min-height 双保险 */
.dbs-ticket-estimated, .dbs-ticket-actual, .dbs-ticket-error, .dbs-ticket-timeline { display: flex; flex-direction: column; gap: 6px; }
.dbs-ticket-section-head { display: flex; align-items: center; gap: 6px; }
.dbs-ticket-stat-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dbs-stat { display: flex; flex-direction: column; gap: 1px; min-width: 110px; padding: 5px 9px;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-bg); }
.dbs-stat-label { font-size: 10.5px; color: var(--dbs-ink-4); }
.dbs-stat-value { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.dbs-ticket-statements .dbs-grid-wrap { max-height: 200px; border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); }
.dbs-ticket-notes { margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--dbs-ink-3); }
.dbs-ticket-notes li { margin: 1px 0; }
.dbs-ticket-unknown { font-size: 11.5px; color: var(--dbs-link); padding: 2px 0; }
.dbs-ticket-results .dbs-grid-wrap { max-height: 220px; border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); }
.dbs-timeline { display: flex; flex-direction: column; gap: 0; }
.dbs-timeline-item { display: flex; gap: 8px; position: relative; padding-bottom: 8px; }
.dbs-timeline-dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--dbs-ink-4); }
.dbs-timeline-dot.is-link { background: var(--dbs-link); }
.dbs-timeline-dot.is-danger { background: var(--dbs-danger); }
.dbs-timeline-dot.is-plain { background: var(--dbs-ink-4); }
.dbs-timeline-body { flex: 1; min-width: 0; border-left: 1px solid var(--dbs-line); margin-left: -4px; padding-left: 10px; }
.dbs-timeline-line { display: flex; align-items: baseline; gap: 8px; }
.dbs-timeline-label { font-size: 12px; color: var(--dbs-ink-2); }
.dbs-timeline-time { font-family: var(--dbs-mono); font-size: 10.5px; color: var(--dbs-ink-4); }
.dbs-timeline-detail { font-size: 11px; color: var(--dbs-ink-3); overflow-wrap: anywhere; }
.dbs-modal-text { font-size: 12.5px; line-height: 19px; color: var(--dbs-ink-2); }
.dbs-modal-sql { max-height: 280px; border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-bg); flex-shrink: 0; }
.dbs-modal-textarea { height: auto; min-height: 64px; padding: 6px 8px; resize: vertical; font-family: var(--dbs-font); line-height: 18px; }
/* 审批弹窗的影响面摘要（第 21 轮）：标题行 + 行数 + 精确/风险 Tag + 可展开逐条明细 */
.dbs-modal-impact { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-hover); }
.dbs-modal-impact-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbs-modal-impact-title { font-size: 11.5px; font-weight: 600; color: var(--dbs-ink-2); }
.dbs-modal-impact-rows { font-family: var(--dbs-mono); font-size: 12.5px; color: var(--dbs-ink); }
.dbs-modal-impact-warn { font-size: 11.5px; line-height: 17px; color: var(--dbs-danger); }
.dbs-modal-impact-toggle { align-self: flex-start; }
/* 会话写窗口条（V2.4）：关=中性，开=链接色 */
.dbs-window-bar { display: flex; align-items: center; gap: 8px; flex: none;
  padding: 4px 10px; border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm);
  background: var(--dbs-hover); }
.dbs-window-bar.is-open { border-color: color-mix(in srgb, var(--dbs-link) 40%, transparent);
  background: color-mix(in srgb, var(--dbs-link) 8%, transparent); }
.dbs-window-bar-label { font-size: 11.5px; font-weight: 600; color: var(--dbs-ink-2); }
.dbs-window-bar-state { font-size: 11.5px; color: var(--dbs-ink-3); }
/* 结构化工单 diff（V2.3）：统计行 + 分组明细表 */
.dbs-ticket-rowsdiff-wrap { display: flex; flex-direction: column; gap: 6px; }
.dbs-ticket-rowsdiff { display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); padding: 8px 10px;
  background: var(--dbs-hover); }
.dbs-ticket-rowsdiff-group { display: flex; flex-direction: column; gap: 4px; }
.dbs-notice { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 10px;
  border-radius: var(--dbs-r-sm); font-size: 12px;
  border: 1px solid var(--dbs-line-strong); background: var(--dbs-hover); color: var(--dbs-ink-2); }
.dbs-notice.is-ok { color: var(--dbs-link); border-color: color-mix(in srgb, var(--dbs-link) 40%, transparent);
  background: color-mix(in srgb, var(--dbs-link) 8%, transparent); }
.dbs-notice.is-bad { color: var(--dbs-danger); border-color: color-mix(in srgb, var(--dbs-danger) 40%, transparent);
  background: color-mix(in srgb, var(--dbs-danger) 8%, transparent); }
.dbs-notice > :first-child { flex: 1; min-width: 0; }
/* 提示统一可关（第 47 轮）：× 形关闭按钮，继承所在提示的色调，仅无障碍标注 */
.dbs-notice-close { flex: none; border: 0; background: transparent; color: inherit; opacity: .55;
  font-size: 13px; line-height: 1; padding: 1px 5px; border-radius: 4px; cursor: pointer; }
.dbs-notice-close:hover { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }

/* 执行历史 */
.dbs-history-filters { gap: 6px; }
.dbs-history-filters .dbs-input { max-width: 240px; }
.dbs-history-list-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }
.dbs-history-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.dbs-history-row { display: grid;
  grid-template-columns: 132px minmax(80px, 120px) 80px minmax(110px, 1fr) 56px 54px minmax(96px, auto) 62px 70px 92px;
  gap: 8px; align-items: center; width: 100%; padding: 5px 10px; font-size: 11.5px;
  color: var(--dbs-ink-2); border-bottom: 1px solid var(--dbs-line); text-align: left; }
.dbs-history-row:not(.is-head):hover { background: var(--dbs-hover); }
.dbs-history-row.is-on { background: var(--dbs-active); }
.dbs-history-row.is-head { color: var(--dbs-ink-4); font-size: 10.5px; background: var(--dbs-hover);
  position: sticky; top: 0; z-index: 1; }
.dbs-history-sql { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dbs-mono); font-size: 11px; }
.dbs-history-detail-pane { flex: none; width: 40%; min-width: 300px; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }
.dbs-history-detail { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 14px; }
.dbs-history-detail-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbs-history-detail-title { font-size: 13px; font-weight: 600; }

/* ================= 第 5 轮新增：连接脱敏模式 ================= */

.dbs-form-wide { grid-column: 1 / -1; min-width: 0; }
.dbs-masking { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--dbs-line); padding-top: 8px; margin-top: 2px; }
.dbs-masking-body { display: flex; flex-direction: column; gap: 8px; }
.dbs-masking-keywords { display: flex; flex-direction: column; gap: 3px; }
.dbs-masking-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-height: 30px; padding: 4px 6px;
  border: 1px solid var(--dbs-line-strong); border-radius: var(--dbs-r-sm); background: var(--dbs-layer); }
.dbs-masking-chip { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; }
.dbs-masking-chip-x { color: var(--dbs-ink-3); font-size: 12px; line-height: 14px; padding: 0 2px; }
.dbs-masking-chip-x:hover { color: var(--dbs-danger); }
.dbs-masking-keywords-empty { font-size: 11px; padding: 0 2px; }
.dbs-masking-keyword-input { flex: 1; min-width: 150px; height: 22px; border: 0; background: transparent; padding-left: 2px; }
.dbs-masking-keyword-input:focus { border: 0; }
.dbs-masking-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbs-masking-builtin { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-bg); }
.dbs-masking-policies { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }
.dbs-masking-policy { display: flex; align-items: flex-start; gap: 5px; font-size: 11px; color: var(--dbs-ink-3); }
.dbs-masking-policy.is-hit { color: var(--dbs-link); }
.dbs-masking-policy-name { flex: none; font-weight: 600; }
.dbs-masking-policy-state { min-width: 0; overflow-wrap: anywhere; }
.dbs-masking-review { display: flex; flex-direction: column; gap: 4px; }
.dbs-masking-review-head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dbs-ink-3); }
.dbs-masking-table { display: flex; flex-direction: column; border: 1px solid var(--dbs-line);
  border-radius: var(--dbs-r-sm); overflow: hidden; }
.dbs-masking-row { display: grid;
  grid-template-columns: 26px minmax(80px, 1fr) minmax(70px, 1fr) 78px minmax(110px, 1.6fr) 54px;
  gap: 6px; align-items: center; padding: 4px 8px; font-size: 11.5px; border-bottom: 1px solid var(--dbs-line); }
.dbs-masking-row:last-child { border-bottom: 0; }
.dbs-masking-row.is-head { color: var(--dbs-ink-4); font-size: 10.5px; background: var(--dbs-hover); }
.dbs-masking-row.is-mandatory { background: color-mix(in srgb, var(--dbs-link) 6%, transparent); }
.dbs-masking-check { gap: 2px; }
.dbs-masking-lock { display: inline-flex; color: var(--dbs-link); }
.dbs-masking-table-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-masking-reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-masking-empty { display: flex; flex-direction: column; gap: 2px; padding: 8px; font-size: 11.5px;
  color: var(--dbs-ink-3); border: 1px dashed var(--dbs-line-strong); border-radius: var(--dbs-r-sm); }
.dbs-mask-badge { display: inline-flex; align-items: center; gap: 3px; flex: none; font-size: 10px; line-height: 15px;
  padding: 0 5px; border-radius: 8px; color: var(--dbs-link);
  border: 1px solid color-mix(in srgb, var(--dbs-link) 45%, transparent); white-space: nowrap; }

/* ================= 第 6 轮：连接 tab 页 + 可拖拽结果区 ================= */

.dbs-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dbs-conn-tabs { flex: none; display: flex; align-items: stretch; padding-left: 4px;
  border-bottom: 1px solid var(--dbs-line); background: var(--dbs-bg); overflow: hidden; }
.dbs-conn-tabs-scroll { display: flex; align-items: stretch; gap: 2px; flex: 1; min-width: 0;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
.dbs-conn-tab { display: flex; align-items: center; flex: none; max-width: 240px; margin-top: 4px;
  border: 1px solid transparent; border-bottom: 0; border-radius: var(--dbs-r-sm) var(--dbs-r-sm) 0 0; }
.dbs-conn-tab:hover { background: var(--dbs-hover); }
.dbs-conn-tab.is-on { background: var(--dbs-layer); border-color: var(--dbs-line); }
.dbs-conn-tab-label { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 5px 4px 5px 9px;
  font-size: 11.5px; color: var(--dbs-ink-3); }
.dbs-conn-tab.is-on .dbs-conn-tab-label { color: var(--dbs-ink); font-weight: 600; }
.dbs-conn-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-conn-tab-badge { flex: none; font-size: 9.5px; line-height: 14px; padding: 0 4px; border-radius: 7px;
  color: var(--dbs-ink-3); background: var(--dbs-hover); }
.dbs-conn-tab-close { flex: none; width: 18px; height: 20px; line-height: 18px; text-align: center;
  border-radius: 5px; color: var(--dbs-ink-4); font-size: 13px; }
.dbs-conn-tab-close:hover { background: var(--dbs-active); color: var(--dbs-danger); }
.dbs-tab-panes { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.dbs-tab-pane { display: none; flex: 1; min-height: 0; flex-direction: column; }
.dbs-tab-pane.is-active { display: flex; }

.dbs-workbench { flex: 1; min-height: 0; }
.dbs-workbench-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; overflow: hidden; }
.dbs-workbench-main.is-resizing, .dbs-workbench-main.is-resizing * { user-select: none; }
/* 编辑器区按分隔比例控高（第 34 轮，默认 6:4）：flexBasis 由 JS 内联写入，
   min-height 280px 保底编辑器可读（textarea ≈240px），结果区吃剩余空间（自身 min-height 140px 保底） */
.dbs-editor-region { flex: 0 0 auto; min-height: 280px; min-width: 0; display: flex; flex-direction: column; overflow: visible; }
.dbs-editor-region .dbs-editor-wrap { flex: 1; min-height: 0; }
.dbs-editor-region .dbs-editor { flex: 1; }
.dbs-splitter { flex: none; height: 7px; margin: 0 -1px; position: relative; display: flex;
  align-items: center; justify-content: center; cursor: row-resize; touch-action: none; }
.dbs-splitter::before { content: ''; position: absolute; left: 0; right: 0; top: 3px; height: 1px; background: var(--dbs-line); }
.dbs-splitter:hover::before, .dbs-splitter.is-resizing::before { top: 2px; height: 3px; border-radius: 2px; background: var(--dbs-link); }
.dbs-splitter-grip { position: relative; width: 30px; height: 3px; border-radius: 2px; background: var(--dbs-line-strong);
  opacity: 0; transition: opacity .12s ease; }
.dbs-splitter:hover .dbs-splitter-grip, .dbs-splitter.is-resizing .dbs-splitter-grip { opacity: 1; background: var(--dbs-link); }
.dbs-workbench-results { flex: 1; min-height: 140px; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.dbs-workbench-results .dbs-results { flex: 1; min-height: 0; }
.dbs-workbench-results .dbs-results-scroll { flex: 1; min-height: 0; }
/* 单结果：卡片撑满结果区，表格在卡片内部滚动（表头 sticky 相对 grid-wrap，不会压住结果 tab） */
.dbs-workbench .dbs-result-list { flex: 1; min-height: 0; }
.dbs-workbench .dbs-result-list > .dbs-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-workbench .dbs-result > .dbs-grid-wrap { flex: 1; min-height: 0; max-height: none; overflow: auto; }
/* 多结果集：结果面板撑满，当前结果页签的表格占满剩余高度并内部滚动 */
.dbs-workbench .dbs-result-panel { flex: 1; min-height: 0; }
.dbs-workbench .dbs-result-panel > .dbs-result-tab-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding-bottom: 0; }
.dbs-workbench .dbs-result-panel .dbs-grid-wrap { flex: 1; min-height: 0; max-height: none; overflow: auto; }
.dbs-workbench .dbs-grid-wrap { max-height: none; }

/* ================= 第 20 轮：查询页多 tab（本地缓存 / 打开保存 SQL 文件） ================= */

.dbs-query-workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-query-panes { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-query-tabs { flex: none; display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 4px;
  border-bottom: 1px solid var(--dbs-line); background: var(--dbs-bg); overflow: hidden; }
.dbs-query-tabs-scroll { display: flex; align-items: stretch; gap: 2px; flex: 1; min-width: 0;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
.dbs-query-tab { display: flex; align-items: center; flex: none; max-width: 200px;
  border: 1px solid transparent; border-radius: var(--dbs-r-sm); }
.dbs-query-tab:hover { background: var(--dbs-hover); }
.dbs-query-tab.is-on { background: var(--dbs-layer); border-color: var(--dbs-line); }
.dbs-query-tab-label { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 3px 3px 3px 8px;
  font-size: 11px; color: var(--dbs-ink-3); }
.dbs-query-tab.is-on .dbs-query-tab-label { color: var(--dbs-ink); font-weight: 600; }
.dbs-query-tab.is-file .dbs-query-tab-label svg { color: var(--dbs-link); }
.dbs-query-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-query-tab-close { flex: none; width: 16px; height: 18px; line-height: 16px; text-align: center;
  border-radius: 5px; color: var(--dbs-ink-4); font-size: 12px; }
.dbs-query-tab-close:hover { background: var(--dbs-active); color: var(--dbs-danger); }
.dbs-query-tab-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.dbs-query-tab-actions .dbs-iconbtn { width: 22px; height: 20px; }
.dbs-query-note { flex: none; display: inline-flex; align-items: center; gap: 2px; max-width: 260px;
  font-size: 10.5px; color: var(--dbs-link); }
.dbs-query-note > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-file-input { position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 0;
  border: 0; padding: 0; pointer-events: none; }  /* 不能 display:none：部分内嵌 webview 会忽略其程序化 click */
.dbs-workbench.is-hidden { display: none; }

/* ================= 第 9 轮：脱敏策略树（连接 → 库 → 表 → 字段） ================= */

.dbs-policy-mask { position: absolute; inset: 0; z-index: 70; background: var(--dbs-bg); display: flex; }
.dbs-policy { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--dbs-bg); }
.dbs-policy-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--dbs-line); }
.dbs-policy-title { font-size: 12.5px; font-weight: 600; color: var(--dbs-ink); }
.dbs-policy-conn-title { font-size: 11.5px; color: var(--dbs-ink-3); }
.dbs-policy-layout { flex: 1; min-height: 0; display: flex; }
.dbs-policy-conns { flex: none; width: 168px; min-height: 0; overflow: auto; padding: 6px;
  border-right: 1px solid var(--dbs-line); display: flex; flex-direction: column; gap: 2px; }
.dbs-policy-conn { display: flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: var(--dbs-r-sm);
  font-size: 11.5px; color: var(--dbs-ink-3); text-align: left; }
.dbs-policy-conn:hover { background: var(--dbs-hover); color: var(--dbs-ink); }
.dbs-policy-conn.is-on { background: var(--dbs-active); color: var(--dbs-ink); font-weight: 600; }
.dbs-policy-conn-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dbs-policy-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dbs-policy-toolbar { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 10px; border-bottom: 1px solid var(--dbs-line); }
.dbs-policy-search { width: 210px; }
.dbs-policy-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 8px 10px;
  scrollbar-width: thin; scrollbar-color: var(--dbs-line-strong) transparent; }
.dbs-policy-row { display: flex; align-items: center; gap: 5px; min-height: 24px; font-size: 11.5px; color: var(--dbs-ink-2); }
.dbs-policy-row.is-conn { font-weight: 600; color: var(--dbs-ink); }
.dbs-policy-row.is-db { color: var(--dbs-ink-2); }
.dbs-policy-row.is-table { color: var(--dbs-ink-2); }
.dbs-policy-row.is-field { padding-left: 56px; gap: 8px; border-radius: 4px; padding-top: 1px; padding-bottom: 1px; }
.dbs-policy-row.is-field:hover { background: var(--dbs-hover); }
.dbs-policy-row.is-field.is-masked { background: color-mix(in srgb, var(--dbs-link) 5%, transparent); }
.dbs-policy-row.is-field.is-mandatory { background: color-mix(in srgb, var(--dbs-link) 9%, transparent); }
.dbs-policy-toggle { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
  color: var(--dbs-ink-4); flex: none; }
.dbs-policy-toggle.is-open { transform: rotate(90deg); }
.dbs-policy-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dbs-policy-field-name { flex: none; width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dbs-ink); }
.dbs-policy-field-comment { flex: 1; min-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dbs-ink-3); font-size: 11px; }
.dbs-policy-field-type { flex: none; width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; }
.dbs-policy-select { flex: none; display: flex; align-items: center; gap: 3px; width: 150px; }
.dbs-policy-select .dbs-select { width: 118px; }
.dbs-policy-lock { display: inline-flex; color: var(--dbs-link); flex: none; }
.dbs-policy-ai { flex: none; font-size: 9.5px; line-height: 14px; padding: 0 4px; border-radius: 7px;
  color: var(--dbs-link); background: color-mix(in srgb, var(--dbs-link) 12%, transparent); }
.dbs-policy-muted { padding: 4px 8px 4px 56px; font-size: 11px; color: var(--dbs-ink-4); }
.dbs-policy-pad { padding: 4px 8px; }
.dbs-policy-conn-state { font-size: 10.5px; font-weight: 400; }
.dbs-policy-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-top: 1px solid var(--dbs-line); }
.dbs-policy-page { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 12px; overflow: auto; }
.dbs-policy-filter { flex: 1; min-height: 0; overflow: auto; padding: 4px 8px 12px;
  scrollbar-width: thin; scrollbar-color: var(--dbs-line-strong) transparent; }
.dbs-policy-builtin { flex: none; display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  padding: 4px 10px; border-bottom: 1px solid var(--dbs-line); background: var(--dbs-bg); }
.dbs-policy-builtin-title { font-size: 10.5px; color: var(--dbs-ink-4); margin-right: 2px; }
.dbs-policy-builtin-chip { display: inline-flex; align-items: center; gap: 3px; font-size: 10px;
  line-height: 15px; padding: 0 5px; border-radius: 8px; color: var(--dbs-ink-3);
  border: 1px solid var(--dbs-line); background: var(--dbs-layer); }
.dbs-policy-filter-total { padding: 2px 0 6px; font-size: 11px; }
.dbs-policy-filter-group { margin-bottom: 6px; }
.dbs-policy-empty { padding: 14px 8px; font-size: 11.5px; color: var(--dbs-ink-3); text-align: center; }
.dbs-policy-residual { flex: none; font-size: 9.5px; line-height: 14px; padding: 0 4px; border-radius: 7px;
  color: var(--dbs-danger); background: color-mix(in srgb, var(--dbs-danger) 12%, transparent); }
.dbs-policy-ai-notice { flex: none; display: flex; align-items: flex-start; gap: 6px; padding: 5px 12px;
  border-bottom: 1px solid var(--dbs-line); background: var(--dbs-bg); font-size: 11px;
  color: var(--dbs-ink-3); overflow-wrap: anywhere; }
.dbs-ai-error { color: var(--dbs-danger); overflow-wrap: anywhere; }
.dbs-note.dbs-ai-notice { overflow-wrap: anywhere; }

/* ================= 第 18 轮：语义层视图（域 → 文件 → 可编辑正文） ================= */

.dbs-semantic { flex: 1; min-height: 0; display: flex; gap: 10px; }
.dbs-semantic-pane { flex: none; width: 176px; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }
.dbs-semantic-domains { width: 190px; }
.dbs-semantic-files { width: 226px; }
.dbs-semantic-head-actions { display: inline-flex; align-items: center; gap: 4px; }
.dbs-semantic-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.dbs-semantic-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px;
  border-bottom: 1px solid var(--dbs-line); font-size: 12px; color: var(--dbs-ink-2); text-align: left; }
.dbs-semantic-row:last-child { border-bottom: 0; }
.dbs-semantic-row:hover { background: var(--dbs-hover); }
.dbs-semantic-row.is-on { background: var(--dbs-active); color: var(--dbs-ink); }
.dbs-semantic-row.is-on svg { color: var(--dbs-link); }
.dbs-semantic-row-name { flex: 1; min-width: 0; font-family: var(--dbs-mono); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-semantic-row-sub { flex: none; font-size: 10px; color: var(--dbs-ink-4); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dbs-semantic-note { padding: 10px; font-size: 11.5px; color: var(--dbs-ink-4); }
.dbs-semantic-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); overflow: hidden; background: var(--dbs-layer); }

/* 文件行 + 内联标题树（第 52 轮：正文区顶部的小节 chips 挪到文件名下方，缩进按 level 1-4） */
.dbs-semantic-file-group { display: flex; flex-direction: column; }
.dbs-semantic-toc { display: flex; flex-direction: column; padding: 2px 0 6px 8px;
  border-bottom: 1px solid var(--dbs-line); background: var(--dbs-hover); }
.dbs-semantic-toc-item { display: block; width: 100%; padding: 2px 8px; border: 0; background: transparent;
  border-radius: var(--dbs-r-sm); font-size: 11px; line-height: 17px; color: var(--dbs-ink-3);
  text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbs-semantic-toc-item:hover { background: var(--dbs-active); color: var(--dbs-ink); }
.dbs-semantic-toc-item.is-on { background: var(--dbs-active); color: var(--dbs-link); font-weight: 500; }
.dbs-semantic-toc-item.is-level-1 { padding-left: 6px; font-weight: 600; color: var(--dbs-ink-2); }
.dbs-semantic-toc-item.is-level-2 { padding-left: 16px; }
.dbs-semantic-toc-item.is-level-3 { padding-left: 26px; }
.dbs-semantic-toc-item.is-level-4 { padding-left: 36px; color: var(--dbs-ink-4); }

/* 可编辑正文（第 51 轮：<pre> 只读正文 → textarea 编辑器） */
.dbs-semantic-editor-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dbs-semantic-editor { flex: 1; min-height: 160px; width: 100%; margin: 0; padding: 10px 12px 14px;
  border: 0; border-radius: 0; resize: none; background: transparent; color: var(--dbs-ink);
  font-family: var(--dbs-mono); font-size: 12px; line-height: 19px; tab-size: 2; }
.dbs-semantic-editor:focus { outline: none; box-shadow: inset 0 0 0 2px var(--dbs-ring); }
.dbs-semantic-editor::placeholder { color: var(--dbs-ink-4); }
.dbs-semantic-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  border-top: 1px solid var(--dbs-line); background: var(--dbs-hover); font-size: 11px; color: var(--dbs-ink-3); }
.dbs-semantic-foot-info { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dbs-semantic-dirty { flex: none; padding: 0 6px; border-radius: 9px; line-height: 17px;
  color: var(--dbs-warning); background: color-mix(in srgb, var(--dbs-warning) 14%, transparent); }
.dbs-semantic-save-state { flex: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-semantic-save-state.is-ok { color: var(--dbs-success); }
.dbs-semantic-save-state.is-warn { color: var(--dbs-warning); }
.dbs-semantic-save-state.is-bad { color: var(--dbs-danger); }
.dbs-semantic-conflict { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--dbs-line); font-size: 11.5px; color: var(--dbs-warning);
  background: color-mix(in srgb, var(--dbs-warning) 10%, transparent); }
.dbs-semantic-dialog-note { margin: 0; font-size: 11.5px; line-height: 17px; color: var(--dbs-ink-3); }

/* 关联数据表弹窗 */
.dbs-semantic-tables-bar { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.dbs-semantic-table-list { flex: 1; min-height: 120px; max-height: 320px; overflow: auto;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-bg); }
.dbs-semantic-table-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  border-bottom: 1px solid var(--dbs-line); font-size: 12px; color: var(--dbs-ink-2); cursor: pointer; }
.dbs-semantic-table-row:last-child { border-bottom: 0; }
.dbs-semantic-table-row:hover { background: var(--dbs-hover); }
.dbs-semantic-table-row input { accent-color: var(--dbs-accent); }
.dbs-semantic-table-name { flex: 1; min-width: 0; font-family: var(--dbs-mono); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbs-semantic-table-refs { flex: none; display: inline-flex; align-items: center; gap: 4px; }

/* AI 蒸馏弹窗：筛选条件对齐网格（第 52 轮：输入框底边同一水平线，hint 移到整行下方） */
.dbs-semantic-distill-head { display: grid; grid-template-columns: repeat(4, auto);
  align-items: end; justify-content: start; gap: 12px; }
.dbs-semantic-distill-head .dbs-field { min-width: 0; }
.dbs-semantic-distill-head .dbs-select, .dbs-semantic-distill-head .dbs-input { height: 26px; }
.dbs-semantic-distill-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
.dbs-semantic-cand { display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-bg); }
.dbs-semantic-cand input { margin-top: 3px; accent-color: var(--dbs-accent); }
.dbs-semantic-cand-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dbs-semantic-cand-q { font-size: 12px; color: var(--dbs-ink); }
.dbs-semantic-cand-sql { margin: 0; max-height: 120px; overflow: auto; padding: 6px 8px;
  border-radius: var(--dbs-r-sm); background: var(--dbs-hover); color: var(--dbs-ink-2);
  font-family: var(--dbs-mono); font-size: 11.5px; line-height: 17px;
  white-space: pre-wrap; word-break: break-word; }
.dbs-semantic-cand-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 10.5px; color: var(--dbs-ink-4); }

/* 窄一点时收窄左栏 */
@media (max-width: 900px) {
  .dbs-side { width: 232px; }
  .dbs-keys-pane { width: 240px; }
  .dbs-form-grid { grid-template-columns: 1fr; }
  .dbs-semantic { flex-direction: column; }
  .dbs-semantic-pane, .dbs-semantic-domains, .dbs-semantic-files { width: 100%; }
  .dbs-semantic-pane { max-height: 30%; }
  .dbs-semantic-main { flex: 1; }
}

/* ================= 第 10 轮：窄面板抽屉 / 侧栏模式（连接与元数据显隐） ================= */

/* 工具栏显隐开关的激活态 */
.dbs-head .dbs-iconbtn.is-on { color: var(--dbs-link); background: var(--dbs-active); }
.dbs-open-sidebar, .dbs-open-main { flex: none; }

/* 侧栏 tab 标题（注册到 sidebar.right.pane.tab.title 的组件用） */
.dbs-sidebar-tab-title { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
.dbs-sidebar-tab-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }

/* 侧栏模式的一句话提示（只在连接与元数据都收起时出现） */
.dbs-sidebar-hint { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 12px;
  border-bottom: 1px solid var(--dbs-line); font-size: 11px; color: var(--dbs-ink-4);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* 窄面板：左栏改为覆盖式抽屉（absolute + 遮罩），不挤压主区 */
.dbs-body.is-narrow { position: relative; }
.dbs-root.is-narrow .dbs-head { flex-wrap: wrap; row-gap: 6px; }
.dbs-root.is-narrow .dbs-nav { overflow-x: auto; scrollbar-width: thin; }
.dbs-root.is-narrow .dbs-drawer-mask { position: absolute; inset: 0; z-index: 50;
  background: var(--dsw-alias-bg-mask-1, color-mix(in srgb, CanvasText 24%, transparent)); }
.dbs-root.is-narrow .dbs-side.is-drawer { position: absolute; left: 0; top: 0; bottom: 0; z-index: 51;
  width: min(86%, 320px); max-width: 320px; border-right: 1px solid var(--dbs-line);
  background: var(--dbs-layer);
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px color-mix(in srgb, CanvasText 20%, transparent)); }
.dbs-drawer-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 7px 10px;
  border-bottom: 1px solid var(--dbs-line); }
.dbs-drawer-title { font-size: 12px; font-weight: 600; color: var(--dbs-ink); }
.dbs-drawer-close { flex: none; }

/* 侧栏模式：默认收起后的紧凑主区（纵向排布、结果区横向滚动、无横向溢出）。
   第 33 轮：分隔条恢复显示——手动调编辑器高度是明确需求，旧「隐藏拖拽条」是比例语义的产物 */
.dbs-root.is-sidebar .dbs-head { gap: 6px; padding: 8px 10px; }
.dbs-root.is-sidebar .dbs-title { font-size: 13px; }
.dbs-root.is-sidebar .dbs-nav { overflow-x: auto; scrollbar-width: thin; }
.dbs-root.is-sidebar .dbs-runbar { padding: 6px 8px; }
.dbs-root.is-sidebar .dbs-editor-wrap { padding: 6px 8px 4px; }
.dbs-root.is-sidebar .dbs-workbench-results { min-height: 120px; }
.dbs-root.is-sidebar .dbs-tabbar { overflow-x: auto; scrollbar-width: thin; }
.dbs-root.is-sidebar .dbs-tabbar > * { flex: none; }
.dbs-root.is-sidebar .dbs-result-tabs { overflow-x: auto; scrollbar-width: thin; }
.dbs-root.is-sidebar .dbs-result-tab-actions { flex-wrap: nowrap; }
.dbs-root.is-sidebar .dbs-content { overflow-x: hidden; }
.dbs-root.is-sidebar .dbs-keys-pane { width: 220px; }

/* ================= 第 19 轮：语义层目录配置 / 历史时间筛选·分页·EXPLAIN / 策略树原位展开 ================= */

/* 语义层：DB 写出路径行 + 没配路径时的 warn 提示（第 52 轮） */
.dbs-semantic-dir-wrap { flex: none; display: flex; flex-direction: column; gap: 4px; }
.dbs-semantic-dir { flex: none; display: flex; align-items: center; gap: 8px; }
.dbs-semantic-dir-label { flex: none; font-size: 11.5px; white-space: nowrap; }
.dbs-semantic-dir-input { flex: 1; min-width: 160px; max-width: 560px; font-family: var(--dbs-mono); }
.dbs-semantic-dir .dbs-btn { flex: none; }
.dbs-semantic-dir-warn { display: flex; align-items: flex-start; gap: 6px; padding: 4px 10px;
  border-radius: var(--dbs-r-sm); font-size: 11.5px; line-height: 17px; color: var(--dbs-warning);
  background: color-mix(in srgb, var(--dbs-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dbs-warning) 35%, transparent); overflow-wrap: anywhere; }

/* 历史：开始/结束日期筛选 */
.dbs-history-filters .dbs-input.is-date { flex: none; min-width: 0; width: 148px; max-width: none; }

/* 历史：列表底部翻页条 */
.dbs-history-page { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-top: 1px solid var(--dbs-line); background: var(--dbs-hover); }
.dbs-history-page-info { flex: 1; min-width: 0; text-align: right; font-size: 11px;
  color: var(--dbs-ink-3); font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 历史：详情 EXPLAIN 计划 */
.dbs-history-explain { display: flex; flex-direction: column; gap: 6px; }
.dbs-history-explain-block { display: flex; flex-direction: column; gap: 4px; }
.dbs-history-explain-stmt { font-size: 11px; color: var(--dbs-ink-3); }
.dbs-history-explain .dbs-grid-wrap { max-height: 200px; border: 1px solid var(--dbs-line);
  border-radius: var(--dbs-r-sm); }
.dbs-history-explain-error { margin: 0; padding: 6px 8px; white-space: pre-wrap; word-break: break-word;
  font-family: var(--dbs-mono); font-size: 11.5px; line-height: 17px; color: var(--dbs-danger);
  border: 1px solid color-mix(in srgb, var(--dbs-danger) 40%, transparent); border-radius: var(--dbs-r-sm);
  background: color-mix(in srgb, var(--dbs-danger) 6%, transparent); }

/* 脱敏策略：策略页直出策略树（无遮罩外壳，撑满页面剩余空间，内部自行滚动；连接切换在树内数据连接侧栏） */
.dbs-policy-inline { flex: 1; min-width: 0; min-height: 200px; display: flex; flex-direction: column;
  border: 1px solid var(--dbs-line); border-radius: var(--dbs-r-sm); background: var(--dbs-layer); overflow: hidden; }


/* ================= 第 40 轮样式改版：视觉层覆写 =================
   结构/布局规则一律沿用上方既有规则，本节只覆写「观感」：品牌主色、控件质感、
   层次阴影、动效与滚动条。深浅色仍完全跟随宿主 --dsw-alias-*（无本插件自切主题）。 */

.dbs-root {
  --dbs-accent: #3b74e0;                /* 品牌主色：浅深两底都够对比 */
  --dbs-accent-hover: color-mix(in srgb, #3b74e0 84%, #000000);
  --dbs-accent-ink: #ffffff;
  --dbs-accent-soft: color-mix(in srgb, #3b74e0 14%, transparent);
  --dbs-accent-softer: color-mix(in srgb, #3b74e0 7%, transparent);
  --dbs-success: #2e8a4d;
  --dbs-warning: #b97a12;
  --dbs-ring: color-mix(in srgb, #3b74e0 32%, transparent);
  --dbs-ease: background .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease;
}

/* 焦点环统一品牌色 */
.dbs-root :focus-visible { outline: 2px solid var(--dbs-accent); outline-offset: 1px; border-radius: var(--dbs-r-sm); }

/* 按钮：主按钮实心品牌色，次按钮层底描边，全部带过渡 */
.dbs-btn { height: 28px; padding: 0 12px; gap: 6px; font-weight: 500; background: var(--dbs-layer);
  transition: var(--dbs-ease); }
.dbs-btn:hover:not(:disabled) { background: var(--dbs-hover); border-color: var(--dbs-ink-4); }
.dbs-btn.is-primary { background: var(--dbs-accent); color: var(--dbs-accent-ink); border-color: transparent;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dbs-accent) 35%, transparent); }
.dbs-btn.is-primary:hover:not(:disabled) { background: var(--dbs-accent-hover); box-shadow: 0 2px 6px color-mix(in srgb, var(--dbs-accent) 30%, transparent); }
.dbs-btn.is-small { height: 26px; padding: 0 10px; }
.dbs-btn.is-ghost { background: transparent; }
.dbs-iconbtn { width: 26px; height: 26px; transition: var(--dbs-ease); }
.dbs-iconbtn.is-on { color: var(--dbs-accent); background: var(--dbs-accent-soft); }

/* 输入 / 下拉：聚焦品牌描边 + 光环 */
.dbs-input:focus, .dbs-select:focus { border-color: var(--dbs-accent); box-shadow: 0 0 0 3px var(--dbs-ring); }
.dbs-input, .dbs-select { transition: var(--dbs-ease); }

/* 头部：图标品牌色、标题加重 */
.dbs-head { padding: 10px 16px; gap: 10px; }
.dbs-head > svg:first-child { color: var(--dbs-accent); }
.dbs-title { font-size: 14.5px; font-weight: 700; letter-spacing: 0; }
.dbs-health.is-ready { color: var(--dbs-success); }
.dbs-health.is-ready .dbs-dot { background: var(--dbs-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dbs-success) 16%, transparent); }

/* 顶部导航：选中项品牌色加重，悬停有底 */
.dbs-nav { padding: 6px 14px; gap: 6px; background: var(--dbs-layer); }
.dbs-nav-item { padding: 6px 14px; font-weight: 500; border-radius: var(--dbs-r-sm); transition: var(--dbs-ease); }
.dbs-nav-item:hover { color: var(--dbs-ink); background: var(--dbs-hover); }
.dbs-nav-item.is-on { color: var(--dbs-accent-ink); background: var(--dbs-accent); font-weight: 600;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--dbs-accent) 40%, transparent); }
.dbs-nav-item.is-on .dbs-nav-badge { background: var(--dbs-accent-ink); color: var(--dbs-accent); }

/* 侧栏：选中行品牌化（soft 底 + 左侧 2px 品牌条），行悬停过渡 */
.dbs-conn, .dbs-tree-row, .dbs-key-row, .dbs-ticket-row { transition: var(--dbs-ease); }
.dbs-conn.is-on { background: var(--dbs-accent-soft); color: var(--dbs-ink); box-shadow: inset 2px 0 0 var(--dbs-accent); }
.dbs-conn.is-on svg, .dbs-tree-row.is-on svg { color: var(--dbs-accent); }
.dbs-tree-row.is-on { background: var(--dbs-accent-soft); color: var(--dbs-ink); }
.dbs-key-row.is-on { background: var(--dbs-accent-soft); color: var(--dbs-ink); }
.dbs-ticket-row.is-on { background: var(--dbs-accent-softer); }

/* 网格：表头小型大写字距、行悬停品牌 soft */
.dbs-grid th { padding: 6px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  background: var(--dbs-accent-soft); color: var(--dbs-accent); border-bottom-color: color-mix(in srgb, var(--dbs-accent) 35%, transparent); }
.dbs-grid td { padding: 5px 10px; }
.dbs-grid tbody tr:hover td { background: var(--dbs-accent-softer); }

/* 结果卡 / 面板卡：更大圆角 + 柔和阴影 */
.dbs-result { border-radius: var(--dbs-r-md); box-shadow: var(--dbs-shadow); }
.dbs-ticket-list-pane, .dbs-ticket-detail-pane { border-radius: var(--dbs-r-md); }

/* 页签：激活页签品牌色下划线 */
.dbs-result-tab { transition: var(--dbs-ease); }
.dbs-result-tab.is-on { color: var(--dbs-accent); border-color: var(--dbs-line-strong); box-shadow: inset 0 2px 0 var(--dbs-accent); font-weight: 600; }
.dbs-conn-tab { transition: var(--dbs-ease); }
.dbs-conn-tab.is-on { background: var(--dbs-accent-soft); border-color: color-mix(in srgb, var(--dbs-accent) 45%, transparent); box-shadow: none; }
.dbs-conn-tab.is-on .dbs-conn-tab-label { color: var(--dbs-accent); }
.dbs-query-tab { transition: var(--dbs-ease); }
.dbs-query-tab.is-on { background: var(--dbs-accent); color: var(--dbs-accent-ink); }
.dbs-query-tab.is-on .dbs-query-tab-label { color: var(--dbs-accent-ink); }

/* Tag / Chip：品牌化 */
.dbs-tag.is-link { color: var(--dbs-accent); border-color: color-mix(in srgb, var(--dbs-accent) 45%, transparent); background: var(--dbs-accent-softer); }
.dbs-tag.is-warn { color: var(--dbs-warning); border-color: color-mix(in srgb, var(--dbs-warning) 45%, transparent); }
.dbs-chip { transition: var(--dbs-ease); }
.dbs-chip:hover:not(:disabled) { border-color: var(--dbs-accent); color: var(--dbs-accent); }
.dbs-chip.is-on { background: var(--dbs-accent-soft); border-color: var(--dbs-accent); color: var(--dbs-accent); }

/* 编辑器：聚焦品牌描边 + 光环，关键词品牌色，光标品牌色，选区品牌色
   （选区 45% 起步：30% 时浅深主题下与编辑底色拉不开对比，命中/选中一眼找不到） */
.dbs-editor:focus { border-color: var(--dbs-accent); box-shadow: 0 0 0 3px var(--dbs-ring); }
.dbs-editor-text { caret-color: var(--dbs-accent); }
.dbs-editor-text::selection, .dbs-editor-highlight::selection { background: color-mix(in srgb, var(--dbs-accent) 45%, transparent); }
.dbs-token-kw { color: var(--dbs-accent); font-weight: 600; }
.dbs-editor-gutter { color: var(--dbs-ink-4); }

/* 补全弹层 / 菜单：选中项品牌化，阴影加深 */
.dbs-complete { border-radius: var(--dbs-r-md); box-shadow: 0 12px 32px color-mix(in srgb, CanvasText 20%, transparent); }
.dbs-complete-item { transition: var(--dbs-ease); }
.dbs-complete-item:hover, .dbs-complete-item.is-on { background: var(--dbs-accent-soft); color: var(--dbs-ink); }
.dbs-export-menu { border-radius: var(--dbs-r-md); box-shadow: 0 12px 32px color-mix(in srgb, CanvasText 20%, transparent); }

/* 弹窗：头部留白加大、标题加重 */
.dbs-modal { border-radius: var(--dbs-r-md); }
.dbs-modal-head { padding: 12px 14px; }
.dbs-modal-title { font-size: 14px; }

/* 状态点 / 加载 / 时间线：品牌色 */
.dbs-spinner { border-top-color: var(--dbs-accent); }
.dbs-timeline-dot.is-link { background: var(--dbs-accent); }

/* 滚动条：细圆角主题化 */
.dbs-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.dbs-root ::-webkit-scrollbar-track { background: transparent; }
.dbs-root ::-webkit-scrollbar-corner { background: transparent; }
.dbs-root ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dbs-ink-3) 32%, transparent);
  border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
.dbs-root ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--dbs-ink-3) 55%, transparent);
  border: 2px solid transparent; background-clip: padding-box; }
.dbs-root { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--dbs-ink-3) 32%, transparent) transparent; }


/* ---- 第 41 轮增补：一眼可见的品牌化 ---- */
/* 头部：品牌色横幅（白字），子控件全部反白适配 */
.dbs-head { background: linear-gradient(90deg, var(--dbs-accent), color-mix(in srgb, var(--dbs-accent) 78%, var(--dbs-bg)));
  color: var(--dbs-accent-ink); border-bottom-color: transparent; }
.dbs-head svg { color: var(--dbs-accent-ink); }
.dbs-head .dbs-title { color: var(--dbs-accent-ink); }
.dbs-head .dbs-health { color: color-mix(in srgb, var(--dbs-accent-ink) 82%, transparent); }
.dbs-head .dbs-health.is-ready { color: var(--dbs-accent-ink); }
.dbs-head .dbs-health.is-ready .dbs-dot { background: var(--dbs-accent-ink); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dbs-accent-ink) 22%, transparent); }
.dbs-head .dbs-health.is-down { color: var(--dbs-accent-ink); }
.dbs-head .dbs-tag { color: var(--dbs-accent-ink); border-color: color-mix(in srgb, var(--dbs-accent-ink) 45%, transparent); background: color-mix(in srgb, var(--dbs-accent-ink) 12%, transparent); }
.dbs-head .dbs-btn { background: color-mix(in srgb, var(--dbs-accent-ink) 14%, transparent);
  border-color: color-mix(in srgb, var(--dbs-accent-ink) 32%, transparent); color: var(--dbs-accent-ink); }
.dbs-head .dbs-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dbs-accent-ink) 26%, transparent);
  border-color: color-mix(in srgb, var(--dbs-accent-ink) 55%, transparent); }
/* 激活态统一白字（用户要求：右上角按钮不要蓝字）——用加深的白底 + 更强描边表达「已展开」 */
.dbs-head .dbs-btn.is-on { color: var(--dbs-accent-ink); background: color-mix(in srgb, var(--dbs-accent-ink) 30%, transparent);
  border-color: color-mix(in srgb, var(--dbs-accent-ink) 70%, transparent); }
.dbs-head .dbs-btn.is-on:hover:not(:disabled) { background: color-mix(in srgb, var(--dbs-accent-ink) 40%, transparent);
  border-color: var(--dbs-accent-ink); }
.dbs-head .dbs-iconbtn { color: var(--dbs-accent-ink); }
.dbs-head .dbs-iconbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--dbs-accent-ink) 18%, transparent); color: var(--dbs-accent-ink); }

/* 侧栏：色调底面（与主区形成层次，深浅色自适应） */
.dbs-side { background: color-mix(in srgb, var(--dbs-ink) 5%, var(--dbs-bg)); }

/* 结果页签栏：层底 + 激活页签白底卡片强化 */
.dbs-result-tabs { background: var(--dbs-layer); }

`
