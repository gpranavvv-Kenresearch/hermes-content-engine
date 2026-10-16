/**
 * Reasoning models (Qwen3 and friends) may wrap their chain of thought in
 * <think>...</think> before the answer. Complete blocks are stripped. An
 * unclosed <think> means the reply is raw, cut-off reasoning rather than an
 * answer, so it yields '' and the caller treats it as an unusable reply.
 */
export function stripThinking(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (/<think>/i.test(withoutBlocks)) return '';
  const close = withoutBlocks.search(/<\/think>/i);
  if (close >= 0) return withoutBlocks.slice(close + '</think>'.length).trim();
  return withoutBlocks;
}
