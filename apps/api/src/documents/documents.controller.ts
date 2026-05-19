import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import {
  BookingConfirmationService,
  type DocumentView,
} from './booking-confirmation.service';

/**
 * Internal documents endpoint (ADR-016, Booking Documents Foundation
 * Slice 1).
 *
 * The endpoint is **documents-owned**, not booking-owned: ADR-011's
 * import direction forbids the `booking` module depending on
 * `documents`, so document issue lives here and reads booking tables
 * by parameterised SQL.
 *
 * `POST /internal/documents/booking-confirmation`
 *   Body:    { bookingId: string }
 *   201:     { document: DocumentView, replayed: boolean }
 *   400:     malformed body / bad bookingId
 *   401:     missing/wrong X-Internal-Key
 *   404:     booking not found
 *   422:     booking not CONFIRMED / no pinned booking-time snapshot
 *
 * Status code 201 matches the existing internal-write convention
 * (FxController, BookingController). Replays also return 201; the
 * body's `replayed` flag distinguishes new vs replayed.
 *
 * Out of scope: PDF/HTML rendering, email/delivery, public download
 * links, voucher, tax invoice, reseller branding, async document
 * worker.
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/documents')
export class DocumentsController {
  constructor(
    @Inject(BookingConfirmationService)
    private readonly service: BookingConfirmationService,
  ) {}

  @Post('booking-confirmation')
  @HttpCode(201)
  async issueBookingConfirmation(
    @Body() body: unknown,
  ): Promise<{ document: DocumentView; replayed: boolean }> {
    return this.service.issue(body);
  }
}
