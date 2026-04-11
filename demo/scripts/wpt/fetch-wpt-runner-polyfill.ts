import { SceneTree } from 'godot';
import 'godot-fetch/godot/global';
import { parseArgs, runWptSuite } from './fetch-wpt-runner.js';
export { runWptSuite };

export default class FetchWptRunnerPolyfill extends SceneTree {
  override async _initialize(): Promise<void> {
    try {
      const args = parseArgs();
      const summary = await runWptSuite({
        files: args.files,
        debug: args.debug,
        fetchMode: args.fetchMode,
        host: args.host,
        domainWww: args.domainWww,
        domainWww2: args.domainWww2,
        httpPort0: args.httpPort0,
        httpPort1: args.httpPort1,
        httpsPort0: args.httpsPort0,
        httpsPort1: args.httpsPort1,
        h2Port0: args.h2Port0,
        timeoutMs: args.timeoutMs,
        fetchImplementation: 'polyfill',
      });
      console.log(`[WPT_GODOT_JSON]${JSON.stringify(summary)}`);
      this.quit(0);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WPT] ${message}`);
      this.quit(1);
    }
  }
}
