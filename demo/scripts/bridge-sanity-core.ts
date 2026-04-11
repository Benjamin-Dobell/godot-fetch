import { HTTPClient, is_instance_valid } from 'godot';
import { fetch as godotFetch } from 'godot-fetch';

export type BridgeSanityOptions = {
  fetchIterations: number;
  fetchUrl: null | string;
  waitMs: number;
};

type BridgeSnapshot = {
  clientCloseType: string;
  clientGetStatusType: string;
  isInstanceValidType: string;
  label: string;
};

export type BridgeSanityResult = {
  failures: string[];
  snapshots: BridgeSnapshot[];
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sample(client: HTTPClient, label: string): BridgeSnapshot {
  return {
    label,
    isInstanceValidType: typeof is_instance_valid,
    clientCloseType: typeof client.close,
    clientGetStatusType: typeof client.get_status,
  };
}

export async function runBridgeSanity(options: BridgeSanityOptions): Promise<BridgeSanityResult> {
  const snapshots: BridgeSnapshot[] = [];
  const failures: string[] = [];
  const client = new HTTPClient();

  const record = (label: string) => {
    const snapshot = sample(client, label);
    snapshots.push(snapshot);
    if (snapshot.isInstanceValidType !== 'function') {
      failures.push(`${label}: typeof is_instance_valid=${snapshot.isInstanceValidType}`);
    }
    if (snapshot.clientCloseType !== 'function') {
      failures.push(`${label}: typeof client.close=${snapshot.clientCloseType}`);
    }
    if (snapshot.clientGetStatusType !== 'function') {
      failures.push(`${label}: typeof client.get_status=${snapshot.clientGetStatusType}`);
    }
  };

  record('initial');
  if (typeof is_instance_valid === 'function') {
    if (!is_instance_valid(client)) {
      failures.push('initial: is_instance_valid(client) returned false');
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

  client.close();
  record('after-close');

  return { snapshots, failures };
}
