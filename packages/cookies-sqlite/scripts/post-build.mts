import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildVariants = {
  commonjs: join(import.meta.dirname, '../dist/cjs/package.json'),
  module: join(import.meta.dirname, '../dist/esm/package.json'),
};

for (const [variant, packagePath] of Object.entries(buildVariants)) {
  writeFileSync(packagePath, `{"type": "${variant}"}`, 'utf-8');
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const sourceLicensePath = resolve(packageRoot, '..', '..', 'LICENSE');
const distLicensePath = resolve(packageRoot, 'dist', 'LICENSE');

mkdirSync(resolve(packageRoot, 'dist'), { recursive: true });
copyFileSync(sourceLicensePath, distLicensePath);
