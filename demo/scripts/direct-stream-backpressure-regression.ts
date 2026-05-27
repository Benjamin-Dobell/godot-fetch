import { OS, SceneTree } from 'godot';
import type { Fetch, Response as FetchResponse } from 'godot-fetch/standards';

declare function require(id: string): unknown;

const { fetch } = require('godot-fetch') as { fetch: Fetch };

const DefaultRequestCount = 1_000;
const DefaultObservationWindowMs = 5_000;

const PassPrefix = '[DIRECT_STREAM_BACKPRESSURE] PASS';
const FailPrefix = '[DIRECT_STREAM_BACKPRESSURE] FAIL';

type RegressionArgs = {
  observationWindowMs: number;
  requestCount: number;
  url: string;
};

function unpackCliArgs(values: { size: () => number; get: (index: number) => string }): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.size(); index += 1) {
    result.push(values.get(index));
  }
  return result;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(): RegressionArgs {
  const args = [
    ...unpackCliArgs(OS.get_cmdline_user_args()),
    ...unpackCliArgs(OS.get_cmdline_args()),
  ];

  let url: null | string = null;
  let requestCount = DefaultRequestCount;
  let observationWindowMs = DefaultObservationWindowMs;

  for (const arg of args) {
    if (arg.startsWith('--regression-url=')) {
      url = arg.slice('--regression-url='.length);
      continue;
    }

    if (arg.startsWith('--regression-request-count=')) {
      requestCount = parsePositiveInteger(arg.slice('--regression-request-count='.length), DefaultRequestCount);
      continue;
    }

    if (arg.startsWith('--regression-window-ms=')) {
      observationWindowMs = parsePositiveInteger(arg.slice('--regression-window-ms='.length), DefaultObservationWindowMs);
      continue;
    }

  }

  if (!url || url.length === 0) {
    throw new Error('Missing required --regression-url argument');
  }

  return {
    observationWindowMs,
    requestCount,
    url,
  };
}

function waitForTimeout(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export default class DirectStreamBackpressureRegression extends SceneTree {
  override async _initialize(): Promise<void> {
    const capturedResponses: FetchResponse[] = [];

    try {
      const args = parseArgs();
      let resolved = 0;
      let rejected = 0;

      for (let index = 0; index < args.requestCount; index += 1) {
        void fetch(args.url, { method: 'GET' })
          .then((response) => {
            capturedResponses.push(response);
            resolved += 1;
          })
          .catch(() => {
            rejected += 1;
          });
      }

      await waitForTimeout(args.observationWindowMs);

      const pending = args.requestCount - resolved - rejected;
      console.log(
        `${PassPrefix} resolved=${String(resolved)} pending=${String(pending)} rejected=${String(rejected)} requests=${String(args.requestCount)} window_ms=${String(args.observationWindowMs)}`,
      );
      this.quit(0);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${FailPrefix} ${message}`);
      this.quit(1);
    } finally {
      for (const response of capturedResponses) {
        try {
          response.body?.cancel('regression-cleanup');
        } catch {
          // Ignore cleanup errors while process exits.
        }
      }
    }
  }
}
