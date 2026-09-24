import type {Plugin} from "vite";
import {resolve} from "node:path";
import {ChemScienceService} from "../main/services/chem-science.ts";
import {acquirePreviewExecutionJournal} from "./preview-execution-journal.ts";

const services=new Map<string,ChemScienceService>();
const journals=new Map<string,ReturnType<typeof acquirePreviewExecutionJournal>>();
export function previewChemScience(workspace:string):ChemScienceService {
  const root=resolve(workspace);
  let service=services.get(root);
  if(!service) {const ledger=acquirePreviewExecutionJournal(root);journals.set(root,ledger);service=new ChemScienceService({repoRoot:root,workspacePath:root,journal:ledger.journal});services.set(root,service);}
  return service;
}
export function chemSciencePreview():Plugin {
  return {name:"proto-chem-science",configureServer(server){
    const root=resolve(server.config.root,"../.."),service=previewChemScience(root),ownedLedger=journals.get(root);
    server.httpServer?.once("close",()=>{if(services.get(root)===service)services.delete(root);void service.close().finally(()=>{ownedLedger?.close();if(journals.get(root)===ownedLedger)journals.delete(root);});});
    server.middlewares.use(async(req,res,next)=>{
      if(req.url?.split("?")[0]!=="/__proto/chem-science")return next();
      res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");
      const host=req.headers.host??"";
      if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)||req.headers.origin!==`http://${host}`||req.headers["sec-fetch-site"]==="cross-site") {
        res.statusCode=403;res.end(JSON.stringify({ok:false,error:{code:"ORIGIN",message:"Loopback same-origin access required."}}));return;
      }
      if(req.method!=="POST"||req.url?.includes("?")||req.headers["content-type"]!=="application/json") {
        res.statusCode=405;res.end(JSON.stringify({ok:false,error:{code:"METHOD",message:"Use the chemistry workspace."}}));return;
      }
      const controller=new AbortController();
      res.once("close",()=>{if(!res.writableEnded)controller.abort();});
      try {
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw new Error("Chemistry input exceeds 2 MiB.");chunks.push(chunk);}
        const result=await service.request(JSON.parse(Buffer.concat(chunks).toString("utf8")),controller.signal);
        if(!res.destroyed)res.end(JSON.stringify(result));
      } catch(error){if(!res.destroyed){res.statusCode=400;res.end(JSON.stringify({ok:false,error:{code:"REQUEST",message:error instanceof Error?error.message:String(error)}}));}}
    });
  }};
}
