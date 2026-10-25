import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const TERMINAL = /terminal|ptyxis|kgx|konsole|kitty|alacritty|foot|wezterm|tilix|terminator|xterm|ghostty|blackbox/i;

// Time for the shell to hand keyboard focus back to the app after closing.
const FOCUS_RETURN_DELAY_MS = 180;

export class Paster {
    constructor() {
        const seat = global.stage.context.get_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._timeoutId = 0;
    }

    /**
     * Copies text and pastes it into whichever window regains focus, replacing
     * its selection. Call right after closing Penguin's UI.
     *
     * @param {string} text
     */
    paste(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_RETURN_DELAY_MS, () => {
            this._timeoutId = 0;
            this._sendPasteShortcut();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteShortcut() {
        const window = global.display.focus_window;
        const ids = `${window?.get_wm_class() ?? ''} ${window?.get_gtk_application_id() ?? ''}`;
        const keys = TERMINAL.test(ids)
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];

        let time = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_keyval(time++, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._keyboard.notify_keyval(time++, key, Clutter.KeyState.RELEASED);
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._keyboard = null;
    }
}
