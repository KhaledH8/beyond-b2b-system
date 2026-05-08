import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import type { Request } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Raw-body capture for HMAC-signed routes (E2-B Auth0 webhook).
  // The body parser still parses JSON for the controller, but we
  // additionally stash the byte-exact buffer on `req.rawBody` so the
  // webhook signature service can recompute the HMAC over the exact
  // bytes Auth0 signed. JSON.stringify(parsedBody) is NOT
  // signature-safe (key ordering, whitespace).
  const captureRaw = (req: Request, _res: unknown, buf: Buffer): void => {
    if (buf && buf.length > 0) {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    }
  };
  app.use(json({ verify: captureRaw }));
  app.use(urlencoded({ extended: true, verify: captureRaw }));

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen(port);
  console.log(`[api] listening on port ${port}`);
}

void bootstrap();
