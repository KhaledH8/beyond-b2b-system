export interface AppConfig {
  readonly port: number;
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly objectStorageEndpoint: string;
  readonly objectStorageBucket: string;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    nodeEnv: (process.env['NODE_ENV'] as AppConfig['nodeEnv']) ?? 'development',
    databaseUrl: requireEnv('DATABASE_URL'),
    redisUrl: requireEnv('REDIS_URL'),
    objectStorageEndpoint: process.env['OBJECT_STORAGE_ENDPOINT'] ?? 'http://localhost:9000',
    objectStorageBucket: process.env['OBJECT_STORAGE_BUCKET'] ?? 'beyond-borders-local',
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
