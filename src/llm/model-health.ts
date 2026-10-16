/**
 * In-process circuit breaker per model id. A model that returns unusable output
 * (HTTP errors, empty, reasoning leaks...) `threshold` times in a row is
 * quarantined for `quarantineMs`, so a dead or junk model stops eating the
 * key pool. State is per process; it is not persisted.
 */
export class ModelHealth {
  private readonly state = new Map<string, { consecutiveBad: number; until: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly threshold = 3,
    private readonly quarantineMs = 6 * 60 * 60 * 1000,
  ) {}

  isQuarantined(model: string): boolean {
    const s = this.state.get(model);
    return s !== undefined && s.until > this.now();
  }

  record(model: string, ok: boolean): void {
    if (ok) {
      this.state.delete(model);
      return;
    }
    const prev = this.state.get(model);
    const consecutiveBad = (prev?.consecutiveBad ?? 0) + 1;
    const until = consecutiveBad >= this.threshold ? this.now() + this.quarantineMs : (prev?.until ?? 0);
    this.state.set(model, { consecutiveBad, until });
  }
}
