# Penguin

An AI assistant built into GNOME Shell. Ask anything, ask about your screen or selected text, and look up words from anywhere.

It works right after install on a free tier, with no account or key. If you want more, point it at any OpenAI-compatible API and use your own key.

![Look Up explaining a word in context](screenshots/01-lookup.png)

![Asking Penguin about a selected term](screenshots/02-ask-banner.png)

![Model and connection settings](screenshots/03-prefs-general.png)

![Keyboard shortcut settings](screenshots/04-prefs-shortcuts.png)

![Appearance settings](screenshots/05-prefs-appearance.png)

## Requirements

- GNOME Shell 50

## Install

From [extensions.gnome.org](https://extensions.gnome.org) search for **Penguin Assistant**, or from this repo:

```bash
./install.sh
```

The installer copies the extension into `~/.local/share/gnome-shell/extensions`, installs the `penguin` command and a launcher, and downloads the offline dictionary that Look Up uses.

Log out and back in so GNOME Shell loads the extension, then press **Super+I** and ask something.

## Free tier

By default Penguin uses Gemma 4 through `penguin.zenbleed.tech`, a small proxy run by the author, with [Sarvam AI](https://www.sarvam.ai/) behind it. The first time you ask something, Penguin makes a random key for your install and keeps it in its settings. There is no sign-up.

The free tier has daily limits per install and per network (IP address), plus a total for everyone. They reset at midnight IST. When you hit one, Penguin says so; you can wait, or switch to your own key.

## Use your own API

Open **Extensions → Penguin Assistant → Settings** and set the API URL, key, and model of any OpenAI-compatible service, for example `https://api.openai.com/v1` with `gpt-4o`. Questions about the screen need a model that accepts images. **Free tier → Use** switches back and clears your key.

You can also set your provider when installing:

```bash
PENGUIN_API_URL=https://api.openai.com/v1 PENGUIN_MODEL=gpt-4o PENGUIN_API_KEY=sk-... ./install.sh
```

## Privacy

Penguin sends something only when you ask: your question, the text you selected or copied, and the screenshot for screen questions. They go to the API in your settings. On the free tier that is `penguin.zenbleed.tech` (behind Cloudflare), which forwards them to Sarvam AI. The free-tier server keeps the time, your IP address, your install's key id, and token counts for 31 days, to enforce the limits. It never stores your questions, answers, or screenshots.

## Shortcuts

| Action | Default |
| --- | --- |
| Open or close Penguin | Super+I |
| Ask about the screen | Shift+Super+S |
| Explain selected or copied text | not set |
| Look up the selected word | not set |
| New chat | Shift+Super+N |

The two that read your selection or clipboard start unbound; set them in Penguin's preferences. To also list Penguin's shortcuts under **Settings → Keyboard → View and Customize Shortcuts**:

```bash
./system-integration.sh
```

That step needs root once.

## Command line

```
penguin              # open or close
penguin ask …        # open and ask
penguin screen       # ask about the screen
penguin selection    # explain selection or clipboard
penguin lookup       # look up the selected word
penguin new          # start a new chat
penguin prefs        # open preferences
```

## Uninstall

```bash
./uninstall.sh           # keep settings
./uninstall.sh --purge   # also erase the API key and shortcuts
```

## Publish on extensions.gnome.org

Pack only the extension directory, not the whole repo. `gnome-extensions pack` picks up `extension.js`, `metadata.json`, `prefs.js`, `stylesheet.css`, and `schemas/`; `lib/` and `icons/` have to be named:

```bash
gnome-extensions pack extension --extra-source=lib --extra-source=icons --force -o .
```

That writes `penguin@sumit.github.io.shell-extension.zip`. Upload it at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/) (or with `gnome-extensions upload`), then add the images in `screenshots/` on the extension's page. Each new version is reviewed again against the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

An install from extensions.gnome.org is the Shell extension only. The `penguin` command, launcher, Activities search icon, and offline dictionary come from `./install.sh`.

## Develop

`dev/test-shell.sh` starts a throwaway headless GNOME Shell so you can iterate without logging out. It uses a private D-Bus and dconf and does not touch your session.

```bash
dev/test-shell.sh start
dev/test-shell.sh eval '…'
dev/test-shell.sh stop
```

## License

GPL-2.0-or-later. The offline dictionary is [Open English WordNet](https://en-word.net/), CC BY 4.0, downloaded at install time.
