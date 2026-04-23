import { Global, Module } from '@nestjs/common';
import { loadConfig } from '@bb/config';
import { createPool } from '@bb/db';
import type { Pool } from '@bb/db';

export const PG_POOL = 'PG_POOL' as const;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => createPool(loadConfig().databaseUrl),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
