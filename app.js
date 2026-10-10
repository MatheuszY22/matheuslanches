'use strict';
// Gerentes (acesso ao painel). A chave é o nome em minúsculas e sem acento; a senha fica só como SHA-256.
const ADMINS = {
  matheus: { name: 'Matheus', hash: 'aeefd4741ec5108880b213cef40536a41a46217b571d4857a18cf2426edcec47' },
  luciana: { name: 'Luciana', hash: '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92' },
};
const LS = 'lanchonete-v1';
const IP_HANDLE = 'matheus-tributino'; // InfiniteTag (InfinitePay), sem o $
const IP_API = 'https://api.checkout.infinitepay.io';
const IP_WEBHOOK = 'https://lm-lanches-webhook.lm-lanches-webhook.workers.dev'; // recebedor (Cloudflare): baixa o pedido mesmo se o cliente não voltar ao site
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Ícones em SVG (só apresentação)
const ICON = {
  dish: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h18"/><path d="M5 17a7 7 0 0 1 14 0"/><path d="M12 10V8"/><path d="M10 8h4"/><path d="M2 20h20"/></svg>',
  bag: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l1 12H5L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (k) => k.split('-').reverse().join('/');
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- Estoque (por produto e sabor; só controla produtos com "Controlar estoque") ---------- */
const stockId = (pid, flavor) => pid + '__' + (flavor ? String(flavor).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') : '_');
const isTracked = (p) => !!p && p.track === true;
const stockQty = (pid, flavor) => Store.data.stock.find((s) => s.id === stockId(pid, flavor))?.qty || 0;
const available = (p, flavor) => (isTracked(p) ? stockQty(p.id, flavor) : Infinity);
const availableTotal = (p) => (!isTracked(p) ? Infinity : p.flavors?.length ? p.flavors.reduce((a, f) => a + stockQty(p.id, f), 0) : stockQty(p.id, ''));
const inCart = (pid, flavor) => S.cart.filter((i) => i.productId === pid && i.flavor === flavor).reduce((a, i) => a + i.qty, 0);
const stockItems = () => Store.data.products.filter(isTracked).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((p) => (p.flavors?.length ? p.flavors : ['']).map((f) => ({ p, flavor: f, id: stockId(p.id, f), qty: stockQty(p.id, f) })));

/* ---------- Armazenamento: local (padrão) ou Firestore (se config.js tiver FIREBASE_CONFIG) ---------- */
const Store = {
  data: { products: [], orders: [], customers: [], stock: [], purchases: [], stockLog: [], settings: { pixKey: '', pixName: '', pixCity: '' } },
  cloud: !!window.FIREBASE_CONFIG,
  fs: null, onChange: () => {}, ordersUnsub: null,
  init() {
    if (this.cloud) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      this.fs = firebase.firestore();
      this.fs.collection('products').onSnapshot((s) => { this.data.products = s.docs.map((d) => d.data()); this.onChange(); });
      this.fs.collection('stock').onSnapshot((s) => { this.data.stock = s.docs.map((d) => d.data()); this.onChange(); });
      this.fs.doc('config/main').onSnapshot((d) => { if (d.exists) this.data.settings = { ...this.data.settings, ...d.data() }; this.onChange(); });
    } else {
      try { Object.assign(this.data, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) {}
      addEventListener('storage', () => { try { Object.assign(this.data, JSON.parse(localStorage.getItem(LS) || '{}')); this.onChange(); } catch (e) {} });
    }
  },
  watchOrders() { // só o administrador assina os pedidos
    if (!this.cloud || this.ordersUnsub) return;
    this.ordersUnsub = ['orders', 'purchases', 'stockLog', 'customers'].map((col) =>
      this.fs.collection(col).onSnapshot((s) => { this.data[col] = s.docs.map((d) => d.data()); this.onChange(); }));
  },
  /* Mexe no estoque e grava outros documentos (pedido, histórico) de uma vez só.
     deltas: [{ id, productId, flavor, name, delta }]; falha inteira se algum item ficar negativo. */
  async applyStock(deltas, writes = [], guard, strict = true) {
    const falta = (d, cur) => new Error('ESTOQUE:' + d.name + (d.flavor ? ' (' + d.flavor + ')' : '') + ': ' + (cur > 0 ? 'só restam ' + cur : 'acabou'));
    // guard: só aplica se o pedido ainda estiver num destes status (evita devolver o estoque duas vezes)
    const mudou = (g) => !g || !guard.status.includes(g.status);
    if (this.cloud) {
      return this.fs.runTransaction(async (tx) => {
        const refs = deltas.map((d) => this.fs.collection('stock').doc(d.id));
        const [gsnap, ...snaps] = await Promise.all([guard ? tx.get(this.fs.collection(guard.col).doc(guard.id)) : null, ...refs.map((r) => tx.get(r))]);
        if (guard && mudou(gsnap.exists ? gsnap.data() : null)) throw new Error('MUDOU');
        const next = deltas.map((d, i) => { const cur = snaps[i].exists ? snaps[i].data().qty : 0; if (strict && cur + d.delta < 0) throw falta(d, cur); return cur + d.delta; });
        deltas.forEach((d, i) => tx.set(refs[i], { id: d.id, productId: d.productId, flavor: d.flavor || '', qty: next[i] }));
        writes.forEach((w) => tx.set(this.fs.collection(w.col).doc(w.obj.id), w.obj));
      });
    }
    if (guard && mudou(this.data[guard.col].find((x) => x.id === guard.id))) throw new Error('MUDOU');
    const next = deltas.map((d) => { const cur = this.data.stock.find((s) => s.id === d.id)?.qty || 0; if (strict && cur + d.delta < 0) throw falta(d, cur); return cur + d.delta; });
    deltas.forEach((d, i) => {
      const row = { id: d.id, productId: d.productId, flavor: d.flavor || '', qty: next[i] }, k = this.data.stock.findIndex((s) => s.id === d.id);
      if (k >= 0) this.data.stock[k] = row; else this.data.stock.push(row);
    });
    writes.forEach((w) => { const arr = this.data[w.col], k = arr.findIndex((x) => x.id === w.obj.id); if (k >= 0) arr[k] = w.obj; else arr.push(w.obj); });
    this.save(); this.onChange();
  },
  // linhas de estoque de um pedido (só produtos com estoque controlado); sinal -1 baixa, +1 devolve
  stockLines(o, sinal) {
    const m = {};
    o.items.forEach((i) => {
      if (!isTracked(Store.data.products.find((p) => p.id === i.productId))) return;
      const id = stockId(i.productId, i.flavor);
      (m[id] ||= { id, productId: i.productId, flavor: i.flavor, name: i.name, delta: 0 }).delta += sinal * i.qty;
    });
    return Object.values(m);
  },
  placeOrder(order) { return this.applyStock(this.stockLines(order, -1), [{ col: 'orders', obj: order }], null, false); }, // venda nunca é barrada: o saldo pode ficar negativo
  // devolve o estoque e cancela, mas só se o pedido ainda estiver em aberto (lança 'MUDOU' se outro já mexeu)
  cancelOrder(o, reason) {
    return this.applyStock(this.stockLines(o, 1), [{ col: 'orders', obj: { ...o, status: 'cancelled', cancelledAt: Date.now(), cancelReason: reason || '' } }], { col: 'orders', id: o.id, status: ['pending'] });
  },
  save() { if (!this.cloud) localStorage.setItem(LS, JSON.stringify(this.data)); },
  async put(col, obj) {
    if (this.cloud) return this.fs.collection(col).doc(obj.id).set(obj);
    const arr = this.data[col]; const i = arr.findIndex((x) => x.id === obj.id);
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    this.save(); this.onChange();
  },
  async getCustomer(key) {
    if (this.cloud) { const d = await this.fs.collection('customers').doc(key).get(); return d.exists ? d.data() : null; }
    return (this.data.customers || []).find((c) => c.id === key) || null;
  },
  async remove(col, id) {
    if (this.cloud) return this.fs.collection(col).doc(id).delete();
    this.data[col] = this.data[col].filter((x) => x.id !== id); this.save(); this.onChange();
  },
  async setSettings(s) {
    this.data.settings = { ...this.data.settings, ...s };
    if (this.cloud) return this.fs.doc('config/main').set(this.data.settings);
    this.save(); this.onChange();
  },
};

/* ---------- Pix copia e cola (BR Code estático) ---------- */
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
const ascii = (s, n) => s.normalize('NFD').replace(/[^\x20-\x7e]/g, '').toUpperCase().slice(0, n);
function pixPayload({ key, name, city, amount, txid }) {
  const p =
    tlv('00', '01') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', key)) + tlv('52', '0000') + tlv('53', '986') +
    tlv('54', amount.toFixed(2)) + tlv('58', 'BR') + tlv('59', ascii(name, 25) || 'LANCHONETE') +
    tlv('60', ascii(city, 15) || 'BRASIL') + tlv('62', tlv('05', (txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) + '6304';
  return p + crc16(p);
}

/* ---------- Estado de tela ---------- */
const nameKey = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const readSess = () => { try { return JSON.parse(localStorage.getItem('lanche-sess')); } catch (e) { return null; } };
const ADMIN_KEY = ADMINS[sessionStorage.getItem('lanche-admin')] ? sessionStorage.getItem('lanche-admin') : '';
const IS_ADMIN = !!ADMIN_KEY;
const S = { user: IS_ADMIN ? ADMINS[ADMIN_KEY].name : readSess()?.name || '', profile: IS_ADMIN ? null : readSess(), admin: IS_ADMIN, tab: 'rel', range: '7', cart: [], askPass: false, step: 'nome', pending: null, openOrders: [], enc: { data: '', hora: '', obs: '' } };

function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 2200); }
function modal(html) { const m = $('#modal'); m.innerHTML = `<div class="box">${html}</div>`; m.classList.remove('hidden'); m.onclick = (e) => { if (e.target === m) closeModal(); }; }
function closeModal() { $('#modal').classList.add('hidden'); }

/* ---------- Render ---------- */
function render() {
  if (!S.user) return renderLogin();
  if (S.admin) return renderAdmin();
  renderMenu();
}

function renderLogin() {
  const L = (title, inner) => ($('#app').innerHTML = `<div class="login"><div class="brandbox"><img src="logo.png" alt="L&M Lanches" class="logo"><span class="eyebrow">Cardápio digital</span><h1>${title}</h1><i class="rule"></i></div><div class="form">${inner}</div></div>`);
  if (S.step === 'pin') {
    L('Confirme que é você', `<p>O nome <b>${esc(S.pending.name)}</b> já tem cadastro. Para confirmar que é você, digite os <b>4 últimos números do celular</b> cadastrado.</p>
      <input id="pin" inputmode="numeric" maxlength="4" placeholder="Últimos 4 dígitos" autocomplete="off">
      <div class="stack"><button class="btn" id="entrar">Confirmar</button><button class="btn sec" id="voltar">Não sou eu, usar outro nome</button></div>`);
    $('#entrar').onclick = confirmPin; $('#voltar').onclick = backToName; $('#pin').onkeydown = (e) => { if (e.key === 'Enter') confirmPin(); };
    return $('#pin').focus();
  }
  if (S.step === 'cad') {
    L('Seja bem-vindo', `<p>Olá, <b>${esc(S.pending.name)}</b>! Primeira vez por aqui. Cadastre seu contato uma só vez: ele fica salvo e agiliza o pagamento.</p>
      <input id="cphone" type="tel" inputmode="tel" placeholder="Celular com DDD, ex.: (64) 99999-9999" autocomplete="tel">
      <input id="cemail" type="email" placeholder="E-mail" autocomplete="email">
      <div class="stack"><button class="btn" id="entrar">Cadastrar e entrar</button><button class="btn sec" id="voltar">Voltar</button></div>`);
    $('#entrar').onclick = registerCustomer; $('#voltar').onclick = backToName; $('#cemail').onkeydown = (e) => { if (e.key === 'Enter') registerCustomer(); };
    return $('#cphone').focus();
  }
  L('Bem-vindo', `<p>Digite seu nome para ver o cardápio e fazer o pedido</p><input id="nome" placeholder="Seu nome" autocomplete="off" value="">
    ${S.askPass ? '<input id="senha" type="password" placeholder="Senha do administrador">' : ''}
    <button class="btn" id="entrar">Entrar</button>`);
  const go = async () => {
    const nome = $('#nome').value.trim().replace(/\s+/g, ' ');
    if (!nome) return toast('Digite seu nome');
    const key = nameKey(nome);
    if (ADMINS[key]) {
      if (!S.askPass) { S.askPass = true; renderLogin(); $('#nome').value = nome; $('#senha').focus(); return; }
      if ((await sha256($('#senha').value)) !== ADMINS[key].hash) return toast('Senha incorreta');
      S.admin = true; sessionStorage.setItem('lanche-admin', key); S.user = ADMINS[key].name; S.profile = null; S.askPass = false; Store.watchOrders(); return render();
    }
    try {
      const c = await Store.getCustomer(key);
      if (c && localStorage.getItem('lanche-ok:' + key)) return enterCustomer(c); // este aparelho já foi confirmado
      S.pending = { key, name: nome }; S.step = c ? 'pin' : 'cad'; renderLogin();
    } catch (e) { toast('Sem conexão. Tente de novo.'); }
  };
  $('#entrar').onclick = go;
  $('#app').querySelectorAll('input').forEach((i) => (i.onkeydown = (e) => { if (e.key === 'Enter') go(); }));
  $('#nome').oninput = () => { if (S.askPass && !ADMINS[nameKey($('#nome').value)]) { S.askPass = false; const v = $('#nome').value; renderLogin(); $('#nome').value = v; $('#nome').focus(); } };
  $('#nome').focus();
}
function backToName() { S.step = 'nome'; S.pending = null; renderLogin(); }
function enterCustomer(c) {
  S.user = c.name; S.profile = c; S.step = 'nome'; S.pending = null;
  localStorage.setItem('lanche-sess', JSON.stringify(c)); localStorage.setItem('lanche-ok:' + c.id, '1'); render(); checkOpen();
}
async function confirmPin() {
  try {
    const c = await Store.getCustomer(S.pending.key);
    if (c && (await sha256(c.id + ':' + $('#pin').value.trim())) === c.pinHash) return enterCustomer(c);
    toast('Número não confere. Se esse nome é de outra pessoa, volte e use outro nome.');
  } catch (e) { toast('Sem conexão. Tente de novo.'); }
}
async function registerCustomer() {
  const phone = $('#cphone').value.trim(), email = $('#cemail').value.trim(), d = soDigitos(phone);
  if (d.length < 10 || d.length > 11) return toast('Celular inválido: use DDD + número');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('E-mail inválido');
  try {
    const { key, name } = S.pending;
    if (await Store.getCustomer(key)) { toast('Esse nome acabou de ser cadastrado por outra pessoa.'); S.step = 'pin'; return renderLogin(); }
    const c = { id: key, name, phone, email, pinHash: await sha256(key + ':' + d.slice(-4)), createdAt: Date.now() };
    await Store.put('customers', c); enterCustomer(c);
  } catch (e) { toast('Não foi possível cadastrar. Tente de novo.'); }
}
function logout() { S.user = ''; S.profile = null; S.admin = false; S.cart = []; S.openOrders = []; S.step = 'nome'; localStorage.removeItem('lanche-sess'); sessionStorage.removeItem('lanche-admin'); render(); }
/* --- categorias: o cardápio e a lista de produtos ficam separados por tipo, nesta ordem --- */
const CAT_COMBO = 'Combos', CAT_ENC = 'Encomendas';
const CATP = [CAT_COMBO, 'Entradas', 'Refeições', 'Lanches', 'Acompanhamentos', 'Bebidas', 'Sobremesas', 'Cafés', 'Outros', CAT_ENC];
const ENC_MIN_DIAS = 1; // antecedência mínima de uma encomenda (dias)
const isEnc = (p) => (p.cat || '').trim() === CAT_ENC;
const catOf = (p) => (p.cat || '').trim() || 'Outros';
// categorias digitadas pelo gestor entram depois das fixas; "Outros" fica sempre por último
const catOrder = (c) => { if (c === CAT_ENC) return 1e9 + 1; if (c === 'Outros') return 1e9; const i = CATP.indexOf(c); return i < 0 ? CATP.length : i; };
const catId = (c) => 'cat-' + c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
function groupCats(ps) {
  const by = {}; ps.forEach((p) => (by[catOf(p)] ||= []).push(p));
  return Object.entries(by).sort((a, b) => catOrder(a[0]) - catOrder(b[0]) || a[0].localeCompare(b[0])).map(([c, l]) => [c, l.sort((x, y) => x.name.localeCompare(y.name))]);
}
const allCats = () => [...new Set(CATP.concat(Store.data.products.map(catOf)))];
function irCat(id) { const el = document.getElementById(id); if (el) window.scrollTo({ top: el.offsetTop - 132, behavior: 'smooth' }); }
/* --- cliente --- */
const out = (p) => p.active === false; // só o que a gerência pausar; estoque não limita o cliente
function renderMenu() {
  const grupos = groupCats(Store.data.products), n = S.cart.reduce((a, i) => a + i.qty, 0), tot = cartTotal();
  const card = (p) => `<div class="prod ${out(p) ? 'off' : ''} ${p.novo ? 'novo' : ''}" ${out(p) ? '' : `onclick="pick('${p.id}')"`}>${p.novo ? '<span class="selo-novo">Novidade</span>' : ''}${p.photo ? `<img src="${p.photo}" alt="">` : `<div class="ph">${ICON.dish}</div>`}
      <div class="i"><b>${esc(p.name)}</b>${p.desc ? `<small class="desc">${esc(p.desc)}</small>` : ''}<span class="pr">${out(p) ? 'Esgotado' : money(p.price)}</span>${isEnc(p) ? '<small>Sob encomenda</small>' : ''}${!out(p) && p.flavors?.length ? `<small>${p.flavors.length} sabores</small>` : ''}
      ${out(p) ? '' : `<button class="add" onclick="event.stopPropagation();pick('${p.id}')" aria-label="Adicionar ${esc(p.name)}">${p.flavors?.length ? 'Escolher sabor' : '+ Adicionar'}</button>`}</div></div>`;
  $('#app').innerHTML = `<div class="top"><div class="brand"><img src="icon-192.png" alt="" class="mini"><div><span class="eyebrow">L&amp;M Lanches</span><h1>Olá, ${esc(S.user)}</h1></div></div><button class="ghost" onclick="logout()">Sair</button></div>
    ${grupos.length > 1 ? `<div class="cats">${grupos.map(([c]) => `<button onclick="irCat('${catId(c)}')">${esc(c)}</button>`).join('')}</div>` : ''}
    <div class="wrap">${openBanner()}${grupos.length ? '' : '<p class="empty">Nenhum produto cadastrado ainda.</p>'}
    ${grupos.map(([c, ps]) => `<h2 class="cath" id="${catId(c)}">${esc(c)}</h2>${c === CAT_ENC ? '<p class="hint enc-hint">Feitos sob encomenda: escolha a data de retirada ao finalizar. Encomendas são pedidas separadas dos demais itens.</p>' : ''}<div class="grid">${ps.map(card).join('')}</div>`).join('')}<div class="pad"></div></div>
    ${n ? `<div class="cartbar" onclick="openCart()"><span>${ICON.bag} ${n} item(ns)</span><b>${money(tot)} · Ver pedido</b></div>` : ''}`;
}
const cartTotal = () => S.cart.reduce((a, i) => a + i.price * i.qty, 0);
function pick(id) {
  const p = Store.data.products.find((x) => x.id === id);
  if (!p.flavors?.length) return addCart(p, '');
  modal(`<h2>${esc(p.name)}</h2><p class="lead">Escolha o sabor:</p><div class="chips">${p.flavors.map((f, i) => `<button class="chip" onclick="pickFlavor('${id}',${i})">${esc(f)}</button>`).join('')}</div>`);
}
function pickFlavor(id, i) { const p = Store.data.products.find((x) => x.id === id); addCart(p, p.flavors[i]); }
function addCart(p, flavor) {
  if (S.cart.length && !!S.cart[0].enc !== isEnc(p)) { closeModal(); return toast(isEnc(p) ? 'Encomenda é pedida separada: finalize ou esvazie o pedido atual primeiro.' : 'Há uma encomenda no pedido. Finalize-a antes de pedir outros itens.'); }
  const l = S.cart.find((i) => i.productId === p.id && i.flavor === flavor);
  if (l) l.qty++; else S.cart.push({ productId: p.id, name: p.name, flavor, price: p.price, cost: p.cost || 0, qty: 1, enc: isEnc(p) });
  closeModal(); toast('Adicionado'); render();
}
const minEncData = () => dayKey(Date.now() + ENC_MIN_DIAS * 86400000);
const encBox = () => (S.cart[0]?.enc ? `<div class="encbox"><h3>Dados da encomenda</h3>
  <label class="lbl" for="edata">Data de retirada</label><input id="edata" type="date" min="${minEncData()}" value="${S.enc.data}" onchange="S.enc.data=this.value">
  <label class="lbl" for="ehora">Horário</label><input id="ehora" type="time" value="${S.enc.hora}" onchange="S.enc.hora=this.value">
  <label class="lbl" for="eobs">Observações (opcional)</label><input id="eobs" placeholder="Ex.: sem cebola, escrever parabéns" value="${esc(S.enc.obs)}" oninput="S.enc.obs=this.value">
  <p class="hint">Antecedência mínima: ${ENC_MIN_DIAS} dia(s).</p></div>` : '');
const limpaCarrinho = () => { S.cart = []; S.enc = { data: '', hora: '', obs: '' }; };
function openCart() {
  if (!S.cart.length) return closeModal();
  modal(`<h2>Seu pedido</h2>${S.cart.map((i, k) => `<div class="row"><div><span class="nm">${esc(i.name)}</span>${i.flavor ? ` <small>(${esc(i.flavor)})</small>` : ''}<br><small>${money(i.price)}</small></div>
    <div class="qty"><button onclick="qty(${k},-1)" aria-label="Menos">−</button>${i.qty}<button onclick="qty(${k},1)" aria-label="Mais">+</button></div></div>`).join('')}
    ${encBox()}<div class="total"><span>Total</span><b>${money(cartTotal())}</b></div>
    <div class="stack"><button class="btn" onclick="payOnline()">Pagar agora: cartão, Apple Pay, Google Pay ou Pix</button>${contato() ? `<p class="hint">Contato: ${esc(contato().phone)} · ${esc(contato().email)} <a href="#" onclick="editContato();return false">alterar</a></p>` : ''}
    <button class="btn sec" onclick="checkout('pix')">Só Pix copia e cola</button>
    <button class="btn sec" onclick="checkout('maquininha')">Pagar no cartão físico (maquininha)</button></div>`);
}
function qty(k, d) {
  S.cart[k].qty += d; if (S.cart[k].qty <= 0) S.cart.splice(k, 1); render(); openCart(); }
const soDigitos = (v) => String(v || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const contato = () => (S.profile ? { phone: S.profile.phone, email: S.profile.email } : null);
function payOnline() { checkout('infinitepay'); }
function editContato() {
  const c = contato() || { phone: '', email: '' };
  modal(`<h2>Meu contato</h2><p class="lead"><small>Esses dados vão preenchidos na tela de pagamento. Se trocar o celular, os 4 últimos dígitos novos passam a ser o seu código de acesso.</small></p>
    <input id="cphone" type="tel" inputmode="tel" placeholder="Celular com DDD" value="${esc(c.phone)}">
    <input id="cemail" type="email" placeholder="E-mail" value="${esc(c.email)}">
    <button class="btn" onclick="saveContato()">Salvar</button>`);
}
async function saveContato() {
  const phone = $('#cphone').value.trim(), email = $('#cemail').value.trim(), d = soDigitos(phone);
  if (d.length < 10 || d.length > 11) return toast('Celular inválido: use DDD + número');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('E-mail inválido');
  try {
    const c = { ...S.profile, phone, email, pinHash: await sha256(S.profile.id + ':' + d.slice(-4)) };
    await Store.put('customers', c); S.profile = c; localStorage.setItem('lanche-sess', JSON.stringify(c)); openCart();
  } catch (e) { toast('Não foi possível salvar. Tente de novo.'); }
}
function stockFail(e) {
  closeModal(); render();
  toast(String(e.message).startsWith('ESTOQUE:') ? e.message.slice(8) + '. Ajuste o pedido.' : 'Não foi possível enviar o pedido. Tente de novo.');
}
async function checkout(method) {
  const st = Store.data.settings;
  if (method === 'pix' && !st.pixKey) return toast('Pix ainda não configurado pelo Matheus');
  const enc = S.cart[0]?.enc ? { data: S.enc.data, hora: S.enc.hora, obs: (S.enc.obs || '').trim() } : null;
  if (enc && (!enc.data || enc.data < minEncData())) return toast('Escolha a data de retirada (a partir de ' + dayLabel(minEncData()) + ')');
  if (enc && !enc.hora) return toast('Escolha o horário de retirada');
  if (method === 'infinitepay' || method === 'pix') { // um pagamento online por vez: não duplica o pedido
    await checkOpen();
    const aberto = pedidoAbertoOnline();
    if (aberto) return avisoDuplicado(aberto, method);
  }
  const paused = S.cart.filter((i) => Store.data.products.find((p) => p.id === i.productId)?.active === false);
  if (paused.length) { S.cart = S.cart.filter((i) => !paused.includes(i)); render(); closeModal(); return toast(paused.map((i) => i.name).join(', ') + ' acabou e saiu do pedido'); }
  const order = { id: uid(), customer: S.user, items: S.cart.map((i) => ({ ...i })), total: cartTotal(), status: 'pending', method, createdAt: Date.now(), paidAt: null };
  if (enc) order.encomenda = enc;
  if (method === 'infinitepay') {
    $('#modal .box').innerHTML = '<h2>Abrindo o pagamento…</h2><p>Aguarde um instante.</p>';
    try {
      const r = await fetch(IP_API + '/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        handle: IP_HANDLE, order_nsu: order.id, redirect_url: location.origin + location.pathname, webhook_url: IP_WEBHOOK,
        items: order.items.map((i) => ({ quantity: i.qty, price: Math.round(i.price * 100), description: i.name + (i.flavor ? ' (' + i.flavor + ')' : '') })),
        customer: { name: order.customer, email: contato()?.email, phone_number: '+55' + soDigitos(contato()?.phone) } }) });
      const j = await r.json().catch(() => ({}));
      order.payUrl = j.url || j.link || j.checkout_url || j.payment_url || Object.values(j).find((v) => typeof v === 'string' && v.startsWith('https://') && !v.includes('app.infinitepay.io/external')) || '';
      if (!r.ok || !order.payUrl) throw new Error(j.message || 'sem link');
    } catch (e) { closeModal(); return toast('Não foi possível abrir o pagamento. Tente o Pix ou pague depois.'); }
    order.method = 'infinitepay';
    try { await Store.placeOrder(order); } catch (e) { return stockFail(e); }
    limpaCarrinho(); localStorage.setItem('lanche-pagando', order.id);
    saveOpen(openIds().concat(order.id)); // fica em aberto neste aparelho até confirmar: se o pagamento falhar, o cliente retoma sem refazer
    location.href = order.payUrl; return;
  }
  try { await Store.placeOrder(order); } catch (e) { return stockFail(e); }
  limpaCarrinho();
  if (method === 'maquininha') { render(); return modal(`<h2>${ICON.check} ${order.encomenda ? 'Encomenda registrada' : 'Pedido registrado'}</h2><p>Total de <b>${money(order.total)}</b>. ${order.encomenda ? `Retire em <b>${dayLabel(order.encomenda.data)} às ${esc(order.encomenda.hora)}</b> e pague` : 'Vá ao balcão e pague'} no <b>cartão físico</b> (maquininha), informando o nome <b>${esc(order.customer)}</b>.</p><button class="btn" onclick="closeModal()">Ok</button>`); }
  // Pix: o pedido fica em aberto neste aparelho até o cliente avisar que pagou
  saveOpen(openIds().concat(order.id)); S.openOrders.push(order); render();
  pixModal(order);
}

