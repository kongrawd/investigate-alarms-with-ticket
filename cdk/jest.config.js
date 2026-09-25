/** @type {import('jest').Config} */
module.exports = {
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
  // swc strips types without checking them — `npm run build` (tsc) is the type gate.
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  // Restores anything replaced with jest.spyOn/replaceProperty after each test so a
  // leaked spy cannot affect a later file.
  restoreMocks: true,
  collectCoverageFrom: ['lambda/**/*.ts', '!lambda/**/*.test.ts', '!lambda/**/*.fixtures.ts'],
};
