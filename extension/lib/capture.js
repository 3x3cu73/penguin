import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

const MAX_EDGE = 2048;
const THUMBNAIL_HEIGHT = 56;
const MAX_TEXT = 100000;

// Survives disable/enable like the chat does.
const lastChange = {primary: 0, clipboard: 0};

/**
 * Remembers which of PRIMARY (selected) and CLIPBOARD (copied) changed last,
 * so "ask about selection" uses whatever the user touched most recently.
 */
export class SelectionTracker {
    constructor() {
        this._selection = global.display.get_selection();
        this._idleId = 0;
        this._id = this._selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_PRIMARY)
                lastChange.primary = GLib.get_monotonic_time();
            else if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                lastChange.clipboard = GLib.get_monotonic_time();
        });
    }

    get clipboardIsNewer() {
        return lastChange.clipboard > lastChange.primary;
    }

    // Shortcut handlers run inside a grab. Starting a selection transfer there makes
    // Mutter cancel it when the grab ends ("Could not fetch selection data: Broken
    // pipe"), which drops the clipboard the next paste tries to read. Wait until
    // this handler has returned and the grab is gone.
    afterShortcutGrab() {
        return new Promise(resolve => {
            if (this._idleId)
                GLib.source_remove(this._idleId);
            this._idleId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idleId = 0;
                resolve();
            });
        });
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._selection.disconnect(this._id);
    }
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];

export function readText(type) {
    return new Promise(resolve => {
        St.Clipboard.get_default().get_text(type, (_clipboard, text) =>
            resolve((text ?? '').slice(0, MAX_TEXT)));
    });
}

function mimetypes(type) {
    return St.Clipboard.get_default().get_mimetypes(type) ?? [];
}

function offersText(types) {
    return types.some(mime => {
        const name = mime.split(';')[0].trim().toLowerCase();
        return name.startsWith('text/') || name === 'utf8_string' || name === 'string' || name === 'text';
    });
}

function readImageBytes(type, mimetype) {
    return new Promise(resolve => {
        // The GBytes is only valid during the callback, so copy it before resolving.
        St.Clipboard.get_default().get_content(type, mimetype, (_clipboard, bytes) =>
            resolve(bytes && bytes.get_size() > 0 ? new GLib.Bytes(bytes.toArray()) : null));
    });
}

/**
 * Reads the clipboard once. An image-only clipboard is left untouched unless
 * the caller asked for an image: requesting text/plain from it cancels the
 * image, so a later paste finds nothing.
 *
 * @param {boolean} allowImage
 */
async function readClipboard(allowImage) {
    const type = St.ClipboardType.CLIPBOARD;
    const types = mimetypes(type);
    const imageType = IMAGE_MIMES.find(mime => types.includes(mime));
    if (allowImage && imageType) {
        const bytes = await readImageBytes(type, imageType);
        if (bytes)
            return {image: imageFromBytes(bytes)};
        if (!offersText(types))
            return null;
    } else if (types.length > 0 && !offersText(types)) {
        return null;
    }

    const copied = await readText(type);
    return copied.trim() ? {text: copied.trim(), raw: copied, source: 'clipboard'} : null;
}

/**
 * Reads what the user most recently selected or copied.
 * One selection is transferred, and only after the shortcut grab has ended.
 *
 * @param {SelectionTracker} tracker
 * @param {object} options
 * @param {boolean} options.allowImage
 * @returns {Promise<?{text?: string, source?: string, image?: Promise<object>}>}
 */
export async function readSelectionOrClipboard(tracker, {allowImage = true} = {}) {
    await tracker.afterShortcutGrab();

    if (!tracker.clipboardIsNewer) {
        const primary = await readText(St.ClipboardType.PRIMARY);
        if (primary.trim())
            return {text: primary.trim(), raw: primary, source: 'primary'};
    }

    const copied = await readClipboard(allowImage);
    if (copied)
        return copied;

    if (!tracker.clipboardIsNewer)
        return null;
    const primary = await readText(St.ClipboardType.PRIMARY);
    return primary.trim() ? {text: primary.trim(), raw: primary, source: 'primary'} : null;
}

/**
 * Grabs the current frame of one monitor, without the cursor. This is quick;
 * callers hide their own UI first and can show it again once this resolves.
 *
 * @param {number} monitorIndex
 */
export async function grabMonitor(monitorIndex) {
    const monitor = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
    const shooter = new Shell.Screenshot();
    const [content, scale] = await shooter.screenshot_stage_to_content();
    return {texture: content.get_texture(), scale, monitor};
}

/**
 * Turns a grab into a downscaled JPEG data URL plus a thumbnail.
 *
 * @returns {Promise<{dataUrl: string, thumbnail: St.ImageContent, width: number, height: number}>}
 */
export async function encodeGrab({texture, scale, monitor}) {
    const png = Gio.MemoryOutputStream.new_resizable();
    const pixbuf = await Shell.Screenshot.composite_to_stream(texture,
        monitor.x * scale, monitor.y * scale, monitor.width * scale, monitor.height * scale,
        scale, null, 0, 0, 1, png);
    png.close(null);
    return encodeImage(pixbuf);
}

async function imageFromBytes(bytes) {
    const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(
        Gio.MemoryInputStream.new_from_bytes(bytes), null);
    return encodeImage(pixbuf.apply_embedded_orientation() ?? pixbuf);
}

async function encodeImage(pixbuf) {
    const ratio = Math.min(1, MAX_EDGE / Math.max(pixbuf.width, pixbuf.height));
    let image = pixbuf;
    if (pixbuf.has_alpha || ratio < 1) {
        // The JPEG encoder rejects alpha, so composite onto an opaque RGB buffer while scaling.
        const width = Math.max(1, Math.round(pixbuf.width * ratio));
        const height = Math.max(1, Math.round(pixbuf.height * ratio));
        image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
        image.fill(0xffffffff);
        pixbuf.composite(image, 0, 0, width, height, 0, 0,
            width / pixbuf.width, height / pixbuf.height, GdkPixbuf.InterpType.BILINEAR, 255);
    }

    const jpeg = await encodeJpeg(image);
    return {
        dataUrl: `data:image/jpeg;base64,${GLib.base64_encode(jpeg.toArray())}`,
        thumbnail: makeThumbnail(image),
        width: image.width,
        height: image.height,
    };
}

// Encodes in a worker thread so large screenshots don't stall the compositor.
function encodeJpeg(pixbuf) {
    return new Promise((resolve, reject) => {
        const stream = Gio.MemoryOutputStream.new_resizable();
        pixbuf.save_to_streamv_async(stream, 'jpeg', ['quality'], ['85'], null, (_pixbuf, result) => {
            try {
                GdkPixbuf.Pixbuf.save_to_stream_finish(result);
                stream.close(null);
                resolve(stream.steal_as_bytes());
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Decodes downloaded image bytes into St content of the given logical height. */
export async function imageContentFromBytes(bytes, logicalHeight) {
    const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(
        Gio.MemoryInputStream.new_from_bytes(bytes), null);
    return makeThumbnail(pixbuf, logicalHeight);
}

function makeThumbnail(pixbuf, logicalHeight = THUMBNAIL_HEIGHT) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const height = logicalHeight * scale;
    const width = Math.max(1, Math.round(pixbuf.width * height / pixbuf.height));
    const small = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);

    const content = St.ImageContent.new_with_preferred_size(
        Math.round(width / scale), logicalHeight);
    content.set_bytes(
        global.stage.context.get_backend().get_cogl_context(),
        small.read_pixel_bytes(),
        small.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        width, height, small.rowstride);
    return content;
}
