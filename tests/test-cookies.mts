import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireGodotExecutable } from './require-godot.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const godot = requireGodotExecutable();
const scriptPath = 'res://scripts/cookie-store-persistence.ts';

type RunCase = {
  env: Record<string, string>;
  marker: string;
  title: string;
};

function runGodotCase(testCase: RunCase): void {
  const result = spawnSync(
    godot,
    ['--headless', '--path', '.', '-s', scriptPath],
    {
      cwd: demoRoot,
      env: {
        ...process.env,
        ...testCase.env,
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0 || !output.includes(testCase.marker)) {
    process.stderr.write(`\n[test:cookies] ${testCase.title} failed\n`);
    process.stderr.write(output);
    if (!output.includes(testCase.marker)) {
      process.stderr.write(`\nMissing marker: ${testCase.marker}\n`);
    }
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const dbPath = 'user://godot-fetch-cookie-store-test';

  const cases: RunCase[] = [
    {
      title: 'memory write',
      env: { COOKIE_STORE: 'memory', COOKIE_PHASE: 'write' },
      marker: '[COOKIE_STORE_TEST] write store=memory ok',
    },
    {
      title: 'memory read reboot (non-persistent)',
      env: {
        COOKIE_STORE: 'memory',
        COOKIE_PHASE: 'read',
        COOKIE_EXPECT: 'absent',
      },
      marker: '[COOKIE_STORE_TEST] read store=memory absent ok',
    },
    {
      title: 'sqlite write',
      env: {
        COOKIE_STORE: 'sqlite',
        COOKIE_PHASE: 'write',
        COOKIE_DB_PATH: dbPath,
        COOKIE_RESET: '1',
      },
      marker: '[COOKIE_STORE_TEST] write store=sqlite ok',
    },
    {
      title: 'sqlite read reboot (persistent)',
      env: {
        COOKIE_STORE: 'sqlite',
        COOKIE_PHASE: 'read',
        COOKIE_EXPECT: 'present',
        COOKIE_DB_PATH: dbPath,
      },
      marker: '[COOKIE_STORE_TEST] read store=sqlite present ok',
    },
  ];

  for (const testCase of cases) {
    runGodotCase(testCase);
  }

  process.stdout.write('[test:cookies] memory and sqlite cookie-store tests passed\n');
}

main();
