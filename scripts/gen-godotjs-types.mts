import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const demoProjectPath = join(repoRoot, 'demo');
const demoProjectSettingsPath = join(demoProjectPath, 'project.godot');
const demoTypingsDir = join(demoProjectPath, 'typings');
const outputDir = join(repoRoot, 'types');

const godotBinary = process.env.GODOT;
const pnpmBinary = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

if (!godotBinary) {
  throw new Error('GODOT environment variable is required. Example: GODOT=/Applications/Godot47.app/Contents/MacOS/Godot');
}

if (!existsSync(demoProjectPath)) {
  throw new Error(`Demo project path not found: ${demoProjectPath}`);
}

// Ensure demo JS artifacts exist before Godot editor codegen loads TS scripts.
execFileSync(
  pnpmBinary,
  ['-C', demoProjectPath, 'exec', 'tsgo', '--build', '--noCheck'],
  { stdio: 'inherit' },
);

const projectSettingsBefore = readFileSync(demoProjectSettingsPath, 'utf8');
const projectSettingsForTypegen = projectSettingsBefore.replace(
  /runtime\/core\/camel_case_bindings_enabled\s*=\s*(true|false)/,
  'runtime/core/camel_case_bindings_enabled=false',
);

writeFileSync(demoProjectSettingsPath, projectSettingsForTypegen, 'utf8');

try {
  execFileSync(
    godotBinary,
    ['--headless', '--editor', '--generate-types', '--path', demoProjectPath],
    { stdio: 'inherit' },
  );
} finally {
  writeFileSync(demoProjectSettingsPath, projectSettingsBefore, 'utf8');
}

if (!existsSync(demoTypingsDir)) {
  throw new Error(`Generated typings directory not found: ${demoTypingsDir}`);
}

const stagingRoot = mkdtempSync(join(repoRoot, '.types-staging-'));
const stagedTypesDir = join(stagingRoot, 'types-next');
const backupTypesDir = join(stagingRoot, 'types-prev');

try {
  cpSync(demoTypingsDir, stagedTypesDir, { recursive: true });

  if (existsSync(outputDir)) {
    renameSync(outputDir, backupTypesDir);
  }

  renameSync(stagedTypesDir, outputDir);
  rmSync(backupTypesDir, { force: true, recursive: true });
} catch (error) {
  if (!existsSync(outputDir) && existsSync(backupTypesDir)) {
    renameSync(backupTypesDir, outputDir);
  }

  throw error;
} finally {
  rmSync(stagingRoot, { force: true, recursive: true });
}
