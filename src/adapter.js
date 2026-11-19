/**
 * The rotation adapter.
 *
 * Each configured chain becomes a *virtual model* under the `model-rotation`
 * route. Selecting it sends `{provider: 'model-rotation', model: '<chain id>'}`;
 * the adapter resolves that id to an ordered list of real routes and walks it.
 *
 * Three properties drive the design:
 *
 * 1. **The request body survives the hop.** The registry projects
 *    `options.messages` before dispatch, so a forwarded request that drops
 *    messages, tools or the system prompt crashes the projection. Controls
 *    (provider, model, sampling) come from `prepared.config` because the
 *    registry fills defaults during preparation and validates against them.
 * 2. **Nothing partial leaks.** Chunks are buffered until the first
 *    reader-visible one; a route that dies before that is abandoned silently.
 * 3. **The turn ends exactly once.** Every path out of `#stream` yields exactly
 *    one terminal `finish`, so the loop sees either a real answer or one error
 *    naming every route it tried.
 *
 * @module adapter
 */
import { classifyUnfinishedStream, codeOf, describe, runAttempt } from './attempt.js'
import { requirementsOf, routeCanServe } from './capability.js'
import { ROUTER_PROVIDER } from './config.js'
import { buildChain, shouldFailover } from './chain.js'
import { CooldownTable } from './cooldown.js'

/** How long resolved model metadata is reused, in milliseconds. */
const INFO_TTL_MS = 30_000

/** Ceiling on one metadata lookup. A timeout degrades to "unknown". */
const INFO_TIMEOUT_MS = 8_000

/**
 * Default idle timeout for one route attempt, in milliseconds.
 *
 * Only reached when a caller does not supply its own; the adapter's own
 * watchdog exists because a provider that stops producing must not hold the
 * turn forever.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000

/** Pause between attempts, multiplied by the attempt index. */
const RETRY_PAUSE_MS = 120

