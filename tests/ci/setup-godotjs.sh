#!/usr/bin/env bash
set -euo pipefail

godotjs_release_tag="${GODOTJS_RELEASE_TAG:-v1.1.0.beta1-4.6.1}"
godotjs_release_base="https://github.com/godotjs/GodotJS/releases/download/${godotjs_release_tag}"

editor_archive_url="${GODOTJS_EDITOR_ARCHIVE_URL:-${godotjs_release_base}/linux-editor-4.6.1-v8.zip}"
editor_archive_sha256="${GODOTJS_EDITOR_ARCHIVE_SHA256:-}"
template_debug_archive_url="${GODOTJS_TEMPLATE_DEBUG_ARCHIVE_URL:-${godotjs_release_base}/web-dlink-template_debug-4.6.1-browser.zip}"
template_debug_archive_sha256="${GODOTJS_TEMPLATE_DEBUG_ARCHIVE_SHA256:-}"
template_release_archive_url="${GODOTJS_TEMPLATE_RELEASE_ARCHIVE_URL:-${godotjs_release_base}/web-dlink-template_release-4.6.1-browser.zip}"
template_release_archive_sha256="${GODOTJS_TEMPLATE_RELEASE_ARCHIVE_SHA256:-}"
templates_version_override="${GODOT_EXPORT_TEMPLATES_VERSION:-4.6.1.stable}"

if [[ -z "$editor_archive_url" ]]; then
  echo "GODOTJS_EDITOR_ARCHIVE_URL is required (or set GODOTJS_RELEASE_TAG)." >&2
  exit 1
fi

workdir="${RUNNER_TEMP:-/tmp}/godotjs-toolchain"
editor_archive_path="$workdir/editor-archive"
editor_extract_dir="$workdir/editor-extracted"
templates_extract_dir="$workdir/templates-extracted"
rm -rf "$workdir"
mkdir -p "$editor_extract_dir" "$templates_extract_dir"

download_archive() {
  local url="$1"
  local output_path="$2"
  local checksum="${3:-}"
  echo "[ci] downloading archive: $url"
  curl -fL --retry 4 --retry-delay 2 "$url" -o "$output_path"
  if [[ -n "$checksum" ]]; then
    echo "[ci] verifying SHA256 for $url"
    local actual
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$output_path" | awk '{print $1}')"
    else
      actual="$(sha256sum "$output_path" | awk '{print $1}')"
    fi
    if [[ "$actual" != "$checksum" ]]; then
      echo "Archive checksum mismatch: expected=$checksum actual=$actual url=$url" >&2
      exit 1
    fi
  fi
}

extract_archive() {
  local archive_path="$1"
  local source_url="$2"
  local destination_dir="$3"
  case "$source_url" in
    *.zip) unzip -q "$archive_path" -d "$destination_dir" ;;
    *.tar.xz|*.txz) tar -xJf "$archive_path" -C "$destination_dir" ;;
    *.tar.gz|*.tgz) tar -xzf "$archive_path" -C "$destination_dir" ;;
    *.tar) tar -xf "$archive_path" -C "$destination_dir" ;;
    *)
      if command -v bsdtar >/dev/null 2>&1; then
        bsdtar -xf "$archive_path" -C "$destination_dir"
      else
        echo "Unsupported archive type for URL: $source_url" >&2
        exit 1
      fi
      ;;
  esac
}

download_archive "$editor_archive_url" "$editor_archive_path" "$editor_archive_sha256"
extract_archive "$editor_archive_path" "$editor_archive_url" "$editor_extract_dir"

find_godot_bin() {
  local base="$1"
  local app_bin
  app_bin="$(find "$base" -type f -path "*/Godot*.app/Contents/MacOS/Godot*" | head -n 1 || true)"
  if [[ -n "$app_bin" ]]; then
    echo "$app_bin"
    return 0
  fi

  local direct_bin
  direct_bin="$(find "$base" -type f \( -name "Godot*" -o -name "godot*" \) | head -n 1 || true)"
  if [[ -n "$direct_bin" ]]; then
    echo "$direct_bin"
    return 0
  fi

  return 1
}

