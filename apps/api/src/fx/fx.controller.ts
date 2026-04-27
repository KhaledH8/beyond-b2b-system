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
import {
  OxrSyncService,
  type OxrSyncResult,
} from './oxr-sync.service';

@UseGuards(InternalAuthGuard)
@Controller('internal/fx')
export class FxController {
  constructor(
    @Inject(EcbFetcherService)
    private readonly ecbFetcher: EcbFetcherService,
    @Inject(OxrSyncService)
    private readonly oxrSyncer: OxrSyncService,
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

  @Post('oxr-sync')
  @HttpCode(201)
  async oxrSync(): Promise<OxrSyncResult> {
    try {
      return await this.oxrSyncer.sync();
    } catch (err) {
      throw new InternalServerErrorException(
        err instanceof Error ? err.message : 'OXR sync failed',
      );
    }
  }
}
