import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createServer as createNetServer } from 'node:net';
import process from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireGodotExecutable } from './require-godot.mts';
import { discoverWptFiles, ensureCanonicalWptCache } from './wpt-cache.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const repoRoot = resolve(demoRoot, '..');
const testsRoot = resolve(scriptDirectory, '.');
const godotExecutable = requireGodotExecutable();
const minimumPassRate = Number.parseFloat(process.env.WPT_MIN_PASS_RATE ?? '0');
const requestedFiles = process.env.WPT_FILES
  ? process.env.WPT_FILES.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  : [];
const debugMode = process.env.WPT_DEBUG === '1';
const fetchMode = process.env.GODOT_FETCH_MODE === 'fast' ? 'fast' : 'conformant';
const fetchImplementation = process.env.WPT_FETCH_IMPLEMENTATION === 'browser' ? 'browser' : 'polyfill';
const parsedTimeoutMs = Number.parseInt(process.env.WPT_TIMEOUT_MS ?? '60000', 10);
const wptTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : 60000;
const wptRepoDir = resolve(testsRoot, 'wpt-upstream');
const wptPyPath = resolve(wptRepoDir, 'wpt.py');
const wptConfigPath = resolve(testsRoot, '.wpt-serve.config.json');
const wptHost = process.env.WPT_HOST ?? 'web-platform.test';
const wptDomainWww = process.env.WPT_DOMAIN_WWW ?? 'www.web-platform.test';
const wptDomainWww2 = process.env.WPT_DOMAIN_WWW2 ?? 'www2.web-platform.test';
const parsedH2Port = Number.parseInt(process.env.WPT_PORT_H2 ?? '', 10);
const runnerSummaryMarker = '[WPT_RUNNER_SUMMARY]';

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const socket = createNetServer();
    socket.once('error', rejectPort);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        rejectPort(new Error('Failed to allocate an available TCP port'));
        return;
      }

      const port = address.port;
      socket.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

type WptPorts = {
  h2: number;
  http0: number;
  http1: number;
  httpLocal: number;
  httpPublic: number;
  https0: number;
  https1: number;
  httpsLocal: number;
  httpsPublic: number;
  ws: number;
  wss: number;
  webtransportH3: number;
  dns: number;
};

async function allocateWptPorts(): Promise<WptPorts> {
  const h2 = Number.isFinite(parsedH2Port) && parsedH2Port > 0 ? parsedH2Port : await getAvailablePort();
  const [
    http0,
    http1,
    httpLocal,
    httpPublic,
    https0,
    https1,
    httpsLocal,
    httpsPublic,
    ws,
    wss,
    webtransportH3,
    dns,
  ] = await Promise.all([
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
    getAvailablePort(),
  ]);

  return {
    h2,
    http0,
    http1,
    httpLocal,
    httpPublic,
    https0,
    https1,
    httpsLocal,
    httpsPublic,
    ws,
    wss,
    webtransportH3,
    dns,
  };
}

let wptPorts: WptPorts = {
  h2: 0,
  http0: 0,
  http1: 0,
  httpLocal: 0,
  httpPublic: 0,
  https0: 0,
  https1: 0,
  httpsLocal: 0,
  httpsPublic: 0,
  ws: 0,
  wss: 0,
  webtransportH3: 0,
  dns: 0,
};

function run(command, args, cwd, envOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    env: {
      ...process.env,
      ...envOverrides,
      GODOT: godotExecutable,
      GODOT_FETCH_TLS_CA_CERT_PATH: resolve(wptRepoDir, 'tools/certs/cacert.pem'),
    },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function ensureWptRepo() {
  if (!existsSync(wptPyPath)) {
    throw new Error(
      `Missing WPT submodule at ${wptRepoDir}. Run: git submodule update --init --recursive --depth 1 tests/wpt-upstream`,
    );
  }

  if (!existsSync(resolve(wptRepoDir, '.git'))) {
    throw new Error(
      `Expected ${wptRepoDir} to be a git submodule checkout. Run: git submodule update --init --recursive tests/wpt-upstream`,
    );
  }
}

function writeWptServeConfig() {
  const config = {
    alternate_hosts: { alt: 'not-web-platform.test' },
    browser_host: wptHost,
    check_subdomains: true,
    ports: {
      dns: [wptPorts.dns],
      h2: [wptPorts.h2],
      http: [wptPorts.http0, wptPorts.http1],
      'http-local': [wptPorts.httpLocal],
      'http-public': [wptPorts.httpPublic],
      https: [wptPorts.https0, wptPorts.https1],
      'https-local': [wptPorts.httpsLocal],
      'https-public': [wptPorts.httpsPublic],
      ws: [wptPorts.ws],
      webtransport_h3: [wptPorts.webtransportH3],
      wss: [wptPorts.wss],
    },
  };

  writeFileSync(wptConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function verifyWptHostsResolution() {
  const requiredHosts = [wptHost, wptDomainWww, wptDomainWww2, 'not-web-platform.test'];

  for (const host of requiredHosts) {
    try {
      await lookup(host);
    } catch {
      throw new Error(
        `Host "${host}" does not resolve. Run: (cd ${wptRepoDir} && python3 wpt.py make-hosts-file | sudo tee -a /etc/hosts)`,
      );
    }
  }
}

async function waitForWptServerReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://${wptHost}:${String(wptPorts.http0)}/`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { method: 'GET' });
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {
      // keep waiting
    }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 1000));
  }

  throw new Error(`Timed out waiting for WPT server readiness at ${healthUrl}`);
}

