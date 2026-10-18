import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('full-cycle PowerShell launcher', () => {
  const script = readFileSync('scripts/run-full-cycle.ps1', 'utf8');

  it('does not forward a false SwitchParameter as a child-process string during preflight', () => {
    const preflight = script.split("if (!$SkipFeedback)")[0]!;
    expect(preflight).toContain('-WriteSheet -Check');
    expect(preflight).not.toContain('-KeepAwake');
  });

  it('avoids smart quotes that PowerShell parses as string delimiters', () => {
    expect(script).not.toMatch(/[‘’]/u);
  });
});
