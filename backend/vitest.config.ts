import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // env.ts requires PZ_SERVER_DIR; provide safe test values.
    env: {
      NODE_ENV: 'test',
      // Pinned so suites never depend on the PZ_RUNTIME default, and so no
      // test can reach a real systemd unit or AMP instance.
      PZ_RUNTIME: 'standalone',
      PZ_SERVER_DIR: '/tmp/zpanel-test/Server',
      PZ_RCON_PASSWORD: 'test',
      SESSION_SECRET: 'test-session-secret-1234567890',
      PANEL_DB_PATH: '/tmp/zpanel-test/panel-test.db',
      PANEL_ORIGINS: 'http://localhost:8095',
    },
  },
});
