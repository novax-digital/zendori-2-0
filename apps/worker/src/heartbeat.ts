import { writeFile } from 'node:fs/promises';

export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? '/tmp/zendori-worker-heartbeat';

/** Touched every minute by the pg-boss heartbeat job; the Docker healthcheck reads the mtime. */
export async function writeHeartbeat(): Promise<void> {
  await writeFile(HEARTBEAT_FILE, new Date().toISOString(), 'utf8');
}
