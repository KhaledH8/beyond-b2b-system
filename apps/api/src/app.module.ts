import { Module, type NestModule, type MiddlewareConsumer } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ObjectStorageModule } from './object-storage/object-storage.module';
import { AdaptersModule } from './adapters/adapters.module';
import { SearchModule } from './search/search.module';
import { AdminModule } from './admin/admin.module';
import { AdminAgenciesModule } from './admin-agencies/admin-agencies.module';
import { AdminAuditModule } from './admin-audit/admin-audit.module';
import { DirectContractsModule } from './direct-contracts/direct-contracts.module';
import { FxModule } from './fx/fx.module';
import { BookingModule } from './booking/booking.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { RequestIdMiddleware } from './audit/request-id.middleware';

@Module({
  imports: [
    DatabaseModule,
    ObjectStorageModule,
    AdaptersModule,
    HealthModule,
    SearchModule,
    AdminModule,
    AdminAgenciesModule,
    AdminAuditModule,
    DirectContractsModule,
    FxModule,
    BookingModule,
    AuthModule,
    AuditModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
