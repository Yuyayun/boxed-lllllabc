const names = { indexeddb: 'IndexedDB', sqlite: 'SQLite' };
export function createStorageSwitchUi({ control, sqlite, coordinator, isGenerating = () => false, afterChange = async () => {} }) {
  let modal;
  let progressText;
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
  function button(label, onClick) { const node = document.createElement('button'); node.type='button'; node.className='menu_button'; node.textContent=label; node.addEventListener('click',onClick); modal.append(node); return node; }
  function block(message = '正在等待已有操作结束，请勿关闭页面。') {
    const node = frame('正在切换存储方式'); progressText.textContent=message;
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
    progressText.focus();
  }
  async function refresh() {
    const state=await control.read();
    text('#boxed-lllllabc-storage-mode',names[state.active]);
    const health=await sqlite.status();
    const writable=health.ok && health.database?.writable===true;
    text('#boxed-lllllabc-sqlite-state',health.ok ? writable ? 'SQLite 插件已连接，可写入（可选）'
      : health.database?.writable===false ? 'SQLite 插件已连接，当前不可写入' : 'SQLite 插件已连接，写入权限未确认' : health.reason);
    const switchButton=document.querySelector('#boxed-lllllabc-switch-storage');
    const clearButton=document.querySelector('#boxed-lllllabc-clear-inactive');
    if (switchButton) switchButton.disabled=!!state.journal || state.active==='indexeddb' && !writable;
    const clearReason=state.journal ? '存在未完成的存储操作，请先恢复。'
      : !state.lastTransfer || !state.previous || state.previous===state.active ? '完成存储切换后，才可清空保留的旧端数据。'
      : !health.ok ? 'SQLite 插件当前不可用，请先恢复连接，再清空旧端数据。'
      : !writable ? health.database?.writable===false ? 'SQLite 插件当前不可写入，暂不能清空旧端数据。' : 'SQLite 插件写入权限未确认，暂不能清空旧端数据。'
      : `仅清空非活动端 ${names[state.previous]} 的箱装备份与快照；当前 ${names[state.active]}、备份开关和酒馆聊天文件保留。`;
    if (clearButton) { clearButton.disabled=!!state.journal || !state.lastTransfer || !state.previous || state.previous===state.active || !writable; clearButton.textContent=state.previous ? `清空旧端数据（${names[state.previous]}）` : '清空旧端数据'; }
    text('#boxed-lllllabc-clear-help',clearReason);
    return state;
  }
  async function failure(error) {
    text(resultSelector,error.message);
    let pending = true;
    try { pending = Boolean((await control.read()).journal); }
    catch { /* Unreadable control state must keep the page locked as well. */ }
    if (pending) {
      block(`存储操作尚待恢复：${error.message}。备份写入保持暂停。`);
      button('重试恢复', async () => { try { await coordinator.recover(); await refresh(); await afterChange(); } catch (next) { await failure(next); } });
    } else close();
  }
  async function confirm(kind) {
    resultSelector=kind==='switch'?'#boxed-lllllabc-transfer-result':'#boxed-lllllabc-clear-result';
    const state=await refresh();
    if (state.journal) return failure(new Error('请先恢复未完成的存储操作。'));
    if (isGenerating()) { text(resultSelector,'请先停止生成，再切换或清空存储。'); return; }
    const to=kind==='switch' ? (state.active==='indexeddb'?'sqlite':'indexeddb') : state.previous;
    if (!to) return;
    const node=frame(kind==='switch'?'切换存储方式':'清空旧端数据');
    progressText.textContent=kind==='switch'
      ? `${names[state.active]} → ${names[to]}。目标端原有箱装备份将被完整覆盖，不会合并。成功后原来源副本继续保留；失败时保留原来源和原目标。`
      : `将清空非活动端 ${names[to]} 的全部箱装备份，此操作不可撤销。当前活动端 ${names[state.active]}、箱装设置及酒馆聊天文件不会被清空。`;
    const label=document.createElement('label'); const check=document.createElement('input'); check.type='checkbox'; label.append(check,document.createTextNode('我已停止生成并关闭其他酒馆页签，确认上述覆盖或清空范围。')); node.append(label);
    const cancel=button('取消',close);
    const submit=button(kind==='switch'?'确认覆盖并切换':'确认清空', async()=>{
      submit.disabled=true; cancel.disabled=true;
      try {
        const result=kind==='switch' ? await coordinator.switchTo(to,{confirmed:true}) : await coordinator.clearInactive(to,{confirmed:true});
        text(resultSelector,kind==='switch' ? `切换成功，当前使用 ${names[result.active]}。原来源副本已保留。` : `${names[to]} 旧端数据已清空并校验。`);
        await refresh(); await afterChange();
      } catch(error) { await failure(error); }
    });
    submit.disabled=true; check.addEventListener('change',()=>{submit.disabled=!check.checked;}); cancel.focus();
  }
  function bind() {
    document.querySelector('#boxed-lllllabc-switch-storage')?.addEventListener('click',()=>confirm('switch').catch(failure));
    document.querySelector('#boxed-lllllabc-clear-inactive')?.addEventListener('click',()=>confirm('clear').catch(failure));
    document.querySelector('#boxed-lllllabc-check-storage')?.addEventListener('click',()=>{ resultSelector='#boxed-lllllabc-transfer-result'; refresh().then(afterChange).catch(failure); });
  }
  return { bind, refresh, block, close, failure, progress(message) { if (progressText) progressText.textContent=message; } };
}
