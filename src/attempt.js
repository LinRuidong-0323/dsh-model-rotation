/**
 * Ceiling on closing an abandoned upstream, in milliseconds.
 *
 * An upstream stuck inside `next()` never reaches `return()`, so awaiting the
 * close would hang the turn. Closing is best-effort: the verdict is already
 * decided, and a provider that refuses to be cancelled must not be able to hold
 * the turn open.
 */
const CLOSE_TIMEOUT_MS = 500

/**
 * Per-attempt streaming with commit semantics.
 *
 * One attempt is one route. The reader sees chunks as soon as the attempt is
 * committed — the first chunk that carries reader-visible output. Before that
 * point the attempt may be abandoned silently; after it, the attempt owns the
 * turn and a later failure must surface rather than switch.
 *
 * @module attempt
 */

/**
 * Whether one chunk is reader-visible output.
 *
 * Only actual content commits: non-empty text, or a tool call. A `block-start`
 * does *not* commit even when it opens a text block, because the block may turn
 * out to be empty — a route that opens a block and then dies has produced
 * nothing the reader asked for, so it must still be switchable. `usage` is
 * bookkeeping and never commits.
 *
 * @param {object} chunk - one stream chunk.
 * @returns {boolean} true when this chunk commits the attempt.
 */
export function commitsAttempt(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
      return typeof chunk.text === 'string' && chunk.text.trim() !== ''
    case 'tool-call-delta':
      return true
    case 'block-end':
      // A completed text block with content is visible; an empty one is not.
      if (chunk.block?.type === 'reasoning') return false
      if (chunk.block?.type === 'text') {
        return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
      }
      return true
    case 'block-start':
    case 'reasoning-delta':
    case 'usage':
      return false
    default:
      // Unknown chunk types are forwarded by the host, so assume they are visible.
      return chunk.type !== undefined && chunk.type !== 'ping' && chunk.type !== 'heartbeat'
  }
}

/**
 * Whether one chunk proves the upstream is still working.
 *
 * The watchdog measures progress, not bytes: gateways commonly emit keepalive
 * pings and empty deltas while a model is stuck, and a byte-based timer would
 * never fire on those.
 * @param {object} chunk - one stream chunk.
 * @returns {boolean} true when this chunk counts as progress.
 */
export function carriesProgress(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text !== ''
  if (chunk.type === 'reasoning-delta') return typeof chunk.text === 'string' && chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type === 'block-start' || chunk.type === 'block-end' || chunk.type === 'finish') return true
  return false
}

/** Render one thrown value without letting hostile coercion escape. */
export function describe(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  try {
    return String(error)
  } catch {
    return 'route failed'
  }
}

/**
 * Read the failure code out of a finish reason or a thrown value.
 * @param {unknown} value - a finish reason or thrown value.
 * @returns {string | undefined} the code, when present.
 */
export function codeOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const direct = value.code
  if (typeof direct === 'string' && direct !== '') return direct
  const failure = value.failure
  if (failure && typeof failure === 'object') {
    if (typeof failure.code === 'string' && failure.code !== '') return failure.code
  }
  return undefined
}

/**
 * Classify an attempt that ended without an explicit failure.
 *
 * A stream that ends without a `finish` chunk is a protocol violation, not a
 * clean stop: the provider never said the answer was complete, so the turn must
 * not be reported as successful. It is reported as `STREAM_CLOSED` (the host's
 * own code for an interrupted stream) when output had started, and as
 * `EMPTY_RESPONSE` when nothing at all arrived.
 * @param {{committed: boolean, sawFinish: boolean, sawAnyChunk: boolean}} state
 * @returns {{kind: 'failed', code: string, message: string}}
 */
export function classifyUnfinishedStream(state) {
  if (!state.sawFinish) {
    if (!state.sawAnyChunk) {
      return { kind: 'failed', code: 'EMPTY_RESPONSE', message: 'route produced no output' }
    }
    return {
      kind: 'failed',
      code: 'STREAM_CLOSED',
      message: state.committed ? 'stream ended after output without a finish reason' : 'stream ended without a finish reason',
    }
  }
  return { kind: 'failed', code: 'EMPTY_RESPONSE', message: 'route produced no output' }
}

/**
 * One attempt against one route, streamed.
 *
 * The async iterable yields chunks as they become safe to forward and resolves
 * to an outcome when the attempt is over. `commit()` is called exactly once, on
 * the first visible chunk, so the caller can pin the route.
 *
 * Cleanup: the returned iterable's `return()` cancels the upstream stream, and
 * the idle watchdog is always cleared. A consumer that stops early (the agent
 * loop abandoning a turn) therefore does not leave the upstream running.
 *
 * @param {AsyncIterable<object>} stream - the route's chunk stream.
 * @param {{signal?: AbortSignal, idleTimeoutMs?: number}} options
 * @returns {{chunks: AsyncIterable<object>, outcome: Promise<object>}} the stream and its verdict.
 */
