// Runs inside each spec file's own process, before that file's tests run.
// Vitest's globalSetup runs in a separate process whose env changes do NOT
// propagate to test workers — this file is what actually makes
// DATABASE_URL point at the disposable test database for the code under test.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env.test'), override: true });
