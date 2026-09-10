import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { bootTestApp, resetDb } from './helpers';

describe('Categories (e2e)', () => {
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

  describe('GET /categories', () => {
    it('returns the seeded categories', async () => {
      const res = await http().get('/categories').expect(200);
      expect(res.body).toHaveLength(4);
    });
  });

  describe('GET /categories/:id', () => {
    it('returns an existing category with its relations', async () => {
      const res = await http().get('/categories/1').expect(200);
      expect(res.body).toMatchObject({ id: 1, name: 'Electronics' });
      expect(res.body.children.map((c: { id: number }) => c.id)).toEqual([2]);
    });
    it('404s for a missing category', async () => {
      await http().get('/categories/9999').expect(404);
    });
    it('400s for a non-numeric id', async () => {
      await http().get('/categories/abc').expect(400);
    });
  });

  describe('GET /categories/:id/tree — bug #2: 500 on multi-level trees', () => {
    it('returns the full descendant subtree at any depth', async () => {
      // seeded: Electronics(1) > Computers(2) > Laptops(3)
      const res = await http().get('/categories/1/tree').expect(200);
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
      const res = await http().get('/categories/3/tree').expect(200);
      expect(res.body).toEqual({ id: 3, name: 'Laptops', children: [] });
    });
    it('404s for a missing category', async () => {
      await http().get('/categories/9999/tree').expect(404);
    });
  });

  describe('POST /categories', () => {
    it('creates a root category', async () => {
      const res = await http()
        .post('/categories')
        .send({ name: 'Garden' })
        .expect(201);
      expect(res.body).toMatchObject({ name: 'Garden', parentId: null });
    });
    it('creates a child category under an existing parent', async () => {
      const res = await http()
        .post('/categories')
        .send({ name: 'Ultrabooks', parentId: 3 })
        .expect(201);
      expect(res.body).toMatchObject({ name: 'Ultrabooks', parentId: 3 });
    });
    it('400s when name is missing', async () => {
      await http().post('/categories').send({ description: 'x' }).expect(400);
    });
    it('400s on unknown body properties', async () => {
      await http().post('/categories').send({ name: 'X', id: 1 }).expect(400);
    });
    it('404s when parentId does not exist (was a raw 500)', async () => {
      await http()
        .post('/categories')
        .send({ name: 'Orphan', parentId: 9999 })
        .expect(404);
    });
  });
});
