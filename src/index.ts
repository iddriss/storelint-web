import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { loadScanner } from './scanner.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = new Store(path.join(config.dataDir, 'storelint.db'));
const scanner = await loadScanner();

function cleanup(): void {
  try {
    const removed = store.deleteExpiredReports(config.reportTtlMs);
    if (removed > 0) console.log(`[cleanup] removed ${removed} expired report(s)`);
  } catch (err) {
    console.error('[cleanup] failed:', err);
  }
}
cleanup();
const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();

const app = createApp({ store, config, scanner });

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(
    `storelint-web listening on http://${info.address}:${info.port} (scanner: ${scanner.source}, data: ${config.dataDir}, reports stored: ${store.countReports()})`,
  );
});

function shutdown(signal: string): void {
  console.log(`[shutdown] ${signal} received`);
  clearInterval(cleanupTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
