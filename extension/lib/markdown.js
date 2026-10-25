import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;

/**
 * Splits Markdown into prose and fenced code blocks. An unterminated fence
 * (common while a reply is still streaming) is returned as an open code block.
 *
 * @param {string} markdown
 * @returns {{type: string, text: string, lang?: string}[]}
 */
export function splitBlocks(markdown) {
    const blocks = [];
    let prose = [];
    let code = null;

    const flushProse = () => {
        const text = prose.join('\n').replace(/^\n+|\n+$/g, '');
        if (text.trim())
            blocks.push({type: 'text', text});
        prose = [];
    };

    for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
        const fence = line.match(FENCE);
        if (code) {
            if (fence && fence[1][0] === code.fence[0] && !fence[2]) {
                blocks.push({type: 'code', lang: code.lang, text: code.lines.join('\n')});
                code = null;
            } else {
                code.lines.push(line);
            }
        } else if (fence) {
            flushProse();
            code = {fence: fence[1], lang: fence[2], lines: []};
        } else {
            prose.push(line);
        }
    }

    if (code)
        blocks.push({type: 'code', lang: code.lang, text: code.lines.join('\n')});
    else
        flushProse();
    return blocks;
}

/**
 * Converts a prose block of Markdown to Pango markup.
 *
 * @param {string} text
 * @returns {string}
 */
export function toMarkup(text) {
    const lines = [];
    for (const line of text.split('\n')) {
        let m;
        if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/))) {
            lines.push(`<b>${inline(m[1])}</b>`);
        } else if ((m = line.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
            const box = m[2] ? `${m[2] === ' ' ? '☐' : '☑'} ` : '';
            lines.push(`${indent(m[1])}•  ${box}${inline(m[3])}`);
        } else if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
            lines.push(`${indent(m[1])}${m[2]}.  ${inline(m[3])}`);
        } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
            lines.push(`<i>${inline(m[1])}</i>`);
        } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            lines.push('');
        } else {
            lines.push(inline(line));
        }
    }

    const markup = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    return isValidMarkup(markup) ? markup : escape(text);
}

/**
 * Strips Markdown syntax, for copying answers as plain text.
 *
 * @param {string} text
 * @returns {string}
 */
export function toPlainText(text) {
    return splitBlocks(text).map(block => {
        if (block.type === 'code')
            return block.text;
        return block.text
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?![*\w])/g, '$1$2')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');
    }).join('\n\n');
}

export function escape(text) {
    return GLib.markup_escape_text(text, -1);
}

function indent(spaces) {
    return '    '.repeat(Math.min(Math.floor(spaces.length / 2), 3));
}

function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(code);
        return `\uE000${codes.length - 1}\uE001`;
    });

    s = escape(s)
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>')
        .replace(/(^|[^*\w])\*(?=\S)([^*]+?)(?<=\S)\*(?![*\w])/g, '$1<i>$2</i>')
        .replace(/(^|[^_\w])_(?=\S)([^_]+?)(?<=\S)_(?![_\w])/g, '$1<i>$2</i>')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
        .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '<u>$1</u>');

    return s.replace(/\uE000(\d+)\uE001/g,
        (_, i) => `<tt>${escape(codes[Number(i)])}</tt>`);
}

function isValidMarkup(markup) {
    try {
        Pango.parse_markup(markup, -1, '');
        return true;
    } catch {
        return false;
    }
}
