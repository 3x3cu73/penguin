import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import * as Markdown from './markdown.js';
import {IMAGE_ACTIONS, textActions} from './prompts.js';
import {
    AnswerView, accelLabel, copyText, iconButton, pillButton, thumbnailActor, trackColorScheme,
    wrappingLabel
} from './widgets.js';

const WIDTH = 680;
const TOP_MARGIN = 14;
const MAX_HEIGHT_FRACTION = 0.62;
const RENDER_INTERVAL_MS = 40;
const SNIPPET_LENGTH = 90;

function snippet(text, length = SNIPPET_LENGTH) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

class TurnView {
    constructor(turn, assistant) {
        this.turn = turn;
        this.actor = new St.BoxLayout({
            style_class: 'penguin-turn',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const question = new St.BoxLayout({style_class: 'penguin-question', x_expand: true});
        for (const image of turn.images) {
            if (image.thumbnail)
                question.add_child(thumbnailActor(image.thumbnail, 'penguin-question-thumb', 40));
        }
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (turn.context)
            text.add_child(wrappingLabel('penguin-question-context', `“${snippet(turn.context, 160)}”`));
        text.add_child(wrappingLabel('penguin-question-text', turn.label));
        question.add_child(text);
        this.actor.add_child(question);

        this.answer = new AnswerView();
        this.actor.add_child(this.answer.actor);

        this._footer = new St.BoxLayout({style_class: 'penguin-answer-actions', visible: false});
        this._flashId = 0;
        this._copyButton = pillButton('Copy', 'edit-copy-symbolic', () => {
            copyText(Markdown.toPlainText(turn.answer));
            this._flash(this._copyButton, 'Copied');
        }, 'penguin-pill penguin-small');
        this._replaceButton = pillButton('Replace selection', 'edit-paste-symbolic',
            () => assistant.replaceSelection(turn), 'penguin-pill penguin-small');
        this._retryButton = pillButton('Retry', 'view-refresh-symbolic',
            () => assistant.retry(turn), 'penguin-pill penguin-small');
        this._footer.add_child(this._copyButton);
        this._footer.add_child(this._replaceButton);
        this._footer.add_child(this._retryButton);
        this.actor.add_child(this._footer);

        this.update();
    }

    update() {
        const {answer, error, done, replaceable} = this.turn;
        this.answer.setThinking(!done && !answer);
        if (answer)
            this.answer.setText(answer);
        this.answer.setError(error);

        const answered = done && answer.length > 0 && !error;
        this._copyButton.visible = answered;
        this._replaceButton.visible = answered && replaceable;
        this._retryButton.visible = done && !!error;
        this._footer.visible = this._copyButton.visible || this._retryButton.visible;
    }

    _flash(button, text) {
        const label = button.child.get_last_child();
        label.original ??= label.text;
        label.text = text;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            this._flashId = 0;
            label.text = label.original;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
        this._footer.destroy();
        this._footer = null;
        this.actor.destroy();
        this.actor = null;
    }
}

export const PenguinPanel = GObject.registerClass(
class PenguinPanel extends St.BoxLayout {
    constructor(assistant, settings, gicon) {
        super({
            style_class: 'penguin-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
        });
        this._assistant = assistant;
        this._settings = settings;
        this._grab = null;
        this._capturedId = 0;
        this._renderId = 0;
        this._dirty = new Set();
        this._views = new Map();
        this._images = [];
        this._text = null;
        this._history = [];
        this._historyIndex = -1;

        this._buildComposer(gicon);
        this._buildConversation();

        Main.layoutManager.addTopChrome(this);
        global.focus_manager.add_group(this);
        trackColorScheme(this, () => this._syncOpacity());
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this.visible)
                this._place();
        }, this);
        this._settings.connectObject(
            'changed', () => this._syncHint(),
            'changed::panel-opacity', () => this._syncOpacity(),
            this);
        // Fullscreen apps that bypass the compositor would otherwise hide the banner.
        this._unredirectDisabled = false;
        this.connect('notify::visible', () => this._syncUnredirect());
        this.connect('destroy', this._onDestroy.bind(this));
        this._syncComposer();
    }

