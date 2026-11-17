
    // ======================================================================
    // 5. 数据拉取 hook：AbortController 取消 + 手动 reload
    // ======================================================================

    /**
     * @param {(signal:AbortSignal)=>Promise<any>} loader
     * @param {any[]} deps
     */
    function useAsync(loader, deps) {
      const loaderRef = useRef(loader)
      loaderRef.current = loader
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const controller = new AbortController()
        let alive = true
        setState(previous => ({ loading: true, data: previous.data, error: null }))
        Promise.resolve()
          .then(() => loaderRef.current(controller.signal))
          .then(
            data => {
              if (alive) setState({ loading: false, data, error: null })
            },
            error => {
              if (alive && !isAbort(error)) setState({ loading: false, data: null, error })
            },
          )
        return () => {
          alive = false
          controller.abort()
        }
      }, deps.concat([tick]))
      const reload = useCallback(() => setTick(value => value + 1), [])
      return { loading: state.loading, data: state.data, error: state.error, reload }
    }
