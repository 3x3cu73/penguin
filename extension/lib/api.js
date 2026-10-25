import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.File.prototype, 'read_async');

/** Penguin's hosted free tier. Each install sends its own random key, made on first use. */
export const FREE_TIER_URL = 'https://penguin.zenbleed.tech/v1';
export const FREE_TIER_MODEL = 'gemma4';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let pendingKey = null;

// Not every OpenAI-compatible server knows these; they are dropped and the
// request retried once if a 400 response names them.
const OPTIONAL_PARAMS = ['verbosity', 'reasoning_effort'];

// The free tier answers 413 when a conversation is too long, as nginx does for
// oversized bodies; OpenAI-style servers answer 400 with wording like this.
const TOO_LONG = /context_length_exceeded|context length|context window|maximum context|too many tokens|reduce the length/i;

/** The conversation is longer than the API accepts. */
export class ContextTooLongError extends Error {}

export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class ChatClient {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({
            timeout: 120,
            user_agent: 'Penguin (GNOME Shell)',
        });
    }

    destroy() {
        this._session.abort();
    }

    get _allowInsecure() {
        return this._settings.get_boolean('allow-insecure-tls');
    }

    // When the user is behind an intercepting proxy (Burp) or a captive/campus
    // network, the peer certificate won't validate; this opts into accepting it.
    _message(method, url) {
        const message = Soup.Message.new(method, url);
        if (!message)
            throw new Error(`“${url}” is not a valid URL.`);
        if (this._allowInsecure)
            message.connect('accept-certificate', () => true);
        return message;
    }

    /** Fetches a URL; resolves to null on 404. */
    async getBytes(url, cancellable = null) {
        const message = this._message('GET', url);
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (status === 404)
            return null;
        if (status < 200 || status >= 300)
            throw new Error(`${hostOf(url)} returned ${status}.`);
        return bytes;
    }

    async getJson(url, cancellable = null) {
        const bytes = await this.getBytes(url, cancellable);
        return bytes ? JSON.parse(decoder.decode(bytes.toArray())) : null;
    }

    /**
     * Streams a chat completion.
     *
     * @param {object[]} messages - OpenAI chat messages
     * @param {object} options
     * @param {string} options.reasoningEffort - none, minimal, low, medium or high
     * @param {Function} options.onText - called with the full text so far
     * @param {Gio.Cancellable} options.cancellable
     * @returns {Promise<string>} the complete answer
     */
    async complete(messages, {reasoningEffort = 'low', onText = () => {}, cancellable = null} = {}) {
        const free = this._settings.get_boolean('use-free-tier');
        const base = free ? FREE_TIER_URL : this._settings.get_string('api-base-url').trim().replace(/\/+$/, '');
        const model = free ? FREE_TIER_MODEL : this._settings.get_string('model').trim();
        const key = free ? await freeTierKey(this._settings) : this._settings.get_string('api-key').trim();
        if (!base)
            throw new Error('No API URL yet. Add one in Penguin preferences, or switch to the free tier.');
        if (!key)
            throw new Error('No API key yet. Add one in Penguin preferences, or switch to the free tier.');

        const payload = {
            model,
            messages,
            stream: true,
            reasoning_effort: reasoningEffort,
            verbosity: 'low',
        };

        for (let attempt = 0; ; attempt++) {
            const message = this._message('POST', `${base}/chat/completions`);
            message.request_headers.append('Authorization', `Bearer ${key}`);
            message.request_headers.append('Accept', 'text/event-stream');
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(encoder.encode(JSON.stringify(payload))));

            let input;
            try {
                input = await this._session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                throw new Error(networkError(hostOf(base), e, this._allowInsecure));
            }

            const status = message.get_status();
            if (status >= 200 && status < 300)
                return this._readEvents(input, onText, cancellable);

            const body = await readAll(input, cancellable);
            const rejected = OPTIONAL_PARAMS.filter(p => p in payload && body.includes(p));
            if (status === 400 && rejected.length > 0 && attempt === 0) {
                rejected.forEach(p => delete payload[p]);
                continue;
            }
            const description = describeError(status, message.get_reason_phrase(), body);
            if (status === 413 || (status === 400 && TOO_LONG.test(body)))
                throw new ContextTooLongError(description);
            throw new Error(description);
        }
    }

    async _readEvents(input, onText, cancellable) {
        const lines = new Gio.DataInputStream({
            base_stream: input,
            close_base_stream: true,
            newline_type: Gio.DataStreamNewlineType.ANY,
        });
        let text = '';
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [raw] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (raw === null)
                    break;
                const line = decoder.decode(raw);
                if (!line.startsWith('data:'))
                    continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]')
                    break;

                let event;
                try {
                    event = JSON.parse(data);
                } catch {
                    continue;
                }
                if (event.error)
                    throw new Error(event.error.message ?? String(event.error));

                const delta = event.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta.length > 0) {
                    text += delta;
                    onText(text);
                }
            }
        } finally {
            lines.close_async(GLib.PRIORITY_DEFAULT, null, null);
        }
        return text;
    }
}

/** This install's free-tier key, made and saved on first use; concurrent first requests share one. */
function freeTierKey(settings) {
    const saved = settings.get_string('free-tier-key');
    if (saved)
        return Promise.resolve(saved);
    pendingKey ??= (async () => {
        const stream = await Gio.File.new_for_path('/dev/urandom').read_async(GLib.PRIORITY_DEFAULT, null);
        const bytes = await stream.read_bytes_async(32, GLib.PRIORITY_DEFAULT, null);
        stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
        if (bytes.get_size() < 32)
            throw new Error('Couldn’t make a key for the free tier.');
        const random = GLib.base64_encode(bytes.toArray()).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const key = `pg-${random}`;
        settings.set_string('free-tier-key', key);
        return key;
    })().finally(() => {
        pendingKey = null;
    });
    return pendingKey;
}

async function readAll(input, cancellable) {
    const chunks = [];
    let size = 0;
    try {
        while (size < 65536) {
            // eslint-disable-next-line no-await-in-loop
            const bytes = await input.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, cancellable);
            if (bytes.get_size() === 0)
                break;
            chunks.push(bytes.toArray());
            size += bytes.get_size();
        }
    } catch (e) {
        if (isCancelled(e))
            throw e;
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
    }
    return decoder.decode(all);
}

function hostOf(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() ?? url;
    } catch {
        return url;
    }
}

function networkError(host, error, allowInsecure) {
    const message = error.message ?? String(error);
    if (/certificate|TLS/i.test(message) && !allowInsecure) {
        return `Can’t verify ${host}’s security certificate. If you’re on an intercepting proxy ` +
            '(like Burp) or a campus/captive network, turn on “Allow insecure TLS certificates” ' +
            'in Penguin preferences.';
    }
    return `Can’t reach ${host}. ${message}`;
}

function describeError(status, reason, body) {
    let detail = '';
    try {
        const json = JSON.parse(body);
        detail = json.error?.message ?? json.detail ?? json.message ?? '';
        if (typeof detail !== 'string')
            detail = JSON.stringify(detail);
    } catch {
        detail = body;
    }
    detail = detail.replace(/\s+/g, ' ').trim().slice(0, 240);

    const summary = {
        401: 'The API key was rejected.',
        403: 'Access denied.',
        404: 'The API URL or model wasn’t found.',
        413: 'The request was too large.',
        429: 'Limit reached.',
        503: 'The AI service is unavailable right now.',
    }[status] ?? (status >= 500
        ? `The AI server had a problem (${status}).`
        : `Request failed (${status} ${reason ?? ''}).`);
    return detail ? `${summary} ${detail}` : summary;
}
