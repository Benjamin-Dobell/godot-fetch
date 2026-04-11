import { JavaScriptBridge, Node } from 'godot';
import { fetch } from 'godot-fetch';

const Iterations = 200;
const PassPrefix = '[WEB_HTTP_POLL_REGRESSION] PASS';
const FailPrefix = '[WEB_HTTP_POLL_REGRESSION] FAIL';

export default class HttpPollRegressionRunner extends Node {
  override _ready(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      if (!JavaScriptBridge || typeof JavaScriptBridge.eval !== 'function') {
        throw new Error('JavaScriptBridge.eval is unavailable');
      }
      const requestUrl = JavaScriptBridge.eval(
        "globalThis.location && typeof globalThis.location.href === 'string' ? new URL('/http-poll-regression', globalThis.location.href).toString() : ''",
        true,
      ) as string;
      if (typeof requestUrl !== 'string' || requestUrl.length === 0) {
        throw new Error('request URL is unavailable');
      }

      for (let index = 0; index < Iterations; index += 1) {
        const response = await fetch(requestUrl, { method: 'GET' });
        if (!response.ok) {
          throw new Error(`status=${String(response.status)} at iteration=${String(index)}`);
        }

        const body = await response.text();
        if (body !== 'ok') {
          throw new Error(`body=${body} at iteration=${String(index)}`);
        }
      }

      console.log(`${PassPrefix} iterations=${String(Iterations)}`);
      this.get_tree()?.quit(0);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${FailPrefix} ${message}`);
      this.get_tree()?.quit(1);
    }
  }
}
