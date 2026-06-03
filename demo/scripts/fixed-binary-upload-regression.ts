import { OS, SceneTree } from 'godot';
import type { Fetch } from 'godot-fetch/standards';

declare function require(id: string): unknown;

const { fetch } = require('godot-fetch') as { fetch: Fetch };

type RegressionArgs = {
  expectedBody: string;
  maxElapsedMs: number;
  url: string;
};

function unpackCliArgs(values: { size: () => number; get: (index: number) => string }): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.size(); index += 1) {
    result.push(values.get(index));
  }
  return result;
}

function parseArgs(): RegressionArgs {
  const args = [
    ...unpackCliArgs(OS.get_cmdline_user_args()),
    ...unpackCliArgs(OS.get_cmdline_args()),
  ];

  let expectedBody = 'ok';
  let maxElapsedMs = 5_000;
  let url: null | string = null;

  for (const arg of args) {
    if (arg.startsWith('--fixed-binary-upload-url=')) {
      url = arg.slice('--fixed-binary-upload-url='.length);
      continue;
    }
    if (arg.startsWith('--fixed-binary-upload-expected-body=')) {
      expectedBody = arg.slice('--fixed-binary-upload-expected-body='.length);
      continue;
    }
    if (arg.startsWith('--fixed-binary-upload-max-elapsed-ms=')) {
      maxElapsedMs = Number.parseInt(arg.slice('--fixed-binary-upload-max-elapsed-ms='.length), 10);
    }
  }

  if (!url || url.length === 0) {
    throw new Error('Missing required --fixed-binary-upload-url argument');
  }
  if (!Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) {
    throw new Error('Invalid --fixed-binary-upload-max-elapsed-ms argument');
  }

  return { expectedBody, maxElapsedMs, url };
}

function buildPayload(): ArrayBuffer {
  const bytes = new Uint8Array(256 * 1024);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes.buffer;
}

export default class FixedBinaryUploadRegression extends SceneTree {
  override async _initialize(): Promise<void> {
    try {
      const args = parseArgs();
      const startedAtMs = Date.now();
      const response = await fetch(args.url, {
        body: buildPayload(),
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        method: 'PUT',
      });
      const elapsedMs = Date.now() - startedAtMs;

      if (!response.ok) {
        throw new Error(`PUT failed with status ${String(response.status)}: ${await response.text()}`);
      }

      const body = await response.text();
      if (body !== args.expectedBody) {
        throw new Error(`Unexpected response body: ${body}`);
      }

      if (elapsedMs > args.maxElapsedMs) {
        throw new Error(`PUT took ${String(elapsedMs)}ms, expected <= ${String(args.maxElapsedMs)}ms`);
      }

      console.log(`[JS] Fixed binary upload regression passed elapsedMs=${String(elapsedMs)} body=${body}`);
      this.quit(0);
    } catch (error: unknown) {
      console.error(`[JS] Fixed binary upload regression failed: ${error instanceof Error ? error.message : String(error)}`);
      this.quit(1);
    }
  }
}
