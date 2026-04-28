import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import {
  BookingService,
  type ConfirmBookingResult,
} from './booking.service';

/**
 * Internal booking-confirm endpoint (ADR-024 C5c.3).
 *
 * Mounted at `/internal/bookings/...` to match the existing
 * `/internal/<area>/...` convention used by `FxController`,
 * `MarkupRuleAdminController`, and the Hotelbeds internal routes.
 *
 * `POST /internal/bookings/:id/confirm`
 *   Body:    { chargeCurrency: string }   // 3-letter uppercase ISO 4217
 *   200/201: ConfirmBookingResult
 *   400:     malformed body, terminal-state booking, unpriced booking,
 *            invalid chargeCurrency
 *   401:     missing/wrong X-Internal-Key
 *   404:     booking not found
 *   409:     race — booking state changed during confirm
 *
 * Status code 201 matches the existing internal-write convention in
 * this codebase (see `FxController.ecbSync` / `oxrSync`). Idempotent
 * re-confirms also return 201; the response body's `alreadyConfirmed`
 * flag distinguishes new vs replayed.
 *
 * Out of scope for this slice (deferred to C5c.4 / C5d):
 *   - public-facing booking endpoints
 *   - refund / cancellation routes
 *   - payment execution
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/bookings')
export class BookingController {
  constructor(
    @Inject(BookingService) private readonly service: BookingService,
  ) {}

  @Post(':id/confirm')
  @HttpCode(201)
  async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ConfirmBookingResult> {
    const { chargeCurrency } = parseConfirmBody(body);
    // Service-layer validation (chargeCurrency format, pricing-pinned
    // guard, terminal-state guard, etc.) is the source of truth.
    // The controller intentionally does NOT pre-validate
    // `chargeCurrency` shape so the service's BadRequestException
    // remains the single error-message surface.
    return this.service.confirm({ bookingId: id, chargeCurrency });
  }
}

function parseConfirmBody(body: unknown): { chargeCurrency: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const o = body as Record<string, unknown>;
  const chargeCurrency = o['chargeCurrency'];
  if (typeof chargeCurrency !== 'string') {
    throw new BadRequestException(
      'chargeCurrency is required and must be a string',
    );
  }
  return { chargeCurrency };
}
