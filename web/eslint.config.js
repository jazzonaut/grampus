// Lint rules for the dashboard client: typescript-eslint strictTypeChecked on .ts and .vue
// files, eslint-plugin-vue recommended, and Prettier owning layout (root .prettierrc.json).
import { configureVueProject, defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript';
import prettier from 'eslint-config-prettier/flat';
import pluginVue from 'eslint-plugin-vue';

configureVueProject({ scriptLangs: ['ts'], rootDir: import.meta.dirname });

export default defineConfigWithVueTs(
  { ignores: ['dist/**', 'node_modules/**'] },
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.strictTypeChecked,
  {
    name: 'grampus/rules',
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Numbers read naturally in UI strings; other types still need converting.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      complexity: ['error', 15],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      'vue/define-props-declaration': ['error', 'type-based'],
      'vue/define-emits-declaration': ['error', 'type-based'],
      'vue/require-explicit-slots': 'error',
      // Optional props stay optional: exactOptionalPropertyTypes forbids `undefined` defaults.
      'vue/require-default-prop': 'off',
    },
  },
  {
    name: 'grampus/tests',
    // Tests, their typed fixtures and helpers: long data is fine, and a missing fixture should fail loudly.
    files: ['src/**/*.test.ts', 'src/mock.ts', 'src/testing.ts'],
    rules: { 'max-lines': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
