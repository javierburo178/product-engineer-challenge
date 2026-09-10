import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { bootTestApp, resetDb } from './helpers';

describe('Users (e2e)', () => {
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

  describe('GET /users', () => {
    it('returns the seeded users', async () => {
      const res = await http().get('/users').expect(200);
      expect(res.body).toHaveLength(3);
      expect(res.body[0]).toMatchObject({ email: 'alice@example.com', isActive: true });
    });
  });

  describe('GET /users/:id', () => {
    it('returns an existing user', async () => {
      const res = await http().get('/users/1').expect(200);
      expect(res.body).toMatchObject({ id: 1, name: 'Alice Johnson' });
    });

    it('404s for a missing user', async () => {
      await http().get('/users/9999').expect(404);
    });

    it('400s for a non-numeric id', async () => {
      await http().get('/users/abc').expect(400);
    });
  });

  describe('POST /users', () => {
    it('creates a user', async () => {
      const res = await http()
        .post('/users')
        .send({ email: 'dave@example.com', name: 'Dave Grohl' })
        .expect(201);
      expect(res.body).toMatchObject({ email: 'dave@example.com', isActive: true });
      expect(res.body.id).toBeDefined();
    });

    it('400s on an invalid email', async () => {
      await http().post('/users').send({ email: 'not-an-email', name: 'X Y' }).expect(400);
    });

    it('400s on a too-short name', async () => {
      await http().post('/users').send({ email: 'x@example.com', name: 'A' }).expect(400);
    });

    it('400s when required fields are missing', async () => {
      await http().post('/users').send({ email: 'x@example.com' }).expect(400);
    });

    it('409s on a duplicate email (was a raw 500)', async () => {
      await http()
        .post('/users')
        .send({ email: 'alice@example.com', name: 'Not Alice' })
        .expect(409);
    });
  });

  describe('DELETE /users/:id', () => {
    it('deletes a user with no orders', async () => {
      await http().delete('/users/3').expect(200); // carol, no orders
      await http().get('/users/3').expect(404);
    });

    it('404s for a missing user', async () => {
      await http().delete('/users/9999').expect(404);
    });

    it('409s when the user still has orders (was a raw 500)', async () => {
      await http().delete('/users/2').expect(409); // bob owns seeded order 2
      await http().get('/users/2').expect(200); // untouched
    });
  });
});
