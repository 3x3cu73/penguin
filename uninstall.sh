#!/usr/bin/env bash
# Removes Penguin for the current user.
#
#   ./uninstall.sh           keep settings (API key, shortcuts)
#   ./uninstall.sh --purge   also erase settings
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID=penguin@sumit.github.io
SCHEMA=org.gnome.shell.extensions.penguin
APP_ID=io.github.sumit.Penguin
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"

if [[ -f /usr/local/share/gnome-control-center/keybindings/50-penguin.xml ]]; then
    "$ROOT/system-integration.sh" --remove
fi

gnome-extensions disable "$UUID" 2> /dev/null || true
python3 - "$UUID" <<'EOF'
import sys
from gi.repository import Gio
uuid = sys.argv[1]
shell = Gio.Settings.new('org.gnome.shell')
shell.set_strv('enabled-extensions', [u for u in shell.get_strv('enabled-extensions') if u != uuid])
Gio.Settings.sync()
EOF

if [[ "${1:-}" == "--purge" ]]; then
    dconf reset -f /org/gnome/shell/extensions/penguin/
fi

rm -rf "$DATA/gnome-shell/extensions/$UUID" "$DATA/penguin/dictionary"
rmdir "$DATA/penguin" 2> /dev/null || true
rm -f "$DATA/glib-2.0/schemas/$SCHEMA.gschema.xml"
glib-compile-schemas "$DATA/glib-2.0/schemas" 2> /dev/null || true
rm -f "$HOME/.local/bin/penguin" "$DATA/applications/$APP_ID.desktop"
rm -f "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg" "$DATA/icons/hicolor/symbolic/apps/$APP_ID-symbolic.svg"
if [[ -f "$DATA/icons/hicolor/icon-theme.cache" ]] && command -v gtk-update-icon-cache > /dev/null; then
    gtk-update-icon-cache -q -f -t "$DATA/icons/hicolor" || true
fi

echo "Penguin removed. It disappears from the shell after you log out."
