import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const WORD_CLASSES = {n: 'noun', v: 'verb', a: 'adjective', r: 'adverb'};
const MAX_SENSES = 3;
// For the base form ("see" under "saw") when the word is a headword of its own.
const MAX_BASE_SENSES = 2;
const MAX_SYNONYMS = 5;
const MAX_OPPOSITES = 3;

// WordNet's rules for regular inflections; irregular forms come with the data.
const SUFFIXES = {
    n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'],
        ['men', 'man'], ['ies', 'y']],
    v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
    a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e']],
    r: [],
};

const EDGE_PUNCTUATION = /^[\s"“”'«([{]+|[\s"“”'»)\]}.,;:!?…]+$/g;

/**
 * The offline dictionary: Open English WordNet, which install-dictionary.py
 * splits into small JSON files keyed by lower-case headword.
 */
export class WordNet {
    constructor(path = GLib.build_filenamev([GLib.get_user_data_dir(), 'penguin', 'dictionary'])) {
        this._dir = Gio.File.new_for_path(path);
    }

    /**
     * Looks up a word or phrase along with its base form ("saw" → "see").
     *
     * @param {string} text - the selected text
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<string|null>} the entry in the Look Up line format
     *   (see dictionary.js), or null if the dictionary doesn't have it
     */
    async define(text, cancellable = null) {
        const {shards: count} = await this._readInfo(cancellable);
        const shards = new Map();
        const lookUp = key => {
            const name = `${shardOf(key, count)}.json`;
            if (!shards.has(name))
                shards.set(name, this._readJson(name, cancellable));
            return shards.get(name).then(records => records[key] ?? null);
        };

        const typed = text.normalize('NFC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
        const word = typed.replace(EDGE_PUNCTUATION, '');
        if (!word)
            return null;

        // "a.m." is a headword with its full stops; "happy," isn't.
        let surface = typed;
        let record = await lookUp(surface.toLowerCase());
        if (!record && word !== typed) {
            surface = word;
            record = await lookUp(surface.toLowerCase());
        }

        const exact = [...record?.g ?? []].sort((a, b) => Number(a.l !== surface) - Number(b.l !== surface));
        const bases = await baseGroups(surface.toLowerCase(), record, lookUp);
        if (exact.length === 0 && bases.length === 0)
            return null;
        return format(surface, exact, bases);
    }

    async _readInfo(cancellable) {
        try {
            return await this._readJson('info.json', cancellable);
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw new Error('The offline dictionary isn’t installed. Run ./install-dictionary.py in the Penguin folder.');
            throw e;
        }
    }

    async _readJson(name, cancellable) {
        const [contents] = await this._dir.get_child(name).load_contents_async(cancellable);
        return JSON.parse(decoder.decode(contents));
    }
}

// 32-bit FNV-1a of the UTF-8 key; must match shard_of() in install-dictionary.py.
function shardOf(key, count) {
    let hash = 0x811c9dc5;
    for (const byte of encoder.encode(key))
        hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash % count;
}

/**
 * The word classes of the headwords that `key` inflects, found the way WordNet
 * does: irregular forms from the data, otherwise the first suffix rule that
 * gives a headword.
 */
async function baseGroups(key, record, lookUp) {
    const words = key.split(' ');
    const groups = [];
    for (const pos of Object.keys(SUFFIXES)) {
        // A phrasal verb inflects its first word ("gave up"), a compound noun its last ("credit cards").
        const at = words.length === 1 ? 0 : {v: 0, n: words.length - 1}[pos];
        if (at === undefined)
            continue;
        const own = words.length === 1 ? record : await lookUp(words[at]);
        const irregular = (own?.b ?? []).filter(([, p]) => p === pos).map(([lemma]) => lemma.toLowerCase());
        for (const base of irregular.length > 0 ? irregular : regularBases(words[at], pos)) {
            const candidate = words.with(at, base).join(' ');
            if (candidate === key)
                continue;
            const found = ((await lookUp(candidate))?.g ?? []).filter(g => g.p === pos);
            groups.push(...found);
            if (found.length > 0 && irregular.length === 0)
                break;
        }
    }
    return groups;
}

function regularBases(word, pos) {
    if (pos === 'n' && (word.length <= 2 || word.endsWith('ss')))
        return [];
    return SUFFIXES[pos]
        .filter(([suffix]) => word.length > suffix.length && word.endsWith(suffix))
        .map(([suffix, ending]) => word.slice(0, -suffix.length) + ending);
}

function format(word, exact, bases) {
    const lines = [];
    const sound = exact.find(g => g.i)?.i;
    if (sound)
        lines.push(`PRON: /${sound}/`);

    const sections = [[exact, MAX_SENSES], [bases, exact.length > 0 ? MAX_BASE_SENSES : MAX_SENSES]];
    for (const [groups, maxSenses] of sections) {
        for (const group of groups) {
            const headword = group.l !== word && group.l !== word.toLowerCase() ? group.l : null;
            const homograph = groups === exact && group.i && group.i !== sound ? `/${group.i}/` : null;
            lines.push(`POS: ${[headword, WORD_CLASSES[group.p], homograph].filter(Boolean).join(' · ')}`);
            for (const sense of group.s.slice(0, maxSenses)) {
                lines.push(`DEF: ${sense.d}`);
                if (sense.x)
                    lines.push(`EX: ${sense.x}`);
                if (sense.y)
                    lines.push(`SYN: ${sense.y.slice(0, MAX_SYNONYMS).join(', ')}`);
                if (sense.o)
                    lines.push(`OPP: ${sense.o.slice(0, MAX_OPPOSITES).join(', ')}`);
            }
        }
    }
    return lines.join('\n');
}
