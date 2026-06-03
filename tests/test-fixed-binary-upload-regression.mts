import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { requireGodotExecutable } from './require-godot.mts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');
const godotBinary = requireGodotExecutable();
const RegressionTimeoutMs = 15_000;
const MaxFetchElapsedMs = 5_000;
const PassMarker = '[JS] Fixed binary upload regression passed';

function findNonLoopbackIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  throw new Error('No non-loopback IPv4 address available; cannot exercise native HTTP transport path');
}

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

async function withUploadServer<T>(run: (url: string, getSawConnectionClose: () => boolean) => Promise<T>): Promise<T> {
  let sawConnectionClose = false;
  let receivedBytes = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'PUT' || request.url !== '/upload') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    sawConnectionClose = String(request.headers.connection ?? '').toLowerCase().split(',')
      .some(value => value.trim() === 'close');

    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
    });

    request.on('end', () => {
      if (receivedBytes <= 0) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end('missing upload body');
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('ok');
    });
  });
  server.keepAliveTimeout = 30_000;

  server.listen(0, '0.0.0.0');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to resolve upload regression server address');
  }

  const url = `http://${findNonLoopbackIpv4()}:${String(address.port)}/upload`;

  try {
    return await run(url, () => sawConnectionClose);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function runGodot(url: string): Promise<{ output: string; status: null | number }> {
  return new Promise((resolveResult, rejectResult) => {
    const processHandle = spawn(
      godotBinary,
      [
        '--headless',
        '--path',
        '.',
        '-s',
        'res://scripts/fixed-binary-upload-regression.ts',
        `--fixed-binary-upload-url=${url}`,
        '--fixed-binary-upload-expected-body=ok',
        `--fixed-binary-upload-max-elapsed-ms=${String(MaxFetchElapsedMs)}`,
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
      output += `\n[test:fixed-binary-upload] timed out after ${String(RegressionTimeoutMs)}ms\n`;
      processHandle.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          processHandle.kill('SIGKILL');
        }
      }, 2_000);
    }, RegressionTimeoutMs);

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

  await withUploadServer(async (url, getSawConnectionClose) => {
    const runResult = await runGodot(url);
    if (runResult.status !== 0 || !runResult.output.includes(PassMarker)) {
      process.stderr.write(runResult.output);
      if (!runResult.output.includes(PassMarker)) {
        process.stderr.write(`\nMissing fixed binary upload marker: ${PassMarker}\n`);
      }
      process.exit(runResult.status ?? 1);
    }

    if (!getSawConnectionClose()) {
      process.stderr.write(runResult.output);
      throw new Error('Fixed binary upload did not send Connection: close');
    }

    process.stdout.write('[test:fixed-binary-upload] native fixed binary upload regression passed\n');
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
