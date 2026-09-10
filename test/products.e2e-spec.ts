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

  describe('POST /products/batch — bug #6: swallows errors, always reports success', () => {
    it('reports which ids failed and marks the batch unsuccessful', async () => {
      const res = await request(app.getHttpServer())
        .post('/products/batch')
        .send({ productIds: [1, 999] }) // 1 exists, 999 does not
        .expect(201);

      expect(res.body.processed).toBe(1);
      // RED before fix: today returns { success: true, processed: 1 } and hides 999.
      expect(res.body.success).toBe(false);
      expect(res.body.failed).toEqual([
        { id: 999, reason: 'Product #999 not found' },
      ]);
    });

    it('marks the batch successful when every id processed', async () => {
      const res = await request(app.getHttpServer())
        .post('/products/batch')
        .send({ productIds: [1, 2] })
        .expect(201);

      expect(res.body).toEqual({ success: true, processed: 2, failed: [] });
    });
  });

  describe('GET /categories/:id/tree — bug #2: 500 on multi-level trees', () => {
    it('returns the full descendant subtree at any depth', async () => {
      // seeded: Electronics(1) > Computers(2) > Laptops(3)
      const res = await request(app.getHttpServer()).get('/categories/1/tree').expect(200);

      expect(res.body).toEqual({
        id: 1,
        name: 'Electronics',
        children: [
          {
            id: 2,
            name: 'Computers',
            children: [{ id: 3, name: 'Laptops', children: [] }],
          },
        ],
      });
    });

    it('returns a leaf category with no children', async () => {
      const res = await request(app.getHttpServer()).get('/categories/3/tree').expect(200);
      expect(res.body).toEqual({ id: 3, name: 'Laptops', children: [] });
    });

    it('404s for a missing category', async () => {
      await request(app.getHttpServer()).get('/categories/9999/tree').expect(404);
    });
  });
});