/* ---------- Pedido em aberto do cliente (Pix) ----------
   Fica guardado no aparelho até o cliente avisar que pagou. O aviso (clientPaid) não dá baixa: só marca para
   o Matheus ou a Luciana conferirem o comprovante no painel e confirmarem o recebimento. */
const openKey = () => 'lanche-abertos:' + (S.profile?.id || nameKey(S.user));
const openIds = () => { try { return JSON.parse(localStorage.getItem(openKey()) || '[]'); } catch (e) { return []; } };
const saveOpen = (ids) => localStorage.setItem(openKey(), JSON.stringify(ids.filter((x, i) => ids.indexOf(x) === i)));
async function getOrder(id) {
  if (Store.cloud) { const d = await Store.fs.collection('orders').doc(id).get(); return d.exists ? d.data() : null; }
  return Store.data.orders.find((o) => o.id === id) || null;
}
// Relê os pedidos guardados: pago ou cancelado sai da lista; pendente continua (com ou sem aviso de pagamento)
async function checkOpen() {
  if (!S.user || S.admin) return;
  const ids = openIds(), os = [];
  for (const id of ids) {
    try { const o = await getOrder(id); if (o && o.status === 'pending') os.push(o); }
    catch (e) { const o = S.openOrders.find((x) => x.id === id); if (o) os.push(o); } // sem conexão: mantém o que já sabia
  }
  saveOpen(os.map((o) => o.id)); S.openOrders = os;
  if (S.user && !S.admin && $('#modal').classList.contains('hidden')) renderMenu();
}
const openBanner = () => S.openOrders.map((o) => o.method === 'infinitepay'
  ? `<div class="aberto"><div><b>Pagamento não concluído · ${money(o.total)}</b><br><small>${new Date(o.createdAt).toLocaleString('pt-BR')} · ${itemsText(o)}</small></div>
    <div class="acts"><button class="btn sm" onclick="continuar('${o.id}')">Continuar o pagamento</button><button class="btn sec sm" onclick="cancelOpen('${o.id}')">Cancelar pedido</button></div></div>`
  : o.clientPaid
  ?`<div class="aberto ok"><div><b>Pix informado · ${money(o.total)}</b><br><small>${itemsText(o)} · o Matheus confere o comprovante e dá a baixa</small></div></div>`
  : `<div class="aberto"><div><b>Pedido em aberto · ${money(o.total)}</b><br><small>${new Date(o.createdAt).toLocaleString('pt-BR')} · ${itemsText(o)}</small></div>
    <div class="acts"><button class="btn sm" onclick="pixModal('${o.id}')">Pagar com Pix</button><button class="btn ok sm" onclick="clientePagou('${o.id}')">Já paguei</button></div></div>`).join('');
