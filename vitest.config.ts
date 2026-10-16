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
        url: 'http://localhost/',
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
        'lib/agent/compaction.ts',
        'lib/agent/loop.ts',
        'lib/artifacts/gate.ts',
        'lib/artifacts/store.ts',
        'lib/chat/model.ts',
        'lib/chat/models.ts',
        'lib/chat/protocol.ts',
        'lib/diagnostics/redaction.ts',
        'lib/diagnostics/trace.ts',
        'lib/domain/chat.ts',
        'lib/storage/crypto.ts',
        'lib/tools/extract.ts',
        'lib/tools/page-access.ts',
        'lib/tools/read-artifact.ts',
        'lib/tools/read-current-page.ts',
        'lib/tools/registry.ts',
        'lib/tools/types.ts',
      ],
    },
  },
});