    _buildComposer(gicon) {
        const row = new St.BoxLayout({style_class: 'penguin-entry-row', x_expand: true});
        row.add_child(new St.Icon({
            gicon,
            style_class: 'penguin-logo',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._entry = new St.Entry({
            style_class: 'penguin-entry',
            hint_text: 'Ask Penguin…',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.clutter_text.connect('activate', () => this._submit());
        this._entry.clutter_text.connect('button-press-event', () => {
            if (!this._grab)
                this.focus();
            return Clutter.EVENT_PROPAGATE;
        });
        row.add_child(this._entry);

        // Two dots page through older/newer messages; a dot dims when there's
        // nothing that way. Shown only when there's more than one message.
        this._nav = new St.BoxLayout({style_class: 'penguin-nav', visible: false});
        this._prevButton = this._navDot('Older message', () => this._navigate(-1));
        this._nextButton = this._navDot('Newer message', () => this._navigate(1));
        this._nav.add_child(this._prevButton);
        this._nav.add_child(this._nextButton);
        row.add_child(this._nav);

        this._stopButton = iconButton('media-playback-stop-symbolic', 'Stop', () => this._assistant.stop());
        this._stopButton.hide();
        row.add_child(this._stopButton);
        row.add_child(iconButton('camera-photo-symbolic', 'Attach a screenshot',
            () => this._assistant.askAboutScreen()));
        row.add_child(iconButton('chat-message-new-symbolic', 'New chat',
            () => this._assistant.newChat()));
        row.add_child(iconButton('emblem-system-symbolic', 'Preferences',
            () => this._assistant.openPreferences()));
        row.add_child(iconButton('window-close-symbolic', 'Close', () => this.close()));
        this.add_child(row);

        this._attachmentRow = new St.BoxLayout({style_class: 'penguin-attachments', visible: false});
        this.add_child(this._attachmentRow);
        this._actionRow = new St.BoxLayout({style_class: 'penguin-actions', visible: false});
        this.add_child(this._actionRow);

        this._notice = wrappingLabel('penguin-notice');
        this._notice.hide();
        this.add_child(this._notice);
        this._hint = wrappingLabel('penguin-hint');
        this.add_child(this._hint);
        this._syncHint();
    }

    _buildConversation() {
        // One message is shown at a time; the header arrows page through the history.
        this._index = -1;
        this._list = new St.BoxLayout({
            style_class: 'penguin-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'penguin-scroll',
            child: this._list,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            visible: false,
        });
        this.add_child(this._scroll);

        const adjustment = this._scroll.vadjustment;
        this._stickToBottom = true;
        const followBottom = () => {
            if (this._stickToBottom)
                adjustment.value = adjustment.upper - adjustment.page_size;
        };
        adjustment.connect('notify::value', () => {
            this._stickToBottom = adjustment.value >= adjustment.upper - adjustment.page_size - 4;
        });
        adjustment.connect('notify::upper', followBottom);
        adjustment.connect('notify::page-size', followBottom);
    }

    // Visibility and focus

    open({focus = true} = {}) {
        if (!this.visible || this._closing) {
            if (this._views.size > 0)
                this._showTurn(this._views.size - 1);
            this._place();
            this._animateIn();
        }
        if (focus)
            this.focus();
    }

    toggle() {
        if (this.visible && !this._closing)
            this.close();
        else
            this.open();
    }

    focus() {
        if (!this._grab) {
            this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
            this._capturedId = this.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
            this.remove_style_pseudo_class('inactive');
        }
        this._entry.grab_key_focus();
    }

    unfocus() {
        if (!this._grab)
            return;
        this.disconnect(this._capturedId);
        this._capturedId = 0;
        Main.popModal(this._grab);
        this._grab = null;
        this.add_style_pseudo_class('inactive');
    }

    close() {
        this.unfocus();
        if (!this.visible || this._closing)
            return;
        this._closing = true;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.ease({
            opacity: 0,
            translation_y: -8 * scale,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._closing = false;
                this.hide();
            },
        });
    }

    /** Hides immediately so the panel isn't in a screenshot. */
    hideNow() {
        this.unfocus();
        this.remove_all_transitions();
        this._closing = false;
        this.hide();
    }

    _animateIn() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.remove_all_transitions();
        this._closing = false;
        this.opacity = 0;
        this.translation_y = -12 * scale;
        this.show();
        this.ease({
            opacity: 255,
            translation_y: 0,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _place() {
        const index = global.display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        const width = Math.min(WIDTH * scale, monitor.width - 32 * scale);
        this.set_width(width);
        const maxHeight = Math.floor(workArea.height * MAX_HEIGHT_FRACTION / scale);
        this._scroll.style = `max-height: ${maxHeight}px;`;
        this.set_position(
            monitor.x + Math.floor((monitor.width - width) / 2),
            workArea.y + TOP_MARGIN * scale);
    }

    _onCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this.contains(global.stage.get_event_actor(event))) {
                this.unfocus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const key = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const alt = (event.get_state() & Clutter.ModifierType.MOD1_MASK) !== 0;
        const entryFocused = global.stage.key_focus === this._entry.clutter_text;

        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        // Alt+arrows always page; plain arrows page only when the entry is empty,
        // so they still move the cursor while you're typing.
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Right) {
            if (alt || (entryFocused && this._entry.get_text() === '')) {
                this._navigate(key === Clutter.KEY_Left ? -1 : 1);
                return Clutter.EVENT_STOP;
            }
        }
        if (ctrl && (key === Clutter.KEY_n || key === Clutter.KEY_N)) {
            this._assistant.newChat();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && shift && (key === Clutter.KEY_c || key === Clutter.KEY_C)) {
            this._copyLastAnswer();
            return Clutter.EVENT_STOP;
        }
        if (entryFocused && (key === Clutter.KEY_Up || key === Clutter.KEY_Down) && this._recall(key === Clutter.KEY_Up ? 1 : -1))
            return Clutter.EVENT_STOP;
        if (key === Clutter.KEY_Page_Up || key === Clutter.KEY_Page_Down) {
            const adjustment = this._scroll.vadjustment;
            adjustment.value += (key === Clutter.KEY_Page_Up ? -0.8 : 0.8) * adjustment.page_size;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _recall(direction) {
        const text = this._entry.get_text();
        if (this._historyIndex === -1 && text !== '')
            return false;
        const next = this._historyIndex + direction;
        if (next < -1 || next >= this._history.length)
            return true;
        this._historyIndex = next;
        this._entry.set_text(next === -1 ? '' : this._history[this._history.length - 1 - next]);
        this._entry.clutter_text.set_cursor_position(-1);
        return true;
    }

    _copyLastAnswer() {
        const last = [...this._views.keys()].at(-1);
        if (last?.answer)
            copyText(Markdown.toPlainText(last.answer));
    }

    // Composer

    _submit(action = null) {
        const text = this._entry.get_text().trim();
        if (this._assistant.busy)
            return;
        if (!text && !action && this._images.length === 0 && !this._text)
            return;
        if (text) {
            this._history.push(text);
            this._historyIndex = -1;
        }
        this._entry.set_text('');
        this._assistant.submit(text, action);
    }

    /** Hands the attachments to a new turn and clears them from the composer. */
    takeAttachments() {
        const attachments = {
            images: this._images.map(i => i.promise),
            screenshot: this.hasScreenshot,
            text: this._text ? {text: this._text.text, raw: this._text.raw, source: this._text.source} : null,
        };
        this._clearAttachments();
        this._syncComposer();
        return attachments;
    }

    get hasAttachments() {
        return this._images.length > 0 || this._text !== null;
    }

    get hasScreenshot() {
        return this._images.some(i => i.screenshot);
    }

    attachImage(promise, {label = 'Screen', screenshot = true} = {}) {
        const item = {promise, screenshot, chip: null, alive: true};
        item.chip = this._createChip(label, null, () => this._removeImage(item));
        this._images.push(item);
        this._attachmentRow.insert_child_at_index(item.chip, this._images.length - 1);
        promise.then(image => {
            if (item.alive)
                item.chip.insert_child_at_index(thumbnailActor(image.thumbnail, 'penguin-chip-thumb', 40), 0);
        }).catch(e => {
            if (!item.alive)
                return;
            this._removeImage(item);
            this.showNotice(`Couldn’t read the image: ${e.message}`);
        });
        this._syncComposer();
    }

    attachText(text, source, raw = text) {
        this._text?.chip.destroy();
        const label = `${source === 'primary' ? 'Selected' : 'Copied'}: “${snippet(text, 60)}”`;
        const chip = this._createChip(label, 'text-x-generic-symbolic', () => {
            this._text?.chip.destroy();
            this._text = null;
            this._syncComposer();
        });
        this._text = {text, raw, source, chip};
        this._attachmentRow.add_child(chip);
        this._syncComposer();
    }

    _removeImage(item) {
        item.alive = false;
        item.chip.destroy();
        this._images = this._images.filter(i => i !== item);
        this._syncComposer();
    }

    _clearAttachments() {
        for (const item of this._images) {
            item.alive = false;
            item.chip.destroy();
        }
        this._images = [];
        this._text?.chip.destroy();
        this._text = null;
    }

    showNotice(text) {
        this._notice.text = text ?? '';
        this._notice.visible = !!text;
        this._syncHint();
    }

    _createChip(label, iconName, onRemove) {
        const chip = new St.BoxLayout({style_class: 'penguin-chip'});
        if (iconName) {
            chip.add_child(new St.Icon({
                icon_name: iconName,
                style_class: 'penguin-chip-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        const text = new St.Label({
            text: label,
            style_class: 'penguin-chip-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        chip.add_child(text);
        chip.add_child(iconButton('window-close-symbolic', 'Remove', onRemove,
            'penguin-icon-button penguin-chip-remove'));
        return chip;
    }

    _syncComposer() {
        if (this._destroyed)
            return;
        this._attachmentRow.visible = this.hasAttachments;

        this._actionRow.destroy_all_children();
        const actions = this._images.length > 0
            ? IMAGE_ACTIONS
            : this._text ? textActions(this._settings.get_string('translate-language')) : [];
        for (const action of actions) {
            this._actionRow.add_child(pillButton(action.label, action.icon,
                () => this._submit(action)));
        }
        this._actionRow.visible = actions.length > 0;

        if (this.hasScreenshot)
            this._entry.hint_text = 'Ask about your screen…  (Enter for a quick take)';
        else if (this._images.length > 0)
            this._entry.hint_text = 'Ask about the image…  (Enter for a quick take)';
        else if (this._text)
            this._entry.hint_text = 'Ask about the text…  (Enter to explain)';
        else
            this._entry.hint_text = 'Ask Penguin…';
        this._syncHint();
    }

    _syncHint() {
        if (!this._hint)
            return;
        const accel = key => accelLabel(this._settings.get_strv(key)[0]);
        this._hint.text = [
            `${accel('ask-screen')}  screen`,
            `${accel('ask-selection')}  explain selection`,
            `${accel('look-up')}  look up`,
            `${accel('new-chat')}  new chat`,
        ].join('     ');
        this._hint.visible = this._views.size === 0 && !this._attachmentRow.visible && !this._notice.visible;
    }

    setBusy(busy) {
        this._stopButton.visible = busy;
    }

    _syncOpacity() {
        const alpha = this._settings.get_int('panel-opacity') / 100;
        const base = this.has_style_class_name('penguin-light') ? '250, 250, 252' : '30, 30, 34';
        this.style = `background-color: rgba(${base}, ${alpha});`;
    }

    _syncUnredirect() {
        const wanted = this.visible && !this._destroyed;
        if (wanted === this._unredirectDisabled)
            return;
        this._unredirectDisabled = wanted;
        if (wanted)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    // Conversation

    renderTurns(turns) {
        this.reset();
        for (const turn of turns)
            this.addTurn(turn);
    }

    reset() {
        for (const view of this._views.values())
            view.destroy();
        this._views.clear();
        this._dirty.clear();
        this._index = -1;
        this._clearAttachments();
        this.showNotice(null);
        this._scroll.hide();
        this._nav.hide();
        this._syncComposer();
    }

    addTurn(turn) {
        const view = new TurnView(turn, this._assistant);
        this._views.set(turn, view);
        this._showTurn(this._views.size - 1, {stick: true});
        this.showNotice(null);
        this._syncHint();
    }

    /** Shows one message, swapping it into the single-message view. */
    _showTurn(index, {stick} = {}) {
        const turns = [...this._views.keys()];
        if (turns.length === 0) {
            this._index = -1;
            this._scroll.hide();
            this._nav.hide();
            return;
        }
        this._index = Math.max(0, Math.min(index, turns.length - 1));
        const turn = turns[this._index];
        const view = this._views.get(turn);
        const shown = this._list.get_first_child();
        if (shown !== view.actor) {
            if (shown)
                this._list.remove_child(shown);
            this._list.add_child(view.actor);
        }
        const isLatest = this._index === turns.length - 1;
        this._stickToBottom = stick ?? (isLatest && !turn.done);
        const adjustment = this._scroll.vadjustment;
        adjustment.value = this._stickToBottom ? adjustment.upper : 0;
        this._updateNav(turns.length);
        this._scroll.show();
    }

    _navigate(delta) {
        if (this._views.size > 0)
            this._showTurn(this._index + delta, {stick: false});
    }

    _navDot(accessibleName, onClicked) {
        const dot = new St.Button({
            style_class: 'penguin-nav-dot',
            accessible_name: accessibleName,
            can_focus: true,
            child: new St.Widget({
                style_class: 'penguin-nav-dot-fill',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            }),
        });
        dot.connect('clicked', () => onClicked());
        return dot;
    }

    _updateNav(total) {
        this._nav.visible = total > 1;
        for (const [dot, enabled] of [
            [this._prevButton, this._index > 0],
            [this._nextButton, this._index < total - 1],
        ]) {
            dot.reactive = enabled;
            dot.opacity = enabled ? 255 : 55;
        }
    }

    /** Re-renders a turn, coalescing streaming updates. */
    updateTurn(turn, {immediate = false} = {}) {
        this._dirty.add(turn);
        if (immediate) {
            this._flush();
            return;
        }
        if (this._renderId)
            return;
        this._renderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RENDER_INTERVAL_MS, () => {
            this._renderId = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        if (this._renderId) {
            GLib.source_remove(this._renderId);
            this._renderId = 0;
        }
        for (const turn of this._dirty)
            this._views.get(turn)?.update();
        this._dirty.clear();
    }

    _onDestroy() {
        this._destroyed = true;
        this._syncUnredirect();
        this.unfocus();
        for (const item of this._images)
            item.alive = false;
        for (const view of this._views.values())
            view.destroy();
        this._views.clear();
        this._dirty.clear();
        if (this._renderId)
            GLib.source_remove(this._renderId);
        this._renderId = 0;
        global.focus_manager.remove_group(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
    }
});