// Retoma o pagamento de um pedido em aberto (mesmo link da InfinitePay, ou o Pix) em vez de criar outro pedido
function continuar(id) {
  const o = S.openOrders.find((x) => x.id === id);
  if (!o) return;
  if (o.method === 'infinitepay' && o.payUrl) { location.href = o.payUrl; return; }
  closeModal(); pixModal(o);
}
async function cancelOpen(id, depois) {
  const o = S.openOrders.find((x) => x.id === id);
  if (!o) return;
  if (!depois && !confirm('Cancelar este pedido? Se você já pagou, não cancele: fale com o Matheus.')) return;
  try { await Store.cancelOrder(o, 'cliente'); } catch (e) { if (e.message !== 'MUDOU') return toast('Não foi possível cancelar. Tente de novo.'); toast('Esse pedido já foi pago ou alterado.'); }
  saveOpen(openIds().filter((x) => x !== id)); S.openOrders = S.openOrders.filter((x) => x.id !== id);
  if (!depois) { render(); toast('Pedido cancelado'); }
}
// Antes de abrir um novo pagamento online, olha se já existe um em aberto: evita pedido duplicado
function pedidoAbertoOnline() { return S.openOrders.find((x) => (x.method === 'infinitepay' || x.method === 'pix') && !x.clientPaid); }
function avisoDuplicado(o, method) {
  modal(`<h2>Você já tem um pedido aguardando pagamento</h2><p class="lead">${itemsText(o)} · <b>${money(o.total)}</b></p>
    <p class="hint">Para não duplicar, conclua esse pedido. Só cancele se quiser trocar o que pediu.</p>
    <div class="stack"><button class="btn" onclick="continuar('${o.id}')">Continuar esse pagamento</button>
    <button class="btn sec" onclick="cancelarETrocar('${o.id}','${method}')">Cancelar esse e fazer o pedido novo</button></div>`);
}
async function cancelarETrocar(id, method) {
  if (!confirm('Cancelar o pedido anterior? Se você já pagou, não cancele: fale com o Matheus.')) return;
  await cancelOpen(id, true); openCart(); checkout(method);
}
function pixModal(x) {
  const o = typeof x === 'string' ? S.openOrders.find((y) => y.id === x) : x, st = Store.data.settings;
  if (!o) return;
  const code = pixPayload({ key: st.pixKey, name: st.pixName, city: st.pixCity, amount: o.total, txid: o.id });
  let qr = ''; try { const q = qrcode(0, 'M'); q.addData(code); q.make(); qr = q.createImgTag(5, 8); } catch (e) {}
  modal(`<h2>Pague com Pix</h2><div class="total"><span>Total</span><b>${money(o.total)}</b></div><div class="qrwrap">${qr}</div>
    <div class="pix" id="pixcode">${code}</div>
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('pixcode').textContent).then(()=>toast('Pix copiado!'))">Copiar Pix copia e cola</button>
    <div class="ask"><p><b>Deu certo o pagamento?</b></p><div class="stack"><button class="btn ok" onclick="clientePagou('${o.id}')">Sim, já paguei</button><button class="btn sec" onclick="aindaNao()">Ainda não</button></div></div>
    <p class="hint">Se ainda não pagou, o pedido fica em aberto: dá para pagar depois pelo aviso no topo do cardápio ou no balcão.</p>`);
}
function aindaNao() { closeModal(); render(); toast('Pedido ficou em aberto. Pague quando puder.'); }
async function clientePagou(id) {
  let o; try { o = await getOrder(id); } catch (e) { return toast('Sem conexão. Tente de novo.'); }
  const tira = () => { saveOpen(openIds().filter((x) => x !== id)); S.openOrders = S.openOrders.filter((x) => x.id !== id); };
  if (!o) { tira(); render(); return toast('Pedido não encontrado'); }
  if (o.status === 'cancelled') { tira(); render(); return modal('<h2>Pedido cancelado</h2><p>Esse pedido foi cancelado pelo Matheus. Se você pagou, fale com ele para resolver.</p><button class="btn" onclick="closeModal()">Ok</button>'); }
  if (o.status === 'paid') { tira(); render(); return modal(`<h2>${ICON.check} Já está pago</h2><p>O pedido de <b>${money(o.total)}</b> já foi baixado. Obrigado!</p><button class="btn" onclick="closeModal()">Ok</button>`); }
  if (!o.clientPaid) {
    o = { ...o, clientPaid: true, clientPaidAt: Date.now() };
    try { await Store.put('orders', o); } catch (e) { return toast('Não foi possível avisar. Tente de novo.'); }
  }
  S.openOrders = S.openOrders.map((x) => (x.id === id ? o : x)); render();
  modal(`<h2>${ICON.check} Obrigado!</h2><p>Pedido de <b>${money(o.total)}</b> anotado como <b>pago pelo Pix</b>. O Matheus ou a Luciana conferem o comprovante e dão a baixa.</p><button class="btn" onclick="closeModal()">Ok</button>`);
}

