import { Node, is_instance_valid } from 'godot';
import { fetch as godotFetch } from 'godot-fetch';

export type BridgeSanityOptions = {
  fetchIterations: number;
  fetchUrl: null | string;
  waitMs: number;
};

type BridgeSnapshot = {
  isInstanceValidType: string;
  label: string;
  nodeFreeType: string;
  nodeGetNameType: string;
};

export type BridgeSanityResult = {
  failures: string[];
  snapshots: BridgeSnapshot[];
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sample(node: Node, label: string): BridgeSnapshot {
  return {
    label,
    isInstanceValidType: typeof is_instance_valid,
    nodeFreeType: typeof node.free,
    nodeGetNameType: typeof node.get_name,
  };
}

export async function runBridgeSanity(options: BridgeSanityOptions): Promise<BridgeSanityResult> {
  const snapshots: BridgeSnapshot[] = [];
  const failures: string[] = [];
  const node = new Node();

  const record = (label: string) => {
    const snapshot = sample(node, label);
    snapshots.push(snapshot);
    if (snapshot.isInstanceValidType !== 'function') {
      failures.push(`${label}: typeof is_instance_valid=${snapshot.isInstanceValidType}`);
    }
    if (snapshot.nodeFreeType !== 'function') {
      failures.push(`${label}: typeof node.free=${snapshot.nodeFreeType}`);
    }
    if (snapshot.nodeGetNameType !== 'function') {
      failures.push(`${label}: typeof node.get_name=${snapshot.nodeGetNameType}`);
    }
  };

  record('initial');
  if (typeof is_instance_valid === 'function') {
    if (!is_instance_valid(node)) {
      failures.push('initial: is_instance_valid(node) returned false');
    }
  }

  for (let index = 0; index < options.fetchIterations; index += 1) {
    await delay(options.waitMs);
    record(`tick-${String(index)}`);
    console.log(`[BRIDGE_SANITY_TRACE] tick=${String(index)} sampled`);
    if (options.fetchUrl) {
      try {
        console.log(`[BRIDGE_SANITY_TRACE] tick=${String(index)} fetch:start url=${options.fetchUrl}`);
        const response = await godotFetch(options.fetchUrl, { method: 'GET' });
        console.log(`[BRIDGE_SANITY_TRACE] tick=${String(index)} fetch:headers status=${String((response as { status?: unknown }).status ?? 'unknown')}`);
        await response.text();
        console.log(`[BRIDGE_SANITY_TRACE] tick=${String(index)} fetch:done`);
      } catch (error: unknown) {
        console.log(`[BRIDGE_SANITY_TRACE] tick=${String(index)} fetch:error ${error instanceof Error ? error.message : String(error)}`);
        failures.push(`tick-${String(index)}: fetch failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  record('before-free');
  node.free();
  if (typeof is_instance_valid === 'function' && is_instance_valid(node)) {
    failures.push('after-free: is_instance_valid(node) returned true');
  }

  return { snapshots, failures };
}
