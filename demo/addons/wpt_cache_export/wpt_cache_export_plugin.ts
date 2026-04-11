import { EditorExportPlugin, DirAccess, FileAccess, PackedStringArray } from 'godot';

const WPT_CACHE_ROOT = 'res://wpt-cache';
const WPT_RUNNER_SCRIPTS_ROOT = 'res://.godot/GodotJS/scripts/wpt';
const REQUIRED_RUNNER_FILES = [
  'res://.godot/GodotJS/scripts/wpt/fetch-wpt-runner.js',
  'res://.godot/GodotJS/scripts/wpt/fetch-wpt-runner.js.map',
  'res://.godot/GodotJS/scripts/wpt/fetch-runner-polyfill-node.js',
  'res://.godot/GodotJS/scripts/wpt/fetch-runner-polyfill-node.js.map',
  'res://.godot/GodotJS/scripts/wpt/fetch-wpt-runner-browser-node.js',
  'res://.godot/GodotJS/scripts/wpt/fetch-wpt-runner-browser-node.js.map',
];

export default class WptCacheExportPlugin extends EditorExportPlugin {
  override _get_name(): string {
    return 'WptCacheExportPlugin';
  }

  override _export_begin(features: PackedStringArray, _is_debug: boolean, _path: string, _flags: number): void {
    if (!features.has('web')) {
      return;
    }

    this._add_directory_recursive(WPT_CACHE_ROOT);
    this._add_directory_recursive(WPT_RUNNER_SCRIPTS_ROOT);

    for (const filePath of REQUIRED_RUNNER_FILES) {
      this._add_file_if_exists(filePath);
    }
  }

  private _add_file_if_exists(filePath: string): void {
    if (!FileAccess.file_exists(filePath)) {
      return;
    }

    this.add_file(filePath, FileAccess.get_file_as_bytes(filePath), false);
  }

  private _add_directory_recursive(dirPath: string): void {
    const directory = DirAccess.open(dirPath);

    if (!directory) {
      return;
    }

    directory.list_dir_begin();
    let entryName = directory.get_next();

    while (entryName !== '') {
      if (entryName === '.' || entryName === '..') {
        entryName = directory.get_next();
        continue;
      }

      const childPath = `${dirPath}/${entryName}`;

      if (directory.current_is_dir()) {
        this._add_directory_recursive(childPath);
      } else {
        this.add_file(childPath, FileAccess.get_file_as_bytes(childPath), false);
      }

      entryName = directory.get_next();
    }
    directory.list_dir_end();
  }
}
