import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { ObjectStorageModule } from '../object-storage/object-storage.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { DocumentContentRepository } from './document-content.repository';
import { DocumentRepository } from './document.repository';
import { DocumentStorage } from './document-storage';
import { BookingConfirmationService } from './booking-confirmation.service';
import { DocumentsController } from './documents.controller';

/**
 * Documents module (ADR-016, Booking Documents Foundation Slice 1).
 *
 * Owns the `doc_` tables and the `/internal/documents/...` surface.
 * Deliberately does NOT import `BookingModule` — ADR-011 forbids the
 * `booking → documents` import edge and we keep the reverse edge out
 * too; document content is read from booking-owned tables by
 * parameterised SQL via `DocumentContentRepository`.
 *
 * Imports `AuditModule` so `BOOKING_DOCUMENT_CREATED` is written in
 * the issue transaction even when this module is booted in isolation
 * in tests (AuditModule is @Global in the full app). Imports
 * `ObjectStorageModule` for the content-addressed JSON writer (also
 * @Global in the full app, explicit here for isolated test graphs).
 *
 * Out of scope (later, deliberate slices): PDF/HTML rendering,
 * email/delivery, public download links, voucher, tax invoice,
 * reseller branding, the async document-issue worker.
 */
@Module({
  imports: [DatabaseModule, AuditModule, ObjectStorageModule],
  controllers: [DocumentsController],
  providers: [
    InternalAuthGuard,
    DocumentContentRepository,
    DocumentRepository,
    DocumentStorage,
    BookingConfirmationService,
  ],
  exports: [BookingConfirmationService],
})
export class DocumentsModule {}
