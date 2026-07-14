import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'old-app/**',
      'old-bridge/**',
      'old-n8n-flows/**',
      // reference marketing site (separate Astro project, not part of this app)
      'Zendori-Website/**',
      'apps/web/next-env.d.ts',
      // generated widget bundle (esbuild output, see apps/web/scripts/build-widget.mjs)
      'apps/web/public/widget.js',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
    },
    settings: {
      next: { rootDir: 'apps/web/' },
    },
  }
);
