// @ts-check
import tsEslint from 'typescript-eslint';

const ALL_BB = [
  '@bb/domain',
  '@bb/supplier-contract',
  '@bb/ledger',
  '@bb/payments',
  '@bb/rewards',
  '@bb/documents',
  '@bb/reseller',
  '@bb/rate-intelligence',
  '@bb/ui',
  '@bb/config',
  '@bb/testing',
];

// Backend-internal packages that frontend apps must never import
const BACKEND_INTERNAL = [
  '@bb/ledger',
  '@bb/payments',
  '@bb/rewards',
  '@bb/documents',
  '@bb/reseller',
  '@bb/supplier-contract',
  '@bb/rate-intelligence',
];

function forbid(allowed, message) {
  return ALL_BB.filter((p) => !allowed.includes(p)).map((name) => ({
    group: [name],
    message: message.replace('{name}', name),
  }));
}

export default tsEslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.js', '**/*.mjs'] },

  ...tsEslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },

  // --- Dependency direction enforcement ---

  {
    // domain: zero internal dependencies (ADR-011)
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain'], "packages/domain must have zero internal dependencies. Remove '{name}'.") },
      ],
    },
  },
  {
    // supplier-contract: only @bb/domain (ADR-011)
    files: ['packages/supplier-contract/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain', '@bb/supplier-contract'], "packages/supplier-contract may only depend on @bb/domain. Remove '{name}'.") },
      ],
    },
  },
  {
    // rate-intelligence: only @bb/domain — pricing depends on it, never the reverse (ADR-011, ADR-015)
    files: ['packages/rate-intelligence/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain', '@bb/rate-intelligence'], "packages/rate-intelligence may only depend on @bb/domain. Remove '{name}'.") },
      ],
    },
  },
  {
    // ledger: only @bb/domain (ADR-011)
    files: ['packages/ledger/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain', '@bb/ledger'], "packages/ledger may only depend on @bb/domain. Remove '{name}'.") },
      ],
    },
  },
  {
    // payments: @bb/domain + @bb/ledger (ADR-011)
    files: ['packages/payments/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain', '@bb/ledger', '@bb/payments'], "packages/payments may only depend on @bb/domain and @bb/ledger. Remove '{name}'.") },
      ],
    },
  },
  {
    // reseller: only @bb/domain (ADR-011 amendment ADR-016/017)
    files: ['packages/reseller/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain', '@bb/reseller'], "packages/reseller may only depend on @bb/domain. Remove '{name}'.") },
      ],
    },
  },
  {
    // documents: @bb/domain + @bb/ledger (read) + @bb/reseller (branding)
    files: ['packages/documents/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: forbid(['@bb/domain', '@bb/ledger', '@bb/reseller', '@bb/documents'], "packages/documents may only depend on @bb/domain, @bb/ledger, and @bb/reseller. Remove '{name}'.") },
      ],
    },
  },
  {
    // Frontend apps: never import backend-internal packages (ADR-011)
    files: [
      'apps/b2c-web/**/*.ts',
      'apps/b2c-web/**/*.tsx',
      'apps/b2b-portal/**/*.ts',
      'apps/b2b-portal/**/*.tsx',
      'apps/admin/**/*.ts',
      'apps/admin/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: BACKEND_INTERNAL.map((name) => ({
            group: [name],
            message: `Frontend apps must not import backend-internal packages. Remove '${name}'.`,
          })),
        },
      ],
    },
  },
);
