import assert from "node:assert/strict";
import test from "node:test";
import { sourceSelection, quoteOccurrences } from "../src/renderer/research-claim-selection.ts";

test("identical wording retains distinct original offsets including overlapping occurrences", () => {
  assert.deepEqual(quoteOccurrences("mean 8; mean 8", "mean 8"), {ranges:[
    {start:0,end:6,quote:"mean 8"},{start:8,end:14,quote:"mean 8"}],truncated:false});
  assert.deepEqual(quoteOccurrences("aaaa", "aa").ranges.map(item=>item.start),[0,1,2]);
});
test("DOM offsets retain Unicode and line endings without normalized citation drift", () => {
  const text="A🧪\r\ne\u0301 / é";
  assert.deepEqual(sourceSelection(text,1,3),{start:1,end:3,quote:"🧪"});
  assert.equal(sourceSelection(text,1,2),undefined);
  assert.equal(sourceSelection(text,2,3),undefined);
  assert.deepEqual(quoteOccurrences(text,"é").ranges.map(item=>item.start),[10]);
  assert.deepEqual(sourceSelection(text,5,7),{start:5,end:7,quote:"e\u0301"});
});
test("empty, fabricated and out-of-range selections cannot become citations", () => {
  for(const [start,end] of [[-1,2],[0,9],[1,1],[2,1],[NaN,2],[0,Infinity],[0,1.5]])
    assert.equal(sourceSelection("abc",start,end),undefined);
  assert.equal(sourceSelection(" \r\n ",0,4),undefined);
  assert.deepEqual(quoteOccurrences("actual source", "invented source"),{ranges:[],truncated:false});
});
test("large ambiguous selections report a bounded list instead of implying uniqueness", () => {
  const result=quoteOccurrences("x".repeat(101),"x");
  assert.equal(result.ranges.length,100);assert.equal(result.truncated,true);
  assert.deepEqual(sourceSelection("x".repeat(101),100,101),{start:100,end:101,quote:"x"});
});
