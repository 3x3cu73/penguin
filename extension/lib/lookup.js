import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EntryView} from './dictionary.js';
import * as Markdown from './markdown.js';
import {
    AnswerView, copyText, iconButton, pillButton, thumbnailActor, trackColorScheme, wrappingLabel
} from './widgets.js';

const WIDTH = {term: 500, text: 560, image: 560};
const MAX_BODY_HEIGHT = 340;
const MIN_BODY_HEIGHT = 120;
// Header, subtitle, footer and mode buttons around the scrolling body (px).
const CHROME_HEIGHT = 150;
const POINTER_GAP = 18;
const SCREEN_MARGIN = 8;

// How far the card moves per scroll notch when it follows the document (px).
// Approximate, since an app's real scroll distance isn't knowable from here.
const SMOOTH_STEP = 50;
const DISCRETE_STEP = 50;

const MODES = {
    term: [
        {id: 'define', label: 'Dictionary'},
        {id: 'thesaurus', label: 'Thesaurus'},
        {id: 'wikipedia', label: 'Wikipedia'},
        {id: 'context', label: 'In context'},
    ],
    text: [
        {id: 'explain', label: 'Explain'},
        {id: 'summarize', label: 'Summarize'},
        {id: 'fix', label: 'Fix writing'},
        {id: 'rewrite', label: 'Rewrite'},
        {id: 'translate', label: 'Translate'},
    ],
    image: [
        {id: 'explain', label: 'Explain'},
        {id: 'text', label: 'Copy text'},
    ],
};

// Modes whose answers use the dictionary line format instead of Markdown.
const ENTRY_MODES = new Set(['define', 'thesaurus']);

const THINKING = {
    define: 'Looking up…',
    thesaurus: 'Finding synonyms…',
    wikipedia: 'Searching Wikipedia…',
    context: 'Reading your screen…',
};

/**
 * A card that opens next to the pointer, like Look Up on macOS. Words get an
 * Oxford-style dictionary entry; passages and copied images get explained.
 *
 * A subject is {kind: 'term' | 'text', text, raw, source, offline} or
 * {kind: 'image', image: Promise}. An offline subject's Dictionary tab comes
 * from the offline dictionary instead of the AI.
 */
