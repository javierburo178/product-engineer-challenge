import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { bootTestApp, resetDb } from './helpers';

describe('Products (e2e)', () => {
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

  describe('GET /products/search — bug #3: cache key ignores the query term', () => {
    it('returns results for the current query, not a previously cached one', async () => {
      const laptop = await request(app.getHttpServer())
        .get('/products/search?q=laptop')
        .expect(200);
      expect(laptop.body.map((p: { name: string }) => p.name)).toEqual([
        'Laptop Pro 15',
        'Laptop Air 13',
      ]);

      const coffee = await request(app.getHttpServer())
        .get('/products/search?q=coffee')
        .expect(200);
      // RED before fix: the constant cache key makes this return the laptop results.
      expect(coffee.body.map((p: { name: string }) => p.name)).toEqual(['Coffee Maker']);

      // Same term, different case: must resolve to the same result (the key is
      // normalised the same way the search itself lowercases the query).
      const coffeeUpper = await request(app.getHttpServer())
        .get('/products/search?q=Coffee')
        .expect(200);
      expect(coffeeUpper.body.map((p: { name: string }) => p.name)).toEqual(['Coffee Maker']);
    });
  });
});