/* --- administrador --- */
function renderAdmin() {
  const tabs = [['rel', 'Relatórios'], ['res', 'Resultado'], ['vf', 'Venda por fora'], ['prazo', 'Pendentes'], ['enc', 'Encomendas'], ['cli', 'Clientes'], ['est', 'Estoque'], ['cmp', 'Compras'], ['prod', 'Produtos'], ['cfg', 'Pix'], ['qr', 'QR do cardápio']];
  $('#app').innerHTML = `<div class="top"><div class="brand"><img src="icon-192.png" alt="" class="mini"><div><span class="eyebrow">Painel de gestão</span><h1>${esc(S.user)}</h1></div></div><button class="ghost" onclick="logout()">Sair</button></div><div class="wrap">
    <div class="tabs">${tabs.map(([k, t]) => `<button class="${S.tab === k ? 'on' : ''}" onclick="S.tab='${k}';render()">${t}</button>`).join('')}</div><div id="tab"></div></div>`;
  ({ rel: tabRel, res: tabRes, vf: tabVenda, prazo: tabPrazo, enc: tabEnc, cli: tabCli, est: tabEst, cmp: tabCmp, prod: tabProd, cfg: tabCfg, qr: tabQr })[S.tab]();
}
function tabRel() {
  const r = S.range, now = Date.now();
  const from = r === 'all' ? 0 : r === '1' ? new Date().setHours(0, 0, 0, 0) : now - Number(r) * 86400000;
  const os = Store.data.orders.filter((o) => o.createdAt >= from && o.status !== 'cancelled');
  const paid = os.filter((o) => o.status === 'paid'), pend = os.filter((o) => o.status !== 'paid'), conf = pend.filter(aConferir);
  const sum = (a) => a.reduce((x, o) => x + o.total, 0);
  const byDay = {}; os.forEach((o) => { const d = byDay[dayKey(o.createdAt)] ||= { n: 0, paid: 0, pend: 0 }; d.n++; o.status === 'paid' ? (d.paid += o.total) : (d.pend += o.total); });
  const prods = {}; os.forEach((o) => o.items.forEach((i) => { const p = prods[i.name] ||= { q: 0, v: 0 }; p.q += i.qty; p.v += i.qty * i.price; }));
  const top = Object.entries(prods).sort((a, b) => b[1].q - a[1].q), max = top[0]?.[1].q || 1;
  $('#tab').innerHTML = `<div class="toolbar">${rangeSelect()}</div>
    <div class="cards"><div class="stat click" onclick="detail('vendido')"><span>Total vendido</span><b>${money(sum(os))}</b></div><div class="stat click" onclick="detail('recebido')"><span>Recebido</span><b class="c-ok">${money(sum(paid))}</b></div>
    <div class="stat click" onclick="detail('areceber')"><span>A receber</span><b class="c-warn">${money(sum(pend))}</b></div><div class="stat click" onclick="detail('conferir')"><span>Pix informado, a conferir</span><b class="c-info">${money(sum(conf))}</b><span>${conf.length} pedido(s)</span></div><div class="stat click" onclick="detail('pedidos')"><span>Pedidos</span><b>${os.length}</b></div></div>
    <div class="panel"><h3>Vendas por dia</h3><table><tr><th>Dia</th><th class="n">Pedidos</th><th class="n">Recebido</th><th class="n">A receber</th><th class="n">Total</th></tr>
    ${Object.entries(byDay).sort().reverse().map(([k, d]) => `<tr><td>${dayLabel(k)}</td><td class="n">${d.n}</td><td class="n">${money(d.paid)}</td><td class="n">${money(d.pend)}</td><td class="n"><b>${money(d.paid + d.pend)}</b></td></tr>`).join('') || '<tr><td colspan=5>Sem vendas no período</td></tr>'}</table></div>
    <div class="panel"><h3>Produtos mais vendidos</h3>${top.map(([n, p]) => `<div class="tp"><div class="row plain"><span>${esc(n)}</span><small>${p.q} un · ${money(p.v)}</small></div><div class="bar"><i style="width:${(p.q / max) * 100}%"></i></div></div>`).join('') || '<p class="empty">Sem dados</p>'}</div>`;
}
function tabPrazo() {
  const pend = Store.data.orders.filter((o) => o.status !== 'paid' && o.status !== 'cancelled').sort((a, b) => a.createdAt - b.createdAt);
  const conf = pend.filter(aConferir), by = {};
  // mesmo cliente, mesmos itens, em menos de 30 minutos: provável pedido duplicado (pagamento que falhou e foi refeito)
  const sig = (o) => nameKey(o.customer) + '|' + o.items.map((i) => i.productId + ':' + i.flavor + ':' + i.qty).sort().join(',');
  // compara com todos os pedidos não cancelados: o caso mais comum é o pendente que ficou para trás e o refeito que foi pago
  const vivos = Store.data.orders.filter((o) => o.status !== 'cancelled'), dup = new Map();
  pend.forEach((a) => { const b = vivos.find((x) => x.id !== a.id && sig(x) === sig(a) && Math.abs(x.createdAt - a.createdAt) < 30 * 60000); if (b) dup.set(a.id, b.status === 'paid'); });
  // quem já avisou que pagou aparece primeiro: é só conferir o comprovante e dar baixa
  pend.slice().sort((a, b) => Number(aConferir(b)) - Number(aConferir(a)) || a.createdAt - b.createdAt).forEach((o) => (by[o.customer] ||= []).push(o));
  const aviso = conf.length ? `<div class="panel conf"><b>${conf.length} pedido(s) com Pix informado pelo cliente · ${money(conf.reduce((a, o) => a + o.total, 0))}</b><br><small>Confira o comprovante no extrato e clique em <b>Confirmar Pix</b> para dar a baixa. Se o Pix não caiu, clique em <b>Não caiu</b>: o pedido volta a ficar em aberto para o cliente.</small></div>` : '';
  $('#tab').innerHTML = aviso + (Object.keys(by).length ? Object.entries(by).map(([c, os]) => `<div class="panel"><div class="row plain"><h3>${esc(c)}</h3><b class="c-gold">${money(os.reduce((a, o) => a + o.total, 0))}</b></div>
    ${os.map((o) => `<div class="row ${aConferir(o) ? 'conf' : ''}"><div><small>${new Date(o.createdAt).toLocaleString('pt-BR')} <span class="tag ${aConferir(o) ? 'conf' : ''}">${ordLabel(o)}</span>${encTag(o)}${dup.has(o.id) ? ` <span class="tag dup">${dup.get(o.id) ? 'duplicado: já existe um igual pago' : 'possível duplicado'}</span>` : ''}</small><br>${o.items.map((i) => `${i.qty}× ${esc(i.name)}${i.flavor ? ` (${esc(i.flavor)})` : ''}`).join(', ')}${subConf(o)}</div>
    <div class="r"><b>${money(o.total)}</b><div class="acts col">${aConferir(o) ? `<button class="btn ok sm" onclick="markPaid('${o.id}')">Confirmar Pix</button><button class="btn sec sm" onclick="naoCaiu('${o.id}')">Não caiu</button>` : `<button class="btn ok sm" onclick="markPaid('${o.id}')">Pago</button><button class="btn del sm" onclick="cancelOrd('${o.id}')">Cancelar</button>`}</div></div></div>`).join('')}
    <div class="pfoot"><button class="btn sec sm" onclick="payAll('${esc(c).replace(/'/g, "\\'")}')">Receber tudo de ${esc(c)}</button></div></div>`).join('') : '<p class="empty">Nenhum pedido pendente.</p>');
}
// Baixa final: registra quem conferiu e por onde o dinheiro entrou
const baixa = (o) => ({ ...o, status: 'paid', paidAt: Date.now(), paidBy: S.user, paidWith: o.paidWith || (o.method === 'pix' ? 'pix' : o.method === 'maquininha' ? 'maquininha' : '') });
async function markPaid(id) { const o = Store.data.orders.find((x) => x.id === id); await Store.put('orders', baixa(o)); toast(aConferir(o) ? 'Pix conferido e pedido baixado' : 'Marcado como pago'); }
async function payAll(c) { if (!confirm(`Marcar tudo de ${c} como pago?`)) return; for (const o of Store.data.orders.filter((x) => x.customer === c && x.status !== 'paid' && x.status !== 'cancelled')) await Store.put('orders', baixa(o)); }
async function naoCaiu(id) {
  const o = Store.data.orders.find((x) => x.id === id);
  if (!confirm(`O Pix de ${o.customer} (${money(o.total)}) não apareceu no extrato? O pedido volta a ficar em aberto para o cliente.`)) return;
  await Store.put('orders', { ...o, clientPaid: false, naoCaiuEm: Date.now(), naoCaiuPor: S.user }); toast('Pedido voltou para em aberto');
}

