#!/usr/bin/env python3
"""Build/check only the two game-only distribution ZIPs, never payout code.

Run from any directory after the Node 22 review/build and export checks.
The exact allowlists deliberately exclude data, generated dependencies, .wrangler,
pass contract sources, email/campaign candidates and the unfinished CHOG vault.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
workspace = root.parent
archives = {
    'CHOGPIT_NFT_First_Cloudflare_Update.zip': (
        'CHOGPIT_Cloudflare_Free_Deploy', '''
        DEPLOY.md live-rooms.mjs package-lock.json package.json
        public/app.js public/arena-world.js public/assets/chog1.jpg
        public/assets/chogbadge.jpg public/audio.js public/game.js
        public/index.html public/style.css scripts/smoke.mjs worker.mjs
        wrangler.jsonc ws-shim.mjs
        '''.split(), 'export_cloudflare_game.mjs'
    ),
    'CHOGPIT_NFT_First_Node_Backup.zip': (
        'CHOGPIT_Game_Only_Deploy', '''
        .gitignore .node-version README.md live-rooms.mjs oracle/Caddyfile
        oracle/DEPLOY.md oracle/chogpit.service oracle/install-on-ubuntu.sh
        package-lock.json package.json public/app.js public/arena-world.js
        public/assets/chog1.jpg public/assets/chogbadge.jpg public/audio.js
        public/game.js public/index.html public/style.css render.yaml
        scripts/smoke.mjs server.mjs
        '''.split(), 'export_game_only.mjs'
    )
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(archive, source, names):
    with ZipFile(archive) as bundle:
        actual = bundle.namelist()
        if actual != sorted(names):
            raise RuntimeError(f'{archive.name}: ZIP allowlist/order differs: {actual!r}')
        bad = bundle.testzip()
        if bad is not None:
            raise RuntimeError(f'{archive.name}: corrupt ZIP entry {bad}')
        for name in actual:
            real = (source / name).read_bytes()
            if bundle.read(name) != real:
                raise RuntimeError(f'{archive.name}: bytes differ from current export: {name}')
    print(f'PASS: {archive.name} · {len(names)} exact allowlisted files · SHA-256 {digest(archive.read_bytes())}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='read-only ZIP versus export verification')
    args = parser.parse_args()
    for filename, (folder, names, export_check) in archives.items():
        source, archive = workspace / folder, workspace / filename
        names = sorted(names)
        # Check the generated export against the reviewed source before relying on it.
        subprocess.run(['node', str(root / 'scripts' / export_check), '--check'],
                       cwd=root, check=True)
        for name in names:
            path = source / name
            if not path.is_file() or path.is_symlink():
                raise RuntimeError(f'Missing or symlinked allowed source: {path}')
        if args.check:
            verify(archive, source, names)
            continue
        temp = archive.with_name(archive.name + '.tmp')
        try:
            with ZipFile(temp, 'w') as bundle:
                for name in names:
                    entry = ZipInfo(name, (2026, 10, 19, 0, 0, 0))
                    entry.compress_type = ZIP_DEFLATED
                    entry.create_system = 3
                    entry.external_attr = 0o100644 << 16
                    bundle.writestr(entry, (source / name).read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
            os.replace(temp, archive)
        finally:
            temp.unlink(missing_ok=True)
        verify(archive, source, names)


if __name__ == '__main__':
    main()
