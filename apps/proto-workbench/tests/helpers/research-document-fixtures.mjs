// Tiny independently generated fixtures: Office archives use stored entries;
// PDF has a real cross-reference table and selectable text on two pages.
function crc32(bytes) { let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
export function zip(entries) {
  const local=[],central=[];let offset=0;
  for(const [name,text] of Object.entries(entries)) {
    const nameBytes=Buffer.from(name),data=Buffer.from(text),crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(nameBytes.length,26);
    local.push(header,nameBytes,data);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(nameBytes.length,28);record.writeUInt32LE(offset,42);central.push(record,nameBytes);offset+=header.length+nameBytes.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function pdfFixture() {
  const stream=text=>`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",stream("BT /F1 12 Tf 40 740 Td (Research evidence on page one.) Tj ET"),stream("BT /F1 12 Tf 40 740 Td (Mean = 6; sample SD = 3.1623.) Tj ET")];
  let text="%PDF-1.4\n";const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
const paragraph=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
export const docxFixture=(text="Hello &amp; evidence")=>zip({"word/document.xml":`<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body>${paragraph(text)}<w:tbl><w:tr><w:tc>${paragraph("Group")}</w:tc><w:tc>${paragraph("Value")}</w:tc></w:tr></w:tbl>${paragraph("After table")}</w:body></w:document>`,"word/footnotes.xml":`<w:footnotes xmlns:w="urn:test"><w:footnote>${paragraph("A cited footnote")}</w:footnote></w:footnotes>`});
export const xlsxFixture=()=>zip({
  "xl/workbook.xml":'<workbook xmlns:r="urn:relationship"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/><sheet name="Metadata" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml":'<sst><si><t>Scientific label</t></si></sst>',
  "xl/worksheets/sheet1.xml":'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>6</v></c><c r="C1"><f>SUM(B1:B2)</f><v>10</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><r><t>Rich </t></r><r><t>text</t></r></is></c><c r="B2"><v>4</v></c></row></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml":'<worksheet><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>'
});
