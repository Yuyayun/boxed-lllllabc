import { STORAGE_LOCATION_NAMES as names } from './storage-location.js';
import { BATCH_TRANSFER_VERSION } from '../storage/protocol.js';

export function storageChangeDescription(kind, from, to) {
  return kind === 'switch'
    ? `将备份从“${names[from]}”切换到“${names[to]}”。新位置已有的备份会被覆盖，不会合并。切换成功后，原位置的备份仍会保留。`
    : `将删除原存储位置“${names[to]}”中的普通备份、未保存变更和聊天快照，此操作不可撤销。当前使用位置“${names[from]}”的备份、备份设置及酒馆聊天文件不受影响。`;
}
const legacyStageNames={inventory:'清点回滚副本',clear:'整理恢复位置',copy:'写回并读回核对',verify:'复核完整内容','verify-active':'核验已启用内容','count-active':'复核已启用记录总量',cleanup:'清理旧暂存',done:'恢复完成'};
export function legacyRecoveryProgressText(r){
  const count=r?.stage==='clear'?r.cleared:r?.stage==='cleanup'?r.removed:r?.stage==='count-active'?r.countSummary?.count:r?.summary?.count;
  return `正在分批恢复旧任务：${legacyStageNames[r?.stage]??'核对任务'}${Number.isSafeInteger(count)?'（本阶段 '+count+' 条）':''}`;
}
export function supervisorProgressText(state){
  if(state.state==='idle')return '';
  if(state.state==='queued')return `任务正在排队，已等待 ${Math.floor((state.elapsedMs??0)/1000)} 秒。`;
  const stages={'startup-audit':'逐页检查已有记录','upgrade-backup':'生成旧库一致备份','upgrade-backup-recheck':'复核旧库备份','upgrade-source-recheck':'复核升级来源','upgrade-copy-verified':'写入并核对新结构','upgrade-target-check':'验收新结构','upgrade-activated':'已启用新结构','upgrade-cleanup':'分批清理旧表','storage-statistics':'分批统计容量','legacy-inventory':'清点旧任务回滚副本','legacy-clear':'整理旧任务恢复位置','legacy-copy':'分批写回并读回核对','legacy-verify':'验收旧任务恢复内容','legacy-cleanup':'清理旧任务暂存'};
  const labels={initializing:'服务器正在准备存储',slow:'当前步骤较慢，仍在等待有效进展',working:'服务器正在处理','no-progress':'长时间没有有效进展，结果需要核对',unresponsive:'服务器工作线程暂未回复，结果需要核对',unavailable:'服务器工作线程不可用'};
  const legacyName=state.stage?.startsWith('legacy-')?legacyStageNames[state.stage.slice(7)]:undefined;
  const status=['no-progress','unresponsive','unavailable'].includes(state.state)?labels[state.state]:legacyName??stages[state.stage]??labels[state.state];
  return `${status??'正在等待服务器'}${Number.isSafeInteger(state.count)?'；本阶段已处理 '+state.count+' 条':''}${Number.isSafeInteger(state.verified)?'；已读回核对 '+state.verified+' 条':''}；${state.state==='initializing'?'准备存储已用':'当前任务已用'} ${Math.floor((state.elapsedMs??0)/1000)} 秒。存活报告不表示核验完成。`;
}
export function createStorageSwitchUi({ control, sqlite, coordinator, isGenerating = () => false, afterChange = async () => {},canReadLogs=()=>false,onLogs=()=>{} }) {
  let modal;
  let progressText;
  let pausing = false;
  let operationKind = 'switch', operationTo;
  let monitorText;
  let resultSelector = '#boxed-lllllabc-transfer-result';
  const text = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  function close() { modal?.close(); modal?.remove(); modal = null; }
  function frame(title) {
    close(); modal = document.createElement('dialog'); modal.id = 'boxed-lllllabc-transfer-dialog';
    modal.setAttribute('aria-labelledby','boxed-lllllabc-transfer-title');
    const heading = document.createElement('strong'); heading.id = 'boxed-lllllabc-transfer-title'; heading.textContent = title;
    progressText = document.createElement('p'); progressText.setAttribute('aria-live','polite');
    modal.append(heading,progressText); document.body.append(modal); modal.showModal();
    return modal;
  }
  function button(label, onClick) {
    let actions=modal.querySelector('.boxed-lllllabc-transfer-actions');
    if(!actions){actions=document.createElement('div');actions.className='boxed-lllllabc-transfer-actions';modal.append(actions);}
    const node=document.createElement('button');node.type='button';node.className='menu_button';node.textContent=label;node.addEventListener('click',onClick);actions.append(node);return node;
  }
  function block(message = '正在等待已有操作结束，请勿关闭页面。', { running = true, kind, abandoning, title = abandoning?(kind==='clear'?'正在撤销清空':'正在撤销迁移'):kind==='clear'?'正在清空原位置备份':kind==='switch'?'正在切换备份位置':'正在处理备份存储操作' } = {}) {
    pausing = false;
    const node = frame(title); progressText.textContent=message;
    node.setAttribute('aria-busy', String(running));
    progressText.tabIndex=0;
    node.addEventListener('cancel',(event)=>event.preventDefault());
    node.addEventListener('keydown',(event)=>{
      event.stopPropagation();
      if(event.key==='Tab') {
        event.preventDefault();
        const items=[...node.querySelectorAll('[tabindex="0"],button:not(:disabled)')];
        const index=items.indexOf(document.activeElement);
        items[(index+(event.shiftKey?-1:1)+items.length)%items.length]?.focus();
      }
    });
    node.addEventListener('keyup',(event)=>event.stopPropagation());
    const boundary=document.createElement('small'); boundary.textContent='当前页面已锁定。其他插件或外部程序直接修改聊天无法完全拦截；检测到当前聊天变化会停止提交。'; node.append(boundary);
    monitorText=document.createElement('small');monitorText.hidden=true;node.append(monitorText);
    if(canReadLogs())button('查看运行日志',onLogs);
    if (running && coordinator.requestPause && coordinator.canPause?.()!==false) {
      const pauseButton=button('暂停任务',()=>{
        pausing=true; pauseButton.disabled=true; coordinator.requestPause();
        progressText.textContent='已请求暂停，正在等待当前步骤结束。备份操作继续保持锁定。';
      });
    }
    progressText.focus();
  }
  async function refresh() {
    const state=await control.read();
    text('#boxed-lllllabc-storage-mode',names[state.active]);
    const health=await sqlite.status();
    const writable=health.ok && health.database?.writable===true;
    const migrationReady=writable && health.database?.batchTransfer===BATCH_TRANSFER_VERSION;
    text('#boxed-lllllabc-sqlite-state',health.ok ? writable ? '服务器备份插件已连接'
      : health.database?.writable===false ? '服务器备份插件已连接，暂时无法写入' : '服务器备份插件已连接，写入状态未确认' : '服务器备份插件未连接');
    const connectionDetail=document.querySelector('#boxed-lllllabc-sqlite-detail');
    if (connectionDetail) { connectionDetail.textContent=health.ok ? health.database?.batchTransfer===BATCH_TRANSFER_VERSION ? '' : '服务器插件未提供新版迁移能力，请更新配套插件后再切换。' : health.reason || '请检查服务器备份插件是否已安装并启用。'; connectionDetail.hidden=!!health.ok && health.database?.batchTransfer===BATCH_TRANSFER_VERSION; }
    const switchButton=document.querySelector('#boxed-lllllabc-switch-storage');
    const clearButton=document.querySelector('#boxed-lllllabc-clear-inactive');
    if (switchButton) switchButton.disabled=!!state.journal || !migrationReady;
    const clearReason=state.journal ? '存在未完成的存储操作，请先恢复。'
      : !state.lastTransfer || !state.previous || state.previous===state.active ? '切换备份位置后，才可清空原存储位置保留的备份。'
      : !health.ok ? '服务器备份插件未连接，请先恢复连接，再清空原位置的备份。'
      : !writable ? health.database?.writable===false ? '服务器存储暂时无法写入，暂不能清空原位置的备份。' : '服务器存储写入状态未确认，暂不能清空原位置的备份。'
      : !migrationReady ? '请先更新配套服务器插件，再切换或清空原位置。'
      : storageChangeDescription('clear',state.active,state.previous);
    if (clearButton) { clearButton.disabled=!!state.journal || !state.lastTransfer || !state.previous || state.previous===state.active || !migrationReady; clearButton.textContent='清空原位置的备份'; }
    text('#boxed-lllllabc-clear-help',clearReason);
    return state;
  }
  async function failure(error) {
    let pending = true, state;
    try { state=await control.read(); pending = Boolean(state.journal); }
    catch { /* Unreadable control state must keep the page locked as well. */ }
    operationKind=state?.journal?.kind??operationKind;operationTo=state?.journal?.to??operationTo;
    resultSelector=operationKind==='clear'?'#boxed-lllllabc-clear-result':'#boxed-lllllabc-transfer-result';text(resultSelector,error.message);
    if (pending) {
      block(`${error.message}\n备份操作保持暂停。继续时会先核对登记和实际内容，不会自动选择其他存储位置。`, { running:false, title:error.code==='paused'?(operationKind==='clear'?'清空已暂停':'迁移已暂停'):(operationKind==='clear'?'恢复清空旧位置':'恢复存储操作') });
      if(state?.journal?.version===3 && state.journal.kind==='switch' && !state.journal.manifest) {
        const note=document.createElement('p');note.textContent='来源清单尚未完成。若无法证明来源未变，将撤销本次任务并保留两端原备份。';modal.append(note);
      }
      const continueButton=button(state?.journal?.phase==='activated'?'继续完成收尾':state?.journal?.phase==='aborting'?'继续完成撤销':'继续核对并恢复', async () => {
        for (const node of modal.querySelectorAll('button')) node.disabled=true;
        try { await completed(await coordinator.recover({confirmed:true}),state?.journal?.kind,state?.journal?.to); } catch (next) { await failure(next); }
      });
      if (state?.journal?.version===3 && ['working','committing'].includes(state.journal.phase) && coordinator.abandon) {
        button(operationKind==='clear'?'放弃本次清空':'放弃本次迁移',()=>confirmAbandon());
      }
    } else close();
  }
  async function completed(result,kind,to) {
    const state=await refresh();
    text(resultSelector,result?.cancelled ? result.reason || '已放弃本次迁移，原位置现有备份和目标原正式备份已保留。'
      : result?.ok ? kind==='clear' ? `原存储位置“${names[to]}”的备份已清空并完成校验。` : `已切换至${names[state.active]}。原位置的备份仍然保留。`
      : `已完成核对，当前使用${names[state.active]}。`);
    await afterChange(); close();
  }
  function confirmAbandon() {
    const clearing=operationKind==='clear';
    block(clearing?'将撤销尚未完成的清空，恢复旧位置原有备份，当前使用位置不变。':'将撤销尚未完成的迁移并清理本次暂存。原位置现有备份和目标原有正式备份会保留。', { running:false,title:clearing?'放弃本次清空':'放弃本次迁移' });
    const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';
    label.append(check,document.createTextNode(clearing?'我确认放弃本次清空，保留旧位置备份。':'我确认放弃本次任务，回到迁移前的存储位置。'));modal.append(label);
    const back=button('返回恢复',()=>failure(new Error(clearing?'清空尚未完成。':'迁移尚未完成。')));
    const submit=button('确认放弃并撤销',async()=>{
      submit.disabled=true;back.disabled=true;
      try {await completed(await coordinator.abandon({confirmed:true}),operationKind,operationTo);}catch(next){await failure(next);}
    });
    submit.disabled=true;check.addEventListener('change',()=>{submit.disabled=!check.checked;});back.focus();
  }
  async function confirm(kind) {
    operationKind=kind;
    resultSelector=kind==='switch'?'#boxed-lllllabc-transfer-result':'#boxed-lllllabc-clear-result';
    const state=await refresh();
    if (state.journal) return failure(new Error('请先恢复未完成的存储操作。'));
    if (isGenerating()) { text(resultSelector,'请先停止生成，再切换或清空存储。'); return; }
    const to=kind==='switch' ? (state.active==='indexeddb'?'sqlite':'indexeddb') : state.previous;
    operationTo=to;
    if (!to) return;
    const node=frame(kind==='switch'?'切换备份位置':'清空原位置的备份');
    progressText.textContent=storageChangeDescription(kind,state.active,to);
    const label=document.createElement('label'); const check=document.createElement('input'); check.type='checkbox'; label.append(check,document.createTextNode('我已停止生成并关闭其他酒馆页签，确认上述覆盖或清空范围。')); node.append(label);
    const cancel=button('取消',close);
    const submit=button(kind==='switch'?'确认覆盖并切换':'确认清空', async()=>{
      submit.disabled=true; cancel.disabled=true;
      try {
        const result=kind==='switch' ? await coordinator.switchTo(to,{confirmed:true}) : await coordinator.clearInactive(to,{confirmed:true});
        await completed(result,kind,to);
      } catch(error) { await failure(error); }
    });
    submit.disabled=true; check.addEventListener('change',()=>{submit.disabled=!check.checked;}); cancel.focus();
  }
  function bind() {
    document.querySelector('#boxed-lllllabc-switch-storage')?.addEventListener('click',()=>confirm('switch').catch(failure));
    document.querySelector('#boxed-lllllabc-clear-inactive')?.addEventListener('click',()=>confirm('clear').catch(failure));
    document.querySelector('#boxed-lllllabc-check-storage')?.addEventListener('click',()=>{ resultSelector='#boxed-lllllabc-transfer-result'; refresh().then(afterChange).catch(failure); });
  }
  return { bind, refresh, block, close, failure,monitor(state){const message=supervisorProgressText(state);if(monitorText?.isConnected){monitorText.textContent=message;monitorText.hidden=!message;}else if(state.state==='initializing')text('#boxed-lllllabc-sqlite-state',message);},progress(message) { if (progressText) progressText.textContent=pausing?`${message}\n已请求暂停，将在当前步骤结束后停下。`:message; } };
}
