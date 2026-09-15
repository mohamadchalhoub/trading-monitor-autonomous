// Runs inside each spec file's own process, before that file's tests run.
// Vitest's globalSetup runs in a separate process whose env changes do NOT
// propagate to test workers — this file is what actually makes
// DATABASE_URL point at the disposable test database for the code under test.
import { config } from 'dotenv';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env.test'), override: true });

// isKillSwitchActive() defaults to `<cwd>/KILL_SWITCH` when this env var is unset — which, run
// from `backend/`, is the SAME path an operator's real kill switch lives at. Without this, a
// test run happening to coincide with a genuinely engaged operational kill switch would see
// every kill-switch-gated check as active, and (worse) a test run that leaves it engaged would
// never be distinguishable from a real one. Point every test worker at its own throwaway path by
// default; a test that specifically exercises kill-switch behavior overrides this further in its
// own beforeEach (see test/autonomous/kill-switch.spec.ts).
process.env.AUTONOMOUS_KILL_SWITCH_PATH = join(mkdtempSync(join(tmpdir(), 'test-kill-switch-')), 'KILL_SWITCH');

// `AppModule`'s `ConfigModule.forRoot({ isGlobal: true })` loads the REAL `backend/.env` (not
// `.env.test`) the first time it runs inside a test file (via `createTestApp()`), using dotenv's
// default `override: false` — so it only fills in keys not already set, but for any key `.env.test`
// above didn't define, whatever this repo's own real `.env` currently has for it silently becomes
// this test process's value. `GOLD_EXECUTION_MODE` is a real example: this deployment's `.env` was
// set to `DEMO` once gold DEMO was activated operationally, which then leaked into a test
// asserting the OFF default. Setting it explicitly here (running BEFORE ConfigModule ever loads
// `.env`) means ConfigModule's later, non-destructive load leaves it alone — tests get a
// deterministic default regardless of this repo's own current operational `.env` state.
process.env.GOLD_EXECUTION_MODE = 'OFF';
