import {
  Controller,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import {
  EcbFetcherService,
  type EcbSyncResult,
} from './ecb-fetcher.service';

@UseGuards(InternalAuthGuard)
@Controller('internal/fx')
export class FxController {
  constructor(
    @Inject(EcbFetcherService)
    private readonly ecbFetcher: EcbFetcherService,
  ) {}

  @Post('ecb-sync')
  @HttpCode(201)
  async ecbSync(): Promise<EcbSyncResult> {
    try {
      return await this.ecbFetcher.sync();
    } catch (err) {
      throw new InternalServerErrorException(
        err instanceof Error ? err.message : 'ECB sync failed',
      );
    }
  }
}
