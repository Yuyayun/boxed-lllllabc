import { nativeMessageHash } from '../backup/native-content.js';

const ID='boxed-lllllabc-legacy-branch-dialog';
export function buildLegacyBranchModel(plan) {
  const choices=plan.branchChoices??[],chats=choices.map(choice=>choice.plan.targetChat);
  let prefix=0,suffix=0;
  while(chats.length&&chats.every(chat=>prefix<chat.length&&nativeMessageHash(chat[prefix])===nativeMessageHash(chats[0][prefix])))prefix++;
  while(chats.length&&chats.every(chat=>chat.length-suffix-1>=prefix&&nativeMessageHash(chat.at(-suffix-1))===nativeMessageHash(chats[0].at(-suffix-1))))suffix++;
  return {firstIndex:prefix,commonSuffix:suffix,choices:choices.map((choice,index)=>({id:choice.id,label:`内容 ${index+1}`,chat:choice.plan.targetChat,
    start:Math.max(0,prefix-1),end:Math.min(choice.plan.targetChat.length,choice.plan.targetChat.length-suffix+1)}))};
}

export function openLegacyBranchDialog({plan,onSelect}) {
  document.getElementById(ID)?.remove();
  const model=buildLegacyBranchModel(plan),dialog=document.createElement('div');dialog.id=ID;dialog.className='boxed-lllllabc-dialog';
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby',ID+'-title');
  const close=()=>dialog.remove(),backdrop=document.createElement('div');backdrop.className='boxed-lllllabc-dialog-backdrop';backdrop.addEventListener('click',close);
  const frame=document.createElement('div');frame.className='boxed-lllllabc-dialog-frame boxed-lllllabc-restore-frame';
  const header=document.createElement('header');header.className='boxed-lllllabc-dialog-header';
  const title=document.createElement('strong');title.id=ID+'-title';title.textContent='选择要恢复的聊天内容';
  const closeButton=document.createElement('button');closeButton.type='button';closeButton.className='menu_button boxed-lllllabc-dialog-close';closeButton.textContent='×';closeButton.setAttribute('aria-label','关闭');closeButton.addEventListener('click',close);header.append(title,closeButton);
  const body=document.createElement('div');body.className='boxed-lllllabc-restore-body';
  const description=document.createElement('p');description.textContent=`第 ${model.firstIndex} 层起发现 ${model.choices.length} 套连续内容，无法自动确认最后实际使用的是哪一套。请选择一套，再查看恢复预览。`;body.append(description);
  const note=document.createElement('p');note.textContent='只会恢复你选择的这一套，不会交叉拼接，也不会另建聊天。每套内容都可展开逐层查看。';body.append(note);
  const footer=document.createElement('footer');footer.className='boxed-lllllabc-restore-footer';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='menu_button';cancel.textContent='取消';cancel.addEventListener('click',close);
  const next=document.createElement('button');next.type='button';next.className='menu_button';next.textContent='查看恢复预览';next.disabled=true;
  const error=document.createElement('p');error.className='boxed-lllllabc-restore-error';error.hidden=true;error.setAttribute('role','alert');
  let selected;
  for(const choice of model.choices){
    const section=document.createElement('section'),label=document.createElement('label'),radio=document.createElement('input');radio.type='radio';radio.name=ID+'-choice';radio.value=choice.id;
    radio.addEventListener('change',()=>{selected=choice.id;next.disabled=false;});label.append(radio,document.createTextNode(`${choice.label} · 共 ${choice.chat.length} 层`));
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看连续内容和前后文';details.append(summary);
    const list=document.createElement('div');details.append(list);let cursor=choice.start;
    const more=document.createElement('button');more.type='button';more.className='menu_button';
    const appendPage=()=>{
      const end=Math.min(cursor+50,choice.end);
      for(;cursor<end;cursor++){
        const raw=choice.chat[cursor],item=document.createElement('details'),heading=document.createElement('summary');
        heading.textContent=`第 ${cursor} 层 · ${raw.name|| (raw.is_user?'用户':'角色')} · ${String(raw.mes??raw.text??raw.content??'').slice(0,100)}`;
        const text=document.createElement('pre');text.style.whiteSpace='pre-wrap';text.style.overflowWrap='anywhere';text.textContent=String(raw.mes??raw.text??raw.content??'');
        item.append(heading,text);
        const additional=Object.fromEntries(Object.entries(raw).filter(([key])=>!['mes','text','content','name','is_user','is_system'].includes(key)));
        if(Object.keys(additional).length){const extra=document.createElement('details'),extraTitle=document.createElement('summary'),extraText=document.createElement('pre');extraTitle.textContent='查看消息的其他已保存内容';extraText.style.whiteSpace='pre-wrap';extraText.style.overflowWrap='anywhere';extraText.textContent=JSON.stringify(additional,null,2);extra.append(extraTitle,extraText);item.append(extra);}
        list.append(item);
      }
      more.hidden=cursor>=choice.end;more.textContent=`继续查看后面的内容（剩余 ${choice.end-cursor} 层）`;
    };
    details.addEventListener('toggle',()=>{if(details.open&&cursor===choice.start)appendPage();});more.addEventListener('click',appendPage);details.append(more);
    section.append(label,details);body.append(section);
  }
  next.addEventListener('click',async()=>{
    if(!selected)return;next.disabled=true;cancel.disabled=true;error.hidden=true;
    const radios=[...dialog.querySelectorAll('input[type="radio"]')];radios.forEach(radio=>{radio.disabled=true;});
    try{const result=await onSelect(selected,()=>dialog.isConnected);if(result?.ok)close();else {error.textContent=result?.reason||'内容已经变化，请重新打开恢复。';error.hidden=false;}}
    catch(cause){error.textContent=cause.message||'暂时无法读取，请重新打开恢复。';error.hidden=false;}
    finally{next.disabled=false;cancel.disabled=false;radios.forEach(radio=>{radio.disabled=false;});}
  });
  footer.append(cancel,next);frame.append(header,body,error,footer);dialog.append(backdrop,frame);dialog.addEventListener('keydown',event=>{if(event.key==='Escape')close();});document.body.append(dialog);closeButton.focus();return dialog;
}
