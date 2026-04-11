import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { requireGodotExecutable } from './require-godot.mts';
import { discoverWptFiles, ensureCanonicalWptCache } from './wpt-cache.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const repoRoot = resolve(demoRoot, '..');
const testsRoot = resolve(scriptDirectory, '.');
const demoDistRoot = resolve(demoRoot, 'dist');
const webDistRoot = resolve(demoRoot, 'dist/web');
const webExportPath = resolve(webDistRoot, 'index.html');

const godotExecutable = requireGodotExecutable();
const requestedFiles = process.env.WPT_FILES
  ? process.env.WPT_FILES.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  : [];
const minimumPassRate = Number.parseFloat(process.env.WPT_WEB_MIN_PASS_RATE ?? '0');
const timeoutMs = Number.parseInt(process.env.WPT_WEB_TIMEOUT_MS ?? '120000', 10);
const debugMode = process.env.WPT_DEBUG === '1';
const fetchMode = process.env.GODOT_FETCH_MODE === 'fast' ? 'fast' : 'conformant';
const fetchImplementation = process.env.WPT_WEB_FETCH_IMPLEMENTATION === 'browser' ? 'browser' : 'polyfill';
const webPreset = fetchImplementation === 'browser' ? 'Web WPT Browser' : 'Web';
const marker = '[WPT_GODOT_JSON]';
const webRuntimeConfigPath = resolve(demoRoot, '.wpt-web-config.json');
const wptRepoDir = resolve(testsRoot, 'wpt-upstream');
const wptPyPath = resolve(wptRepoDir, 'wpt.py');
const wptConfigPath = resolve(testsRoot, '.wpt-serve.config.json');
const wptCertDir = resolve(wptRepoDir, 'tools/certs');
const wptLeafKeyPath = resolve(wptCertDir, 'web-platform.test.key');
const wptLeafCertPath = resolve(wptCertDir, 'web-platform.test.pem');
const wptHost = process.env.WPT_HOST ?? 'web-platform.test';
const wptDomainWww = process.env.WPT_DOMAIN_WWW ?? 'www.web-platform.test';
const wptDomainWww2 = process.env.WPT_DOMAIN_WWW2 ?? 'www2.web-platform.test';
const parsedH2Port = Number.parseInt(process.env.WPT_PORT_H2 ?? '', 10);
const runnerSummaryMarker = '[WPT_RUNNER_SUMMARY]';
const wptLeafCertSpki = '7LXIejxoHZqLSGX1mRfe1UrTJPYX97f9vOuje3vp09w=';
const ciSandboxBypassArgs =
  process.platform === 'linux' && process.env.CI === 'true'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];

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

function run(command: string, args: string[], cwd: string): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    env: {
      ...process.env,
      GODOT: godotExecutable,
    },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function runChecked(command: string, args: string[], cwd: string, label: string): void {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.stderr.write(`[test:fetch:wpt:web] ${label} failed\n`);
    process.exit(result.status ?? 1);
  }
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
}

async function proxyToWpt(
  request: any,
  response: any,
  targetOrigins: { standard: string; h2: string },
): Promise<void> {
  await new Promise<void>((resolveForward) => {
    const rawUrl = request.url ?? '/';
    const h2Target = rawUrl.includes('.h2.py');
    const target = new URL(rawUrl, h2Target ? targetOrigins.h2 : targetOrigins.standard);
    const method = String(request.method ?? 'GET').toUpperCase();
    const transport = target.protocol === 'https:' ? requestHttps : requestHttp;
    const outboundHeaders = { ...(request.headers ?? {}) } as Record<string, string | string[] | undefined>;
    delete outboundHeaders.host;

    const upstreamRequest = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: `${target.pathname}${target.search}`,
        headers: outboundHeaders,
        insecureHTTPParser: true,
        rejectUnauthorized: false,
      },
      (upstreamResponse) => {
        const rawHeaders = Array.isArray(upstreamResponse.rawHeaders) ? [...upstreamResponse.rawHeaders] : [];
        try {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage ?? '',
            rawHeaders as unknown as Record<string, string>,
          );
        } catch {
          response.statusCode = upstreamResponse.statusCode ?? 502;
        }
        upstreamResponse.on('error', () => {
          if (!response.writableEnded) {
            response.end();
          }
          resolveForward();
        });
        response.on('close', () => resolveForward());
        upstreamResponse.pipe(response);
      },
    );

    upstreamRequest.on('error', (error) => {
      response.statusCode = 502;
      response.end(`proxy failure: ${error instanceof Error ? error.message : String(error)}`);
      resolveForward();
    });

    if (method === 'GET' || method === 'HEAD') {
      upstreamRequest.end();
      return;
    }

    request.pipe(upstreamRequest);
  });
}

