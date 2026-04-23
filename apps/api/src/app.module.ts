import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ObjectStorageModule } from './object-storage/object-storage.module';
import { AdaptersModule } from './adapters/adapters.module';

@Module({
  imports: [DatabaseModule, ObjectStorageModule, AdaptersModule, HealthModule],
})
export class AppModule {}
