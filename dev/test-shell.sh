#!/usr/bin/env bash
# Throwaway headless GNOME Shell for developing Penguin without logging out.
# It runs on a private D-Bus, private dconf and private XDG dirs, so it never
# touches the real session.
#
#   dev/test-shell.sh start [WxH]   install the extension into a fresh headless shell
#   dev/test-shell.sh eval 'JS'     evaluate JS inside the test shell (await allowed)
#   dev/test-shell.sh shot FILE     save a PNG screenshot of the test shell
#   dev/test-shell.sh key 'ACCEL'   press an accelerator, e.g. '<Super>i'
#   dev/test-shell.sh type 'text'   type text through a virtual keyboard
#   dev/test-shell.sh app CMD…      run an app inside the test shell
#   dev/test-shell.sh log [N]       show extension-related log lines
#   dev/test-shell.sh stop
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE=/tmp/penguin-test-shell
UUID=penguin@sumit.github.io

use_env() {
    export XDG_CONFIG_HOME=$STATE/config XDG_DATA_HOME=$STATE/data
    export XDG_CACHE_HOME=$STATE/cache XDG_STATE_HOME=$STATE/state
    export XDG_RUNTIME_DIR=$STATE/runtime
    if [[ -f $STATE/bus ]]; then
        DBUS_SESSION_BUS_ADDRESS="$(cat "$STATE/bus")"
        export DBUS_SESSION_BUS_ADDRESS
    fi
    unset WAYLAND_DISPLAY DISPLAY
}

shell_eval() {
    local code
    code="$(python3 -c 'import sys; from gi.repository import GLib; print(GLib.Variant("s", sys.argv[1]).print_(False))' "$1")"
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$code"
}

stop_shell() {
    for f in shell.pid bus.pid; do
        if [[ -f $STATE/$f ]]; then
            kill "$(cat "$STATE/$f")" 2>/dev/null || true
            rm -f "$STATE/$f"
        fi
    done
    # Services the private bus activated (portals, dconf) share our runtime dir.
    for p in /proc/[0-9]*; do
        if grep -qz "^XDG_RUNTIME_DIR=$STATE/runtime\$" "$p/environ" 2>/dev/null; then
            kill "${p#/proc/}" 2>/dev/null || true
        fi
    done
    if [[ -d $STATE/runtime/doc ]]; then
        fusermount3 -u "$STATE/runtime/doc" 2>/dev/null || fusermount -u "$STATE/runtime/doc" 2>/dev/null || true
    fi
    sleep 0.3
}

case "${1:-}" in
start)
    stop_shell
    rm -rf "$STATE"
    mkdir -p "$STATE"/{config,data,cache,state,runtime}
    chmod 700 "$STATE/runtime"
    real_key="$(dconf read /org/gnome/shell/extensions/penguin/api-key 2>/dev/null || true)"
    real_dictionary="${XDG_DATA_HOME:-$HOME/.local/share}/penguin/dictionary"
    use_env

    dbus-daemon --session --fork --print-address=1 --print-pid=1 > "$STATE/bus.out"
    sed -n 1p "$STATE/bus.out" > "$STATE/bus"
    sed -n 2p "$STATE/bus.out" > "$STATE/bus.pid"
    use_env

    ext_dir="$XDG_DATA_HOME/gnome-shell/extensions"
    mkdir -p "$ext_dir"
    "$ROOT/install.sh" --build-only "$ext_dir/$UUID" > /dev/null
    cp -r "$ROOT/dev/helper@penguin.test" "$ext_dir/"
    if [[ -d $real_dictionary ]]; then
        mkdir -p "$XDG_DATA_HOME/penguin"
        ln -s "$real_dictionary" "$XDG_DATA_HOME/penguin/dictionary"
    fi
    mkdir -p "$XDG_DATA_HOME/applications" "$XDG_DATA_HOME/icons/hicolor/scalable/apps"
    sed "s|@BIN@|$ROOT/bin|g" "$ROOT/data/io.github.sumit.Penguin.desktop" \
        > "$XDG_DATA_HOME/applications/io.github.sumit.Penguin.desktop"
    cp "$ROOT/data/icons/io.github.sumit.Penguin.svg" "$XDG_DATA_HOME/icons/hicolor/scalable/apps/"

    gsettings set org.gnome.shell enabled-extensions "['helper@penguin.test', '$UUID']"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
    # A new virtual pointer starts in the top-left corner and would open the overview.
    gsettings set org.gnome.desktop.interface enable-hot-corners false
    gsettings set org.gnome.desktop.interface color-scheme "${PENGUIN_TEST_SCHEME:-prefer-dark}"
    key="${PENGUIN_TEST_KEY:-$real_key}"
    if [[ -n "$key" ]]; then
        [[ "$key" == \'* ]] || key="'$key'"
        dconf write /org/gnome/shell/extensions/penguin/api-key "$key"
    fi

    nohup gnome-shell --headless --wayland --no-x11 --wayland-display penguin-test-0 \
        --virtual-monitor "${2:-1600x1000}" > "$STATE/shell.log" 2>&1 &
    echo $! > "$STATE/shell.pid"

    for _ in $(seq 1 60); do
        if shell_eval 'true' 2>/dev/null | grep -q "(true,"; then
            sleep 1.5
            shell_eval '
                for (const source of Main.messageTray.getSources())
                    [...source.notifications].forEach(n => n.destroy());
                Main.overview.hide();
                "ok"' > /dev/null
            sleep 0.8
            echo "test shell ready"
            exit 0
        fi
        sleep 0.5
    done
    echo "test shell failed to start; log:" >&2
    tail -50 "$STATE/shell.log" >&2
    exit 1
    ;;
eval)
    use_env
    shell_eval "$2"
    ;;
shot)
    use_env
    out="$(realpath -m "$2")"
    gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$out" > /dev/null
    echo "$out"
    ;;
