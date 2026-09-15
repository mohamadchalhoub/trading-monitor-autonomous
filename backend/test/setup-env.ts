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
