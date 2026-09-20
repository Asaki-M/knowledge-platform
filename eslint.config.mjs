import antfu from '@antfu/eslint-config'

export default antfu(
  {
    isInEditor: false,
    typescript: true,
    react: true,
    test: {
      // Server integration tests use Node's built-in test runner.
      overrides: { 'test/no-import-node-test': 'off' },
    },
    ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml'],
  },
  {
    files: ['app/src/components/ui/**/*.tsx'],
    rules: {
      // shadcn/ui exports reusable variant helpers alongside components.
      'react-refresh/only-export-components': ['error', { allowExportNames: ['buttonVariants'] }],
    },
  },
)
