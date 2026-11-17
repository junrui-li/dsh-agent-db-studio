
    // ======================================================================
    // 5.5 面板外壳：宽度测量 / 窄布局 / 连接与元数据显隐偏好
    // ======================================================================

    const LAYOUT_STORAGE_KEY = 'dsh-agent-db-studio:layout'
    /** 面板宽度小于该值时视为窄布局（连接与元数据默认收起）。 */
    const NARROW_WIDTH = 720
    /** 测不到面板宽度时的窗口兜底值（SSR / 无 window 环境）。 */
    const VIEWPORT_FALLBACK_WIDTH = 1200

    /** 当前窗口宽度；无 window / 宽度非法时回退 1200。 */
    function viewportWidth() {
      const scope = typeof window === 'undefined' ? null : window
      const width = scope && typeof scope.innerWidth === 'number' ? scope.innerWidth : 0
      return width > 0 ? width : VIEWPORT_FALLBACK_WIDTH
    }

    /** 量一个 DOM 节点宽度：getBoundingClientRect → offsetWidth → clientWidth，失败返回 0。 */
    function measureElementWidth(node) {
      if (!node) return 0
      try {
        if (typeof node.getBoundingClientRect === 'function') {
          const rect = node.getBoundingClientRect()
          const width = rect && typeof rect.width === 'number' ? rect.width : 0
          if (width > 0) return Math.round(width)
        }
        if (typeof node.offsetWidth === 'number' && node.offsetWidth > 0) {
          return Math.round(node.offsetWidth)
        }
        if (typeof node.clientWidth === 'number' && node.clientWidth > 0) {
          return Math.round(node.clientWidth)
        }
      } catch (error) {
        /* 尺寸测量失败按「未测到」处理 */
      }
      return 0
    }

    /**
     * 监听 ref 元素宽度。首帧为 0（由调用方回退窗口宽度），挂载后先同步量一次，
     * 之后由 ResizeObserver 持续更新；无 ResizeObserver 的环境保持回退宽度。
     */
    function useElementWidth(ref) {
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const node = ref.current
        const initial = measureElementWidth(node)
        if (initial > 0) setWidth(initial)
        if (!node || typeof ResizeObserver === 'undefined') return undefined
        let observer = null
        try {
          observer = new ResizeObserver(entries => {
            const list = entries || []
            for (let index = 0; index < list.length; index += 1) {
              const entry = list[index] || {}
              const content = entry.contentRect || {}
              const next = typeof content.width === 'number' && content.width > 0
                ? Math.round(content.width)
                : measureElementWidth(entry.target || node)
              if (next > 0) {
                setWidth(previous => (previous === next ? previous : next))
                break
              }
            }
          })
          observer.observe(node)
        } catch (error) {
          observer = null
        }
        return () => {
          try {
            if (observer) observer.disconnect()
          } catch (error) {
            /* 断开失败忽略 */
          }
        }
      }, [ref])
      return width > 0 ? width : viewportWidth()
    }

    /** 读持久化布局偏好；缺省/非法/无 localStorage 时返回 null（= 跟随宽度自动默认）。 */
    function readStoredLayout() {
      const result = { showSide: null }
      if (typeof localStorage === 'undefined') return result
      try {
        const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
        if (!raw) return result
        const parsed = JSON.parse(String(raw))
        if (parsed && typeof parsed.showSide === 'boolean') {
          result.showSide = parsed.showSide
          return result
        }
        // 旧版偏好 {showConnections, showMeta} 兼容读取：任一显式项为 true 即视为展开左栏，
        // 两项都显式 false 才视为收起；读后由下一次写入迁移成 {showSide}。
        if (parsed && (typeof parsed.showConnections === 'boolean' || typeof parsed.showMeta === 'boolean')) {
          result.showSide = parsed.showConnections === true || parsed.showMeta === true
        }
      } catch (error) {
        /* 坏 JSON / 隐私模式：静默降级为自动默认 */
      }
      return result
    }

    /** 写布局偏好：形状固定 {showSide:boolean}。 */
    function writeStoredLayout(value) {
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
          showSide: Boolean(value && value.showSide),
        }))
      } catch (error) {
        /* 配额满 / 隐私模式：静默降级为仅本会话生效 */
      }
    }

    /**
     * 面板布局状态：
     * - narrow：侧栏模式恒为 true，否则宽度 < NARROW_WIDTH；
     * - 左栏（连接 + 元数据）是一个整体：没手动设置过时跟随宽度自动默认（narrow → 收起，宽 → 展开），
     *   点过工具栏「连接与元数据」开关后变成显式选择并持久化。
     * rootRef 必须挂到最外层 .dbs-root 上。
     */
    function usePanelLayout(mode) {
      const rootRef = useRef(null)
      const width = useElementWidth(rootRef)
      const narrow = mode === 'sidebar' || width < NARROW_WIDTH
      const [prefs, setPrefs] = useState(readStoredLayout)

      const hasExplicitPrefs = prefs.showSide !== null
      const showSide = prefs.showSide === null ? !narrow : prefs.showSide

      const toggleSide = useCallback(() => {
        setPrefs(previous => ({
          showSide: !(previous.showSide === null ? !narrow : previous.showSide),
        }))
      }, [narrow])

      // 用户点过开关后才写 localStorage（形状固定为 {showSide}）
      useEffect(() => {
        if (!hasExplicitPrefs) return
        writeStoredLayout({ showSide })
      }, [hasExplicitPrefs, showSide])

      return { rootRef, narrow, showSide, toggleSide }
    }
