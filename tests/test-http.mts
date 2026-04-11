import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireGodotExecutable } from './require-godot.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const godot = requireGodotExecutable();

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: demoRoot,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

const runResult = run(godot, ['--headless', '--path', '.', '-s', 'res://scripts/http-smoke.ts']);
const output = `${runResult.stdout}${runResult.stderr}`;
const marker = '[JS] HTTP GET test passed';

if (runResult.status !== 0 || !output.includes(marker)) {
  process.stderr.write(output);
  if (!output.includes(marker)) {
    process.stderr.write(`\nMissing HTTP test marker: ${marker}\n`);
  }
  process.exit(runResult.status ?? 1);
}

process.stdout.write('[test:http] HTTP demo test passed\n');
