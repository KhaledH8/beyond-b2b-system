export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface HotelAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly stateOrRegion?: string;
  readonly postalCode?: string;
  readonly countryCode: string;
}

export type MappingStatus = 'PENDING' | 'MAPPED' | 'CONFLICT' | 'REJECTED';

export interface SupplierHotelRef {
  readonly supplierId: string;
  readonly supplierHotelId: string;
  readonly mappingStatus: MappingStatus;
  readonly mappedAt?: Date;
  readonly mappingConfidence?: number;
}

export interface CanonicalHotel {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly address: HotelAddress;
  readonly geo: GeoPoint;
  readonly starRating?: number;
  readonly chainCode?: string;
  readonly brandCode?: string;
  readonly supplierRefs: SupplierHotelRef[];
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type HotelMappingDecisionKind =
  | 'DETERMINISTIC_AUTO'
  | 'FUZZY_AUTO'
  | 'HUMAN_CONFIRMED'
  | 'HUMAN_REJECTED';

export interface HotelMappingRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly canonicalHotelId: string;
  readonly supplierId: string;
  readonly supplierHotelId: string;
  readonly decisionKind: HotelMappingDecisionKind;
  readonly confidence?: number;
  readonly reviewedBy?: string;
  readonly createdAt: Date;
}
