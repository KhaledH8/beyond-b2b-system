import { describe, expect, it } from 'vitest';
import { generateBookingReference } from '../booking-reference';

describe('generateBookingReference', () => {
  it('matches the BB-YYYY-NNNNN shape', () => {
    const ref = generateBookingReference(new Date('2026-05-15T00:00:00Z'));
    expect(ref).toMatch(/^BB-2026-\d{5}$/);
  });

  it('uses the UTC year of the supplied date', () => {
    const ref = generateBookingReference(new Date('2027-01-01T00:00:00Z'));
    expect(ref.startsWith('BB-2027-')).toBe(true);
  });

  it('zero-pads the numeric suffix to 5 digits', () => {
    for (let i = 0; i < 200; i++) {
      const ref = generateBookingReference();
      const suffix = ref.split('-')[2]!;
      expect(suffix).toHaveLength(5);
    }
  });

  it('varies the suffix across calls (not a constant)', () => {
    const refs = new Set(
      Array.from({ length: 50 }, () => generateBookingReference()),
    );
    expect(refs.size).toBeGreaterThan(1);
  });
});