function tabProd() {
  const linha = (p) => `<div class="panel row">
    <div class="pline">${p.photo ? `<img src="${p.photo}" class="thumb" alt="">` : `<div class="thumb ph">${ICON.dish}</div>`}<div><b>${esc(p.name)}</b> ${p.novo ? '<span class="tag nov">Novidade</span>' : ''} ${p.active === false ? '<span class="tag">pausado</span>' : ''}${p.desc ? `<br><small>${esc(p.desc)}</small>` : ''}<br><span class="c-gold">${money(p.price)}</span>${isTracked(p) ? `<small> · estoque ${availableTotal(p)}</small>` : ''}${p.flavors?.length ? `<br><small>${esc(p.flavors.join(', '))}</small>` : ''}</div></div>
    <div class="acts col"><button class="btn sm ${p.active === false ? 'ok' : 'sec'}" onclick="toggleProd('${p.id}')">${p.active === false ? 'Ativar' : 'Pausar'}</button><button class="btn sec sm" onclick="toggleNovo('${p.id}')">${p.novo ? 'Tirar destaque' : 'Marcar novidade'}</button><button class="btn sec sm" onclick="editProd('${p.id}')">Editar</button></div></div>`;
  $('#tab').innerHTML = `<div class="toolbar"><button class="btn" onclick="editProd()">+ Novo produto</button></div>${groupCats(Store.data.products).map(([c, ps]) => `<h3 class="cath">${esc(c)} <small>(${ps.length})</small></h3>${ps.map(linha).join('')}`).join('') || '<p class="empty">Nenhum produto ainda.</p>'}`;
}
async function toggleProd(id) {
  const p = Store.data.products.find((x) => x.id === id);
  await Store.put('products', { ...p, active: p.active === false });
  toast(p.active === false ? 'Produto ativado' : 'Produto pausado');
}
async function toggleNovo(id) {
  const p = Store.data.products.find((x) => x.id === id);
  await Store.put('products', { ...p, novo: !p.novo });
  toast(p.novo ? 'Destaque de novidade removido' : 'Marcado como novidade');
}
let editPhoto = '';
function editProd(id) {
  const p = Store.data.products.find((x) => x.id === id) || { name: '', price: '', cost: '', flavors: [], photo: '', active: true, track: true, cat: '', novo: false };
  editPhoto = p.photo || '';
  const cat = (p.cat || '').trim();
  modal(`<h2>${id ? 'Editar' : 'Novo'} produto</h2>
    <label class="lbl" for="pn">Nome</label><input id="pn" placeholder="Ex.: Filé ao molho madeira" value="${esc(p.name)}">
    <label class="lbl" for="pdesc">Descrição (opcional)</label><input id="pdesc" placeholder="Ex.: 1 pizza média + 1 Coca-Cola lata" value="${esc(p.desc || '')}">
    <label class="lbl" for="pcat">Categoria</label>
    <div class="catpick" id="catpick">${allCats().map((c) => `<button type="button" class="${c === cat ? 'on' : ''}" onclick="setCat(this)">${esc(c)}</button>`).join('')}</div>
    <input id="pcat" list="cats" placeholder="Ou digite uma nova categoria" value="${esc(cat)}" autocomplete="off" oninput="syncCat(this.value)"><datalist id="cats">${allCats().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="two"><div><label class="lbl" for="pp">Venda (R$)</label><input id="pp" type="number" step="0.01" min="0" placeholder="0,00" value="${p.price}"></div>
    <div><label class="lbl" for="pc">Custo unitário (R$)</label><input id="pc" type="number" step="0.01" min="0" placeholder="Quanto custa fazer 1" value="${p.cost || ''}"></div></div>
    <label class="lbl" for="pf">Sabores</label><input id="pf" placeholder="Separados por vírgula (deixe vazio se não tiver)" value="${esc((p.flavors || []).join(', '))}">
    <label class="lbl" for="pimg">Foto</label><div class="photo"><input id="pimg" type="file" accept="image/*" capture="environment"><img id="prev" src="${editPhoto}" alt="" style="${editPhoto ? '' : 'display:none'}"></div>
    <label class="chk"><input type="checkbox" id="pt" ${p.track === true ? 'checked' : ''}><span>Controlar estoque<small>Só vende o que foi lançado como produção</small></span></label>
    <label class="chk"><input type="checkbox" id="pnov" ${p.novo ? 'checked' : ''}><span>Novidade<small>Destaca o produto com o selo "Novidade" no cardápio</small></span></label>
    <label class="chk"><input type="checkbox" id="pa" ${p.active !== false ? 'checked' : ''}><span>Ativo<small>Desmarque para pausar no cardápio</small></span></label>
    <div class="stack"><button class="btn" onclick="saveProd('${id || ''}')">Salvar</button>${id ? `<button class="btn del" onclick="delProd('${id}')">Excluir</button>` : ''}</div>`);
  $('#pimg').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; editPhoto = await shrink(f); $('#prev').src = editPhoto; $('#prev').style.display = ''; };
}
// Botões de categoria do formulário: só preenchem o campo #pcat (que continua sendo o que é salvo)
function setCat(b) { $('#pcat').value = b.textContent; syncCat(b.textContent); if ([CAT_COMBO, CAT_ENC].includes(b.textContent)) $('#pt').checked = false; } // combo e encomenda não têm estoque próprio
function syncCat(v) { document.querySelectorAll('#catpick button').forEach((b) => b.classList.toggle('on', b.textContent === String(v).trim())); }
function shrink(file, max = 480) {
  return new Promise((res) => { const img = new Image(); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.8)); }; img.src = URL.createObjectURL(file); });
}
async function saveProd(id) {
  const name = $('#pn').value.trim(), price = parseFloat($('#pp').value);
  if (!name || isNaN(price)) return toast('Informe nome e valor');
  await Store.put('products', { id: id || uid(), name, price, flavors: $('#pf').value.split(',').map((s) => s.trim()).filter(Boolean), photo: editPhoto, active: $('#pa').checked, cost: parseFloat($('#pc').value) || 0, desc: $('#pdesc').value.trim(), track: $('#pt').checked, novo: $('#pnov').checked, cat: $('#pcat').value.trim().replace(/\s+/g, ' ') || 'Outros' });
  closeModal(); render(); toast('Produto salvo');
}
async function delProd(id) { if (!confirm('Excluir este produto?')) return; await Store.remove('products', id); closeModal(); render(); }

/* --- gestão: estoque, compras e resultado --- */
const rangeFrom = () => (S.range === 'all' ? 0 : S.range === '1' ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(S.range) * 86400000);
const rangeSelect = () => `<select onchange="S.range=this.value;render()">${[['1', 'Hoje'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['all', 'Tudo']].map(([v, t]) => `<option value="${v}" ${S.range === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
const today = () => dayKey(Date.now());
const itemName = (name, flavor) => esc(name) + (flavor ? ` <small>(${esc(flavor)})</small>` : '');
const LOG_TIPO = { producao: 'Produção', perda: 'Perda', contagem: 'Contagem' };
const logEntry = (it, type, qty, date, note) => ({ id: uid(), date, productId: it.p.id, productName: it.p.name, flavor: it.flavor, type, qty, note: note || '', createdAt: Date.now() });
const stockMsg = (e) => String(e.message).replace('ESTOQUE:', '');

function tabEst() {
  const items = stockItems(), log = Store.data.stockLog.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  $('#tab').innerHTML = `<div class="toolbar"><button class="btn" onclick="prodDia()">+ Lançar produção do dia</button><button class="btn sec" onclick="adjStock()">Perda / contagem</button></div>
    ${items.length ? projecao(items) : ''}
    ${items.length ? `<div class="panel"><h3>Estoque atual</h3><table><tr><th>Item</th><th class="n">Qtd</th><th class="n">Custo un.</th><th class="n">Valor</th></tr>
    ${items.map((it) => `<tr><td>${itemName(it.p.name, it.flavor)}</td><td class="n ${it.qty <= 0 ? 'low' : it.qty <= 5 ? 'warn' : ''}"><b>${it.qty}</b>${it.qty < 0 ? `<br><small>faltou ${-it.qty}</small>` : ''}</td><td class="n">${it.p.cost ? money(it.p.cost) : '—'}</td><td class="n">${it.p.cost ? money(Math.max(0, it.qty) * it.p.cost) : '—'}</td></tr>`).join('')}</table></div>`
      : '<div class="panel"><p class="lead" style="margin:0">Nenhum produto com estoque controlado. Em <b>Produtos → Editar</b>, marque "Controlar estoque".</p></div>'}
    <div class="panel"><h3>Últimos lançamentos</h3><table><tr><th>Data</th><th>Item</th><th>Tipo</th><th class="n">Qtd</th></tr>
    ${log.map((l) => `<tr><td>${dayLabel(l.date)}</td><td>${itemName(l.productName, l.flavor)}</td><td>${LOG_TIPO[l.type] || l.type}</td><td class="n">${l.qty > 0 ? '+' : ''}${l.qty}</td></tr>`).join('') || '<tr><td colspan=4>Nenhum lançamento ainda</td></tr>'}</table></div>`;
}
const encTag = (o) => (o.encomenda ? ` <span class="tag enc">Encomenda ${dayLabel(o.encomenda.data)} ${esc(o.encomenda.hora)}</span>` : '');
function tabEnc() {
  const hoje = today(), os = Store.data.orders.filter((o) => o.encomenda && o.status !== 'cancelled'), chave = (o) => o.encomenda.data + ' ' + o.encomenda.hora;
  const prox = os.filter((o) => o.encomenda.data >= hoje).sort((a, b) => chave(a).localeCompare(chave(b))), pass = os.filter((o) => o.encomenda.data < hoje).sort((a, b) => chave(b).localeCompare(chave(a))).slice(0, 15);
  const fone = (o) => Store.data.customers.find((c) => c.id === nameKey(o.customer))?.phone || '';
  const row = (o) => `<div class="panel"><div class="row plain"><div><b class="c-gold">${dayLabel(o.encomenda.data)} às ${esc(o.encomenda.hora)}</b><br><b>${esc(o.customer)}</b>${fone(o) ? ` <small>· ${esc(fone(o))}</small>` : ''}<br>${itemsText(o)}${o.encomenda.obs ? `<br><small>Obs.: ${esc(o.encomenda.obs)}</small>` : ''}<br><span class="tag">${ordLabel(o)}</span></div>
    <div class="r"><b>${money(o.total)}</b>${o.status !== 'paid' ? `<div class="acts col"><button class="btn ok sm" onclick="markPaid('${o.id}')">Pago</button><button class="btn del sm" onclick="cancelOrd('${o.id}')">Cancelar</button></div>` : ''}</div></div></div>`;
  $('#tab').innerHTML = `<h3 class="cath">Próximas <small>(${prox.length})</small></h3>${prox.map(row).join('') || '<p class="empty">Nenhuma encomenda marcada.</p>'}${pass.length ? `<h3 class="cath">Anteriores</h3>${pass.map(row).join('')}` : ''}`;
}

/* Clientes cadastrados: a gerência vê o contato e o código de acesso (4 últimos dígitos do celular) e pode corrigir */
function cliRows(q) {
  const t = nameKey(q || ''), dig = String(q || '').replace(/\D/g, '');
  const cs = Store.data.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).filter((c) => !t || nameKey(c.name).includes(t) || (dig && soDigitos(c.phone).includes(dig)));
  return cs.map((c) => {
    const os = Store.data.orders.filter((o) => nameKey(o.customer) === c.id && o.status !== 'cancelled'), aberto = os.filter((o) => o.status !== 'paid').reduce((a, o) => a + o.total, 0);
    return `<div class="panel"><div class="row" style="border:0"><div><b>${esc(c.name)}</b><br><small>${esc(c.phone)} · ${esc(c.email)}</small><br><small>Cadastro em ${new Date(c.createdAt).toLocaleDateString('pt-BR')} · ${os.length} pedido(s)${aberto ? ' · <b>em aberto ' + money(aberto) + '</b>' : ''}</small></div>
      <div style="text-align:right"><small>Código de acesso</small><br><b style="font-size:20px;letter-spacing:2px">${esc(soDigitos(c.phone).slice(-4))}</b><br><button class="btn sec sm" onclick="editCli('${c.id.replace(/'/g, "\\'")}')">Editar</button></div></div></div>`;
  }).join('') || '<p>Nenhum cliente encontrado.</p>';
}
function tabCli() {
  $('#tab').innerHTML = `<input id="cq" placeholder="Buscar por nome ou celular" oninput="document.querySelector('#clilist').innerHTML=cliRows(this.value)">
    <p><small>${Store.data.customers.length} cliente(s) cadastrado(s). O código de acesso é o final do celular: se o cliente esquecer, é só informar o número que aparece aqui.</small></p><div id="clilist">${cliRows('')}</div>`;
}
function editCli(id) {
  const c = Store.data.customers.find((x) => x.id === id);
  modal(`<h2>${esc(c.name)}</h2><p><small>Se o cliente trocou de número, corrija aqui: os 4 últimos dígitos do novo celular passam a ser o código dele.</small></p>
    <input id="cphone" type="tel" inputmode="tel" placeholder="Celular com DDD" value="${esc(c.phone)}">
    <input id="cemail" type="email" placeholder="E-mail" value="${esc(c.email)}">
    <button class="btn" onclick="saveCli('${c.id.replace(/'/g, "\\'")}')">Salvar</button>`);
}
async function saveCli(id) {
  const c = Store.data.customers.find((x) => x.id === id), phone = $('#cphone').value.trim(), email = $('#cemail').value.trim(), d = soDigitos(phone);
  if (d.length < 10 || d.length > 11) return toast('Celular inválido: use DDD + número');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('E-mail inválido');
  try { await Store.put('customers', { ...c, phone, email, pinHash: await sha256(c.id + ':' + d.slice(-4)) }); closeModal(); render(); toast('Cliente atualizado'); }
  catch (e) { toast('Não foi possível salvar. Tente de novo.'); }
}

