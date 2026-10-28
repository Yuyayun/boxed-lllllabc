const KNOWN_KEY='boxed-lllllabc:server-logs-known';
const stages={registered:'登记任务',inventory:'清点来源','source-check':'复核来源','source-checked':'来源核对完成',prepared:'目标准备完成',append:'写入批次','batch-verified':'批次读回通过','target-check':'核对目标',verified:'最终核验通过',committing:'准备提交',committed:'目标已提交',activated:'正式启用','target-activated':'目标确认启用','finish-target':'清理目标','finish-source':'来源收尾','release-source':'释放来源锁','release-target':'释放目标锁',completed:'任务完成',cancelled:'任务已撤销',paused:'任务暂停',recover:'恢复核对',error:'发生异常',timeout:'等待超时',started:'开始操作',finished:'操作完成',progress:'完成一个工作步骤'};
export function formatRuntimeLog(entry){
  const parts=[entry.timestamp,entry.category==='error'?'异常':entry.scope==='migration'?'迁移':'日常',entry.taskId,stages[entry.stage]??entry.stage];
  if(entry.from&&entry.to)parts.push(`${entry.from} → ${entry.to}`);
  for(const [key,label] of [['operation','操作'],['count','已清点'],['verified','已核验'],['batch','批次'],['bytes','字节'],['errorCode','错误'],['sqliteCode','SQLite 错误号'],['elapsedMs','耗时毫秒']])if(entry[key]!==undefined)parts.push(`${label}：${entry[key]}`);
  return parts.filter(value=>value!==undefined&&value!==null).join(' | ');
}
export function createRuntimeLogUi({storage,remember=globalThis.localStorage}={}){
  let known=false,connected=false,cursor=null,busy=false,modal;
  try{known=remember?.getItem(KNOWN_KEY)==='1';}catch{/* Private browsers may disable preferences. */}
  const root=document.querySelector('#boxed-lllllabc-runtime-logs');
  if(!root)return {connection(){},available:()=>known,open(){}};
  const body=root.querySelector('[data-log-body]'),message=root.querySelector('[data-log-message]'),output=root.querySelector('textarea'),filter=root.querySelector('select');
  const buttons=[...root.querySelectorAll('button')],older=root.querySelector('[data-log-older]'),check=root.querySelector('input[type=checkbox]'),cleanup=root.querySelector('[data-log-cleanup]');
  function state(){root.hidden=!known;for(const button of buttons)button.disabled=busy||!connected;older.disabled ||= !cursor;cleanup.disabled ||= !check.checked;root.setAttribute('aria-busy',String(busy));}
  function connection(health){if(health.capabilities?.logs===1){known=true;try{remember?.setItem(KNOWN_KEY,'1');}catch{}}connected=health.capabilities?.logs===1;if(!connected&&known)message.textContent='目前无法读取服务器日志。恢复连接后，请先检查服务器连接，再刷新日志。';state();}
  async function action(fn){if(busy)return;busy=true;state();try{await fn();}catch(error){message.textContent=`无法读取或处理服务器日志：${error.message}`;}finally{busy=false;state();}}
  const read=next=>action(async()=>{const result=await storage.readLogs({category:filter.value,...(next?{cursor}:{}),limit:50});cursor=result.cursor;output.value=result.entries.map(formatRuntimeLog).join('\n');message.textContent=result.stale?'日志已轮换或清理，请刷新。':result.entries.length?`本页 ${result.entries.length} 条。${cursor?'可以查看更早记录。':'已到最早记录。'}`:cursor?'本段没有符合条件的记录，可继续查看更早记录。':'暂无符合条件的记录。';});
  root.querySelector('[data-log-refresh]').addEventListener('click',()=>read(false));
  older.addEventListener('click',()=>read(true));filter.addEventListener('change',()=>read(false));check.addEventListener('change',state);
  root.querySelector('[data-log-copy]').addEventListener('click',()=>action(async()=>{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(output.value);else{output.select();if(!document.execCommand('copy'))throw new Error('复制失败，请选中日志后手动复制。');}message.textContent='已复制当前页日志。';}));
  cleanup.addEventListener('click',()=>action(async()=>{if(!check.checked)return;let position=0,removed=0;do{const result=await storage.clearLogs(position);removed+=result.removed;position=result.cursor;message.textContent=`正在分批清理，已移除 ${removed} 条已结束日志。未结束任务保留。`;}while(position!==null);check.checked=false;cursor=null;output.value='';message.textContent=`已清理 ${removed} 条已结束的日志；未结束任务及迁移登记均保留。`;}));
  root.addEventListener('toggle',()=>{if(root.open&&connected&&!output.value)void read(false);});
  function open(){if(!known||modal)return;modal=document.createElement('dialog');modal.id='boxed-lllllabc-log-dialog';modal.setAttribute('aria-labelledby','boxed-lllllabc-log-title');const title=document.createElement('strong');title.id='boxed-lllllabc-log-title';title.textContent='查看运行日志';const close=document.createElement('button');close.type='button';close.className='menu_button';close.textContent='返回';close.addEventListener('click',()=>modal.close());modal.append(title,body,close);document.body.append(modal);modal.addEventListener('close',()=>{root.append(body);modal.remove();modal=null;},{once:true});modal.showModal();close.focus();if(connected)void read(false);}
  state();return {connection,available:()=>known,open};
}