key)
    use_env
    shell_eval "
        const Clutter = imports.gi.Clutter;
        const seat = global.stage.context.get_backend().get_default_seat();
        globalThis._penguinTestKbd ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const modMap = {'<Super>': Clutter.KEY_Super_L, '<Shift>': Clutter.KEY_Shift_L,
            '<Control>': Clutter.KEY_Control_L, '<Ctrl>': Clutter.KEY_Control_L, '<Alt>': Clutter.KEY_Alt_L};
        const held = [];
        let rest = '$2';
        for (;;) {
            const m = rest.match(/^<[A-Za-z]+>/);
            if (!m) break;
            held.push(modMap[m[0]]);
            rest = rest.slice(m[0].length);
        }
        const keyval = Clutter['KEY_' + rest] ?? Clutter.unicode_to_keysym(rest.codePointAt(0));
        const kbd = globalThis._penguinTestKbd;
        let t = imports.gi.GLib.get_monotonic_time();
        for (const k of held) kbd.notify_keyval(t++, k, Clutter.KeyState.PRESSED);
        kbd.notify_keyval(t++, keyval, Clutter.KeyState.PRESSED);
        kbd.notify_keyval(t++, keyval, Clutter.KeyState.RELEASED);
        for (const k of held.reverse()) kbd.notify_keyval(t++, k, Clutter.KeyState.RELEASED);
        'ok';
    "
    ;;
type)
    use_env
    text_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$2")"
    shell_eval "
        const Clutter = imports.gi.Clutter;
        const seat = global.stage.context.get_backend().get_default_seat();
        globalThis._penguinTestKbd ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const kbd = globalThis._penguinTestKbd;
        let t = imports.gi.GLib.get_monotonic_time();
        for (const ch of $text_json) {
            const keyval = ch === '\n' ? Clutter.KEY_Return : Clutter.unicode_to_keysym(ch.codePointAt(0));
            kbd.notify_keyval(t++, keyval, Clutter.KeyState.PRESSED);
            kbd.notify_keyval(t++, keyval, Clutter.KeyState.RELEASED);
        }
        'ok';
    "
    ;;
app)
    use_env
    shift
    WAYLAND_DISPLAY=penguin-test-0 GDK_BACKEND=wayland nohup "$@" >> "$STATE/apps.log" 2>&1 &
    echo "started $1"
    ;;
log)
    grep -v -E "^\s*$" "$STATE/shell.log" | grep -i -E "penguin|error|warn|exception|stack|\.js:" | tail -"${2:-60}" || true
    ;;
stop)
    stop_shell
    echo "stopped"
    ;;
*)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
