#!/usr/bin/env python3
"""Installs the offline dictionary that Look Up uses (no root needed).

Downloads Open English WordNet (CC BY 4.0, https://en-word.net) and splits it
into small JSON files that extension/lib/wordnet.js reads on demand.

  ./install-dictionary.py    download (~11 MB) and install into ~/.local/share/penguin/dictionary
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

URL = ('https://github.com/globalwordnet/english-wordnet/releases/download/'
       '2025-edition/english-wordnet-2025-plus-json.zip')
NAME = 'Open English WordNet 2025+'
SHARDS = 1024
# British first, like the AI dictionary.
VARIETIES = ('GB', None, 'US')


def shard_of(key):
    # 32-bit FNV-1a of the UTF-8 key; must match shardOf() in extension/lib/wordnet.js.
    h = 0x811C9DC5
    for byte in key.encode():
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return h % SHARDS


def clean(text):
    return re.sub(r'\s+', ' ', text).strip()


def pronunciation(entry):
    sounds = entry.get('pronunciation', [])
    for variety in VARIETIES:
        for sound in sounds:
            if sound.get('variety') == variety:
                return sound['value'].replace('.', '')
    return sounds[0]['value'].replace('.', '') if sounds else None


def example(synset, lemma):
    """The first example that uses the word itself, not one of its synonyms."""
    texts = [clean(x if isinstance(x, str) else x['text']) for x in synset.get('example', [])]
    return next((t for t in texts if lemma.lower() in t.lower()), texts[0] if texts else None)


def load(archive):
    entries, synsets = {}, {}
    for name in archive.namelist():
        if not name.endswith('.json'):
            continue
        data = json.load(archive.open(name))
        if Path(name).name.startswith('entries-'):
            entries.update(data)
        elif all(isinstance(value, dict) for value in data.values()):
            synsets.update(data)
    return entries, synsets


def build(entries, synsets):
    """Maps each lower-case headword to its word classes ('g') and, for an
    irregular form like 'geese', to the headwords it inflects ('b')."""
    lemma_of = {sense['id']: lemma
                for lemma, kinds in entries.items()
                for entry in kinds.values()
                for sense in entry['sense']}
    records = defaultdict(lambda: {'g': [], 'b': []})

    for lemma, kinds in entries.items():
        for kind, entry in kinds.items():
            pos = 'a' if kind[0] == 's' else kind[0]
            senses = []
            for sense in entry['sense']:
                synset = synsets[sense['synset']]
                definition = clean(synset['definition'][0])
                item = {'d': definition if definition.endswith(('.', '!', '?')) else definition + '.'}
                if text := example(synset, lemma):
                    item['x'] = text
                if synonyms := [m for m in synset['members'] if m.lower() != lemma.lower() and ',' not in m]:
                    item['y'] = synonyms
                if opposites := list(dict.fromkeys(lemma_of[a] for a in sense.get('antonym', []) if a in lemma_of)):
                    item['o'] = opposites
                senses.append(item)

            group = {'l': lemma, 'p': pos, 's': senses}
            if sound := pronunciation(entry):
                group['i'] = sound
            records[lemma.lower()]['g'].append(group)
            for form in entry.get('form', []):
                base = records[form.lower()]['b']
                if [lemma, pos] not in base:
                    base.append([lemma, pos])

    for key, record in records.items():
        record['g'].sort(key=lambda g: (g['l'] != key, -len(g['s'])))
        # Spellings that share every sense, like "A.M." and "a.m.", are shown once.
        seen = set()
        unique = []
        for group in record['g']:
            senses = (group['p'], tuple(s['d'] for s in group['s']))
            if senses not in seen:
                seen.add(senses)
                unique.append(group)
        record['g'] = unique
    return records


def install(records, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.dictionary-', dir=target.parent))
    try:
        shards = defaultdict(dict)
        for key, record in records.items():
            shards[shard_of(key)][key] = {k: v for k, v in record.items() if v}
        for index in range(SHARDS):
            with open(staging / f'{index}.json', 'w', encoding='utf-8') as f:
                json.dump(shards[index], f, ensure_ascii=False, separators=(',', ':'))
        info = {'name': NAME, 'license': 'CC BY 4.0', 'url': 'https://en-word.net/', 'shards': SHARDS}
        (staging / 'info.json').write_text(json.dumps(info, indent=2) + '\n')

        old = target.with_name(target.name + '.old')
        shutil.rmtree(old, ignore_errors=True)
        if target.exists():
            target.rename(old)
        staging.rename(target)
        shutil.rmtree(old, ignore_errors=True)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main():
    data_home = os.environ.get('XDG_DATA_HOME') or Path.home() / '.local' / 'share'
    target = Path(data_home) / 'penguin' / 'dictionary'

    print(f'Downloading {NAME}…')
    try:
        with urllib.request.urlopen(URL, timeout=60) as response:
            data = response.read()
    except OSError as e:
        sys.exit(f'Couldn’t download {NAME}: {e}')

    print('Building the offline dictionary…')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries, synsets = load(archive)
    install(build(entries, synsets), target)
    print(f'Installed the offline dictionary in {target}.')


if __name__ == '__main__':
    main()
