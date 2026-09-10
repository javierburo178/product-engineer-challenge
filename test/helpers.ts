import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { seed, type SeedOptions } from '../scripts/seed-data';

/**
 * Boots the full application (real Postgres + Redis, no mocks) exactly as
 * src/main.ts does, so validation and DI behave identically under test.
 * Connection target comes from .env.test via test/setup-env.ts.
 */
export async function bootTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  return app;
}

/**
 * Restores the deterministic baseline: truncates + re-seeds every table and
 * clears the cache the app uses. Call in beforeEach so each test starts clean.
 */
export async function resetDb(
  app: INestApplication,
  opts?: SeedOptions,
): Promise<void> {
  await seed(app.get(DataSource), opts);
  await app.get<Cache>(CACHE_MANAGER).clear();
}
