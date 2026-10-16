/**
 * Hook formulas for the opening question of Facebook / LinkedIn posts. Every formula yields ONE
 * question, as in the reference post, but with a different shape. History tracks the formula used
 * per report so the same opening is not repeated.
 */

export interface HookStyle {
  id: string;
  /** What the model is told. Placeholders in <angle brackets> are filled from the facts and notes. */
  instruction: string;
}

export const HOOK_STYLES: readonly HookStyle[] = [
  {
    id: 'contrast-why',
    instruction:
      'Write the hook as a "Why" question that sets a stated figure against a tension, in the shape: "Why did <the market> reach <figure> in <year>, a figure that contrasts with <tension from the notes>?"',
  },
  {
    id: 'sufficiency',
    instruction: 'Write the hook as a sufficiency question, in the shape: "Is <growth rate or size> enough to justify <a decision>?"',
  },
  {
    id: 'implication',
    instruction: 'Write the hook as an implication question, in the shape: "What does <a stated fact> mean for <players in the market> that must <decide something>?"',
  },
  {
    id: 'which-part',
    instruction: 'Write the hook as a "Which" question about where value sits, in the shape: "Which <part of the market> stands to capture the move from <figure> to <figure>?"',
  },
  {
    id: 'how-should',
    instruction: 'Write the hook as a "How should" question, in the shape: "How should <a type of player> respond when <a stated fact>?"',
  },
  {
    id: 'what-changes',
    instruction: 'Write the hook as a "What changes" question, in the shape: "What changes for <a decision> if the market moves from <figure> to <figure>?"',
  },
  {
    id: 'myth-check',
    instruction: 'Write a belief-testing question. Use "Is the common assumption that <belief> still true when <a stated fact>?" ONLY if the supplied source notes explicitly state that belief. Otherwise ask "Does <a stated fact> change <a decision>?" without inventing an industry assumption.',
  },
];

export function hookById(id: string): HookStyle | undefined {
  return HOOK_STYLES.find((h) => h.id === id);
}
