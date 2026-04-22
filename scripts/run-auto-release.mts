import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

type BumpLevel = 'major' | 'minor' | 'patch';
type NonReleaseBump = '' | 'none' | 'skip';
type ParsedBumpToken = BumpLevel | NonReleaseBump;

function isBumpLevel(value: string): value is BumpLevel {
  return value === 'major' || value === 'minor' || value === 'patch';
}

function isNonReleaseBump(value: string): value is NonReleaseBump {
  return value === '' || value === 'none' || value === 'skip';
}

function getArgValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for argument ${name}`);
  }

  return value;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function writeGithubOutputs(outputPath: string | undefined, outputs: Record<string, string>): void {
  if (!outputPath) {
    return;
  }

  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputPath, `${key}=${value}\n`, 'utf8');
  }
}

function run(command: string, commandArgs: readonly string[]): string {
  return execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function getLatestScopedTag(tagPrefix: string): string | undefined {
  const tags = run('git', ['tag', '--list', `${tagPrefix}*`, '--sort=-v:refname']);
  if (!tags) {
    return undefined;
  }

  return tags.split('\n')[0]?.trim() || undefined;
}

function incrementSemver(version: string, bump: BumpLevel): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Expected plain semver version, got "${version}"`);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bump === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unsupported bump level "${bump}"`);
  }

  return `${major}.${minor}.${patch}`;
}

function tagExists(tagName: string): boolean {
  try {
    run('git', ['rev-parse', '--verify', `refs/tags/${tagName}`]);
    return true;
  } catch {
    return false;
  }
}

function parseBumpToken(versionOutput: string): ParsedBumpToken | undefined {
  const tokens = versionOutput
    .split(/\s+/)
    .map((value) => value.trim().toLowerCase());

  let latest: ParsedBumpToken | undefined;
  for (const token of tokens) {
    if (isBumpLevel(token) || isNonReleaseBump(token)) {
      latest = token;
    }
  }

  return latest;
}

function main(): void {
  const args = process.argv.slice(2);
  const tagPrefix = getArgValue(args, '--tag-prefix');
  const targetSha = getArgValue(args, '--target-sha') ?? 'HEAD';
  const baseBranch = getArgValue(args, '--base-branch') ?? 'main';
  const expectedVersion = getArgValue(args, '--expected-version');
  const githubOutputPath = getArgValue(args, '--github-output');
  const isPlanOnly = hasFlag(args, '--plan-only');
  const isDryRun = hasFlag(args, '--dry-run');

  if (!tagPrefix) {
    throw new Error('--tag-prefix is required');
  }

  const latestTag = getLatestScopedTag(tagPrefix);
  const firstCommit = run('git', ['rev-list', '--max-parents=0', 'HEAD']).split('\n').at(-1)?.trim();
  if (!firstCommit) {
    throw new Error('Unable to determine first commit in repository');
  }

  const fromRef = latestTag ?? firstCommit;
  const currentVersion = latestTag ? latestTag.slice(tagPrefix.length) : '0.0.0';

  if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
    throw new Error(`Latest scoped tag "${latestTag}" does not contain a plain semver version`);
  }

  const versionOutput = run('pnpm', [
    'exec',
    'auto',
    'version',
    '--from',
    fromRef,
  ]);

  const bumpToken = parseBumpToken(versionOutput);

  if (bumpToken === undefined) {
    throw new Error(`Unable to parse bump from auto version output: "${versionOutput}"`);
  }

  if (isNonReleaseBump(bumpToken)) {
    console.log(`No releasable commits for ${tagPrefix} since ${fromRef}; skipping release.`);
    writeGithubOutputs(githubOutputPath, {
      release_created: 'false',
      release_tag: '',
      release_version: '',
    });
    return;
  }

  const nextVersion = incrementSemver(currentVersion, bumpToken);
  const nextTag = `${tagPrefix}${nextVersion}`;

  if (expectedVersion && expectedVersion !== nextVersion) {
    throw new Error(
      `Expected computed version ${expectedVersion} but release calculation produced ${nextVersion}`,
    );
  }

  if (tagExists(nextTag)) {
    console.log(`Tag ${nextTag} already exists; skipping release.`);
    writeGithubOutputs(githubOutputPath, {
      release_created: 'false',
      release_tag: nextTag,
      release_version: nextVersion,
    });
    return;
  }

  if (isPlanOnly) {
    console.log(`Planned release ${nextTag} from ${fromRef} to ${targetSha}.`);
    writeGithubOutputs(githubOutputPath, {
      release_created: 'true',
      release_tag: nextTag,
      release_version: nextVersion,
    });
    return;
  }

  const releaseCommandArgs = [
    'exec',
    'auto',
    'release',
    '--from',
    fromRef,
    '--to',
    targetSha,
    '--use-version',
    nextTag,
    '--base-branch',
    baseBranch,
  ];

  if (isDryRun) {
    releaseCommandArgs.push('--dry-run');
  }

  execFileSync('pnpm', releaseCommandArgs, { stdio: 'inherit' });
  writeGithubOutputs(githubOutputPath, {
    release_created: 'true',
    release_tag: nextTag,
    release_version: nextVersion,
  });
}

main();
