import { app, sessionStore } from './app.js';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
await pool.query('SELECT 1');
const server = app.listen(config.port, () => console.log(`WCM listening on http://127.0.0.1:${config.port}; admin at /admin/`));
async function shutdown() { server.close(async () => { sessionStore.close(); await pool.end(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
