// =============================================================================
// ESLint 9 flat configuration.
//
// The repository previously declared `lint` in package.json but shipped no
// config, so `npm run lint` exited with ESLint's "couldn't find eslint.config.js"
// error. This file is that config.
//
// Scope decisions
// ---------------
// - Type-aware linting is deliberately NOT enabled. `tsc --noEmit -p tsconfig.json`
//   already performs full type checking and is the authoritative type gate; running
//   it a second time inside ESLint would double the slowest gate in the project
//   for no additional safety.
// - The rule set is small and mostly about correctness hazards that the compiler
//   cannot see. Style is left to the existing Prettier-free formatting already in
//   the codebase, so this config does not churn untouched files.
// =============================================================================

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    // Nothing generated or vendored is linted. `dist` is esbuild output and
    // `node_modules` is managed by npm.
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'coverage/**',
      '**/*.d.ts',
      // Prisma's generated client and its post-install repair copies.
      'modules/module_11_database_event_system/generated/**',
    ],
  },

  // -- TypeScript: the whole server, modules, packages, scripts and tests ------
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Start from the recommended set, then override the handful of rules that
      // would otherwise force churn across the existing, working modules 5/11.
      ...tsPlugin.configs.recommended.rules,

      // `no-unused-vars` is replaced by the TypeScript-aware version below so
      // that type-only imports and `_`-prefixed names are handled correctly.
      //
      // `args: 'none'` is intentional. Module 11's repositories implement port
      // interfaces whose signatures include parameters a given implementation
      // does not need (`applyTransition` is handed `now`, `llm.resolve` is handed
      // an abort signal). Dropping those parameters from the implementations
      // would diverge them from the shared contract in packages/core/src/ports.ts
      // for no benefit, so unused parameters are not treated as defects.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // `any` is used at genuine framework seams (the RouteTable is typed as
      // `RouteDefinition<any>` by design, see packages/core/src/http.ts) and in
      // Prisma passthroughs. Banning it outright would be dishonest about where
      // the code lives, so it is reported as a warning rather than an error.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'error',

      'no-return-await': 'error',
      'no-throw-literal': 'error',

      // `require-await` is deliberately NOT enabled. Every Module 11 repository
      // method is declared `async` and returns the promise produced by
      // `guardDatabase(...)` without awaiting it internally, which is a
      // deliberate and correct shape: `guardDatabase` performs the error
      // translation and the `async` declaration is what puts the thrown
      // AppError on the caller's promise chain. The rule reported 92 violations,
      // every one of them this pattern, so enabling it would have required
      // rewriting working, tested persistence code to satisfy a style rule.

      // An empty catch block is how errors get swallowed silently, which this
      // system explicitly forbids. A comment inside the block is the sanctioned
      // escape hatch and is how `apps/server/src/app.ts` already handles a bad
      // websocket frame.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Correctness rules that are cheap and catch real bugs.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },

  // -- Browser: the dashboard and any module frontend -------------------------
  {
    files: ['apps/dashboard/src/**/*.{ts,tsx}', 'modules/*/frontend/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // -- Plain JavaScript: build and config scripts ------------------------------
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: false }],
      // `scripts/fix-prisma-client.mjs` scans generated Prisma output for a NUL
      // byte by design; that is the whole job of the script.
      'no-control-regex': 'off',
    },
  },

  // -- Test files: mocks and loose typing are expected -------------------------
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // ESLint 9 reports directives that suppress nothing. The repository's
    // `// eslint-disable-next-line no-console` in packages/core/src/runtime.ts
    // predates this config and targets a rule this config intentionally leaves
    // off (createConsoleLogger is the project's own logging implementation, so
    // banning console would ban the logger). Reporting it as an error would fail
    // the lint gate on a suppression comment that is doing the right thing.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
];
