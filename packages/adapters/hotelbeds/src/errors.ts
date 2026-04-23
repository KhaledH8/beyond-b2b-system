export class HotelbedsAdapterError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'HotelbedsAdapterError';
  }
}

export class HotelbedsNotImplementedError extends HotelbedsAdapterError {
  constructor(operation: string) {
    super(
      `Hotelbeds adapter operation '${operation}' is not implemented in the Phase 1 scaffold. ` +
        `Booking confirmation, cancellation, and live HTTP calls land in Phase 2 (see roadmap.md).`,
      'NOT_IMPLEMENTED',
    );
    this.name = 'HotelbedsNotImplementedError';
  }
}
