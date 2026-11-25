import {createBackupCoordinator} from '../../src/controllers/backup-coordinator.js';
import {createPendingObserver,createRestoreJournal} from '../../src/backup/pending-journal.js';
import {ensureStatusLine,updateStatusLine} from '../../src/ui/status-line.js';

export function runStatusCopyContract() {
  const assert=(condition,message)=>{if(!condition)throw new Error(message);},checks=[];
  const host=document.createElement('main');host.id='status-copy-fixture';
  host.innerHTML='<div id="chat"><div class="mes"><div class="mes_block"><div class="mes_text">隔离文案夹具</div></div></div></div>';
  document.body.replaceChildren(host);
  ensureStatusLine({getDisplayMode:()=> 'message'});
  const coordinator=createBackupCoordinator({}),floor=[{id:'old-floor',messageIndex:10}],before=[{mes:'a'},{mes:'b'},{mes:'c'}];
  const current={ok:true,chat:before,identity:{chatKey:'copy-contract'}};
  const observer=createPendingObserver({readCurrent:()=>current});observer.reset();current.chat=[before[0]];
  const deleted=observer.capture({eventName:'message_deleted',args:[1]}).records;
  const restored=createRestoreJournal({chat:before,targetChat:[{mes:'restored'}],chatKey:'copy-contract',pending:floor});
  const cases=[
    ['checking','正在检查保存状态',floor,'正在核对第 10 层是否已保存','checking'],
    ['unconfirmed','酒馆保存待确认',floor,'第 10 层保存待确认','checking'],
    ['verify-unavailable','无法确认保存状态',floor,'暂时无法核对第 10 层是否已保存','failed'],
    ['unconfirmed','酒馆已保存，备份待补全',floor,'酒馆已保存，第 10 层备份待补全','checking'],
    ['unconfirmed','酒馆保存待确认',deleted,'原第 1–2 层的删除待确认','checking'],
    ['unconfirmed','酒馆保存待确认',[...floor,...restored],'恢复内容保存待确认','checking'],
    ['unconfirmed','酒馆保存待确认',[{messageIndex:null}],'旧改动保存待确认','checking'],
    ['saved','酒馆聊天已保存',[],'酒馆聊天已保存','saved'],
    ['full-frozen','完整备份已暂停更新',[],'完整备份已暂停更新','failed'],
    ['verify-unavailable','无法确认保存状态',[10,11,12,20,21,22,30,31,32].map(messageIndex=>({messageIndex})),
      '暂时无法核对第 10–12、20–22、30–32 层是否已保存','failed'],
  ];
  for(const [code,text,pending,expected,visual] of cases){
    const status=coordinator.createDisplayStatus(code,text,'原详情',pending);updateStatusLine(status);
    const line=document.getElementById('boxed-lllllabc-status-line');
    assert(document.getElementById('boxed-lllllabc-status-text').textContent===expected,'文案不符：'+text);
    assert(status.code===code&&status.detail==='原详情'&&line.dataset.status===visual,'状态语义或灯色改变：'+text);
    assert(getComputedStyle(line).display==='flex','状态灯公共样式没有载入');
    assert(getComputedStyle(line.querySelector('.boxed-lllllabc-status-signal')).backgroundColor===({checking:'rgb(205, 148, 31)',saved:'rgb(47, 151, 103)',failed:'rgb(194, 65, 65)'})[visual],'实际灯色改变：'+text);
    assert(line.getAttribute('aria-label')===expected+'，查看当前聊天备份'&&line.title===expected+'；查看当前聊天备份','辅助文字不同步');
    assert(document.documentElement.scrollWidth<=innerWidth+1,'状态文字导致页面横向溢出');checks.push(expected);
  }
  return checks;
}
