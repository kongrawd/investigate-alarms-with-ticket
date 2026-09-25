/** @type {import('jest').Config} */
module.exports = {
  displayName: 'unit',
  testEnvironment: 'node',
  // Unit tests live beside the code they cover under lambda/; test/ holds the CDK
  // template tests. Integration tests are excluded here and run from
  // jest.integration.config.js, so `npm test` is always hermetic.
  roots: ['<rootDir>/lambda', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/integration/'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  // Sets POWERTOOLS_LOG_LEVEL before any module constructs the Logger.
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // swc strips types without checking them — `npm run build` (tsc) is the type gate.
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  // Restores anything replaced with jest.spyOn/replaceProperty after each test so a
  // leaked spy cannot affect a later file.
  restoreMocks: true,
  // lib/ is included because the template tests exercise the stack; leaving it out
  // under-reported what is actually covered.
  collectCoverageFrom: [
    'lambda/**/*.ts',
    'lib/**/*.ts',
    '!lambda/**/*.test.ts',
    '!lambda/**/*.fixtures.ts',
  ],
  // A ratchet just under the current numbers, so coverage cannot quietly regress. Raise it
  // when it climbs; never lower it to make a change pass.
  coverageThreshold: {
    global: { statements: 99, branches: 92, functions: 100, lines: 99 },
  },
};
