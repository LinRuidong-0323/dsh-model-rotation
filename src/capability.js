/**
 * Route selection by capability.
 *
 * A chain mixes models that are not interchangeable. Three differences matter
 * before dispatch, and getting any of them wrong silently degrades the answer
 * rather than failing loudly:
 *
 * - **Images**: a text-only model cannot see a picture. The host would flatten
 *   it to text, which loses the request's whole point.
 * - **Context**: a 128K model cannot hold a 400K conversation.
 * - **Tools**: a route that rejects tool declarations cannot run an agent step.
 *
 * @module capability
 */

/**
 * Whether one message block carries an image.
 *
 * DSH represents an image as `{type:'image', attachment:{...}}` — a reference to
 * a stored attachment the host resolves. Some shapes also carry the media inline,
 * so both are recognised.
 * @param {object} block - one content block.
 * @returns {boolean} true when this block is an image.
 */
function blockHasImage(block) {
  if (!block || typeof block !== 'object') return false
  return block.type === 'image'
}

/**
 * Whether the request contains an image anywhere.
 *
 * Scans both user messages and tool results: a screenshot returned by a tool is
 * still an image the model must be able to read.
 * @param {Array<object>} messages - request messages.
 * @returns {boolean} true when an image is present.
 */
export function requestHasImage(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (blockHasImage(block)) return true
      // A tool result may carry its own content array.
      if (block?.type === 'tool-result' && Array.isArray(block.content)) {
        for (const inner of block.content) if (blockHasImage(inner)) return true
      }
    }
  }
  return false
}

/**
 * Whether one code point is written with a wide (CJK) glyph.
 *
 * These cost roughly one token each, unlike Latin text at ~4 characters per
 * token. Counting them at the Latin rate underestimates a Chinese request by
 * about 4x, which lets a request that will not fit pass the gate and fail
 * upstream instead.
 * @param {number} code - one code point.
 * @returns {boolean} true for CJK ideographs, kana, hangul and fullwidth forms.
 */
function isWideCodePoint(code) {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0x3040 && code <= 0x30ff) || // hiragana + katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) || // fullwidth forms
    (code >= 0x20000 && code <= 0x2fa1f) // CJK extensions B–F
  )
}

/**
 * Estimate the token count of one string.
 *
 * Wide glyphs count as one token each; everything else counts at the usual
 * ~4 characters per token. This is still an estimate — it is used to decide
 * whether a route is *plausibly* too small, and being slightly high is safer
 * than being low, because the alternative is a request that overflows upstream.
 * @param {string} text - the text to measure.
 * @returns {number} estimated tokens.
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let wide = 0
  let narrow = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (isWideCodePoint(code)) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/** Rough token estimate for one message, good enough to compare against a window. */
function estimateMessageTokens(message) {
  const content = message?.content
  if (typeof content === 'string') return estimateTextTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (typeof block?.text === 'string') total += estimateTextTokens(block.text)
    else if (typeof block?.content === 'string') total += estimateTextTokens(block.content)
    else if (Array.isArray(block?.content)) total += estimateMessageTokens({ content: block.content })
    else if (block?.type === 'image') total += 1000 // a picture is expensive; be conservative
    else total += 16
  }
  return total
}

/**
 * Estimate the request's input size in tokens.
 * @param {Array<object>} messages - request messages.
 * @param {Array<object>} [tools] - tool declarations.
 * @returns {number} estimated input tokens.
 */
export function estimateRequestTokens(messages, tools) {
  let total = 0
  for (const message of Array.isArray(messages) ? messages : []) total += estimateMessageTokens(message)
  // Tool schemas are part of the prompt on every turn.
  if (Array.isArray(tools) && tools.length > 0) total += estimateTextTokens(JSON.stringify(tools))
  return total
}

/**
 * Decide whether one route can serve a request.
 *
 * An unknown capability is treated as compatible: refusing a route because the
 * host did not report a window would silently shrink the chain to nothing. Only
 * a *known* incompatibility is a rejection.
 * @param {{inputModalities?: string[]}} info - resolved route metadata.
 * @param {{needsImage: boolean, inputTokens: number, needsTools: boolean, reservedOutputTokens?: number}} need
 * @returns {{ok: true} | {ok: false, reason: string}} the verdict.
 */
export function routeCanServe(info, need) {
  if (need.needsImage) {
    const modalities = info?.inputModalities
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      return { ok: false, reason: 'route cannot accept images' }
    }
  }
  if (need.needsTools && info?.toolUpdate === null) {
    return { ok: false, reason: 'route cannot accept tool declarations' }
  }
  const window = info?.contextWindow
  if (typeof window === 'number' && window > 0 && need.inputTokens > 0) {
    const reserve = need.reservedOutputTokens ?? 0
    if (need.inputTokens + reserve > window) {
      return { ok: false, reason: `request needs ${need.inputTokens} tokens but route window is ${window}` }
    }
  }
  return { ok: true }
}

/**
 * Build the requirement set for one request.
 * @param {{messages?: Array<object>, tools?: Array<object>, maxTokens?: number}} options - the request.
 * @returns {{needsImage: boolean, needsTools: boolean, inputTokens: number, reservedOutputTokens: number}}
 */
export function requirementsOf(options) {
  const messages = options?.messages
  return {
    needsImage: requestHasImage(messages),
    needsTools: Array.isArray(options?.tools) && options.tools.length > 0,
    inputTokens: estimateRequestTokens(messages, options?.tools),
    reservedOutputTokens: typeof options?.maxTokens === 'number' ? options.maxTokens : 0,
  }
}
