import type { Knex } from 'knex';
import { ModuleMigrationSource } from './migration-source';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable not set: ${name}`);
  return value;
}

const config: Knex.Config = {
  client: 'pg',
  connection: requireEnv('DATABASE_URL'),
  pool: { min: 0, max: 3 },
  migrations: {
    tableName: 'knex_migrations',
    migrationSource: new ModuleMigrationSource(),
  },
};

export default config;
