import {mkdir,writeFile} from 'node:fs/promises';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
const root=join(process.cwd(),'evals/datasheet-fact/fixtures');await mkdir(root,{recursive:true});
const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
const page=pdf.addPage([600,800]);
for(const [i,text] of ['AX17 Datasheet - synthetic evaluation fixture - revision B',
 'Recommended VDD operating range: 3.0 to 3.6 V at 25 C.',
 'Absolute maximum VDD rating: 4.0 V.',
 'Absolute maximum ratings are stress limits, not normal operating conditions.'].entries())page.drawText(text,{x:30,y:740-i*40,size:14,font});
await writeFile(join(root,'AX17-datasheet.pdf'),await pdf.save());
console.log('Wrote synthetic PDF fixture. No third-party document redistributed.');
const schematicRoot=join(process.cwd(),'evals/schematic-visual/fixtures');await mkdir(schematicRoot,{recursive:true});
const canvas=createCanvas(1000,700),ctx=canvas.getContext('2d');
ctx.fillStyle='white';ctx.fillRect(0,0,1000,700);ctx.fillStyle='black';ctx.strokeStyle='black';ctx.lineWidth=3;ctx.font='26px sans-serif';
ctx.fillText('Synthetic schematic: U1 digital outputs',40,45);
ctx.strokeRect(90,160,250,400);ctx.fillText('U1 MCU',160,205);
ctx.fillText('PB7',260,292);ctx.fillText('PA9',260,442);
ctx.beginPath();ctx.moveTo(340,285);ctx.lineTo(500,285);ctx.stroke();
ctx.strokeRect(500,270,120,30);ctx.fillText('R1 330R',500,245);
ctx.beginPath();ctx.moveTo(620,285);ctx.lineTo(760,285);ctx.stroke();
ctx.beginPath();ctx.moveTo(760,265);ctx.lineTo(795,285);ctx.lineTo(760,305);ctx.closePath();ctx.stroke();
ctx.beginPath();ctx.moveTo(795,260);ctx.lineTo(795,310);ctx.moveTo(795,285);ctx.lineTo(880,285);ctx.lineTo(880,355);ctx.moveTo(850,355);ctx.lineTo(910,355);ctx.moveTo(860,365);ctx.lineTo(900,365);ctx.moveTo(870,375);ctx.lineTo(890,375);ctx.stroke();
ctx.fillText('D1 LED',725,230);ctx.fillText('GND',845,410);
ctx.beginPath();ctx.moveTo(340,435);ctx.lineTo(800,435);ctx.stroke();ctx.fillText('J2 TX',805,443);
await writeFile(join(schematicRoot,'board.png'),canvas.toBuffer('image/png'));
