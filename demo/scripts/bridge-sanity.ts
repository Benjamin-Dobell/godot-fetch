import { OS, SceneTree } from 'godot';
import { runBridgeSanity } from './bridge-sanity-core';

function unpackCliArgs(values: { size: () => number; get: (index: number) => string }): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.size(); index += 1) {
    result.push(values.get(index));
  }
  return result;
}

type BridgeCliOptions = {
  fetchIterations: number;
  fetchUrl: null | string;
  waitMs: number;
};

function parseArgs(): BridgeCliOptions {
  const args = [
    ...unpackCliArgs(OS.get_cmdline_user_args()),
    ...unpackCliArgs(OS.get_cmdline_args()),
  ];

  let fetchUrl: null | string = null;
  let fetchIterations = 5;
  let waitMs = 25;

  for (const arg of args) {
    if (arg.startsWith('--bridge-url=')) {
      fetchUrl = arg.slice('--bridge-url='.length);
      continue;
    }
    if (arg.startsWith('--bridge-iterations=')) {
      fetchIterations = Number.parseInt(arg.slice('--bridge-iterations='.length), 10);
      continue;
    }
    if (arg.startsWith('--bridge-wait-ms=')) {
      waitMs = Number.parseInt(arg.slice('--bridge-wait-ms='.length), 10);
    }
  }

  if (!Number.isFinite(fetchIterations) || fetchIterations < 0) {
    throw new Error(`Invalid --bridge-iterations value: ${String(fetchIterations)}`);
  }
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error(`Invalid --bridge-wait-ms value: ${String(waitMs)}`);
  }

  return {
    fetchUrl,
    fetchIterations,
    waitMs,
  };
}

export default class BridgeSanity extends SceneTree {
  override async _initialize(): Promise<void> {
    try {
      const options = parseArgs();
      const result = await runBridgeSanity(options);
      if (result.failures.length > 0) {
        console.error(`[BRIDGE_SANITY] FAIL failures=${JSON.stringify(result.failures)} snapshots=${JSON.stringify(result.snapshots)}`);
        this.quit(1);
        return;
      }
      console.log(`[BRIDGE_SANITY] PASS snapshots=${JSON.stringify(result.snapshots)}`);
      this.quit(0);
    } catch (error: unknown) {
      console.error(`[BRIDGE_SANITY] FAIL ${error instanceof Error ? error.message : String(error)}`);
      this.quit(1);
    }
  }
}
