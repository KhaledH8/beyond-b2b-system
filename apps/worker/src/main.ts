import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  console.log('[worker] started — queue consumers will register here in Phase 1');

  // Keep the process alive; BullMQ workers hold the event loop open.
  // For Phase 0 this is just a health signal.
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });
}

void bootstrap();
