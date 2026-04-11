import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { requireGodotExecutable } from './require-godot.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..');
const demoRoot = resolve(repoRoot, 'demo');
const godotExecutable = requireGodotExecutable();
const wptHost = process.env.WPT_HOST ?? 'web-platform.test';
const demoDistRoot = resolve(demoRoot, 'dist');
const webRuntimeConfigPath = resolve(demoRoot, '.wpt-web-config.json');
const wptCertPath = resolve(repoRoot, 'tests/wpt-upstream/tools/certs/web-platform.test.pem');
const wptKeyPath = resolve(repoRoot, 'tests/wpt-upstream/tools/certs/web-platform.test.key');

const StreamChunkSize = 64 * 1024;
const StreamChunkCount = 32;
const StreamTotalBytes = StreamChunkSize * StreamChunkCount;

const BridgeFetchUrlEnv = process.env.BRIDGE_WEB_FETCH_URL;
const bridgeFetchUrl = typeof BridgeFetchUrlEnv === 'string'
  ? (BridgeFetchUrlEnv.trim().length > 0 ? BridgeFetchUrlEnv : null)
  : '/http-smoke';
const bridgeIterations = Number.parseInt(process.env.BRIDGE_WEB_ITERATIONS ?? '20', 10);
const bridgeWaitMs = Number.parseInt(process.env.BRIDGE_WEB_WAIT_MS ?? '25', 10);

const PollPassMarker = '[WEB_HTTP_POLL_REGRESSION] PASS';
const PollFailMarker = '[WEB_HTTP_POLL_REGRESSION] FAIL';
const PollLegacyFailureMarker = 'HTTP poll failed with Godot error: 3';

const IgnorablePageErrorSubstrings = [
  "Failed to construct 'AudioWorkletNode': parameter 1 is not of type 'BaseAudioContext'.",
];

type WebScenario = 'http' | 'stream' | 'bridge' | 'http-poll';

const ciSandboxBypassArgs =
  process.platform === 'linux' && process.env.CI === 'true'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];

function parseScenarioArg(): WebScenario {
  const arg = process.argv[2];
  if (arg === 'http' || arg === 'stream' || arg === 'bridge' || arg === 'http-poll') {
    return arg;
  }

  throw new Error(
    `Missing or invalid web scenario argument. Expected one of: http, stream, bridge, http-poll. Received: ${arg ?? '<none>'}`,
  );
}

function scenarioLogPrefix(scenario: WebScenario): string {
  switch (scenario) {
    case 'http':
      return '[test:http:web]';
    case 'stream':
      return '[test:stream:web]';
    case 'bridge':
      return '[test:bridge:web]';
    case 'http-poll':
      return '[test:http:poll:web]';
    default:
      return scenario;
  }
}

function webDistRootForScenario(scenario: WebScenario): string {
  switch (scenario) {
    case 'http':
      return resolve(demoRoot, 'dist/web-http-smoke');
    case 'stream':
      return resolve(demoRoot, 'dist/web-stream-smoke');
    case 'bridge':
      return resolve(demoRoot, 'dist/web-bridge-smoke');
    case 'http-poll':
      return resolve(demoRoot, 'dist/web-http-poll-regression');
    default:
      return scenario;
  }
}

function exportPresetForScenario(scenario: WebScenario): string {
  switch (scenario) {
    case 'http':
    case 'stream':
    case 'bridge':
      return 'Web';
    case 'http-poll':
      return 'Web HTTP Poll Regression';
    default:
      return scenario;
  }
}

function successMessageForScenario(scenario: WebScenario): string {
  switch (scenario) {
    case 'http':
      return '[test:http:web] web HTTP smoke passed';
    case 'stream':
      return '[test:stream:web] web streaming smoke passed';
    case 'bridge':
      return '[test:bridge:web] bridge sanity web test passed';
    case 'http-poll':
      return '[test:http:poll:web] web HTTP poll regression passed';
    default:
      return scenario;
  }
}