type RunnerBaseUrls = {
  httpBaseUrl: string;
  httpsBaseUrl: string;
};

async function withServers(
  rootDir: string,
  wptHttpProxyOrigin: string,
  wptHttpsProxyOrigin: string,
  wptH2ProxyOrigin: string,
  fn: (urls: RunnerBaseUrls) => Promise<void>,
): Promise<void> {
  const handler = (proxyOrigin: string) => (request: any, response: any) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const rawUrl = request.url ?? '/';
    const cleanPath = rawUrl.split('?')[0] ?? '/';
    if (
      cleanPath.startsWith('/fetch/')
      || cleanPath.startsWith('/resources/')
      || cleanPath.startsWith('/xhr/')
      || cleanPath.startsWith('/common/')
    ) {
      void proxyToWpt(request, response, { standard: proxyOrigin, h2: wptH2ProxyOrigin });
      return;
    }
    const normalized = cleanPath === '/' ? '/index.html' : cleanPath;
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
            : extension === 'pck'
              ? 'application/octet-stream'
              : 'application/octet-stream';

      const content = readFileSync(filePath);
      response.statusCode = 200;
      response.setHeader('Content-Type', mimeType);
      response.end(content);
    } catch {
      response.statusCode = 500;
      response.end('Not found');
    }
  };

  const httpServer = createHttpServer(handler(wptHttpProxyOrigin));
  const httpsServer = createHttpsServer({
    key: readFileSync(wptLeafKeyPath, 'utf8'),
    cert: readFileSync(wptLeafCertPath, 'utf8'),
  }, handler(wptHttpsProxyOrigin));

  await new Promise<void>((resolveStart, rejectStart) => {
    httpServer.once('error', rejectStart);
    httpServer.listen(0, '127.0.0.1', () => resolveStart());
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    httpsServer.once('error', rejectStart);
    httpsServer.listen(0, '127.0.0.1', () => resolveStart());
  });
  const httpAddress = httpServer.address();
  const httpsAddress = httpsServer.address();
  if (!httpAddress || typeof httpAddress === 'string' || !httpsAddress || typeof httpsAddress === 'string') {
    httpServer.close();
    httpsServer.close();
    throw new Error('Failed to bind web servers');
  }

  const urls = {
    httpBaseUrl: `http://${wptHost}:${String(httpAddress.port)}`,
    httpsBaseUrl: `https://${wptHost}:${String(httpsAddress.port)}`,
  };

  try {
    await fn(urls);
  } finally {
    await new Promise<void>((resolveClose) => {
      httpServer.close(() => resolveClose());
    });
    await new Promise<void>((resolveClose) => {
      httpsServer.close(() => resolveClose());
    });
  }
}

function createBrowserProfile(): string {
  const profileDir = mkdtempSync(join(tmpdir(), 'godot-fetch-wpt-browser-'));
  return profileDir;
}

function isTransientExecutionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes('Execution context was destroyed')
    || error.message.includes('Execution context is not available in detached frame or worker')
    || error.message.includes('Attempted to use detached Frame')
    || error.message.includes('Cannot find context with specified id')
    || error.message.includes('Target closed')
    || error.message.includes('Session closed')
    || error.message.includes('Runtime.callFunctionOn timed out');
}

type RuntimeStateSnapshot = {
  enterTree: boolean;
  error: string | null;
  location: string | null;
  modeRequested: boolean | null;
  skipped: string | null;
  started: boolean;
  summary: Record<string, unknown> | null;
};

