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
      const res = await request(app.getHttpServer()).get('/orders/1/full').expect(200);

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

      const res = await request(app.getHttpServer()).post('/orders/1/pay').expect(201);
      expect(res.body.success).toBe(true);

      const order = await request(app.getHttpServer()).get('/orders/1').expect(200);
      expect(order.body.status).toBe('confirmed');
    });

    it('gives up quickly with a 503 (not a generic 500) when the gateway keeps failing', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.01);

      const started = Date.now();
      const res = await request(app.getHttpServer()).post('/orders/1/pay').expect(503);
      const elapsed = Date.now() - started;

      expect(res.body.message).toMatch(/payment/i);
      expect(elapsed).toBeLessThan(5000); // 3 attempts, not 1000

      const order = await request(app.getHttpServer()).get('/orders/1').expect(200);
      expect(order.body.status).toBe('pending'); // unchanged on failure
    });
  });
});
