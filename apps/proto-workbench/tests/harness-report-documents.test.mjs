import test from 'node:test';
import assert from 'node:assert/strict';
import {expandJsonReportBlocks} from '../src/main/services/harness-report-documents.ts';

test('literal prose and embedded JSON remain independently readable',()=>{
  const json='[{"resource_id":"toy:A","length":37}]';
  const result=expandJsonReportBlocks([`Evidence token: Literal-AbC\n\n\`\`\`json\n${json}\n\`\`\`\nReview still required.`]);
  assert.deepEqual(result.errors,[]);assert.ok(result.documents.includes(json));
  assert.ok(result.documents.some(text=>text.includes('Evidence token: Literal-AbC')));
  assert.ok(result.documents.some(text=>text.includes('Review still required.')));
  assert.ok(result.documents.every(text=>!text.includes('```')));
});
test('multiple JSON blocks, indentation, tildes and longer closing fences work',()=>{
  const result=expandJsonReportBlocks(['  ~~~JSON\n{"a":1}\n  ~~~~\n\n```\n[{"b":2}]\n```']);
  assert.deepEqual(result.errors,[]);assert.ok(result.documents.includes('{"a":1}'));assert.ok(result.documents.includes('[{"b":2}]'));
});
test('invalid or unclosed declared JSON cannot disappear beside a good block',()=>{
  for(const broken of ['```json\n{"bad":\n```','```json\n{"bad":1}','```json\n"scalar"\n```']){
    assert.ok(expandJsonReportBlocks(['```json\n{"good":1}\n```\n'+broken]).errors.length);
  }
});
test('ordinary code text is preserved and JSON tokens inside it are not extracted',()=>{
  const code='```text\nnot JSON\n~~~json\n{"example":1}\n~~~\n```';
  assert.deepEqual(expandJsonReportBlocks([code]),{documents:[code],errors:[]});
});
test('valid bare JSON is preserved byte for byte including duplicate keys',()=>{
  const raw='{"resource_id":"toy:A","length":-37,"length":37,"note":"```json"}';
  assert.deepEqual(expandJsonReportBlocks([raw]),{documents:[raw],errors:[]});
});
test('JSON block count is bounded across every input document',()=>{
  const report=Array.from({length:129},()=> '```json\n{}\n```').join('\n');
  assert.ok(expandJsonReportBlocks([report]).errors.some(message=>message.includes('128')));
});

test('prose on opposite sides of a JSON block cannot share a record section',()=>{
  const report='# Resource toy:A\n```json\n{"resource_id":"toy:B","length":37}\n```\nlength:37';
  assert.deepEqual(expandJsonReportBlocks([report]),{documents:['# Resource toy:A','{"resource_id":"toy:B","length":37}','length:37'],errors:[]});
});