export const LookupPopover = GObject.registerClass(
class LookupPopover extends St.BoxLayout {
    constructor(assistant, gicon) {
        super({
            style_class: 'penguin-popover',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
        });
        this._assistant = assistant;
        this._globalId = 0;
        this._watchedWindow = null;
        this._escapeAction = Meta.KeyBindingAction.NONE;
        this._releaseEscapeId = 0;
        this._bodyHeight = 0;
        this._subject = null;
        this._mode = null;
        this._text = '';
        this._wikiUrl = null;
        this._anchor = null;
        this._laterId = 0;
        this._userMoved = false;
        this._workArea = null;

        const header = new St.BoxLayout({style_class: 'penguin-popover-header'});
        this._thumbnail = new St.Bin({y_align: Clutter.ActorAlign.CENTER, visible: false});
        header.add_child(this._thumbnail);
        this._title = new St.Label({
            style_class: 'penguin-popover-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._title);
        this._copyButton = iconButton('edit-copy-symbolic', 'Copy', () => {
            copyText(this._plainText());
            this.close();
        });
        header.add_child(this._copyButton);
        this.add_child(header);

        this._subtitle = new St.Label({style_class: 'penguin-popover-subtitle', visible: false});
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._subtitle);

        const body = new St.BoxLayout({
            style_class: 'penguin-popover-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._answer = new AnswerView('penguin-popover-answer');
        this._entry = new EntryView(word => this._assistant.lookUpWord(word));
        this._wiki = this._buildWikipedia();
        body.add_child(this._answer.actor);
        body.add_child(this._entry.actor);
        body.add_child(this._wiki);
        this._scroll = new St.ScrollView({
            style_class: 'penguin-popover-scroll',
            child: body,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this.add_child(this._scroll);

        this._footer = new St.BoxLayout({style_class: 'penguin-popover-footer', visible: false});
        this._replaceButton = pillButton('Replace selection', 'edit-paste-symbolic',
            () => this._assistant.replaceFromLookup(this._text), 'penguin-pill penguin-small');
        this._wikiButton = pillButton('Open in Wikipedia', 'web-browser-symbolic', () => {
            if (this._wikiUrl)
                this._assistant.openUri(this._wikiUrl);
        }, 'penguin-pill penguin-small');
        this._footer.add_child(this._replaceButton);
        this._footer.add_child(this._wikiButton);
        this.add_child(this._footer);

        this._actions = new St.BoxLayout({style_class: 'penguin-popover-actions'});
        this._modes = new St.BoxLayout({style_class: 'penguin-popover-modes'});
        this._modeButtons = new Map();
        this._actions.add_child(this._modes);
        this._actions.add_child(new St.Widget({x_expand: true}));
        const ask = pillButton('Ask Penguin', null, () => this._assistant.askAbout(this._subject),
            'penguin-pill penguin-small penguin-accent');
        ask.child.insert_child_at_index(new St.Icon({
            gicon,
            style_class: 'penguin-pill-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }), 0);
        this._actions.add_child(ask);
        this.add_child(this._actions);

        Main.layoutManager.addTopChrome(this);
        global.focus_manager.add_group(this);
        trackColorScheme(this);
        Main.layoutManager.connectObject('monitors-changed', () => this.close({animate: false}), this);
        this.connect('notify::height', () => this._queueFit());
        this.connect('destroy', this._onDestroy.bind(this));
    }

    _buildWikipedia() {
        const box = new St.BoxLayout({style_class: 'penguin-wiki', x_expand: true, visible: false});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._wikiDescription = wrappingLabel('penguin-wiki-description');
        this._wikiExtract = wrappingLabel('penguin-prose');
        column.add_child(this._wikiDescription);
        column.add_child(this._wikiExtract);
        this._wikiImage = new St.Bin({y_align: Clutter.ActorAlign.START, visible: false});
        box.add_child(column);
        box.add_child(this._wikiImage);
        return box;
    }

    get subject() {
        return this._subject;
    }

    /** Opens at the pointer for a subject, ready for runLookup(). */
    open(subject) {
        this._reset(subject);
        this._present(subject.kind);
    }

    /** Shows another subject in place, e.g. after clicking a synonym. */
    navigate(subject) {
        this._reset(subject);
        this._place(subject.kind, this._anchor);
    }

    /** Opens at the pointer with a short explanation instead of a subject. */
    openHint(title, hint) {
        this._reset(null);
        this._setTitle(title, true);
        this._answer.setText(hint);
        this._present('term');
    }

    setMode(modeId) {
        for (const [id, button] of this._modeButtons) {
            if (id === modeId)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._mode = modeId;
        this._clearContent();
        this._answer.setThinking(true, THINKING[modeId] ??
            (this._subject?.kind === 'image' ? 'Looking at the image…' : 'Thinking…'));
    }

    setText(text) {
        this._text = text;
        if (ENTRY_MODES.has(this._mode)) {
            this._entry.actor.show();
            this._entry.setText(text, false);
            if (this._entry.hasContent)
                this._answer.setThinking(false);
            this._syncPronunciation();
        } else {
            this._answer.setThinking(false);
            this._answer.setText(text);
        }
        this._copyButton.visible = text.length > 0;
    }

    setWikipedia({description, extract, url}) {
        this._answer.setThinking(false);
        this._wikiDescription.text = description ?? '';
        this._wikiDescription.visible = !!description;
        this._wikiExtract.text = extract;
        this._wiki.show();
        this._text = extract;
        this._wikiUrl = url;
        this._copyButton.visible = true;
        this._wikiButton.visible = !!url;
        this._footer.visible = !!url;
    }

    setWikipediaImage(content) {
        this._wikiImage.set_child(thumbnailActor(content, 'penguin-wiki-image', 84));
        this._wikiImage.show();
    }

    setError(message) {
        this._answer.setThinking(false);
        this._answer.setError(message);
    }

    setDone({replaceable = false} = {}) {
        this._answer.setThinking(false);
        if (ENTRY_MODES.has(this._mode) && this._text) {
            this._entry.actor.show();
            this._entry.setText(this._text, true);
            this._syncPronunciation();
        }
        this._replaceButton.visible = replaceable && this._text.trim().length > 0;
        this._footer.visible = this._replaceButton.visible || this._wikiButton.visible;
    }

    /** Hides without animation so the popover stays out of a screenshot. */
    hideForCapture() {
        this.remove_all_transitions();
        this.opacity = 0;
    }

    restoreAfterCapture() {
        this.opacity = 255;
    }

    close({animate = true} = {}) {
        this._disconnectGlobal();
        if (!this.visible)
            return;
        this._assistant.cancelLookup();
        this.remove_all_transitions();
        if (!animate) {
            this.hide();
            return;
        }
        this.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this.hide(),
        });
    }

    _plainText() {
        if (ENTRY_MODES.has(this._mode)) {
            const heading = [this._subject?.text, this._entry.pronunciation].filter(Boolean).join(' ');
            return `${heading}\n${this._entry.toPlainText()}`;
        }
        return Markdown.toPlainText(this._text);
    }

    _syncPronunciation() {
        const subtitle = [this._entry.language, this._entry.pronunciation].filter(Boolean).join(' · ');
        this._subtitle.text = subtitle;
        this._subtitle.visible = subtitle.length > 0;
    }

    _clearContent() {
        this._text = '';
        this._wikiUrl = null;
        this._answer.clear();
        this._entry.clear();
        this._entry.actor.hide();
        this._wiki.hide();
        this._wikiImage.set_child(null);
        this._wikiImage.hide();
        this._subtitle.hide();
        this._footer.hide();
        this._replaceButton.hide();
        this._wikiButton.hide();
        this._copyButton.visible = false;
    }

    _reset(subject) {
        this._subject = subject;
        this._mode = null;
        this._clearContent();
        this._thumbnail.set_child(null);
        this._thumbnail.hide();

        this._modes.destroy_all_children();
        this._modeButtons.clear();
        for (const mode of MODES[subject?.kind] ?? []) {
            const button = pillButton(mode.label, null,
                () => this._assistant.runLookup(mode.id), 'penguin-pill penguin-small');
            this._modeButtons.set(mode.id, button);
            this._modes.add_child(button);
        }
        this._actions.visible = subject !== null;

        if (subject?.kind === 'image') {
            this._setTitle('Copied image', false);
            subject.image.then(image => {
                if (this._subject !== subject)
                    return;
                this._thumbnail.set_child(thumbnailActor(image.thumbnail, 'penguin-popover-thumb', 36));
                this._thumbnail.show();
            }).catch(() => {});
        } else if (subject?.kind === 'term') {
            this._setTitle(subject.text.replace(/\s+/g, ' '), true);
        } else if (subject) {
            this._setTitle(`“${subject.text.replace(/\s+/g, ' ').slice(0, 120)}”`, false);
        }
    }

    _setTitle(text, prominent) {
        this._title.text = text;
        if (prominent)
            this._title.remove_style_class_name('penguin-popover-quote');
        else
            this._title.add_style_class_name('penguin-popover-quote');
    }

    _present(kind) {
        const appearing = !this.visible || this.opacity < 255;
        this._place(kind);
        if (appearing) {
            this.remove_all_transitions();
            this.set_pivot_point(0.1, this._anchor.above ? 1 : 0);
            this.opacity = 0;
            this.scale_x = this.scale_y = 0.94;
            this.show();
            this.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._connectGlobal();
    }

    // The card is deliberately non-modal: events reach the app underneath, so
    // you can keep scrolling and clicking the document while it's open.
    // Mutter hands keys and clicks meant for a window straight to the app, so
    // the stage only sees events over the shell. Escape is therefore grabbed
    // while the card is open, and a key press or click in the focused window
    // (which bumps its user time) or a focus change closes the card.
    _connectGlobal() {
        if (this._globalId)
            return;
        this._globalId = global.stage.connect('captured-event',
            (_actor, event) => this._onGlobalEvent(event));
        this._grabEscape();
        global.display.connectObject(
            'accelerator-activated', (_display, action) => {
                if (action === this._escapeAction)
                    this.close();
            },
            'notify::focus-window', () => this.close(),
            this);
        Main.overview.connectObject('showing', () => this.close({animate: false}), this);
        this._watchedWindow = global.display.focus_window;
        this._watchedWindow?.connectObject('notify::user-time', () => this.close(), this);
    }

    _disconnectGlobal() {
        if (!this._globalId)
            return;
        global.stage.disconnect(this._globalId);
        this._globalId = 0;
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._watchedWindow?.disconnectObject(this);
        this._watchedWindow = null;
        this._releaseEscape();
    }

    _grabEscape() {
        if (this._releaseEscapeId) {
            GLib.source_remove(this._releaseEscapeId);
            this._releaseEscapeId = 0;
        }
        if (this._escapeAction !== Meta.KeyBindingAction.NONE)
            return;
        const action = global.display.grab_accelerator('Escape', Meta.KeyBindingFlags.NONE);
        if (action === Meta.KeyBindingAction.NONE)
            return;
        this._escapeAction = action;
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }

    // Deferred: the Escape press that closes the card through the user-time
    // signal is matched against key bindings afterwards, and must still be
    // swallowed by the grab instead of reaching the app.
    _releaseEscape() {
        if (this._escapeAction === Meta.KeyBindingAction.NONE || this._releaseEscapeId)
            return;
        this._releaseEscapeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._releaseEscapeId = 0;
            this._ungrabEscape();
            return GLib.SOURCE_REMOVE;
        });
    }

    _ungrabEscape() {
        if (this._releaseEscapeId) {
            GLib.source_remove(this._releaseEscapeId);
            this._releaseEscapeId = 0;
        }
        if (this._escapeAction === Meta.KeyBindingAction.NONE)
            return;
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._escapeAction),
            Shell.ActionMode.NONE);
        global.display.ungrab_accelerator(this._escapeAction);
        this._escapeAction = Meta.KeyBindingAction.NONE;
    }

    _onGlobalEvent(event) {
        const type = event.type();
        const target = global.stage.get_event_actor(event);
        const overCard = target !== null && this.contains(target);

        if (type === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
        } else if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            if (!overCard)
                this.close();
        } else if (type === Clutter.EventType.SCROLL && !overCard) {
            // Scrolling the document moves the card with it, like a sticky note.
            this._followScroll(event);
        }
        // Everything propagates so the app (or the card's own scrollview) still reacts.
        return Clutter.EVENT_PROPAGATE;
    }

    _followScroll(event) {
        let dy;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.SMOOTH:
            dy = event.get_scroll_delta()[1] * SMOOTH_STEP;
            break;
        case Clutter.ScrollDirection.DOWN:
            dy = DISCRETE_STEP;
            break;
        case Clutter.ScrollDirection.UP:
            dy = -DISCRETE_STEP;
            break;
        default:
            return;
        }
        if (!dy)
            return;

        this._userMoved = true;
        this.y = Math.round(this.y - dy);
        const area = this._workArea;
        if (area && (this.y + this.height < area.y + 2 || this.y > area.y + area.height - 2))
            this.close();
    }

    /**
     * Sizes the card and anchors it below the pointer, or above it when only
     * there a full-height card fits, or at `anchor`.
     */
    _place(kind, anchor = null) {
        this._userMoved = false;
        const index = global.display.get_current_monitor();
        const workArea = Main.layoutManager.getWorkAreaForMonitor(index);
        this._workArea = workArea;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min((WIDTH[kind] ?? WIDTH.term) * scale, workArea.width - 16 * scale);
        this.set_width(width);

        if (anchor) {
            const x = Math.min(anchor.x, workArea.x + workArea.width - width - 8 * scale);
            this._anchor = {...anchor, x};
        } else {
            const [pointerX, pointerY] = global.get_pointer();
            const gap = POINTER_GAP * scale;
            const margin = SCREEN_MARGIN * scale;
            const roomBelow = workArea.y + workArea.height - margin - (pointerY + gap);
            const roomAbove = pointerY - gap - (workArea.y + margin);
            const tallest = (MAX_BODY_HEIGHT + CHROME_HEIGHT) * scale;
            const above = roomBelow < tallest && roomAbove > roomBelow;
            const x = Math.max(workArea.x + 8 * scale,
                Math.min(pointerX - 28 * scale, workArea.x + workArea.width - width - 8 * scale));
            this._anchor = {x, y: above ? pointerY - gap : pointerY + gap, above};
        }
        this._fit();
    }

    // Caps the scrolling body so the whole card fits between its anchor and
    // the screen edge, then positions it. An above-the-pointer card keeps its
    // bottom edge in place as the answer grows.
    _fit() {
        if (!this._anchor || !this._workArea)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = this._workArea;
        const margin = SCREEN_MARGIN * scale;
        const {x, y, above} = this._anchor;
        const room = above ? y - (area.y + margin) : area.y + area.height - margin - y;
        const chrome = this.height > this._scroll.height
            ? this.height - this._scroll.height
            : CHROME_HEIGHT * scale;
        const body = Math.max(MIN_BODY_HEIGHT,
            Math.min(MAX_BODY_HEIGHT, Math.floor((room - chrome) / scale)));
        if (body !== this._bodyHeight) {
            this._bodyHeight = body;
            this._scroll.style = `max-height: ${body}px;`;
        }

        const top = above ? y - this.height : y;
        const lowest = area.y + area.height - margin - this.height;
        this.set_position(x, Math.round(Math.max(area.y + margin, Math.min(top, lowest))));
    }

    _queueFit() {
        if (this._userMoved || !this._anchor || this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._fit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onDestroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._disconnectGlobal();
        this._ungrabEscape();
        global.focus_manager.remove_group(this);
        Main.layoutManager.disconnectObject(this);
    }
});
