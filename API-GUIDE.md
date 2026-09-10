# API Guide

How to run the API locally, exercise every endpoint with `curl`, and walk the
main business flows. For *what was broken and how it was fixed*, see
[`REMEDIATION.md`](./REMEDIATION.md).

---

## 1. Bring it up

```bash
docker compose up -d          # Postgres :5433, Redis :6379
pnpm install
pnpm db:seed                  # deterministic baseline (see below)
pnpm start:dev                # http://localhost:3000
```

`pnpm db:seed` loads a fixed dataset (`scripts/seed-data.ts`), inserted straight
through TypeORM so it is never shaped by application logic:

| Table | Rows |
|---|---|
| categories | `1 Electronics` → `2 Computers` → `3 Laptops` (3-level chain), `4 Home` |
| products | `1` Laptop Pro 15 (1899.99, stock 25) · `2` Laptop Air 13 (1199.00, 40) · `3` Mechanical Keyboard (129.99, 100) · `4` Wireless Mouse (49.99, 200) · `5` USB-C Charger (39.90, stock 0, **isAvailable false**) · `6` 4K Monitor (499.00, 15) · `7` Coffee Maker (89.99, 30) · `8` Desk Lamp (24.99, 60) |
| users | `1` alice (active) · `2` bob (active) · `3` carol (inactive) |
| orders | `1` alice / PENDING / 1999.97 · `2` bob / CONFIRMED / 499.00 (seeded orders do **not** move stock) |

`price` and `total` are `decimal` columns — the API returns them as **strings**
(`"49.99"`).

---

## 2. Automated checks

```bash
pnpm test:e2e                 # Jest, real Postgres (challengedb_test) + Redis
./scripts/smoke.sh            # curl every endpoint against a running server (re-seeds first)
```

`smoke.sh` env: `BASE_URL` (default `http://localhost:3000`), `SKIP_SEED=1` to
skip the re-seed.

---

## 3. Endpoint reference

`B=http://localhost:3000`. All bodies are JSON (`-H 'Content-Type: application/json'`).

### Users

```bash
curl $B/users                                    # 200 list
curl $B/users/1                                  # 200 | 404 missing | 400 non-numeric id
curl -X POST $B/users -H 'Content-Type: application/json' \
  -d '{"email":"dave@example.com","name":"Dave Grohl"}'   # 201
#   400 invalid email / name < 2 chars / unknown props ("id", "isActive", …)
#   409 email already exists
curl -X DELETE $B/users/3                        # 200 | 404 missing | 409 user still has orders
```

### Products

```bash
curl $B/products                                 # 200, each item includes its category
curl $B/products/1                               # 200 | 404 | 400 non-numeric
curl -X POST $B/products -H 'Content-Type: application/json' \
  -d '{"name":"Webcam 4K","description":"USB","price":79.99,"stock":10,"categoryId":2}'  # 201
#   400 missing name / price < 0 / unknown props   |   404 categoryId does not exist
curl -X DELETE $B/products/3                      # 200 | 404 | 409 product is in an order

# search — case-insensitive substring on name/description, cached 60s (busted on create/delete)
curl "$B/products/search?q=laptop"               # 200 [Laptop Pro 15, Laptop Air 13]
curl "$B/products/search?q="                     # 200 all products

# batch — "touch" updatedAt for each id
curl -X POST $B/products/batch -H 'Content-Type: application/json' \
  -d '{"productIds":[1,2,999]}'
#   -> { "success": false, "processed": 2, "failed": [{ "id": 999, "reason": "Product #999 not found" }] }
#   400 empty array / non-integer id
```

### Categories

```bash
curl $B/categories                               # 200 list (with parent/children)
curl $B/categories/1                             # 200 (with products) | 404
curl $B/categories/1/tree                        # 200 nested descendant subtree, any depth
#   -> {"id":1,"name":"Electronics","children":[{"id":2,"name":"Computers","children":[{"id":3,"name":"Laptops","children":[]}]}]}
curl -X POST $B/categories -H 'Content-Type: application/json' \
  -d '{"name":"Garden"}'                         # 201 root
curl -X POST $B/categories -H 'Content-Type: application/json' \
  -d '{"name":"Ultrabooks","parentId":3}'        # 201 child   |   404 parentId does not exist
```

### Orders

