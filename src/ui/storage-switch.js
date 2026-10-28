import { STORAGE_LOCATION_NAMES as names } from './storage-location.js';
import { BATCH_TRANSFER_VERSION } from '../storage/protocol.js';

export function storageChangeDescription(kind, from, to) {
  return kind === 'switch'
    ? `将备份从“${names[from]}”切换到“${names[to]}”。新位置已有的备份会被覆盖，不会合并。切换成功后，原位置的备份仍会保留。`
    : `将删除原存储位置“${names[to]}”中的普通备份、未保存变更和聊天快照，此操作不可撤销。当前使用位置“${names[from]}”的备份、备份设置及酒馆聊天文件不受影响。`;
}
export function createStorageSwitchUi({ control, sqlite, coordinator, isGenerating = () => false, afterChange = async () => {} }) {
  let modal;
  let progressText;
  let pausing = false;
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
  function block(message = '正在等待已有操作结束，请勿关闭页面。', { running = true, title = '正在切换备份位置' } = {}) {
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
    text(resultSelector,error.message);
    let pending = true, state;
    try { state=await control.read(); pending = Boolean(state.journal); }
    catch { /* Unreadable control state must keep the page locked as well. */ }
    if (pending) {
      block(`${error.message}\n备份操作保持暂停。继续时会先核对登记和实际内容，不会自动选择其他存储位置。`, { running:false, title:error.code==='paused'?'迁移已暂停':'恢复存储操作' });
      if(state?.journal?.version===3 && state.journal.kind==='switch' && !state.journal.manifest) {
        const note=document.createElement('p');note.textContent='来源清单尚未完成。若无法证明来源未变，将撤销本次任务并保留两端原备份。';modal.append(note);
      }
      const continueButton=button(state?.journal?.phase==='activated'?'继续完成收尾':state?.journal?.phase==='aborting'?'继续完成撤销':'继续核对并恢复', async () => {
        for (const node of modal.querySelectorAll('button')) node.disabled=true;
        try { await completed(await coordinator.recover({confirmed:true}),state?.journal?.kind,state?.journal?.to); } catch (next) { await failure(next); }
      });
      if (state?.journal?.version===3 && ['working','committing'].includes(state.journal.phase) && coordinator.abandon) {
        button('放弃本次迁移',()=>confirmAbandon());
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
    block('将撤销尚未完成的迁移并清理本次暂存。原位置现有备份和目标原有正式备份会保留。', { running:false,title:'放弃本次迁移' });
    const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';
    label.append(check,document.createTextNode('我确认放弃本次任务，回到迁移前的存储位置。'));modal.append(label);
    const back=button('返回恢复',()=>failure(new Error('迁移尚未完成。')));
    const submit=button('确认放弃并撤销',async()=>{
      submit.disabled=true;back.disabled=true;
      try {await completed(await coordinator.abandon({confirmed:true}));}catch(next){await failure(next);}
    });
    submit.disabled=true;check.addEventListener('change',()=>{submit.disabled=!check.checked;});back.focus();
  }
  async function confirm(kind) {
    resultSelector=kind==='switch'?'#boxed-lllllabc-transfer-result':'#boxed-lllllabc-clear-result';
    const state=await refresh();
    if (state.journal) return failure(new Error('请先恢复未完成的存储操作。'));
    if (isGenerating()) { text(resultSelector,'请先停止生成，再切换或清空存储。'); return; }
    const to=kind==='switch' ? (state.active==='indexeddb'?'sqlite':'indexeddb') : state.previous;
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
  return { bind, refresh, block, close, failure, progress(message) { if (progressText) progressText.textContent=pausing?`${message}\n已请求暂停，将在当前步骤结束后停下。`:message; } };
}
