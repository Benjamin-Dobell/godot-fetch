import { EditorExportPlugin, EditorPlugin } from 'godot';
import WptCacheExportPlugin from './wpt_cache_export_plugin';

export default class WptCacheExportPluginBootstrap extends EditorPlugin {
  private _export_plugin: null | EditorExportPlugin = null;

  override _enter_tree(): void {
    this._export_plugin = new WptCacheExportPlugin();
    this.add_export_plugin(this._export_plugin);
  }

  override _exit_tree(): void {
    if (this._export_plugin === null) {
      return;
    }
    this.remove_export_plugin(this._export_plugin);
    this._export_plugin = null;
  }
}
