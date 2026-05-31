import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireGodotExecutable } from './require-godot.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const godotBinary = requireGodotExecutable();

const RequestCount = 1_000;
const ObservationWindowMs = 5_000;
const MaxResolvedWithinWindow = 16;
const RegressionTestTimeoutMs = 120_000;
const PassMarker = '[DIRECT_STREAM_BACKPRESSURE] PASS';
const FailMarker = '[DIRECT_STREAM_BACKPRESSURE] FAIL';
const HoldResponseContentLengthBytes = 1_000_000_000;

type HoldConnection = {
  interval: NodeJS.Timeout;
  response: ServerResponse<IncomingMessage>;
};

function ensureDemoBuild(): void {
  const buildResult = spawnSync('pnpm', ['build'], {
    cwd: demoRoot,
    encoding: 'utf8',
  });

  if (buildResult.error) {
    throw buildResult.error;
  }

  if (buildResult.status !== 0) {
    process.stderr.write(`${buildResult.stdout}${buildResult.stderr}`);
    throw new Error(`demo build failed with exit code ${String(buildResult.status)}`);
  }
}

async function withHoldOpenServer<T>(
  run: (
    url: string,
    getRequestCount: () => number,
    getMaxConcurrentConnectionCount: () => number,
  ) => Promise<T>,
): Promise<T> {
  const openConnections = new Set<HoldConnection>();
  let requestCount = 0;
  let maxConcurrentConnectionCount = 0;

  const server = createServer((request, response) => {
    if (request.url !== '/hold') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }

    requestCount += 1;
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(HoldResponseContentLengthBytes),
      Connection: 'keep-alive',
    });
    response.write(Buffer.alloc(64 * 1024, 0x61));

    const interval = setInterval(() => {
      if (!response.writableEnded) {
        response.write(Buffer.from('x'));
      }
    }, 250);

    const holdConnection: HoldConnection = { interval, response };
    openConnections.add(holdConnection);
    if (openConnections.size > maxConcurrentConnectionCount) {
      maxConcurrentConnectionCount = openConnections.size;
    }

    response.on('close', () => {
      clearInterval(interval);
      openConnections.delete(holdConnection);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to resolve hold-open server address');
  }

  const url = `http://127.0.0.1:${String(address.port)}/hold`;

  try {
    return await run(
      url,
      () => requestCount,
      () => maxConcurrentConnectionCount,
    );
  } finally {
    process.stdout.write(`[test:direct-stream-backpressure] hold endpoint request_count=${String(requestCount)}\n`);
    for (const connection of openConnections) {
      clearInterval(connection.interval);
      if (!connection.response.writableEnded) {
        connection.response.end();
      }
    }
    server.close();
    await once(server, 'close');
  }
}

function runGodotDirectStreamBackpressureRegression(url: string): Promise<{ output: string; status: null | number }> {
  return new Promise((resolveResult, rejectResult) => {
    const processHandle = spawn(
      godotBinary,
      [
        '--headless',
        '--path',
        '.',
        '-s',
        'res://scripts/direct-stream-backpressure-regression.ts',
        `--regression-url=${url}`,
        `--regression-request-count=${String(RequestCount)}`,
        `--regression-window-ms=${String(ObservationWindowMs)}`,
        `--regression-max-resolved=${String(MaxResolvedWithinWindow)}`,
      ],
      {
        cwd: demoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      output += `\n[test:direct-stream-backpressure] timed out after ${String(RegressionTestTimeoutMs)}ms; terminating Godot process\n`;
      processHandle.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          processHandle.kill('SIGKILL');
        }
      }, 5_000);
    }, RegressionTestTimeoutMs);

    processHandle.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    processHandle.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    processHandle.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rejectResult(error);
    });

    processHandle.on('close', (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({ output, status });
    });
  });
}

async function main(): Promise<void> {
  ensureDemoBuild();

  await withHoldOpenServer(async (url, getRequestCount, getMaxConcurrentConnectionCount) => {
    const runResult = await runGodotDirectStreamBackpressureRegression(url);
    const observedRequestCount = getRequestCount();
    const observedMaxConcurrentConnectionCount = getMaxConcurrentConnectionCount();

    const failed = runResult.status !== 0 || !runResult.output.includes(PassMarker) || runResult.output.includes(FailMarker);
    if (failed) {
      const diagnostics: string[] = [];
      diagnostics.push(runResult.output);
      if (!runResult.output.includes(PassMarker)) {
        diagnostics.push(`Missing regression pass marker: ${PassMarker}`);
      }
      diagnostics.push(`Regression status code: ${String(runResult.status ?? 1)}`);
      throw new Error(diagnostics.join('\n'));
    }

    if (observedRequestCount <= 0) {
      throw new Error(
        `No requests reached hold endpoint during regression window (observed_requests=${String(observedRequestCount)})`,
      );
    }

    if (observedMaxConcurrentConnectionCount > MaxResolvedWithinWindow) {
      throw new Error(
        `Direct-stream backpressure regression detected: observed hold-endpoint max concurrent connections exceeded cap (max_concurrent_connections=${String(observedMaxConcurrentConnectionCount)} observed_requests=${String(observedRequestCount)} max_allowed=${String(MaxResolvedWithinWindow)})`,
      );
    }

    process.stdout.write('[test:direct-stream-backpressure] Direct-stream backpressure regression passed\n');
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
