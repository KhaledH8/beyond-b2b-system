/**
 * OpenExchangeRates HTTP client.
 *
 * The free plan returns USD-base rates only, hourly, capped at 1,000
 * requests/month. Paid plans allow `?base=` to pick a different pivot
 * currency and publish more frequently. To make the upgrade a config
 * change rather than a rewrite:
 *
 *   - `appId` is read from env (`OXR_APP_ID`).
 *   - `baseUrl` is overridable via `OXR_BASE_URL` (so contract tests and
 *      paid-plan customers can target a sandbox or alternate region).
 *   - `baseCurrency` defaults to `USD` (only valid value on the free
 *      plan); paid plans set `OXR_BASE_CURRENCY=EUR`/`GBP`/etc. and the
 *      client appends `&base=` automatically.
 *
 * Freshness TTL is enforced inside `FxRateService` via `FxConfig`, not
 * here, so this client stays a thin wire-format layer.
 */

export interface OxrConfig {
  readonly appId: string;
  readonly baseUrl: string;
  readonly baseCurrency: string;
}

export function loadOxrConfig(): OxrConfig {
  return {
    appId: process.env['OXR_APP_ID'] ?? '',
    baseUrl:
      process.env['OXR_BASE_URL'] ?? 'https://openexchangerates.org/api',
    baseCurrency: process.env['OXR_BASE_CURRENCY'] ?? 'USD',
  };
}

/** Shape of a `GET /latest.json` response on both free and paid plans. */
export interface OxrLatestResponse {
  readonly base: string;
  /** Provider-stamped UTC unix seconds. */
  readonly timestamp: number;
  readonly rates: Record<string, number>;
}

export class OxrClient {
  constructor(private readonly cfg: OxrConfig) {}

  async fetchLatest(): Promise<OxrLatestResponse> {
    if (!this.cfg.appId) {
      throw new Error(
        'OXR_APP_ID env var must be set to fetch live FX rates from OpenExchangeRates',
      );
    }
    const params = new URLSearchParams({ app_id: this.cfg.appId });
    if (this.cfg.baseCurrency !== 'USD') {
      // Free plan rejects this with 403; paid plans accept it. Adding
      // the param only when non-default keeps free-plan requests clean.
      params.set('base', this.cfg.baseCurrency);
    }
    const url = `${this.cfg.baseUrl}/latest.json?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `OXR fetch failed: ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as OxrLatestResponse;
  }
}
