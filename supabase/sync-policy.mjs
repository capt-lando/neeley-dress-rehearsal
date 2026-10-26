import { readFile, writeFile, mkdir } from 'node:fs/promises';
const text=await readFile(new URL('../lib/coaching-prompt.md',import.meta.url),'utf8');
const destination=new URL('./functions/_shared/coaching-policy.json',import.meta.url);
await mkdir(new URL('./functions/_shared/',import.meta.url),{recursive:true});
await writeFile(destination,JSON.stringify({text})+'\n');
