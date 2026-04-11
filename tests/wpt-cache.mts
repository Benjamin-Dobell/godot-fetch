import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const featureRelativePath = 'fetch/api';
const excludedWptFiles = new Set<string>([
  'keepalive.any.js',
  'mode-same-origin.any.js',
  'referrer.any.js',
  'request-referrer.any.js',
]);

export type WptCachePaths = {
  demoRoot: string;
  cacheDir: string;
  featureCacheDir: string;
  wptRepoDir: string;
};

export function getWptCachePaths(): WptCachePaths {
  const cacheDir = resolve(demoRoot, 'wpt-cache');
  const featureCacheDir = resolve(cacheDir, featureRelativePath);
  const wptRepoDir = resolve(scriptDirectory, 'wpt-upstream');

  return {
    demoRoot,
    cacheDir,
    featureCacheDir,
    wptRepoDir,
  };
}

export function ensureCanonicalWptCache(): WptCachePaths {
  const paths = getWptCachePaths();
  if (!existsSync(paths.cacheDir)) {
    throw new Error(`Missing WPT cache directory: ${paths.cacheDir}. Run: node ./tests/sync-wpt-cache.ts`);
  }

  if (!existsSync(paths.featureCacheDir)) {
    throw new Error(`Missing WPT feature cache directory: ${paths.featureCacheDir}`);
  }

  return paths;
}

export function discoverWptFiles(featureCacheDir: string, requestedFiles: string[]): string[] {
  const discovered: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith('.any.js')) {
        continue;
      }
      if (excludedWptFiles.has(entry.name)) {
        continue;
      }
      const relativePath = fullPath.slice(featureCacheDir.length + 1).replaceAll('\\', '/');
      discovered.push(relativePath);
    }
  };
  walk(featureCacheDir);
  discovered.sort((left, right) => left.localeCompare(right));

  if (requestedFiles.length === 0) {
    return discovered;
  }

  const selected: string[] = [];
  for (const requested of requestedFiles) {
    const requestedName = requested.split('/').at(-1) ?? requested;
    if (excludedWptFiles.has(requestedName)) {
      continue;
    }
    const normalizedRequested = requested.includes('fetch/api/')
      ? requested.replace(/^fetch\/api\//, '')
      : requested;
    const match = discovered.find(
      (path) => path === normalizedRequested || path.endsWith(`/${normalizedRequested}`),
    );
    if (match) {
      selected.push(match);
    }
  }
  return selected;
}
