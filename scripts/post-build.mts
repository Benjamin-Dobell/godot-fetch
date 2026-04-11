import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const buildVariants = {
  commonjs: join(import.meta.dirname, '../dist/cjs/package.json'),
  module: join(import.meta.dirname, '../dist/esm/package.json'),
};

for (const [variant, packagePath] of Object.entries(buildVariants)) {
  writeFileSync(packagePath, `{"type": "${variant}"}`, 'utf-8');
}
