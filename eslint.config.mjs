import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'public/js/**',      // Frontend browser JS — separate pass if needed
      'playwright-report/**',
      'test-results/**',
      '.tmp/**',
      'debug/**',
    ],
  },
  // Node.js backend (CommonJS)
  {
    files: ['server.js', 'migrate.js', 'morningNudge.js', 'routes/**/*.js', 'middleware/**/*.js', 'lib/**/*.js', 'scripts/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Error-level: real bugs
      'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-undef': 'error',
      'no-duplicate-case': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-sparse-arrays': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-fallthrough': 'error',
      'no-redeclare': 'error',

      // Security-relevant
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Warning-level: code smell
      'no-console': 'off',   // Express server — console OK; TODO: migrate to structured logger
      'no-var': 'warn',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
    },
  },
  // Test files
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js', 'tests/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-undef': 'error',
      'no-console': 'off',
    },
  },
];
