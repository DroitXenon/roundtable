import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createRuntime } from './runtime.js';

const requestedPort = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  console.error('PORT must be a number between 1 and 65535.');
  process.exit(1);
}

let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
try {
  runtime = await createRuntime({ dataDir: resolve('.roundtable'), dev: process.argv.includes('--dev') });
  const { hostUrl } = await runtime.listen(requestedPort);
  console.log(`\n  ROUNDTABLE · AVALON\n\n  Host window (keep this link private):\n  ${hostUrl}\n\n  Keep this terminal open and the Mac awake.\n  Players scan the QR code on the host window using the same Wi-Fi.\n  Press Control+C to stop. The game is saved automatically.\n`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', hostUrl] : [hostUrl];
    const child = spawn(opener, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log('Open the host link above in your browser.'));
    child.unref();
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await runtime?.close(); process.exitCode = 0; }
    catch { console.error('Could not finish shutting down. The previous saved game is retained.'); process.exitCode = 1; }
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} catch (error) {
  await runtime?.close();
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === 'EADDRINUSE' ? `Port ${requestedPort} is already in use. Close the other server or run PORT=3001 npm start.` : `Roundtable could not start: ${(error as Error).message}`);
  process.exitCode = 1;
}
