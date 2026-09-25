'use strict';
const {app,BrowserWindow,dialog,session}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'runtime.json'),'utf8'));
config.workspace=path.resolve(__dirname,config.workspace);
app.setName('Chem Workbench');
app.setPath('userData',path.join(config.workspace,'build','desktop-user-data'));
let server,window,origin;
function stop(){if(server){server.kill();server=null;}}
app.on('before-quit',stop);
app.on('window-all-closed',()=>app.quit());
app.whenReady().then(()=>{
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  server=spawn(config.python,['-m','chem_workbench.web','--port','0'],{
    cwd:config.workspace,windowsHide:true,
    env:{...process.env,PYTHONPATH:path.join(config.workspace,'src'),CHEM_PSI4_PREFIX:config.psi4},stdio:['ignore','pipe','pipe']
  });
  const log=fs.createWriteStream(path.join(config.workspace,'build','desktop-server.log'),{flags:'a'});
  server.stderr.pipe(log);let output='';
  server.on('error',error=>{dialog.showErrorBox('Backend unavailable',error.message);app.quit();});
  server.on('exit',code=>{if(window&&!window.isDestroyed()&&code!==0)dialog.showErrorBox('Backend stopped','The local compiler process stopped. Restart the Workbench.');});
  server.stdout.on('data',chunk=>{
    output+=chunk.toString();const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(!match||window)return;
    origin=match[0];
    const localResource=url=>url.startsWith(origin+'/')||url.startsWith('blob:'+origin+'/');
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!localResource(details.url)}));
    session.defaultSession.on('will-download',(event,item)=>{
      if(!localResource(item.getURL())){event.preventDefault();return;}
      const directory=path.join(config.workspace,'build','exports');
      fs.mkdirSync(directory,{recursive:true});
      const filename=path.basename(item.getFilename()).replace(/[^a-zA-Z0-9._-]/g,'_');
      item.setSavePath(path.join(directory,require('node:crypto').randomUUID()+'-'+filename));
    });
    window=new BrowserWindow({width:1500,height:1000,minWidth:920,minHeight:650,title:'Chem Workbench',backgroundColor:'#f4f7f5',
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
    window.webContents.on('will-prevent-unload',event=>{
      const choice=dialog.showMessageBoxSync(window,{type:'question',buttons:['Keep editing','Discard and close'],defaultId:0,cancelId:0,message:'This workspace has unsaved changes.'});
      if(choice===1)event.preventDefault();
    });
    window.removeMenu();window.loadURL(origin+'/');
  });
});