/** Sleep that settles early when the turn is cancelled. */
function delay(ms, signal) {
  if (signal?.aborted === true || ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/** Reject when `promise` outlives `ms`, without leaving a timer behind. */
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * The adapter handed to `ctx.llm.registerAdapter()`.
 *
 * It implements the structural contract the LLM registry consumes:
 * `providerInfo`, `providerRetryPolicy`, `imageRequestPricing`,
 * `imageRequestTarget`, `listModels`, `resolveModel`, and `prepareCall`.
 */
export class RotationAdapter {
  /** @type {import('./config.js').SettingsStore} */
  #store
  /** @type {object} */
  #log
  /** @type {object | undefined} */
  ctx
  /** @type {Map<string, {at: number, info: object | undefined}>} */
  #info = new Map()
  /** @type {{onSwitch?: (event: object) => void, onFailure?: (event: object) => void}} */
  #hooks
  /** @type {CooldownTable} */
  #cooldown
  /** @type {import('./request-log.js').RequestLog | undefined} */
  #requestLog

  /**
   * @param {{store: import('./config.js').SettingsStore, logger?: object, hooks?: object, cooldown?: CooldownTable, requestLog?: object}} options
   */
  constructor({ store, logger, hooks, cooldown, requestLog }) {
    this.#store = store
    this.#log = logger ?? {}
    this.#hooks = hooks ?? {}
    this.#cooldown = cooldown ?? new CooldownTable()
    this.#requestLog = requestLog
  }

  /**
   * Describe the route. The name is the picker's group heading.
   * @param {string} provider - the registered route.
   * @returns {{id: string, name: string}} detached provider metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: '模型轮换' }
  }

  /**
   * No provider-level retry policy.
   *
   * The adapter retries *across routes* itself, which the agent-level retry
   * executor cannot do. Declaring a policy here would make one failed turn look
   * like several independent failures, and would stack the host's retry loop on
   * top of this one. `dsh-llm-retry` therefore only sees a turn this adapter has
   * already declared dead — it re-enters with a fresh walk rather than looping
   * inside a single attempt.
   * @returns {undefined}
   */
  providerRetryPolicy() {
    return undefined
  }

  /** @returns {undefined} no provider-side image pricing. */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Preserve normalized image dimensions, as the upstream default does.
   * @param {string} _provider - registered route.
   * @param {string} _model - chain id.
   * @param {{width: number, height: number, bytes: number}} image - normalized image.
   * @returns {{width: number, height: number, maxBytes: number}} unchanged target.
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * The enabled chains as picker models.
   *
   * `inputModalities` is derived from the chain's own routes rather than being
   * fixed to `['text']`. The host reads this list to decide whether to offer
   * image input at all, so a hard-coded text-only claim made every rotation chain
   * refuse pictures even when its routes could see them.
   *
   * The list is a union over the routes that DECLARED modalities; when none did,
   * it is omitted (unknown) rather than set to text-only.
   *
   * @returns {Promise<object[]>} picker models.
   */
  async listModels() {
    const { settings } = this.#store.read()
    const enabled = settings.chains.filter(chain => chain.enabled)
    return Promise.all(
      enabled.map(async chain => {
        const infos = await Promise.all(chain.routes.map(route => this.#infoOf(route)))
        const modalities = new Set()
        let anyDeclared = false
        for (const info of infos) {
          if (!Array.isArray(info?.inputModalities)) continue
          anyDeclared = true
          for (const modality of info.inputModalities) {
            if (typeof modality === 'string' && modality !== '') modalities.add(modality)
          }
        }
        return {
          provider: ROUTER_PROVIDER,
          id: chain.id,
          name: chain.name,
          // A note the user wrote for a route is shown next to it, in brackets, so
          // the picker explains the chain without opening the settings card. It is
          // display-only: the walk itself never reads it.
          description: chain.routes
            .map(route => route.provider + '/' + route.model + (route.note ? '（' + route.note + '）' : ''))
            .join(' → '),
          ...(anyDeclared && modalities.size > 0 ? { inputModalities: [...modalities] } : {}),
        }
      }),
    )
  }

  /**
   * Resolve one chain's metadata.
   *
   * The context window is the largest among the routes: the dispatcher then
   * routes each request to a route that fits it. Reasoning levels are a
   * vocabulary rather than a capacity, so they are not intersected here — each
   * attempt resolves its own route's levels.
   * @param {string} provider - registered route.
   * @param {string} model - chain id.
   * @returns {Promise<object>} model info.
   */
  async resolveModel(provider, model) {
    const { settings } = this.#store.read()

    // Drop cache entries for routes no longer configured anywhere. The cache is
    // keyed by route, so without this a user who removes a route and adds it back
   // later would get whatever window and modalities it had before — stale
    // capability data driving a live routing decision.
    //
    // Pruning runs before the empty-chain early return: removing a chain's last
    // route is exactly when the stale entry must go.
    this.#pruneInfoCache(settings)

    const chain = settings.chains.find(candidate => candidate.id === model)
    // No `inputModalities` here on purpose. The host treats a PRESENT list that
    // lacks 'image' as "this model is blind" and flattens every image to text
    // before dispatch (`dsh-llm`: `inputModalities !== undefined &&
    // !inputModalities.includes('image')`). An absent list means "unknown", which
    // the host leaves alone. Claiming text-only for a chain we know nothing about
    // silently disabled image input for the whole route.
    const base = { provider, id: model, name: chain?.name ?? model }
    if (chain === undefined || chain.routes.length === 0) return base

    const infos = await Promise.all(chain.routes.map(route => this.#infoOf(route)))
    const windows = infos.map(info => info?.contextWindow).filter(value => typeof value === 'number' && value > 0)

    // Union of the routes' declared modalities, but only over routes that
    // actually DECLARED something. A chain is offered to the user as one model,
    // so it can see an image when any of its routes can; the capability gate then
    // routes the request to that route.
    //
    // If no route disclosed anything, the list stays undefined rather than
    // becoming ['text']: "unknown" must not be reported as "cannot see".
    const modalities = new Set()
    let anyDeclared = false
    for (const info of infos) {
      if (!Array.isArray(info?.inputModalities)) continue
      anyDeclared = true
      for (const modality of info.inputModalities) {
        if (typeof modality === 'string' && modality !== '') modalities.add(modality)
      }
    }

    // `contextWindow` belongs under `context`: the registry validates
    // `context.contextWindow` and silently ignores a stray flat field.
    return {
      ...base,
      ...(windows.length > 0 ? { context: { contextWindow: Math.max(...windows) } } : {}),
      ...(anyDeclared && modalities.size > 0 ? { inputModalities: [...modalities] } : {}),
    }
  }

  /**
   * Bind metadata and the eventual dispatch to one adapter generation.
   * @param {string} provider - registered route.
   * @param {string} model - chain id.
   * @param {AbortSignal} [signal] - cancellation for model resolution.
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>}
   */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: options => this.#stream(provider, model, options),
    }
  }

  /**
   * Walk the chain, forwarding the first route that answers.
   *
   * @param {string} _provider - registered route.
   * @param {string} chainId - chain id.
   * @param {object} options - the full request the loop handed down.
   * @returns {AsyncIterable<object>} one stream, ending exactly once.
   */
  async *#stream(_provider, chainId, options) {
    const { settings } = this.#store.read()
    const chain = settings.chains.find(candidate => candidate.id === chainId)
    const signal = options?.signal

    if (chain === undefined) {
      yield finishError('UNKNOWN_MODEL', `unknown rotation chain "${chainId}"`)
      return
    }

    const ordered = buildChain({ provider: chainId, model: chainId }, chain.routes, { includeRequested: false })
    if (ordered.length === 0) {
      yield finishError('UNKNOWN_MODEL', `rotation chain "${chainId}" has no routes`)
      return
    }

    // Move routes that recently failed to the back. This is a reorder, never a
    // removal: if every route is cooling down, `partition` returns the chain
    // unchanged so the walk still attempts something.
    const { routes, cooling } = this.#cooldown.partition(ordered)

    const need = requirementsOf(options)
    // Wall-clock start of the whole walk, for the request log. `started` below
    // is per-route and would under-report a walk that tried several routes.
    const walkStarted = Date.now()
    const tried = []
    const skipped = []
    let lastCode

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }

      const label = route.provider + '/' + route.model

      // Capability gate: skip a route that provably cannot serve this request
      // rather than letting it silently drop an image or overflow its window.
      const info = await this.#infoOf(route)
      const verdict = routeCanServe(info, need)
      if (!verdict.ok) {
        skipped.push({ route, reason: verdict.reason })
        this.#log.info?.(`model-rotation: skipping ${label}: ${verdict.reason}`)
        continue
      }

      const started = Date.now()
      let prepared
      this.#hooks.onAttemptStart?.()
      try {
        // The registry's prepareCall takes a config object, not (provider, model).
        prepared = await withTimeout(
          Promise.resolve(this.ctx?.llm?.prepareCall?.({ provider: route.provider, model: route.model }, signal)),
          INFO_TIMEOUT_MS,
          'prepareCall',
        )
      } catch (error) {
        this.#hooks.onAttemptEnd?.()
        const code = codeOf(error)
        tried.push({ route, code, message: describe(error) })
        this.#log.warn?.(`model-rotation: ${label} could not be prepared (${code ?? 'unknown'}): ${describe(error)}`)
        if (!shouldFailover(code)) {
          this.#reportFailure(chainId, tried, skipped, code, { startedAt: walkStarted })
          yield finishError(code ?? 'UNKNOWN', describe(error))
          return
        }
        lastCode = code
        await delay(RETRY_PAUSE_MS * (index + 1), signal)
        continue
      }

      if (prepared === undefined) {
        tried.push({ route, code: 'NO_ADAPTER', message: 'route is not available' })
        lastCode = 'NO_ADAPTER'
        continue
      }

      // The request body must survive the hop; the controls come from the
      // resolved config so the prepared-call equality check passes.
      //
      // This plugin's own knobs are removed first: `idleTimeoutMs` and
      // `timeoutMs` are read by this adapter, and forwarding them would hand a
      // downstream provider a field it never defined.
      const { idleTimeoutMs: _idle, timeoutMs: _timeout, ...requestBody } = options ?? {}
      const forwarded = {
        ...requestBody,
        ...(prepared.config ?? {}),
        provider: route.provider,
        model: route.model,
      }

      let attempt
      try {
        attempt = runAttempt(prepared.stream(forwarded), {
          signal,
          idleTimeoutMs: this.#idleTimeoutOf(options),
        })
      } catch (error) {
        const code = codeOf(error)
        tried.push({ route, code, message: describe(error) })
        this.#log.warn?.(`model-rotation: ${label} refused dispatch (${code ?? 'unknown'}): ${describe(error)}`)
        if (!shouldFailover(code)) {
          this.#reportFailure(chainId, tried, skipped, code, { startedAt: walkStarted })
          yield finishError(code ?? 'UNKNOWN', describe(error))
          return
        }
        lastCode = code
        continue
      }

      // Stream the attempt. Once it commits, this route owns the turn.
      let committed = false
      let outcome
      try {
        for await (const chunk of attempt.chunks) {
          if (!committed) {
            committed = true
            this.#log.info?.(`model-rotation: ${chainId} → ${label}`)
            this.#hooks.onSwitch?.({
              chainId,
              from: tried.at(-1)?.route ?? null,
              to: route,
              reason: tried.at(-1)?.code ?? 'primary',
            })
          }
          yield chunk
        }
        outcome = await attempt.outcome
      } finally {
        // Decrement here, not after the branch below: the reader may abandon the
        // generator at any `yield`, and a leaked counter would make the settings
        // card claim a request is still running forever.
        this.#hooks.onAttemptEnd?.()
      }

      const elapsed = Date.now() - started

      if (outcome.kind === 'aborted') {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      if (outcome.kind === 'answer') {
        // The route answered, so any earlier cooldown is stale.
        this.#cooldown.succeed(route)
        this.#log.info?.(`model-rotation: ${chainId} served by ${label} in ${elapsed}ms`)
        this.#requestLog?.record({
          chainId,
          provider: route.provider,
          model: route.model,
          elapsedMs: elapsed,
          outcome: 'answered',
          tried,
        })
        return
      }

      tried.push({ route, code: outcome.code, message: outcome.message })
      lastCode = outcome.code
      // Only retryable failures earn a cooldown: a terminal one (AUTH, bad
      // request) would fail identically on the next turn, and holding the route
      // out would hide the real problem instead of fixing it.
      if (shouldFailover(outcome.code)) {
        const held = this.#cooldown.fail(route)
        this.#log.info?.(`model-rotation: ${label} cooling down for ${Math.round(held / 1000)}s`)
      }
      this.#log.warn?.(
        `model-rotation: ${label} failed (${outcome.code ?? 'unknown'}): ${outcome.message ?? ''}`,
      )

      // After commit the reader has already seen output from this route, so
      // switching would splice two models' answers together. Surface the
      // failure instead: the turn is genuinely broken.
      if (committed) {
        this.#reportFailure(chainId, tried, skipped, outcome.code, { startedAt: walkStarted })
        yield finishError(outcome.code ?? 'UNKNOWN', outcome.message ?? 'route failed after emitting output')
        return
      }

      if (!shouldFailover(outcome.code)) {
        this.#reportFailure(chainId, tried, skipped, outcome.code, { startedAt: walkStarted })
        yield finishError(outcome.code ?? 'UNKNOWN', outcome.message ?? 'route failed')
        return
      }

      // A short pause before the next route: an upstream that just rate-limited
      // us is unlikely to accept the same burst on a sibling route either.
      await delay(RETRY_PAUSE_MS * (index + 1), signal)
    }

    // Every route was skipped or failed in a retryable way.
    this.#reportFailure(chainId, tried, skipped, lastCode, { inputTokens: need.inputTokens, startedAt: walkStarted })
    yield finishError(
      lastCode ?? 'UNKNOWN',
      summarizeFailure(chainId, tried, skipped, { inputTokens: need.inputTokens }),
    )
  }

  /**
   * Per-request idle timeout.
   *
   * The request may carry its own; otherwise the adapter's default applies.
   * A value of `0` from the request disables the watchdog.
   * @param {object} options - the request.
   * @returns {number} timeout in milliseconds.
   */
  #idleTimeoutOf(options) {
    const requested = options?.idleTimeoutMs ?? options?.timeoutMs
    if (typeof requested === 'number' && requested >= 0) return requested
    return DEFAULT_IDLE_TIMEOUT_MS
  }

  /** @returns {CooldownTable} the cooldown state, for diagnostics and tests. */
  get cooldown() {
    return this.#cooldown
  }

  /** Record one failed walk for the status surface. */
  #reportFailure(chainId, tried, skipped, code, detail) {
    const summary = summarizeFailure(chainId, tried, skipped, detail)
    this.#log.warn?.('model-rotation: ' + summary)
    this.#hooks.onFailure?.({ chainId, code, summary, tried: tried.map(entry => entry.route) })
    // The status card only keeps the newest failure per chain and the Host
    // logger does not persist info lines, so without this the fact that a walk
    // failed disappears on restart. The route named is the last one tried:
    // that is the one whose error the summary reports last.
    const last = tried.at(-1)
    if (last !== undefined) {
      this.#requestLog?.record({
        chainId,
        provider: last.route.provider,
        model: last.route.model,
        elapsedMs: typeof detail?.startedAt === 'number' ? Date.now() - detail.startedAt : 0,
        outcome: 'failed',
        code,
        tried,
      })
    }
  }

  /**
   * Drop metadata cache entries for routes that are no longer configured.
   *
   * Cheap: the configured route set is small, and the cache is bounded by it. The
   * cost of not pruning is a routing decision made on a stale context window after
   * the user re-adds a route.
   * @param {{chains: Array<object>}} settings - the current document.
   */
  #pruneInfoCache(settings) {
    if (this.#info.size === 0) return
    const live = new Set()
    for (const chain of settings.chains) {
      for (const route of chain.routes) live.add(route.provider + '\u0000' + route.model)
    }
    for (const key of this.#info.keys()) {
      if (!live.has(key)) this.#info.delete(key)
    }
  }

  /**
   * Resolve one route's metadata, cached briefly.
   * @param {{provider: string, model: string}} route - the route.
   * @returns {Promise<object | undefined>} info, or undefined when unknown.
   */
  async #infoOf(route) {
    const key = route.provider + '\u0000' + route.model
    const cached = this.#info.get(key)
    if (cached !== undefined && Date.now() - cached.at < INFO_TTL_MS) return cached.info
    let info
    try {
      const raw = await withTimeout(
        Promise.resolve(this.ctx?.llm?.resolveModelInfo?.(route.provider, route.model)),
        INFO_TIMEOUT_MS,
        'resolveModelInfo',
      )
      info =
        raw === undefined
          ? undefined
          : {
              contextWindow: raw.context?.contextWindow,
              inputModalities: raw.inputModalities === undefined ? undefined : [...raw.inputModalities],
              toolUpdate: raw.toolUpdate,
            }
    } catch {
      info = undefined
    }
    this.#info.set(key, { at: Date.now(), info })
    return info
  }
}

