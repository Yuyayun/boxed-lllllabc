import { buildBackendChatRequest } from '../verifier/backend-reader.js';

// Use the same native save endpoints with an immutable payload and explicit
// identity. saveChatConditional waits on a global lock and can otherwise select
// a different chat if the user switches while it is waiting.
export async function saveNativeChatSnapshot({current,shouldContinue=()=>true,fetchImpl=globalThis.fetch,prepareRequest=async request=>request}) {
  const identity=buildBackendChatRequest(current);
  if(!identity.ok)throw new Error(identity.reason);
  const header={chat_metadata:structuredClone(current.context?.chatMetadata??{}),user_name:'unused',character_name:'unused'};
  const chat=[header,...structuredClone(current.chat)];
  const body=identity.endpoint==='/api/chats/group/get'?{id:identity.body.id,chat,force:false}
    :{...identity.body,ch_name:current.identity.meta.characterName||current.context?.name2||'',chat,force:false};
  const headers={'Content-Type':'application/json',...current.context?.getRequestHeaders?.()};
  const request=await prepareRequest({method:'POST',credentials:'same-origin',headers,body:JSON.stringify(body)});
  if(!shouldContinue())throw new Error('聊天或存储位置已经变化，已停止本次保存，保护记录仍保留。');
  const response=await fetchImpl(identity.endpoint.replace(/\/get$/,'/save'),request);
  if(!response.ok) {
    const detail=await response.json().catch(()=>null);
    throw new Error(detail?.error==='integrity'?'酒馆拒绝保存：聊天身份校验不一致，原文件与保护记录已保留。':`酒馆保存未成功（${response.status}），保护记录已保留。`);
  }
}
