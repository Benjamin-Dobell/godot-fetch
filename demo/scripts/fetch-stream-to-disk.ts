import { DirAccess, FileAccess, OS, SceneTree } from 'godot';
import type { Fetch } from 'godot-fetch/standards';

declare function require(id: string): unknown;

const { fetch } = require('godot-fetch') as { fetch: Fetch };

type StreamArgs = {
  url: string;
  outputPath: string;
  expectedBytes: number;
};

function unpackCliArgs(values: { size: () => number; get: (index: number) => string }): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.size(); index += 1) {
    result.push(values.get(index));
  }
  return result;
}

function parseArgs(): StreamArgs {
  const args = [
    ...unpackCliArgs(OS.get_cmdline_user_args()),
    ...unpackCliArgs(OS.get_cmdline_args()),
  ];

  let url: null | string = null;
  let outputPath = 'user://fetch-streaming.bin';
  let expectedBytes = Number.NaN;

  for (const arg of args) {
    if (arg.startsWith('--stream-url=')) {
      url = arg.slice('--stream-url='.length);
      continue;
    }
    if (arg.startsWith('--stream-output=')) {
      outputPath = arg.slice('--stream-output='.length);
      continue;
    }
    if (arg.startsWith('--stream-expected-bytes=')) {
      expectedBytes = Number.parseInt(arg.slice('--stream-expected-bytes='.length), 10);
    }
  }

  if (!url || url.length === 0) {
    throw new Error('Missing required --stream-url argument');
  }
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    throw new Error('Missing required --stream-expected-bytes argument');
  }

  return { url, outputPath, expectedBytes };
}

function toBufferChunk(value: Uint8Array): ArrayBuffer {
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return value.buffer as ArrayBuffer;
  }
  return value.slice().buffer;
}

function readFileLength(path: string): number {
  const file = FileAccess.open(path, FileAccess.ModeFlags.READ);
  if (!file) {
    throw new Error(`Failed to open output file for verification: ${path}`);
  }
  try {
    return Number(file.get_length());
  } finally {
    file.close();
  }
}

export default class FetchStreamToDisk extends SceneTree {
  override async _initialize(): Promise<void> {
    try {
      const args = parseArgs();
      DirAccess.remove_absolute(args.outputPath);

      const response = await fetch(args.url, { method: 'GET' });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Streaming request failed with status ${String(response.status)}: ${body}`);
      }
      if (!response.body) {
        throw new Error('Streaming request did not expose a response body stream');
      }

      const file = FileAccess.open(args.outputPath, FileAccess.ModeFlags.WRITE);
      if (!file) {
        throw new Error(`Failed to open output file for write: ${args.outputPath}`);
      }

      let chunks = 0;
      let bytesWritten = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          const value = result.value;
          if (!(value instanceof Uint8Array)) {
            throw new Error(`Expected Uint8Array chunk, received: ${typeof value}`);
          }
          const writeOk = file.store_buffer(toBufferChunk(value));
          if (!writeOk) {
            throw new Error(`Failed to write stream chunk to file: ${args.outputPath}`);
          }
          chunks += 1;
          bytesWritten += value.byteLength;
        }
      } finally {
        file.close();
      }

      const expectedBytesFromHeader = Number.parseInt(response.headers.get('x-expected-bytes') ?? '', 10);
      const expectedSha256 = response.headers.get('x-expected-sha256');
      const expectedBytes = Number.isFinite(expectedBytesFromHeader) ? expectedBytesFromHeader : args.expectedBytes;

      if (bytesWritten !== expectedBytes) {
        throw new Error(`Streamed byte count mismatch (got=${String(bytesWritten)} expected=${String(expectedBytes)})`);
      }

      const fileBytes = readFileLength(args.outputPath);
      if (fileBytes !== expectedBytes) {
        throw new Error(`Output file length mismatch (got=${String(fileBytes)} expected=${String(expectedBytes)})`);
      }

      const sha256 = FileAccess.get_sha256(args.outputPath).toLowerCase();
      if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
        throw new Error(`Output file hash mismatch (got=${sha256} expected=${expectedSha256.toLowerCase()})`);
      }

      console.log(
        `[JS] Fetch stream-to-disk test passed chunks=${String(chunks)} bytes=${String(bytesWritten)} path=${args.outputPath}`,
      );
      console.log(`[JS] SHA256 ${sha256}`);
      this.quit(0);
    } catch (error: unknown) {
      console.error(`[JS] Fetch stream-to-disk test failed: ${error instanceof Error ? error.message : String(error)}`);
      this.quit(1);
    }
  }
}
