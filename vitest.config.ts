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
        'lib/diagnostics/recorder.ts',
        'lib/diagnostics/redaction.ts',
        'lib/diagnostics/report.ts',
        'lib/domain/chat.ts',
        'lib/generation/errors.ts',
        'lib/generation/manager.ts',
        'lib/generation/pi-adapter.ts',
        'lib/generation/resolve.ts',
        'lib/ipc/protocol.ts',
        'lib/llm/client.ts',
        'lib/providers/client.ts',
        'lib/providers/discovery.ts',
        'lib/providers/permissions.ts',
        'lib/providers/registry.ts',
        'lib/providers/service.ts',
        'lib/providers/store.ts',
        'lib/storage/access.ts',
        'entrypoints/sidepanel/usePort.ts',
      ],
      thresholds: {
        statements: 95,
        branches: 89,
        functions: 95,
        lines: 97,
      },
    },
  },
});
