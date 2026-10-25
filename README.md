# Penguin

An AI assistant built into GNOME Shell. Ask anything, ask about your screen or selected text, and look up words from anywhere.

Works with any OpenAI-compatible API. Screen questions need a model that accepts images.

## Requirements

- GNOME Shell 50
- An API key for an OpenAI-compatible endpoint

## Install

```bash
./install.sh
```

The installer copies the extension into `~/.local/share/gnome-shell/extensions`, installs the `penguin` command, and downloads the offline dictionary used by Look Up.

If no API key is set, it will prompt for one. You can also pass it:

```bash
PENGUIN_API_KEY=sk-... ./install.sh
```

Log out and back in so GNOME Shell loads the extension. Then open **Extensions → Penguin → Settings** and set the API URL, key, and model if you did not do that during install.

Defaults are `https://api.openai.com/v1` and `gpt-4o`. Any compatible endpoint works.

## Shortcuts

| Action | Default |
| --- | --- |
| Open or close Penguin | Super+I |
| Ask about the screen | Shift+Super+S |
| Explain selected or copied text | Shift+Super+C |
| Look up the selected word | Ctrl+Super+D |
| New chat | Shift+Super+N |

Change these in Penguin preferences. To also list them under **Settings → Keyboard → View and Customize Shortcuts**:

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

Penguin can be listed on [extensions.gnome.org](https://extensions.gnome.org) like any other GNOME Shell extension. The site reviews the zip for security, not for bugs. You need a [GNOME account](https://extensions.gnome.org/accounts/login/), then upload at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/).

Pack only the extension directory (not this whole repo). `gnome-extensions pack` already picks up `extension.js`, `metadata.json`, `prefs.js`, `stylesheet.css`, and `schemas/`. The `lib/` and `icons/` trees have to be named:

```bash
gnome-extensions pack extension \
  --extra-source=lib \
  --extra-source=icons \
  --force \
  -o .
```

That writes `penguin@sumit.github.io.shell-extension.zip`. You can upload that file on the site, or:

```bash
gnome-extensions upload --accept-tos penguin@sumit.github.io.shell-extension.zip
```

An EGO install is the Shell extension only. The `penguin` command, desktop launcher, Activities search icon, and offline dictionary still come from `./install.sh` (or `./install-dictionary.py`). After an EGO install those extras are optional.

Reviewers follow the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html). For this project, expect them to look at:

- **Clipboard and screen capture.** Look Up and “explain selection” read the selection or clipboard, and screen questions send a screenshot. The description must say that. Sharing that data with an API is only allowed after the user asks (a button or a shortcut they set). The guidelines also say not to ship default shortcuts that touch the clipboard — the current Shift+Super+C / Ctrl+Super+D defaults may need to be empty for EGO, with the user binding them in preferences.
- **No secrets in the zip.** The API key stays in GSettings. Defaults are a public OpenAI URL and an empty key.
- **No extra files.** Do not pack `install.sh`, `dev/`, the dictionary download, or this README.
- **`metadata.json`.** Drop unused keys. Do not set `version`; the site assigns it. `url` should point at the public GitHub repo once it exists.
- **GPL-2.0-or-later.** Required because extensions are derived from GNOME Shell.

Add a couple of screenshots on the upload form. Updates use the same form; each new zip is reviewed again.

## Develop

`dev/test-shell.sh` starts a throwaway headless GNOME Shell so you can iterate without logging out. It uses a private D-Bus and dconf and does not touch your session.

```bash
dev/test-shell.sh start
dev/test-shell.sh eval '…'
dev/test-shell.sh stop
```

## License

GPL-2.0-or-later. The offline dictionary is [Open English WordNet](https://en-word.net/), CC BY 4.0, downloaded at install time.
