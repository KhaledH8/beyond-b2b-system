export interface AppConfig {
  readonly port: number;
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly objectStorageEndpoint: string;
  readonly objectStorageBucket: string;
  /** MinIO/S3 access key. Required when adapters write raw payloads. */
  readonly objectStorageAccessKey: string;
  /** MinIO/S3 secret key. */
  readonly objectStorageSecretKey: string;
  /** AWS-compatible region; MinIO accepts any string, defaults to us-east-1. */
  readonly objectStorageRegion: string;
  /** S3-style addressing. MinIO requires path-style (forcePathStyle=true). */
  readonly objectStorageForcePathStyle: boolean;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    nodeEnv: (process.env['NODE_ENV'] as AppConfig['nodeEnv']) ?? 'development',
    databaseUrl: requireEnv('DATABASE_URL'),
    redisUrl: requireEnv('REDIS_URL'),
    objectStorageEndpoint: process.env['OBJECT_STORAGE_ENDPOINT'] ?? 'http://localhost:9000',
    objectStorageBucket: process.env['OBJECT_STORAGE_BUCKET'] ?? 'beyond-borders-local',
    objectStorageAccessKey: process.env['OBJECT_STORAGE_ACCESS_KEY'] ?? 'bb_local',
    objectStorageSecretKey: process.env['OBJECT_STORAGE_SECRET_KEY'] ?? 'bb_local_secret',
    objectStorageRegion: process.env['OBJECT_STORAGE_REGION'] ?? 'us-east-1',
    objectStorageForcePathStyle:
      (process.env['OBJECT_STORAGE_FORCE_PATH_STYLE'] ?? 'true').toLowerCase() === 'true',
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
