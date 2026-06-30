// Root ESLint config (issue #48) — lints the CommonJS Node server code.
// The client (ESM/React) has its own flat config in client/eslint.config.js and
// is linted separately via `npm run lint --prefix client`, so it's ignored here.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'client/**',        // linted by the client's own config
      'gateway/**',        // generated / third-party config
      '**/*.min.js',
      'coverage/**',
    ],
  },
  {
    files: ['server/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        // Modern Node runtime globals used across the server.
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        WebSocket: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      // Intentional ignored failures are common (cleanup, best-effort aborts,
      // probes). The codebase documents them with a trailing comment and uses
      // logSwallowed() where it matters — don't force a churn here.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Ignore deliberately-unused caught errors and UPPER_CASE/_-prefixed vars.
      'no-unused-vars': ['error', {
        caughtErrors: 'none',
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
      }],
    },
  },
];
