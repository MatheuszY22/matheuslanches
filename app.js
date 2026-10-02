'use strict';
const ADMIN_NAME = 'matheus';
const ADMIN_HASH = 'aeefd4741ec5108880b213cef40536a41a46217b571d4857a18cf2426edcec47'; // SHA-256 da senha
const LS = 'lanchonete-v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayLabel = (k) => k.split('-').reverse().join('/');
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- Armazenamento: local (padrão) ou Firestore (se config.js tiver FIREBASE_CONFIG) ---------- */
const Store = {
  data: { products: [], orders: [], settings: { pixKey: '', pixName: '', pixCity: '' } },
  cloud: !!window.FIREBASE_CONFIG,
  fs: null, onChange: () => {}, ordersUnsub: null,
  init() {
    if (this.cloud) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      this.fs = firebase.firestore();
      this.fs.collection('products').onSnapshot((s) => { this.data.products = s.docs.map((d) => d.data()); this.onChange(); });
      this.fs.doc('config/main').onSnapshot((d) => { if (d.exists) this.data.settings = { ...this.data.settings, ...d.data() }; this.onChange(); });
    } else {
      try { Object.assign(this.data, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) {}
      addEventListener('storage', () => { try { Object.assign(this.data, JSON.parse(localStorage.getItem(LS) || '{}')); this.onChange(); } catch (e) {} });
    }
  },
  watchOrders() { // só o administrador assina os pedidos
    if (!this.cloud || this.ordersUnsub) return;
    this.ordersUnsub = this.fs.collection('orders').onSnapshot((s) => { this.data.orders = s.docs.map((d) => d.data()); this.onChange(); });
  },
  save() { if (!this.cloud) localStorage.setItem(LS, JSON.stringify(this.data)); },
  async put(col, obj) {
    if (this.cloud) return this.fs.collection(col).doc(obj.id).set(obj);
    const arr = this.data[col]; const i = arr.findIndex((x) => x.id === obj.id);
    if (i >= 0) arr[i] = obj; else arr.push(obj);
    this.save(); this.onChange();
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
const S = { user: localStorage.getItem('lanche-user') || '', admin: sessionStorage.getItem('lanche-admin') === '1', tab: 'rel', range: '7', cart: [], askPass: false };

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
  $('#app').innerHTML = `<div class="login"><h1>🍔 Lanchonete</h1><p>Digite seu nome para entrar</p>
    <input id="nome" placeholder="Seu nome" autocomplete="off" value="">
    ${S.askPass ? '<input id="senha" type="password" placeholder="Senha do administrador">' : ''}
    <button class="btn" id="entrar">Entrar</button></div>`;
  const go = async () => {
    const nome = $('#nome').value.trim();
    if (!nome) return toast('Digite seu nome');
    if (nome.toLowerCase() === ADMIN_NAME) {
      if (!S.askPass) { S.askPass = true; renderLogin(); $('#nome').value = nome; $('#senha').focus(); return; }
      if ((await sha256($('#senha').value)) !== ADMIN_HASH) return toast('Senha incorreta');
      S.admin = true; sessionStorage.setItem('lanche-admin', '1'); S.user = 'Matheus'; Store.watchOrders();
    } else S.user = nome;
    S.askPass = false; localStorage.setItem('lanche-user', S.user); render();
  };
  $('#entrar').onclick = go;
  $('#app').querySelectorAll('input').forEach((i) => (i.onkeydown = (e) => { if (e.key === 'Enter') go(); }));
  $('#nome').oninput = () => { if (S.askPass && $('#nome').value.trim().toLowerCase() !== ADMIN_NAME) { S.askPass = false; const v = $('#nome').value; renderLogin(); $('#nome').value = v; $('#nome').focus(); } };
  $('#nome').focus();
}
function logout() { S.user = ''; S.admin = false; S.cart = []; localStorage.removeItem('lanche-user'); sessionStorage.removeItem('lanche-admin'); render(); }

/* --- cliente --- */
function renderMenu() {
  const ps = Store.data.products.slice().sort((a, b) => a.name.localeCompare(b.name));
  const n = S.cart.reduce((a, i) => a + i.qty, 0), tot = cartTotal();
  $('#app').innerHTML = `<div class="top"><h1>🍔 Olá, ${esc(S.user)}</h1><button onclick="logout()">Sair</button></div>
    <div class="wrap">${ps.length ? '' : '<p>Nenhum produto cadastrado ainda.</p>'}<div class="grid">${ps.map((p) => `
      <div class="prod ${p.active === false ? 'off' : ''}" ${p.active === false ? '' : `onclick="pick('${p.id}')"`}>${p.photo ? `<img src="${p.photo}" alt="">` : '<div class="ph">🍽️</div>'}
      <div class="i"><b>${esc(p.name)}</b><span class="pr">${p.active === false ? 'Esgotado' : money(p.price)}</span>${p.active !== false && p.flavors?.length ? `<br><small>${p.flavors.length} sabores</small>` : ''}</div></div>`).join('')}</div><div class="pad"></div></div>
    ${n ? `<div class="cartbar" onclick="openCart()"><span>🛒 ${n} item(ns)</span><b>${money(tot)} · Ver pedido</b></div>` : ''}`;
}
const cartTotal = () => S.cart.reduce((a, i) => a + i.price * i.qty, 0);
function pick(id) {
  const p = Store.data.products.find((x) => x.id === id);
  if (!p.flavors?.length) return addCart(p, '');
  modal(`<h2>${esc(p.name)}</h2><p>Escolha o sabor:</p><div class="chips">${p.flavors.map((f, i) => `<button class="chip" onclick="addCart(Store.data.products.find(x=>x.id==='${id}'),'${esc(f).replace(/'/g, '')}')">${esc(f)}</button>`).join('')}</div>`);
}
function addCart(p, flavor) {
  const l = S.cart.find((i) => i.productId === p.id && i.flavor === flavor);
  if (l) l.qty++; else S.cart.push({ productId: p.id, name: p.name, flavor, price: p.price, qty: 1 });
  closeModal(); toast('Adicionado'); render();
}
function openCart() {
  if (!S.cart.length) return closeModal();
  modal(`<h2>Seu pedido</h2>${S.cart.map((i, k) => `<div class="row"><div>${esc(i.name)}${i.flavor ? ` <small>(${esc(i.flavor)})</small>` : ''}<br><small>${money(i.price)}</small></div>
    <div class="qty"><button onclick="qty(${k},-1)">−</button>${i.qty}<button onclick="qty(${k},1)">+</button></div></div>`).join('')}
    <p style="font-size:20px"><b>Total: ${money(cartTotal())}</b></p>
    <button class="btn" onclick="checkout('pix')">Pagar agora com Pix</button><br><br>
    <button class="btn sec" onclick="checkout('prazo')">Deixar anotado (pagar depois)</button>`);
}
function qty(k, d) { S.cart[k].qty += d; if (S.cart[k].qty <= 0) S.cart.splice(k, 1); render(); openCart(); }
async function checkout(method) {
  const st = Store.data.settings;
  if (method === 'pix' && !st.pixKey) return toast('Pix ainda não configurado pelo Matheus');
  const paused = S.cart.filter((i) => Store.data.products.find((p) => p.id === i.productId)?.active === false);
  if (paused.length) { S.cart = S.cart.filter((i) => !paused.includes(i)); render(); closeModal(); return toast(paused.map((i) => i.name).join(', ') + ' acabou e saiu do pedido'); }
  const order = { id: uid(), customer: S.user, items: S.cart.map((i) => ({ ...i })), total: cartTotal(), status: 'pending', method, createdAt: Date.now(), paidAt: null };
  await Store.put('orders', order); S.cart = []; render();
  if (method === 'prazo') return modal(`<h2>Pedido anotado ✅</h2><p>Total de ${money(order.total)} anotado no nome de <b>${esc(order.customer)}</b>. Pague depois com o Matheus.</p><button class="btn" onclick="closeModal()">Ok</button>`);
  const code = pixPayload({ key: st.pixKey, name: st.pixName, city: st.pixCity, amount: order.total, txid: order.id });
  let qr = ''; try { const q = qrcode(0, 'M'); q.addData(code); q.make(); qr = q.createImgTag(5, 8); } catch (e) {}
  modal(`<h2>Pague com Pix</h2><p>Total: <b>${money(order.total)}</b></p><div style="text-align:center">${qr}</div>
    <div class="pix" id="pixcode">${code}</div>
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('pixcode').textContent).then(()=>toast('Pix copiado!'))">Copiar Pix copia e cola</button>
    <p><small>Depois de pagar, o Matheus confirma o recebimento. Até lá o pedido fica como pendente.</small></p><button class="btn sec" onclick="closeModal()">Fechar</button>`);
}

/* --- administrador --- */
function renderAdmin() {
  const tabs = [['rel', 'Relatórios'], ['prazo', 'A prazo / pendentes'], ['prod', 'Produtos'], ['cfg', 'Pix'], ['qr', 'QR do cardápio']];
  $('#app').innerHTML = `<div class="top"><h1>🍔 Painel do Matheus</h1><button onclick="logout()">Sair</button></div><div class="wrap">
    <div class="tabs">${tabs.map(([k, t]) => `<button class="${S.tab === k ? 'on' : ''}" onclick="S.tab='${k}';render()">${t}</button>`).join('')}</div><div id="tab"></div></div>`;
  ({ rel: tabRel, prazo: tabPrazo, prod: tabProd, cfg: tabCfg, qr: tabQr })[S.tab]();
}
function tabRel() {
  const r = S.range, now = Date.now();
  const from = r === 'all' ? 0 : r === '1' ? new Date().setHours(0, 0, 0, 0) : now - Number(r) * 86400000;
  const os = Store.data.orders.filter((o) => o.createdAt >= from);
  const paid = os.filter((o) => o.status === 'paid'), pend = os.filter((o) => o.status !== 'paid');
  const sum = (a) => a.reduce((x, o) => x + o.total, 0);
  const byDay = {}; os.forEach((o) => { const d = byDay[dayKey(o.createdAt)] ||= { n: 0, paid: 0, pend: 0 }; d.n++; o.status === 'paid' ? (d.paid += o.total) : (d.pend += o.total); });
  const prods = {}; os.forEach((o) => o.items.forEach((i) => { const p = prods[i.name] ||= { q: 0, v: 0 }; p.q += i.qty; p.v += i.qty * i.price; }));
  const top = Object.entries(prods).sort((a, b) => b[1].q - a[1].q), max = top[0]?.[1].q || 1;
  $('#tab').innerHTML = `<select onchange="S.range=this.value;render()">${[['1', 'Hoje'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['all', 'Tudo']].map(([v, t]) => `<option value="${v}" ${r === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <div class="cards"><div class="stat"><span>Total vendido</span><b>${money(sum(os))}</b></div><div class="stat"><span>Recebido</span><b style="color:var(--ok)">${money(sum(paid))}</b></div>
    <div class="stat"><span>A receber</span><b style="color:var(--warn)">${money(sum(pend))}</b></div><div class="stat"><span>Pedidos</span><b>${os.length}</b></div></div>
    <div class="panel"><h3>Vendas por dia</h3><table><tr><th>Dia</th><th class="n">Pedidos</th><th class="n">Recebido</th><th class="n">A receber</th><th class="n">Total</th></tr>
    ${Object.entries(byDay).sort().reverse().map(([k, d]) => `<tr><td>${dayLabel(k)}</td><td class="n">${d.n}</td><td class="n">${money(d.paid)}</td><td class="n">${money(d.pend)}</td><td class="n"><b>${money(d.paid + d.pend)}</b></td></tr>`).join('') || '<tr><td colspan=5>Sem vendas no período</td></tr>'}</table></div>
    <div class="panel"><h3>Produtos mais vendidos</h3>${top.map(([n, p]) => `<div style="margin-bottom:10px"><div class="row" style="border:0;padding:0"><span>${esc(n)}</span><span>${p.q} un · ${money(p.v)}</span></div><div class="bar"><i style="width:${(p.q / max) * 100}%"></i></div></div>`).join('') || 'Sem dados'}</div>`;
}
function tabPrazo() {
  const pend = Store.data.orders.filter((o) => o.status !== 'paid').sort((a, b) => a.createdAt - b.createdAt);
  const by = {}; pend.forEach((o) => (by[o.customer] ||= []).push(o));
  $('#tab').innerHTML = Object.keys(by).length ? Object.entries(by).map(([c, os]) => `<div class="panel"><div class="row" style="border:0"><h3 style="margin:0">${esc(c)}</h3><b>${money(os.reduce((a, o) => a + o.total, 0))}</b></div>
    ${os.map((o) => `<div class="row"><div><small>${new Date(o.createdAt).toLocaleString('pt-BR')} <span class="tag">${o.method === 'pix' ? 'Pix aguardando' : 'A prazo'}</span></small><br>${o.items.map((i) => `${i.qty}× ${esc(i.name)}${i.flavor ? ` (${esc(i.flavor)})` : ''}`).join(', ')}</div>
    <div style="text-align:right"><b>${money(o.total)}</b><br><button class="btn ok sm" onclick="markPaid('${o.id}')">Pago</button></div></div>`).join('')}
    <br><button class="btn sec sm" onclick="payAll('${esc(c).replace(/'/g, "\\'")}')">Receber tudo de ${esc(c)}</button></div>`).join('') : '<p>Nenhum pedido pendente 🎉</p>';
}
async function markPaid(id) { const o = Store.data.orders.find((x) => x.id === id); await Store.put('orders', { ...o, status: 'paid', paidAt: Date.now() }); toast('Marcado como pago'); }
async function payAll(c) { if (!confirm(`Marcar tudo de ${c} como pago?`)) return; for (const o of Store.data.orders.filter((x) => x.customer === c && x.status !== 'paid')) await Store.put('orders', { ...o, status: 'paid', paidAt: Date.now() }); }

function tabProd() {
  $('#tab').innerHTML = `<button class="btn" onclick="editProd()">+ Novo produto</button><br><br>${Store.data.products.map((p) => `<div class="panel row" style="border:0">
    <div style="display:flex;gap:10px;align-items:center">${p.photo ? `<img src="${p.photo}" width="56" height="56" style="object-fit:cover;border-radius:8px">` : '🍽️'}<div><b>${esc(p.name)}</b> ${p.active === false ? '<span class="tag">pausado</span>' : ''}<br>${money(p.price)}${p.flavors?.length ? `<br><small>${esc(p.flavors.join(', '))}</small>` : ''}</div></div>
    <div style="display:flex;flex-direction:column;gap:6px"><button class="btn sm ${p.active === false ? 'ok' : 'sec'}" onclick="toggleProd('${p.id}')">${p.active === false ? 'Ativar' : 'Pausar'}</button><button class="btn sec sm" onclick="editProd('${p.id}')">Editar</button></div></div>`).join('') || '<p>Nenhum produto ainda.</p>'}`;
}
async function toggleProd(id) {
  const p = Store.data.products.find((x) => x.id === id);
  await Store.put('products', { ...p, active: p.active === false });
  toast(p.active === false ? 'Produto ativado' : 'Produto pausado');
}
let editPhoto = '';
function editProd(id) {
  const p = Store.data.products.find((x) => x.id === id) || { name: '', price: '', flavors: [], photo: '', active: true };
  editPhoto = p.photo || '';
  modal(`<h2>${id ? 'Editar' : 'Novo'} produto</h2>
    <input id="pn" placeholder="Nome (ex.: X-Burguer)" value="${esc(p.name)}">
    <input id="pp" type="number" step="0.01" min="0" placeholder="Valor (R$)" value="${p.price}">
    <input id="pf" placeholder="Sabores, separados por vírgula (deixe vazio se não tiver)" value="${esc((p.flavors || []).join(', '))}">
    <label>Foto</label><input id="pimg" type="file" accept="image/*" capture="environment"><img id="prev" src="${editPhoto}" width="96" style="${editPhoto ? '' : 'display:none'};border-radius:8px;margin-bottom:10px">
    <label><input type="checkbox" id="pa" ${p.active !== false ? 'checked' : ''} style="width:auto"> Ativo (desmarque para pausar)</label><br><br>
    <button class="btn" onclick="saveProd('${id || ''}')">Salvar</button>${id ? `<br><br><button class="btn del" onclick="delProd('${id}')">Excluir</button>` : ''}`);
  $('#pimg').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; editPhoto = await shrink(f); $('#prev').src = editPhoto; $('#prev').style.display = ''; };
}
function shrink(file, max = 480) {
  return new Promise((res) => { const img = new Image(); img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.8)); }; img.src = URL.createObjectURL(file); });
}
async function saveProd(id) {
  const name = $('#pn').value.trim(), price = parseFloat($('#pp').value);
  if (!name || isNaN(price)) return toast('Informe nome e valor');
  await Store.put('products', { id: id || uid(), name, price, flavors: $('#pf').value.split(',').map((s) => s.trim()).filter(Boolean), photo: editPhoto, active: $('#pa').checked });
  closeModal(); toast('Produto salvo');
}
async function delProd(id) { if (!confirm('Excluir este produto?')) return; await Store.remove('products', id); closeModal(); }

