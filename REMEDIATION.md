# Remediation log

Bugs are numbered by discovery order; they were fixed in dependency order, so
commit messages may reference them out of sequence. Each entry: symptom → root
cause → fix, with the guarding test in `test/*.e2e-spec.ts`.

## #1 — `GET /orders/:id/full` returns 500 for every order
- **Cause:** `getOrderWithFullDetails` set `user.latestOrder = enriched`, and `enriched` already holds `user` → `JSON.stringify` hit a circular structure and threw.
- **Fix:** `latestOrder` is now an acyclic copy of the order without its nested `user` (`src/orders/orders.service.ts`).
- **Test:** `test/orders.e2e-spec.ts` → "circular reference makes it 500 for every order".

## #2 — `GET /categories/:id/tree` returns 500 for any tree deeper than one level
- **Cause:** `buildCategoryTree` recursed into `category.parent` / `category.children` that `findCategory` never loaded (one level only), so level 2+ hit `undefined.id`.
- **Fix:** `buildCategoryTree` now takes an id and loads `children` one level per recursion, building the descendant subtree to any depth; the always-broken `parent` walk was dropped (`src/products/products.service.ts`).
- **Test:** `test/products.e2e-spec.ts` → "500 on multi-level trees".

## #3 — `GET /products/search` returns another term's results
- **Cause:** cache key was the constant `'product-search'`, so the first search's result was served for every later term for 60s.
- **Fix:** key now includes the term, normalised like the filter does (`` `product-search:${query.toLowerCase().trim()}` ``) in `src/products/products.service.ts`.
- **Test:** `test/products.e2e-spec.ts` → "cache key ignores the query term".

## #4 / #5 — `POST /orders` leaves partial data and oversells under load
- **Cause:**
  - `create` had no transaction: the order and each `order_item` were persisted immediately, so a later failed stock check left an orphan order (`total: 0`) + partial items.
  - `productsService.updateStock(...)` was called **without `await`** (fire-and-forget): the response raced the write, failures became unhandled rejections, and it did a read-modify-write of an *absolute* stock value from a stale read → lost updates / overselling under concurrency.
- **Fix (`src/orders/orders.service.ts`):**
  - `create` and `cancel` now run inside `dataSource.transaction(...)`; any failure rolls the whole thing back.
  - stock moves via atomic relative SQL: `manager.decrement(Product, { id, stock: MoreThanOrEqual(qty) }, 'stock', qty)` (guard `affected === 1`) on create, `manager.increment(...)` on cancel. Two concurrent orders can no longer both pass the stock check.
  - order total is summed in integer cents (`src/common/money.ts`) instead of adding floats.
  - dead `ProductsService.updateStock` removed; `OrdersModule` no longer imports `ProductsModule`.
  - `CreateOrderDto.items` gains `@ArrayMinSize(1)`.
- **Test:** `test/orders.e2e-spec.ts` → "no transaction + unawaited stock update" (rollback on bad stock / missing product, exact totals, 10-way concurrent no-oversell, cancel restores stock).
- **Note (pre-existing, separate):** `OrdersService` still injects an unused `CACHE_MANAGER`; safe to drop in its own cleanup.

## #6 — `POST /products/batch` always answers `{ success: true }`
- **Cause:** per-id errors were caught and dropped (`console.log('Error processing product')`); `success` was hard-coded `true`, so a batch where every id was invalid still looked fine.
- **Fix:** collect `failed: [{ id, reason }]`, set `success = failed.length === 0`, and reject a missing/empty `productIds` up front (`src/products/products.service.ts`).
- **Test:** `test/products.e2e-spec.ts` → "swallows errors, always reports success".

## #7 / #8 — cache ran in-process memory, never Redis; DB index hard-coded to 0
- **Cause:** `@nestjs/cache-manager@3` pulls `cache-manager@7` (Keyv-based, `stores: [...]` API), but the config passed `store: await redisStore(...)` from `cache-manager-ioredis-yet@2` (built for `cache-manager@5`). `cache-manager@7` ignores the unknown `store` key and silently falls back to an in-memory store — 0 keys ever reached Redis. `db: 0` was also hard-coded, ignoring `REDIS_DB`.
- **Fix (`src/app.module.ts`):** store is now `createKeyv(`redis://${host}:${port}/${db}`)` from `@keyv/redis`, with `db` read from `REDIS_DB`. Dropped `cache-manager-ioredis-yet` + `ioredis`, added `@keyv/redis` (and `cache-manager` as a direct dep).
- **Test:** `test/cache.e2e-spec.ts` — a value set on one app instance is readable from a second independent instance (only possible with a shared Redis); writes land in the `REDIS_DB` logical DB (15 under `.env.test`), not 0; entries expire after their TTL; reads are served from cache until it is cleared or invalidated.
- **Aside:** on this machine Redis DB 0 already holds another app's Sidekiq keys — extra reason the index must come from config.

## #9 — `POST /orders/:id/pay` hangs on retries and 500s on failure
- **Cause:** `maxRetries = 1000` (a burst of gateway failures could block the request for minutes) and `throw lastError!` surfaced a bare `Error` → generic `500 Internal server error` with no context.
- **Fix:** retry loop extracted to `src/common/with-retry.ts` and called with `maxRetries = 3`; exhaustion now throws `ServiceUnavailableException` (HTTP 503) with the underlying reason. Order stays `pending` on failure.
- **Test:** `test/orders.e2e-spec.ts` → "1000 retries + raw Error on failure".
- **Follow-up (out of scope here):** resilience for external calls (backoff + jitter, timeout, circuit breaker) belongs in a shared policy, and the fake `paymentService` const should become an injectable provider so it can be swapped/retried at the infrastructure layer rather than inside `OrdersService`.

## #10 / #11 — `DELETE`/`POST /users` surface raw 500s on constraint violations
- **Cause:** `DELETE /users/:id` for a user with orders hit a FK violation, and `POST /users` with an existing email hit a unique violation — both bubbled up as `500 Internal server error`.
- **Fix (`src/users/users.service.ts`, helper `src/common/db-errors.ts`):** map PostgreSQL `23503` (FK) and `23505` (unique) to `409 Conflict` with a clear message; `remove` also deletes by id (no entity load) and 404s when nothing was deleted.
- **Test:** `test/users.e2e-spec.ts` → full endpoint sweep incl. "409s on a duplicate email" and "409s when the user still has orders".
