/**
 * Local estimate of what one MCP tool definition costs a request.
 *
 * Neither side of this wire carries a tokenizer: the browser cannot reach the
 * provider's, and running one in the Host for a settings listing would be a
 * dependency the listing does not need. The number a listing shows is for
 * comparison — which tool is expensive, how much a rule removes, what the row
 * costs in total — so an estimate is the honest answer, and the labels that show
 * it say "≈".
 *
 * The estimate measures the JSON a definition serializes to: its name, title,
 * description, and argument schema. Text is counted at four characters per
 * token, except CJK, which most tokenizers split nearer two characters per
 * token.
 * @module @guowenzhang/dsh-mcp-manager/mcp-tokens
 */

/** One tool definition, as far as its size is concerned. */
export interface TokenCountedTool {
  readonly name: string
  /** Display name the spec added in 2025-06-18, when the server declared one. */
  readonly title?: string | undefined
  readonly description?: string | undefined
  /** Argument schema the request carries alongside the description. */
  readonly inputSchema?: unknown
}

/** Characters most tokenizers pack about four to a token. */
const CHARS_PER_TOKEN = 4

/** CJK characters carry more each; about two of them are one token. */
const CJK_CHARS_PER_TOKEN = 2

/** Han, kana, Hangul, and fullwidth forms: the ranges counted as CJK. */
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g

/**
 * Estimate the tokens one text costs.
 * @param text - the text a request would carry.
 * @returns the estimated token count, at least 1 for non-empty text.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return Math.max(1, Math.ceil((text.length - cjk) / CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN))
}

/**
 * Estimate the tokens one tool definition adds to a request.
 *
 * The definition's own text is what is measured — the `name`, `title`,
 * `description`, and `inputSchema` the model receives. The adapter's own
 * wrapper is not modelled, so the number is comparable across tools rather than
 * absolute.
 * @param tool - the definition as the server published it.
 * @returns the estimated token count.
 */
export function estimateToolTokens(tool: TokenCountedTool): number {
  return estimateTokens(JSON.stringify({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}
