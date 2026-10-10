import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { adminLoginMode } from './auth.js';
import { describeSmtp, loadConfig } from './config.js';
import { Store } from './db.js';
import { Outbox, createSmtpTransport } from './mailer.js';
import { loadScanner } from './scanner.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const store = new Store(path.join(config.dataDir, 'storelint.db'));
const scanner = await loadScanner();

function cleanup(): void {
  try {
    const removed = store.deleteExpiredReports(config.reportTtlMs);
    if (removed > 0) console.log(`[cleanup] removed ${removed} expired report(s)`);
    store.deleteExpiredSessions();
  } catch (err) {
    console.error('[cleanup] failed:', err);
  }
}
cleanup();
const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();

console.log(describeSmtp(config.smtp));
const loginMode = adminLoginMode(config);
console.log(
  `[admin] login: ${
    loginMode === 'hash'
      ? 'ADMIN_PASSWORD_HASH'
      : loginMode === 'plain'
        ? `ADMIN_PASSWORD (plain${config.adminPasswordHash ? '; ADMIN_PASSWORD_HASH is set but malformed' : ''}; prefer ADMIN_PASSWORD_HASH)`
        : `disabled (${config.adminPasswordHash ? 'ADMIN_PASSWORD_HASH is malformed' : 'set ADMIN_PASSWORD_HASH'})`
  }, api token: ${config.adminToken ? 'set' : 'unset'}, notifications to ${config.notifyEmail}`,
);

const outbox = new Outbox({
  store,
  from: { name: config.smtp.fromName, address: config.smtp.from ?? config.notifyEmail },
  transport: config.smtp.configured ? createSmtpTransport(config.smtp) : undefined,
});
outbox.start();

const app = createApp({ store, config, scanner, outbox });

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(
    `storelint-web listening on http://${info.address}:${info.port} (scanner: ${scanner.source}, data: ${config.dataDir}, reports stored: ${store.countReports()}, checkout: ${
      config.paymentsEnabled
        ? `flutterwave ${config.flutterwave.version} ${config.flutterwave.currency}${config.flutterwave.webhookHash ? '' : ', no webhook hash'}`
        : config.flutterwave.configured
          ? `off (flutterwave ${config.flutterwave.version} configured, set FLW_V4_PAYMENT_METHOD to enable checkout)`
          : 'off'
    })`,
  );
});

function shutdown(signal: string): void {
  console.log(`[shutdown] ${signal} received`);
  clearInterval(cleanupTimer);
  outbox.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
