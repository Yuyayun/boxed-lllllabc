import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Text, nativeChatHash } from '../src/backup/native-content.js';
import { createPendingObserver, recoverPendingJournal } from '../src/backup/pending-journal.js';

test('portable SHA-256 matches Node for padding, UTF-8 and long inputs', () => {
  for (const text of ['', 'abc', '中文🙂', ...[55,56,63,64,65,128,10000].map(n => 'x'.repeat(n))]) {
    assert.equal(sha256Text(text), createHash('sha256').update(text).digest('hex'));
  }
});
const messages = text => [...text].map(mes => ({ mes }));
function observer(text = 'ABCDE') {
  const current = { ok: true, chat: messages(text), identity: { chatKey: 'chat:A', meta: {} } };
  const watcher = createPendingObserver({ readCurrent: () => current });
  watcher.reset();
  return { current, watcher };
}
for (const [name, start, count] of [['last',4,1],['middle',1,1],['multiple',1,2],['tail',2,3],['all',0,5]]) {
  test(`capture ${name} deletion independently of the emitted remaining length`, () => {
    const { current, watcher } = observer();
    const before = structuredClone(current.chat);
    current.chat.splice(start, count);
    const captured = watcher.capture({ eventName: 'message_deleted', args: [current.chat.length] });
    const root = captured.records.find(row => row.pendingType === 'operation');
    assert.equal(root.deleteStartIndex, start); assert.equal(root.deleteCount, count);
    assert.equal(root.beforeLength, 5); assert.equal(root.afterLength, current.chat.length);
    const result = recoverPendingJournal({ chat: before, chatKey: 'chat:A', records: captured.records });
    assert.equal(result.ok, true); assert.deepEqual(result.targetChat, current.chat);
  });
}
test('delete, edit and append within one debounce retain immutable ordered payloads', () => {
  const { current, watcher } = observer();
  const before = structuredClone(current.chat), records = [];
  current.chat.splice(1,2);
  records.push(...watcher.capture({ eventName:'message_deleted',args:[3] }).records);
  current.chat[1].mes = 'D edited';
  records.push(...watcher.capture({ eventName:'message_edited',args:[1] }).records);
  current.chat.push({ mes:'F' });
  records.push(...watcher.capture({ eventName:'message_received',args:[3] }).records);
  assert.equal(new Set(records.map(row => row.id)).size, records.length);
  const target = structuredClone(current.chat);
  current.chat[1].mes = 'later';
  const recovered = recoverPendingJournal({ chat: before, chatKey:'chat:A',records });
  assert.equal(recovered.ok,true); assert.deepEqual(recovered.targetChat,target);
});
test('already persisted delete is never applied twice', () => {
  const { current, watcher } = observer(); current.chat.splice(1,2);
  const records = watcher.capture({ eventName:'message_deleted',args:[3] }).records;
  const recovered = recoverPendingJournal({ chat:current.chat,chatKey:'chat:A',records });
  assert.equal(recovered.ok,true); assert.deepEqual(recovered.targetChat,messages('ADE'));
});
test('new chat and inherited parent metadata never compare against the parent observation', () => {
  const { current, watcher } = observer();
  current.identity = { chatKey:'chat:B',meta:{main_chat:'A'} }; current.chat = messages('XY');
  const captured = watcher.capture({ eventName:'chat_id_changed',args:['B'] });
  assert.deepEqual(captured.records,[]); assert.equal(captured.chatKey,'chat:B');
  current.chat.pop();
  const records=watcher.capture({eventName:'message_deleted',args:[1]}).records;
  assert(records.every(row=>row.chatKey==='chat:B'));
  assert.equal(recoverPendingJournal({chat:messages('XY'),chatKey:'chat:B',records}).ok,true);
});
test('missing observation and missed mutations never invent a pure delete', () => {
  let current={ok:true,chat:messages('AB'),identity:{chatKey:'A',meta:{}}};
  const watcher=createPendingObserver({readCurrent:()=>current});
  assert.equal(watcher.capture({eventName:'message_deleted',args:[2]}).records[0].pendingType,'observation_gap');
  watcher.reset(); current.chat[0].mes='changed without event'; current.chat.pop();
  const rows=watcher.capture({eventName:'message_deleted',args:[1]}).records;
  assert.equal(rows.find(row=>row.pendingType==='operation').kind,'message_edit');
});
test('swipe and reasoning deletions retain their message content without deleting a floor', () => {
  for(const eventName of ['message_swipe_deleted','message_reasoning_deleted']) {
    const {current,watcher}=observer('AB');
    current.chat[0].extra={reasoning:'new'};
    const rows=watcher.capture({eventName,args:[{messageId:0,swipeId:1,newSwipeId:0}]}).records;
    const op=rows.find(row=>row.pendingType==='operation');
    assert.notEqual(op.kind,'message_delete'); assert.equal(op.beforeLength,op.afterLength);
    assert.equal(recoverPendingJournal({chat:messages('AB'),chatKey:'chat:A',records:rows}).ok,true);
  }
});
test('different native fields and incompatible bases are rejected', () => {
  assert.notEqual(nativeChatHash([{mes:'same',original_avatar:'a'}]),nativeChatHash([{mes:'same',original_avatar:'b'}]));
  const {current,watcher}=observer(); current.chat.pop();
  const records=watcher.capture({eventName:'message_deleted',args:[4]}).records;
  assert.equal(recoverPendingJournal({chat:messages('XXXXX'),chatKey:'chat:A',records}).ok,false);
});
