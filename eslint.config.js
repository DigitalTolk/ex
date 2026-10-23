import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // One <select> for the whole app, styled like Input: hand-styled ones
    // never lined up with the text fields next to them.
    files: ['src/**/*.tsx'],
    ignores: ['src/components/ui/native-select.tsx', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: 'Use NativeSelect from @/components/ui/native-select.',
        },
        {
          selector: "JSXAttribute[name.name='type'][value.value='number']",
          message: 'No <input type="number">: use a text field with inputMode="numeric" (see lib/numeric-field).',
        },
        // Type floor (CLAUDE.md): 12px (text-xs) is the smallest size, and
        // nothing renders at 13px either.
        {
          selector: 'Literal[value=/text-\\[(?:[0-9]|1[013])(?:\\.[0-9]+)?px\\]/]',
          message: 'Below the type floor: use text-xs (12px) or text-sm (14px).',
        },
        {
          selector: 'TemplateElement[value.raw=/text-\\[(?:[0-9]|1[013])(?:\\.[0-9]+)?px\\]/]',
          message: 'Below the type floor: use text-xs (12px) or text-sm (14px).',
        },
      ],
    },
  },
  {
    files: ['src/components/ui/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['src/context/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'components.json'],
  },
]);
