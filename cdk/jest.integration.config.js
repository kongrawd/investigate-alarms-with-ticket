const base = require('./jest.config');

/**
 * Integration suite: talks to a live Agent Space. Kept in its own config rather than
 * behind CLI flags, because `--testPathIgnorePatterns` on the command line replaces the
 * value from the config instead of adding to it, which is easy to get subtly wrong.
 *
 *   npm run test:integration
 *
 * Requires AGENT_SPACE_ID and WEBHOOK_SECRET_ARN; set RUN_BILLABLE_TESTS=1 to also run
 * the cases that start real investigations.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  displayName: 'integration',
  roots: ['<rootDir>/test/integration'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Agent Space quotas are low (3 concurrent investigations, 1 invocation per custom
  // agent), so these run one at a time rather than racing each other.
  maxWorkers: 1,
  // An investigation takes minutes; polling cases need room to finish.
  testTimeout: 5 * 60 * 1000,
};
