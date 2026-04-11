import { Node } from 'godot';
import { parseArgs, runWptSuite } from './fetch-wpt-runner.js';

export default class FetchWptRunnerBrowserNode extends Node {
  override _ready(): void {
    void this.run();
  }

  private async run(): Promise<void> {
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
        fetchImplementation: 'browser',
      });
      console.log(`[WPT_GODOT_JSON]${JSON.stringify(summary)}`);
      this.get_tree()?.quit(0);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WPT] ${message}`);
      this.get_tree()?.quit(1);
    }
  }
}
