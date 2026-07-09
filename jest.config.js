module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^matrix-js-sdk$': '<rootDir>/tests/__mocks__/matrix-js-sdk.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: 'reports', outputName: 'junit.xml' }],
  ],
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: 'reports/coverage',
  coverageReporters: ['text-summary'],
  collectCoverageFrom: ['src/**/*.ts'],
};
