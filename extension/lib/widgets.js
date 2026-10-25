import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Markdown from './markdown.js';

/** Keeps `penguin-light` on the actor in sync with the shell's light/dark style. */
export function trackColorScheme(actor, onChanged = null) {
    const settings = St.Settings.get();
    const sync = () => {
        if (Main.getStyleVariant() === 'light')
            actor.add_style_class_name('penguin-light');
        else
            actor.remove_style_class_name('penguin-light');
        onChanged?.();
    };
    settings.connectObject('notify::color-scheme', sync, actor);
    actor.connect('destroy', () => settings.disconnectObject(actor));
    sync();
}

export function iconButton(iconName, accessibleName, onClicked, styleClass = 'penguin-icon-button') {
    const button = new St.Button({
        style_class: styleClass,
        icon_name: iconName,
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClicked());
    return button;
}

export function pillButton(label, iconName, onClicked, styleClass = 'penguin-pill') {
    const box = new St.BoxLayout({style_class: 'penguin-pill-box'});
    if (iconName) {
        box.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'penguin-pill-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
    const button = new St.Button({style_class: styleClass, child: box, can_focus: true});
    button.connect('clicked', () => onClicked());
    return button;
}

export function wrappingLabel(styleClass, text = '') {
    const label = new St.Label({style_class: styleClass, text, x_expand: true});
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
    });
    return label;
}

export function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

/** Lays children out left to right, wrapping onto new rows when they don't fit. */
export const WrapLayout = GObject.registerClass(
class PenguinWrapLayout extends Clutter.LayoutManager {
    constructor(spacing = 6, rowSpacing = 4) {
        super();
        this._spacing = spacing;
        this._rowSpacing = rowSpacing;
    }

    _rows(container, width) {
        const rows = [];
        let row = null;
        let x = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, childWidth] = child.get_preferred_width(-1);
            const [, childHeight] = child.get_preferred_height(childWidth);
            if (!row || (x + childWidth > width && row.items.length > 0)) {
                row = {items: [], height: 0};
                rows.push(row);
                x = 0;
            }
            row.items.push({child, x, width: childWidth, height: childHeight});
            row.height = Math.max(row.height, childHeight);
            x += childWidth + this._spacing;
        }
        return rows;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        let min = 0;
        let natural = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [childMin, childNatural] = child.get_preferred_width(-1);
            min = Math.max(min, childMin);
            natural += childNatural + (natural > 0 ? this._spacing : 0);
        }
        return [min, natural];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const rows = this._rows(container, forWidth < 0 ? Infinity : forWidth);
        const height = rows.reduce((sum, row) => sum + row.height, 0) +
            Math.max(0, rows.length - 1) * this._rowSpacing;
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        let y = box.y1;
        for (const row of this._rows(container, width)) {
            for (const item of row.items) {
                const childBox = new Clutter.ActorBox();
                childBox.set_origin(box.x1 + item.x, y + Math.floor((row.height - item.height) / 2));
                childBox.set_size(Math.min(item.width, width), item.height);
                item.child.allocate(childBox);
            }
            y += row.height + this._rowSpacing;
        }
    }
});

/** Shows image content at the given logical height, keeping its aspect ratio. */
export function thumbnailActor(content, styleClass, height) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const [, naturalWidth, naturalHeight] = content.get_preferred_size();
    return new St.Widget({
        style_class: styleClass,
        content,
        width: Math.round(naturalWidth * height / naturalHeight) * scale,
        height: height * scale,
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/** Turns '<Shift><Super>s' into 'Shift+Super+S'. */
export function accelLabel(accel) {
    if (!accel)
        return '';
    const names = {control: 'Ctrl', primary: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', super: 'Super', meta: 'Meta'};
    const mods = [...accel.matchAll(/<(\w+)>/g)].map(m => names[m[1].toLowerCase()] ?? m[1]);
    const order = ['Ctrl', 'Alt', 'Shift', 'Super', 'Meta'];
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    let key = accel.replace(/<\w+>/g, '');
    key = {space: 'Space', Return: 'Enter', Escape: 'Esc'}[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    return [...mods, key].join('+');
}

/**
 * Renders a streaming Markdown answer: prose as wrapped Pango labels, fenced
 * code as monospace boxes with their own copy button.
 */
export class AnswerView {
    constructor(styleClass = 'penguin-answer') {
        this.actor = new St.BoxLayout({
            style_class: styleClass,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._blocks = [];
        this._thinking = null;
        this._error = null;
    }

    setThinking(thinking, label = 'Thinking…') {
        if (!thinking) {
            this._thinking?.destroy();
            this._thinking = null;
            return;
        }
        if (this._thinking)
            return;
        this._thinking = new St.BoxLayout({style_class: 'penguin-thinking'});
        const spinner = new Spinner(16, {animate: true});
        spinner.play();
        this._thinking.add_child(spinner);
        this._thinking.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        this.actor.add_child(this._thinking);
    }

    setText(text) {
        const blocks = Markdown.splitBlocks(text);

        let reuse = 0;
        while (reuse < blocks.length && reuse < this._blocks.length &&
               this._blocks[reuse].type === blocks[reuse].type)
            reuse++;
        for (const view of this._blocks.splice(reuse))
            view.actor.destroy();

        blocks.forEach((block, i) => {
            let view = this._blocks[i];
            if (!view) {
                view = block.type === 'code' ? this._createCode() : this._createProse();
                this._blocks.push(view);
                this.actor.insert_child_at_index(view.actor, i);
            }
            if (view.source !== block.text || view.lang !== block.lang) {
                view.source = block.text;
                view.lang = block.lang;
                view.update(block);
            }
        });
    }

    setError(message) {
        this._error?.destroy();
        this._error = null;
        if (!message)
            return;
        this._error = wrappingLabel('penguin-error', message);
        this.actor.add_child(this._error);
    }

    clear() {
        this.setThinking(false);
        this.setError(null);
        for (const view of this._blocks)
            view.actor.destroy();
        this._blocks = [];
    }

    _createProse() {
        const label = wrappingLabel('penguin-prose');
        return {
            type: 'text',
            actor: label,
            update: block => label.clutter_text.set_markup(Markdown.toMarkup(block.text)),
        };
    }

    _createCode() {
        const box = new St.BoxLayout({
            style_class: 'penguin-code',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const header = new St.BoxLayout({style_class: 'penguin-code-header'});
        const lang = new St.Label({
            style_class: 'penguin-code-lang',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const view = {type: 'code', actor: box, source: null};
        header.add_child(lang);
        header.add_child(iconButton('edit-copy-symbolic', 'Copy code',
            () => copyText(view.source), 'penguin-icon-button penguin-small'));
        const code = wrappingLabel('penguin-code-text');
        box.add_child(header);
        box.add_child(code);
        view.update = block => {
            lang.text = block.lang || 'code';
            code.text = block.text;
        };
        return view;
    }
}
