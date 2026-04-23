import { Inject, Injectable } from '@nestjs/common';
import type { SupplierAdapter } from '@bb/supplier-contract';
import { HOTELBEDS_ADAPTER } from './hotelbeds/hotelbeds.module';

/**
 * Runtime lookup table from supplier code to `SupplierAdapter`.
 *
 * Phase 1 has exactly one supplier (Hotelbeds). As additional
 * adapters scaffold (WebBeds, TBO, direct CRS), they register here
 * with the same contract — downstream code continues to ask the
 * registry for `adapter(supplierCode)` without caring which
 * implementation answers.
 */
@Injectable()
export class SupplierAdapterRegistry {
  private readonly bySupplierCode: ReadonlyMap<string, SupplierAdapter>;

  constructor(
    @Inject(HOTELBEDS_ADAPTER) hotelbeds: SupplierAdapter,
  ) {
    this.bySupplierCode = new Map<string, SupplierAdapter>([
      [hotelbeds.meta.supplierId, hotelbeds],
    ]);
  }

  get(supplierCode: string): SupplierAdapter {
    const adapter = this.bySupplierCode.get(supplierCode);
    if (!adapter) {
      throw new Error(`No registered adapter for supplier code: ${supplierCode}`);
    }
    return adapter;
  }

  list(): ReadonlyArray<SupplierAdapter> {
    return Array.from(this.bySupplierCode.values());
  }
}
