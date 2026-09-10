import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { bootTestApp, resetDb } from './helpers';

describe('Orders (e2e)', () => {
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

  describe('GET /orders/:id/full — bug #1: circular reference makes it 500 for every order', () => {
    it('returns the order with its user and items without crashing', async () => {
      // seeded order 1: alice, PENDING, 2 items (product 1 x1, product 4 x2)
      const res = await request(app.getHttpServer())
        .get('/orders/1/full')
        .expect(200);

      expect(res.body.id).toBe(1);
      expect(res.body.user.email).toBe('alice@example.com');
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].product).toBeDefined();
      // the user.latestOrder back-reference is kept, but acyclic now
      expect(res.body.user.latestOrder.id).toBe(1);
      expect(res.body.user.latestOrder.user).toBeUndefined();
    });

    it('404s for a missing order', async () => {
      await request(app.getHttpServer()).get('/orders/9999/full').expect(404);
    });
  });

  describe('POST /orders/:id/pay — bug #9: 1000 retries + raw Error on failure', () => {
    // the fake payment gateway fails when Math.random() < 0.1
    afterEach(() => jest.restoreAllMocks());

    it('confirms the order when the gateway succeeds', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.9);

      const res = await request(app.getHttpServer())
        .post('/orders/1/pay')
        .expect(201);
      expect(res.body.success).toBe(true);

      const order = await request(app.getHttpServer())
        .get('/orders/1')
        .expect(200);
      expect(order.body.status).toBe('confirmed');
    });

    it('gives up quickly with a 503 (not a generic 500) when the gateway keeps failing', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.01);

      const started = Date.now();
      const res = await request(app.getHttpServer())
        .post('/orders/1/pay')
        .expect(503);
      const elapsed = Date.now() - started;

      expect(res.body.message).toMatch(/payment/i);
      expect(elapsed).toBeLessThan(5000); // 3 attempts, not 1000

      const order = await request(app.getHttpServer())
        .get('/orders/1')
        .expect(200);
      expect(order.body.status).toBe('pending'); // unchanged on failure
    });
  });

  describe('POST /orders — bug #4/#5: no transaction + unawaited stock update', () => {
    const post = (body: Record<string, unknown>) =>
      request(app.getHttpServer()).post('/orders').send(body);
    const getProduct = (id: number) =>
      request(app.getHttpServer()).get(`/products/${id}`).expect(200);
    const listOrders = () =>
      request(app.getHttpServer()).get('/orders').expect(200);

    it('creates the order, records the exact total and decrements stock', async () => {
      const res = await post({
        userId: 1,
        items: [
          { productId: 1, quantity: 1 }, // Laptop Pro 15 @ 1899.99, stock 25
          { productId: 4, quantity: 2 }, // Wireless Mouse @ 49.99, stock 200
        ],
      }).expect(201);

      expect(res.body.total).toBe('1999.97'); // 1899.99 + 2 * 49.99
      expect(res.body.status).toBe('pending');
      expect(res.body.items).toHaveLength(2);

      expect((await getProduct(1)).body.stock).toBe(24);
      expect((await getProduct(4)).body.stock).toBe(198);
    });

    it('rolls back completely when a later item has insufficient stock', async () => {
      const before = (await listOrders()).body.length;

      await post({
        userId: 1,
        items: [
          { productId: 6, quantity: 1 }, // ok
          { productId: 6, quantity: 999 }, // 4K Monitor stock is 15 -> fails
        ],
      }).expect(400);

      expect((await listOrders()).body).toHaveLength(before); // no orphan order
      expect((await getProduct(6)).body.stock).toBe(15); // first decrement rolled back
    });

    it('rolls back when an item references a missing product', async () => {
      await post({
        userId: 1,
        items: [
          { productId: 4, quantity: 1 },
          { productId: 9999, quantity: 1 },
        ],
      }).expect(404);

      expect((await getProduct(4)).body.stock).toBe(200); // untouched
      expect((await listOrders()).body).toHaveLength(2); // only the seeded ones
    });

    it('rejects an order with no items', async () => {
      await post({ userId: 1, items: [] }).expect(400);
    });

    it('sums a multi-item total exactly', async () => {
      const res = await post({
        userId: 1,
        items: [
          { productId: 8, quantity: 1 }, // 24.99
          { productId: 7, quantity: 1 }, // 89.99
          { productId: 4, quantity: 1 }, // 49.99
        ],
      }).expect(201);

      expect(res.body.total).toBe('164.97'); // naive float sum: 164.96999999999997
    });

    it('does not oversell under concurrent orders for the same product', async () => {
      // product 6: stock 15. Ten concurrent orders of qty 2 -> at most 7 succeed.
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          post({ userId: 1, items: [{ productId: 6, quantity: 2 }] }),
        ),
      );

      const created = responses.filter((r) => r.status === 201).length;
      expect(created).toBe(7);
      expect(responses.every((r) => r.status === 201 || r.status === 400)).toBe(
        true,
      );

      expect((await getProduct(6)).body.stock).toBe(1); // 15 - 7*2, never negative
    });

    it('restores stock atomically when a pending order is cancelled', async () => {
      const created = await post({
        userId: 1,
        items: [{ productId: 6, quantity: 3 }],
      }).expect(201);
      expect((await getProduct(6)).body.stock).toBe(12);

      await request(app.getHttpServer())
        .post(`/orders/${created.body.id}/cancel`)
        .expect(201);

      expect((await getProduct(6)).body.stock).toBe(15); // put back
    });

    it('404s when the userId does not exist', async () => {
      await post({
        userId: 9999,
        items: [{ productId: 4, quantity: 1 }],
      }).expect(404);
    });
  });

  describe('read + status endpoints', () => {
    const http = () => request(app.getHttpServer());

    it('GET /orders returns every order', async () => {
      const res = await http().get('/orders').expect(200);
      expect(res.body).toHaveLength(2);
    });

    it("GET /orders?userId=1 returns that user's orders", async () => {
      const res = await http().get('/orders?userId=1').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].userId).toBe(1);
    });

    it('GET /orders?userId=99 returns an empty list', async () => {
      const res = await http().get('/orders?userId=99').expect(200);
      expect(res.body).toEqual([]);
    });

    it('GET /orders?userId=abc is a 400 (was a raw 500)', async () => {
      await http().get('/orders?userId=abc').expect(400);
    });

    it('GET /orders/:id 404s / 400s appropriately', async () => {
      await http().get('/orders/1').expect(200);
      await http().get('/orders/9999').expect(404);
      await http().get('/orders/abc').expect(400);
    });

    it('PATCH /orders/:id/status updates on a valid enum value', async () => {
      const res = await http()
        .patch('/orders/1/status')
        .send({ status: 'shipped' })
        .expect(200);
      expect(res.body.status).toBe('shipped');
    });

    it('PATCH /orders/:id/status 400s on an invalid enum value (was a raw 500)', async () => {
      await http()
        .patch('/orders/1/status')
        .send({ status: 'banana' })
        .expect(400);
    });

    it('POST /orders/:id/pay 404s for a missing order', async () => {
      await http().post('/orders/9999/pay').expect(404);
    });

    it('POST /orders/:id/pay 400s for an order that is not pending', async () => {
      // seeded order 2 is CONFIRMED
      const res = await http().post('/orders/2/pay').expect(400);
      expect(res.body.message).toMatch(/cannot be paid/i);
    });

    it('POST /orders/:id/cancel 400s for a non-pending order, 404s for a missing one', async () => {
      await http().post('/orders/2/cancel').expect(400); // CONFIRMED
      await http().post('/orders/9999/cancel').expect(404);
    });
  });
});
