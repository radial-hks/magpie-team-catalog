(async () => {
  const app = document.getElementById("app"), session = document.querySelector('meta[name="catalog-session"]').content
  try { const q=new URLSearchParams(location.search).get("t"); if(q){ const theme=JSON.parse(decodeURIComponent(escape(atob(q)))); for(const[k,v]of Object.entries(theme.tokens??{}))if(typeof v==="string"&&v)document.documentElement.style.setProperty("--"+k,v); if(theme.dark)document.documentElement.style.colorScheme="dark" } } catch {}
  let view = null, snapshot = null, draft = {}, expired = false, busy = false, tab = "tools", query = "", source = "", kind = "", status = "", client = "", refreshPromise = null
  const collapsedGroups = new Set()
  const notice = CatalogUI.node("div", "", "notice"); notice.setAttribute("role", "status"); notice.hidden=true
  const draftDirty = () => !CatalogViewModel.equal(draft, snapshot?.options.overrides ?? {})
  const editorOpen = () => !!document.querySelector("dialog.editor-dialog") || !!document.querySelector('form[data-dirty="true"]')
  function notify(text, level="info") { notice.textContent=text; notice.className="notice "+level; notice.hidden=!text }
  async function recoverSession() {
    if(expired)return; expired=true
    notify("插件已重载，页面会话需要更新。未保存修改仍保留，请重新加载后继续。", "error")
    const bar=CatalogUI.node("div", undefined, "notice bar");bar.append(CatalogUI.node("span","页面会话已过期"), CatalogUI.button("重新加载页面",async()=>{ if(!draftDirty()&&!editorOpen()||await CatalogUI.confirm("重新加载页面？","未保存的表单和本机覆盖将丢失。",{danger:true,accept:"重新加载"}))location.reload() })); document.body.prepend(bar)
    if(!draftDirty()&&!editorOpen())location.reload()
  }
  const api=createCatalogAPI({token:document.querySelector('meta[name="catalog-token"]').content,onExpired:recoverSession})
  const manager=createCatalogManager({api,refresh,notify}), projectsManager=createProjectManager({api,refresh,notify})
  async function refresh() {
    if(refreshPromise)return refreshPromise
    refreshPromise=(async()=>{
      try {
        const next=await(await fetch("/state")).json();if(next.session&&next.session!==session){recoverSession();return}if(next.error)throw Error(next.error)
        const settings=await api("/ui-options")
        // 背景刷新不能覆盖正在编辑的覆盖；首次才初始化。
        if(!snapshot||!draftDirty()&&!app.querySelector('form[data-dirty="true"]')){draft=structuredClone(settings.options.overrides??{});snapshot=settings}
        view=next;if(!app.querySelector('form[data-dirty="true"]'))render()
      }catch(e){notify("刷新失败："+e.message,"error");if(!view){app.replaceChildren(notice,CatalogUI.button("重试",refresh))}}
    })().finally(()=>{refreshPromise=null});return refreshPromise
  }
  function render() {
    if(!view)return
    app.replaceChildren()
    const hero=CatalogUI.node("header",undefined,"hero"), title=CatalogUI.node("div");title.append(CatalogUI.node("h1","团队目录"),CatalogUI.node("p","CLI 工具 · Git 项目 · P4 工作区｜本机注册与团队声明分离","hint"))
    const actions=CatalogUI.node("div",undefined,"bar");const rerun=CatalogUI.button(busy?"正在检查…":"立即重跑探测",rerunProbe);rerun.disabled=busy||expired;actions.append(rerun,CatalogUI.button("刷新视图",refresh));hero.append(title,actions);app.append(hero)
    const stats=CatalogUI.node("div",undefined,"stats");for(const[label,value]of [["CLI 工具",view.tools.length],["项目 / 工作区",view.projects.length],["本机已发现",view.tools.filter(t=>["present","configured","outdated"].includes(t.status)).length+view.projects.filter(p=>p.local?.status==="present").length],["需关注",view.tools.filter(t=>["missing","outdated","unknown"].includes(t.status)).length+view.projects.filter(p=>["missing","unbound","not-repository","unknown"].includes(p.local?.status??"unknown")).length]]){const card=CatalogUI.node("div",undefined,"stat");card.append(CatalogUI.node("strong",String(value)),CatalogUI.node("span",label,"hint"));stats.append(card)}app.append(stats)
    app.append(notice)
    if(view.warnings?.length)app.append(CatalogUI.node("p",view.warnings.join("\n"),"notice warning"))
    const tabs=CatalogUI.node("nav",undefined,"tabs");tabs.setAttribute("role","tablist");for(const[value,label]of [["tools",`工具 ${view.tools.length}`],["projects",`项目 ${view.projects.length}`],["settings","插件设置"]]){const b=CatalogUI.button(label,()=>{tab=value;query="";source="";kind="";status="";client="";render()});b.setAttribute("role","tab");b.setAttribute("aria-selected",String(tab===value));tabs.append(b)}app.append(tabs)
    if(tab==="settings"){renderSettings();return}
    const filters=CatalogUI.node("div",undefined,"filters"), search=document.createElement("input");search.type="search";search.placeholder=tab==="tools"?"搜索工具、包名或用法":"搜索项目、路径、Client 或 Depot";search.value=query;search.setAttribute("aria-label","搜索目录")
    const list=CatalogUI.node("div",undefined,"entries")
    const makeSelect=(label,values,current,set)=>{const s=document.createElement("select");s.setAttribute("aria-label",label);for(const[v,text]of values){const o=CatalogUI.node("option",text);o.value=v;s.append(o)}s.value=current;s.onchange=()=>{set(s.value);renderList()};return s}
    filters.append(search,makeSelect("来源",[["","全部来源"],["team","团队"],["local","本机"]],source,v=>source=v),makeSelect("类型",[["","全部类型"],...(tab==="tools"?["npm","binary","pipx","pip","brew"]:["git","p4","directory"]).map(v=>[v,v])],kind,v=>kind=v),makeSelect("状态",[["","全部状态"],...(tab==="tools"?["present","missing","outdated","unknown","configured","disabled"]:["present","unbound","missing","unknown","not-repository"]).map(v=>[v,CatalogViewModel.statusLabel(v)])],status,v=>status=v))
    if(tab==="projects")filters.append(makeSelect("P4 工作区",[["","全部工作区"],...new Set(view.projects.map(p=>p.p4?.client).filter(Boolean))].map(v=>Array.isArray(v)?v:[v,v]),client,v=>client=v))
    const count=CatalogUI.node("span","","hint"), head=CatalogUI.node("div",undefined,"section-head"), controls=CatalogUI.node("div",undefined,"bar");(tab==="tools"?manager:projectsManager).mount(controls);head.append(count,controls);app.append(filters,head,list)
    search.oninput=()=>{query=search.value;renderList()}
    function renderList(){
      list.replaceChildren();const entries=CatalogViewModel.filter(tab==="tools"?view.tools:view.projects,{query,source,kind,status}).filter(p=>!client||p.p4?.client===client);count.textContent=`显示 ${entries.length} / ${tab==="tools"?view.tools.length:view.projects.length} 条`
      if(!entries.length){list.append(CatalogUI.node("p","没有匹配条目。调整筛选，或新增本机注册。","empty"));return}
      if(tab==="tools")for(const t of entries)list.append(toolCard(t));else for(const group of CatalogViewModel.groups(entries)){const d=document.createElement("details");d.className="group";d.open=!collapsedGroups.has(group.key);d.ontoggle=()=>{if(d.open)collapsedGroups.delete(group.key);else collapsedGroups.add(group.key)};const summary=CatalogUI.node("summary");summary.append(CatalogUI.node("strong",group.title),CatalogUI.node("span",`${group.subtitle} · ${group.projects.length} 条`,"hint"));d.append(summary);const items=CatalogUI.node("div",undefined,"entries");for(const p of group.projects)items.append(projectCard(p));d.append(items);list.append(d)}
    }
    renderList();if(draftDirty())draftBar()
    const checked=CatalogUI.node("p",`最近检查：${view.checkedAt?new Date(view.checkedAt).toLocaleString():"尚未完成"}${view.freshness?.stale?" · 快照待更新":""}`,"hint");checked.style.marginTop="16px";app.append(checked)
  }
  function baseCard(entry,status){const card=CatalogUI.node("article",undefined,"entry");card.dataset.id=entry.id;const head=CatalogUI.node("div",undefined,"entry-head"),text=CatalogUI.node("div"),name=CatalogUI.node("div",undefined,"entry-name");name.append(CatalogUI.node("h3",entry.name||entry.id),CatalogUI.node("span",entry.source==="local"?"本机":"团队","tag"));text.append(name,CatalogUI.node("div",entry.id,"entry-id"));head.append(text,CatalogUI.badge(status));card.append(head);return card}
  function toolCard(tool){const card=baseCard(tool,tool.status);card.append(CatalogUI.node("div",[tool.kind,tool.version?`v${tool.version}`:"版本未知",tool.package,tool.via].filter(Boolean).join(" · "),"entry-meta hint"));if(tool.path)card.append(CatalogUI.node("div",tool.path,"path"));if(tool.usage)card.append(CatalogUI.node("p",tool.usage.slice(0,160),"entry-summary"));CatalogUI.details(card,"安装 / 更新说明",tool.install);const actions=CatalogUI.node("div",undefined,"bar entry-actions");actions.append(CatalogUI.button("本机覆盖",()=>editOverride(tool)));if(tool.source==="local")manager.rowActions(actions,tool.id);card.append(actions);return card}
  function projectCard(p){const card=baseCard(p,p.local?.status??(p.localPath?"unknown":"unbound"));card.append(CatalogUI.node("div",[p.kind,p.local?.branch,p.local?.head?.slice(0,12)].filter(Boolean).join(" · "),"entry-meta hint"));if(p.localPath)card.append(CatalogUI.node("div",p.localPath,"path"));if(p.p4?.depotPath)card.append(CatalogUI.node("div",p.p4.depotPath,"path"));CatalogUI.details(card,"项目地址与说明",[p.vcs??p.url,p.note,p.p4?.view?.join("\n")].filter(Boolean).join("\n\n"));const actions=CatalogUI.node("div",undefined,"bar entry-actions");projectsManager.rowActions(actions,p);card.append(actions);return card}
  function editOverride(tool){
    const editor=CatalogUI.editor(`本机覆盖 · ${tool.name||tool.id}`,"仅本机生效；恢复自动会移除状态钉死。不会修改团队注册或安装工具。"), fields=CatalogUI.section(editor.form,"覆盖配置"), cur=draft[tool.id]??{}
    const bin=CatalogUI.field(fields,"启动路径覆盖",cur.bin??"",{wide:true,placeholder:tool.path??"留空使用自动查找"}), enabled=CatalogUI.field(fields,"启用",cur.enabled===false?"off":"on",{choices:[["on","启用"],["off","禁用"]]}), pin=CatalogUI.field(fields,"状态模式",cur.status??"",{choices:[["","自动探测"],...["present","configured","outdated","missing","unknown"].map(v=>[v,`手工指定：${v}`])],hint:"手工状态不是实测，建议保持自动"})
    editor.actions.append(CatalogUI.button("恢复自动",()=>{bin.value="";enabled.value="on";pin.value="";editor.setDirty()}))
    editor.bindSave("应用到待保存修改",async()=>{const value={};if(bin.value.trim())value.bin=bin.value.trim();if(enabled.value==="off")value.enabled=false;if(pin.value)value.status=pin.value;if(Object.keys(value).length)draft[tool.id]=value;else delete draft[tool.id];render();notify("覆盖已暂存，请点击保存本机覆盖")});editor.show()
  }
  function draftBar(){const bar=CatalogUI.node("div",undefined,"draft-bar");bar.append(CatalogUI.node("span","本机覆盖有未保存修改"));const buttons=CatalogUI.node("div",undefined,"bar");buttons.append(CatalogUI.button("放弃修改",async()=>{if(await CatalogUI.confirm("放弃覆盖修改？","恢复到最近读取的配置，不修改磁盘。",{danger:true,accept:"放弃修改"})){draft=structuredClone(snapshot.options.overrides??{});render()}}),CatalogUI.button("保存本机覆盖",saveOverrides,{primary:true}));bar.append(buttons);app.append(bar)}
  async function saveOverrides(){
    try{const savingDraft=structuredClone(draft);const savingSnapshot=snapshot;await api("/options",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({overrides:savingDraft,revision:savingSnapshot.revision})});savingSnapshot.options.overrides=savingDraft;notify("覆盖已保存，宿主将重载并重新检查","success");await refresh()}catch(e){notify(e.message,"error")}
  }
  async function rerunProbe(){if(busy||expired)return;if(app.querySelector('form[data-dirty="true"]')){notify("请先保存设置或切换页面并确认放弃修改，再重跑探测","error");return}busy=true;render();notify("后台检查已启动，正在等待新快照…");const before=view?.checkedAt
    try{await api("/refresh",{method:"POST"});const deadline=Date.now()+60000;let done=false;while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));try{const next=await(await fetch("/state")).json();if(next.session&&next.session!==session){recoverSession();return}if(!next.error&&next.checkedAt!==before){view=next;done=true;break}}catch{}}notify(done?"检查完成":"检查仍在后台运行，可稍后刷新视图",done?"success":"info")}catch(e){notify(e.message,"error")}finally{busy=false;render()}}
  function renderSettings(){
    const panel=CatalogUI.node("div",undefined,"entry");panel.append(CatalogUI.node("h2","插件设置"),CatalogUI.node("p","更改配置会触发宿主重载；个人注册文件保留。未知高级配置键不会被此表单覆盖。","hint"));app.append(panel)
    const options=snapshot.options, form=CatalogUI.node("form",undefined,"editor-form"), fields=CatalogUI.section(form,"数据源与检查")
    const registry=CatalogUI.field(fields,"团队 registry",options.registry??"./registry/registry.yaml",{wide:true,hint:"本地路径、HTTP 文件或 Git spec"}), local=CatalogUI.field(fields,"个人注册文件",options.localRegistry===false?"":options.localRegistry??"",{wide:true,hint:"留空使用默认状态目录；必须在插件目录外"})
    const enabled=CatalogUI.field(fields,"个人注册层",options.localRegistry===false?"off":"on",{choices:[["on","开启"],["off","关闭（保留个人文件）"]]}), interval=CatalogUI.field(fields,"检查周期（秒）",options.interval??900,{type:"number"}), timeout=CatalogUI.field(fields,"单命令超时（毫秒）",options.probeTimeoutMs??5000,{type:"number"}), concurrency=CatalogUI.field(fields,"并发检查数",options.concurrency??8,{type:"number"})
    const advanced=CatalogUI.section(form,"高级分发与回退",{advanced:true}), magpie=CatalogUI.field(advanced,"magpie 可执行路径",options.magpieBin??"",{wide:true}), show=CatalogUI.field(advanced,"索引中显示未安装",String(options.showMissing??false),{choices:[["false","关闭"],["true","开启"]]}), inject=CatalogUI.field(advanced,"提示词索引注入",String(options.injectIndex??false),{choices:[["false","关闭（推荐）"],["true","开启（回退）"]]}), skills=CatalogUI.field(advanced,"Skill 导出",String(options.skillExport??false),{choices:[["false","关闭"],["true","开启"]]}), repo=CatalogUI.field(advanced,"skillsRepo",options.skillsRepo??"",{wide:true}), prefix=CatalogUI.field(advanced,"Skill 前缀",options.skillPrefix??"")
    const syncSettings = () => { local.disabled=enabled.value==="off" }; enabled.onchange=syncSettings;syncSettings()
    let dirty=false;form.addEventListener("input",()=>{dirty=true;form.dataset.dirty="true"});form.addEventListener("change",()=>{dirty=true;form.dataset.dirty="true"})
    const error=CatalogUI.node("p","","form-error");error.setAttribute("role","alert");form.append(error)
    const actions=CatalogUI.node("div",undefined,"actions");actions.append(CatalogUI.button("保存插件设置",async()=>{
      error.textContent="";const controls=[...form.querySelectorAll("input,textarea,select")];const flags=controls.map(e=>e.disabled);controls.forEach(e=>e.disabled=true);try{if(draftDirty())throw Error("请先保存或放弃本机覆盖，避免交叉覆盖配置");const settings={registry:registry.value.trim(),localRegistry:enabled.value==="off"?false:local.value.trim(),interval:Number(interval.value),probeTimeoutMs:Number(timeout.value),concurrency:Number(concurrency.value),magpieBin:magpie.value.trim(),showMissing:show.value==="true",injectIndex:inject.value==="true",skillExport:skills.value==="true",skillsRepo:repo.value.trim(),skillPrefix:prefix.value.trim()};await api("/options",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({settings,revision:snapshot.revision})});dirty=false;delete form.dataset.dirty;notify("设置已保存，页面将随宿主重载恢复","success");await refresh()}catch(e){error.textContent=e.message}finally{controls.forEach((e,i)=>e.disabled=flags[i])}}, {primary:true}));form.append(actions);panel.append(form)
    if(view.index)CatalogUI.details(panel,"当前目录索引（默认不注入提示词）",view.index)
    // 页签切换不丢弃未保存设置。
    form.onsubmit=e=>{e.preventDefault();actions.querySelector("button").click()}
    for(const b of app.querySelectorAll('[role="tab"]')){const original=b.onclick;b.onclick=async()=>{if(b.getAttribute("aria-selected")==="true")return;if(!dirty||await CatalogUI.confirm("放弃未保存设置？","切换页面会丢弃当前设置表单输入。",{danger:true,accept:"放弃修改"}))await original()}}
  }
  setInterval(async()=>{if(expired||busy)return;try{const next=await(await fetch("/state")).json();if(next.session&&next.session!==session){recoverSession();return}if(!next.error&&next.checkedAt!==view?.checkedAt&&!draftDirty()&&!editorOpen()&&tab!=="settings"){view=next;render()}}catch{}},5000)
  await refresh()
})()
