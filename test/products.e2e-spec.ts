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

  const http = () => request(app.getHttpServer());

  describe('GET /products', () => {
    it('returns every product with its category', async () => {
      const res = await http().get('/products').expect(200);
      expect(res.body).toHaveLength(8);
      expect(res.body[0]).toHaveProperty('category');
      expect(res.body[0].category).toMatchObject({ name: 'Laptops' });
    });
  });

  describe('GET /products/:id', () => {
    it('returns an existing product', async () => {
      const res = await http().get('/products/1').expect(200);
      expect(res.body).toMatchObject({ id: 1, name: 'Laptop Pro 15' });
    });
    it('404s for a missing product', async () => {
      await http().get('/products/9999').expect(404);
    });
    it('400s for a non-numeric id', async () => {
      await http().get('/products/abc').expect(400);
    });
  });

  describe('POST /products', () => {
    const valid = {
      name: 'Webcam 4K',
      description: 'USB webcam',
      price: 79.99,
      stock: 10,
      categoryId: 2,
    };

    it('creates a product', async () => {
      const res = await http().post('/products').send(valid).expect(201);
      expect(res.body).toMatchObject({ name: 'Webcam 4K', stock: 10 });
    });
    it('400s when name is missing', async () => {
      await http().post('/products').send({ price: 10 }).expect(400);
    });
    it('400s on a negative price', async () => {
      await http().post('/products').send({ name: 'X', price: -1 }).expect(400);
    });
    it('400s on unknown body properties (no mass-assignment)', async () => {
      await http()
        .post('/products')
        .send({ ...valid, id: 1, isAvailable: false, foo: 'bar' })
        .expect(400);
    });
    it('404s when categoryId does not exist (was a raw 500)', async () => {
      await http()
        .post('/products')
        .send({ name: 'X', price: 1, categoryId: 9999 })
        .expect(404);
    });
  });

  describe('DELETE /products/:id', () => {
    it('deletes a product that is not in any order', async () => {
      await http().delete('/products/3').expect(200); // Mechanical Keyboard, unreferenced
      await http().get('/products/3').expect(404);
    });
    it('404s for a missing product', async () => {
      await http().delete('/products/9999').expect(404);
    });
    it('409s when the product is referenced by an order (was a raw 500)', async () => {
      await http().delete('/products/1').expect(409); // in seeded order_item
      await http().get('/products/1').expect(200);
    });
  });

  describe('GET /products/search — bug #3: cache key ignores the query term', () => {
    it('returns results for the current query, not a previously cached one', async () => {
      const laptop = await http().get('/products/search?q=laptop').expect(200);
      expect(laptop.body.map((p: { name: string }) => p.name)).toEqual([
        'Laptop Pro 15',
        'Laptop Air 13',
      ]);

      const coffee = await http().get('/products/search?q=coffee').expect(200);
      expect(coffee.body.map((p: { name: string }) => p.name)).toEqual([
        'Coffee Maker',
      ]);

      const coffeeUpper = await http()
        .get('/products/search?q=Coffee')
        .expect(200);
      expect(coffeeUpper.body.map((p: { name: string }) => p.name)).toEqual([
        'Coffee Maker',
      ]);
    });

    it('an empty q returns every product', async () => {
      const res = await http().get('/products/search?q=').expect(200);
      expect(res.body).toHaveLength(8);
    });

    it('invalidates the search cache when a product is created', async () => {
      await http().get('/products/search?q=webcam').expect(200); // cache miss -> []
      await http()
        .post('/products')
        .send({ name: 'Webcam 4K', price: 79.99, categoryId: 2 })
        .expect(201);

      const res = await http().get('/products/search?q=webcam').expect(200);
      expect(res.body.map((p: { name: string }) => p.name)).toEqual([
        'Webcam 4K',
      ]);
    });
  });

  describe('POST /products/batch — bug #6: swallows errors, always reports success', () => {
    it('reports which ids failed and marks the batch unsuccessful', async () => {
      const res = await http()
        .post('/products/batch')
        .send({ productIds: [1, 999] })
        .expect(201);
      expect(res.body.processed).toBe(1);
      expect(res.body.success).toBe(false);
      expect(res.body.failed).toEqual([
        { id: 999, reason: 'Product #999 not found' },
      ]);
    });

    it('marks the batch successful when every id processed', async () => {
      const res = await http()
        .post('/products/batch')
        .send({ productIds: [1, 2] })
        .expect(201);
      expect(res.body).toEqual({ success: true, processed: 2, failed: [] });
    });

    it('400s on an empty productIds array', async () => {
      await http().post('/products/batch').send({ productIds: [] }).expect(400);
    });

    it('400s when an id is not an integer (no raw PG text leak)', async () => {
      await http()
        .post('/products/batch')
        .send({ productIds: ['abc'] })
        .expect(400);
    });
  });
});
