/**
 * Currency minor-unit metadata shared across the platform.
 *
 * Travel inventory in scope today exposes only four zero-decimal
 * currencies. Anything else is treated as a 2-decimal currency.
 * ADR-020 forbids silent currency assumptions, so this table is small
 * and obvious — adding a currency is a deliberate edit, not a guess.
 *
 * Lives in `@bb/domain` (not `@bb/pricing`) so that `@bb/fx` and any
 * other downstream consumer can reuse it without taking a dependency
 * on the pricing evaluator. `@bb/pricing → @bb/fx → @bb/pricing` would
 * otherwise become a cycle once C4 wires FX into the pricing path.
 */

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'ISK']);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}
