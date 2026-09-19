import { chromium } from '@playwright/test';
const S='/private/tmp/claude-501/-Users-berkingurcan-Documents-algoria-x/63517913-714a-4652-a31f-e07aa5b77461/scratchpad'; const b = await chromium.launch({channel:'chrome'});
for (const url of ['/','/how-to-use']) for (const [w,h] of [[320,640],[390,844],[768,1024],[1024,768],[1280,800],[1920,1080]]) {
  const p = await b.newPage({ viewport:{width:w,height:h} });
  await p.goto('http://localhost:4179'+url, {waitUntil:'networkidle'}); await p.waitForTimeout(url==='/'?17500:800);
  const r = await p.evaluate(() => { const bad=[]; for (const el of document.querySelectorAll('body *')) { const x=el.getBoundingClientRect(); if (x.right>innerWidth+1 && getComputedStyle(el).position!=='fixed' && !el.closest('pre,.v-bg,.body')) bad.push(el.tagName+'.'+el.className.toString().slice(0,30)+' '+Math.round(x.right)); } return {sw:document.documentElement.scrollWidth, iw:innerWidth, bad:bad.slice(0,5)}; });
  console.log(url, w, JSON.stringify(r));
  await p.screenshot({ path: S+'/q'+(url==='/'?'home':'how')+'-'+w+'.png', fullPage:true }); await p.close();
}
await b.close();