const readRuntimeStateSnapshot = (): RuntimeStateSnapshot => {
  const state = globalThis as {
    __WPT_GODOT_JSON__?: Record<string, unknown>;
    __WPT_WEB_ENTER_TREE__?: boolean;
    __WPT_WEB_ERROR__?: string;
    __WPT_WEB_LOCATION__?: string;
    __WPT_WEB_MODE_REQUESTED__?: boolean;
    __WPT_WEB_SKIPPED__?: string;
    __WPT_WEB_STARTED__?: boolean;
  };
  return {
    enterTree: state.__WPT_WEB_ENTER_TREE__ ?? false,
    error: state.__WPT_WEB_ERROR__ ?? null,
    location: state.__WPT_WEB_LOCATION__ ?? null,
    modeRequested: state.__WPT_WEB_MODE_REQUESTED__ ?? null,
    skipped: state.__WPT_WEB_SKIPPED__ ?? null,
    started: state.__WPT_WEB_STARTED__ ?? false,
    summary: state.__WPT_GODOT_JSON__ ?? null,
  };
};

async function safelyReadRuntimeState(
  reader: () => Promise<RuntimeStateSnapshot>,
): Promise<RuntimeStateSnapshot | null> {
  try {
    return await reader();
  } catch (error) {
    if (isTransientExecutionContextError(error)) {
      return null;
    }
    throw error;
  }
}