function runChecked(command: string, args: string[], cwd: string, label: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`);
  }
}

function writeRuntimeConfigForScenario(scenario: WebScenario): void {
  switch (scenario) {
    case 'http':
      writeFileSync(
        webRuntimeConfigPath,
        JSON.stringify({
          webHttpSmoke: true,
          webHttpUrl: '/http-smoke',
          webHttpExpected: 'ok',
        }),
        'utf8',
      );
      return;
    case 'stream':
      writeFileSync(
        webRuntimeConfigPath,
        JSON.stringify({
          webStreamSmoke: true,
          webStreamUrl: '/stream.bin',
          webStreamExpectedBytes: StreamTotalBytes,
        }),
        'utf8',
      );
      return;
    case 'bridge':
      writeFileSync(
        webRuntimeConfigPath,
        JSON.stringify({
          webBridgeSmoke: true,
          ...(bridgeFetchUrl ? { webBridgeUrl: bridgeFetchUrl } : {}),
          webBridgeIterations: bridgeIterations,
          webBridgeWaitMs: bridgeWaitMs,
        }),
        'utf8',
      );
      return;
    case 'http-poll':
      rmSync(webRuntimeConfigPath, { force: true });
      return;
    default:
      return;
  }
}

function serveScenarioRoute(scenario: WebScenario, pathname: string, response: import('node:http').ServerResponse): boolean {
  if (scenario === 'http' || scenario === 'bridge') {
    if (pathname === '/http-smoke') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('ok');
      return true;
    }
    return false;
  }

  if (scenario === 'stream') {
    if (pathname !== '/stream.bin') {
      return false;
    }

    const streamChunk = Buffer.alloc(StreamChunkSize, 0x5a);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', String(StreamTotalBytes));
    let sent = 0;
    const send = () => {
      while (sent < StreamChunkCount) {
        const canContinue = response.write(streamChunk);
        sent += 1;
        if (!canContinue) {
          response.once('drain', send);
          return;
        }
      }
      response.end();
    };
    send();
    return true;
  }

  if (pathname !== '/http-poll-regression') {
    return false;
  }

  const body = 'ok';
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
  response.end(body);
  return true;
}

async function withServer(
  scenario: WebScenario,
  rootDir: string,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  if (!existsSync(wptCertPath) || !existsSync(wptKeyPath)) {
    throw new Error(`Missing TLS cert files: ${wptCertPath} / ${wptKeyPath}`);
  }

  const prefix = scenarioLogPrefix(scenario);
  const server = createHttpsServer(
    {
      key: readFileSync(wptKeyPath),
      cert: readFileSync(wptCertPath),
    },
    (request, response) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      response.setHeader('Cache-Control', 'no-store');

      const rawUrl = request.url ?? '/';
      const pathname = rawUrl.split('?')[0] ?? '/';

      if (scenario === 'http' || scenario === 'bridge' || scenario === 'http-poll') {
        process.stdout.write(`${prefix}[server] ${request.method ?? 'GET'} ${rawUrl}\n`);
      }

      if (serveScenarioRoute(scenario, pathname, response)) {
        return;
      }

      const normalized = pathname === '/' ? '/index.html' : pathname;
      const filePath = resolve(rootDir, `.${normalized}`);
      if (!filePath.startsWith(rootDir)) {
        response.statusCode = 403;
        response.end('Forbidden');
        return;
      }

      try {
        const extension = filePath.split('.').pop()?.toLowerCase();
        const mimeType = extension === 'html'
          ? 'text/html; charset=utf-8'
          : extension === 'js'
            ? 'application/javascript; charset=utf-8'
            : extension === 'wasm'
              ? 'application/wasm'
              : 'application/octet-stream';
        response.statusCode = 200;
        response.setHeader('Content-Type', mimeType);
        response.end(readFileSync(filePath));
      } catch {
        response.statusCode = 404;
        response.end('Not found');
      }
    },
  );

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => resolveStart());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error(`Failed to bind ${scenario} web server`);
  }

  const baseUrl = `https://${wptHost}:${String(address.port)}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

async function runScenario(scenario: WebScenario, baseUrl: string): Promise<void> {
  const prefix = scenarioLogPrefix(scenario);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--ignore-certificate-errors', ...ciSandboxBypassArgs],
  });

  try {
    const page = await browser.newPage();
    let pass = false;
    let failMessage: null | string = null;
    let sawLegacyPollMarker = false;

    if (scenario === 'http') {
      page.on('console', async (msg) => {
        const text = msg.text();
        const argValues = await Promise.all(
          msg.args().map(async (arg) => {
            try {
              const value = await arg.jsonValue();
              return JSON.stringify(value);
            } catch {
              return '<unserializable>';
            }
          }),
        );
        const argSuffix = argValues.length > 0 ? ` args=${argValues.join(' | ')}` : '';
        process.stdout.write(`${prefix}[console:${msg.type()}] ${text}${argSuffix}\n`);
        if (text.includes('[WEB_HTTP_SMOKE] PASS')) {
          pass = true;
        }
        if (text.includes('[WEB_HTTP_SMOKE] FAIL') || text.startsWith('[WPT] ')) {
          failMessage = text;
        }
      });
      page.on('request', (request) => {
        process.stdout.write(`${prefix}[request] ${request.method()} ${request.url()}\n`);
      });
      page.on('response', (response) => {
        process.stdout.write(`${prefix}[response] ${response.status()} ${response.url()}\n`);
      });
      page.on('requestfailed', (request) => {
        const failure = request.failure();
        process.stdout.write(`${prefix}[requestfailed] ${request.method()} ${request.url()} error=${failure?.errorText ?? '<unknown>'}\n`);
      });
    } else {
      page.on('console', (msg) => {
        const text = msg.text();
        process.stdout.write(`${prefix}[console] ${text}\n`);
        if (scenario === 'stream' && text.includes('[WEB_STREAM_SMOKE] PASS')) {
          pass = true;
        }
        if (scenario === 'bridge' && text.includes('[WEB_BRIDGE_SMOKE] PASS')) {
          pass = true;
        }
        if (scenario === 'http-poll' && text.includes(PollPassMarker)) {
          pass = true;
        }

        const failMatch =
          (scenario === 'stream' && text.includes('[WEB_STREAM_SMOKE] FAIL'))
          || (scenario === 'bridge' && text.includes('[WEB_BRIDGE_SMOKE] FAIL'))
          || (scenario === 'http-poll' && text.includes(PollFailMarker))
          || text.startsWith('[WPT] ');
        if (failMatch) {
          failMessage = text;
        }

        if (scenario === 'http-poll' && text.includes(PollLegacyFailureMarker)) {
          sawLegacyPollMarker = true;
          failMessage = text;
        }
      });

      if (scenario === 'bridge' || scenario === 'http-poll') {
        page.on('requestfailed', (request) => {
          const failure = request.failure();
          process.stdout.write(`${prefix}[requestfailed] ${request.method()} ${request.url()} error=${failure?.errorText ?? '<unknown>'}\n`);
        });
      }

      if (scenario === 'http-poll') {
        page.on('request', (request) => {
          process.stdout.write(`${prefix}[request] ${request.method()} ${request.url()}\n`);
        });
        page.on('response', (response) => {
          process.stdout.write(`${prefix}[response] ${response.status()} ${response.url()}\n`);
        });
        page.on('framenavigated', (frame) => {
          process.stdout.write(`${prefix}[frame] ${frame.url()}\n`);
        });
      }
    }

    page.on('pageerror', (error) => {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stdout.write(`${prefix}[pageerror] ${text}\n`);
      const shouldIgnore = IgnorablePageErrorSubstrings.some((snippet) => text.includes(snippet));
      if (!shouldIgnore) {
        failMessage = text;
      }
      if (scenario === 'http-poll' && text.includes(PollLegacyFailureMarker)) {
        sawLegacyPollMarker = true;
      }
    });

    let url = `${baseUrl}/index.html`;
    if (scenario === 'http') {
      url = `${baseUrl}/index.html?web_http_smoke=1&web_http_url=${encodeURIComponent('/http-smoke')}&web_http_expected=ok`;
    } else if (scenario === 'stream') {
      url = `${baseUrl}/index.html?web_stream_smoke=1&web_stream_url=${encodeURIComponent('/stream.bin')}&web_stream_expected_bytes=${String(StreamTotalBytes)}`;
    } else if (scenario === 'bridge') {
      const params = new URLSearchParams();
      params.set('web_bridge_smoke', '1');
      if (bridgeFetchUrl) {
        params.set('web_bridge_url', bridgeFetchUrl);
      }
      params.set('web_bridge_iterations', String(bridgeIterations));
      params.set('web_bridge_wait_ms', String(bridgeWaitMs));
      url = `${baseUrl}/index.html?${params.toString()}`;
    }

    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });

    const deadlineMs = scenario === 'http-poll' ? 90_000 : 60_000;
    const start = Date.now();
    while (!pass && !failMessage && Date.now() - start < deadlineMs) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }

    if (scenario === 'http-poll' && sawLegacyPollMarker) {
      throw new Error(`web poll regression failed: observed legacy marker "${PollLegacyFailureMarker}"`);
    }

    if (failMessage) {
      if (scenario === 'http') {
        throw new Error(`web http smoke failed: ${failMessage}`);
      }
      if (scenario === 'stream') {
        throw new Error(`web stream smoke failed: ${failMessage}`);
      }
      if (scenario === 'bridge') {
        throw new Error(`web bridge smoke failed: ${failMessage}`);
      }
      throw new Error(`web poll regression failed: ${failMessage}`);
    }

    if (!pass) {
      if (scenario === 'http') {
        const statusNotice = await page.evaluate(() => {
          const notice = document.getElementById('status-notice');
          return typeof notice?.textContent === 'string' ? notice.textContent.trim() : '';
        });
        throw new Error(
          statusNotice.length > 0
            ? `web http smoke timed out without PASS marker (status-notice: ${statusNotice})`
            : 'web http smoke timed out without PASS marker',
        );
      }
      if (scenario === 'stream') {
        throw new Error('web stream smoke timed out without PASS marker');
      }
      if (scenario === 'bridge') {
        throw new Error('web bridge smoke timed out without PASS marker');
      }
      throw new Error('web poll regression timed out without PASS marker');
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const scenario = parseScenarioArg();
  const webDistRoot = webDistRootForScenario(scenario);
  const webExportPath = resolve(webDistRoot, 'index.html');

  runChecked('pnpm', ['build'], demoRoot, 'demo build');
  mkdirSync(demoDistRoot, { recursive: true });
  writeFileSync(resolve(demoDistRoot, '.gdignore'), '', 'utf8');
  rmSync(webDistRoot, { recursive: true, force: true });
  mkdirSync(webDistRoot, { recursive: true });

  writeRuntimeConfigForScenario(scenario);
  try {
    runChecked(
      godotExecutable,
      ['--headless', '--path', '.', '--export-debug', exportPresetForScenario(scenario), webExportPath],
      demoRoot,
      `${scenario} web export`,
    );
    await withServer(scenario, webDistRoot, async (baseUrl) => {
      await runScenario(scenario, baseUrl);
    });
  } finally {
    rmSync(webRuntimeConfigPath, { force: true });
  }

  process.stdout.write(`${successMessageForScenario(scenario)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
