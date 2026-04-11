import { Error as GodotError, HTTPRequest, SceneTree } from 'godot';

export default class HttpSmoke extends SceneTree {
  override async _initialize(): Promise<void> {
    const request = new HTTPRequest();
    if (this.root === null) {
      throw new globalThis.Error('SceneTree root is null');
    }
    this.root.add_child(request);
    await request.ready.as_promise();

    try {
      const requestError = request.request('https://google.com');
      if (requestError !== GodotError.OK) {
        console.error(`[JS] HTTP GET test failed to start: ${String(requestError)}`);
        this.quit(1);
        return;
      }

      const [result, responseCode, _headers, body] = await request.request_completed.as_promise();
      const bodyLength = body.get_string_from_utf8().length;
      console.log(`[JS] HTTP GET test passed (result=${String(result)}, status=${String(responseCode)}, bytes=${String(bodyLength)})`);
      this.quit(0);
    } catch (error: unknown) {
      console.error(`[JS] HTTP GET test failed: ${error instanceof globalThis.Error ? error.message : String(error)}`);
      this.quit(1);
    } finally {
      request.queue_free();
    }
  }
}