async function runInBrowser(baseUrl: string, files: string[]): Promise<Record<string, unknown>> {
  const profileDir = createBrowserProfile();
  const launchArgs = [
    `--ignore-certificate-errors-spki-list=${wptLeafCertSpki}`,
    '--allow-insecure-localhost',
  ];
  if (baseUrl.startsWith('http://')) {
    launchArgs.push(`--unsafely-treat-insecure-origin-as-secure=${baseUrl}`);
  }
  launchArgs.push(...ciSandboxBypassArgs);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: profileDir,
      channel: 'chrome',
      args: launchArgs,
    });
  } catch {
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: profileDir,
      args: launchArgs,
    });
  }

  try {
    const page = await browser.newPage();
    browser.on('disconnected', () => {
      process.stdout.write('[WPT_WEB][lifecycle] browser disconnected\n');
    });
    browser.on('targetcreated', (target) => {
      process.stdout.write(`[WPT_WEB][lifecycle] target created type=${target.type()} url=${target.url()}\n`);
    });
    browser.on('targetdestroyed', (target) => {
      process.stdout.write(`[WPT_WEB][lifecycle] target destroyed type=${target.type()} url=${target.url()}\n`);
    });
    const attachedTargets = new Set<string>();
    const attachDebuggerSession = async (targetId: string, label: string, createSession: () => Promise<any>) => {
      if (attachedTargets.has(targetId)) {
        return;
      }
      attachedTargets.add(targetId);

      const cdp = await createSession();
      await cdp.send('Debugger.enable');
      cdp.on('Debugger.paused', async (event: any) => {
        const topFrame = event.callFrames?.[0];
        const url = topFrame?.url ?? '<unknown>';
        const line = Number(topFrame?.location?.lineNumber ?? -1) + 1;
        const column = Number(topFrame?.location?.columnNumber ?? -1) + 1;
        process.stdout.write(`[WPT_DEBUGGER] target=${label} reason=${String(event.reason)} at ${url}:${String(line)}:${String(column)}\n`);
        await cdp.send('Debugger.resume');
      });
    };

    const pageTarget = page.target() as any;
    await attachDebuggerSession(String(pageTarget._targetId ?? 'page'), 'page', async () => await pageTarget.createCDPSession());

    await page.evaluateOnNewDocument(() => {
      const target = globalThis as {
        __WPT_GODOT_JSON__?: Record<string, unknown>;
        __WPT_WEB_ENTER_TREE__?: boolean;
        __WPT_WEB_ERROR__?: string;
        __WPT_WEB_LOCATION__?: string;
        __WPT_WEB_MODE_REQUESTED__?: boolean;
        __WPT_WEB_SKIPPED__?: string;
        __WPT_WEB_STARTED__?: boolean;
      };

      const maybeWindow = globalThis as { addEventListener?: (type: string, handler: (event: MessageEvent) => void) => void };
      if (typeof maybeWindow.addEventListener !== 'function') {
        return;
      }

      maybeWindow.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as
          | {
            __godotFetchWpt?: boolean;
            type?: 'summary' | 'error' | 'state';
            summary?: Record<string, unknown>;
            error?: string;
            state?: {
              __WPT_WEB_ENTER_TREE__?: boolean;
              __WPT_WEB_ERROR__?: string;
              __WPT_WEB_LOCATION__?: string;
              __WPT_WEB_MODE_REQUESTED__?: boolean;
              __WPT_WEB_SKIPPED__?: string;
              __WPT_WEB_STARTED__?: boolean;
            };
          }
          | null;

        if (!data || data.__godotFetchWpt !== true) {
          return;
        }

        if (data.type === 'summary' && data.summary && typeof data.summary === 'object') {
          target.__WPT_GODOT_JSON__ = data.summary;
          return;
        }

        if (data.type === 'error' && typeof data.error === 'string') {
          target.__WPT_WEB_ERROR__ = data.error;
          return;
        }

        if (data.type === 'state' && data.state && typeof data.state === 'object') {
          if (typeof data.state.__WPT_WEB_ENTER_TREE__ === 'boolean') {
            target.__WPT_WEB_ENTER_TREE__ = data.state.__WPT_WEB_ENTER_TREE__;
          }
          if (typeof data.state.__WPT_WEB_ERROR__ === 'string') {
            target.__WPT_WEB_ERROR__ = data.state.__WPT_WEB_ERROR__;
          }
          if (typeof data.state.__WPT_WEB_LOCATION__ === 'string') {
            target.__WPT_WEB_LOCATION__ = data.state.__WPT_WEB_LOCATION__;
          }
          if (typeof data.state.__WPT_WEB_MODE_REQUESTED__ === 'boolean') {
            target.__WPT_WEB_MODE_REQUESTED__ = data.state.__WPT_WEB_MODE_REQUESTED__;
          }
          if (typeof data.state.__WPT_WEB_SKIPPED__ === 'string') {
            target.__WPT_WEB_SKIPPED__ = data.state.__WPT_WEB_SKIPPED__;
          }
          if (typeof data.state.__WPT_WEB_STARTED__ === 'boolean') {
            target.__WPT_WEB_STARTED__ = data.state.__WPT_WEB_STARTED__;
          }
        }
      });
    });

    let summaryLine: string | null = null;
    let fatalErrorLine: string | null = null;
    let pageSummary: Record<string, unknown> | null = null;
    let pageError: string | null = null;
    let pageState: Record<string, unknown> | null = null;
    let parsedPassed = 0;
    let parsedTotal = 0;
    let parsedFilesRan = 0;
    let parsedErrors = 0;
    const completedFiles = new Set<string>();

    page.on('pageerror', (error) => {
      process.stdout.write(`[WPT_WEB][lifecycle] pageerror ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    });
    page.on('error', (error) => {
      process.stdout.write(`[WPT_WEB][lifecycle] page error event ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    });
    page.on('close', () => {
      process.stdout.write('[WPT_WEB][lifecycle] page closed\n');
    });
    page.on('framenavigated', (frame) => {
      process.stdout.write(`[WPT_WEB][lifecycle] frame navigated detached=${String(frame.detached)} url=${frame.url()}\n`);
    });
    page.on('framedetached', (frame) => {
      process.stdout.write(`[WPT_WEB][lifecycle] frame detached detached=${String(frame.detached)} url=${frame.url()}\n`);
    });
    page.on('load', () => {
      process.stdout.write('[WPT_WEB][lifecycle] page load\n');
    });
    page.on('domcontentloaded', () => {
      process.stdout.write('[WPT_WEB][lifecycle] page domcontentloaded\n');
    });

    page.on('console', (message) => {
      const text = message.text();
      process.stdout.write(`${text}\n`);
      if (text.includes(marker)) {
        summaryLine = text;
        return;
      }

      const fileMatch = text.match(/^\[WPT\]\[file\]\s+(.+?)\s+(\d+)\/(\d+)\s+passed$/);
      if (fileMatch) {
        const filePath = fileMatch[1] ?? '';
        const normalizedPath = filePath.startsWith('fetch/api/')
          ? filePath.slice('fetch/api/'.length)
          : filePath;
        completedFiles.add(normalizedPath);

        const passed = Number.parseInt(fileMatch[2] ?? '', 10);
        const total = Number.parseInt(fileMatch[3] ?? '', 10);
        if (Number.isFinite(passed) && Number.isFinite(total) && total >= passed) {
          parsedPassed += passed;
          parsedTotal += total;
          parsedFilesRan += 1;
        }
        return;
      }

      const fileErrorMatch = text.match(/^\[WPT\]\[file\]\s+(.+?)\s+ERROR\s+/);
      if (fileErrorMatch) {
        const filePath = fileErrorMatch[1] ?? '';
        const normalizedPath = filePath.startsWith('fetch/api/')
          ? filePath.slice('fetch/api/'.length)
          : filePath;
        completedFiles.add(normalizedPath);
        parsedErrors += 1;
        parsedFilesRan += 1;
        return;
      }

      if (text.startsWith('[WPT_WEB][error]')) {
        fatalErrorLine = text;
      }
    });

    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) {
        process.stdout.write(`[WPT_WEB][network] ${status} ${response.url()}\n`);
      }
    });

    page.on('requestfailed', (request) => {
      process.stdout.write(`[WPT_WEB][network] FAILED ${request.url()} ${request.failure()?.errorText ?? '<unknown>'}\n`);
    });

    const params = new URLSearchParams();
    params.set('wpt_browser', '1');
    if (files.length > 0) {
      params.set('wpt_files', files.join(','));
    }
    if (debugMode) {
      params.set('wpt_debug', '1');
    }
    params.set('wpt_fetch_mode', fetchMode);
    params.set('wpt_fetch_implementation', fetchImplementation);
    params.set('wpt_timeout_ms', '30000');

    await page.goto(`${baseUrl}/index.html?${params.toString()}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    for (const worker of page.workers()) {
      const workerTarget = (worker as any).target?.();
      if (!workerTarget || typeof workerTarget.createCDPSession !== 'function') {
        continue;
      }
      await attachDebuggerSession(
        String(workerTarget._targetId ?? `worker:${worker.url()}`),
        `worker:${worker.url()}`,
        async () => await workerTarget.createCDPSession(),
      );
    }

    const startedAt = Date.now();
    while (!summaryLine && !pageSummary && !pageError && !fatalErrorLine && Date.now() - startedAt < timeoutMs) {
      for (const worker of page.workers()) {
        const workerTarget = (worker as any).target?.();
        if (!workerTarget || typeof workerTarget.createCDPSession !== 'function') {
          continue;
        }
        await attachDebuggerSession(
          String(workerTarget._targetId ?? `worker:${worker.url()}`),
          `worker:${worker.url()}`,
          async () => await workerTarget.createCDPSession(),
        );
      }

      const stateCandidates: RuntimeStateSnapshot[] = [];
      const pageCandidate = await safelyReadRuntimeState(() => page.evaluate(readRuntimeStateSnapshot));
      if (pageCandidate) {
        stateCandidates.push(pageCandidate);
      }

      for (const worker of page.workers()) {
        const workerCandidate = await safelyReadRuntimeState(() => worker.evaluate(readRuntimeStateSnapshot));
        if (workerCandidate) {
          stateCandidates.push(workerCandidate);
        }
      }

      const currentState = stateCandidates.find((candidate) => {
        return candidate.enterTree
          || candidate.started
          || candidate.modeRequested !== null
          || candidate.skipped !== null
          || candidate.error !== null
          || candidate.summary !== null;
      }) ?? pageCandidate ?? {
        enterTree: false,
        error: null,
        location: null,
        modeRequested: null,
        skipped: null,
        started: false,
        summary: null,
      };

      pageState = currentState as Record<string, unknown>;

      if (typeof currentState.error === 'string' && currentState.error.length > 0) {
        pageError = currentState.error;
        break;
      }

      if (currentState.summary && typeof currentState.summary === 'object') {
        pageSummary = currentState.summary;
        break;
      }

      if (currentState.enterTree === true && currentState.modeRequested === false) {
        throw new Error(
          `Web WPT mode was not detected by demo runtime (location=${String(currentState.location ?? 'unknown')})`,
        );
      }

      if (typeof currentState.skipped === 'string' && currentState.skipped.length > 0) {
        throw new Error(
          `Web WPT suite was skipped by demo runtime: ${currentState.skipped} (location=${String(currentState.location ?? 'unknown')})`,
        );
      }

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }

    if (pageSummary) {
      return {
        ...pageSummary,
        completedFiles: Array.from(completedFiles),
      };
    }

    if (pageError) {
      throw new Error(`WPT web run failed in demo runtime: ${pageError}`);
    }

    const finalSummaryLine = summaryLine;
    if (typeof finalSummaryLine === 'string') {
      const markerIndex = finalSummaryLine.indexOf(marker);
      const parsed = JSON.parse(finalSummaryLine.slice(markerIndex + marker.length)) as Record<string, unknown>;
      return {
        ...parsed,
        completedFiles: Array.from(completedFiles),
      };
    }

    if (parsedFilesRan > 0) {
      const failed = Math.max(parsedTotal - parsedPassed, 0);
      return {
        passed: parsedPassed,
        failed,
        errors: parsedErrors + (fatalErrorLine ? 1 : 0),
        total: parsedTotal,
        filesRan: parsedFilesRan,
        summarySource: 'fallback',
        incomplete: true,
        markerMissing: true,
        fatalError: fatalErrorLine,
        completedFiles: Array.from(completedFiles),
      };
    }

    if (typeof fatalErrorLine === 'string') {
      throw new Error(`WPT web run failed before summary: ${fatalErrorLine}`);
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const workerUrls = page.workers().map((worker) => worker.url());
      return {
        passed: 0,
        failed: 0,
        errors: 1,
        total: 1,
        filesRan: 0,
        summarySource: 'timeout-fallback',
        incomplete: true,
        markerMissing: true,
        fatalError: `Missing summary marker before timeout (${timeoutMs}ms): ${marker}; state=${JSON.stringify(pageState)}; workers=${JSON.stringify({ count: workerUrls.length, urls: workerUrls })}`,
        completedFiles: Array.from(completedFiles),
      };
    }

    if (!summaryLine) {
      throw new Error(`Missing summary marker: ${marker}`);
    }
    throw new Error('Unexpected web summary parse state');
  } finally {
    await browser.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  wptPorts = await allocateWptPorts();
  runChecked('pnpm', ['run', 'sync:wpt:cache'], demoRoot, 'sync wpt cache');
  const cachePaths = ensureCanonicalWptCache();
  const files = discoverWptFiles(cachePaths.featureCacheDir, requestedFiles);
  runChecked('pnpm', ['build'], repoRoot, 'root build');
  ensureWptRepo();
  writeWptServeConfig();
  if (files.length === 0) {
    process.stderr.write(`[test:fetch:wpt:web] No cached .any.js files found in ${cachePaths.featureCacheDir}\n`);
    process.exit(1);
  }
  writeFileSync(
    webRuntimeConfigPath,
    `${JSON.stringify({
      debug: debugMode,
      fetchImplementation,
      fetchMode,
      files,
      host: wptHost,
      domainWww: wptDomainWww,
      domainWww2: wptDomainWww2,
      httpPort0: wptPorts.http0,
      httpPort1: wptPorts.http1,
      httpsPort0: wptPorts.https0,
      httpsPort1: wptPorts.https1,
      h2Port0: wptPorts.h2,
      timeoutMs: 30000,
    }, null, 2)}\n`,
    'utf8',
  );
  runChecked('pnpm', ['build'], demoRoot, 'demo build');
  mkdirSync(demoDistRoot, { recursive: true });
  writeFileSync(resolve(demoDistRoot, '.gdignore'), '', 'utf8');
  rmSync(webDistRoot, { recursive: true, force: true });
  mkdirSync(webDistRoot, { recursive: true });
  runChecked(godotExecutable, ['--headless', '--path', '.', '--export-debug', webPreset, webExportPath], demoRoot, 'web export');

  try {
    await verifyWptHostsResolution();
    const wptServer = startWptServer();
    try {
      await waitForWptServerReady();
      await withServers(
        webDistRoot,
        `http://${wptHost}:${String(wptPorts.http0)}`,
        `https://${wptHost}:${String(wptPorts.https0)}`,
        `https://${wptHost}:${String(wptPorts.h2)}`,
        async ({ httpBaseUrl, httpsBaseUrl }) => {
        const runWithContinuation = async (baseUrl: string, selectedFiles: string[]) => {
          if (selectedFiles.length === 0) {
            return {
              passed: 0,
              failed: 0,
              errors: 0,
              total: 0,
              filesRan: 0,
              summarySource: 'marker',
              incomplete: false,
            };
          }

          const pendingFiles = [...selectedFiles];
          let passed = 0;
          let failed = 0;
          let errors = 0;
          let total = 0;
          let filesRan = 0;
          let summarySource = 'marker';
          let incomplete = false;
          let attempts = 0;

          while (pendingFiles.length > 0) {
            attempts += 1;
            if (attempts > 12) {
              throw new Error(`Exceeded continuation attempts while running web suite: pending=${pendingFiles.length}`);
            }

            const summary = await runInBrowser(baseUrl, pendingFiles);
            passed += Number(summary.passed ?? 0);
            failed += Number(summary.failed ?? 0);
            errors += Number(summary.errors ?? 0);
            total += Number(summary.total ?? 0);
            filesRan += Number(summary.filesRan ?? 0);

            const runSource = String(summary.summarySource ?? 'marker');
            const runIncomplete = Boolean(summary.incomplete ?? false);
            const runCompletedFiles = Array.isArray(summary.completedFiles)
              ? summary.completedFiles.filter((value): value is string => typeof value === 'string')
              : [];
            const runCompletedSet = new Set(runCompletedFiles);
            const nextPending = pendingFiles.filter((file) => !runCompletedSet.has(file));

            if (runIncomplete || nextPending.length > 0) {
              summarySource = runSource === 'marker' ? summarySource : runSource;
              incomplete = true;
              if (nextPending.length >= pendingFiles.length) {
                throw new Error(
                  `Web suite stalled without progress: pending=${pendingFiles.length} summarySource=${runSource} filesRan=${String(summary.filesRan ?? 'unknown')}`,
                );
              }
              pendingFiles.length = 0;
              pendingFiles.push(...nextPending);
              process.stdout.write(
                `[WPT_WEB][continuation] rerun pending files=${String(pendingFiles.length)} after source=${runSource}\n`,
              );
              continue;
            }

            pendingFiles.length = 0;
          }

          return {
            passed,
            failed,
            errors,
            total,
            filesRan,
            summarySource,
            incomplete,
          };
        };

        const httpsFiles = files.filter((file) => file.endsWith('.https.any.js'));
        const httpFiles = files.filter((file) => !file.endsWith('.https.any.js'));
        const httpResult = await runWithContinuation(httpBaseUrl, httpFiles);
        const httpsResult = await runWithContinuation(httpsBaseUrl, httpsFiles);
        const passed = httpResult.passed + httpsResult.passed;
        const failed = httpResult.failed + httpsResult.failed;
        const errors = httpResult.errors + httpsResult.errors;
        const total = httpResult.total + httpsResult.total;
        const filesRan = httpResult.filesRan + httpsResult.filesRan;
        let summarySource = 'marker';
        if (httpResult.summarySource !== 'marker') {
          summarySource = httpResult.summarySource;
        }
        if (httpsResult.summarySource !== 'marker') {
          summarySource = httpsResult.summarySource;
        }
        const incomplete = filesRan !== files.length;
        const passRate = total > 0 ? passed / total : 0;
        const summaryPayload = {
          runner: 'web',
          mode: fetchMode,
          implementation: fetchImplementation,
          summarySource,
          selectedFiles: files.length,
          filesRan,
          passed,
          failed,
          errors,
          total,
          passRatePercent: Number((passRate * 100).toFixed(1)),
          incomplete,
        };

        process.stdout.write(`${runnerSummaryMarker}${JSON.stringify(summaryPayload)}\n`);

        process.stdout.write(
          `[test:fetch:wpt:web] mode=${fetchMode} implementation=${fetchImplementation}\n`,
        );
        process.stdout.write(
          `[test:fetch:wpt:web] passed=${String(summaryPayload.passed)} failed=${String(summaryPayload.failed)} errors=${String(summaryPayload.errors)} total=${String(summaryPayload.total)} files=${String(summaryPayload.filesRan)}/${String(summaryPayload.selectedFiles)} source=${summaryPayload.summarySource} incomplete=${String(summaryPayload.incomplete)} pass_rate=${String(summaryPayload.passRatePercent)}%\n`,
        );

        if (Number.isFinite(minimumPassRate) && minimumPassRate > 0 && passRate < minimumPassRate) {
          process.stderr.write(
            `[test:fetch:wpt:web] Pass rate ${String((passRate * 100).toFixed(1))}% is below required ${String((minimumPassRate * 100).toFixed(1))}%\n`,
          );
          process.exit(1);
        }
      },
      );
    } finally {
      await stopWptServer(wptServer);
    }
  } finally {
    rmSync(webRuntimeConfigPath, { force: true });
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
