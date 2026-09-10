import { INestApplication } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { createClient } from '@keyv/redis';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { User } from '../src/users/user.entity';
import { bootTestApp, resetDb } from './helpers';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Cache (e2e)', () => {
  describe('wiring — bug #7/#8: Redis was never used, DB index was hard-coded', () => {
    it('stores entries in Redis, shared across independent app instances', async () => {
      const a = await bootTestApp();
      const b = await bootTestApp();
      try {
        const key = `cache:cross:${Date.now()}`;
        await a.get<Cache>(CACHE_MANAGER).set(key, 'shared-value', 60000);

        // An in-process memory store (the old broken behaviour) would never let
        // a second app instance see this write.
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

  describe('behaviour', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootTestApp();
    });
    afterAll(async () => {
      await app.close();
    });
    beforeEach(async () => {
      await resetDb(app);
    });

    const http = () => request(app.getHttpServer());
    const cache = () => app.get<Cache>(CACHE_MANAGER);

    it('serves GET /users from cache; a direct DB change shows only after the key is cleared', async () => {
      const first = await http().get('/users').expect(200);
      expect(first.body).toHaveLength(3); // seeded

      // Insert straight through the DataSource: UsersService never runs, so it
      // never invalidates `users:all`.
      await app.get(DataSource).getRepository(User).insert({
        email: 'ghost@example.com',
        name: 'Ghost User',
        isActive: true,
      });

      const stillCached = await http().get('/users').expect(200);
      expect(stillCached.body).toHaveLength(3); // served from cache, not the DB

      await cache().del('users:all');

      const fresh = await http().get('/users').expect(200);
      expect(fresh.body).toHaveLength(4); // now read from the DB
    });

    it('expires entries after their TTL', async () => {
      await cache().set('ttl:probe', 'value', 150);
      expect(await cache().get('ttl:probe')).toBe('value');

      await sleep(300);
      expect(await cache().get('ttl:probe')).toBeUndefined();
    });

    it('invalidates the list cache when a user is created', async () => {
      await http().get('/users').expect(200); // populate users:all

      await http()
        .post('/users')
        .send({ email: 'new@example.com', name: 'New Person' })
        .expect(201);

      const after = await http().get('/users').expect(200);
      expect(after.body.map((u: { email: string }) => u.email)).toContain('new@example.com');
    });

    it('invalidates entry + list cache when a user is deleted', async () => {
      // user 3 (carol) has no seeded orders, so no FK gets in the way
      await http().get('/users/3').expect(200); // cache user:3 (a plain object from Redis)
      await http().get('/users').expect(200); // cache users:all

      await http().delete('/users/3').expect(200);

      await http().get('/users/3').expect(404);
      const list = await http().get('/users').expect(200);
      expect(list.body.map((u: { id: number }) => u.id)).not.toContain(3);
    });
  });
});
