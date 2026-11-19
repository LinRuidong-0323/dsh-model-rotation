window.__ModuleLoader__.load({
  id: '@local/dsh-model-rotation',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dshModelRotation'
    const API = '/api/model-rotation'

    // `settings.plugins.tab` is the slot the plugin settings section renders one
    // tab per entry from — it declares that slot as its child list and reads
    // `ctx.slots.entries('settings.plugins.tab')`. `plugins.item` is a different
    // slot (the shell's own cards), so registering there puts the card nowhere.
    const SLOT = 'settings.plugins.tab'

    let localeService = null

    const ZH = {
      'meta.title': '模型轮换',
      'meta.description': '把多个模型收成一条有序链，失败时自动降级。',
      'tab.title': '模型轮换',
      'intro': '每条链是一个可在模型选择器中直接选中的条目。链内顺序即优先级：靠前的先尝试，失败后降级到下一个。',
      'empty': '还没有配置任何链。',
      'addChain': '新增链',
      'chainName': '链名称',
      'enabled': '已启用',
      'disabled': '已停用',
      'remove': '删除',
      'up': '上移',
      'down': '下移',
      'moveHint': '点一行选中，再用 ↑↓ 连续调整',
      'moveSelected': '正在调整第 {position} 个',
      'routes': '模型顺序（按优先级）',
      'addRoute': '添加模型',
      'pickProvider': '选择渠道',
      'pickModel': '选择模型',
      'routeNote': '备注（可选，只给自己看，不会发给模型）',
      'save': '保存',
      'saved': '已保存',
      'saveFailed': '保存失败',
      'reload': '重新加载',
      'loading': '加载中…',
      'lastHit': '最近命中',
      'lastFailure': '最近失败',
      'noDiagnostics': '暂无记录',
      'inFlight': '进行中 {count} 个请求',
    }
    const EN = {
      'meta.title': 'Model rotation',
      'meta.description': 'Ordered model chains that fail over automatically.',
      'tab.title': 'Model rotation',
      'intro': 'Each chain is one entry in the model picker. Order inside a chain is priority: the first route is tried first, then the next on failure.',
      'empty': 'No chain configured yet.',
      'addChain': 'Add chain',
      'chainName': 'Chain name',
      'enabled': 'Enabled',
      'disabled': 'Disabled',
      'remove': 'Remove',
      'up': 'Move up',
      'down': 'Move down',
      'moveHint': 'Click a row, then use ↑↓ to move it',
      'moveSelected': 'Moving item {position}',
      'routes': 'Models in priority order',
      'addRoute': 'Add model',
      'pickProvider': 'Provider',
      'pickModel': 'Model',
      'routeNote': 'Note (optional, yours only, never sent to the model)',
      'save': 'Save',
      'saved': 'Saved',
      'saveFailed': 'Save failed',
      'reload': 'Reload',
      'loading': 'Loading…',
      'lastHit': 'Last hit',
      'lastFailure': 'Last failure',
      'noDiagnostics': 'Nothing recorded yet',
      'inFlight': '{count} request(s) in flight',
    }

    function t(key, vars) {
      if (localeService) {
        try {
          const text = localeService.bind(NS)(key, vars)
          if (text) return text
        } catch {
          // Fall through to the built-in text.
        }
      }
      const table = ZH[key] ?? EN[key] ?? key
      if (!vars) return table
      return table.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      )
    }

    const CSS = [
      '.dshMr{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}',
      '.dshMr-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}',
      '.dshMr-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}',
      '.dshMr-row{display:flex;align-items:center;gap:8px}',
      '.dshMr-grow{flex:1;min-width:0}',
      // `--dsw-alias-bg-l1` does not exist in this theme; the real layers are
      // bg-layer-1/2. A missing custom property resolves to nothing, which left
      // these controls with a transparent background.
      '.dshMr-input,.dshMr-select{font:inherit;font-size:13px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit}',
      '.dshMr-input{width:100%}',
      '.dshMr-btn{font:inherit;font-size:13px;padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer}',
      '.dshMr-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}',
      '.dshMr-btn:disabled{opacity:.45;cursor:default}',
      '.dshMr-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}',
      '.dshMr-btn[data-danger=true]{color:var(--dsw-alias-state-error-primary)}',
      '.dshMr-route{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;cursor:pointer}',
      '.dshMr-route:hover{border-color:var(--dsw-alias-label-tertiary)}',
      // The selected row must be distinguishable in BOTH themes. Background alone
      // is not enough: in the light theme every surface token resolves to #fff,
      // so a layer-2 background is invisible against the card. The brand-coloured
      // border and ring carry the signal, and the tint is mixed from the brand
      // colour so it stays visible whichever way the theme goes.
      '.dshMr-route[data-selected=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)}',
      '.dshMr-note{flex:1;min-width:80px;width:auto}',
      '.dshMr-move{gap:6px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}',
      '.dshMr-move[data-active=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, transparent)}',
      '.dshMr-label{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dshMr-move[data-active=true] .dshMr-label{color:var(--dsw-alias-label-primary)}',
      '.dshMr-diag{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-markdown-code-block-small)}',
      '.dshMr-msg{font-size:13px}',
      '.dshMr-msg[data-kind=error]{color:var(--dsw-alias-state-error-primary)}',
      // A checkbox styled as a switch. The input stays in the DOM for keyboard
      // and screen-reader access; only its track is drawn.
      '.dshMr-switch{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;position:relative}',
      '.dshMr-switch input{position:absolute;opacity:0;width:0;height:0}',
      '.dshMr-switch-track{position:relative;width:32px;height:18px;border-radius:9px;background:var(--dsw-alias-state-idle-primary);transition:background .15s;flex:none}',
      '.dshMr-switch-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}',
      '.dshMr-switch input:checked + .dshMr-switch-track{background:var(--dsw-alias-state-success-primary)}',
      '.dshMr-switch input:checked + .dshMr-switch-track .dshMr-switch-thumb{transform:translateX(14px)}',
      '.dshMr-switch input:focus-visible + .dshMr-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    ].join('')

    const STYLE_ID = 'dsh-model-rotation-styles'

    /** Fetch the current settings plus the provider catalog. */
    async function loadState() {
      const response = await fetch(API + '/state', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('state ' + response.status)
      return response.json()
    }

    /** Persist one settings document. */
    async function saveState(settings) {
      const response = await fetch(API + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'save ' + response.status)
      }
      return response.json()
    }

    /** Deep-copy the editable parts so React state never aliases the server's. */
    function cloneSettings(settings) {
      return {
        chains: (settings?.chains ?? []).map(chain => ({
          id: chain.id,
          name: chain.name,
          enabled: chain.enabled !== false,
          routes: (chain.routes ?? []).map(route => ({
            provider: route.provider,
            model: route.model,
            // A note is optional. Copying it as `undefined` would make the input
            // an uncontrolled component after the first keystroke, so a route
            // without one starts from the empty string.
            note: typeof route.note === 'string' ? route.note : '',
          })),
        })),
      }
    }

    /** Build a chain id that the store will accept. */
    function newChainId(existing) {
      let n = existing.length + 1
      const taken = new Set(existing.map(chain => chain.id))
      while (taken.has('chain-' + n)) n += 1
      return 'chain-' + n
    }

    /** Move one array element, returning a new array. */
    function moved(list, from, to) {
      if (to < 0 || to >= list.length) return list
      const next = list.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    }

    /**
     * Move the selected element one step and report where it landed.
     *
     * Returns the new index so the caller can keep the moved row selected: the
     * whole point of a move bar is that you can press it repeatedly without
     * hunting for the row again, and a selection that stayed on the old index
     * would silently start moving a different route.
     * @param {Array<object>} list - the routes.
     * @param {number} index - the selected index.
     * @param {number} direction - -1 up, +1 down.
     * @returns {{list: Array<object>, index: number}} new list and new index.
     */
    function step(list, index, direction) {
      const target = index + direction
      if (!Array.isArray(list) || index < 0 || index >= list.length) return { list, index }
      if (target < 0 || target >= list.length) return { list, index }
      return { list: moved(list, index, target), index: target }
    }

    function RotationCard() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // Which route row is selected for moving, as `chainIndex:routeIndex`.
      // Only one row is selected at a time: the move bar acts on the selection,
      // so two selected rows would make its target ambiguous.
      const [selected, setSelected] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const next = await loadState()
          setState(next)
          setDraft(cloneSettings(next.settings))
          setMessage(null)
        } catch (error) {
          setMessage({ kind: 'error', text: t('saveFailed') + ': ' + String(error.message ?? error) })
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      if (draft === null) {
        return h('div', { className: 'dshMr' }, h('p', { className: 'dshMr-intro' }, t('loading')))
      }

      const catalog = Array.isArray(state?.catalog) ? state.catalog : []
      const diagnostics = state?.diagnostics ?? {}

      /** Patch one chain by index. */
      const patchChain = (index, patch) => {
        setDraft(current => {
          const chains = current.chains.slice()
          chains[index] = { ...chains[index], ...patch }
          return { ...current, chains }
        })
      }

      /** Patch one route inside one chain. */
      const patchRoute = (chainIndex, routeIndex, patch) => {
        setDraft(current => {
          const chains = current.chains.slice()
          const chain = chains[chainIndex]
          const routes = chain.routes.slice()
          routes[routeIndex] = { ...routes[routeIndex], ...patch }
          chains[chainIndex] = { ...chain, routes }
          return { ...current, chains }
        })
      }

      const save = async () => {
        setBusy(true)
        try {
          const result = await saveState(draft)
          setState(current => ({ ...current, settings: result.settings }))
          setDraft(cloneSettings(result.settings))
          setMessage({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setMessage({ kind: 'error', text: t('saveFailed') + ': ' + String(error.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dshMr' },
        h('p', { className: 'dshMr-intro' }, t('intro')),

        // A non-zero in-flight count tells the user a request is running even
        // though only the newest hit is shown per chain.
        (diagnostics.inFlight ?? 0) > 0
          ? h('p', { className: 'dshMr-diag' }, t('inFlight', { count: diagnostics.inFlight }))
          : null,

        draft.chains.length === 0
          ? h('p', { className: 'dshMr-intro' }, t('empty'))
          : draft.chains.map((chain, chainIndex) =>
              h(
                'div',
                { className: 'dshMr-card', key: chain.id + ':' + chainIndex },
                h(
                  'div',
                  { className: 'dshMr-row' },
                  h('input', {
                    className: 'dshMr-input dshMr-grow',
                    value: chain.name,
                    placeholder: t('chainName'),
                    onChange: event => patchChain(chainIndex, { name: event.target.value }),
                  }),
                  h(
                    'label',
                    { className: 'dshMr-switch', title: chain.enabled ? t('enabled') : t('disabled') },
                    h('input', {
                      type: 'checkbox',
                      checked: chain.enabled,
                      onChange: event => patchChain(chainIndex, { enabled: event.target.checked }),
                    }),
                    h(
                      'span',
                      { className: 'dshMr-switch-track' },
                      h('span', { className: 'dshMr-switch-thumb' }),
                    ),
                    h('span', { className: 'dshMr-label' }, chain.enabled ? t('enabled') : t('disabled')),
                  ),
                  h(
                    'button',
                    {
                      className: 'dshMr-btn',
                      type: 'button',
                      disabled: chainIndex === 0,
                      title: t('up'),
                      onClick: () => setDraft(c => ({ ...c, chains: moved(c.chains, chainIndex, chainIndex - 1) })),
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      className: 'dshMr-btn',
                      type: 'button',
                      disabled: chainIndex === draft.chains.length - 1,
                      title: t('down'),
                      onClick: () => setDraft(c => ({ ...c, chains: moved(c.chains, chainIndex, chainIndex + 1) })),
                    },
                    '↓',
                  ),
                  h(
                    'button',
                    {
                      className: 'dshMr-btn',
                      type: 'button',
                      'data-danger': true,
                      title: t('remove'),
                      onClick: () =>
                        setDraft(c => ({ ...c, chains: c.chains.filter((_, i) => i !== chainIndex) })),
                    },
                    '✕',
                  ),
                ),

                h('div', { className: 'dshMr-label' }, t('routes')),

                chain.routes.map((route, routeIndex) => {
                  const group = catalog.find(entry => entry.id === route.provider)
                  const models = group?.models ?? []
                  const key = chainIndex + ':' + routeIndex
                  const isSelected = selected === key
                  return h(
                    'div',
                    {
                      className: 'dshMr-route',
                      key: route.provider + '/' + route.model + ':' + routeIndex,
                      'data-selected': isSelected,
                      // Clicking anywhere on the row selects it, except on a
                      // control: otherwise choosing a model would also move the
                      // selection, which is surprising mid-edit.
                      onClick: event => {
                        const tag = String(event?.target?.tagName ?? '').toLowerCase()
                        if (tag === 'select' || tag === 'option' || tag === 'input' || tag === 'button') return
                        setSelected(current => (current === key ? null : key))
                      },
                    },
                    h(
                      'div',
                      { className: 'dshMr-row' },
                      h(
                        'select',
                        {
                          className: 'dshMr-select dshMr-grow',
                          value: route.provider,
                          onChange: event => {
                            const provider = event.target.value
                            const first = catalog.find(entry => entry.id === provider)?.models?.[0]?.id ?? ''
                            patchRoute(chainIndex, routeIndex, { provider, model: first })
                          },
                        },
                        [
                          h('option', { value: '', key: '' }, t('pickProvider')),
                          ...catalog.map(entry => h('option', { value: entry.id, key: entry.id }, entry.name)),
                        ],
                      ),
                      h(
                        'select',
                        {
                          className: 'dshMr-select dshMr-grow',
                          value: route.model,
                          onChange: event => patchRoute(chainIndex, routeIndex, { model: event.target.value }),
                        },
                        [
                          h('option', { value: '', key: '' }, t('pickModel')),
                          ...models.map(model => h('option', { value: model.id, key: model.id }, model.name)),
                        ],
                      ),
                      // The note sits on the same line as the selectors and the
                      // remove button, so the row is one compact strip.
                      h('input', {
                        className: 'dshMr-input dshMr-note',
                        value: route.note ?? '',
                        placeholder: t('routeNote'),
                        maxLength: 200,
                        onChange: event => patchRoute(chainIndex, routeIndex, { note: event.target.value }),
                      }),
                      h(
                        'button',
                        {
                          className: 'dshMr-btn',
                          type: 'button',
                          'data-danger': true,
                          title: t('remove'),
                          onClick: () =>
                            patchChain(chainIndex, { routes: chain.routes.filter((_, i) => i !== routeIndex) }),
                        },
                        '✕',
                      ),
                    ),
                  )
                }),

                // The move bar. Reordering used to mean clicking an arrow on the
                // row, which reflows the list under the cursor and loses the row
                // you were moving. Acting on a selected row from a bar that does
                // not move lets you press repeatedly.
                chain.routes.length > 1
                  ? h(
                      'div',
                      {
                        className: 'dshMr-row dshMr-move',
                        // The bar tints while it owns a selection, so the user can
                        // see at a glance which chain the arrows will act on.
                        'data-active': selected !== null && selected.startsWith(chainIndex + ':'),
                      },
                      h(
                        'span',
                        { className: 'dshMr-label' },
                        selected !== null && selected.startsWith(chainIndex + ':')
                          ? t('moveSelected', { position: Number(selected.split(':')[1]) + 1 })
                          : t('moveHint'),
                      ),
                      h('div', { className: 'dshMr-grow' }),
                      h(
                        'button',
                        {
                          className: 'dshMr-btn',
                          type: 'button',
                          disabled: selected === null || !selected.startsWith(chainIndex + ':') ||
                            Number(selected.split(':')[1]) === 0,
                          title: t('up'),
                          onClick: () => {
                            if (selected === null) return
                            const index = Number(selected.split(':')[1])
                            setDraft(current => {
                              const chains = current.chains.slice()
                              const chainNow = chains[chainIndex]
                              const result = step(chainNow.routes, index, -1)
                              chains[chainIndex] = { ...chainNow, routes: result.list }
                              return { ...current, chains }
                            })
                            // Follow the moved route so the next press keeps
                            // acting on the same model rather than the one that
                            // slid into the old slot.
                            const index2 = Number(selected.split(':')[1])
                            if (index2 > 0) setSelected(chainIndex + ':' + (index2 - 1))
                          },
                        },
                        '↑',
                      ),
                      h(
                        'button',
                        {
                          className: 'dshMr-btn',
                          type: 'button',
                          disabled: selected === null || !selected.startsWith(chainIndex + ':') ||
                            Number(selected.split(':')[1]) === chain.routes.length - 1,
                          title: t('down'),
                          onClick: () => {
                            if (selected === null) return
                            const index = Number(selected.split(':')[1])
                            setDraft(current => {
                              const chains = current.chains.slice()
                              const chainNow = chains[chainIndex]
                              const result = step(chainNow.routes, index, 1)
                              chains[chainIndex] = { ...chainNow, routes: result.list }
                              return { ...current, chains }
                            })
                            const index2 = Number(selected.split(':')[1])
                            if (index2 < chain.routes.length - 1) setSelected(chainIndex + ':' + (index2 + 1))
                          },
                        },
                        '↓',
                      ),
                    )
                  : null,

                h(
                  'button',
                  {
                    className: 'dshMr-btn',
                    type: 'button',
                    onClick: () => patchChain(chainIndex, { routes: [...chain.routes, { provider: '', model: '' }] }),
                  },
                  t('addRoute'),
                ),

                diagnostics.lastHit?.[chain.id]
                  ? h(
                      'div',
                      { className: 'dshMr-diag' },
                      t('lastHit') + ': ' + diagnostics.lastHit[chain.id].provider + '/' + diagnostics.lastHit[chain.id].model,
                    )
                  : null,
                diagnostics.lastFailure?.[chain.id]
                  ? h('div', { className: 'dshMr-diag' }, t('lastFailure') + ': ' + diagnostics.lastFailure[chain.id].summary)
                  : null,
              ),
            ),

        h(
          'div',
          { className: 'dshMr-row' },
          h(
            'button',
            {
              className: 'dshMr-btn',
              type: 'button',
              onClick: () =>
                setDraft(current => ({
                  ...current,
                  chains: [
                    ...current.chains,
                    { id: newChainId(current.chains), name: 'Chain ' + (current.chains.length + 1), enabled: true, routes: [] },
                  ],
                })),
            },
            t('addChain'),
          ),
          h('div', { className: 'dshMr-grow' }),
          h('button', { className: 'dshMr-btn', type: 'button', onClick: () => void refresh() }, t('reload')),
          h(
            'button',
            { className: 'dshMr-btn', type: 'button', 'data-primary': true, disabled: busy, onClick: () => void save() },
            t('save'),
          ),
        ),

        message ? h('p', { className: 'dshMr-msg', 'data-kind': message.kind }, message.text) : null,
      )
    }

    function apply(ctx) {
      localeService = ctx.get('locale') ?? null

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const existing = document.getElementById(STYLE_ID)
        if (existing) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'dsh-model-rotation: styles')

      if (localeService) {
        try {
          ctx.effect(() => localeService.register(NS, { zh: ZH, en: EN }), 'dsh-model-rotation: dictionaries')
        } catch (error) {
          console.warn('[dsh-model-rotation] locale registration failed', error)
        }
      }

      // A list slot is addressed by `id`; the section reads `entry.options.id`
      // and `entry.options.label` when it builds the tab strip.
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'model-rotation',
            order: 50,
            label: () => t('meta.title'),
            locale: NS,
          },
          RotationCard,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply,
      __test: { cloneSettings, moved, newChainId, step },
    }
  },
})
