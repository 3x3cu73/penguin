import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Assistant} from './lib/assistant.js';
import {PenguinDBus} from './lib/dbus.js';
import {PenguinIndicator} from './lib/indicator.js';
import {PenguinSearchProvider} from './lib/searchProvider.js';

const KEYBINDINGS = {
    'toggle-assistant': assistant => assistant.toggle(),
    'ask-screen': assistant => assistant.askAboutScreen(),
    'ask-selection': assistant => assistant.explainSelection(),
    'look-up': assistant => assistant.lookUp(),
    'new-chat': assistant => assistant.newChat(),
};

export default class PenguinExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._assistant = new Assistant(this, this._settings);
        this._dbus = new PenguinDBus(this._assistant);

        for (const [name, action] of Object.entries(KEYBINDINGS)) {
            Main.wm.addKeybinding(name, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => Promise.resolve(action(this._assistant)).catch(logError));
        }

        this._settings.connectObject(
            'changed::show-indicator', () => this._syncIndicator(),
            'changed::search-provider', () => this._syncSearchProvider(),
            this);
        this._syncIndicator();
        this._syncSearchProvider();
    }

    disable() {
        for (const name of Object.keys(KEYBINDINGS))
            Main.wm.removeKeybinding(name);
        this._settings.disconnectObject(this);

        this._indicator?.destroy();
        this._indicator = null;
        if (this._searchProvider)
            Main.overview.searchController.removeProvider(this._searchProvider);
        this._searchProvider = null;

        this._dbus.destroy();
        this._dbus = null;
        this._assistant.destroy();
        this._assistant = null;
        this._settings = null;
    }

    _syncIndicator() {
        const wanted = this._settings.get_boolean('show-indicator');
        if (wanted && !this._indicator) {
            this._indicator = new PenguinIndicator(this._assistant, this._settings);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!wanted && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _syncSearchProvider() {
        const wanted = this._settings.get_boolean('search-provider');
        if (wanted && !this._searchProvider) {
            const provider = new PenguinSearchProvider(this._assistant);
            // Needs the installed launcher for its name and icon.
            if (!provider.appInfo)
                return;
            this._searchProvider = provider;
            Main.overview.searchController.addProvider(provider);
        } else if (!wanted && this._searchProvider) {
            Main.overview.searchController.removeProvider(this._searchProvider);
            this._searchProvider = null;
        }
    }
}
