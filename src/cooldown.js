/**
 * Cooldown for routes that recently failed.
 *
 * Without this, a provider that is down makes every request pay its timeout
 * before falling over. With it, the next request skips the known-bad route until
 * the cooldown expires.
 *
 * The rule that keeps this safe: cooldown may reorder the chain but must never
 * empty it. If every route is cooling down, the walk still tries them — a chain
 * that refuses to attempt anything is worse than a slow one.
 *
 * @module cooldown
 */

/** First cooldown for one consecutive failure, in milliseconds. */
export const BASE_COOLDOWN_MS = 15_000

/** Ceiling for the exponential growth, in milliseconds. */
export const MAX_COOLDOWN_MS = 10 * 60_000

/** How long a route key stays in the map with no failures, in milliseconds. */
const FORGET_AFTER_MS = 30 * 60_000

/**
 * Cooldown state for one adapter instance.
 *
 * Keyed by `provider/model`, so it survives chain edits that move a route between
 * chains — the route is what is unhealthy, not the chain.
 */
export class CooldownTable {
  /** @type {Map<string, {until: number, streak: number, at: number}>} */
  #entries = new Map()
  /** @type {() => number} */
  #now
  /** @type {number} */
  #baseMs

  /**
   * @param {{now?: () => number, baseMs?: number}} [options] - clock and base duration.
   */
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#baseMs = typeof options.baseMs === 'number' && options.baseMs >= 0 ? options.baseMs : BASE_COOLDOWN_MS
  }

  /** @param {{provider: string, model: string}} route - the route. */
  static keyOf(route) {
    return route.provider + '\u0000' + route.model
  }

  /**
   * Record one retryable failure and start (or extend) the route's cooldown.
   * @param {{provider: string, model: string}} route - the failed route.
   * @returns {number} how long the route is now held out, in milliseconds.
   */
  fail(route) {
    const key = CooldownTable.keyOf(route)
    const now = this.#now()
    const previous = this.#entries.get(key)
    const streak = (previous?.streak ?? 0) + 1
    const duration = Math.min(this.#baseMs * 2 ** (streak - 1), MAX_COOLDOWN_MS)
    this.#entries.set(key, { until: now + duration, streak, at: now })
    this.#forget(now)
    return duration
  }

  /**
   * Clear a route's cooldown after it answers.
   * @param {{provider: string, model: string}} route - the route that worked.
   */
  succeed(route) {
    this.#entries.delete(CooldownTable.keyOf(route))
  }

  /**
   * Whether a route is currently held out.
   * @param {{provider: string, model: string}} route - the route.
   * @returns {boolean} true while the route is cooling down.
   */
  isCooling(route) {
    const entry = this.#entries.get(CooldownTable.keyOf(route))
    if (entry === undefined) return false
    if (entry.until <= this.#now()) {
      // Expired: drop it so the next failure starts a fresh streak rather than
      // resuming an old one.
      this.#entries.delete(CooldownTable.keyOf(route))
      return false
    }
    return true
  }

  /**
   * Reorder a chain so cooling routes come last, keeping relative order.
   *
   * Never drops a route: when every route is cooling, the chain comes back
   * unchanged so the walk can still attempt something.
   * @param {Array<{provider: string, model: string}>} routes - the effective chain.
   * @returns {{routes: Array<object>, cooling: Array<object>}} the reordered chain and what was held out.
   */
  partition(routes) {
    const ready = []
    const cooling = []
    for (const route of routes) {
      if (this.isCooling(route)) cooling.push(route)
      else ready.push(route)
    }
    // All cooling: keep the caller's order so the walk still has somewhere to go.
    if (ready.length === 0) return { routes: routes.slice(), cooling: [] }
    return { routes: [...ready, ...cooling], cooling }
  }

  /** Drop entries that have been idle long enough to be uninteresting. */
  #forget(now) {
    for (const [key, entry] of this.#entries) {
      if (now - entry.at > FORGET_AFTER_MS && entry.until <= now) this.#entries.delete(key)
    }
  }

  /** @returns {number} how many routes are currently held out. */
  get size() {
    return this.#entries.size
  }
}