/* Venda por fora: lança no sistema o que foi vendido sem passar pelo cardápio (balcão, WhatsApp...) e baixa o estoque */
const vendaItems = () => Store.data.products.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((p) => (p.flavors?.length ? p.flavors : ['']).map((f) => ({ p, flavor: f })));
function tabVenda() {
  const its = vendaItems();
  $('#tab').innerHTML = its.length ? `<div class="panel"><h3>Lançar venda feita por fora</h3>
    <p class="lead"><small>Digite a quantidade vendida de cada item. O estoque é baixado e a venda entra nos relatórios.</small></p>
    ${its.map((it, i) => `<div class="row"><span>${itemName(it.p.name, it.flavor)}<br><small>${money(it.p.price)}${isTracked(it.p) ? ' · estoque ' + stockQty(it.p.id, it.flavor) : ''}</small></span>
      <input class="vq qin" data-i="${i}" type="number" min="0" step="1" inputmode="numeric" placeholder="0" oninput="vTotal()" aria-label="Quantidade"></div>`).join('')}
    <div class="total"><span>Total</span><b id="vtot">${money(0)}</b></div>
    <label class="lbl" for="vcli">Cliente</label><input id="vcli" placeholder="Nome do cliente (opcional)">
    <label class="lbl" for="vpay">Recebimento</label><select id="vpay"><option value="dinheiro">Recebido em dinheiro</option><option value="pix">Recebido por Pix</option><option value="cartao">Recebido no cartão</option><option value="receber">Ainda não recebi (fica em Pendentes)</option></select>
    <label class="lbl" for="vdate">Data</label><input id="vdate" type="date" value="${today()}">
    <button class="btn" onclick="saveVenda()">Registrar venda</button></div>` : '<p class="empty">Cadastre produtos primeiro.</p>';
}
function vTotal() {
  const its = vendaItems();
  $('#vtot').textContent = money([...document.querySelectorAll('.vq')].reduce((a, el) => a + Math.floor(Number(el.value) || 0) * its[Number(el.dataset.i)].p.price, 0));
}
async function saveVenda() {
  const its = vendaItems(), es = [...document.querySelectorAll('.vq')].map((el) => ({ it: its[Number(el.dataset.i)], q: Math.floor(Number(el.value)) })).filter((x) => x.q > 0);
  if (!es.length) return toast('Digite ao menos uma quantidade');
  const pay = $('#vpay').value, date = $('#vdate').value || today(), now = Date.now();
  const when = date === today() ? now : new Date(date + 'T12:00:00').getTime();
  const items = es.map(({ it, q }) => ({ productId: it.p.id, name: it.p.name, flavor: it.flavor, price: it.p.price, cost: it.p.cost || 0, qty: q }));
  const order = { id: uid(), customer: $('#vcli').value.trim() || 'Balcão', items, total: items.reduce((a, i) => a + i.price * i.qty, 0), status: pay === 'receber' ? 'pending' : 'paid',
    method: 'balcao', paidWith: pay === 'receber' ? '' : pay, createdAt: when, paidAt: pay === 'receber' ? null : when };
  try { await Store.placeOrder(order); } catch (e) { return toast(stockMsg(e) + '. Se faltou lançar produção, faça em Estoque.'); }
  toast('Venda registrada: ' + money(order.total)); render();
}

/* Projeção do dia: o que já vendeu hoje + o que o estoque atual renderia se vendesse tudo */
function projecao(items) {
  items = items.map((it) => ({ ...it, qty: Math.max(0, it.qty) })); // saldo negativo (vendeu além do lançado) não conta como estoque
  const h0 = new Date().setHours(0, 0, 0, 0), os = Store.data.orders.filter((o) => o.createdAt >= h0 && o.status !== 'cancelled');
  const recHoje = os.reduce((a, o) => a + o.total, 0);
  const custoHoje = os.reduce((a, o) => a + o.items.reduce((b, i) => b + i.qty * (i.cost || Store.data.products.find((p) => p.id === i.productId)?.cost || 0), 0), 0);
  const recPot = items.reduce((a, it) => a + it.qty * it.p.price, 0), custoPot = items.reduce((a, it) => a + it.qty * (it.p.cost || 0), 0);
  const total = recHoje + recPot, lucro = total - (custoHoje + custoPot), semCusto = items.some((it) => !it.p.cost);
  return `<div class="panel"><h3>Projeção do dia: se vender tudo</h3>
    <div class="cards"><div class="stat"><span>Já vendido hoje</span><b>${money(recHoje)}</b></div><div class="stat"><span>Estoque a preço de venda</span><b>${money(recPot)}</b></div>
    <div class="stat"><span>Faturamento possível do dia</span><b class="c-ok">${money(total)}</b></div>
    <div class="stat"><span>Lucro bruto estimado</span><b>${semCusto ? '—' : money(lucro)}</b><span>${semCusto ? 'faltam custos nos produtos' : total ? ((lucro / total) * 100).toFixed(0) + '% de margem' : ''}</span></div></div>
    <table><tr><th>Item</th><th class="n">Qtd</th><th class="n">Preço</th><th class="n">Rende</th><th class="n">Lucro</th></tr>
    ${items.map((it) => `<tr><td>${itemName(it.p.name, it.flavor)}</td><td class="n">${it.qty}</td><td class="n">${money(it.p.price)}</td><td class="n">${money(it.qty * it.p.price)}</td><td class="n">${it.p.cost ? money(it.qty * (it.p.price - it.p.cost)) : '—'}</td></tr>`).join('')}
    <tr><td><b>Total do estoque</b></td><td class="n"><b>${items.reduce((a, it) => a + it.qty, 0)}</b></td><td></td><td class="n"><b>${money(recPot)}</b></td><td class="n"><b>${semCusto ? '—' : money(recPot - custoPot)}</b></td></tr></table>
    <p class="hint">Considera o estoque de agora vendido por inteiro ao preço do cardápio, mais o que já foi vendido hoje. O lucro usa o custo unitário de cada produto.</p></div>`;
}
function prodDia() {
  const items = stockItems();
  if (!items.length) return toast('Marque "Controlar estoque" nos produtos primeiro');
  modal(`<h2>Produção do dia</h2><label class="lbl" for="pdate">Data</label><input id="pdate" type="date" value="${today()}"><p class="lead"><small>Digite quanto foi produzido de cada item. Deixe em branco o que não produziu.</small></p>
    ${items.map((it, i) => `<div class="row"><span>${itemName(it.p.name, it.flavor)}<br><small>no estoque: ${it.qty}</small></span><input class="pq qin" data-i="${i}" type="number" min="0" step="1" inputmode="numeric" placeholder="0" aria-label="Quantidade"></div>`).join('')}
    <div class="stack"><button class="btn" onclick="saveProdDia()">Salvar produção</button></div>`);
}
async function saveProdDia() {
  const items = stockItems(), date = $('#pdate').value || today();
  const es = [...document.querySelectorAll('.pq')].map((el) => ({ it: items[Number(el.dataset.i)], q: Math.floor(Number(el.value)) })).filter((x) => x.q > 0);
  if (!es.length) return toast('Digite ao menos uma quantidade');
  try {
    await Store.applyStock(es.map(({ it, q }) => ({ id: it.id, productId: it.p.id, flavor: it.flavor, name: it.p.name, delta: q })), es.map(({ it, q }) => ({ col: 'stockLog', obj: logEntry(it, 'producao', q, date) })));
  } catch (e) { return toast(stockMsg(e)); }
  closeModal(); render(); toast('Produção lançada');
}
function adjStock() {
  const items = stockItems();
  if (!items.length) return toast('Marque "Controlar estoque" nos produtos primeiro');
  modal(`<h2>Perda ou contagem</h2>
    <label class="lbl" for="asel">Item</label><select id="asel">${items.map((it, i) => `<option value="${i}">${esc(it.p.name)}${it.flavor ? ' (' + esc(it.flavor) + ')' : ''} — estoque ${it.qty}</option>`).join('')}</select>
    <label class="lbl" for="amode">Tipo</label><select id="amode"><option value="perda">Perda / desperdício (tira do estoque)</option><option value="contagem">Contagem (informo quanto tem agora)</option></select>
    <input id="aqty" type="number" min="0" step="1" inputmode="numeric" placeholder="Quantidade">
    <input id="anote" placeholder="Observação (opcional)"><button class="btn" onclick="saveAdj()">Salvar</button>`);
}
async function saveAdj() {
  const it = stockItems()[Number($('#asel').value)], mode = $('#amode').value, q = Math.floor(Number($('#aqty').value));
  if (!(q >= 0) || $('#aqty').value === '' || (mode === 'perda' && q === 0)) return toast('Informe uma quantidade válida');
  const delta = mode === 'perda' ? -q : q - it.qty;
  if (delta === 0) return toast('O estoque já está com esse valor');
  try {
    await Store.applyStock([{ id: it.id, productId: it.p.id, flavor: it.flavor, name: it.p.name, delta }], [{ col: 'stockLog', obj: logEntry(it, mode, delta, today(), $('#anote').value.trim()) }]);
  } catch (e) { return toast(stockMsg(e)); }
  closeModal(); render(); toast('Estoque atualizado');
}

