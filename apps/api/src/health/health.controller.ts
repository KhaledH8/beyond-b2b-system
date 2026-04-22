import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      version: process.env['npm_package_version'] ?? '0.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
