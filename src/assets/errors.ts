import { EngineError } from '../errors.js';

/** The card input broke a rule (unverified fact, disallowed source, missing label ...). No image is produced. */
export class CardInputError extends EngineError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Card input rejected (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n - ${issues.join('\n - ')}`, 'fatal', 'CARD_INPUT_INVALID', {
      detail: { issues },
    });
    this.issues = issues;
  }
}

/** The chart data was empty, mixed units, or otherwise unusable. No image is produced. */
export class ChartInputError extends EngineError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Chart input rejected (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n - ${issues.join('\n - ')}`, 'fatal', 'CHART_INPUT_INVALID', {
      detail: { issues },
    });
    this.issues = issues;
  }
}

/** No usable font could be located for Satori/resvg. */
export class FontNotFoundError extends EngineError {
  constructor(tried: string[]) {
    super(
      `No usable font found. Set CE_FONT_PATH to a .ttf/.otf file. Tried: ${tried.join(', ')}`,
      'fatal',
      'FONT_NOT_FOUND',
      { detail: { tried } },
    );
  }
}

export class AssetRenderError extends EngineError {
  constructor(message: string, cause?: unknown) {
    super(message, 'fatal', 'ASSET_RENDER_FAILED', cause === undefined ? {} : { cause });
  }
}
