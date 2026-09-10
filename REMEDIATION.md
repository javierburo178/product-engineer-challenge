# Remediation log

Each entry: symptom → root cause → fix. Test that guards it in `test/*.e2e-spec.ts`.

## #3 — `GET /products/search` returns another term's results
- **Cause:** cache key was the constant `'product-search'`, so the first search's result was served for every later term for 60s.
- **Fix:** key now includes the term, normalised like the filter does (`` `product-search:${query.toLowerCase().trim()}` ``) in `src/products/products.service.ts`.
- **Test:** `test/products.e2e-spec.ts` → "cache key ignores the query term".

## #6 — `POST /products/batch` always answers `{ success: true }`
- **Cause:** per-id errors were caught and dropped (`console.log('Error processing product')`); `success` was hard-coded `true`, so a batch where every id was invalid still looked fine.
- **Fix:** collect `failed: [{ id, reason }]`, set `success = failed.length === 0`, and reject a missing/empty `productIds` up front (`src/products/products.service.ts`).
- **Test:** `test/products.e2e-spec.ts` → "swallows errors, always reports success".
