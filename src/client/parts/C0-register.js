
    // ======================================================================
    // 14. 注册：主面板 / 左侧栏入口 / 右侧边栏 tab 类型与两个 keyed 槽
    //     （所有注册都在 ctx.effect 里，卸载时统一回收）
    // ======================================================================

    // 右栏 tab 类型的注册 id（同时是 body/title 两个 keyed 槽的 key）与 kind。
    // id 必须全局唯一，用包名最稳；kind 是打开 tab 时用的判别符。
    const SIDEBAR_TAB_ID = 'dsh-db-studio'
    const SIDEBAR_TAB_KIND = 'db-studio'
    // “切回会话 → 右侧栏 seat 挂载/adopt”是异步的，openTab 首次会同步抛错，
    // 用短轮询重试（上限约 2s），成功即停。
    const SIDEBAR_OPEN_RETRY_MS = 50
    const SIDEBAR_OPEN_RETRY_LIMIT = 40

    // 组件只回调外壳动作，真正的 ctx 调用都在 apply 闭包里（组件不碰 ctx）。
    let panelShell = null

    function mainPanelShell() {
      return panelShell && panelShell.main ? panelShell.main : null
    }

    function sidebarPanelShell() {
      return panelShell && panelShell.sidebar ? panelShell.sidebar : null
    }

    /** main keyed 槽（key=db-studio）：中央全局面板，行为保持现状 + 可请求在右栏打开。 */
    function MainPanelSlot(props) {
      return h(Panel, Object.assign({}, props, { mode: 'main', shell: mainPanelShell() }))
    }

    /** sidebar.right.pane.tab 槽：同一套 Panel 的右侧边栏窄布局版本。 */
    function SidebarTabBody(props) {
      return h(Panel, Object.assign({}, props, { mode: 'sidebar', shell: sidebarPanelShell() }))
    }

    /** sidebar.right.pane.tab.title 槽：tab 标题（图标 + 文案）。 */
    function SidebarTabTitle() {
      return h('span', { className: 'dbs-sidebar-tab-title' },
        h(Icon, { name: 'database', size: 13 }),
        h('span', { className: 'dbs-sidebar-tab-title-text' }, t('panel.sidebarTabTitle')))
    }

    /**
     * 在右侧边栏打开数据管理 tab。
     * 全局面板（main key）选中时会话不渲染、右栏 seat 不挂载 → openTab 会抛
     * `sidebarRight: no session surface is mounted`；先切回会话再轮询重试。
     * @param {object} ctx Client 上下文（sidebarRight / layout 已在 inject 里）
     */
    function openSidebarTabWhenReady(ctx) {
      try {
        ctx.layout.selectPanel(null)
      } catch (error) {
        // 没有可切换的会话时保持现状，下面的重试会兜底失败并记录原因
      }
      let attempts = 0
      const attempt = () => {
        attempts += 1
        try {
          ctx.sidebarRight.openTab(SIDEBAR_TAB_KIND)
        } catch (error) {
          if (attempts < SIDEBAR_OPEN_RETRY_LIMIT) {
            setTimeout(attempt, SIDEBAR_OPEN_RETRY_MS)
            return
          }
          if (typeof console !== 'undefined' && console.warn) {
            const reason = error && error.message ? error.message : String(error)
            console.warn('[dsh-db-studio] 无法在右侧边栏打开数据管理：' + reason)
          }
        }
      }
      attempt()
    }

    const plugin = {
      inject: ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        panelShell = {
          main: {
            openInSidebar: () => openSidebarTabWhenReady(ctx),
          },
          sidebar: {
            openInMain: () => {
              try {
                ctx.layout.selectPanel(PANEL_KEY)
              } catch (error) {
                if (typeof console !== 'undefined' && console.warn) {
                  console.warn('[dsh-db-studio] 无法切回主面板：' + (error && error.message ? error.message : error))
                }
              }
            },
          },
        }

        ctx.effect(() => {
          // 1) tab 类型：id/kind/title/guide 卡片。省略 priority = extension（最高 band），
          //    不设 multiple（每个会话同一 pane 内只有一个数据管理 tab）。
          const disposeTabType = ctx.sidebarRightTabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_TAB_KIND,
            title: () => t('panel.sidebarTabTitle'),
            guide: [{
              id: 'open',
              order: 30,
              title: () => t('panel.guideTitle'),
              description: () => t('panel.guideDescription'),
              icon: SidebarIcon,
            }],
          })

          // 2) tab body / title：右侧边栏的 keyed 槽，key 必须等于注册的 id。
          const disposeTabBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: SIDEBAR_TAB_ID,
          }, SidebarTabBody))
          const disposeTabTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: SIDEBAR_TAB_ID,
          }, SidebarTabTitle))

          // 3) 原有入口：中央全局面板 + 左侧栏「数据管理」。
          const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_KEY,
          }, MainPanelSlot))
          const disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 6,
            label: () => t('app.title'),
          }, SidebarIcon))

          return () => {
            if (typeof disposeMain === 'function') disposeMain()
            if (typeof disposeSidebar === 'function') disposeSidebar()
            if (typeof disposeTabBody === 'function') disposeTabBody()
            if (typeof disposeTabTitle === 'function') disposeTabTitle()
            if (typeof disposeTabType === 'function') disposeTabType()
            panelShell = null
          }
        }, 'dsh-db-studio: 数据管理面板与左侧栏入口')

        // 插件卸载时关掉自己打开的右栏 tab（无 seat/未 adopt 的会话是 no-op）。
        ctx.effect(() => () => {
          try {
            const openTabs = ctx.sidebarRight.openTabs.getSnapshot()
            if (!Array.isArray(openTabs)) return
            openTabs.forEach(tab => {
              if (!tab || tab.kind !== SIDEBAR_TAB_KIND || !tab.sessionId) return
              try {
                ctx.sidebarRight.closeIn(tab.sessionId, tab.tabId)
              } catch (error) {
                // 单个 tab 清理失败不影响其它会话
              }
            })
          } catch (error) {
            // 右栏服务已拆或从未挂载：无需清理
          }
        }, 'dsh-db-studio: 右侧边栏 tab 清理')
      },
    }
