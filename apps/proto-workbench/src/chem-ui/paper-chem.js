/* Presentation adapter only: original chemistry controls and event handlers stay mounted. */
(() => {
  'use strict';
  const root = document.documentElement;
  const sidebar = document.querySelector('.sidebar');
  const main = document.querySelector('main');
  if (!sidebar || !main) return;
  // file:// Electron renderers have an opaque "null" origin. The recipient
  // still verifies this frame's source and exact bridge origin.
  const parentTarget = window.__CHEM_PARENT_ORIGIN__ === 'null' ? '*' : window.__CHEM_PARENT_ORIGIN__;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const paths = {
    cube:'M8 3 2.5 6.2v7.6L8 17l5.5-3.2V6.2L8 3Zm-5.5 3.2L8 9.5l5.5-3.3M8 9.5V17',
    layers:'m2 5 6-3 6 3-6 3-6-3Zm0 4 6 3 6-3M2 13l6 3 6-3',
    chart:'M2 2v13h13M4 11l3-4 3 2 4-6',
    document:'M4 2h6l4 4v10H4V2Zm6 0v4h4M6 9h6M6 12h6',
    sequence:'M2 4h12M2 8h8M2 12h12M5 2v4M10 6v4M7 10v4',
    history:'M3 4a6 6 0 1 1-1 7M2 1v4h4M8 5v4l3 2',
    code:'m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14',
  };
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 17 18'); svg.setAttribute('fill','none');
    svg.setAttribute('stroke','currentColor'); svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');
    path.setAttribute('d',paths[name] || paths.layers); path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round');
    svg.append(path); return svg;
  }
  function updateCanvas() {
    // The existing viewer has a shared classic-script binding. Keep atom colors,
    // coordinates, current camera, representation and exports under its ownership.
    if (typeof chemViewer !== 'undefined' && chemViewer) {
      chemViewer.setBackgroundColor(getComputedStyle(root).getPropertyValue('--science-canvas').trim());
      if(typeof chemViewer.resize==='function')chemViewer.resize();
      chemViewer.render();
    }
  }
  function setTheme(theme) {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    updateCanvas();
  }
  function setSidebar(expanded) {
    root.dataset.chemSidebar = expanded ? 'expanded' : 'rail';
  }
  const requestedTheme = new URLSearchParams(location.search).get('theme');
  setTheme(requestedTheme || window.__CHEM_THEME__ || 'light');
  setSidebar(window.__CHEM_SIDEBAR_EXPANDED__ !== false);
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.__CHEM_PARENT_ORIGIN__) return;
    if(event.data?.type==='proto:chem-navigate') {navigateFromHost(event.data.target);return;}
    if (!['proto:chem-theme','workbench:theme'].includes(event.data?.type)) return;
    if(event.data.hostNavigation===true)root.dataset.chemHostNavigation='true';
    if (['light','dark'].includes(event.data.theme)) setTheme(event.data.theme);
    if (typeof event.data.sidebarExpanded === 'boolean') setSidebar(event.data.sidebarExpanded);
  });
  document.addEventListener('geometry-display-changed',updateCanvas);
  // The retained Design/Structure handlers bind Ctrl+Enter at document level.
  // A document-only workspace must not trigger their hidden calculation action.
  window.addEventListener('keydown',event=>{
    if(document.body.dataset.chemView==='xdl' && (event.ctrlKey || event.metaKey) && event.key==='Enter') {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  },true);

  const name=element('div','chem-workspace-name','WORKSPACE');
  name.hidden=true;
  sidebar.prepend(name);
  const switcher=document.querySelector('.studio-switch');
  if (switcher) name.after(switcher);
  const design=document.getElementById('open-design-studio');
  const structure=document.getElementById('open-structure-studio');
  for (const [button,label,glyph] of [[design,'Design','D'],[structure,'Structure','S']]) {
    if (!button) continue;
    button.setAttribute('aria-label',label); button.title=label;
    const compact=element('span','chem-mode-glyph',glyph); compact.setAttribute('aria-hidden','true');
    button.replaceChildren(element('span','chem-mode-label',label),compact);
  }
  const nav=element('nav','chem-nav-group'); nav.setAttribute('aria-label','Chemistry workspace sections');
  (switcher || name).after(nav);

  const configurations={
    design:[['Spatial explorer','.viewport-panel','cube'],['Candidates','#design-libraries','layers'],['Refinement','#design-refinement-workflow','sequence'],['Interface reactions','.interface-section','chart'],['Study evidence','#design-evidence','document']],
    structure:[['Spatial explorer','.viewport-panel','cube'],['Calculations','.execution-panel','chart'],['Structure lab','.structure-lab-panel','sequence'],['Source & evidence','.workarea','code'],['Project revisions','.project-panel','history'],['Diagnostics','.diagnostics','document']],
  };
  let xdlMounted=false;
  let lastHostNavigation='';
  let activeMode=document.body.dataset.studio || 'design';
  const xdlHost=element('section'); xdlHost.id='chem-xdl-workspace'; xdlHost.hidden=true; main.append(xdlHost);
  function announceSection(section,title) {
    if(window.parent!==window && parentTarget) window.parent.postMessage({type:'chem:navigation',section,title},parentTarget);
  }
  function showMain() { document.body.dataset.chemView='chemistry'; xdlHost.hidden=true; }
  function navigateFromHost(target) {
    if(!target || !['design','structure','xdl'].includes(target.view) || typeof target.section!=='string' || !Number.isSafeInteger(target.revision))return;
    const identity=JSON.stringify(target);if(identity===lastHostNavigation)return;lastHostNavigation=identity;
    root.dataset.chemHostNavigation='true';
    if(target.view==='xdl'){xdlButton.click();return;}
    if(designDock){
      showMain();
      const panels={spatial:target.view==='structure'?'source':'design',lab:'geometry',source:'source',calculations:'calculate',refinement:'refine',candidates:'design',interfaces:'design'};
      designDock.select(panels[target.section]||'design');
      if(['candidates','interfaces'].includes(target.section))requestAnimationFrame(()=>document.querySelector(target.section==='candidates'?'#design-libraries':'.interface-section')?.scrollIntoView({block:'start',behavior:'instant'}));
      else window.scrollTo({top:0});
      return;
    }
    (target.view==='structure'?structure:design)?.click();
    const anchors={spatial:'.viewport-panel',candidates:'#design-libraries',interfaces:'.interface-section',refinement:'#design-refinement-workflow',calculations:'.execution-panel',lab:'.structure-lab-panel',source:'.workarea'};
    const selector=anchors[target.section];
    if(selector)requestAnimationFrame(()=>{
      const node=document.querySelector(selector);if(!node)return;
      node.closest('details')?.setAttribute('open','');
      node.scrollIntoView({block:'start',behavior:'instant'});
    });
  }
  function selectAnchor(button,target) {
    for(const other of nav.querySelectorAll('button')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current','page');
    announceSection(activeMode,button.textContent);
    const node=document.querySelector(target);
    if(!node) return;
    const details=node.closest('details'); if(details) details.open=true;
    node.classList.add('chem-anchor-target'); node.tabIndex=-1;
    node.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    node.focus({preventScroll:true});
  }
  function refreshNavigation() {
    activeMode=document.body.dataset.studio || 'design';
    showMain(); nav.replaceChildren(element('p','chem-nav-title',activeMode==='design'?'DESIGN WORKSPACE':'STRUCTURE WORKSPACE'));
    for(const [label,target,glyph] of configurations[activeMode] || configurations.design) {
      const button=element('button','chem-section-link'); button.type='button'; button.append(icon(glyph),element('span','',label));
      button.title=label; button.setAttribute('aria-label',label);
      button.onclick=()=>{showMain();xdlButton.removeAttribute('aria-current');selectAnchor(button,target);};
      nav.append(button);
    }
    nav.querySelector('button')?.setAttribute('aria-current','page');
    if (document.querySelector('.heading h1')) document.querySelector('.heading h1').textContent='Chemical design';
    if (document.querySelector('.heading .eyebrow')) document.querySelector('.heading .eyebrow').textContent='DESIGN WORKSPACE';
    if (document.querySelector('.heading .subtitle')) document.querySelector('.heading .subtitle').textContent='Explore candidates. Shape a structure. Inspect the evidence.';
    xdlButton.removeAttribute('aria-current');
    announceSection(activeMode,'Design');
  }
  const xdlButton=element('button','chem-xdl-link'); xdlButton.type='button';
  xdlButton.title='XDL documents'; xdlButton.setAttribute('aria-label','XDL documents');
  xdlButton.append(icon('code'),element('span','','XDL documents'));
  nav.after(xdlButton);
  xdlButton.onclick=()=>{
    if(!xdlMounted && window.ChemXDL?.mount) { window.ChemXDL.mount(xdlHost); xdlMounted=true; }
    if(!xdlMounted) { xdlHost.replaceChildren(element('h1','','XDL documents'),element('p','','The XDL document reader is loading. Select this workspace again once it is ready.')); }
    document.body.dataset.chemView='xdl'; xdlHost.hidden=false;
    const filename=document.getElementById('filename'); if(filename) filename.textContent='XDL documents';
    const origin=document.getElementById('source-origin'); if(origin) origin.textContent='DOCUMENT WORKSPACE';
    for(const other of nav.querySelectorAll('button')) other.removeAttribute('aria-current');
    xdlButton.setAttribute('aria-current','page');
    announceSection('xdl','XDL documents');
    window.scrollTo({top:0});
  };
  const examples=document.getElementById('examples');
  if(examples) {
    const details=element('details','chem-examples'); details.append(element('summary','','Example source files'),examples);
    xdlButton.after(details);
    examples.addEventListener('click',()=>{showMain();refreshNavigation();});
  }
  const bottom=element('div','chem-sidebar-bottom');
  bottom.append(element('p','','Models propose. Tools derive. Evidence stays inspectable.'),element('small','','Local chemistry workspace'));
  sidebar.append(bottom);
  for(const button of [design,structure]) {
    button?.addEventListener('click',showMain,true);
    button?.addEventListener('click',()=>{refreshNavigation();window.scrollTo({top:0});});
  }
  const designDock=mountDesignDock();
  function mountDesignDock() {
    const grid=document.querySelector('.studio-grid'),viewport=document.querySelector('.viewport-panel');
    if(!grid||!viewport)return null;
    const dock=element('aside','chem-design-inspector'),bar=element('div','chem-inspector-tabs');bar.setAttribute('role','tablist');bar.setAttribute('aria-label','Design inspector');
    const head=element('div','chem-inspector-heading');head.append(element('strong','','Inspector'));
    const collapse=element('button','','Hide');collapse.type='button';collapse.setAttribute('aria-label','Hide design inspector');head.append(collapse);
    dock.append(head,bar);grid.append(dock);grid.classList.add('chem-unified-design-grid');
    const restore=element('button','chem-show-inspector','Inspector');restore.type='button';restore.setAttribute('aria-label','Show design inspector');viewport.querySelector('.viewport-header')?.append(restore);
    collapse.onclick=()=>{grid.classList.add('chem-inspector-closed');updateCanvas();};restore.onclick=()=>{grid.classList.remove('chem-inspector-closed');updateCanvas();};
    const configs=[
      ['design','Design','design',['.design-panel']],
      ['source','Source','structure',['.editor-panel']],
      ['geometry','Geometry','structure',['.structure-lab-panel','.project-panel']],
      ['calculate','Calculate','structure',['.execution-panel']],
      ['refine','Refine','design',['#design-refinement-workflow']],
      ['evidence','Evidence','structure',['.metrics','.evidence-panel','.diagnostics']],
      ['plan','Plan','structure',['.agent-panel']],
    ];
    const panels=new Map();let evidenceDomains;
    const select=id=>{
      const config=configs.find(item=>item[0]===id);if(!config)return;
      if(id!=='evidence'&&document.body.dataset.studio!==config[2]) (config[2]==='structure'?structure:design)?.click();
      if(id==='evidence'&&evidenceDomains){const isDesign=document.body.dataset.studio==='design';evidenceDomains.design.hidden=!isDesign;evidenceDomains.structure.hidden=isDesign;}
      grid.classList.remove('chem-inspector-closed');
      for(const [key,{button,panel}] of panels){const active=key===id;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;panel.hidden=!active;}
      announceSection('design',id==='design'?'Design':`Design · ${config[1]}`);updateCanvas();
    };
    for(const [id,label,_mode,selectors] of configs){
      const button=element('button','',label);button.type='button';button.id=`chem-inspector-tab-${id}`;button.setAttribute('role','tab');button.setAttribute('aria-controls',`chem-inspector-${id}`);button.onclick=()=>select(id);
      const panel=element('section','chem-inspector-page');panel.id=`chem-inspector-${id}`;panel.hidden=id!=='design';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);
      for(const selector of selectors){const node=document.querySelector(selector);if(node){node.classList.remove('structure-only','design-only');panel.append(node);}}
      if(id==='evidence'){
        const structureEvidence=element('div','chem-evidence-domain');structureEvidence.append(element('h3','','Compiled source evidence'));
        for(const child of [...panel.children])structureEvidence.append(child);
        const designEvidence=element('div','chem-evidence-domain');designEvidence.append(element('h3','','Design study evidence'),element('p','','Original study record and module execution evidence. Changing the selected candidate does not create a new calculation.'));
        const record=document.getElementById('design-evidence')?.closest('details');if(record)designEvidence.append(record);
        const trace=document.getElementById('design-module-trace');if(trace)designEvidence.append(trace);
        panel.append(designEvidence,structureEvidence);evidenceDomains={design:designEvidence,structure:structureEvidence};
      }
      if(id==='source'){
        const examples=document.getElementById('examples');if(examples){const exampleList=element('details','chem-source-examples');exampleList.append(element('summary','','Example structures'),examples);panel.prepend(exampleList);}
        const compile=document.getElementById('compile');if(compile){compile.classList.remove('structure-only');panel.prepend(compile);}
      }
      if(id==='refine'){const note=element('p','chem-runtime-note','Advanced refinement requires its recorded backend observations and optimizer binding. Preparation reports any missing prerequisites.');panel.prepend(note);}
      bar.append(button);dock.append(panel);panels.set(id,{button,panel});
    }
    bar.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const ids=[...panels.keys()],active=ids.findIndex(id=>panels.get(id).button.getAttribute('aria-selected')==='true');const next=event.key==='Home'?0:event.key==='End'?ids.length-1:(active+(event.key==='ArrowRight'?1:ids.length-1))%ids.length;select(ids[next]);panels.get(ids[next]).button.focus();});
    document.querySelector('.workarea')?.remove();
    select('design');
    return {select};
  }
  refreshNavigation();
  document.title='Chem CLI · Chemistry workspace';
  for(const node of document.querySelectorAll('footer > span')){if(node.textContent.includes('STRUCTURE STUDIO'))node.textContent='CHEM WORKBENCH  /  DESIGN';}
  if(window.parent!==window && parentTarget) window.parent.postMessage({type:'chem:ready'},parentTarget);
})();
