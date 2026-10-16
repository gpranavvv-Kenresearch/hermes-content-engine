import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'supervisor-hermes/tests/**/*.test.ts', 'performance-engine/tests/**/*.test.ts'],
    environment: 'node',
    // The first jsdom/Defuddle import can take many seconds on a busy machine with a
    // OneDrive-synced path; the default 5s timeout produced false failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
