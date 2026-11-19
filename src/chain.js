/**
 * Model rotation chain.
 *
 * The decision logic lives here, apart from any Cordis wiring, so it can be
 * exercised offline and so the adapter stays a thin translation layer.
 *
 * A chain is an ordered list of `{provider, model}` routes. The first entry is
 * the request's own target; the rest are fallbacks, tried in order when the
 * previous one fails in a way that another model could plausibly survive.
 *
 * @module chain
 */

/** Failure codes where a different model is worth trying. */
export const RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'QUOTA',
  // Different providers disagree about what "too long" means: one counts
  // tokens, another counts characters or includes the system prompt, and the
  // same conversation can be over one vendor's limit and well under another's.
  // Treating it as terminal means a chain whose first route rejects the length
  // never tries the route behind it — which is exactly the case a rotation chain
  // exists to handle.
  'CONTEXT_WINDOW_EXCEEDED',
])

/**
 * Codes where another model is pointless or actively harmful.
 *
 * `ABORTED` is the user stopping the turn; the rest are request-shape or
 * credential problems that would fail identically everywhere.
 */
export const TERMINAL_CODES = Object.freeze([
  'ABORTED',
  'AUTH',
  'INVALID_REQUEST',
  'MODEL_UNSUPPORTED',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_CONTENT',
])

/**
 * Whether a failure should advance the chain.
 *
 * Unknown codes are treated as terminal: guessing "retry elsewhere" for a code
 * this plugin does not understand is how a routing layer turns one clear error
 * into three confusing ones.
 * @param {string | undefined} code - failure code from the adapter or stream.
 * @returns {boolean} true when the next route should be tried.
 */
export function shouldFailover(code) {
  if (typeof code !== 'string' || code === '') return false
  if (TERMINAL_CODES.includes(code)) return false
  return RETRYABLE_CODES.includes(code)
}

/** Longest note kept on a route, in characters. */
export const MAX_NOTE_LENGTH = 200

/**
 * Coerce one stored route.
 *
 * `note` is a label the user writes for themselves — "便宜", "强推理", "别用于代码" —
 * so it is carried through untouched apart from trimming and a length cap. It is
 * never sent to a provider: the adapter builds the downstream request from
 * `provider`/`model` plus the resolved controls, so a note cannot leak into a
 * prompt.
 * @param {unknown} raw - a stored chain entry.
 * @returns {{provider: string, model: string, note?: string} | undefined} the route, or undefined when unusable.
 */
export function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return undefined
  // Omitted rather than set to undefined: a route without a note must stay
  // byte-identical to the shape this plugin has always written, so an existing
  // settings file is not rewritten just because it was read.
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE_LENGTH) : ''
  return note === '' ? { provider, model } : { provider, model, note }
}

/**
 * Build the effective chain for one request.
 *
 * The requested route always leads, even when it is not in the configured chain:
 * a user who explicitly picked a model gets that model first, and the chain is
 * the safety net behind it rather than a replacement for the choice.
 * @param {{provider: string, model: string}} requested - the route the caller asked for.
 * @param {Array<{provider: string, model: string}>} chain - configured fallbacks, in order.
 * @param {{includeRequested?: boolean}} [options] - `includeRequested: false` drops the head.
 * @returns {Array<{provider: string, model: string}>} routes to try, deduplicated, head first.
 */
export function buildChain(requested, chain, options = {}) {
  const out = []
  const seen = new Set()
  const push = route => {
    if (!route) return
    const key = route.provider + '\u0000' + route.model
    if (seen.has(key)) return
    seen.add(key)
    out.push(route)
  }
  if (options.includeRequested !== false) push(normalizeRoute(requested))
  for (const raw of Array.isArray(chain) ? chain : []) push(normalizeRoute(raw))
  return out
}

/**
 * Pick the next route after `index`.
 * @param {Array<{provider: string, model: string}>} chain - the effective chain.
 * @param {number} index - the route that just failed.
 * @returns {{provider: string, model: string} | undefined} the next route, if any.
 */
export function nextRoute(chain, index) {
  if (!Array.isArray(chain)) return undefined
  const next = index + 1
  if (next < 0 || next >= chain.length) return undefined
  return chain[next]
}

/**
 * Read the failure code out of whatever the stream or adapter threw.
 * @param {unknown} error - a thrown value or a terminal finish reason.
 * @returns {string | undefined} the code, when one is present.
 */
export function codeOf(error) {
  if (error === null || typeof error !== 'object') return undefined
  const direct = error.code
  if (typeof direct === 'string' && direct !== '') return direct
  const failure = error.failure
  if (failure && typeof failure === 'object' && typeof failure.code === 'string' && failure.code !== '') {
    return failure.code
  }
  return undefined
}
