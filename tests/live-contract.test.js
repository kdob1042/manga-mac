import {test} from 'node:test';import {execFileSync} from 'node:child_process';
test('canonical Live Manga contract vendor matches locked hashes',()=>{execFileSync(process.execPath,['scripts/sync-live-contract.mjs'],{stdio:'pipe'});});
