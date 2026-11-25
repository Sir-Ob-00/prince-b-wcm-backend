import pg from 'pg';
import { config } from '../config/index.js';
export const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10000, max: 10 });
pool.on('error', error => console.error('Idle database connection error:', error.code));
