import process from 'node:process';

export function requireGodotExecutable(): string {
  const godot = process.env.GODOT;
  if (!godot) {
    throw new Error(
      'GODOT environment variable is required and must point to a GodotJS editor executable for this test suite.',
    );
  }
  return godot;
}
