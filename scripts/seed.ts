/**
 * CLI wrapper around the shared seed logic in scripts/seed-data.ts.
 *
 * Run:  pnpm db:seed        (truncates every table first, so it is idempotent)
 *
 * Reads DB_* from the environment (`pnpm db:seed` passes --env-file=.env).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { User } from '../src/users/user.entity';
import { Product } from '../src/products/product.entity';
import { Category } from '../src/products/category.entity';
import { Order } from '../src/orders/order.entity';
import { OrderItem } from '../src/orders/order-item.entity';
import { seed } from './seed-data';

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'challengedb',
  entities: [User, Product, Category, Order, OrderItem],
  synchronize: false,
});

async function main() {
  await dataSource.initialize();
  const counts = await seed(dataSource);
  console.log('Seed complete:', counts);
  await dataSource.destroy();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
