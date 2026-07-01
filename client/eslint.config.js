import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // React 19's compiler-oriented rules are useful as warnings, but
      // set-state-in-effect is too noisy for this app's existing fetch-on-mount
      // screens. Keep exhaustive-deps visible; gate concrete syntax/errors.
      'react-hooks/set-state-in-effect': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        caughtErrors: 'none',
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
      }],
    },
  },
])
