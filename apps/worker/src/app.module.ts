import { Module } from '@nestjs/common';

// Queue processors and cron workers are registered here as NestJS modules.
// BullMQ processors land in Phase 1 alongside the first queue consumer.
@Module({
  imports: [],
})
export class AppModule {}
