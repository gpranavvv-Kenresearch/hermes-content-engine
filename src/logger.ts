import { randomUUID } from 'node:crypto';
import pino, { type DestinationStream, type Logger } from 'pino';

/** Field paths whose values must never reach a log line. */
export const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'api_key',
  'cookie',
  'cookies',
  'authorization',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.cookie',
  '*.cookies',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
];

export interface LoggerOptions {
  level?: string;
  runId?: string;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const base = { runId: options.runId ?? randomUUID() };
  const config = {
    level: options.level ?? 'info',
    base,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}
