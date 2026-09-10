import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE codes we translate into meaningful HTTP errors. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FK_VIOLATION = '23503';

/** Pulls the PostgreSQL SQLSTATE code out of a TypeORM error, if there is one. */
export function pgErrorCode(err: unknown): string | undefined {
  if (!(err instanceof QueryFailedError)) {
    return undefined;
  }
  const driverError = err.driverError as { code?: string } | undefined;
  return driverError?.code ?? (err as unknown as { code?: string }).code;
}
