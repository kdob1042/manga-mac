"""Query the official OSV API for every registry package in the committed lockfile.

This report complements cargo-audit. No project contents or credentials are sent.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import sys
import tomllib
import urllib.request
from pathlib import Path

lock = tomllib.loads(Path(sys.argv[1]).read_text())
packages = [p for p in lock['package'] if p.get('source', '').startswith('registry+')]
def inspect(package):
    query = {'package': {'name': package['name'], 'ecosystem': 'crates.io'}, 'version': package['version']}
    request = urllib.request.Request('https://api.osv.dev/v1/query', data=json.dumps(query).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get('vulns'):
        return {'package': package['name'], 'version': package['version'], 'advisories': result['vulns']}
    return None

with ThreadPoolExecutor(max_workers=8) as pool:
    report = [finding for finding in pool.map(inspect, packages) if finding]
Path(sys.argv[2]).write_text(json.dumps({'packages_checked': len(packages), 'findings': report}, indent=2))
print(f'OSV report: {len(packages)} packages, {len(report)} packages with findings; inspect the report alongside cargo-audit')
