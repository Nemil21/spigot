import type pg from 'pg';

export declare const MIGRATIONS_DIR: string;

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export declare function listMigrations(dir?: string): Promise<Migration[]>;

export declare function migrate(opts?: {
  connectionString?: string;
  client?: pg.Client;
  dir?: string;
  log?: (msg: string) => void;
}): Promise<{ applied: string[]; skipped: string[] }>;

export declare function loadRootDotenv(file?: string): string | null;