godot_bin="$(find_godot_bin "$editor_extract_dir" || true)"
if [[ -z "$godot_bin" ]]; then
  echo "Unable to locate Godot executable in extracted archive." >&2
  find "$editor_extract_dir" -maxdepth 4 -type f | sed 's/^/[ci] file: /' | head -n 200
  exit 1
fi

chmod +x "$godot_bin"
godot_version="$("$godot_bin" --version | head -n 1 | awk '{print $1}')"
if [[ -z "$godot_version" ]]; then
  echo "Failed to read Godot version from $godot_bin" >&2
  exit 1
fi

templates_version="${templates_version_override:-$godot_version}"
if [[ "$RUNNER_OS" == "macOS" ]]; then
  templates_target="$HOME/Library/Application Support/Godot/export_templates/$templates_version"
else
  templates_target="$HOME/.local/share/godot/export_templates/$templates_version"
fi
mkdir -p "$templates_target"

find_templates_source() {
  local base="$1"
  local from_templates
  from_templates="$(find "$base" -type f \( -name "*template*" -o -name "*.tpz" -o -name "web_*" \) -print | head -n 1 || true)"
  if [[ -n "$from_templates" ]]; then
    dirname "$from_templates"
    return 0
  fi

  return 1
}

if [[ -n "$template_debug_archive_url" ]]; then
  template_debug_archive_path="$workdir/template-debug-archive"
  template_debug_extract_dir="$templates_extract_dir/debug"
  mkdir -p "$template_debug_extract_dir"
  download_archive "$template_debug_archive_url" "$template_debug_archive_path" "$template_debug_archive_sha256"
  extract_archive "$template_debug_archive_path" "$template_debug_archive_url" "$template_debug_extract_dir"
fi

if [[ -n "$template_release_archive_url" ]]; then
  template_release_archive_path="$workdir/template-release-archive"
  template_release_extract_dir="$templates_extract_dir/release"
  mkdir -p "$template_release_extract_dir"
  download_archive "$template_release_archive_url" "$template_release_archive_path" "$template_release_archive_sha256"
  extract_archive "$template_release_archive_path" "$template_release_archive_url" "$template_release_extract_dir"
fi

install_inner_web_template_zip() {
  local extract_base="$1"
  local template_kind="$2"
  local inner_template
  local inner_template_name="godot.web.template_${template_kind}.wasm32.zip"
  inner_template="$(find "$extract_base" -type f -name "$inner_template_name" -print | head -n 1 || true)"
  if [[ -z "$inner_template" ]]; then
    return 1
  fi

  cp "$inner_template" "$templates_target/web_${template_kind}.zip"
  cp "$inner_template" "$templates_target/web_dlink_${template_kind}.zip"
  echo "[ci] installed web_${template_kind}.zip and web_dlink_${template_kind}.zip from inner payload: $inner_template"
  return 0
}

copy_templates_from_archive_extract() {
  local extract_base="$1"
  local template_kind="$2"
  if install_inner_web_template_zip "$extract_base" "$template_kind"; then
    return 0
  fi

  local templates_source
  templates_source="$(find_templates_source "$extract_base" || true)"
  if [[ -z "$templates_source" ]]; then
    echo "Unable to locate export templates in extracted template archive." >&2
    find "$extract_base" -maxdepth 6 -type f | sed 's/^/[ci] file: /' | head -n 300
    exit 1
  fi
  cp -a "$templates_source"/. "$templates_target"/
}

if [[ -n "$template_debug_archive_url" ]]; then
  copy_templates_from_archive_extract "$templates_extract_dir/debug" "debug"
fi

if [[ -n "$template_release_archive_url" ]]; then
  copy_templates_from_archive_extract "$templates_extract_dir/release" "release"
fi

if [[ -z "$template_debug_archive_url" && -z "$template_release_archive_url" ]]; then
  echo "No template archives provided. Skipping export template installation." >&2
fi

echo "GODOT=$godot_bin" >> "$GITHUB_ENV"
echo "GODOT_VERSION=$godot_version" >> "$GITHUB_ENV"
echo "GODOT_EXPORT_TEMPLATES_DIR=$templates_target" >> "$GITHUB_ENV"
echo "[ci] installed Godot=$godot_bin version=$godot_version templates=$templates_target"
