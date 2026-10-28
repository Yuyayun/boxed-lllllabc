export async function readSupervisedResponse(response,{touch=()=>{},onProgress=()=>{},maxBytes=34*1024*1024}={}) {
  const type=response.headers?.get?.('content-type')??'';
  if(!type.includes('application/x-ndjson'))return response.json();
  const reader=response.body?.getReader?.();if(!reader)throw Object.assign(new Error('服务器监工响应不可读取。'),{code:'outcome-unknown'});
  const decoder=new TextDecoder();let pending='',total=0,result;
  function line(text){
    if(!text.trim())return;const frame=JSON.parse(text);
    if(frame.type==='heartbeat'||frame.type==='progress')onProgress(frame.supervisor??frame);
    else if(frame.type==='result'){if(result)throw new Error('重复的服务器完成回执。');result=frame;}
    else throw new Error('未知的服务器监工回执。');
  }
  try{
    while(true){const {done,value}=await reader.read();if(done)break;touch();total+=value.byteLength;if(total>maxBytes)throw new Error('服务器响应超过读取上限。');
      pending+=decoder.decode(value,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){line(pending.slice(0,end));pending=pending.slice(end+1);}
    }
    pending+=decoder.decode();if(pending.trim())line(pending);
    if(!result)throw Object.assign(new Error('连接结束但未收到完成回执，结果待核对。'),{code:'outcome-unknown'});
    return result;
  }catch(error){try{await reader.cancel();}catch{}if(error instanceof TypeError)throw Object.assign(new Error('服务器连接中断，尚未确认操作结果。',{cause:error}),{code:'outcome-unknown'});throw error;}
  finally{reader.releaseLock();}
}
