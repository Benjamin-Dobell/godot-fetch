import { createHash } from 'node:crypto';
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

const StreamChunkSize = 64 * 1024;
const StreamChunkCount = 256;
const StreamTotalBytes = StreamChunkSize * StreamChunkCount;
const StreamTestTimeoutMs = 120_000;

function buildChunk(): Buffer {
  const chunk = Buffer.allocUnsafe(StreamChunkSize);
  for (let index = 0; index < chunk.length; index += 1) {
    chunk[index] = index % 251;
  }
  return chunk;
}

function buildExpectedSha256(chunk: Buffer): string {
  const hash = createHash('sha256');
  for (let index = 0; index < StreamChunkCount; index += 1) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function streamResponse(response: ServerResponse<IncomingMessage>, chunk: Buffer): void {
  let sent = 0;

  const send = () => {
    while (sent < StreamChunkCount) {
      const canContinue = response.write(chunk);
      sent += 1;
      if (!canContinue) {
        response.once('drain', send);
        return;
      }
      if (sent % 8 === 0) {
        setTimeout(send, 1);
        return;
      }
    }
    response.end();
  };

  send();
}

async function withStreamingServer<T>(run: (url: string, expectedSha256: string) => T | Promise<T>): Promise<T> {
  const chunk = buildChunk();
  const expectedSha256 = buildExpectedSha256(chunk);

  const server = createServer((request, response) => {
    if (request.url !== '/stream.bin') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not Found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Expected-Bytes': String(StreamTotalBytes),
      'X-Expected-Sha256': expectedSha256,
      'Cache-Control': 'no-store',
    });
    streamResponse(response, chunk);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to resolve streaming server address');
  }

  const url = `http://127.0.0.1:${String(address.port)}/stream.bin`;

  try {
    return await run(url, expectedSha256);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function runGodotFetchStreamTest(url: string): Promise<{ output: string; status: null | number }> {
  return new Promise((resolveResult, rejectResult) => {
    const processHandle = spawn(
      godotBinary,
      [
        '--headless',
        '--path',
        '.',
        '-s',
        'res://scripts/fetch-stream-to-disk.ts',
        `--stream-url=${url}`,
        '--stream-output=user://fetch-streaming.bin',
        `--stream-expected-bytes=${String(StreamTotalBytes)}`,
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
      output += `\n[test:stream] timed out after ${String(StreamTestTimeoutMs)}ms; terminating Godot process\n`;
      processHandle.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          processHandle.kill('SIGKILL');
        }
      }, 5_000);
    }, StreamTestTimeoutMs);

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

async function main(): Promise<void> {
  ensureDemoBuild();

  await withStreamingServer(async (url, expectedSha256) => {
    const runResult = await runGodotFetchStreamTest(url);

    const requiredMarkers = [
      '[JS] Fetch stream-to-disk test passed',
      `[JS] SHA256 ${expectedSha256}`,
    ];

    const missingMarkers = requiredMarkers.filter((marker) => !runResult.output.includes(marker));

    if (runResult.status !== 0 || missingMarkers.length > 0) {
      process.stderr.write(runResult.output);
      if (missingMarkers.length > 0) {
        process.stderr.write(`\nMissing stream test markers: ${missingMarkers.join(', ')}\n`);
      }
      process.exit(runResult.status ?? 1);
    }

    process.stdout.write('[test:stream] Fetch stream-to-disk test passed\n');
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
