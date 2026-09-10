import { spawn } from 'node:child_process';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const venvPython = resolve(process.cwd(), '.venv/bin/python3');
const python = process.env.PYTHON || (existsSync(venvPython) ? venvPython : 'python3');
const nodeArgs = watch ? ['--watch', 'src/server.js'] : ['src/server.js'];
const children = [
  spawn(python, ['run_server.py'], { cwd: process.cwd(), stdio: 'inherit' }),
  spawn(process.execPath, nodeArgs, { cwd: process.cwd(), stdio: 'inherit' }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop());
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`Failed to start ${child.spawnargs.join(' ')}: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`Service exited unexpectedly (${signal || `code ${code}`}). Stopping GATI.`);
      stop(code ?? 1);
    }
  });
}
