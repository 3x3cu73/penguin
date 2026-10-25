import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ChatClient, FREE_TIER_URL} from './lib/api.js';

const EFFORTS = [
    ['none', 'Off — fastest'],
    ['minimal', 'Minimal'],
    ['low', 'Low — recommended'],
    ['medium', 'Medium'],
    ['high', 'High — slowest'],
];

const SHORTCUTS = [
    ['toggle-assistant', 'Open or close Penguin'],
    ['ask-screen', 'Ask about the screen'],
    ['ask-selection', 'Explain selected or copied text'],
    ['look-up', 'Look up the selected word'],
    ['new-chat', 'Start a new chat'],
];

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_ISO_Level3_Shift,
]);

export default class PenguinPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(660, 780);
        window.search_enabled = true;

        window.add(this._generalPage(settings));
        window.add(this._shortcutsPage(window, settings));
        window.add(this._appearancePage(settings));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const model = new Adw.PreferencesGroup({
            title: 'Model',
            description: 'Penguin’s free tier works without setup and has a daily allowance. For more, use any ' +
                'OpenAI-compatible API with your own key. Questions about the screen need a model that accepts images.',
        });
        page.add(model);

        const freeTier = new Adw.ActionRow({
            title: 'Free tier',
            subtitle: 'Gemma 4 through penguin.zenbleed.tech. Switching back resets the URL, key and model below.',
        });
        const useFreeTier = new Gtk.Button({valign: Gtk.Align.CENTER});
        // Resetting the key too keeps a key for another provider from being sent to the free tier.
        useFreeTier.connect('clicked', () => ['api-base-url', 'api-key', 'model'].forEach(k => settings.reset(k)));
        const syncFreeTier = () => {
            const inUse = settings.get_string('api-base-url').trim().replace(/\/+$/, '') === FREE_TIER_URL;
            useFreeTier.label = inUse ? 'In use' : 'Use';
            useFreeTier.sensitive = !inUse;
        };
        syncFreeTier();
        settings.connect('changed::api-base-url', syncFreeTier);
        freeTier.add_suffix(useFreeTier);
        model.add(freeTier);

        const url = new Adw.EntryRow({title: 'API URL'});
        settings.bind('api-base-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
        model.add(url);

        const key = new Adw.PasswordEntryRow({title: 'API key'});
        settings.bind('api-key', key, 'text', Gio.SettingsBindFlags.DEFAULT);
        model.add(key);

        const name = new Adw.EntryRow({title: 'Model'});
        settings.bind('model', name, 'text', Gio.SettingsBindFlags.DEFAULT);
        model.add(name);

        const effort = new Adw.ComboRow({
            title: 'Thinking',
            subtitle: 'More thinking helps with hard questions but answers slower',
            model: Gtk.StringList.new(EFFORTS.map(([, label]) => label)),
        });
        const syncEffort = () => {
            effort.selected = Math.max(0, EFFORTS.findIndex(([id]) => id === settings.get_string('reasoning-effort')));
        };
        syncEffort();
        effort.connect('notify::selected', () => settings.set_string('reasoning-effort', EFFORTS[effort.selected][0]));
        settings.connect('changed::reasoning-effort', syncEffort);
        model.add(effort);

        const test = new Adw.ActionRow({title: 'Test connection', subtitle: 'Sends a tiny request with these settings'});
        const testButton = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        testButton.connect('clicked', () => this._testConnection(settings, test, testButton));
        test.add_suffix(testButton);
        test.activatable_widget = testButton;
        model.add(test);

        const network = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Turn this on if connecting fails with a TLS or certificate error behind ' +
                'an intercepting proxy (like Burp) or a captive/campus network.',
        });
        page.add(network);
        const insecure = new Adw.SwitchRow({
            title: 'Allow insecure TLS certificates',
            subtitle: 'Accepts certificates that don’t validate. Leave off unless you need it.',
        });
        settings.bind('allow-insecure-tls', insecure, 'active', Gio.SettingsBindFlags.DEFAULT);
        network.add(insecure);

        const answers = new Adw.PreferencesGroup({title: 'Answers'});
        page.add(answers);

        const instructions = new Adw.EntryRow({title: 'Custom instructions (e.g. “Reply in Hinglish”)'});
        settings.bind('custom-instructions', instructions, 'text', Gio.SettingsBindFlags.DEFAULT);
        answers.add(instructions);

        const translate = new Adw.EntryRow({title: 'Translate English text into'});
        settings.bind('translate-language', translate, 'text', Gio.SettingsBindFlags.DEFAULT);
        answers.add(translate);

        const privacy = new Adw.PreferencesGroup({title: 'Privacy'});
        page.add(privacy);
        privacy.add(new Adw.ActionRow({
            title: 'What leaves your computer',
            subtitle: 'Only when you ask something: your question, the selected or copied text, and any screenshot ' +
                'go to the API above. On the free tier that is penguin.zenbleed.tech, through Cloudflare, and Sarvam AI. ' +
                'The free-tier server keeps the time, your IP address and token counts for 31 days, never what you asked.',
            subtitle_selectable: true,
        }));

        return page;
    }

    async _testConnection(settings, row, button) {
        button.sensitive = false;
        row.subtitle = 'Connecting…';
        const client = new ChatClient(settings);
        const started = GLib.get_monotonic_time();
        try {
            const reply = await client.complete(
                [{role: 'user', content: 'Reply with exactly: OK'}],
                {reasoningEffort: 'none'});
            const seconds = ((GLib.get_monotonic_time() - started) / 1e6).toFixed(1);
            row.subtitle = `Connected — ${settings.get_string('model')} replied “${reply.trim().slice(0, 40)}” in ${seconds} s`;
        } catch (e) {
            row.subtitle = `Failed: ${e.message}`;
        } finally {
            client.destroy();
            button.sensitive = true;
        }
    }

    _shortcutsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Shortcuts',
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Click a shortcut to change it.',
        });
        page.add(group);

        for (const [key, title] of SHORTCUTS) {
            const row = new Adw.ActionRow({title, activatable: true});
            const label = new Gtk.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
            const sync = () => {
                label.accelerator = settings.get_strv(key)[0] ?? '';
            };
            sync();
            settings.connect(`changed::${key}`, sync);
            row.add_suffix(label);
            row.connect('activated', () => this._editShortcut(window, settings, key, title));
            group.add(row);
        }

        const tips = new Adw.PreferencesGroup({title: 'Tips'});
        page.add(tips);
        for (const [title, subtitle] of [
            ['Explain part of the screen',
                'Press Print, select a region (GNOME copies it), then press the “explain” shortcut.'],
            ['Rewrite text in place',
                'Select text in any app, press the “explain” shortcut, pick Fix writing or Rewrite, then Replace selection.'],
            ['Inside Penguin',
                'Enter sends · Esc closes · Ctrl+N new chat · ↑ recalls the last question · Ctrl+Shift+C copies the last answer'],
            ['From the overview', 'Type a question in Activities search and pick “Ask Penguin”.'],
        ]) {
            tips.add(new Adw.ActionRow({title, subtitle, subtitle_selectable: true}));
        }
        return page;
    }

    _editShortcut(window, settings, key, title) {
        const dialog = new Adw.AlertDialog({
            heading: 'Set Shortcut',
            body: `Press a new shortcut for “${title}”.\nBackspace disables it.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset to Default');
        dialog.set_close_response('cancel');

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            if (MODIFIER_KEYS.has(keyval))
                return Gdk.EVENT_STOP;
            if (!mods && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
            if (!mods && !isFunctionKey)
                return Gdk.EVENT_STOP;
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        // Let Super combos reach the dialog instead of triggering shell shortcuts.
        const surface = window.get_surface();
        surface?.inhibit_system_shortcuts?.(null);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'reset')
                settings.reset(key);
        });
        dialog.connect('closed', () => surface?.restore_system_shortcuts?.());
        dialog.present(window);
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Banner'});
        page.add(look);
        const opacity = new Adw.SpinRow({
            title: 'Opacity',
            subtitle: 'Lower values let more of the screen show through',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 2, page_increment: 10}),
        });
        settings.bind('panel-opacity', opacity, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(opacity);

        const integration = new Adw.PreferencesGroup({title: 'System Integration'});
        page.add(integration);

        const indicator = new Adw.SwitchRow({title: 'Show in top bar'});
        settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        integration.add(indicator);

        const search = new Adw.SwitchRow({
            title: 'Ask from Activities search',
            subtitle: 'Questions typed in the overview get an “Ask Penguin” result',
        });
        settings.bind('search-provider', search, 'active', Gio.SettingsBindFlags.DEFAULT);
        integration.add(search);

        return page;
    }
}