export function runAttempt(stream, options = {}) {
  const { signal, idleTimeoutMs = 0 } = options

  /** Chunks produced before commit, buffered so they can be dropped. */
  const held = []
  const state = {
    committed: false,
    sawFinish: false,
    sawAnyChunk: false,
    finishReason: undefined,
  }

  let resolveOutcome
  const outcome = new Promise(resolve => {
    resolveOutcome = resolve
  })

  let iterator
  let idleTimer = null
  let timedOut = false
  let settled = false
  let closed = false

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const armIdle = () => {
    if (!(idleTimeoutMs > 0)) return
    clearIdle()
    idleTimer = setTimeout(() => {
      timedOut = true
      // Settle here rather than waiting for the loop to notice: the loop is
      // blocked inside `iterator.next()`, which may never resolve. The reader
      // sees the attempt end; the stuck upstream is abandoned below.
      settle({ kind: 'failed', code: 'TIMEOUT', message: `no progress for ${idleTimeoutMs}ms` })
      // Leaving the upstream running would keep a provider busy for a turn
      // nobody is waiting for. The close is bounded, so it cannot block.
      void closeUpstream()
    }, idleTimeoutMs)
  }

  const closeUpstream = async () => {
    if (closed) return
    closed = true
    clearIdle()
    try {
      // Bound the close: an upstream stuck inside `next()` never reaches
      // `return()`, and awaiting it would hang the turn forever. The turn's
      // verdict does not depend on the close succeeding.
      await withDeadline(Promise.resolve(iterator?.return?.()), CLOSE_TIMEOUT_MS)
    } catch {
      // A route that throws on close has already lost; the outcome stands.
    }
  }

  /** Resolve after `ms` regardless of the promise, so a stuck upstream cannot block. */
  function withDeadline(promise, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      promise.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        () => {
          clearTimeout(timer)
          resolve()
        },
      )
    })
  }

  const settle = value => {
    if (settled) return
    settled = true
    clearIdle()
    resolveOutcome(value)
  }

  const abortOutcome = () => ({ kind: 'aborted' })

  const failureOutcome = reason => {
    const code = codeOf(reason) ?? 'UNKNOWN'
    const message = reason?.failure?.message ?? reason?.message
    return { kind: 'failed', code, message: typeof message === 'string' ? message : undefined }
  }

  const chunks = (async function* () {
    try {
      iterator = stream[Symbol.asyncIterator]()
    } catch (error) {
      settle({ kind: 'failed', code: codeOf(error) ?? 'UNKNOWN', message: describe(error) })
      return
    }

    try {
      armIdle()
      while (true) {
        // A watchdog fire or an abort settles the outcome from outside this
        // loop. Checking here is what lets the reader stop even though the
        // `iterator.next()` below may never resolve.
        if (settled) {
          await closeUpstream()
          return
        }
        if (signal?.aborted === true) {
          await closeUpstream()
          settle(abortOutcome())
          return
        }

        let step
        try {
          // Race the pull against the outcome: a stuck upstream must not be able
          // to hold the reader, and a watchdog fire must unblock it.
          step = await Promise.race([
            iterator.next(),
            outcome.then(() => ({ done: true, value: undefined, __settled: true })),
          ])
          if (step.__settled === true) {
            await closeUpstream()
            return
          }
        } catch (error) {
          if (signal?.aborted === true) {
            settle(abortOutcome())
            return
          }
          settle({ kind: 'failed', code: codeOf(error) ?? 'UNKNOWN', message: describe(error) })
          return
        }

        if (step.done === true) {
          settle(classifyUnfinishedStream(state))
          return
        }

        const chunk = step.value
        state.sawAnyChunk = true
        if (carriesProgress(chunk)) armIdle()

        if (chunk?.type === 'finish') {
          state.sawFinish = true
          state.finishReason = chunk.reason
          const reason = chunk.reason ?? {}
          if (reason.kind === 'aborted') {
            settle(abortOutcome())
            return
          }
          if (reason.failure !== undefined) {
            settle(failureOutcome(reason))
            return
          }
          // A clean finish still has to be forwarded so the loop sees it.
          yield chunk
          settle({ kind: 'answer' })
          return
        }

        if (!state.committed) {
          if (!commitsAttempt(chunk)) {
            // Buffer uncommitted chunks: if this route dies, none of them leak.
            held.push(chunk)
            continue
          }
          state.committed = true
          // Release the buffered preamble in order, then stream live.
          for (const pending of held) yield pending
          held.length = 0
        }

        yield chunk
      }
    } finally {
      clearIdle()
      if (!closed) await closeUpstream()
      // A consumer that stops early must still settle, or the caller waits forever.
      settle(abortOutcome())
    }
  })()

  return { chunks, outcome, state }
}
