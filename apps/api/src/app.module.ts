import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ObjectStorageModule } from './object-storage/object-storage.module';
import { AdaptersModule } from './adapters/adapters.module';
import { SearchModule } from './search/search.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    DatabaseModule,
    ObjectStorageModule,
    AdaptersModule,
    HealthModule,
    SearchModule,
    AdminModule,
  ],
})
export class AppModule {}
