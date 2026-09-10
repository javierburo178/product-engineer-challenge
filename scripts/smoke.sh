#!/usr/bin/env bash
#
# End-to-end smoke test: hits every endpoint (happy paths + edge cases) against a
# running server and asserts the HTTP status. Complements the Jest e2e suite.
#
#   pnpm start:dev                 # in another terminal
#   ./scripts/smoke.sh             # re-seeds the dev DB first, then runs
#
#   BASE_URL=http://localhost:3000 ./scripts/smoke.sh
#   SKIP_SEED=1 ./scripts/smoke.sh     # don't re-seed (results depend on prior state)
#
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE_URL:-http://localhost:3000}"
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }

_req() { # _req METHOD PATH [JSON]
  local method=$1 path=$2 data=${3:-}
  if [ -n "$data" ]; then
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$data"
  else
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$BASE$path"
  fi
}

check() { # check "name" EXPECTED METHOD PATH [JSON]
  local name=$1 expected=$2 method=$3 path=$4 data=${5:-}
  local code
  code=$(_req "$method" "$path" "$data")
  if [ "$code" = "$expected" ]; then
    printf '  %s %s (%s)\n' "$(green '✓')" "$name" "$code"
    PASS=$((PASS + 1))
  else
    printf '  %s %s — expected %s, got %s\n       %s\n' \
      "$(red '✗')" "$name" "$expected" "$code" "$(head -c 200 "$BODY_FILE")"
    FAIL=$((FAIL + 1))
  fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- preflight -------------------------------------------------------------
if ! curl -sS -o /dev/null "$BASE/" 2>/dev/null; then
  echo "Server not reachable at $BASE — start it with: pnpm start:dev"
  exit 1
fi

if [ "${SKIP_SEED:-0}" != "1" ]; then
  echo "Re-seeding the dev database…"
  pnpm --silent db:seed >/dev/null || { echo "db:seed failed"; exit 1; }
fi

# --- root ---------------------------------------------------------------------
section "Root"
check "GET /"                              200 GET "/"

# --- users -----------------------------------------------------------------
section "Users"
check "GET /users"                         200 GET "/users"
check "GET /users/1"                       200 GET "/users/1"
check "GET /users/9999 (missing)"          404 GET "/users/9999"
check "GET /users/abc (non-numeric)"       400 GET "/users/abc"
check "POST /users (valid)"               201 POST "/users" '{"email":"smoke@example.com","name":"Smoke Tester"}'
check "POST /users (bad email)"           400 POST "/users" '{"email":"nope","name":"X Y"}'
check "POST /users (short name)"          400 POST "/users" '{"email":"s2@example.com","name":"A"}'
check "POST /users (duplicate email)"     409 POST "/users" '{"email":"alice@example.com","name":"Not Alice"}'
check "POST /users (extra prop)"          400 POST "/users" '{"email":"s3@example.com","name":"Hacker","id":1}'
check "DELETE /users/3 (no orders)"       200 DELETE "/users/3"
check "DELETE /users/9999 (missing)"      404 DELETE "/users/9999"
check "DELETE /users/2 (has orders)"      409 DELETE "/users/2"

# --- products ----------------------------------------------------------------
section "Products"
check "GET /products"                     200 GET "/products"
check "GET /products/1"                   200 GET "/products/1"
check "GET /products/9999 (missing)"      404 GET "/products/9999"
check "GET /products/abc (non-numeric)"   400 GET "/products/abc"
check "POST /products (valid)"           201 POST "/products" '{"name":"Smoke Widget","price":9.99,"stock":5,"categoryId":2}'
check "POST /products (missing name)"    400 POST "/products" '{"price":1}'
check "POST /products (negative price)"  400 POST "/products" '{"name":"X","price":-1}'
check "POST /products (bad categoryId)"  404 POST "/products" '{"name":"X","price":1,"categoryId":9999}'
check "POST /products (extra prop)"      400 POST "/products" '{"name":"X","price":1,"id":1}'
check "GET /products/search?q=laptop"    200 GET "/products/search?q=laptop"
check "GET /products/search?q=coffee"    200 GET "/products/search?q=coffee"
check "GET /products/search (empty q)"   200 GET "/products/search?q="
check "POST /products/batch (valid)"    201 POST "/products/batch" '{"productIds":[1,2]}'
check "POST /products/batch (empty)"    400 POST "/products/batch" '{"productIds":[]}'
check "POST /products/batch (non-int)"  400 POST "/products/batch" '{"productIds":["abc"]}'
check "DELETE /products/3 (unused)"     200 DELETE "/products/3"
check "DELETE /products/9999 (missing)" 404 DELETE "/products/9999"
check "DELETE /products/1 (in order)"   409 DELETE "/products/1"

# --- categories ------------------------------------------------------------
section "Categories"
check "GET /categories"                   200 GET "/categories"
check "GET /categories/1"                 200 GET "/categories/1"
check "GET /categories/9999 (missing)"    404 GET "/categories/9999"
check "GET /categories/1/tree"            200 GET "/categories/1/tree"
check "GET /categories/9999/tree"         404 GET "/categories/9999/tree"
check "POST /categories (root)"          201 POST "/categories" '{"name":"Smoke Cat"}'
check "POST /categories (child)"         201 POST "/categories" '{"name":"Smoke Sub","parentId":3}'
check "POST /categories (missing name)"  400 POST "/categories" '{"description":"x"}'
check "POST /categories (bad parentId)"  404 POST "/categories" '{"name":"Orphan","parentId":9999}'

# --- orders --------------------------------------------------------------------
section "Orders"
check "GET /orders"                       200 GET "/orders"
check "GET /orders?userId=1"              200 GET "/orders?userId=1"
check "GET /orders?userId=99 (none)"      200 GET "/orders?userId=99"
check "GET /orders?userId=abc"            400 GET "/orders?userId=abc"
check "GET /orders/1"                     200 GET "/orders/1"
check "GET /orders/9999 (missing)"        404 GET "/orders/9999"
check "GET /orders/1/full"               200 GET "/orders/1/full"
check "GET /orders/9999/full (missing)"  404 GET "/orders/9999/full"
check "POST /orders (valid)"             201 POST "/orders" '{"userId":1,"items":[{"productId":4,"quantity":2}]}'

# capture the id of the order just created for the cancel check
NEW_ORDER_ID=$(grep -o '"id":[0-9]*' "$BODY_FILE" | head -1 | cut -d: -f2)

check "POST /orders (insufficient stock)" 400 POST "/orders" '{"userId":1,"items":[{"productId":6,"quantity":9999}]}'
check "POST /orders (missing product)"    404 POST "/orders" '{"userId":1,"items":[{"productId":9999,"quantity":1}]}'
check "POST /orders (no items)"           400 POST "/orders" '{"userId":1,"items":[]}'
check "POST /orders (bad userId)"         404 POST "/orders" '{"userId":9999,"items":[{"productId":4,"quantity":1}]}'
check "POST /orders (out-of-stock product)" 400 POST "/orders" '{"userId":1,"items":[{"productId":5,"quantity":1}]}'
check "PATCH /orders/1/status (valid)"   200 PATCH "/orders/1/status" '{"status":"shipped"}'
check "PATCH /orders/1/status (bad enum)" 400 PATCH "/orders/1/status" '{"status":"banana"}'
check "POST /orders/2/pay (not pending)" 400 POST "/orders/2/pay"
check "POST /orders/9999/pay (missing)"  404 POST "/orders/9999/pay"
check "POST /orders/${NEW_ORDER_ID:-0}/cancel" 201 POST "/orders/${NEW_ORDER_ID:-0}/cancel"
check "POST /orders/2/cancel (not pending)" 400 POST "/orders/2/cancel"
check "POST /orders/9999/cancel (missing)"  404 POST "/orders/9999/cancel"

# --- summary -----------------------------------------------------------------
printf '\n%s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
