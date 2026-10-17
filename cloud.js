(function () {
  'use strict';

  let api;
  let currentUser;
  let currentProfile;
  let profiles = [];
  let authMode = 'login';
  let started = false;
  let loadedUserId = '';
  let flushTimer;
  const pendingWrites = new Map();

  const qs = selector => document.querySelector(selector);

  function authMessage(message, success = false) {
    const box = qs('#authError');
    box.textContent = message || '';
    box.classList.toggle('show', Boolean(message));
    box.style.background = success ? '#eef8f2' : '#fff0ed';
    box.style.color = success ? '#265a3c' : '#9f2d1e';
  }

  function readableAuthError(error) {
    const message = String(error?.message || error || 'Não foi possível concluir o acesso.');
    if (/invalid login credentials/i.test(message)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(message)) return 'Confirme seu e-mail antes de entrar.';
    if (/already registered|already been registered/i.test(message)) return 'Este e-mail já possui cadastro.';
    if (/password/i.test(message) && /least|characters|weak/i.test(message)) return 'A senha precisa ter pelo menos 6 caracteres.';
    if (/rate limit/i.test(message)) return 'Muitas tentativas. Aguarde um pouco e tente novamente.';
    return message;
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    qs('#loginTab').classList.toggle('active', !signup);
    qs('#signupTab').classList.toggle('active', signup);
    qs('#nameField').hidden = !signup;
    qs('#authTitle').textContent = signup ? 'Crie seu acesso' : 'Entrar no Lucro na Mesa';
    qs('#authSubtitle').textContent = signup ? 'Um cadastro simples para acessar sua empresa.' : 'Use seu e-mail e sua senha para continuar.';
    qs('#authSubmit').textContent = signup ? 'Criar minha conta' : 'Entrar';
    qs('#authPassword').autocomplete = signup ? 'new-password' : 'current-password';
    authMessage('');
  }

  function setupAuth() {
    qs('#loginTab').onclick = () => setAuthMode('login');
    qs('#signupTab').onclick = () => setAuthMode('signup');
    qs('#authForm').onsubmit = async event => {
      event.preventDefault();
      const email = qs('#authEmail').value.trim();
      const password = qs('#authPassword').value;
      const name = qs('#authName').value.trim();
      const submit = qs('#authSubmit');
      authMessage('');
      submit.disabled = true;
      submit.textContent = 'Aguarde…';
      try {
        if (authMode === 'signup') {
          const { data, error } = await api.auth.signUp({
            email,
            password,
            options: { data: { full_name: name || email.split('@')[0] } }
          });
          if (error) throw error;
          if (!data.session) {
            authMessage('Cadastro criado. Abra o e-mail de confirmação e depois entre no aplicativo.', true);
            setAuthMode('login');
            qs('#authEmail').value = email;
          }
        } else {
          const { data, error } = await Promise.race([api.auth.signInWithPassword({ email, password }), new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo esgotado na autenticação.')), 12000))]);
          if (error) throw error;
          if (!data?.session?.user) throw new Error('O servidor não retornou uma sessão válida.');
          await handleSession(data.session);
        }
      } catch (error) {
        authMessage(readableAuthError(error));
      } finally {
        submit.disabled = false;
        submit.textContent = authMode === 'signup' ? 'Criar minha conta' : 'Entrar';
      }
    };
    qs('#resetPassword').onclick = async () => {
      const email = qs('#authEmail').value.trim();
      if (!email) {
        authMessage('Digite seu e-mail para receber o link de recuperação.');
        qs('#authEmail').focus();
        return;
      }
      const { error } = await api.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      authMessage(error ? readableAuthError(error) : 'Enviamos o link de recuperação para seu e-mail.', !error);
    };
  }

  function showAuth() {
    qs('#appShell').hidden = true;
    qs('#authShell').hidden = false;
    loadedUserId = '';
  }

  function showApp() {
    qs('#authShell').hidden = true;
    qs('#appShell').hidden = false;
    qs('#accountEmail').textContent = (currentUser.email || '') + (currentProfile?.role === 'admin' ? ' · ADMIN' : ' · CLIENTE');
    syncAdminShortcut();
  }

  function normalizeData(data, name, type) {
    const value = data && typeof data === 'object' ? data : blankData(name, type);
    value.company = name || value.company || 'Minha empresa';
    value.type = type || value.type || 'Estabelecimento';
    value.inputs = Array.isArray(value.inputs) ? value.inputs : [];
    value.products = Array.isArray(value.products) ? value.products : [];
    value.fixedCosts = Array.isArray(value.fixedCosts) ? value.fixedCosts : [];
    value.pricingRule = value.pricingRule || { type: '', value: null };
    value.menu = value.menu || null;
    return value;
  }

  async function loadProfile() {
    const { data, error } = await api.from('profiles').select('id,email,full_name,role,created_at,subscription_expires_at').eq('id', currentUser.id).single();
    if (error) throw error;
    currentProfile = data;
    profiles = [data];
    if (data.role === 'admin') {
      const result = await api.from('profiles').select('id,email,full_name,role,created_at,subscription_expires_at').order('full_name');
      if (result.error) throw result.error;
      profiles = result.data || [];
    }
  }

  async function createFirstBusiness() {
    const admin = currentProfile.role === 'admin';
    const name = admin ? 'Super Huay Express' : 'Minha empresa';
    const type = admin ? 'Hamburgueria' : 'Estabelecimento';
    const data = admin ? structuredClone(defaults) : blankData(name, type);
    const result = await api.from('businesses').insert({ owner_id: currentUser.id, name, type, data }).select().single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function loadBusinesses() {
    let result = await api.from('businesses').select('id,owner_id,name,type,data,created_at,updated_at').order('name');
    if (result.error) throw result.error;
    if (!result.data?.length) result = { data: [await createFirstBusiness()] };
    const businesses = result.data.map(row => ({
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      type: row.type,
      data: normalizeData(row.data, row.name, row.type),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
    const cachedActive = sessionStorage.getItem(`lnm-active-${currentUser.id}`);
    state = { activeBusinessId: businesses.some(item => item.id === cachedActive) ? cachedActive : businesses[0].id, businesses };
    db = activeBusiness().data;
    filter = '';
    category = 'Todos';
  }

  function setSync(text, isError = false) {
    const element = qs('#syncStatus');
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('error', isError);
  }

  async function flushWrites() {
    clearTimeout(flushTimer);
    if (!pendingWrites.size) return;
    setSync('Salvando…');
    for (const [id, payload] of [...pendingWrites]) {
      const { error } = await api.from('businesses').update(payload).eq('id', id);
      if (error) {
        console.error(error);
        setSync('Falha ao sincronizar', true);
        flushTimer = setTimeout(flushWrites, 5000);
        return;
      }
      pendingWrites.delete(id);
    }
    setSync('Salvo na nuvem');
    setTimeout(() => setSync(''), 1800);
  }

  function cloudSave() {
    const business = activeBusiness();
    if (!business) return;
    business.data = db;
    business.name = db.company;
    business.type = db.type || business.type;
    business.updatedAt = new Date().toISOString();
    pendingWrites.set(business.id, {
      name: business.name,
      type: business.type,
      data: structuredClone(business.data),
      updated_at: business.updatedAt
    });
    renderAll();
    setSync('Alterações pendentes');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushWrites, 650);
  }

  function cloudCompanySwitch() {
    const select = qs('#companySelect');
    const emailById = new Map(profiles.map(item => [item.id, item.email]));
    select.innerHTML = [...state.businesses].sort((a, b) => alphaText(a.name, b.name)).map(item => {
      const owner = currentProfile.role === 'admin' && item.ownerId !== currentUser.id ? ` · ${emailById.get(item.ownerId) || 'cliente'}` : '';
      return `<option value="${item.id}" ${item.id === state.activeBusinessId ? 'selected' : ''}>${esc(item.name + owner)}</option>`;
    }).join('');
  }

  function cloudSwitchBusiness(id) {
    const business = state.businesses.find(item => item.id === id);
    if (!business) return;
    state.activeBusinessId = id;
    db = business.data;
    filter = '';
    category = 'Todos';
    sessionStorage.setItem(`lnm-active-${currentUser.id}`, id);
    renderAll();
    toast(`${business.name} selecionada`);
  }

  async function cloudCreateBusiness() {
    const form = qs('#businessForm');
    const name = form.name.value.trim();
    const type = form.type.value;
    const files = [...form.menu.files];
    if (!name) {
      toast('Informe o nome da empresa');
      return;
    }
    const data = blankData(name, type);
    const result = await api.from('businesses').insert({ owner_id: currentUser.id, name, type, data }).select().single();
    if (result.error) {
      console.error(result.error);
      toast('Não foi possível criar a empresa');
      return;
    }
    const row = result.data;
    state.businesses.push({ id: row.id, ownerId: row.owner_id, name: row.name, type: row.type, data: normalizeData(row.data, row.name, row.type), createdAt: row.created_at, updatedAt: row.updated_at });
    state.activeBusinessId = row.id;
    db = activeBusiness().data;
    filter = '';
    category = 'Todos';
    qs('#businessDialog').close();
    renderAll();
    toast(`${name} adicionada`);
    if (files.length) setTimeout(() => processMenuFiles(files), 150);
  }


  function subscriptionDate(date){if(!date)return 'Sem prazo definido';return new Date(date).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})}
  function subscriptionStatus(profile){if(profile.role==='admin')return 'Administrador';if(!profile.subscription_expires_at)return 'Sem prazo';return new Date(profile.subscription_expires_at).getTime()>Date.now()?'Ativo':'Expirado'}
  function syncAdminShortcut(){
    const shortcut=qs('#adminCentralShortcut');
    if(!shortcut)return;
    const admin=currentProfile?.role==='admin';
    shortcut.hidden=!admin;
    shortcut.style.display=admin?'inline-flex':'none';
  }
  window.openAdminCentral=function(){
    if(currentProfile?.role!=='admin'){toast('Acesso restrito ao administrador');return}
    renderCentral();
    document.querySelectorAll('.nav button,.view').forEach(x=>x.classList.remove('active'));
    qs('#centralNav')?.classList.add('active');
    qs('#central')?.classList.add('active');
    qs('#central')?.scrollIntoView({behavior:'smooth',block:'start'});
  };
  function renderCentral() {
    const nav=qs('#centralNav'),section=qs('#central'),admin=currentProfile?.role==='admin';
    syncAdminShortcut();
    nav.hidden=!admin;
    nav.style.display=admin?'inline-flex':'none';
    nav.setAttribute('aria-hidden',admin?'false':'true');
    if(!admin){section.innerHTML='';return}
    nav.title='Central de gestão de clientes e assinaturas';
    const byOwner=new Map();state.businesses.forEach(b=>byOwner.set(b.ownerId,(byOwner.get(b.ownerId)||0)+1));
    const clients=profiles.filter(p=>p.role!=='admin'),active=clients.filter(p=>subscriptionStatus(p)==='Ativo').length,expired=clients.filter(p=>subscriptionStatus(p)==='Expirado').length;
    section.innerHTML=head('Central administrativa','Gerencie clientes, períodos gratuitos e vencimentos de acesso.')+
      '<div class="stats"><div class="stat"><label>Clientes</label><strong>'+clients.length+'</strong></div><div class="stat"><label>Ativos</label><strong>'+active+'</strong></div><div class="stat"><label>Expirados</label><strong>'+expired+'</strong></div><div class="stat"><label>Empresas</label><strong>'+state.businesses.length+'</strong></div></div>'+
      '<div class="business-note"><strong>Controle de acesso:</strong> os períodos são definidos por cliente e armazenados no servidor. Quando vencem, o sistema bloqueia o acesso às empresas sem apagar os dados. A conta administrativa não expira.</div>'+
      '<div class="central-grid">'+profiles.map(p=>{const status=subscriptionStatus(p),isAdmin=p.role==='admin',date=p.subscription_expires_at;return '<article class="central-client"><h3>'+esc(p.full_name||p.email||'Usuário')+'</h3><p>'+esc(p.email||'')+'</p><p><strong>'+status+'</strong> · '+(byOwner.get(p.id)||0)+' empresa(s)</p>'+(isAdmin?'<p>Acesso administrativo permanente.</p>':'<p>Vencimento: <strong>'+subscriptionDate(date)+'</strong></p><div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">'+[30,90,180,365].map(days=>'<button type="button" class="btn small" data-sub-user="'+p.id+'" data-sub-days="'+days+'">'+(days===30?'30 dias':days===90?'3 meses':days===180?'6 meses':'1 ano')+'</button>').join('')+'</div><div class="field"><label>Definir vencimento personalizado</label><input type="date" id="subdate-'+p.id+'" value="'+(date?new Date(date).toISOString().slice(0,10):'')+'"></div><button type="button" class="btn small primary" data-sub-save="'+p.id+'">Salvar vencimento</button>')+'</article>'}).join('')+'</div>';
    section.querySelectorAll('[data-sub-user]').forEach(btn=>btn.onclick=()=>changeSubscription(btn.dataset.subUser,Number(btn.dataset.subDays)));
    section.querySelectorAll('[data-sub-save]').forEach(btn=>{btn.onclick=()=>{const v=qs('#subdate-'+btn.dataset.subSave)?.value;if(!v){toast('Selecione uma data');return}changeSubscription(btn.dataset.subSave,null,v)}});
  }
  async function changeSubscription(id,days,dateValue){
    if(currentProfile?.role!=='admin')return;
    const profile=profiles.find(p=>p.id===id&&p.role!=='admin');if(!profile)return;
    let expiry;
    if(days){expiry=new Date();expiry.setUTCDate(expiry.getUTCDate()+days)}
    else {expiry=new Date(dateValue+'T23:59:59-03:00')}
    if(!Number.isFinite(expiry.getTime())){toast('Data inválida');return}
    if(!confirm('Atualizar o acesso de '+(profile.email||profile.full_name)+' até '+subscriptionDate(expiry.toISOString())+'?'))return;
    const {data,error}=await api.rpc('admin_set_subscription',{p_user_id:id,p_expires_at:expiry.toISOString()});
    if(error){console.error(error);toast('Erro ao atualizar acesso: '+error.message);return}
    profile.subscription_expires_at=data;
    renderCentral();
    toast('Prazo de acesso atualizado');
  }
  function installCloudOverrides() {
    const localRenderAll = renderAll;
    renderCompanySwitch = cloudCompanySwitch;
    save = cloudSave;
    switchBusiness = cloudSwitchBusiness;
    createBusiness = cloudCreateBusiness;
    renderAll = function () {
      localRenderAll();
      renderCentral();
    };
  }

  async function handleSession(session) {
    if (!session?.user) {
      currentUser = null;
      currentProfile = null;
      showAuth();
      return;
    }
    if (loadedUserId === session.user.id) return;
    loadedUserId = session.user.id;
    currentUser = session.user;
    try {
      await loadProfile();
      if(currentProfile.role!=='admin'&&(!currentProfile.subscription_expires_at||new Date(currentProfile.subscription_expires_at).getTime()<=Date.now())){
        loadedUserId='';showAuth();authMessage('Seu período de acesso terminou. Entre em contato com o administrador para renovar.');return;
      }
      await loadBusinesses();
      showApp();
      renderAll();
    } catch (error) {
      console.error(error);
      loadedUserId = '';
      showAuth();
      authMessage('Falha ao carregar a conta: ' + String(error?.message || error));
    }
  }

  window.logout = async function () {
    await flushWrites();
    await api.auth.signOut();
    showAuth();
  };

  window.showConfigurationMessage = function () {
    qs('#authTitle').textContent = 'Ambiente em preparação';
    qs('#authSubtitle').textContent = 'A estrutura do aplicativo está pronta. Falta conectar o novo projeto Supabase para liberar os acessos.';
    qs('#authForm').querySelectorAll('input,button').forEach(element => element.disabled = true);
    qs('#authError').classList.add('show');
    qs('#authError').textContent = 'Configuração segura do banco ainda não aplicada.';
  };

  window.startCloudApp = async function () {
    if (started) return;
    started = true;
    const config = window.LNM_CONFIG || {};
    if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase) {
      window.showConfigurationMessage();
      return;
    }
    api = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    setupAuth();
    installCloudOverrides();
    api.auth.onAuthStateChange((_event, session) => setTimeout(() => handleSession(session), 0));
    // Sessão inicial processada pelo evento de autenticação.
  };
})();
