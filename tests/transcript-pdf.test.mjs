import test from 'node:test';
import assert from 'node:assert/strict';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {buildTranscriptPdfDefinition, createTranscriptPdf, PDF_ANNOTATIONS} from '../lib/transcript-pdf.mjs';
import {fontRuns} from '../lib/pdf-fonts.mjs';

function model(parts) {
  let text='', number=0;
  const segments=parts.map(part=>{
    const value=typeof part==='string'?{text:part}:part;
    const start=text.length;text+=value.text;
    return {text:value.text,...(value.category?{annotation:{
      start,end:text.length,quote:value.text,category:value.category,assessment:value.assessment||'strength',
      number:++number,comment:value.comment||`Complete note ${number}.`,...(value.suggestion===undefined?{}:{suggestion:value.suggestion}),
    }}:{})};
  });
  return {text,segments};
}

async function inspect(blob,run) {
  assert.ok(blob instanceof Blob);assert.equal(blob.type,'application/pdf');
  assert.equal(await blob.slice(0,5).text(),'%PDF-');
  const task=getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,disableFontFace:true,useSystemFonts:false});
  const document=await task.promise;
  try {
    const pages=[];
    for(let index=1;index<=document.numPages;index++) {
      const page=await document.getPage(index),content=await page.getTextContent({disableNormalization:true});
      pages.push({page,items:content.items.filter(item=>typeof item.str==='string'),
        text:content.items.map(item=>item.str||'').join(' '),annotations:await page.getAnnotations()});
    }
    return await run({document,pages});
  } finally {await task.destroy();}
}
const compact=value=>value.normalize('NFC').replace(/\s+/gu,'');
function objects(value) {
  if(!value||typeof value!=='object')return [];
  return [value,...Object.values(value).flatMap(objects)];
}

test('a real PDF keeps the entire transcript before a separate color-key page',async()=>{
  const text=Array.from({length:75},(_,index)=>`Transcript line ${index+1}: our proposal needs clear evidence and a concrete next step.`).join('\n')+'\nFINAL TRANSCRIPT SENTINEL';
  await inspect(await createTranscriptPdf(model([text])),async({pages})=>{
    const key=pages.findIndex(page=>page.text.includes('Color key & coaching notes'));
    const lastTranscript=pages.findIndex(page=>page.text.includes('FINAL TRANSCRIPT SENTINEL'));
    assert.ok(lastTranscript>=1,'the fixture exercises transcript pagination');
    assert.equal(key,lastTranscript+1,'the key starts on the page after the transcript ends');
    const transcript=compact(pages.slice(0,key).map(page=>page.text).join(' '));
    for(const line of text.split('\n'))assert.ok(transcript.includes(compact(line)),line);
    assert.ok(pages[key].text.includes('There are no numbered coaching notes'));
    assert.equal(pages.some(page=>page.annotations.length),false);
  });
});

