// Reglas de calidad del proyecto. El formato lo decide Prettier (ver .prettierrc),
// por eso al final se apagan las reglas de estilo que chocarían con él.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Cliente generado por prisma generate.
      'src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      // Los logs pasan por el logger de Nest (JSON, con request id). La consola solo la usan
      // las herramientas de línea de comandos de src/cli/.
      'no-console': 'error',
    },
  },
  {
    // Herramientas de línea de comandos: imprimen su resultado en la consola.
    files: ['src/cli/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    // Scripts de Node fuera del servicio (el transformador de Jest): CommonJS.
    files: ['test/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-console': 'off' },
  },
  prettier,
);
