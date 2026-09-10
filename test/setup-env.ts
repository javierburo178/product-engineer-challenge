import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Loads .env.test into process.env BEFORE AppModule is imported by any spec, so
 * the app connects to challengedb_test / the test Redis DB instead of the dev
 * ones. Registered as `setupFiles` in test/jest-e2e.json.
 *
 * NOTE: process.loadEnvFile() is not used on purpose – it writes to the native
 * process environment, which jest-environment-node does not mirror back into its
 * own process.env copy, so the vars would never reach the app.
 *
 * Existing vars are not overridden, so `DB_NAME=... pnpm test:e2e` still wins.
 */
const envPath = join(__dirname, '..', '.env.test');

for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;

  const eq = line.indexOf('=');
  if (eq === -1) continue;

  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

if (process.env.DB_NAME !== 'challengedb_test') {
  throw new Error(
    `Refusing to run e2e tests against DB "${process.env.DB_NAME}". ` +
      `Expected "challengedb_test" from .env.test.`,
  );
}