```bash
curl $B/orders                                   # 200 all
curl "$B/orders?userId=1"                        # 200 that user's orders | 400 non-numeric
curl $B/orders/1                                 # 200 | 404 | 400 non-numeric
curl $B/orders/1/full                            # 200 order + user + items + product + category

curl -X POST $B/orders -H 'Content-Type: application/json' \
  -d '{"userId":1,"items":[{"productId":4,"quantity":2},{"productId":1,"quantity":1}]}'   # 201
#   the whole order is one transaction: on any failure below, nothing is persisted and no stock moves
#   404 userId / productId does not exist
#   400 items empty | not enough stock | product isAvailable=false

curl -X POST $B/orders/1/pay                     # 201 { success, transactionId }, order -> confirmed
#   gateway fails ~10% randomly -> retried up to 3x -> 503 (never a bare 500); order stays pending
#   400 order is not pending    |   404 order missing

curl -X PATCH $B/orders/1/status -H 'Content-Type: application/json' \
  -d '{"status":"shipped"}'                      # 200   |   400 value not in the OrderStatus enum

curl -X POST $B/orders/1/cancel                  # 201, restores stock  |  400 not pending  |  404 missing
```

`OrderStatus`: `pending`, `confirmed`, `shipped`, `delivered`, `cancelled`.

---

## 4. Full flows

Run `pnpm db:seed` first so ids line up.

### Flow A — new customer places and pays an order

```bash
B=http://localhost:3000
H='-H Content-Type:application/json'

# 1. new customer
UID=$(curl -s -X POST $B/users $H -d '{"email":"erin@example.com","name":"Erin Doe"}' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

# 2. stock before
curl -s $B/products/4 | grep -o '"stock":[0-9]*'            # -> 200

# 3. place order: 3x Wireless Mouse (49.99) + 1x Coffee Maker (89.99)
OID=$(curl -s -X POST $B/orders $H \
  -d "{\"userId\":$UID,\"items\":[{\"productId\":4,\"quantity\":3},{\"productId\":7,\"quantity\":1}]}" \
  | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

# 4. total is exact: 3*49.99 + 89.99 = 239.96
curl -s $B/orders/$OID | grep -o '"total":"[0-9.]*"'

# 5. stock moved atomically
curl -s $B/products/4 | grep -o '"stock":[0-9]*'            # -> 197
curl -s $B/products/7 | grep -o '"stock":[0-9]*'            # -> 29

# 6. pay (retry a couple of times if the fake gateway returns 503)
curl -s -X POST $B/orders/$OID/pay
curl -s $B/orders/$OID | grep -o '"status":"[a-z]*"'        # -> "confirmed"
```

### Flow B — order rolls back on insufficient stock

```bash
# 4K Monitor has stock 15. Ask for 1 (ok) then 999 (fails) in the same order.
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/orders $H \
  -d '{"userId":1,"items":[{"productId":6,"quantity":1},{"productId":6,"quantity":999}]}'   # -> 400

curl -s $B/products/6 | grep -o '"stock":[0-9]*'           # -> 15  (the first decrement was rolled back)
curl -s $B/orders | grep -o '"id":[0-9]*' | wc -l          # -> unchanged (no orphan order)
```

### Flow C — cancel restores stock

```bash
OID=$(curl -s -X POST $B/orders $H -d '{"userId":1,"items":[{"productId":6,"quantity":3}]}' \
  | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
curl -s $B/products/6 | grep -o '"stock":[0-9]*'          # -> 12
curl -s -X POST $B/orders/$OID/cancel > /dev/null
curl -s $B/products/6 | grep -o '"stock":[0-9]*'          # -> 15
```

### Flow D — category tree

```bash
curl -s -X POST $B/categories $H -d '{"name":"Gaming Laptops","parentId":3}' > /dev/null
curl -s $B/categories/1/tree
# Electronics > Computers > Laptops > Gaming Laptops   (4 levels, built recursively)
```

### Flow E — search cache is per-term and invalidated on write

```bash
curl -s "$B/products/search?q=lamp"    | grep -o '"name":"[^"]*"'   # -> Desk Lamp LED
curl -s "$B/products/search?q=laptop"  | grep -o '"name":"[^"]*"'   # -> Laptop Pro 15, Laptop Air 13  (not the lamp result)

curl -s -X POST $B/products $H -d '{"name":"Lava Lamp","price":19.99,"categoryId":4}' > /dev/null
curl -s "$B/products/search?q=lamp"    | grep -o '"name":"[^"]*"'   # -> Desk Lamp LED, Lava Lamp  (cache was busted)
```
