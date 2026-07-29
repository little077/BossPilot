import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    pool: 'threads',
    environmentOptions: {
      jsdom: {
        url: 'https://www.zhipin.com/web/geek/job',
      },
    },
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.output/**', '.wxt/**', 'coverage/**', 'design-prototype/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: [
        'lib/adapter/city-codes.ts',
        'lib/adapter/zhipin.ts',
        'lib/diagnostics/redaction.ts',
        'lib/domain/chat.ts',
        'lib/llm/client.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
