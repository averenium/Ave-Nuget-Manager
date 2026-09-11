// Flat config for ESLint 10. The `lint` script had always been in package.json,
// but nothing it needs was ever installed, so this is the first run the rules
// have ever had — which is also why the set below is deliberately small: the
// point is a check that passes clean and stays honest, not a backlog.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'demo/**', 'docs/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript resolves identifiers itself, and this rule knows neither the
      // Node globals the host half runs with nor the DOM ones the webview has.
      'no-undef': 'off',
      // An escape that a character class does not strictly need is not a
      // defect. The parsing regexes here spell out `\-`, `\(` and `\[` on
      // purpose: they are read far more often than they are written, and the
      // literal spelling says what is being matched without the reader having
      // to recall which characters lose their meaning inside a class.
      'no-useless-escape': 'off',
      // `let x; … () => x; x = …` is how a callback is handed something built
      // after it: the read is what stops this from being a `const`, and the
      // rule offers a fix that would not compile.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // An unused argument is how a function states a signature it does not use
      // all of; a leading underscore is how to say that on purpose.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
  {
    // The hook rules are what would have caught the "hook after an early
    // return" crash of #82. The rest of this plugin's recommended set is the
    // React Compiler's, and asks for refactors this codebase has not made yet.
    files: ['src/webview/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests reach into shapes the types do not describe — a posted message cast
    // to read one field, a `require` to re-import a module under a fresh mock.
    // Both are how the suite is written, and neither says anything about the
    // code that ships.
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
