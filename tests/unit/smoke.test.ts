import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('toolchain smoke test', () => {
  it('runs vitest with TypeScript and zod', () => {
    const schema = z.object({ ok: z.literal(true) });
    expect(schema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('rejects invalid input with zod', () => {
    const schema = z.object({ ok: z.literal(true) });
    expect(schema.safeParse({ ok: false }).success).toBe(false);
  });
});
