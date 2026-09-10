/**
 * Deterministic DB seed.
 *
 * Inserts a clean, predictable baseline straight into Postgres via a standalone
 * TypeORM DataSource, bypassing the Nest controllers/services on purpose so the
 * starting data is never shaped by application bugs. Use the HTTP endpoints to
 * exercise the buggy flows against this baseline.
 *
 * Run:  pnpm db:seed        (truncates every table first, so it is idempotent)
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { User } from '../src/users/user.entity';
import { Product } from '../src/products/product.entity';
import { Category } from '../src/products/category.entity';
import { Order, OrderStatus } from '../src/orders/order.entity';
import { OrderItem } from '../src/orders/order-item.entity';

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

async function seed() {
  await dataSource.initialize();

  // Wipe everything and reset identity counters so ids are stable across runs.
  await dataSource.query(
    'TRUNCATE TABLE order_items, orders, products, categories, users RESTART IDENTITY CASCADE',
  );

  const categories = dataSource.getRepository(Category);
  const products = dataSource.getRepository(Product);
  const users = dataSource.getRepository(User);
  const orders = dataSource.getRepository(Order);
  const orderItems = dataSource.getRepository(OrderItem);

  // --- Categories: a 3-level chain (1 -> 2 -> 3) plus a sibling root (4) ---
  // Electronics(1) > Computers(2) > Laptops(3) ; Home(4)
  await categories.insert([
    { id: 1, name: 'Electronics', description: 'All electronics', parentId: null },
    { id: 2, name: 'Computers', description: 'Desktops and laptops', parentId: 1 },
    { id: 3, name: 'Laptops', description: 'Portable computers', parentId: 2 },
    { id: 4, name: 'Home', description: 'Home and kitchen', parentId: null },
  ]);

  // --- Products: varied stock, one out-of-stock + unavailable edge case ---
  await products.insert([
    { id: 1, name: 'Laptop Pro 15', description: 'Flagship 15-inch laptop', price: 1899.99, stock: 25, isAvailable: true, categoryId: 3 },
    { id: 2, name: 'Laptop Air 13', description: 'Ultralight 13-inch laptop', price: 1199.0, stock: 40, isAvailable: true, categoryId: 3 },
    { id: 3, name: 'Mechanical Keyboard', description: 'Hot-swap mechanical keyboard', price: 129.99, stock: 100, isAvailable: true, categoryId: 2 },
    { id: 4, name: 'Wireless Mouse', description: 'Ergonomic wireless mouse', price: 49.99, stock: 200, isAvailable: true, categoryId: 2 },
    { id: 5, name: 'USB-C Charger 65W', description: 'Compact GaN charger', price: 39.9, stock: 0, isAvailable: false, categoryId: 1 },
    { id: 6, name: '4K Monitor 27"', description: '27-inch 4K IPS monitor', price: 499.0, stock: 15, isAvailable: true, categoryId: 1 },
    { id: 7, name: 'Coffee Maker', description: 'Drip coffee maker 1.2L', price: 89.99, stock: 30, isAvailable: true, categoryId: 4 },
    { id: 8, name: 'Desk Lamp LED', description: 'Dimmable LED desk lamp', price: 24.99, stock: 60, isAvailable: true, categoryId: 4 },
  ]);

  // --- Users: two active, one inactive ---
  await users.insert([
    { id: 1, email: 'alice@example.com', name: 'Alice Johnson', isActive: true },
    { id: 2, email: 'bob@example.com', name: 'Bob Smith', isActive: true },
    { id: 3, email: 'carol@example.com', name: 'Carol White', isActive: false },
  ]);

  // --- Orders: inserted directly with hand-computed totals. ---
  // NOTE: seeded orders intentionally do NOT decrement product stock; the
  // baseline keeps the stock numbers declared above. Stock movement is what we
  // test through POST /orders.
  await orders.insert([
    { id: 1, userId: 1, status: OrderStatus.PENDING, total: 1999.97 },
    { id: 2, userId: 2, status: OrderStatus.CONFIRMED, total: 499.0 },
  ]);
  await orderItems.insert([
    // Order 1: 1x Laptop Pro 15 (1899.99) + 2x Wireless Mouse (49.99) = 1999.97
    { id: 1, orderId: 1, productId: 1, quantity: 1, price: 1899.99 },
    { id: 2, orderId: 1, productId: 4, quantity: 2, price: 49.99 },
    // Order 2: 1x 4K Monitor (499.00) = 499.00
    { id: 3, orderId: 2, productId: 6, quantity: 1, price: 499.0 },
  ]);

  // Keep Postgres sequences ahead of the explicit ids we inserted.
  for (const table of ['categories', 'products', 'users', 'orders', 'order_items']) {
    await dataSource.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`,
    );
  }

  const counts = {
    categories: await categories.count(),
    products: await products.count(),
    users: await users.count(),
    orders: await orders.count(),
    orderItems: await orderItems.count(),
  };
  console.log('Seed complete:', counts);

  await dataSource.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
