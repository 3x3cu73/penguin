// Module scope, so a chat survives the extension being disabled and re-enabled
// around a screen lock. It is lost when the shell restarts.
const turns = [];

const MAX_CONTEXT_TURNS = 12;
const MAX_STORED_TURNS = 40;
const MAX_IMAGES = 3;
const MAX_SELECTION_CHARS = 24000;

/**
 * @typedef {object} Turn
 * @property {string} question - sent to the model
 * @property {string} label - shown in the chat
 * @property {{dataUrl: ?string, thumbnail: ?object}[]} images
 * @property {?string} context - selected or copied text
 * @property {?string} selection - the untrimmed selection, for pasting a rewrite back
 * @property {string} answer
 * @property {?string} error
 * @property {boolean} done
 * @property {boolean} replaceable - the answer is a rewrite that can be pasted back
 */

export function getTurns() {
    return turns;
}

export function clear() {
    turns.length = 0;
}

/** Forgets every turn except this one. */
export function keepOnly(turn) {
    turns.splice(0, turns.length, turn);
}

export function isLast(turn) {
    return turns.at(-1) === turn;
}

export function reset(turn) {
    Object.assign(turn, {answer: '', error: null, done: false});
}

/** @returns {Turn} */
export function addTurn({question, label = question, images = [], context = null, selection = null, replaceable = false}) {
    const turn = {question, label, images, context, selection, answer: '', error: null, done: false, replaceable};
    turns.push(turn);
    if (turns.length > MAX_STORED_TURNS)
        turns.splice(0, turns.length - MAX_STORED_TURNS);

    // Only the newest images are ever sent again; free the others.
    let kept = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
        for (const image of turns[i].images) {
            if (kept++ >= MAX_IMAGES)
                image.dataUrl = null;
        }
    }
    return turn;
}

export function buildMessages(systemPrompt) {
    const messages = [{role: 'system', content: systemPrompt}];
    for (const turn of turns.slice(-MAX_CONTEXT_TURNS)) {
        const parts = [];
        if (turn.context) {
            const text = turn.context.length > MAX_SELECTION_CHARS
                ? `${turn.context.slice(0, MAX_SELECTION_CHARS)}\n[…truncated]`
                : turn.context;
            parts.push(`Selected text:\n"""\n${text}\n"""`);
        }
        parts.push(turn.question);

        const images = turn.images.filter(image => image.dataUrl);
        if (images.length < turn.images.length)
            parts.push('[An earlier screenshot was attached here.]');

        const content = [{type: 'text', text: parts.join('\n\n')}];
        for (const image of images)
            content.push({type: 'image_url', image_url: {url: image.dataUrl}});
        messages.push({role: 'user', content});

        if (turn.answer && !turn.error)
            messages.push({role: 'assistant', content: turn.answer});
    }
    return messages;
}
