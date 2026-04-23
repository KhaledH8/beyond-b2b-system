import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type {
  RawPayloadRef,
  RawPayloadStoragePort,
} from '@bb/adapter-hotelbeds';
import {
  OBJECT_STORAGE_BUCKET,
  S3_CLIENT,
} from '../../object-storage/object-storage.module';

/**
 * MinIO-backed raw payload writer for Hotelbeds responses (ADR-003:
 * raw payloads are kept verbatim, content-addressed).
 *
 * Object key layout:
 *   hotelbeds/<purpose>/<YYYY>/<MM>/<DD>/<sha256>
 *
 * The hash doubles as the filename so repeated writes of an identical
 * payload overwrite themselves deterministically — cheap dedupe, and
 * a stable reference for reconciliation. The date prefix gives us
 * reasonable bucket locality for lifecycle rules later.
 *
 * We do NOT set `If-None-Match` / conditional PUTs because MinIO
 * tolerates idempotent overwrites and the hash keeps writes
 * content-identical.
 */
@Injectable()
export class MinioRawPayloadStoragePort implements RawPayloadStoragePort {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(OBJECT_STORAGE_BUCKET) private readonly bucket: string,
  ) {}

  async put(params: {
    readonly tenantId: string;
    readonly supplierId: string;
    readonly purpose: 'HOTELS_PAGE' | 'AVAILABILITY';
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<RawPayloadRef> {
    const hash = createHash('sha256').update(params.bytes).digest('hex');
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const purposeSlug = params.purpose.toLowerCase();
    const storageRef = `${params.supplierId}/${purposeSlug}/${yyyy}/${mm}/${dd}/${hash}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageRef,
        Body: params.bytes,
        ContentType: params.contentType,
        Metadata: {
          tenant: params.tenantId,
          supplier: params.supplierId,
          purpose: params.purpose,
        },
      }),
    );

    return { hash, storageRef };
  }
}
