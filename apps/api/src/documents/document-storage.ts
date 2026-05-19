import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  OBJECT_STORAGE_BUCKET,
  S3_CLIENT,
} from '../object-storage/object-storage.module';

/**
 * Content-addressed JSON writer for booking documents (ADR-016 +
 * ADR-003 storage convention; mirrors `MinioRawPayloadStoragePort`).
 *
 * Object key layout:
 *   documents/<tenantId>/<documentType>/<YYYY>/<MM>/<DD>/<sha256>.json
 *
 * The sha256 of the canonical JSON bytes doubles as the filename, so
 * an identical document re-render overwrites itself deterministically
 * (cheap dedupe, stable reconciliation reference). The blob is written
 * BEFORE the issuing DB transaction begins: a transaction that later
 * rolls back leaves at most a harmless, content-addressed orphan blob
 * — never a committed document row without its bytes.
 */
@Injectable()
export class DocumentStorage {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(OBJECT_STORAGE_BUCKET) private readonly bucket: string,
  ) {}

  /**
   * Serialises `content` to canonical JSON, content-addresses it, and
   * writes it to object storage. Returns the storage key + hash to be
   * pinned on the `doc_booking_document` row.
   */
  async putJson(params: {
    readonly tenantId: string;
    readonly documentType: string;
    readonly content: unknown;
  }): Promise<{ objectStorageKey: string; contentHash: string; bytes: number }> {
    const json = JSON.stringify(params.content);
    const buf = Buffer.from(json, 'utf8');
    const contentHash = createHash('sha256').update(buf).digest('hex');

    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const objectStorageKey =
      `documents/${params.tenantId}/${params.documentType}/` +
      `${yyyy}/${mm}/${dd}/${contentHash}.json`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectStorageKey,
        Body: buf,
        ContentType: 'application/json',
        Metadata: {
          tenant: params.tenantId,
          documentType: params.documentType,
        },
      }),
    );

    return { objectStorageKey, contentHash, bytes: buf.length };
  }
}
