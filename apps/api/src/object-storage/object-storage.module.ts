import { Global, Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@bb/config';

export const S3_CLIENT = 'S3_CLIENT' as const;
export const OBJECT_STORAGE_BUCKET = 'OBJECT_STORAGE_BUCKET' as const;

/**
 * Single S3-compatible client used by every adapter that persists raw
 * payloads (ADR-003). Local dev points at MinIO; staging/prod will
 * swap the endpoint + credentials without changing adapter code.
 *
 * The bucket itself is provisioned out-of-band (MinIO console or a
 * one-shot init container). Creating it here would widen this
 * module's responsibility into infra and race on startup.
 */
@Global()
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      useFactory: (): S3Client => {
        const cfg = loadConfig();
        return new S3Client({
          region: cfg.objectStorageRegion,
          endpoint: cfg.objectStorageEndpoint,
          forcePathStyle: cfg.objectStorageForcePathStyle,
          credentials: {
            accessKeyId: cfg.objectStorageAccessKey,
            secretAccessKey: cfg.objectStorageSecretKey,
          },
        });
      },
    },
    {
      provide: OBJECT_STORAGE_BUCKET,
      useFactory: (): string => loadConfig().objectStorageBucket,
    },
  ],
  exports: [S3_CLIENT, OBJECT_STORAGE_BUCKET],
})
export class ObjectStorageModule {}
