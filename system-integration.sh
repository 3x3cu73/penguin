#!/usr/bin/env bash
# Lists Penguin's shortcuts in Settings → Keyboard → View and Customize Shortcuts.
# Needs root, so it re-runs itself through pkexec, which shows GNOME's password dialog.
#
#   ./system-integration.sh            install or refresh
#   ./system-integration.sh --remove   undo
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PREFIX=/usr/local/share
SCHEMA=org.gnome.shell.extensions.penguin
SCHEMAS="$PREFIX/glib-2.0/schemas"
KEYBINDINGS="$PREFIX/gnome-control-center/keybindings/50-penguin.xml"

if [[ $EUID -ne 0 ]]; then
    exec pkexec "$ROOT/system-integration.sh" "$@"
fi

if [[ "${1:-}" == "--remove" ]]; then
    rm -f "$KEYBINDINGS" "$SCHEMAS/$SCHEMA.gschema.xml"
    if compgen -G "$SCHEMAS/*.gschema.xml" > /dev/null; then
        glib-compile-schemas "$SCHEMAS"
    else
        rm -f "$SCHEMAS/gschemas.compiled"
    fi
    echo "Removed Penguin from Settings."
    exit 0
fi

# Settings needs the schema to show the shortcuts, so both are always installed together.
install -Dm644 "$ROOT/extension/schemas/$SCHEMA.gschema.xml" "$SCHEMAS/$SCHEMA.gschema.xml"
glib-compile-schemas --strict "$SCHEMAS"
install -Dm644 "$ROOT/data/50-penguin.xml" "$KEYBINDINGS"
echo "Penguin's shortcuts are now in Settings → Keyboard → View and Customize Shortcuts."