const CATS = ['Ingredientes', 'Embalagens', 'Gás e energia', 'Equipamentos', 'Outros'];
function tabCmp() {
  const fromD = dayKey(rangeFrom()), cs = Store.data.purchases.filter((c) => c.date >= fromD).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const total = cs.reduce((a, c) => a + Number(c.value), 0), cat = {};
  cs.forEach((c) => (cat[c.category] = (cat[c.category] || 0) + Number(c.value)));
  $('#tab').innerHTML = `<div class="toolbar">${rangeSelect()}<button class="btn" onclick="editCompra()">+ Lançar compra</button></div>
    <div class="cards"><div class="stat click" onclick="detail('compras')"><span>Total gasto</span><b>${money(total)}</b></div>${Object.entries(cat).map(([k, v]) => `<div class="stat click" onclick="detail('compras','${k}')"><span>${esc(k)}</span><b>${money(v)}</b></div>`).join('')}</div>
    <div class="panel"><h3>Compras</h3><table><tr><th>Data</th><th>Descrição</th><th class="n">Valor</th><th></th></tr>
    ${cs.map((c) => `<tr><td>${dayLabel(c.date)}</td><td>${esc(c.description)}<br><small>${esc(c.category)}${c.supplier ? ' · ' + esc(c.supplier) : ''}</small></td><td class="n">${money(c.value)}</td><td class="n"><button class="btn sec sm" onclick="editCompra('${c.id}')">Editar</button></td></tr>`).join('') || '<tr><td colspan=4>Nenhuma compra no período</td></tr>'}</table></div>`;
}
function editCompra(id) {
  const c = Store.data.purchases.find((x) => x.id === id) || { date: today(), description: '', category: CATS[0], supplier: '', value: '' };
  modal(`<h2>${id ? 'Editar' : 'Lançar'} compra</h2><label class="lbl" for="cdate">Data</label><input id="cdate" type="date" value="${c.date}">
    <label class="lbl" for="cdesc">Compra</label><input id="cdesc" placeholder="O que comprou (ex.: 10 kg de frango)" value="${esc(c.description)}">
    <select id="ccat">${CATS.map((k) => `<option ${k === c.category ? 'selected' : ''}>${k}</option>`).join('')}</select>
    <input id="csup" placeholder="Fornecedor / mercado (opcional)" value="${esc(c.supplier)}">
    <input id="cval" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Valor total gasto (R$)" value="${c.value}">
    <div class="stack"><button class="btn" onclick="saveCompra('${id || ''}')">Salvar</button>${id ? `<button class="btn del" onclick="delCompra('${id}')">Excluir</button>` : ''}</div>`);
}
async function saveCompra(id) {
  const description = $('#cdesc').value.trim(), value = parseFloat($('#cval').value), date = $('#cdate').value;
  if (!description || !(value > 0) || !date) return toast('Informe data, descrição e valor');
  const old = Store.data.purchases.find((x) => x.id === id);
  await Store.put('purchases', { id: id || uid(), date, description, category: $('#ccat').value, supplier: $('#csup').value.trim(), value, createdAt: old?.createdAt || Date.now() });
  closeModal(); render(); toast('Compra salva');
}
async function delCompra(id) { if (!confirm('Excluir esta compra?')) return; await Store.remove('purchases', id); closeModal(); render(); }

function tabRes() {
  const from = rangeFrom(), fromD = dayKey(from);
  const os = Store.data.orders.filter((o) => o.createdAt >= from && o.status !== 'cancelled'), sum = (a) => a.reduce((x, o) => x + o.total, 0);
  const vendas = sum(os), recebido = sum(os.filter((o) => o.status === 'paid')), areceber = vendas - recebido;
  const cps = Store.data.purchases.filter((c) => c.date >= fromD), compras = cps.reduce((a, c) => a + Number(c.value), 0);
  const byProd = {}, byDay = {}; let cmv = 0, semCusto = false;
  os.forEach((o) => {
    (byDay[dayKey(o.createdAt)] ||= { v: 0, c: 0 }).v += o.total;
    o.items.forEach((i) => {
      const cost = i.cost || Store.data.products.find((p) => p.id === i.productId)?.cost || 0; if (!cost) semCusto = true;
      const r = (byProd[i.name] ||= { q: 0, rev: 0, cost: 0 }); r.q += i.qty; r.rev += i.qty * i.price; r.cost += i.qty * cost; cmv += i.qty * cost;
    });
  });
  cps.forEach((c) => ((byDay[c.date] ||= { v: 0, c: 0 }).c += Number(c.value)));
  const perdas = Store.data.stockLog.filter((l) => l.type === 'perda' && l.date >= fromD).reduce((a, l) => a + Math.abs(l.qty) * (Store.data.products.find((p) => p.id === l.productId)?.cost || 0), 0);
  const parado = stockItems().reduce((a, it) => a + Math.max(0, it.qty) * (it.p.cost || 0), 0);
  const lucro = vendas - cmv, caixa = recebido - compras, pct = vendas ? (lucro / vendas) * 100 : 0;
  const cor = (v) => (v >= 0 ? 'c-ok' : 'c-bad');
  $('#tab').innerHTML = `<div class="toolbar">${rangeSelect()}</div>
    <div class="panel note"><b>${vendas || compras ? (caixa >= 0 ? 'No período entrou mais dinheiro do que saiu.' : 'No período saiu mais dinheiro do que entrou.') : 'Sem movimento no período.'}</b>
    <br><small>Caixa = o que já recebeu − o que gastou em compras. Se você comprou muito insumo que ainda não virou venda, o caixa fica baixo mesmo com lucro.</small></div>
    <div class="cards"><div class="stat click" onclick="detail('vendido')"><span>Vendido</span><b>${money(vendas)}</b></div><div class="stat click" onclick="detail('recebido')"><span>Recebido</span><b>${money(recebido)}</b></div><div class="stat click" onclick="detail('areceber')"><span>A receber</span><b class="c-warn">${money(areceber)}</b></div>
    <div class="stat click" onclick="detail('compras')"><span>Gasto em compras</span><b>${money(compras)}</b></div><div class="stat click" onclick="detail('caixa')"><span>Caixa (recebido − compras)</span><b class="${cor(caixa)}">${money(caixa)}</b></div>
    <div class="stat click" onclick="detail('lucro')"><span>Lucro estimado</span><b class="${cor(lucro)}">${money(lucro)}</b><span>${semCusto ? 'faltam custos nos produtos' : pct.toFixed(0) + '% de margem'}</span></div>
    <div class="stat click" onclick="detail('perdas')"><span>Perdas (a custo)</span><b>${money(perdas)}</b></div><div class="stat click" onclick="detail('parado')"><span>Estoque guardado (a custo)</span><b>${money(parado)}</b></div></div>
    ${semCusto ? '<div class="panel"><small>Para ver o lucro certo, informe o <b>custo unitário</b> (quanto custa fazer 1 unidade) em Produtos → Editar.</small></div>' : ''}
    <div class="panel"><h3>Lucro por produto</h3><table><tr><th>Produto</th><th class="n">Qtd</th><th class="n">Vendido</th><th class="n">Lucro</th><th class="n">Margem</th></tr>
    ${Object.entries(byProd).sort((a, b) => b[1].rev - a[1].rev).map(([n, r]) => `<tr><td>${esc(n)}</td><td class="n">${r.q}</td><td class="n">${money(r.rev)}</td><td class="n">${r.cost ? money(r.rev - r.cost) : '—'}</td><td class="n">${r.cost ? ((1 - r.cost / r.rev) * 100).toFixed(0) + '%' : '—'}</td></tr>`).join('') || '<tr><td colspan=5>Sem vendas</td></tr>'}</table></div>
    <div class="panel"><h3>Dia a dia</h3><table><tr><th>Dia</th><th class="n">Vendas</th><th class="n">Compras</th><th class="n">Saldo</th></tr>
    ${Object.entries(byDay).sort().reverse().map(([k, d]) => `<tr><td>${dayLabel(k)}</td><td class="n">${money(d.v)}</td><td class="n">${money(d.c)}</td><td class="n ${cor(d.v - d.c)}"><b>${money(d.v - d.c)}</b></td></tr>`).join('') || '<tr><td colspan=4>Sem movimento</td></tr>'}</table></div>`;
}
/* Detalhe dos cartões: abre os registros que formam cada valor, no período escolhido */
const ordLabel = (o) => (o.status === 'paid' ? 'Pago' + (o.method === 'balcao' ? ' · balcão' : '') + ({ pix: ' (Pix)', credit_card: ' (cartão)', maquininha: ' (maquininha)', cartao: ' (cartão)', dinheiro: ' (dinheiro)' }[o.paidWith] || '') : aConferir(o) ? 'Pix informado · conferir' : o.method === 'pix' ? 'Pix aguardando' : o.method === 'infinitepay' ? 'Pagamento online não confirmado' : o.method === 'maquininha' ? 'Cartão físico (maquininha)' : o.method === 'balcao' ? 'A receber (balcão)' : 'A prazo');
// Sub-confirmação: o cliente avisou que pagou o Pix, mas ninguém conferiu o comprovante ainda
const aConferir = (o) => o.status === 'pending' && o.clientPaid === true;
const quando = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const subConf = (o) => (o.status === 'paid' && o.paidBy ? `<br><small class="sub">Baixa por ${esc(o.paidBy)} em ${quando(o.paidAt)}${o.clientPaidAt ? ' · cliente avisou em ' + quando(o.clientPaidAt) : ''}</small>`
  : aConferir(o) ? `<br><small class="sub conf">Cliente informou o pagamento em ${quando(o.clientPaidAt)} · conferir o comprovante</small>`
  : o.naoCaiuEm ? `<br><small class="sub">Cliente avisou, mas ${esc(o.naoCaiuPor || '')} não achou o Pix em ${quando(o.naoCaiuEm)}</small>` : '');
