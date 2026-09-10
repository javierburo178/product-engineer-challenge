import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { createClient } from '@keyv/redis';

import { bootTestApp } from './helpers';

describe('Cache (e2e) — bug #7/#8: Redis was never used, DB index was hard-coded', () => {
  it('stores entries in Redis, shared across independent app instances', async () => {
    const a = await bootTestApp();
    const b = await bootTestApp();
    try {
      const key = `cache:cross:${Date.now()}`;
      await a.get<Cache>(CACHE_MANAGER).set(key, 'shared-value', 60000);

      // An in-process memory store (the old broken behaviour) would never let a
      // second app instance see this write.
      expect(await b.get<Cache>(CACHE_MANAGER).get(key)).toBe('shared-value');

      await a.get<Cache>(CACHE_MANAGER).del(key);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('writes to the Redis logical DB from REDIS_DB (15 in .env.test), not a hard-coded 0', async () => {
    const client = createClient({ url: 'redis://localhost:6379/15' });
    await client.connect();
    await client.flushDb();

    const app = await bootTestApp();
    try {
      await app.get<Cache>(CACHE_MANAGER).set(`db:probe:${Date.now()}`, 'x', 60000);
      expect(await client.dbSize()).toBeGreaterThan(0);
    } finally {
      await app.close();
      await client.destroy();
    }
  });
});
