#!/usr/bin/env bash
# Installs Penguin for the current user (no root needed).
#
#   ./install.sh                     install / update; Penguin starts on its free tier
#   PENGUIN_API_KEY=sk-... ./install.sh
#                                    install and use a custom provider (OpenAI unless
#                                    PENGUIN_API_URL and PENGUIN_MODEL say otherwise)
#   ./install.sh --build-only DIR    only assemble the extension into DIR (used by dev/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID=penguin@sumit.github.io
SCHEMA=org.gnome.shell.extensions.penguin
APP_ID=io.github.sumit.Penguin
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN="$HOME/.local/bin"

build() {
    local dest="$1"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$ROOT/extension/." "$dest/"
    glib-compile-schemas --strict "$dest/schemas"
}

if [[ "${1:-}" == "--build-only" ]]; then
    build "$2"
    exit 0
fi

echo "Installing Penguin…"

build "$DATA/gnome-shell/extensions/$UUID"

# A copy of the schema in the user schema dir lets `gsettings` and other
# processes read Penguin's settings.
mkdir -p "$DATA/glib-2.0/schemas"
cp "$ROOT/extension/schemas/$SCHEMA.gschema.xml" "$DATA/glib-2.0/schemas/"
glib-compile-schemas "$DATA/glib-2.0/schemas"

install -Dm755 "$ROOT/bin/penguin" "$BIN/penguin"
install -Dm644 "$ROOT/data/icons/$APP_ID.svg" "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg"
install -Dm644 "$ROOT/data/icons/$APP_ID-symbolic.svg" "$DATA/icons/hicolor/symbolic/apps/$APP_ID-symbolic.svg"
if [[ -f "$DATA/icons/hicolor/icon-theme.cache" ]] && command -v gtk-update-icon-cache > /dev/null; then
    gtk-update-icon-cache -q -f -t "$DATA/icons/hicolor" || true
fi
mkdir -p "$DATA/applications"
sed "s|@BIN@|$BIN|g" "$ROOT/data/$APP_ID.desktop" > "$DATA/applications/$APP_ID.desktop"
update-desktop-database -q "$DATA/applications" 2> /dev/null || true

# Look Up's offline dictionary is downloaded once and kept across updates.
if [[ ! -f "$DATA/penguin/dictionary/info.json" ]]; then
    python3 "$ROOT/install-dictionary.py" || echo "Skipped the offline dictionary; run ./install-dictionary.py to try again." >&2
fi

if [[ -n "${PENGUIN_API_KEY:-}${PENGUIN_API_URL:-}" ]]; then
    python3 - "$SCHEMA" <<'EOF'
import os, sys
from gi.repository import Gio
settings = Gio.Settings.new(sys.argv[1])
settings.set_boolean("use-free-tier", False)
for name, variable in (("api-base-url", "PENGUIN_API_URL"), ("model", "PENGUIN_MODEL"), ("api-key", "PENGUIN_API_KEY")):
    if os.environ.get(variable):
        settings.set_string(name, os.environ[variable])
Gio.Settings.sync()
EOF
fi

# Enable for the next login. The running shell ignores UUIDs it hasn't loaded yet.
python3 - "$UUID" <<'EOF'
import sys
from gi.repository import Gio
uuid = sys.argv[1]
shell = Gio.Settings.new('org.gnome.shell')
enabled = shell.get_strv('enabled-extensions')
if uuid not in enabled:
    shell.set_strv('enabled-extensions', enabled + [uuid])
shell.set_strv('disabled-extensions', [u for u in shell.get_strv('disabled-extensions') if u != uuid])
Gio.Settings.sync()
EOF

system_schema="/usr/local/share/glib-2.0/schemas/$SCHEMA.gschema.xml"
if [[ -f "$system_schema" ]] && ! cmp -s "$system_schema" "$ROOT/extension/schemas/$SCHEMA.gschema.xml"; then
    echo "Settings changed; run ./system-integration.sh to refresh the copy GNOME Settings uses."
fi

if gnome-extensions info "$UUID" > /dev/null 2>&1; then
    echo "Updated. Log out and back in to load the new version."
else
    echo "Installed. Log out and back in once to start Penguin."
fi
