import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const APP_ID = 'io.github.sumit.Penguin.desktop';

const QUESTION = /^(what|who|whom|whose|why|how|when|where|which|is|are|was|were|can|could|should|would|will|do|does|did|define|explain|translate|summari[sz]e|tell|write|ask|penguin)\b/i;

/**
 * Adds an "Ask Penguin" row to Activities search for queries that read like
 * questions, so search doubles as a quick way to ask.
 */
export class PenguinSearchProvider {
    constructor(assistant) {
        this._assistant = assistant;
        this.id = 'penguin';
        this.appInfo = GioUnix.DesktopAppInfo.new(APP_ID);
        this.canLaunchSearch = true;
        this.isRemoteProvider = false;
    }

    _query(terms) {
        return terms.join(' ').replace(/^penguin\s+/i, '').trim();
    }

    async getInitialResultSet(terms) {
        const query = this._query(terms);
        const words = query.split(/\s+/).length;
        const asks = query.length >= 3 && (query.endsWith('?') || words >= 4 || QUESTION.test(terms.join(' ')));
        return asks ? [query] : [];
    }

    getSubsearchResultSet(_previousResults, terms) {
        return this.getInitialResultSet(terms);
    }

    async getResultMetas(ids) {
        return ids.map(id => ({
            id,
            name: 'Ask Penguin',
            description: id,
            createIcon: size => new St.Icon({gicon: this.appInfo.get_icon(), icon_size: size}),
        }));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    activateResult(id) {
        // Runs before the overview starts closing; ask once it has.
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => this._assistant.ask(id));
    }

    launchSearch(terms) {
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => this._assistant.ask(this._query(terms)));
    }

    createResultObject() {
        return null;
    }
}
