import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {accelLabel} from './widgets.js';

export const PenguinIndicator = GObject.registerClass(
class PenguinIndicator extends PanelMenu.Button {
    constructor(assistant, settings) {
        super(0.5, 'Penguin');
        this._settings = settings;
        this._accels = [];
        this._idleId = 0;

        this.add_child(new St.Icon({gicon: assistant.gicon, style_class: 'system-status-icon'}));

        this._addItem('Ask Penguin', 'toggle-assistant', () => assistant.open());
        this._addItem('Ask About Screen', 'ask-screen', () => assistant.askAboutScreen().catch(logError));
        this._addItem('Explain Selection', 'ask-selection', () => assistant.explainSelection().catch(logError));
        this._addItem('Look Up Selection', 'look-up', () => assistant.lookUp().catch(logError));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addItem('New Chat', 'new-chat', () => assistant.newChat());
        this._addItem('Preferences', null, () => assistant.openPreferences());

        settings.connectObject('changed', () => this._syncAccels(), this);
        this._syncAccels();
    }

    _addItem(label, key, action) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            // Close instantly so the menu never ends up in a screenshot.
            this.menu.close(PopupAnimation.NONE);
            if (this._idleId)
                GLib.source_remove(this._idleId);
            this._idleId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
                this._idleId = 0;
                action();
            });
        });
        if (key) {
            const accel = new St.Label({
                style_class: 'penguin-menu-accel',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(accel);
            this._accels.push({key, label: accel});
        }
        this.menu.addMenuItem(item);
    }

    _syncAccels() {
        for (const {key, label} of this._accels)
            label.text = accelLabel(this._settings.get_strv(key)[0]);
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._settings.disconnectObject(this);
        super.destroy();
    }
});
