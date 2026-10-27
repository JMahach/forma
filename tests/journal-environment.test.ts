import test from 'node:test';
import assert from 'node:assert/strict';
import { journalEnvironment } from '../server/runtime/journal-environment.ts';
test('journal uses a distinct zone and an explicit environment independent of release assets',()=>{
 assert.deepEqual(journalEnvironment({},'/state/forma'),{directory:'/state/forma/journal',environment:'stand'});
 assert.deepEqual(journalEnvironment({FORMA_JOURNAL_DIR:'/var/log/forma',FORMA_ENVIRONMENT:'production'},'/state/forma'),{directory:'/var/log/forma',environment:'production'});
 for(const directory of ['relative','/','/state/forma']){
  assert.throws(()=>journalEnvironment({FORMA_JOURNAL_DIR:directory},'/state/forma'));
 }
 assert.throws(()=>journalEnvironment({FORMA_ENVIRONMENT:'prod'},'/state/forma'));
});
test('the journal archive and pending buffer cannot contain the account database zone',()=>{
 for(const stateDir of ['/state/forma/archive','/state/forma/archive/accounts','/state/forma/mail-pending','/state/forma/mail-pending/accounts']){
  assert.throws(()=>journalEnvironment({FORMA_JOURNAL_DIR:'/state/forma'},stateDir),stateDir);
 }
 assert.doesNotThrow(()=>journalEnvironment({FORMA_JOURNAL_DIR:'/state/forma'},'/state/formal/archive'));
});
