import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const host=path.resolve(process.env.BOXED_HOST_PUBLIC);
const output=process.env.BOXED_LAYOUT_ARTIFACTS??path.join(root,'.local-test/current-chat-layout');
const mode=process.argv[2]??'after';await fs.mkdir(output,{recursive:true});
const {chromium}=await import(pathToFileURL(process.env.BOXED_PLAYWRIGHT_PATH).href);
const server=http.createServer(async(request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  if(pathname==='/'){
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/host/style.css"><link rel="stylesheet" href="/host/css/mobile-styles.css"><link rel="stylesheet" href="/style.css">
      <style>html,body{height:100%;}body{margin:0;}#fixture{position:fixed;inset:0;overflow:auto;padding:8px;}#fixture>.boxed-lllllabc-settings{max-width:600px;}
      #sheld{position:fixed;inset:0;margin:0;width:min(100%,600px);height:100%;}#chat{position:absolute;inset:0;width:100%;height:100%;}</style>
      <main id="fixture"></main><main id="sheld"><div id="chat"></div></main>`);return;
  }
  const isHost=pathname.startsWith('/host/'),base=isHost?host:root;
  const file=path.resolve(base,'.'+(isHost?pathname.slice(5):pathname));
  const allowed=isHost?/\.(css|woff2?|ttf|otf)$/.test(file):pathname==='/style.css'||pathname.startsWith('/styles/')||pathname.startsWith('/src/');
  if(!allowed||!file.startsWith(base+path.sep)){response.writeHead(404).end();return;}
  try{response.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'application/octet-stream');response.end(await fs.readFile(file));}
  catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.BOXED_BROWSER_PATH?{executablePath:process.env.BOXED_BROWSER_PATH}:{})});
const report=[];
try{
  for(const viewport of [{width:360,height:640},{width:800,height:390},{width:1200,height:900}]){
    const mobile=viewport.width<1000,context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile});
    for(const target of ['top','settings','dialog']){
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
      await page.evaluate(async target=>{
        const {ensureStatusLine,openStatusDialog}=await import('/src/ui/status-line.js');
        const {renderCurrentChatPanel}=await import('/src/ui/current-chat-panel.js');
        let body;
        if(target==='settings'){
          document.querySelector('#sheld').remove();
          document.querySelector('#fixture').innerHTML='<div class="boxed-lllllabc-settings"><div class="boxed-lllllabc-panel"><div id="boxed-lllllabc-settings-panel-body" class="boxed-lllllabc-panel-body"></div></div></div>';
          body=document.querySelector('#boxed-lllllabc-settings-panel-body');
        }else{
          ensureStatusLine({getDisplayMode:()=> 'top'});
          if(target==='dialog'){openStatusDialog();body=document.querySelector('#boxed-lllllabc-status-dialog-body');}
          else{document.querySelector('#boxed-lllllabc-status-panel').hidden=false;body=document.querySelector('#boxed-lllllabc-status-panel-body');}
        }
        renderCurrentChatPanel(body,{status:{code:'saved',shortText:'酒馆聊天已保存',updatedAt:'2026-11-19T16:00:00Z'},
          meta:{chatDisplayName:'独立布局测试'},messages:[],settings:{},onVerify(){},onCreateSnapshot(){},restore:{onRequestSave(){},onOpenRecovery(){}},
          historicalChanges:Array.from({length:12},(_,messageIndex)=>({messageIndex,message:{mes:'合成备份内容。'.repeat(8)},updatedAt:'2026-11-19T16:00:00Z'}))});
        window.layoutBody=body;await document.fonts.ready;
      },target);
      const layout=await page.evaluate(()=>{
        const body=window.layoutBody,card=body.querySelector('.boxed-lllllabc-primary-actions'),title=card.querySelector('.boxed-lllllabc-primary-actions-title');
        const hint=title.querySelector('span'),buttons=card.querySelector('.boxed-lllllabc-primary-action-grid');
        const range=document.createRange();range.selectNodeContents(hint);
        return {hintHeight:hint.getBoundingClientRect().height,gap:buttons.getBoundingClientRect().top-range.getBoundingClientRect().bottom,
          buttonCount:buttons.children.length,overflowX:body.scrollWidth>body.clientWidth+1,
          bodyHeight:body.clientHeight,scrollHeight:body.scrollHeight,panelHeight:body.parentElement.getBoundingClientRect().height,
          buttonHeights:[...buttons.children].map(button=>button.getBoundingClientRect().height)};
      });
      await page.screenshot({path:path.join(output,`${mode}-${viewport.width}-${target}.png`)});
      assert.equal(layout.buttonCount,4);assert.equal(layout.overflowX,false);assert.deepEqual(errors,[]);
      if(mode==='before'&&viewport.width===360&&target==='top')assert(layout.hintHeight>100&&layout.gap>100,'未复现顶部操作区空白');
      if(mode==='after'){
        assert(layout.hintHeight<80&&layout.gap<=20,`${target}/${viewport.width}: 说明与按钮间存在异常空白`);
        assert(layout.buttonHeights.every(height=>height>=44),'触摸按钮高度不足');
        if(target==='top')assert(layout.panelHeight<=Math.min(380,viewport.height-112)+1,'顶部面板超出可用高度');
      }
      if(mode==='after'&&viewport.width===360&&target==='top'){
        const box=await page.locator('#boxed-lllllabc-status-panel-body').boundingBox(),cdp=await context.newCDPSession(page);
        const x=Math.round(box.x+box.width/2),y=Math.round(box.y+box.height*.8);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*15}]});await page.waitForTimeout(25);}
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(120);await cdp.detach();
        layout.touchScrollTop=await page.evaluate(()=>window.layoutBody.scrollTop);assert(layout.touchScrollTop>0,'顶部正文没有随触摸滚动');
      }
      report.push({viewport,target,...layout});await page.close();
    }
    await context.close();
  }
  await fs.writeFile(path.join(output,`${mode}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