test('annotated PDF preserves Unicode and literal hostile text, complete notes, and internal numbered links only',async()=>{
  const hostile='<script>alert("literal")</script> https://evil.invalid/collect?x=1 & <img src=x onerror=bad()>',
    unicode='“Café” and cafe\u0301 — ★ 🚀 aren’t rewritten.';
  const input=model([
    {text:unicode,category:'great',comment:'The ★ example and 🚀 comparison make “café” memorable.'},'\n',
    {text:hostile,category:'clarity',assessment:'needs_work',comment:`Keep this complete literal note: ${hostile}`,
      suggestion:'Suggested wording stays separate: “A clear proposal — with evidence.” END OF SUGGESTION'},
    '\nThese original words remain unchanged.',
  ]);
  const definition=buildTranscriptPdfDefinition(input),runs=definition.content[2].text;
  assert.ok(runs.map(run=>run.text).join('').includes(unicode));
  await inspect(await createTranscriptPdf(input),async({document,pages})=>{
    const joined=compact(pages.map(page=>page.text).join(' '));
    for(const value of [unicode,hostile,...input.segments.filter(segment=>segment.annotation).flatMap(segment=>[segment.annotation.comment,segment.annotation.suggestion||''])])
      assert.ok(joined.includes(compact(value)),`Missing literal content: ${value}`);
    assert.doesNotMatch(joined,/\ufffd|\u0000/u);
    const destinations={};
    for(const number of [1,2]) {
      destinations[`note-${number}`]=await document.getDestination(`note-${number}`);
      assert.ok(destinations[`note-${number}`]);
    }
    const annotations=pages.flatMap(page=>page.annotations);
    assert.ok(annotations.length>=2);
    for(const annotation of annotations) {
      assert.equal(annotation.subtype,'Link');assert.match(annotation.dest,/^note-[12]$/);
      assert.equal(annotation.url,undefined);assert.equal(annotation.unsafeUrl,undefined);
      assert.equal(annotation.action,undefined);assert.equal(annotation.actions,undefined);
    }
    assert.equal(await document.getJSActions(),null);
    assert.equal(await document.getOpenAction(),null);
    const notePage=await document.getPageIndex(destinations['note-1'][0]);
    assert.ok(notePage>0);assert.ok(pages[notePage].text.includes('Color key & coaching notes'));
  });
});

test('long unbroken transcript and suggestion tokens wrap inside page margins without losing characters',async()=>{
  const token='X'.repeat(600),suggestion='Z'.repeat(700),emoji='🚀'.repeat(40);
  const input=model([{text:token+'\n'+emoji,category:'evidence',assessment:'needs_work',
    comment:'Full coaching explanation. '.repeat(100)+'FINAL NOTE SENTINEL',suggestion:suggestion+'\n'+emoji}]);
  await inspect(await createTranscriptPdf(input),async({pages})=>{
    const transcriptItems=pages.flatMap(page=>page.items).filter(item=>/^X+$/.test(item.str)),
      suggestionItems=pages.flatMap(page=>page.items).filter(item=>/^Z+$/.test(item.str)),
      emojiItems=pages.flatMap(page=>page.items).filter(item=>/^(?:🚀)+$/u.test(item.str));
    assert.equal(transcriptItems.map(item=>item.str).join(''),token);
    assert.equal(suggestionItems.map(item=>item.str).join(''),suggestion);
    assert.equal(emojiItems.map(item=>item.str).join(''),emoji+emoji,'long non-BMP tokens must never split into replacement glyphs');
    assert.ok(transcriptItems.length>1);assert.ok(suggestionItems.length>1);
    for(const item of [...transcriptItems,...suggestionItems,...emojiItems]) {
      assert.ok(item.transform[4]>=43,`Text begins outside the left margin: ${item.transform[4]}`);
      assert.ok(item.transform[4]+item.width<=569,`Text exceeds the right margin: ${item.transform[4]+item.width}`);
    }
    assert.ok(compact(pages.map(page=>page.text).join(' ')).includes(compact('FINAL NOTE SENTINEL')));
  });
});

