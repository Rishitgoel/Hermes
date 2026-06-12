import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Flat config mirroring frontend/eslint.config.js, adapted for the Node backend:
//   - globals.node instead of globals.browser
//   - type-aware linting (parserOptions.projectService) so @typescript-eslint/
//     no-floating-promises can run — it needs type info. This catches a route
//     handler that forgets the `.catch(next)` (or any unhandled async call).
// Only src/**/*.ts is linted; the config file, scripts/, and prisma/ stay out of
// the typed project (they aren't part of tsconfig's `include`).
export default tseslint.config(
  // Test files are excluded from tsconfig (Vitest owns them), so the typed project
  // doesn't cover them — keep them out of lint too rather than fight the type service.
  { ignores: ['dist', 'node_modules', 'coverage', 'src/**/*.test.ts', 'src/**/*.spec.ts', 'src/test/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Pragmatic for this codebase (matches frontend): it leans on `any` for
      // dynamic payloads and `catch (e: any)`. Keep lint actionable.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The headline rule for the backend: an un-awaited / un-caught promise is a
      // dropped error. Routes must `.catch(next)`; fire-and-forget must be `void`-ed.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
