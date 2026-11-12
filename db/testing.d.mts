export declare const testDatabaseUrl: string | undefined;

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

export declare function createTestDatabase(opts?: { migrate?: boolean }): Promise<TestDatabase>;