test('the full 240-note definition retains every category, assessment style, destination and complete note',()=>{
  const categories=Object.keys(PDF_ANNOTATIONS);
  const input=model(Array.from({length:240},(_,index)=>({text:`Passage ${index+1}. `,
    category:categories[index%categories.length],assessment:index%3===0?'needs_work':index%3===1?'observation':'strength',
    comment:`COMPLETE NOTE ${index+1}`,suggestion:index%3===0?`COMPLETE SUGGESTION ${index+1}`:undefined})));
  const definition=buildTranscriptPdfDefinition(input),all=objects(definition),rows=definition.content.at(-1).table.body;
  assert.equal(rows.length,240);
  for(let number=1;number<=240;number++) {
    assert.equal(all.filter(item=>item.id===`note-${number}`).length,1);
    assert.ok(all.some(item=>item.linkToDestination===`note-${number}`));
    const row=rows[number-1];assert.equal(row[0].text,`${number}.`);
    assert.ok(row[1].stack[0].text.map(run=>run.text).join('').endsWith(`COMPLETE NOTE ${number}`));
    if((number-1)%3===0)assert.ok(row[1].stack[1].text.map(run=>run.text).join('').endsWith(`COMPLETE SUGGESTION ${number}`));
    const passage=definition.content[2].text.find(run=>run.text===`Passage ${number}. `);
    if((number-1)%3===0){assert.equal(passage.decoration,'underline');assert.equal(passage.decorationColor,'#c55050');}
    else assert.equal(passage.background,PDF_ANNOTATIONS[input.segments[number-1].annotation.category].background);
  }
  assert.ok(all.every(item=>!Object.hasOwn(item,'link')&&!Object.hasOwn(item,'url')&&!Object.hasOwn(item,'javascript')));
  assert.throws(()=>definition.footer(1,201),/200 pages/);
});

test('malformed, oversized or mismatched export models fail before PDF rendering',async()=>{
  const valid=()=>model([{text:'Original words.',category:'thesis',comment:'The exact note.'}]);
  const cases=[null,{},model([' ']),{text:'x'.repeat(60001),segments:[{text:'x'.repeat(60001)}]},
    ...[
      value=>{value.segments[0].text='Altered words.';},value=>{value.segments=[];},
      value=>{value.segments[0].annotation.category='__proto__';},value=>{value.segments[0].annotation.assessment='unknown';},
      value=>{value.segments[0].annotation.number=2;},value=>{value.segments[0].annotation.start=1;},
      value=>{value.segments[0].annotation.end=1;},value=>{value.segments[0].annotation.quote='Invented quote';},
      value=>{value.segments[0].annotation.comment='';},value=>{value.segments[0].annotation.comment='x'.repeat(4001);},
      value=>{value.segments[0].annotation.suggestion={text:'Object instructions are invalid'};},
      value=>{value.segments[0].annotation.suggestion='x'.repeat(4001);},
    ].map(change=>{const value=valid();change(value);return value;}),
    model(Array.from({length:241},()=>({text:'x',category:'thesis'}))),
    model(Array.from({length:240},()=>({text:'x',category:'thesis',comment:'x'.repeat(2200)}))),
  ];
  for(const input of cases) {
    assert.throws(()=>buildTranscriptPdfDefinition(input));
    await assert.rejects(createTranscriptPdf(input));
  }
});

test('font selection preserves graphemes and rejects unsupported characters explicitly',()=>{
  const text='“Quoted” cafe\u0301 ★ 🚀 — text\n\tend';
  const runs=fontRuns(text);
  assert.equal(runs.map(run=>run.text).join(''),text);
  assert.ok(runs.some(run=>run.font==='RehearsalSymbols'&&run.text.includes('★')));
  assert.ok(runs.some(run=>run.font==='RehearsalEmoji'&&run.text.includes('🚀')));
  assert.ok(runs.some(run=>run.text.includes('e\u0301')),'a combining grapheme stays together');
  assert.throws(()=>fontRuns('Unsupported \uE000'),error=>error.code==='PDF_UNSUPPORTED_CHARACTER'&&error.codePoint===0xE000);
});

test('export captures an immutable snapshot before asynchronous font loading and rendering',async()=>{
  const input=model([{text:'ORIGINAL SNAPSHOT',category:'thesis',comment:'ORIGINAL NOTE'}]);
  const output=createTranscriptPdf(input);
  input.text='MUTATED CONTENT';input.segments[0].text='MUTATED CONTENT';
  input.segments[0].annotation.comment='MUTATED NOTE';
  await inspect(await output,async({pages})=>{
    const text=pages.map(page=>page.text).join(' ');
    assert.match(text,/ORIGINAL SNAPSHOT/);assert.match(text,/ORIGINAL NOTE/);assert.doesNotMatch(text,/MUTATED/);
  });
});
