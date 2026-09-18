"""Extract only regular input files; reject traversal, links and oversized bundles."""
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive, destination = sys.argv[1:]
root = Path(destination).resolve()
with tarfile.open(archive, 'r:') as source:
    members = source.getmembers()
    if len(members) > 100 or sum(m.size for m in members) > 32 * 1024 * 1024:
        raise ValueError('Sample input exceeds limits')
    names = set()
    for member in members:
        p = PurePosixPath(member.name)
        if not member.isfile() or p.is_absolute() or '..' in p.parts or '\\' in member.name or member.name in names:
            raise ValueError('Unsafe input archive')
        names.add(member.name)
    if 'input.json' not in names:
        raise ValueError('Missing input.json')
    for member in members:
        target = root / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write(source.extractfile(member).read())
