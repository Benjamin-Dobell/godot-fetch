import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getWptCachePaths } from './wpt-cache.mts';

const fetchApiRelativePath = 'fetch/api';
const commonRelativePath = 'common';
const resourcesRelativePath = 'resources';
const gdignoreFileName = '.gdignore';

function ensureWptRepo(wptRepoDir: string): void {
  if (!existsSync(resolve(wptRepoDir, 'wpt.py'))) {
    throw new Error(
      `Missing WPT submodule at ${wptRepoDir}. Run: git submodule update --init --recursive --depth 1 tests/wpt-upstream`,
    );
  }
}

function main(): void {
  const paths = getWptCachePaths();
  ensureWptRepo(paths.wptRepoDir);

  const sourceFetchApiDir = resolve(paths.wptRepoDir, fetchApiRelativePath);
  const sourceCommonDir = resolve(paths.wptRepoDir, commonRelativePath);
  const sourceResourcesDir = resolve(paths.wptRepoDir, resourcesRelativePath);

  if (!existsSync(sourceFetchApiDir)) {
    throw new Error(`Missing WPT fetch api directory: ${sourceFetchApiDir}`);
  }

  rmSync(paths.cacheDir, { recursive: true, force: true });
  mkdirSync(paths.cacheDir, { recursive: true });

  cpSync(sourceCommonDir, resolve(paths.cacheDir, commonRelativePath), { recursive: true });
  cpSync(sourceResourcesDir, resolve(paths.cacheDir, resourcesRelativePath), { recursive: true });
  cpSync(sourceFetchApiDir, resolve(paths.cacheDir, fetchApiRelativePath), { recursive: true });
  writeFileSync(resolve(paths.cacheDir, gdignoreFileName), '', 'utf8');

  const countAnyJsFiles = (directory: string): number => {
    let count = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        count += countAnyJsFiles(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.any.js')) {
        count += 1;
      }
    }
    return count;
  };
  const anyJsCount = countAnyJsFiles(resolve(paths.cacheDir, fetchApiRelativePath));

  process.stdout.write(`[sync:wpt:cache] cache=${paths.cacheDir}\n`);
  process.stdout.write(`[sync:wpt:cache] copied .any.js files=${String(anyJsCount)}\n`);
}

main();
