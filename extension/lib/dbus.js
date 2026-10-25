import Gio from 'gi://Gio';

export const OBJECT_PATH = '/io/github/sumit/Penguin';

const INTERFACE = `
<node>
  <interface name="io.github.sumit.Penguin">
    <method name="Toggle"/>
    <method name="Open"/>
    <method name="Ask">
      <arg type="s" name="question" direction="in"/>
    </method>
    <method name="AskScreen"/>
    <method name="AskSelection"/>
    <method name="LookUp"/>
    <method name="NewChat"/>
  </interface>
</node>`;

/** Lets the `penguin` CLI and the app launcher drive the assistant. */
export class PenguinDBus {
    constructor(assistant) {
        this._assistant = assistant;
        this._object = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        this._object.export(Gio.DBus.session, OBJECT_PATH);
    }

    Toggle() {
        this._assistant.toggle();
    }

    Open() {
        this._assistant.open();
    }

    Ask(question) {
        this._assistant.ask(question);
    }

    AskScreen() {
        this._assistant.askAboutScreen().catch(logError);
    }

    AskSelection() {
        this._assistant.explainSelection().catch(logError);
    }

    LookUp() {
        this._assistant.lookUp().catch(logError);
    }

    NewChat() {
        this._assistant.newChat();
    }

    destroy() {
        this._object.unexport();
    }
}
