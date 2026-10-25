import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {WrapLayout, wrappingLabel} from './widgets.js';

const LINE = /^[\s\-*•]*\**\s*(PRON|POS|DEF|EX|SYN|OPP|ORIGIN|LANG|SENSE|NONE)\s*\**\s*:\s*(.*)$/i;

/** Parses the dictionary/thesaurus line format ("POS: noun", "DEF: …"). */
export function parseEntry(text) {
    const items = [];
    for (const line of text.split('\n')) {
        const match = line.match(LINE);
        const item = match
            ? {tag: match[1].toUpperCase(), value: match[2].trim()}
            : {tag: 'TEXT', value: line.trim()};
        if (item.value)
            items.push(item);
    }
    return items;
}

function unquote(text) {
    return text.replace(/^["“'‘]+|["”'’]+$/g, '');
}

/**
 * Renders a streaming dictionary or thesaurus entry like an Oxford entry:
 * word classes, numbered senses, examples, and synonym chips that look the
 * word up when clicked.
 */
export class EntryView {
    constructor(onLookup) {
        this._onLookup = onLookup;
        this.actor = new St.BoxLayout({
            style_class: 'penguin-entry',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._senses = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._origin = new St.BoxLayout({
            style_class: 'penguin-entry-origin',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.add_child(this._senses);
        this.actor.add_child(this._origin);
        this.clear();
    }

    clear() {
        this._senses.destroy_all_children();
        this._origin.destroy_all_children();
        this._origin.hide();
        this._rendered = 0;
        this._number = 0;
        this._column = null;
        this._plain = [];
        this.pronunciation = '';
        this.language = '';
    }

    /**
     * @param {string} text - the answer so far
     * @param {boolean} done - whether the last line is complete
     */
    setText(text, done) {
        const complete = done ? text : text.slice(0, text.lastIndexOf('\n') + 1);
        const items = parseEntry(complete);
        for (const item of items.slice(this._rendered))
            this._add(item);
        this._rendered = items.length;
    }

    get hasContent() {
        return this._senses.get_n_children() > 0 || this._origin.visible;
    }

    toPlainText() {
        return this._plain.join('\n');
    }

    _add({tag, value}) {
        switch (tag) {
        case 'PRON':
            this.pronunciation = value;
            break;
        case 'LANG':
            this.language = value;
            break;
        case 'POS':
            this._number = 0;
            this._column = null;
            this._senses.add_child(new St.Label({text: value, style_class: 'penguin-entry-pos'}));
            this._plain.push(value);
            break;
        case 'DEF': {
            this._number++;
            const row = new St.BoxLayout({style_class: 'penguin-entry-sense', x_expand: true});
            row.add_child(new St.Label({text: `${this._number}`, style_class: 'penguin-entry-number'}));
            this._column = new St.BoxLayout({
                style_class: 'penguin-entry-column',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            this._column.add_child(wrappingLabel('penguin-entry-definition', value));
            row.add_child(this._column);
            this._senses.add_child(row);
            this._plain.push(`${this._number}. ${value}`);
            break;
        }
        case 'SENSE':
            this._column = new St.BoxLayout({
                style_class: 'penguin-entry-column penguin-entry-group',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            this._column.add_child(wrappingLabel('penguin-entry-pos', value));
            this._senses.add_child(this._column);
            this._plain.push(value);
            break;
        case 'EX':
            (this._column ?? this._senses).add_child(
                wrappingLabel('penguin-entry-example', `“${unquote(value)}”`));
            this._plain.push(`   “${unquote(value)}”`);
            break;
        case 'SYN':
        case 'OPP': {
            const title = tag === 'SYN' ? 'Similar' : 'Opposite';
            (this._column ?? this._senses).add_child(this._chips(title, value));
            this._plain.push(`   ${title}: ${value}`);
            break;
        }
        case 'ORIGIN':
            if (this._origin.visible)
                break;
            this._origin.add_child(new St.Label({text: 'Origin', style_class: 'penguin-entry-origin-title'}));
            this._origin.add_child(wrappingLabel('penguin-entry-origin-text', value));
            this._origin.show();
            this._plain.push(`Origin: ${value}`);
            break;
        default:
            this._senses.add_child(wrappingLabel('penguin-prose', value));
            this._plain.push(value);
        }
    }

    _chips(title, value) {
        const flow = new St.Widget({
            style_class: 'penguin-entry-chips',
            layout_manager: new WrapLayout(6, 4),
            x_expand: true,
        });
        flow.add_child(new St.Label({
            text: `${title}:`,
            style_class: 'penguin-entry-chips-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        for (const word of value.split(',').map(w => w.trim().replace(/\.$/, '')).filter(Boolean)) {
            const chip = new St.Button({label: word, style_class: 'penguin-word-chip', can_focus: true});
            chip.connect('clicked', () => this._onLookup(word));
            flow.add_child(chip);
        }
        return flow;
    }
}