const itemsText = (o) => o.items.map((i) => i.qty + '× ' + esc(i.name) + (i.flavor ? ' (' + esc(i.flavor) + ')' : '')).join(', ');
const ordRows = (os) => os.slice().sort((a, b) => b.createdAt - a.createdAt).map((o) => `<div class="row"><div><small>${new Date(o.createdAt).toLocaleString('pt-BR')} · <b>${esc(o.customer)}</b> · <span class="tag ${aConferir(o) ? 'conf' : ''}">${ordLabel(o)}</span>${encTag(o)}</small><br>${itemsText(o)}${subConf(o)}</div><b>${money(o.total)}</b></div>`).join('') || '<p>Nenhum registro no período.</p>';
const cmpRows = (cs) => cs.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c) => `<div class="row"><div><small>${dayLabel(c.date)} · ${esc(c.category)}${c.supplier ? ' · ' + esc(c.supplier) : ''}</small><br>${esc(c.description)}</div><b>${money(c.value)}</b></div>`).join('') || '<p>Nenhuma compra no período.</p>';
function detail(kind, cat) {
  const from = rangeFrom(), fromD = dayKey(from), per = { 1: 'hoje', 7: 'últimos 7 dias', 30: 'últimos 30 dias', all: 'todo o período' }[S.range];
  const os = Store.data.orders.filter((o) => o.createdAt >= from && o.status !== 'cancelled'), sum = (a) => a.reduce((x, o) => x + o.total, 0);
  const allC = Store.data.purchases.filter((c) => c.date >= fromD), cps = allC.filter((c) => !cat || c.category === cat);
  const tot = (cs) => cs.reduce((a, c) => a + Number(c.value), 0);
  const costOf = (i) => i.cost || Store.data.products.find((p) => p.id === i.productId)?.cost || 0;
  const head = (t, v, sub) => `<h2>${t}</h2><p class="lead"><small>${per}${sub ? ' · ' + sub : ''}</small></p><p class="big">${v}</p>`;
  const paid = os.filter((o) => o.status === 'paid'), pend = os.filter((o) => o.status !== 'paid');
  let h = '';
  if (kind === 'vendido') h = head('Total vendido', money(sum(os)), os.length + ' pedido(s)') + ordRows(os);
  else if (kind === 'pedidos') h = head('Pedidos', os.length, money(sum(os))) + ordRows(os);
  else if (kind === 'recebido') h = head('Recebido', money(sum(paid)), paid.length + ' pedido(s) pago(s)') + ordRows(paid);
  else if (kind === 'areceber') h = head('A receber', money(sum(pend)), pend.length + ' pedido(s) em aberto') + ordRows(pend);
  else if (kind === 'conferir') { const conf = pend.filter(aConferir); h = head('Pix informado pelo cliente, a conferir', money(sum(conf)), conf.length + ' pedido(s) · confira o comprovante e dê a baixa em Pendentes') + ordRows(conf); }
  else if (kind === 'compras') h = head('Gasto em compras' + (cat ? ' · ' + esc(cat) : ''), money(tot(cps)), cps.length + ' compra(s)') + cmpRows(cps);
  else if (kind === 'caixa') h = head('Caixa', money(sum(paid) - tot(allC)), 'recebido − compras') + '<h3>Entrou (' + money(sum(paid)) + ')</h3>' + ordRows(paid) + '<h3>Saiu (' + money(tot(allC)) + ')</h3>' + cmpRows(allC);
  else if (kind === 'lucro') {
    const by = {}; let cmv = 0;
    os.forEach((o) => o.items.forEach((i) => { const r = (by[i.name] ||= { q: 0, rev: 0, cost: 0 }); r.q += i.qty; r.rev += i.qty * i.price; r.cost += i.qty * costOf(i); cmv += i.qty * costOf(i); }));
    h = head('Lucro estimado', money(sum(os) - cmv), 'vendido ' + money(sum(os)) + ' − custo dos produtos ' + money(cmv)) +
      '<table><tr><th>Produto</th><th class="n">Qtd</th><th class="n">Vendido</th><th class="n">Custo</th><th class="n">Lucro</th></tr>' +
      Object.entries(by).sort((a, b) => b[1].rev - a[1].rev).map(([n, r]) => `<tr><td>${esc(n)}</td><td class="n">${r.q}</td><td class="n">${money(r.rev)}</td><td class="n">${r.cost ? money(r.cost) : '—'}</td><td class="n">${r.cost ? money(r.rev - r.cost) : '—'}</td></tr>`).join('') + '</table>';
  } else if (kind === 'perdas') {
    const ls = Store.data.stockLog.filter((l) => l.type === 'perda' && l.date >= fromD).sort((a, b) => b.createdAt - a.createdAt);
    const val = (l) => Math.abs(l.qty) * (Store.data.products.find((p) => p.id === l.productId)?.cost || 0);
    h = head('Perdas (a custo)', money(ls.reduce((a, l) => a + val(l), 0)), ls.length + ' lançamento(s)') +
      (ls.map((l) => `<div class="row"><div><small>${dayLabel(l.date)}${l.note ? ' · ' + esc(l.note) : ''}</small><br>${Math.abs(l.qty)}× ${itemName(l.productName, l.flavor)}</div><b>${money(val(l))}</b></div>`).join('') || '<p>Nenhuma perda no período.</p>');
  } else if (kind === 'parado') {
    const its = stockItems();
    h = head('Estoque guardado (a custo)', money(its.reduce((a, it) => a + Math.max(0, it.qty) * (it.p.cost || 0), 0)), 'agora') +
      (its.map((it) => `<div class="row"><div>${itemName(it.p.name, it.flavor)}<br><small>${it.qty} un × ${it.p.cost ? money(it.p.cost) : 'sem custo'}</small></div><b>${money(it.qty * (it.p.cost || 0))}</b></div>`).join('') || '<p>Nenhum item com estoque controlado.</p>');
  }
  modal(h + '<div class="stack"><button class="btn sec" onclick="closeModal()">Fechar</button></div>');
}
async function cancelOrd(id) {
  const o = Store.data.orders.find((x) => x.id === id);
  if (!confirm('Cancelar este pedido? As unidades voltam para o estoque.')) return;
  try { await Store.cancelOrder(o); toast('Pedido cancelado'); } catch (e) { toast(e.message === 'MUDOU' ? 'Esse pedido já foi alterado. Atualize a tela.' : stockMsg(e)); }
}

function tabQr() {
  const url = location.origin + location.pathname;
  let img = ''; try { const q = qrcode(0, 'M'); q.addData(url); q.make(); img = q.createImgTag(10, 12); } catch (e) {}
  $('#tab').innerHTML = `<div class="panel center"><h3>QR code do cardápio</h3><div class="qrwrap">${img}</div><p><b>${esc(url)}</b></p>
    <p class="hint">Imprima e coloque na mesa. O cliente aponta a câmera do celular, digita o nome e faz o pedido.</p>
    <div class="stack"><button class="btn sm" onclick="window.print()">Imprimir</button></div></div>`;
}
function tabCfg() {
  const s = Store.data.settings;
  $('#tab').innerHTML = `<div class="panel"><h3>Pix para recebimento</h3><p class="lead"><small>O Pix copia e cola é gerado com o valor do pedido. Informe a chave Pix da conta que vai receber (pode ser a conta da InfinitePay).</small></p>
    <label class="lbl" for="k">Chave Pix</label><input id="k" placeholder="CPF/CNPJ, e-mail, celular ou aleatória" value="${esc(s.pixKey)}">
    <label class="lbl" for="n">Nome do recebedor</label><input id="n" placeholder="Nome do recebedor" value="${esc(s.pixName)}">
    <label class="lbl" for="c">Cidade</label><input id="c" placeholder="Cidade" value="${esc(s.pixCity)}">
    <button class="btn" onclick="saveCfg()">Salvar</button></div>`;
}
async function saveCfg() { await Store.setSettings({ pixKey: $('#k').value.trim(), pixName: $('#n').value.trim(), pixCity: $('#c').value.trim() }); toast('Salvo'); }

Store.onChange = () => { if ($('#modal').classList.contains('hidden') && !(document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName))) render(); };
/* Volta do checkout da InfinitePay: confere o pagamento e marca o pedido como pago */
async function handleReturn() {
  const q = new URLSearchParams(location.search), id = q.get('order_nsu');
  if (!id || !q.get('transaction_nsu')) return;
  history.replaceState(null, '', location.pathname);
  modal('<h2>Confirmando pagamento…</h2><p>Aguarde um instante.</p>');
  try {
    const r = await fetch(IP_API + '/payment_check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: IP_HANDLE, order_nsu: id, transaction_nsu: q.get('transaction_nsu'), slug: q.get('slug') }) });
    const j = await r.json();
    let o = Store.data.orders.find((x) => x.id === id);
    if (!o && Store.cloud) { const d = await Store.fs.collection('orders').doc(id).get(); o = d.exists ? d.data() : null; }
    if (!o) throw new Error('pedido não encontrado');
    if (o.status === 'cancelled') { modal('<h2>Pedido cancelado</h2><p>Esse pedido foi cancelado pelo Matheus. Se você pagou, fale com ele para resolver.</p><button class="btn" onclick="closeModal()">Ok</button>'); return; }
    if (j.paid && j.amount === Math.round(o.total * 100)) {
      await Store.put('orders', { ...o, status: 'paid', paidAt: Date.now(), paidWith: q.get('capture_method') || j.capture_method || '', receiptUrl: q.get('receipt_url') || '' });
      localStorage.removeItem('lanche-pagando');
      saveOpen(openIds().filter((x) => x !== id)); S.openOrders = S.openOrders.filter((x) => x.id !== id);
      modal(`<h2>${ICON.check} Pagamento confirmado</h2><p>Pedido de <b>${money(o.total)}</b> pago. Obrigado!</p>${q.get('receipt_url') ? `<p><a href="${esc(q.get('receipt_url'))}" target="_blank" rel="noopener">Ver comprovante</a></p>` : ''}<button class="btn" onclick="closeModal()">Ok</button>`);
    } else modal('<h2>Pagamento ainda não confirmado</h2><p>O pedido ficou anotado como pendente. Se você já pagou, avise o Matheus.</p><button class="btn" onclick="closeModal()">Ok</button>');
  } catch (e) { modal('<h2>Não consegui confirmar agora</h2><p>O pedido ficou anotado como pendente. Se você já pagou, avise o Matheus.</p><button class="btn" onclick="closeModal()">Ok</button>'); }
}
Store.init();
if (S.admin) Store.watchOrders();
render();
handleReturn();
checkOpen();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkOpen(); });
addEventListener('pageshow', (e) => { if (e.persisted) checkOpen(); }); // voltou com o botão "voltar" do navegador
setInterval(() => { if (S.openOrders.length && document.visibilityState === 'visible') checkOpen(); }, 15000); // some o aviso quando a baixa chega
