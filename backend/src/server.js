const app = require('./app');
const config = require('./config');
const { startReminderScheduler } = require('./services/reminders');
const { ensureSchema } = require('./services/schemaGuard');

async function start() {
  if (config.runSchemaGuard) await ensureSchema();
  const server = app.listen(config.port, () => {
    console.log(`Challan API listening on port ${config.port}`);
    startReminderScheduler();
  });
  server.on('error', (err) => {
    console.error('Unable to start HTTP server:', err);
    process.exitCode = 1;
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 125000;
  server.keepAliveTimeout = 65000;

  const shutdown = async (signal) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(async () => {
      try {
        const db = require('./db');
        await db.pool.end();
        process.exit(0);
      } catch (err) {
        console.error('Shutdown failed:', err);
        process.exit(1);
      }
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Application startup failed:', err);
  process.exitCode = 1;
});