function tabQr() {
  const url = location.origin + location.pathname;
  let img = ''; try { const q = qrcode(0, 'M'); q.addData(url); q.make(); img = q.createImgTag(10, 12); } catch (e) {}
  $('#tab').innerHTML = `<div class="panel" style="text-align:center"><h3>QR code do cardápio</h3><div>${img}</div><p><b>${esc(url)}</b></p>
    <p><small>Imprima e coloque na lanchonete. O cliente aponta a câmera do celular, digita o nome e faz o pedido.</small></p>
    <button class="btn sm" onclick="window.print()">Imprimir</button></div>`;
}
function tabCfg() {
  const s = Store.data.settings;
  $('#tab').innerHTML = `<div class="panel"><h3>Pix para recebimento</h3><p><small>O Pix copia e cola é gerado com o valor do pedido. Informe a chave Pix da conta que vai receber (pode ser a conta da InfinitePay).</small></p>
    <input id="k" placeholder="Chave Pix (CPF/CNPJ, e-mail, celular ou aleatória)" value="${esc(s.pixKey)}">
    <input id="n" placeholder="Nome do recebedor" value="${esc(s.pixName)}"><input id="c" placeholder="Cidade" value="${esc(s.pixCity)}">
    <button class="btn" onclick="saveCfg()">Salvar</button></div>`;
}
async function saveCfg() { await Store.setSettings({ pixKey: $('#k').value.trim(), pixName: $('#n').value.trim(), pixCity: $('#c').value.trim() }); toast('Salvo'); }

Store.onChange = () => { if ($('#modal').classList.contains('hidden') && !(document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName))) render(); };
Store.init();
if (S.admin) Store.watchOrders();
render();
