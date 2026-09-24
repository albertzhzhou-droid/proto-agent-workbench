import type { Plugin } from "vite";
import { resolve } from "node:path";
import { ChemWorkbenchService } from "../main/services/chem-workbench.ts";

export function chemWorkbenchPreview(): Plugin {
  return {name:"proto-chem-workbench",configureServer(server){
    const repoRoot=resolve(server.config.root,"../..");
    const profile:unknown=JSON.parse(server.config.define?.__PROTO_TYPOGRAPHY_PROFILE__ ?? "null");
    if(profile!=="public" && profile!=="local")throw new Error("Chem preview typography profile is not pinned.");
    const service=new ChemWorkbenchService({repoRoot,workspacePath:repoRoot,uiRoot:resolve(server.config.root,"runtime/chem-ui-profiles",profile)});
    server.httpServer?.once("close",()=>{void service.close();});
    server.middlewares.use(async(req,res,next)=>{
      if(req.url!=="/__proto/chem")return next();
      res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","application/json");
      const host=req.headers.host ?? "",origin=`http://${host}`;
      if(req.method!=="GET" || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin && req.headers.origin!==origin || req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"]!=="same-origin"){
        res.statusCode=403;res.end(JSON.stringify({available:false,error:"Open Chem CLI from the local Workbench."}));return;
      }
      try{res.end(JSON.stringify(await service.start(origin)));}catch(error){res.statusCode=503;res.end(JSON.stringify({available:false,error:error instanceof Error?error.message:"Chem workspace unavailable."}));}
    });
  }};
}
