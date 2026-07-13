// Docker healthcheck: passes while the pg-boss heartbeat job keeps touching the
// heartbeat file. Fails if the file is missing or older than MAX_AGE_MS.
import { statSync } from 'node:fs';

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? '/tmp/zendori-worker-heartbeat';
const MAX_AGE_MS = 3 * 60 * 1000;

try {
  const { mtimeMs } = statSync(HEARTBEAT_FILE);
  if (Date.now() - mtimeMs > MAX_AGE_MS) {
    console.error('heartbeat stale');
    process.exit(1);
  }
  process.exit(0);
} catch {
  console.error('heartbeat file missing');
  process.exit(1);
}
