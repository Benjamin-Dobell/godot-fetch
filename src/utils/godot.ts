import { PackedStringArray } from 'godot.lib.api';

export function unpackStringArray(stringArray: PackedStringArray): string[] {
  const length = stringArray.size();
  const unpacked = new Array<string>(length);

  for (let i = 0; i < length; i++) {
    unpacked[i] = stringArray.get(i);
  }

  return unpacked;
}