/** Build one terminal error chunk. */
function finishError(code, message) {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

/**
 * Codes that mean "this request is longer than the route will accept".
 *
 * Grouped rather than inlined so the hint below and the failover classification
 * cannot drift apart: both answer the same question about the same code.
 */
const CONTEXT_CODES = Object.freeze(['CONTEXT_WINDOW_EXCEEDED'])

/**
 * Whether every attempted route rejected the request for length alone.
 *
 * Only then is "shorten the conversation" the right advice. If one route timed
 * out and another rejected the length, the length was not the whole story and a
 * hint pointing at it would send the user down the wrong path.
 * @param {Array<object>} tried - attempted routes, in order.
 * @returns {boolean} true when length was the only reason anything failed.
 */
function allRejectedForLength(tried) {
  if (!Array.isArray(tried) || tried.length === 0) return false
  return tried.every(entry => CONTEXT_CODES.includes(entry.code))
}

/**
 * The actionable half of a length failure.
 *
 * The plain summary says every route failed, which is true but leaves the user
 * with nothing to do: the obvious next move — try another provider — is exactly
 * what already happened. A chain exists to make that move automatically, so when
 * every route rejects the length the answer is never "switch provider".
 * @param {number | undefined} inputTokens - estimated request size, when known.
 * @returns {string} advice the user can act on.
 */
function contextWindowHint(inputTokens) {
  const size =
    typeof inputTokens === 'number' && inputTokens > 0
      ? `当前请求约 ${Math.round(inputTokens / 1000)}K tokens（估算）。`
      : ''
  return (
    '提示：所有候选模型都判定上下文超限，这不是某一个厂商的限制，换厂商不会更宽松。' +
    size +
    '请开一个新会话继续，或先压缩这段对话再重试。'
  )
}

/** Render the full attempt summary, including routes that were skipped. */
function summarizeFailure(chainId, tried, skipped, detail = {}) {
  const parts = []
  for (const entry of tried) {
    parts.push(`${entry.route.provider}/${entry.route.model}: ${entry.code ?? 'unknown'}`)
  }
  for (const entry of skipped) {
    parts.push(`${entry.route.provider}/${entry.route.model}: skipped (${entry.reason})`)
  }
  if (parts.length === 0) return `rotation chain "${chainId}" has no usable route`
  const summary = `every route in chain "${chainId}" failed — ${parts.join('; ')}`
  // Appended only for a pure length failure; a mixed failure keeps the plain
  // summary so the hint cannot misattribute the cause.
  return allRejectedForLength(tried) ? `${summary}\n\n${contextWindowHint(detail.inputTokens)}` : summary
}

export { classifyUnfinishedStream, summarizeFailure }
