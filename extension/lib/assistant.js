import Gio from 'gi://Gio';

import {ChatClient, ContextTooLongError, isCancelled} from './api.js';
import * as Capture from './capture.js';
import * as Chat from './chat.js';
import {LookupPopover} from './lookup.js';
import * as Markdown from './markdown.js';
import {PenguinPanel} from './panel.js';
import {Paster} from './paste.js';
import * as Prompts from './prompts.js';
import {accelLabel} from './widgets.js';
import {WordNet} from './wordnet.js';

// Up to this size a selection is treated as a word or phrase and gets a dictionary entry.
const TERM_WORDS = 4;
const TERM_CHARS = 48;
const MAX_LOOKUP_CHARS = 20000;
const REPLACEABLE_MODES = new Set(['fix', 'rewrite', 'translate']);

export class Assistant {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
        this._cancellable = null;
        this._lookupCancellable = null;

        this.gicon = new Gio.FileIcon({
            file: extension.dir.get_child('icons').get_child('penguin-symbolic.svg'),
        });
        this._client = new ChatClient(settings);
        this._dictionary = new WordNet();
        this._tracker = new Capture.SelectionTracker();
        this._paster = new Paster();
        this._panel = new PenguinPanel(this, settings, this.gicon);
        this._lookup = new LookupPopover(this, this.gicon);
        this._panel.renderTurns(Chat.getTurns());
    }

    destroy() {
        this._cancellable?.cancel();
        this._lookupCancellable?.cancel();
        this._lookup.destroy();
        this._lookup = null;
        this._panel.destroy();
        this._panel = null;
        this._paster.destroy();
        this._paster = null;
        this._tracker.destroy();
        this._tracker = null;
        this._client.destroy();
        this._client = null;
        this._dictionary = null;
    }

    get busy() {
        return this._cancellable !== null;
    }

    toggle() {
        this._lookup.close({animate: false});
        this._panel.toggle();
    }

    open() {
        this._lookup.close({animate: false});
        this._panel.open();
    }

    ask(question) {
        this.open();
        if (question.trim())
            this.submit(question.trim());
    }

    async askAboutScreen() {
        this._lookup.close({animate: false});
        const monitorIndex = global.display.get_current_monitor();
        this._panel.hideNow();

        let grab;
        try {
            grab = await Capture.grabMonitor(monitorIndex);
        } catch (e) {
            if (!this._panel)
                return;
            this._panel.open();
            this._panel.showNotice(`Couldn’t capture the screen: ${e.message}`);
            return;
        }
        if (!this._panel)
            return;
        this._panel.open();
        this._panel.attachImage(Capture.encodeGrab(grab));
    }

    /** Moves whatever the Look Up card shows into the main chat. */
    askAbout(subject) {
        this._lookup.close({animate: false});
        this._panel.open();
        if (subject?.kind === 'image')
            this._panel.attachImage(subject.image, {label: 'Copied image', screenshot: false});
        else if (subject)
            this._panel.attachText(subject.text, subject.source ?? 'primary', subject.raw);
    }

    newChat() {
        this.stop();
        Chat.clear();
        this._panel.reset();
        this._lookup.close({animate: false});
        this._panel.open();
    }

    stop() {
        this._cancellable?.cancel();
    }

    openPreferences() {
        this._panel.close();
        this._lookup.close({animate: false});
        this._extension.openPreferences();
    }

    // Chat

    async submit(text, action = null) {
        if (this.busy)
            return;
        const {images: pending, screenshot, text: attached} = this._panel.takeAttachments();

        let question, label;
        if (action) {
            question = text ? `${action.prompt}\n\n${text}` : action.prompt;
            label = text ? `${action.label}: ${text}` : action.label;
        } else if (text) {
            question = label = text;
        } else if (pending.length > 0) {
            question = screenshot ? Prompts.DEFAULT_SCREEN_PROMPT : Prompts.DEFAULT_IMAGE_PROMPT;
            label = screenshot ? 'What’s on my screen?' : 'What’s in this image?';
        } else if (attached) {
            question = Prompts.DEFAULT_TEXT_PROMPT;
            label = 'Explain this';
        } else {
            return;
        }

        const cancellable = this._begin();
        let images;
        try {
            images = await Promise.all(pending);
        } catch (e) {
            this._end(cancellable);
            this._panel?.showNotice(`Couldn’t read the image: ${e.message}`);
            return;
        }
        if (cancellable.is_cancelled()) {
            this._end(cancellable);
            return;
        }

        const turn = Chat.addTurn({
            question,
            label,
            images: images.map(({dataUrl, thumbnail}) => ({dataUrl, thumbnail})),
            context: attached?.text ?? null,
            selection: attached?.raw ?? null,
            replaceable: !!action?.replace && attached?.source === 'primary',
        });
        this._panel.addTurn(turn);
        await this._stream(turn, cancellable);
    }

    retry(turn) {
        if (this.busy || !Chat.isLast(turn))
            return;
        Chat.reset(turn);
        this._panel.updateTurn(turn, {immediate: true});
        this._stream(turn, this._begin());
    }

    _begin() {
        this._cancellable = new Gio.Cancellable();
        this._panel.setBusy(true);
        return this._cancellable;
    }

    _end(cancellable) {
        if (this._cancellable !== cancellable)
            return;
        this._cancellable = null;
        this._panel?.setBusy(false);
    }

    async _stream(turn, cancellable) {
        try {
            let answer;
            try {
                answer = await this._ask(turn, cancellable);
            } catch (e) {
                if (!(e instanceof ContextTooLongError) || Chat.getTurns().length < 2 || cancellable.is_cancelled())
                    throw e;
                Chat.keepOnly(turn);
                this._panel.renderTurns(Chat.getTurns());
                this._panel.showNotice('Earlier messages were cleared to fit the length limit.');
                answer = await this._ask(turn, cancellable);
            }
            if (!answer)
                turn.error = 'The model returned an empty answer.';
        } catch (e) {
            if (e instanceof ContextTooLongError)
                turn.error = 'This message is too long to send. Shorten it and try again.';
            else if (!isCancelled(e))
                turn.error = e.message;
            else if (!turn.answer)
                turn.error = 'Stopped.';
        } finally {
            turn.done = true;
            this._end(cancellable);
            this._panel?.updateTurn(turn, {immediate: true});
        }
    }

    _ask(turn, cancellable) {
        const messages = Chat.buildMessages(Prompts.systemPrompt(this._settings.get_string('custom-instructions')));
        return this._client.complete(messages, {
            reasoningEffort: this._settings.get_string('reasoning-effort'),
            cancellable,
            onText: text => {
                turn.answer = text;
                this._panel?.updateTurn(turn);
            },
        });
    }

    replaceSelection(turn) {
        this._panel.close();
        this._paster.paste(pasteText(turn.answer, turn.selection));
    }

    replaceFromLookup(answer) {
        const original = this._lookup.subject?.raw;
        this._lookup.close({animate: false});
        this._paster.paste(pasteText(answer, original));
    }

    // Look Up card

    /** Explains whatever was selected or copied last: a word, a passage or an image. */
    async explainSelection() {
        // A modal grab keeps the focused app from serving the clipboard, and
        // makes the next paste's focus window close immediately.
        this._panel.unfocus();
        const found = await Capture.readSelectionOrClipboard(this._tracker);
        this._showCard(found, 'ask-selection', 'Explain');
    }

    /** Dictionary-style look up of the selected text, with words defined by the offline dictionary. */
    async lookUp() {
        this._panel.unfocus();
        const found = await Capture.readSelectionOrClipboard(this._tracker, {allowImage: false});
        this._showCard(found, 'look-up', 'Look Up', {offline: true});
    }

    _showCard(found, shortcutKey, title, {offline = false} = {}) {
        if (!this._lookup)
            return;
        if (!found) {
            const accel = accelLabel(this._settings.get_strv(shortcutKey)[0]);
            this._lookup.openHint(title, `Select or copy something in any app, then press **${accel}**.`);
            return;
        }

        let subject;
        if (found.image) {
            subject = {kind: 'image', image: found.image};
        } else {
            const text = found.text.slice(0, MAX_LOOKUP_CHARS);
            const term = text.split(/\s+/).length <= TERM_WORDS && text.length <= TERM_CHARS;
            subject = {kind: term ? 'term' : 'text', text, raw: found.raw, source: found.source, offline};
        }
        this._lookup.open(subject);
        this.runLookup(subject.kind === 'term' ? 'define' : 'explain').catch(logError);
    }

    /** Looks up a word clicked in the card, e.g. a synonym. */
    lookUpWord(word) {
        const offline = this._lookup.subject?.offline ?? false;
        this._lookup.navigate({kind: 'term', text: word, raw: word, source: 'lookup', offline});
        this.runLookup('define').catch(logError);
    }

    openUri(uri) {
        this._lookup.close({animate: false});
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(e, `Penguin couldn’t open ${uri}`);
        }
    }

    cancelLookup() {
        this._lookupCancellable?.cancel();
        this._lookupCancellable = null;
    }

    async runLookup(mode) {
        const subject = this._lookup.subject;
        if (!subject)
            return;
        this.cancelLookup();
        const cancellable = new Gio.Cancellable();
        this._lookupCancellable = cancellable;
        this._lookup.setMode(mode);

        try {
            if (mode === 'wikipedia') {
                await this._showWikipedia(subject.text, cancellable);
                return;
            }
            if (mode === 'define' && subject.offline) {
                await this._showOfflineEntry(subject.text, cancellable);
                return;
            }
            const {messages, effort} = await this._lookupRequest(mode, subject);
            if (cancellable.is_cancelled())
                return;
            await this._client.complete(messages, {
                reasoningEffort: effort,
                cancellable,
                onText: text => {
                    if (!cancellable.is_cancelled())
                        this._lookup.setText(text);
                },
            });
        } catch (e) {
            if (!isCancelled(e) && !cancellable.is_cancelled())
                this._lookup.setError(e.message);
        } finally {
            if (this._lookupCancellable === cancellable) {
                this._lookupCancellable = null;
                this._lookup?.setDone({
                    replaceable: subject.kind === 'text' && subject.source === 'primary' &&
                        REPLACEABLE_MODES.has(mode),
                });
            }
        }
    }

    async _showOfflineEntry(term, cancellable) {
        const entry = await this._dictionary.define(term, cancellable);
        if (cancellable.is_cancelled())
            return;
        if (entry) {
            this._lookup.setText(entry);
            return;
        }
        const accel = accelLabel(this._settings.get_strv('ask-selection')[0]);
        this._lookup.setText(`NONE: “${term.replace(/\s+/g, ' ').trim()}” isn’t in the offline dictionary.` +
            (accel ? ` Press ${accel} to ask Penguin.` : ''));
    }

    async _showWikipedia(term, cancellable) {
        const title = encodeURIComponent(term.trim().replace(/\s+/g, '_'));
        const page = await this._client.getJson(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, cancellable);
        if (cancellable.is_cancelled())
            return;
        if (!page?.extract) {
            this._lookup.setError(`Wikipedia has no article on “${term}”.`);
            return;
        }
        this._lookup.setWikipedia({
            description: page.type === 'disambiguation' ? 'Several articles match this.' : page.description,
            extract: page.extract,
            url: page.content_urls?.desktop?.page ?? null,
        });

        const image = page.thumbnail?.source;
        if (!image)
            return;
        try {
            const bytes = await this._client.getBytes(image, cancellable);
            if (!bytes)
                return;
            const content = await Capture.imageContentFromBytes(bytes, 84);
            if (!cancellable.is_cancelled())
                this._lookup.setWikipediaImage(content);
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`Penguin: couldn’t load the Wikipedia image: ${e.message}`);
        }
    }

    async _lookupRequest(mode, subject) {
        const term = subject.text;
        const translateLanguage = this._settings.get_string('translate-language');
        const quoted = () => `"""\n${term}\n"""`;

        if (subject.kind === 'image') {
            const {dataUrl} = await subject.image;
            const prompt = mode === 'text'
                ? Prompts.IMAGE_ACTIONS.find(a => a.id === 'text').prompt
                : 'Explain this image.';
            return {
                effort: 'low',
                messages: [
                    {role: 'system', content: Prompts.EXPLAIN_SYSTEM_PROMPT},
                    {role: 'user', content: [
                        {type: 'text', text: prompt},
                        {type: 'image_url', image_url: {url: dataUrl}},
                    ]},
                ],
            };
        }

        switch (mode) {
        case 'explain':
            return {
                effort: 'low',
                messages: [
                    {role: 'system', content: Prompts.EXPLAIN_SYSTEM_PROMPT},
                    {role: 'user', content: term},
                ],
            };
        case 'summarize':
        case 'fix':
        case 'rewrite':
        case 'translate': {
            const action = Prompts.textActions(translateLanguage).find(a => a.id === mode);
            return {effort: 'none', messages: [{role: 'user', content: `${action.prompt}\n\n${quoted()}`}]};
        }
        case 'thesaurus':
            return {
                effort: 'none',
                messages: [
                    {role: 'system', content: Prompts.THESAURUS_SYSTEM_PROMPT},
                    {role: 'user', content: term},
                ],
            };
        case 'context': {
            this._lookup.hideForCapture();
            let grab;
            try {
                grab = await Capture.grabMonitor(global.display.get_current_monitor());
            } finally {
                this._lookup?.restoreAfterCapture();
            }
            const image = await Capture.encodeGrab(grab);
            return {
                effort: 'low',
                messages: [
                    {role: 'system', content: Prompts.EXPLAIN_SYSTEM_PROMPT},
                    {role: 'user', content: [
                        {type: 'text', text: Prompts.inContextMessage(term)},
                        {type: 'image_url', image_url: {url: image.dataUrl}},
                    ]},
                ],
            };
        }
        default:
            return {
                effort: 'none',
                messages: [
                    {role: 'system', content: Prompts.DICTIONARY_SYSTEM_PROMPT},
                    {role: 'user', content: term},
                ],
            };
        }
    }
}

/**
 * The text to paste over a selection: a lone code block is unwrapped, and the
 * whitespace around the original selection (e.g. a leading blank line) is kept.
 */
function pasteText(answer, original = '') {
    const blocks = Markdown.splitBlocks(answer);
    const text = blocks.length === 1 && blocks[0].type === 'code'
        ? blocks[0].text.trim()
        : answer.trim();
    const source = original ?? '';
    const leading = source.match(/^\s*/)[0];
    const trailing = source.trim() ? source.match(/\s*$/)[0] : '';
    return `${leading}${text}${trailing}`;
}