function startWptServer(): ChildProcess {
  const child = spawn('python3', ['wpt.py', 'serve', '--config', wptConfigPath], {
    cwd: wptRepoDir,
    env: {
      ...process.env,
      GODOT_FETCH_TLS_CA_CERT_PATH: resolve(wptRepoDir, 'tools/certs/cacert.pem'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout?.on('data', chunk => {
    process.stdout.write(`[wpt-serve] ${String(chunk)}`);
  });
  child.stderr?.on('data', chunk => {
    process.stderr.write(`[wpt-serve] ${String(chunk)}`);
  });

  return child;
}

function cleanupWptServerStreams(child: ChildProcess) {
  child.stdout?.removeAllListeners('data');
  child.stderr?.removeAllListeners('data');
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function stopWptServer(child: ChildProcess) {
  const childPid = child.pid;
  const processGroup = childPid ? -childPid : null;
  const killTarget = processGroup ?? childPid ?? undefined;

  if (killTarget !== undefined) {
    try {
      process.kill(killTarget, 'SIGTERM');
    } catch {
      // Process (or process group) may already be gone.
    }
  }

  await new Promise<void>(resolveStop => {
    const timer = setTimeout(() => {
      if (killTarget !== undefined) {
        try {
          process.kill(killTarget, 'SIGKILL');
        } catch {
          // Already exited.
        }
      }
      resolveStop();
    }, 5000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
  cleanupWptServerStreams(child);
}

async function main() {
  wptPorts = await allocateWptPorts();
  const build = run('pnpm', ['build'], repoRoot);
  if (build.status !== 0) {
    process.stderr.write(build.stdout);
    process.stderr.write(build.stderr);
    process.exit(build.status ?? 1);
  }
  const demoBuild = run('pnpm', ['build'], demoRoot);
  if (demoBuild.status !== 0) {
    process.stderr.write(demoBuild.stdout);
    process.stderr.write(demoBuild.stderr);
    process.exit(demoBuild.status ?? 1);
  }
  const syncCache = run('pnpm', ['run', 'sync:wpt:cache'], demoRoot);
  if (syncCache.status !== 0) {
    process.stderr.write(syncCache.stdout);
    process.stderr.write(syncCache.stderr);
    process.exit(syncCache.status ?? 1);
  }
  ensureWptRepo();
  writeWptServeConfig();

  const cachePaths = ensureCanonicalWptCache();
  const selectedFiles = discoverWptFiles(cachePaths.featureCacheDir, requestedFiles);
  const explicitSelectedFiles = requestedFiles.length > 0 ? selectedFiles : [];
  if (selectedFiles.length === 0) {
    process.stderr.write(`[test:fetch:wpt] No cached .any.js files found in ${cachePaths.featureCacheDir}\n`);
    process.exit(1);
  }
  const runnerScriptPath = fetchImplementation === 'browser'
    ? 'res://WptRunnerBrowser.tscn'
    : 'res://FetchRunnerPolyfill.tscn';

  const godotArgs = [
    '--headless',
    '--path',
    '.',
    runnerScriptPath,
    '--',
    `--wpt-host=${wptHost}`,
    `--wpt-domain-www=${wptDomainWww}`,
    `--wpt-domain-www2=${wptDomainWww2}`,
    `--wpt-http-port0=${String(wptPorts.http0)}`,
    `--wpt-http-port1=${String(wptPorts.http1)}`,
    `--wpt-https-port0=${String(wptPorts.https0)}`,
    `--wpt-https-port1=${String(wptPorts.https1)}`,
    `--wpt-h2-port0=${String(wptPorts.h2)}`,
    `--wpt-fetch-mode=${fetchMode}`,
    `--wpt-fetch-implementation=${fetchImplementation}`,
    `--wpt-timeout-ms=${String(wptTimeoutMs)}`,
  ];
  if (explicitSelectedFiles.length > 0) {
    godotArgs.push(`--wpt-files=${explicitSelectedFiles.join(',')}`);
  }
  if (debugMode) {
    godotArgs.push('--wpt-debug');
  }

  await verifyWptHostsResolution();
  const wptServer = startWptServer();
  let runResult;
  try {
    await waitForWptServerReady();
    runResult = run(godotExecutable, godotArgs, demoRoot, {
      WPT_GODOT_DEBUG: debugMode ? '1' : '0',
      WPT_GODOT_DOMAIN_WWW: wptDomainWww,
      WPT_GODOT_DOMAIN_WWW2: wptDomainWww2,
      WPT_GODOT_FETCH_IMPLEMENTATION: fetchImplementation,
      WPT_GODOT_FETCH_MODE: fetchMode,
      WPT_GODOT_FILES: explicitSelectedFiles.join(','),
      WPT_GODOT_H2_PORT0: String(wptPorts.h2),
      WPT_GODOT_HOST: wptHost,
      WPT_GODOT_HTTP_PORT0: String(wptPorts.http0),
      WPT_GODOT_HTTP_PORT1: String(wptPorts.http1),
      WPT_GODOT_HTTPS_PORT0: String(wptPorts.https0),
      WPT_GODOT_HTTPS_PORT1: String(wptPorts.https1),
      WPT_GODOT_TIMEOUT_MS: String(wptTimeoutMs),
    });
  } finally {
    await stopWptServer(wptServer);
  }

  const output = `${runResult.stdout}${runResult.stderr}`;
  const marker = '[WPT_GODOT_JSON]';
  const markerLine = output.split(/\r?\n/).find((line) => line.includes(marker));

  if (runResult.status !== 0) {
    process.stderr.write(output);
    process.exit(runResult.status ?? 1);
  }

  if (!markerLine) {
    process.stderr.write(output);
    process.stderr.write(`\nMissing summary marker: ${marker}\n`);
    process.exit(1);
  }

  let summary;
  try {
    const markerIndex = markerLine.indexOf(marker);
    summary = JSON.parse(markerLine.slice(markerIndex + marker.length));
  } catch (error) {
    process.stderr.write(output);
    process.stderr.write(`\nInvalid summary JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const passRate = summary.total > 0 ? summary.passed / summary.total : 0;
  const summaryPayload = {
    runner: 'host',
    mode: fetchMode,
    implementation: fetchImplementation,
    summarySource: 'marker',
    selectedFiles: selectedFiles.length,
    filesRan: Number(summary.filesRan ?? 0),
    passed: Number(summary.passed ?? 0),
    failed: Number(summary.failed ?? 0),
    errors: Number(summary.errors ?? 0),
    total: Number(summary.total ?? 0),
    passRatePercent: Number((passRate * 100).toFixed(1)),
    incomplete: false,
  };

  if (Number.isFinite(minimumPassRate) && minimumPassRate > 0 && passRate < minimumPassRate) {
    process.stderr.write(output);
    process.stderr.write(`${runnerSummaryMarker}${JSON.stringify(summaryPayload)}\n`);
    process.stderr.write(
      `[test:fetch:wpt] Pass rate ${String((passRate * 100).toFixed(1))}% is below required ${String((minimumPassRate * 100).toFixed(1))}%\n`,
    );
    process.exit(1);
  }

  if (debugMode) {
    process.stdout.write(output);
  }
  process.stdout.write(`${runnerSummaryMarker}${JSON.stringify(summaryPayload)}\n`);
  process.stdout.write(`[test:fetch:wpt] mode=${fetchMode} implementation=${fetchImplementation}\n`);
  process.stdout.write(
    `[test:fetch:wpt] passed=${String(summaryPayload.passed)} failed=${String(summaryPayload.failed)} errors=${String(summaryPayload.errors)} total=${String(summaryPayload.total)} files=${String(summaryPayload.filesRan)}/${String(summaryPayload.selectedFiles)} source=${summaryPayload.summarySource} incomplete=${String(summaryPayload.incomplete)} pass_rate=${String(summaryPayload.passRatePercent)}%\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
