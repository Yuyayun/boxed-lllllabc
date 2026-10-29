import {formatRuntimeLog} from '../storage/runtime-log-format.js';
export {formatRuntimeLog};
const KNOWN_KEY='boxed-lllllabc:server-logs-known';
export function createRuntimeLogUi({storage,remember}={}){
  let known=false,connected=false,cursor=null,busy=false,modal;
  try{remember??=globalThis.localStorage;known=remember?.getItem(KNOWN_KEY)==='1';}catch{/* Private browsers may disable preferences. */}
  const root=document.querySelector('#boxed-lllllabc-runtime-logs');
  if(!root)return {connection(){},logStatus(){},available:()=>known,open(){}};
  const body=root.querySelector('[data-log-body]'),message=root.querySelector('[data-log-message]'),output=root.querySelector('textarea'),filter=root.querySelector('select');
  const buttons=[...root.querySelectorAll('button')],older=root.querySelector('[data-log-older]'),check=root.querySelector('input[type=checkbox]'),cleanup=root.querySelector('[data-log-cleanup]');
  const summary=root.querySelector('summary'),warning=document.getElementById('boxed-lllllabc-log-warning')??document.createElement('p');warning.id='boxed-lllllabc-log-warning';warning.className='boxed-lllllabc-settings-help';warning.setAttribute('role','status');warning.hidden=true;root.before(warning);
  function logStatus(health){const unavailable=health?.available===false;warning.hidden=!unavailable||!known;warning.textContent=unavailable?'运行日志暂时无法记录。备份操作结果另行显示，请检查服务器备份目录或连接后重试。':'';if(summary)summary.textContent=unavailable?'查看运行日志（记录暂不可用）':'查看运行日志';}
  function state(){root.hidden=!known;for(const button of buttons)button.disabled=busy||!connected;older.disabled ||= !cursor;cleanup.disabled ||= !check.checked;root.setAttribute('aria-busy',String(busy));}
  function connection(health){if(health.capabilities?.logs===1){known=true;try{remember?.setItem(KNOWN_KEY,'1');}catch{}}connected=health.capabilities?.logs===1;if(!connected&&known)message.textContent='目前无法读取服务器日志。恢复连接后，请先检查服务器连接，再刷新日志。';if(health.logHealth)logStatus(health.logHealth);state();}
  async function action(fn){if(busy)return;busy=true;state();try{await fn();}catch(error){message.textContent=`无法读取或处理服务器日志：${error.message}`;}finally{busy=false;state();}}
  const read=next=>action(async()=>{const result=await storage.readLogs({category:filter.value,...(next?{cursor}:{}),limit:50});cursor=result.cursor;output.value=result.entries.map(formatRuntimeLog).join('\n');message.textContent=result.stale?'日志已轮换或清理，请刷新。':result.entries.length?`本页 ${result.entries.length} 条。${cursor?'可以查看更早记录。':'已到最早记录。'}`:cursor?'本段没有符合条件的记录，可继续查看更早记录。':'暂无符合条件的记录。';});
  root.querySelector('[data-log-refresh]').addEventListener('click',()=>read(false));
  older.addEventListener('click',()=>read(true));filter.addEventListener('change',()=>read(false));check.addEventListener('change',state);
  root.querySelector('[data-log-copy]').addEventListener('click',()=>action(async()=>{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(output.value);else{output.select();if(!document.execCommand('copy'))throw new Error('复制失败，请选中日志后手动复制。');}message.textContent='已复制当前页日志。';}));
  cleanup.addEventListener('click',()=>action(async()=>{if(!check.checked)return;let position=0,removed=0;do{const result=await storage.clearLogs(position);removed+=result.removed;position=result.cursor;message.textContent=`正在分批清理，已移除 ${removed} 条已结束日志。未结束任务保留。`;}while(position!==null);check.checked=false;cursor=null;output.value='';message.textContent=`已清理 ${removed} 条已结束的日志；未结束任务及迁移登记均保留。`;}));
  root.addEventListener('toggle',()=>{if(root.open&&connected&&!output.value)void read(false);});
  function open(){if(!known||modal)return;modal=document.createElement('dialog');modal.id='boxed-lllllabc-log-dialog';modal.setAttribute('aria-labelledby','boxed-lllllabc-log-title');const title=document.createElement('strong');title.id='boxed-lllllabc-log-title';title.textContent='查看运行日志';const close=document.createElement('button');close.type='button';close.className='menu_button';close.textContent='返回';close.addEventListener('click',()=>modal.close());modal.append(title,body,close);document.body.append(modal);modal.addEventListener('close',()=>{root.append(body);modal.remove();modal=null;},{once:true});modal.showModal();close.focus();if(connected)void read(false);}
  state();return {connection,logStatus,available:()=>known,open};
}
