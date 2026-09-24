import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importResearchDocument, parseResearchDocument, readResearchDocument } from "../src/main/services/research-documents.ts";
import { ResearchChatService } from "../src/main/services/research-chat.ts";

import { zip, pdfFixture, docxFixture, xlsxFixture } from "./helpers/research-document-fixtures.mjs";

test("PDF extraction retains independently verified page numbers and text",async()=>{
  const result=await parseResearchDocument(pdfFixture(),"pdf");
  assert.equal(result.units.length,2);assert.equal(result.units[0].page,1);assert.match(result.units[1].text,/Mean = 6/);assert.equal(result.units[1].locator,"Page 2");
});
test("DOCX preserves paragraph/table order, footnotes and literal XML entities",async()=>{
  const result=await parseResearchDocument(docxFixture(),"docx");
  assert.deepEqual(result.units.map(item=>item.text),["Hello & evidence","Group\tValue","After table","A cited footnote"]);
  assert.equal(result.units[1].kind,"table-row");assert.match(result.units[3].locator,/footnotes/);
});
test("XLSX retains real sheet/cell references and cached formulas without evaluating them",async()=>{
  const result=await parseResearchDocument(xlsxFixture(),"xlsx");
  assert.equal(result.units.length,2);assert.equal(result.units[0].sheet,"Results");
  assert.equal(result.units[0].range,"A1:C2");assert.equal(result.units[0].locator,"Sheet Results · A1:C2");
  const cells=result.units[0].cells;assert.equal(cells[0].value,"Scientific label");assert.equal(cells[2].formula,"SUM(B1:B2)");assert.equal(cells[2].value,"10");assert.equal(cells[3].value,"Rich text");
  assert.match(result.warnings.join("\n"),/hidden/);assert.equal(result.units[1].cells[0].value,"TRUE");
});
test("source bytes and complete extraction persist; large text paginates without silent loss",async()=>{
  const workspace=await mkdtemp(join(tmpdir(),"proto-document-"));const text="Evidence ".repeat(4000);const bytes=docxFixture(text);
  const doc=await importResearchDocument({workspace,sessionId:randomUUID(),name:"study.docx",base64:bytes.toString("base64")});
  assert.equal(doc.content.length,12000);assert.ok(doc.extraction.totalCharacters>doc.content.length);assert.equal(doc.extraction.complete,true);
  assert.deepEqual(await readFile(join(workspace,doc.extraction.sourcePath)),bytes);
  assert.equal(doc.sourceSha256,createHash("sha256").update(bytes).digest("hex"));
  const units=[];let next=0;while(next!==null){const page=await readResearchDocument(workspace,doc,next,1);units.push(...page.units);next=page.nextUnit;}
  assert.equal(units.filter(unit=>unit.paragraph===1).map(unit=>unit.text).join(""),text);
  await writeFile(join(workspace,doc.extraction.extractionPath),"{}");await assert.rejects(readResearchDocument(workspace,doc),/extraction changed/);
});
test("Office rejects entity declarations, invalid archive paths and expansion bombs",async()=>{
  const entity=zip({"word/document.xml":'<!DOCTYPE document [<!ENTITY x "expanded">]><w:document xmlns:w="x"><w:body><w:p>&x;</w:p></w:body></w:document>'});
  await assert.rejects(parseResearchDocument(entity,"docx"),/entity declarations/);
  await assert.rejects(parseResearchDocument(zip({"../word/document.xml":"bad"}),"docx"),/invalid relative path|unsafe/);
  const bomb=docxFixture();const marker=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bomb.writeUInt32LE(70*1024*1024,marker+24);
  await assert.rejects(parseResearchDocument(bomb,"docx"),/expansion|size mismatch/);
});
test("workspace containment and attachment type reject unrelated or unsupported inputs",async()=>{
  const workspace=await mkdtemp(join(tmpdir(),"proto-doc-boundary-"));
  await assert.rejects(importResearchDocument({workspace,sessionId:randomUUID(),path:"../outside.pdf"}),/inside/);
  await assert.rejects(importResearchDocument({workspace,sessionId:randomUUID(),name:"macros.xlsm",base64:"YQ=="}),/PDF, DOCX or XLSX/);
  await assert.rejects(importResearchDocument({workspace,sessionId:randomUUID(),name:"bad.pdf",base64:"YQ=="}),/not a PDF/);
  await assert.rejects(importResearchDocument({workspace,sessionId:randomUUID(),name:"bad.pdf",base64:"YQ===x"}),/base64/);
});
test("Chat attachment and workspace imports expose paginated documents; source cannot be overwritten",async t=>{
  const workspace=await mkdtemp(join(tmpdir(),"proto-doc-chat-"));
  const service=new ResearchChatService({workspace,databasePath:join(workspace,"chat.sqlite"),runtime:{}});t.after(()=>service.close());
  const {session}=await service.request({action:"create"});
  const imported=await service.request({action:"import",sessionId:session.id,name:"results.xlsx",base64:xlsxFixture().toString("base64")});
  const doc=imported.session.documents[0];const page=await service.request({action:"document_read",sessionId:session.id,documentId:doc.id});assert.equal(page.documentPage.units[0].cells[1].value,"6");
  await assert.rejects(service.request({action:"document",sessionId:session.id,documentId:doc.id,expectedRevision:1,name:"results.md",content:"overwrite"}),/preserved/);
  const exported=await service.request({action:"export",sessionId:session.id,documentId:doc.id,expectedRevision:1});assert.match(exported.exportPath,/extracted\.txt$/);
  await writeFile(join(workspace,"paper.pdf"),pdfFixture());const importedPdf=await service.request({action:"read",sessionId:session.id,path:"paper.pdf"});assert.equal(importedPdf.session.documents[1].extraction.unitCount,2);
  const notebook=await service.request({action:"document",sessionId:session.id,name:"analysis.ipynb",content:'{"cells":[],"nbformat":4,"nbformat_minor":5}'});assert.equal(notebook.session.documents[2].name,"analysis.ipynb");
});

// Reusable, non-sensitive acceptance files for local UI and native verification.
if(process.env.PROTO_DOCUMENT_FIXTURE_DIR){const destination=process.env.PROTO_DOCUMENT_FIXTURE_DIR;await mkdir(destination,{recursive:true});for(const [name,data] of [["research-evidence.pdf",pdfFixture()],["research-notes.docx",docxFixture()],["research-results.xlsx",xlsxFixture()]])await writeFile(join(destination,name),data);}
