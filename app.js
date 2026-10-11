/* CryptoPV UI. All data stays in this browser (localStorage). Network is used only when the user
 * explicitly asks for prices from CoinGecko. */
(function () {
  'use strict';
  var C = window.CPV;
  var DAY = C.DAY;
  var LS = { tx: 'cpv.tx', assets: 'cpv.assets', prices: 'cpv.prices', settings: 'cpv.settings', profiles: 'cpv.profiles' };
  var DEFAULT_SETTINGS = { apiKey: '', keyType: 'demo', incomeInPTA: false, tolDays: 2, rates: { before2026: 30, from2026: 31.4 }, overrides: {} };
  var SHORT = { BUY: 'Achat', SELL: 'Vente', PAY: 'Paiement', SWAP: 'Échange', INCOME: 'Revenu', OUT: 'Sortie', TRANSFER: 'Transfert' };

  function load(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function store(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { toast('Enregistrement impossible (stockage plein ou bloqué). Exportez une sauvegarde.'); return false; }
  }

  var S = {
    tx: load(LS.tx, []),
    assets: load(LS.assets, {}),
    prices: load(LS.prices, {}),
    settings: Object.assign({}, DEFAULT_SETTINGS, load(LS.settings, {})),
    profiles: load(LS.profiles, {})
  };
  if (!S.settings.rates) S.settings.rates = DEFAULT_SETTINGS.rates;
  if (!S.settings.overrides) S.settings.overrides = {};

  var ui = { tab: 'home', year: null, txYear: 'all', txAsset: 'all', txLimit: 150, busy: false, priceSym: null };
  var R = null;
  var imp = null; // import wizard state

  function persist(keys) { (keys || ['tx', 'assets', 'prices', 'settings']).forEach(function (k) { store(LS[k], S[k]); }); }
  function ctx() { return { assets: S.assets, prices: S.prices, tolDays: S.settings.tolDays }; }
  function recompute() { R = C.compute(S.tx, ctx(), S.settings); return R; }

  // ---------- formatting ----------
  var fmtCache = {};
  function eur(x, d) {
    if (x == null || !isFinite(x)) return '—';
    d = d == null ? 2 : d;
    var f = fmtCache['e' + d] || (fmtCache['e' + d] = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }));
    return f.format(x);
  }
  function qty(x) {
    if (x == null || !isFinite(x)) return '—';
    var a = Math.abs(x), d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
    return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(x);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dstr(ts) { return C.fmtDate(ts); }
  function dtstr(ts) { var d = new Date(ts * 1000); return C.fmtDate(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cls(x) { return x > 0.005 ? 'gain' : x < -0.005 ? 'loss' : ''; }
  function amountStr(v, cur) { if (v == null) return '—'; return cur && cur !== 'EUR' ? qty(v) + ' ' + cur : eur(v); }
  function $(id) { return document.getElementById(id); }

  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  function symbolsInTx() {
    var set = {};
    S.tx.forEach(function (t) {
      [t.out, t.in, t.fee].forEach(function (l) { if (l && l.a && !C.isFiat(l.a)) set[l.a] = true; });
    });
    return Object.keys(set).sort();
  }
  function ensureAssets() {
    symbolsInTx().forEach(function (s) {
      if (!S.assets[s]) S.assets[s] = { id: C.DEFAULT_IDS[s] || '', zero: false };
    });
  }
  function online() { return navigator.onLine !== false; }
  function isPro() { return S.settings.keyType === 'pro' && !!S.settings.apiKey; }

  // ---------- render ----------
  function render() {
    recompute();
    var v = $('view');
    var html = ({ home: viewHome, tx: viewTx, prices: viewPrices, report: viewReport, settings: viewSettings })[ui.tab]();
    v.innerHTML = html;
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === ui.tab); });
    if (ui.tab === 'home') updateSim();
  }
  function go(tab) { ui.tab = tab; render(); window.scrollTo(0, 0); }

  function emptyState() {
    return '<div class="card empty">' +
      '<h2>Aucune opération</h2>' +
      '<p class="muted">Importez votre fichier de transactions (CSV ou Excel). Il est lu directement sur ce téléphone et n\'est envoyé nulle part.</p>' +
      '<button class="btn primary" data-action="importTx">Importer mon fichier</button> ' +
      '<button class="btn" data-action="editTx">Saisir une opération</button>' +
      '</div>' +
      '<div class="card"><h2>Comment ça marche</h2><ol class="small" style="padding-left:18px;margin:0">' +
      '<li>Importez toutes vos opérations : achats, ventes, échanges, revenus.</li>' +
      '<li>Onglet Cours : récupérez les cours nécessaires (CoinGecko, sur demande) ou importez-les.</li>' +
      '<li>Onglet Déclaration : les montants à reporter sur le formulaire 2086, cession par cession.</li></ol></div>';
  }

  function alertsList() {
    var a = [];
    if (R.negatives.length) a.push({ cls: 'err', html: '<b>' + R.negatives.length + ' crypto(s) passent en solde négatif</b> (' + R.negatives.map(function (n) { return esc(n.asset); }).join(', ') + ') : des achats, revenus ou échanges manquent dans votre fichier. La valeur du portefeuille est alors sous-estimée.' });
    var bad = R.cessions.filter(function (c) { return !c.ok; }).length;
    if (bad) a.push({ cls: 'warn', html: '<b>' + bad + ' cession(s) à vérifier</b> dans l\'onglet Déclaration.', action: 'report' });
    var nomap = symbolsInTx().filter(function (s) { var c = S.assets[s]; return c && !c.id && !c.zero; });
    if (nomap.length) a.push({ cls: 'warn', html: '<b>' + nomap.length + ' crypto(s) sans identifiant de cours</b> : ' + nomap.slice(0, 8).map(esc).join(', ') + (nomap.length > 8 ? '…' : '') + '.', action: 'prices' });
    var miss = Object.keys(R.needed).filter(function (k) { return k.indexOf('__nomap__') !== 0; }).length;
    if (miss) a.push({ cls: 'warn', html: '<b>Cours manquants pour ' + miss + ' crypto(s)</b> aux dates de vente.', action: 'prices' });
    return a;
  }

  function viewHome() {
    if (!S.tx.length) return emptyState();
    var cv = C.currentValue(R.holdings, ctx());
    var latent = cv.total - R.PTAnet;
    var h = '';
    h += '<div class="card"><div class="muted small">Valeur actuelle du portefeuille</div>' +
      '<div class="big">' + eur(cv.total, 0) + '</div>' +
      '<div class="tiny muted">' + (cv.oldest ? 'Cours utilisés : ' + dtstr(cv.oldest) + ' (le plus ancien)' : 'Aucun cours en cache') +
      (cv.missing.length ? ' · sans cours : ' + cv.missing.map(esc).join(', ') : '') + '</div>' +
      '<div class="kpis" style="margin-top:12px">' +
      '<div class="kpi"><div class="l">Prix total d\'acquisition net</div><div class="v">' + eur(R.PTAnet, 0) + '</div></div>' +
      '<div class="kpi"><div class="l">Plus-value latente</div><div class="v ' + cls(latent) + '">' + eur(latent, 0) + '</div></div>' +
      '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn sm" data-action="refreshSpot"' + (online() ? '' : ' disabled') + '>Actualiser les cours du jour</button>' +
      '<span class="tiny muted">connexion requise</span></div></div>';

    var al = alertsList();
    if (al.length) {
      h += '<div class="card"><h2>À corriger</h2>' + al.map(function (x) {
        return '<div class="note ' + x.cls + '">' + x.html + (x.action ? ' <a href="#" data-action="goto" data-tab="' + x.action + '">Voir</a>' : '') + '</div>';
      }).join('') + '</div>';
    }

    h += '<div class="card"><h2>Simuler une vente aujourd\'hui</h2>' +
      '<div class="grid2"><div><label class="f" for="simC">Montant de la vente (EUR)</label><input id="simC" inputmode="decimal" placeholder="ex. 5000" data-input="sim"></div>' +
      '<div><label class="f" for="simF">Frais (EUR)</label><input id="simF" inputmode="decimal" placeholder="0" data-input="sim"></div></div>' +
      '<div id="simOut" class="small" style="margin-top:10px"></div></div>';

    var rows = cv.rows.slice(0, 40);
    h += '<div class="card"><h2>Avoirs (selon vos opérations)</h2><div class="scroll"><table><thead><tr><th>Crypto</th><th class="r">Quantité</th><th class="r">Cours</th><th class="r">Valeur</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) {
        return '<tr><td>' + esc(r.a) + '</td><td class="r num">' + qty(r.q) + '</td><td class="r num">' + (r.p == null ? '<span class="warn">?</span>' : eur(r.p, r.p < 1 ? 4 : 2)) + '</td><td class="r num">' + eur(r.v, 0) + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="muted">Aucun avoir</td></tr>') +
      '</tbody></table></div></div>';
    return h;
  }

  function updateSim() {
    var out = $('simOut'); if (!out) return;
    var Cv = C.parseNumber($('simC').value), F = C.parseNumber($('simF').value) || 0;
    var cv = C.currentValue(R.holdings, ctx());
    if (!(Cv > 0)) { out.innerHTML = '<span class="muted">Valeur du portefeuille utilisée : ' + eur(cv.total, 0) + '. Prix total d\'acquisition net : ' + eur(R.PTAnet, 0) + '.</span>'; return; }
    var s = C.simulate(Cv, F, cv.total, R.PTAnet);
    if (!s) { out.innerHTML = '<span class="warn">Valeur du portefeuille inconnue : actualisez les cours.</span>'; return; }
    var y = new Date().getFullYear(), rate = y >= 2026 ? S.settings.rates.from2026 : S.settings.rates.before2026;
    out.innerHTML = '<div class="lines">' +
      '<span class="k">Part du portefeuille vendue</span><span></span><span class="v">' + (s.ratio * 100).toFixed(1).replace('.', ',') + ' %</span>' +
      '<span class="k">Capital initial consommé</span><span></span><span class="v">' + eur(s.frac, 0) + '</span>' +
      '<span class="k strong">Plus-value imposable</span><span></span><span class="v strong ' + cls(s.pv) + '">' + eur(s.pv, 0) + '</span>' +
      '<span class="k">Impôt estimé (' + String(rate).replace('.', ',') + ' %)</span><span></span><span class="v">' + eur(Math.max(0, s.pv) * rate / 100, 0) + '</span>' +
      '</div>' + (s.ratio > 1 ? '<div class="note warn">Montant supérieur à la valeur du portefeuille.</div>' : '') +
      '<div class="tiny muted" style="margin-top:6px">Hors autres cessions de l\'année et hors seuil de 305 €.</div>';
  }

  // ---------- transactions ----------
  function txSummary(t) {
    var parts = [];
    if (t.out) parts.push('−' + qty(t.out.q) + ' ' + t.out.a);
    if (t.in) parts.push('+' + qty(t.in.q) + ' ' + t.in.a);
    if (t.fee) parts.push('frais ' + qty(t.fee.q) + ' ' + t.fee.a);
    return parts.join(' → ');
  }
  function txTitle(t) {
    var a = t.kind === 'BUY' || t.kind === 'INCOME' ? (t.in && t.in.a) : t.kind === 'SWAP' ? ((t.out ? t.out.a : '?') + ' → ' + (t.in ? t.in.a : '?')) : (t.out && t.out.a);
    return (SHORT[t.kind] || t.kind) + ' ' + esc(a || '');
  }

  function viewTx() {
    var years = {}, assets = {};
    S.tx.forEach(function (t) { years[new Date(t.ts * 1000).getFullYear()] = 1; [t.in, t.out].forEach(function (l) { if (l) assets[l.a] = 1; }); });
    var list = R.sorted.slice().reverse().filter(function (t) {
      if (ui.txYear !== 'all' && new Date(t.ts * 1000).getFullYear() !== +ui.txYear) return false;
      if (ui.txAsset !== 'all' && !((t.in && t.in.a === ui.txAsset) || (t.out && t.out.a === ui.txAsset) || (t.fee && t.fee.a === ui.txAsset))) return false;
      return true;
    });
    var cessionIds = {}; R.cessions.forEach(function (c) { cessionIds[c.tx] = c; });
    var h = '<div class="row" style="margin-bottom:12px"><button class="btn primary grow" data-action="importTx">Importer un fichier</button><button class="btn grow" data-action="editTx">Ajouter</button></div>';
    if (!S.tx.length) return h + emptyState();
    h += '<div class="card"><div class="grid2">' +
      '<div><label class="f">Année</label><select data-change="txYear"><option value="all">Toutes</option>' +
      Object.keys(years).sort().reverse().map(function (y) { return '<option' + (String(ui.txYear) === y ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select></div>' +
      '<div><label class="f">Crypto</label><select data-change="txAsset"><option value="all">Toutes</option>' +
      Object.keys(assets).sort().map(function (a) { return '<option' + (ui.txAsset === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select></div>' +
      '</div><div class="tiny muted" style="margin-top:8px">' + list.length + ' opération(s) · touchez une ligne pour la modifier</div></div>';
    h += '<div class="card" style="padding:4px 12px">' + list.slice(0, ui.txLimit).map(function (t) {
      var c = cessionIds[t.id];
      var badge = c ? (c.ok ? '<span class="badge tax">imposable</span>' : '<span class="badge warn">à vérifier</span>') : '';
      var amt = (t.kind === 'BUY' || t.kind === 'SELL' || t.kind === 'PAY' || (t.kind === 'INCOME' && t.eur)) ? amountStr(t.eur, t.cur) : '';
      return '<div class="tx" data-action="editTx" data-id="' + t.id + '"><div class="d">' + dstr(t.ts) + '</div>' +
        '<div class="m"><div class="t">' + txTitle(t) + ' ' + badge + '</div><div class="s">' + esc(txSummary(t)) + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>' +
        '<div class="e">' + amt + (c && c.pv != null ? '<div class="tiny ' + cls(c.pv) + '">PV ' + eur(c.pv, 0) + '</div>' : '') + '</div></div>';
    }).join('') + '</div>';
    if (list.length > ui.txLimit) h += '<button class="btn" style="width:100%" data-action="moreTx">Afficher plus</button>';
    return h;
  }

  function toLocalInput(ts) { var d = new Date(ts * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function openTxEditor(id) {
    var t = id ? S.tx.filter(function (x) { return x.id === id; })[0] : null;
    var n = t || { id: null, ts: Math.floor(Date.now() / 1000), kind: 'BUY', out: null, in: null, eur: null, cur: 'EUR', feeEur: 0, fee: null, note: '' };
    var kinds = Object.keys(C.KIND_LABELS).filter(function (k) { return k !== 'IGNORE'; });
    var b = '<form id="txForm" autocomplete="off">' +
      '<label class="f">Type</label><select name="kind" data-change="txKind">' + kinds.map(function (k) { return '<option value="' + k + '"' + (n.kind === k ? ' selected' : '') + '>' + esc(C.KIND_LABELS[k]) + '</option>'; }).join('') + '</select>' +
      '<label class="f">Date et heure</label><input type="datetime-local" name="ts" value="' + toLocalInput(n.ts) + '" required>' +
      '<div data-for="out"><div class="grid2"><div><label class="f">Crypto cédée</label><input name="outA" value="' + esc(n.out ? n.out.a : '') + '" placeholder="BTC"></div>' +
      '<div><label class="f">Quantité cédée</label><input name="outQ" inputmode="decimal" value="' + (n.out ? n.out.q : '') + '"></div></div></div>' +
      '<div data-for="in"><div class="grid2"><div><label class="f">Crypto reçue</label><input name="inA" value="' + esc(n.in ? n.in.a : '') + '" placeholder="ETH"></div>' +
      '<div><label class="f">Quantité reçue</label><input name="inQ" inputmode="decimal" value="' + (n.in ? n.in.q : '') + '"></div></div></div>' +
      '<div data-for="eur"><div class="grid2"><div><label class="f" id="eurLabel">Montant</label><input name="eur" inputmode="decimal" value="' + (n.eur == null ? '' : n.eur) + '"></div>' +
      '<div><label class="f">Devise</label><select name="cur"><option' + (n.cur !== 'USD' ? ' selected' : '') + '>EUR</option><option' + (n.cur === 'USD' ? ' selected' : '') + '>USD</option></select></div></div></div>' +
      '<div data-for="feeEur"><label class="f">Frais en monnaie (même devise)</label><input name="feeEur" inputmode="decimal" value="' + (n.feeEur || '') + '"></div>' +
      '<div class="grid2"><div><label class="f">Frais payés en crypto</label><input name="feeA" value="' + esc(n.fee ? n.fee.a : '') + '" placeholder="facultatif"></div>' +
      '<div><label class="f">Quantité de frais</label><input name="feeQ" inputmode="decimal" value="' + (n.fee ? n.fee.q : '') + '"></div></div>' +
      '<label class="f">Note</label><input name="note" value="' + esc(n.note || '') + '">' +
      '<p class="tiny muted" id="kindHelp"></p>' +
      '<div class="row" style="margin-top:14px"><button class="btn primary grow" type="submit">Enregistrer</button>' +
      (t ? '<button class="btn danger" type="button" data-action="deleteTx" data-id="' + t.id + '">Supprimer</button>' : '') + '</div>' +
      (t && t.line ? '<p class="tiny muted">Importée depuis la ligne ' + t.line + ' du fichier.</p>' : '') +
      '</form>';
    openModal(t ? 'Modifier l\'opération' : 'Nouvelle opération', b);
    var f = $('txForm');
    f.dataset.id = t ? t.id : '';
    syncTxForm();
    f.addEventListener('submit', function (e) { e.preventDefault(); saveTxForm(); });
  }
  var KIND_HELP = {
    BUY: 'Achat de crypto avec de la monnaie. Montant = somme payée, frais compris ou dans le champ frais.',
    SELL: 'Vente de crypto contre de la monnaie : événement imposable. Montant = prix de cession brut.',
    PAY: 'Achat d\'un bien ou service payé en crypto : imposable. Montant = valeur du bien.',
    SWAP: 'Échange crypto contre crypto (stablecoins compris) : non imposable, en sursis.',
    INCOME: 'Staking, airdrop, intérêts… Montant facultatif (pris en compte seulement si l\'option est activée dans Réglages).',
    OUT: 'Crypto sortie sans contrepartie (perte, don, frais de réseau isolés). Réduit vos avoirs.',
    TRANSFER: 'Transfert entre vos propres comptes : seuls les frais en crypto réduisent vos avoirs.'
  };
  function syncTxForm() {
    var f = $('txForm'); if (!f) return;
    var k = f.kind.value;
    var show = { out: /SELL|PAY|SWAP|OUT/.test(k), in: /BUY|SWAP|INCOME/.test(k), eur: /BUY|SELL|PAY|INCOME/.test(k), feeEur: /BUY|SELL|PAY/.test(k) };
    Object.keys(show).forEach(function (x) { f.querySelector('[data-for="' + x + '"]').classList.toggle('hide', !show[x]); });
    $('eurLabel').textContent = { BUY: 'Montant payé', SELL: 'Prix de cession', PAY: 'Valeur du bien/service', INCOME: 'Valeur à la réception (facultatif)' }[k] || 'Montant';
    $('kindHelp').textContent = KIND_HELP[k] || '';
  }
  function saveTxForm() {
    var f = $('txForm'), k = f.kind.value;
    var ts = Math.floor(new Date(f.ts.value).getTime() / 1000);
    if (!isFinite(ts)) return toast('Date invalide');
    function leg(a, q) { var s = C.normSym(f[a].value), n = C.parseNumber(f[q].value); return s && n ? { a: s, q: Math.abs(n) } : null; }
    var t = { id: f.dataset.id || C.uid(), ts: ts, kind: k, out: null, in: null, eur: null, cur: f.cur.value, feeEur: 0, fee: null, note: f.note.value.trim(), src: 'manuel' };
    if (/SELL|PAY|SWAP|OUT/.test(k)) t.out = leg('outA', 'outQ');
    if (/BUY|SWAP|INCOME/.test(k)) t.in = leg('inA', 'inQ');
    if (/BUY|SELL|PAY|INCOME/.test(k)) { var e = C.parseNumber(f.eur.value); t.eur = e == null ? null : Math.abs(e); }
    if (/BUY|SELL|PAY/.test(k)) t.feeEur = Math.abs(C.parseNumber(f.feeEur.value) || 0);
    t.fee = leg('feeA', 'feeQ');
    if (/SELL|PAY|OUT/.test(k) && !t.out) return toast('Indiquez la crypto et la quantité cédées');
    if (/BUY|INCOME/.test(k) && !t.in) return toast('Indiquez la crypto et la quantité reçues');
    if (k === 'SWAP' && !t.out && !t.in) return toast('Indiquez au moins une crypto');
    if (/BUY|SELL|PAY/.test(k) && t.eur == null) return toast('Indiquez le montant');
    var old = S.tx.filter(function (x) { return x.id === t.id; })[0];
    if (old) { t.line = old.line; t.src = old.src === 'import' ? 'import modifié' : old.src; S.tx[S.tx.indexOf(old)] = t; }
    else S.tx.push(t);
    ensureAssets(); persist(['tx', 'assets']); closeModal(); render(); toast('Opération enregistrée');
  }

  // ---------- import wizard ----------
  function readFileRows(file) {
    var name = file.name.toLowerCase();
    if (/\.(xlsx|xls|ods)$/.test(name)) {
      return ensureXLSX().then(function () { return file.arrayBuffer(); }).then(function (buf) {
        var wb = XLSX.read(buf, { type: 'array', cellDates: false });
        var sheets = {};
        wb.SheetNames.forEach(function (n) { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); });
        return { sheets: sheets, names: wb.SheetNames };
      });
    }
    return file.arrayBuffer().then(function (buf) {
      var text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
      return { sheets: { CSV: C.parseCSV(text) }, names: ['CSV'] };
    });
  }
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'vendor/xlsx.full.min.js';
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('Lecteur Excel indisponible. Enregistrez le fichier en CSV.')); };
      document.head.appendChild(s);
    });
  }
  function headerSig(row) { return (row || []).map(C.norm).join('|'); }

  function startImport(file) {
    readFileRows(file).then(function (r) {
      imp = { fileName: file.name, sheets: r.sheets, names: r.names, sheet: r.names[0] };
      // choose the first sheet that has data
      for (var i = 0; i < r.names.length; i++) { if ((r.sheets[r.names[i]] || []).length > 1) { imp.sheet = r.names[i]; break; } }
      initImportConfig();
      renderImport();
    }).catch(function (e) { toast(e.message || 'Lecture du fichier impossible'); });
  }
  function initImportConfig() {
    var rows = imp.sheets[imp.sheet] || [];
    imp.rows = rows;
    imp.headerRow = C.guessHeaderRow(rows);
    var header = rows[imp.headerRow] || [];
    var prof = S.profiles[headerSig(header)];
    if (prof) {
      Object.assign(imp, JSON.parse(JSON.stringify(prof)));
      imp.fromProfile = true;
    } else {
      var mb = C.guessMapping(header, C.FIELDS_B);
      imp.mode = (mb.sentQty >= 0 && mb.recvQty >= 0) ? 'B' : 'A';
      imp.decSep = C.detectDecimal(rows.slice(imp.headerRow + 1));
      imp.dateOrder = 'DMY'; imp.signRule = false; imp.oneSided = 'TRANSFER';
      imp.map = imp.mode === 'B' ? mb : C.guessMapping(header, C.FIELDS_A);
      imp.typeMap = {};
      imp.fromProfile = false;
    }
    fillTypeMap();
  }
  function distinctTypes() {
    var m = {}, col = imp.map.type;
    if (col == null || col < 0) return [];
    for (var i = imp.headerRow + 1; i < imp.rows.length; i++) {
      var v = (imp.rows[i] || [])[col];
      if (v == null || String(v).trim() === '') continue;
      var k = C.norm(v);
      if (!m[k]) m[k] = { key: k, label: String(v).trim(), n: 0 };
      m[k].n++;
    }
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.n - a.n; });
  }
  function fillTypeMap() {
    distinctTypes().forEach(function (d) {
      if (imp.typeMap[d.key] == null) imp.typeMap[d.key] = C.guessKind(d.label, imp.mode);
    });
  }
  function runImport() {
    return C.normalizeRows(imp.rows, { mode: imp.mode, headerRow: imp.headerRow, map: imp.map, typeMap: imp.typeMap, decSep: imp.decSep, dateOrder: imp.dateOrder, signRule: imp.signRule, oneSided: imp.oneSided });
  }

  function renderImport() {
    var header = imp.rows[imp.headerRow] || [];
    var fields = imp.mode === 'B' ? C.FIELDS_B : C.FIELDS_A;
    var colOpts = function (sel) {
      return '<option value="-1">—</option>' + header.map(function (h, i) {
        var lab = String(h == null || h === '' ? 'Colonne ' + (i + 1) : h);
        return '<option value="' + i + '"' + (sel === i ? ' selected' : '') + '>' + esc(lab.slice(0, 40)) + '</option>';
      }).join('');
    };
    var res = runImport(); imp.result = res;
    var b = '';
    b += '<div class="card"><div class="small"><b>' + esc(imp.fileName) + '</b> · ' + Math.max(0, imp.rows.length - imp.headerRow - 1) + ' lignes de données' + (imp.fromProfile ? ' · <span class="badge tax">réglages mémorisés appliqués</span>' : '') + '</div>';
    if (imp.names.length > 1) b += '<label class="f">Feuille</label><select data-change="impSheet">' + imp.names.map(function (n) { return '<option' + (n === imp.sheet ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>';
    b += '<div class="grid2"><div><label class="f">Ligne des titres de colonnes</label><input type="number" min="1" value="' + (imp.headerRow + 1) + '" data-change="impHeader"></div>' +
      '<div><label class="f">Séparateur décimal</label><select data-change="impDec"><option value=","' + (imp.decSep === ',' ? ' selected' : '') + '>virgule (1 234,56)</option><option value="."' + (imp.decSep === '.' ? ' selected' : '') + '>point (1,234.56)</option></select></div>' +
      '<div><label class="f">Format des dates</label><select data-change="impDate"><option value="DMY"' + (imp.dateOrder === 'DMY' ? ' selected' : '') + '>jour/mois/année</option><option value="MDY"' + (imp.dateOrder === 'MDY' ? ' selected' : '') + '>mois/jour/année</option></select></div>' +
      '<div><label class="f">Structure du fichier</label><select data-change="impMode"><option value="A"' + (imp.mode === 'A' ? ' selected' : '') + '>Une ligne = une crypto + un type</option><option value="B"' + (imp.mode === 'B' ? ' selected' : '') + '>Colonnes Envoyé / Reçu</option></select></div></div></div>';

    b += '<div class="card"><h2>Correspondance des colonnes</h2><div class="grid2">' + fields.map(function (f) {
      return '<div><label class="f">' + esc(f.label) + (f.req ? ' *' : '') + '</label><select data-change="impMap" data-key="' + f.key + '">' + colOpts(imp.map[f.key]) + '</select></div>';
    }).join('') + '</div>';
    if (imp.mode === 'A' && (imp.map.type == null || imp.map.type < 0)) {
      b += '<label class="row small" style="margin-top:10px"><input type="checkbox" data-change="impSign"' + (imp.signRule ? ' checked' : '') + '> Pas de colonne type : quantité positive = achat, négative = vente</label>';
    }
    if (imp.mode === 'B') {
      b += '<label class="f">Lignes avec seulement une entrée ou une sortie de crypto (sans type)</label><select data-change="impOneSided">' +
        '<option value="TRANSFER"' + (imp.oneSided !== 'REAL' ? ' selected' : '') + '>Transferts entre mes comptes (sans effet)</option>' +
        '<option value="REAL"' + (imp.oneSided === 'REAL' ? ' selected' : '') + '>Entrée = revenu, sortie = perte</option></select>';
    }
    b += '<p class="tiny muted">Montant total en EUR : si votre colonne inclut déjà les frais, ne renseignez pas la colonne frais.</p></div>';

    var types = distinctTypes();
    if (types.length) {
      var kinds = imp.mode === 'B' ? C.MAP_KINDS_B : C.MAP_KINDS_A;
      b += '<div class="card"><h2>Signification des types</h2><p class="tiny muted">Vérifiez surtout les échanges : un échange crypto → crypto saisi comme « vente » serait imposé à tort.</p><table><tbody>' +
        types.map(function (d) {
          return '<tr><td><b>' + esc(d.label) + '</b><div class="tiny muted">' + d.n + ' ligne(s)</div></td><td><select data-change="impType" data-key="' + esc(d.key) + '"><option value="">— à choisir —</option>' +
            Object.keys(kinds).map(function (k) { return '<option value="' + k + '"' + (imp.typeMap[d.key] === k ? ' selected' : '') + '>' + esc(kinds[k]) + '</option>'; }).join('') + '</select></td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    var counts = {};
    res.txs.forEach(function (t) { counts[t.kind] = (counts[t.kind] || 0) + 1; });
    b += '<div class="card"><h2>Aperçu</h2><div class="pill-list">' +
      Object.keys(counts).map(function (k) { return '<span class="badge' + (k === 'SELL' || k === 'PAY' ? ' tax' : '') + '">' + SHORT[k] + ' : ' + counts[k] + '</span>'; }).join('') +
      (res.ignored ? '<span class="badge">ignorées : ' + res.ignored + '</span>' : '') +
      (res.errors.length ? '<span class="badge err">erreurs : ' + res.errors.length + '</span>' : '') + '</div>';
    if (res.errors.length) {
      b += '<div class="note err small">' + res.errors.slice(0, 12).map(function (e) { return 'Ligne ' + e.line + ' : ' + esc(e.msg); }).join('<br>') + (res.errors.length > 12 ? '<br>…' : '') + '</div>';
    }
    if (res.txs.length) {
      b += '<div class="scroll"><table style="font-size:12.5px"><thead><tr><th>Date</th><th>Type</th><th>Détail</th><th class="r">Montant</th></tr></thead><tbody>' +
        res.txs.slice(0, 10).map(function (t) {
          return '<tr><td class="num">' + dstr(t.ts) + '</td><td>' + SHORT[t.kind] + '</td><td>' + esc(txSummary(t)) + '</td><td class="r num">' + (t.eur != null ? amountStr(t.eur, t.cur) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    b += '</div>';
    var can = res.txs.length > 0;
    b += '<div class="row">' +
      '<button class="btn primary grow" data-action="impCommit" data-how="replace"' + (can ? '' : ' disabled') + '>' + (S.tx.length ? 'Remplacer mes ' + S.tx.length + ' opérations' : 'Importer ' + res.txs.length + ' opérations') + '</button>' +
      (S.tx.length ? '<button class="btn grow" data-action="impCommit" data-how="append"' + (can ? '' : ' disabled') + '>Ajouter (sans doublons)</button>' : '') + '</div>' +
      '<p class="tiny muted">Les lignes en erreur ne sont pas importées : corrigez le fichier ou ajoutez-les à la main ensuite.</p>';
    openModal('Importer des opérations', b);
  }

  function commitImport(how) {
    var res = imp.result; if (!res || !res.txs.length) return;
    var added = 0;
    if (how === 'replace') {
      if (S.tx.length && !confirm('Remplacer les ' + S.tx.length + ' opérations existantes ?')) return;
      S.tx = res.txs; added = res.txs.length; S.settings.overrides = {};
    } else {
      var keys = {}; S.tx.forEach(function (t) { keys[C.txKey(t)] = 1; });
      res.txs.forEach(function (t) { var k = C.txKey(t); if (!keys[k]) { S.tx.push(t); keys[k] = 1; added++; } });
    }
    var header = imp.rows[imp.headerRow] || [];
    S.profiles[headerSig(header)] = { mode: imp.mode, map: imp.map, typeMap: imp.typeMap, decSep: imp.decSep, dateOrder: imp.dateOrder, signRule: imp.signRule, oneSided: imp.oneSided };
    ensureAssets(); persist(); store(LS.profiles, S.profiles);
    closeModal(); imp = null;
    ui.tab = 'prices'; render();
    toast(added + ' opération(s) importée(s)');
  }

  // ---------- prices ----------
  function seriesInfo(id) {
    var s = S.prices[id];
    if (!s || !s.length) return '<span class="muted">aucun</span>';
    return s.length + ' cours · ' + dstr(s[0][0]) + ' → ' + dstr(s[s.length - 1][0]);
  }
  function viewPrices() {
    if (!S.tx.length) return emptyState();
    var now = Date.now() / 1000, limit = now - 364 * DAY, pro = isPro();
    var total = R.cessions.length, complete = R.cessions.filter(function (c) { return c.manual || !c.missing.length; }).length;
    var needs = Object.keys(R.needed).map(function (k) { return R.needed[k]; });
    function cg(n) { return n.id.indexOf('__nomap__') !== 0 && n.id.indexOf('manual:') !== 0; }
    var fetchable = needs.filter(function (n) { return cg(n) && (pro || n.max >= limit); });
    var tooOld = needs.filter(function (n) { return cg(n) && !pro && n.min < limit; });
    var h = '<div class="card"><h2>Cours aux dates de vente</h2>' +
      '<div class="kpis"><div class="kpi"><div class="l">Cessions</div><div class="v">' + total + '</div></div>' +
      '<div class="kpi"><div class="l">Valeur du portefeuille complète</div><div class="v ' + (complete === total ? 'gain' : 'warn') + '">' + complete + ' / ' + total + '</div></div></div>';
    if (needs.length) {
      h += '<table style="margin-top:10px"><thead><tr><th>Cours manquants</th><th>Période</th><th class="r">Ventes</th></tr></thead><tbody>' + needs.map(function (n) {
        var nomap = n.id.indexOf('__nomap__') === 0, man = n.id.indexOf('manual:') === 0;
        return '<tr><td>' + esc(n.sym) + (nomap ? ' <span class="badge err">sans identifiant</span>' : man ? ' <span class="badge warn">cours importés incomplets</span>' : (!pro && n.min < limit ? ' <span class="badge warn">' + (n.max < limit ? '> 1 an' : 'en partie > 1 an') + '</span>' : '')) + '</td><td class="num small">' + dstr(n.min) + (n.max !== n.min ? ' → ' + dstr(n.max) : '') + '</td><td class="r">' + n.count + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    h += '<div class="row" style="margin-top:12px"><button class="btn primary grow" data-action="fetchMissing"' + (fetchable.length && online() && !ui.busy ? '' : ' disabled') + '>Télécharger les cours manquants (' + fetchable.length + ')</button></div>';
    if (tooOld.length) h += '<div class="note warn small">L\'API CoinGecko gratuite ne fournit que les 365 derniers jours. Pour les ventes plus anciennes : importez un fichier de cours (bouton « Importer » ci-dessous) ou saisissez la valeur du portefeuille dans l\'onglet Déclaration.</div>';
    h += '<div class="log" id="log"></div><p class="tiny muted">Seuls l\'identifiant de la crypto et les dates sont envoyés à CoinGecko, jamais vos quantités. Les cours sont ensuite gardés sur le téléphone.</p></div>';

    var syms = symbolsInTx();
    h += '<div class="card"><h2>Identifiants CoinGecko</h2><p class="tiny muted">Identifiant = « API ID » affiché sur la page de la crypto sur coingecko.com (ex. bitcoin, ethereum). Vérifiez ceux remplis par défaut : plusieurs cryptos partagent parfois le même symbole.</p>' +
      syms.map(function (s) {
        var a = S.assets[s] || { id: '', zero: false };
        return '<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div class="row"><b style="min-width:64px">' + esc(s) + '</b>' +
          '<input style="flex:1 1 0;min-width:0;width:auto" value="' + esc(a.id && a.id.indexOf('manual:') !== 0 ? a.id : '') + '" placeholder="' + (a.id && a.id.indexOf('manual:') === 0 ? 'cours importés manuellement' : 'identifiant') + '" data-change="assetId" data-sym="' + esc(s) + '"' + (a.zero ? ' disabled' : '') + '>' +
          '<button class="btn sm" data-action="searchId" data-sym="' + esc(s) + '"' + (online() ? '' : ' disabled') + '>Chercher</button></div>' +
          '<div class="row tiny muted" style="margin-top:6px"><span class="grow">' + (a.zero ? 'valeur comptée à 0 €' : (a.id ? seriesInfo(a.id) : 'aucun cours')) + '</span>' +
          '<label class="row" style="gap:4px"><input type="checkbox" data-change="assetZero" data-sym="' + esc(s) + '"' + (a.zero ? ' checked' : '') + '> valeur nulle</label>' +
          '<button class="btn sm" data-action="importPrice" data-sym="' + esc(s) + '">Importer</button></div></div>';
      }).join('') + '</div>';
    h += '<div class="card"><h2>Importer des cours historiques</h2><p class="small muted">Fichier CSV ou Excel avec une colonne date et une colonne de cours en EUR (titres reconnus : date, snapped_at, timeOpen / price, close, clôture, prix). Fonctionne avec l\'export « Historical data » de CoinGecko ou CoinMarketCap en EUR. Une ligne par jour suffit.</p></div>';
    return h;
  }

  function log(msg) { var l = $('log'); if (!l) return; l.style.display = 'block'; l.textContent += msg + '\n'; l.scrollTop = l.scrollHeight; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function getJSON(url, retry) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (r.status === 429 && !retry) { log('Limite de requêtes atteinte : pause de 60 s…'); return sleep(61000).then(function () { return getJSON(url, true); }); }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        var m = (j && j.status && j.status.error_message) || (j && j.error && (j.error.status ? j.error.status.error_message : j.error)) || ('HTTP ' + r.status);
        throw new Error(typeof m === 'string' ? m : 'HTTP ' + r.status);
      });
      return r.json();
    });
  }

  async function fetchMissing() {
    if (ui.busy) return;
    ui.busy = true;
    var btn = document.querySelector('[data-action="fetchMissing"]'); if (btn) btn.disabled = true;
    var now = Math.floor(Date.now() / 1000), pro = isPro(), limit = now - 364 * DAY;
    var delay = S.settings.apiKey ? 2200 : 7000;
    var jobs = [];
    Object.keys(R.needed).forEach(function (k) {
      var n = R.needed[k];
      if (k.indexOf('__nomap__') === 0 || k.indexOf('manual:') === 0) return;
      var from = n.min - 2 * DAY, to = Math.min(now, n.max + 2 * DAY);
      if (!pro) { if (to < limit) return; from = Math.max(from, limit); }
      jobs.push({ id: n.id, sym: n.sym, from: Math.floor(from), to: Math.floor(to) });
    });
    log(jobs.length + ' crypto(s) à télécharger' + (S.settings.apiKey ? '' : ' (sans clé API : lent)') + '…');
    var ok = 0;
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      try {
        var url = C.cgUrl('/coins/' + encodeURIComponent(j.id) + '/market_chart/range', { vs_currency: 'eur', from: j.from, to: j.to }, S.settings);
        var data = await getJSON(url);
        var ser = C.cgSeries(data);
        S.prices[j.id] = C.mergeSeries(S.prices[j.id], ser);
        store(LS.prices, S.prices);
        ok++;
        log('✓ ' + j.sym + ' (' + j.id + ') : ' + ser.length + ' cours');
      } catch (e) {
        log('✗ ' + j.sym + ' (' + j.id + ') : ' + (e.message === 'Failed to fetch' ? 'réseau indisponible ou requête refusée' : e.message));
      }
      if (i < jobs.length - 1) await sleep(delay);
    }
    ui.busy = false;
    log('Terminé : ' + ok + '/' + jobs.length + '.');
    var keepLog = $('log') ? $('log').textContent : '';
    render();
    if (keepLog && $('log')) { $('log').style.display = 'block'; $('log').textContent = keepLog; }
  }

  async function refreshSpot() {
    var ids = {};
    Object.keys(R.holdings).forEach(function (s) { if (R.holdings[s] > 1e-10 && S.assets[s] && S.assets[s].id && S.assets[s].id.indexOf('manual:') !== 0 && !S.assets[s].zero) ids[S.assets[s].id] = 1; });
    var list = Object.keys(ids);
    if (!list.length) return toast('Aucun avoir avec identifiant CoinGecko');
    toast('Actualisation des cours…');
    try {
      var now = Math.floor(Date.now() / 1000);
      for (var i = 0; i < list.length; i += 50) {
        var chunk = list.slice(i, i + 50);
        var data = await getJSON(C.cgUrl('/simple/price', { ids: chunk.join(','), vs_currencies: 'eur' }, S.settings));
        chunk.forEach(function (id) { if (data[id] && data[id].eur != null) S.prices[id] = C.mergeSeries(S.prices[id], [[now, data[id].eur]]); });
      }
      store(LS.prices, S.prices); render(); toast('Cours actualisés');
    } catch (e) { toast('Échec : ' + (e.message === 'Failed to fetch' ? 'réseau indisponible' : e.message)); }
  }

  async function searchId(sym) {
    try {
      var data = await getJSON(C.cgUrl('/search', { query: sym }, S.settings));
      var coins = (data.coins || []).slice(0, 12);
      var exact = coins.filter(function (c) { return C.normSym(c.symbol) === sym; });
      var list = exact.length ? exact.concat(coins.filter(function (c) { return exact.indexOf(c) < 0; })) : coins;
      var b = '<p class="small muted">Choisissez la crypto correspondant à <b>' + esc(sym) + '</b>. Le rang de capitalisation aide à repérer la bonne.</p><div style="display:grid;gap:8px">' +
        list.map(function (c) {
          return '<div class="pick" data-action="pickId" data-sym="' + esc(sym) + '" data-id="' + esc(c.id) + '"><b>' + esc(c.name) + '</b> <span class="muted">' + esc(c.symbol) + '</span><div class="tiny muted">id : ' + esc(c.id) + (c.market_cap_rank ? ' · rang ' + c.market_cap_rank : '') + '</div></div>';
        }).join('') + '</div>' + (list.length ? '' : '<p>Aucun résultat.</p>');
      openModal('Identifiant pour ' + sym, b);
    } catch (e) { toast('Recherche impossible : ' + (e.message === 'Failed to fetch' ? 'réseau indisponible' : e.message)); }
  }

  function importPriceFile(file) {
    var sym = ui.priceSym; if (!sym) return;
    readFileRows(file).then(function (r) {
      var rows = r.sheets[r.names[0]];
      var res = C.parsePriceTable(rows);
      if (res.error) return toast(res.error);
      if (!res.points.length) return toast('Aucun cours lisible dans ce fichier');
      var a = S.assets[sym] || (S.assets[sym] = { id: '', zero: false });
      if (!a.id) a.id = 'manual:' + sym;
      S.prices[a.id] = C.mergeSeries(S.prices[a.id], res.points);
      persist(['assets', 'prices']); render();
      toast(res.points.length + ' cours importés pour ' + sym + ' (' + dstr(res.points[0][0]) + ' → ' + dstr(res.points[res.points.length - 1][0]) + ')');
    }).catch(function (e) { toast(e.message || 'Lecture impossible'); });
  }

  // ---------- report ----------
  function viewReport() {
    if (!S.tx.length) return emptyState();
    var years = Object.keys(R.years).sort().reverse();
    if (!years.length) return '<div class="card empty"><h2>Aucune cession imposable</h2><p class="muted">Aucune vente contre monnaie ni paiement en crypto dans vos opérations. Les échanges crypto ↔ crypto ne sont pas imposables.</p></div>';
    if (!ui.year || !R.years[ui.year]) ui.year = years[0];
    var Y = R.years[ui.year];
    var h = '<div class="card noprint"><label class="f" style="margin-top:0">Année des cessions</label><select data-change="year">' +
      years.map(function (y) { return '<option' + (String(ui.year) === y ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>' +
      '<div class="row" style="margin-top:10px"><button class="btn sm" data-action="exportReport">Exporter CSV</button><button class="btn sm" data-action="print">Imprimer / PDF</button></div></div>';
    var box = Y.totalPV >= 0 ? '3AN' : '3BN';
    h += '<div class="card"><h2>Formulaire 2086 — cessions ' + Y.year + '</h2>' +
      '<div class="kpis"><div class="kpi"><div class="l">Total des cessions</div><div class="v">' + eur(Y.totalC, 0) + '</div></div>' +
      '<div class="kpi"><div class="l">Plus ou moins-value globale</div><div class="v ' + cls(Y.totalPV) + '">' + eur(Math.round(Y.totalPV), 0) + '</div></div></div>';
    if (Y.exempt) h += '<div class="note small">Total des cessions ≤ 305 € : plus-values exonérées pour cette année.</div>';
    else h += '<div class="note small">À reporter case <b>' + box + '</b> de la déclaration 2042 C : <b>' + eur(Math.abs(Math.round(Y.totalPV)), 0) + '</b>' +
      (Y.totalPV > 0 ? '. Impôt estimé au taux de ' + String(Y.rate).replace('.', ',') + ' % : <b>' + eur(Y.tax, 0) + '</b>.' : '. Une moins-value n\'est pas reportable sur les années suivantes.') + '</div>';
    if (Y.issues) h += '<div class="note warn small"><b>' + Y.issues + ' cession(s) à vérifier</b> : les montants ci-dessous ne sont pas fiables tant que les points signalés ne sont pas corrigés.</div>';
    if (R.negatives.length) h += '<div class="note err small">Soldes négatifs détectés (' + R.negatives.map(function (n) { return esc(n.asset); }).join(', ') + ') : il manque des opérations. Le prix total d\'acquisition et la valeur du portefeuille peuvent être faux.</div>';
    h += '<p class="tiny muted">Les cessions sont numérotées dans l\'ordre chronologique, comme sur le formulaire (5 par page). Montants arrondis à l\'euro sur le formulaire. Pensez au formulaire 3916-bis pour chaque compte ouvert sur une plateforme étrangère.</p></div>';

    Y.cessions.forEach(function (c, i) {
      var st = c.ok ? '' : '<span class="badge warn">à vérifier</span>';
      h += '<div class="card"><div class="row"><h2 class="grow" style="margin:0">Cession ' + (i + 1) + ' ' + st + '</h2><span class="small muted num">' + dtstr(c.ts) + '</span></div>' +
        '<div class="small muted" style="margin:4px 0 10px">' + (c.kind === 'PAY' ? 'Paiement' : 'Vente') + ' de ' + qty(c.qty) + ' ' + esc(c.asset) + '</div>' +
        '<div class="lines">' +
        line('211', 'Date de la cession', dstr(c.ts)) +
        line('212', 'Valeur globale du portefeuille' + (c.manual ? ' (saisie)' : ''), eur(c.V, 0)) +
        line('213', 'Prix de cession', eur(c.C, 0)) +
        line('214', 'Frais de cession', eur(c.fees, 0)) +
        line('215', 'Prix de cession net des frais', eur(c.net, 0)) +
        line('217', 'Prix de cession net des soultes', eur(c.C, 0)) +
        line('218', 'Prix net des frais et soultes', eur(c.net, 0)) +
        line('220', 'Prix total d\'acquisition', eur(c.PTA, 0)) +
        line('221', 'Fractions de capital initial', eur(c.PTA - c.PTAnet, 0)) +
        line('222', 'Soultes reçues', eur(0, 0)) +
        line('223', 'Prix total d\'acquisition net', eur(c.PTAnet, 0)) +
        '<span class="k strong">224</span><span class="strong">Plus ou moins-value</span><span class="v strong ' + cls(c.pv) + '">' + eur(c.pv, 0) + '</span>' +
        '</div>';
      if (c.issues.length) h += '<div class="note warn small">' + c.issues.map(esc).join('<br>') + '</div>';
      h += '<details class="noprint"><summary>Détail de la valeur du portefeuille / saisie manuelle</summary>' +
        '<table style="margin-top:6px"><thead><tr><th>Crypto</th><th class="r">Quantité</th><th class="r">Cours</th><th class="r">Valeur</th></tr></thead><tbody>' +
        c.detail.map(function (d) { return '<tr><td>' + esc(d.a) + '</td><td class="r num">' + qty(d.q) + '</td><td class="r num">' + eur(d.p, d.p < 1 ? 4 : 2) + '</td><td class="r num">' + eur(d.v, 0) + '</td></tr>'; }).join('') +
        c.missingDetail.map(function (m) { return '<tr><td>' + esc(m.a) + '</td><td class="r num">' + qty(m.q) + '</td><td class="r warn">manquant</td><td></td></tr>'; }).join('') +
        '<tr><td colspan="3"><b>Total calculé</b></td><td class="r num"><b>' + eur(c.Vauto, 0) + '</b></td></tr></tbody></table>' +
        '<label class="f">Valeur globale saisie à la main (relevé de votre plateforme le jour de la vente)</label>' +
        '<div class="row"><input style="flex:1 1 0;min-width:0;width:auto" inputmode="decimal" value="' + (c.manual ? c.V : '') + '" placeholder="laisser vide = calcul automatique" data-change="override" data-tx="' + c.tx + '">' +
        (c.manual ? '<button class="btn sm" data-action="clearOverride" data-tx="' + c.tx + '">Effacer</button>' : '') + '</div></details></div>';
    });
    return h;
  }
  function line(n, label, v) { return '<span class="k">' + n + '</span><span>' + label + '</span><span class="v">' + v + '</span>'; }

  // ---------- settings ----------
  function storageSize() {
    var n = 0;
    try { Object.keys(LS).forEach(function (k) { var v = localStorage.getItem(LS[k]); n += v ? v.length * 2 : 0; }); } catch (e) { }
    return (n / 1048576).toFixed(2).replace('.', ',') + ' Mo';
  }
  function viewSettings() {
    var s = S.settings;
    return '<div class="card"><h2>CoinGecko</h2>' +
      '<p class="small muted">Facultatif. Sans clé, les requêtes sont très limitées. Une clé « Demo » gratuite s\'obtient en créant un compte sur coingecko.com (rubrique Developer Dashboard). Une clé payante « Pro » donne accès à tout l\'historique.</p>' +
      '<label class="f">Clé API</label><input data-change="apiKey" value="' + esc(s.apiKey) + '" placeholder="CG-..." autocomplete="off">' +
      '<label class="f">Type de clé</label><select data-change="keyType"><option value="demo"' + (s.keyType !== 'pro' ? ' selected' : '') + '>Demo (gratuite, 365 derniers jours)</option><option value="pro"' + (s.keyType === 'pro' ? ' selected' : '') + '>Pro (payante, historique complet)</option></select></div>' +
      '<div class="card"><h2>Calcul</h2>' +
      '<label class="f">Écart maximal entre la date de vente et le cours utilisé (jours)</label><input type="number" min="0" max="15" step="1" data-change="tolDays" value="' + s.tolDays + '">' +
      '<label class="row small" style="margin-top:12px;align-items:flex-start"><input type="checkbox" data-change="incomeInPTA"' + (s.incomeInPTA ? ' checked' : '') + ' style="margin-top:3px"> <span>Ajouter la valeur des revenus reçus (staking, airdrops) au prix d\'acquisition. À activer seulement si ces revenus ont déjà été déclarés et imposés à leur réception. Désactivé : acquis pour 0 €, l\'option la plus prudente.</span></label>' +
      '<div class="grid2"><div><label class="f">Taux d\'imposition jusqu\'en 2025 (%)</label><input inputmode="decimal" data-change="rateBefore" value="' + String(s.rates.before2026).replace('.', ',') + '"></div>' +
      '<div><label class="f">Taux à partir de 2026 (%)</label><input inputmode="decimal" data-change="rateFrom" value="' + String(s.rates.from2026).replace('.', ',') + '"></div></div>' +
      '<p class="tiny muted">Prélèvement forfaitaire unique : 12,8 % d\'impôt + prélèvements sociaux. Vérifiez le taux applicable à votre situation (option possible pour le barème progressif).</p></div>' +
      '<div class="card"><h2>Données</h2><p class="small muted">Tout est stocké uniquement sur cet appareil (' + storageSize() + '). Si vous effacez les données du navigateur ou désinstallez l\'app, elles sont perdues : exportez une sauvegarde régulièrement.</p>' +
      '<div class="row"><button class="btn" data-action="backup">Exporter une sauvegarde</button><button class="btn" data-action="restore">Restaurer</button></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn danger" data-action="wipe">Tout effacer</button></div></div>' +
      '<div class="card"><h2>Méthode</h2><p class="small">Article 150 VH bis du CGI : plus-value = prix de cession − prix total d\'acquisition net × prix de cession ÷ valeur globale du portefeuille. Seules les ventes contre monnaie et les paiements en crypto sont imposables ; les échanges crypto ↔ crypto, stablecoins compris, ne le sont pas.</p>' +
      '<p class="small muted">Limites : soultes non gérées ; cours journaliers pour les dates de plus de 90 jours (cours à 00:00 UTC) ; le résultat dépend de l\'exhaustivité de vos opérations. Outil d\'aide au calcul, pas un conseil fiscal.</p></div>';
  }

  // ---------- backup ----------
  function download(name, content, type) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function doBackup() {
    var data = { app: 'CryptoPV', version: 1, exported: new Date().toISOString(), tx: S.tx, assets: S.assets, prices: S.prices, settings: S.settings, profiles: S.profiles };
    download('cryptopv-sauvegarde-' + today() + '.json', JSON.stringify(data), 'application/json');
  }
  function doRestore(file) {
    file.text().then(function (txt) {
      var d = JSON.parse(txt);
      if (d.app !== 'CryptoPV' || !Array.isArray(d.tx)) throw new Error('Fichier de sauvegarde non reconnu');
      if (!confirm('Remplacer toutes les données actuelles par cette sauvegarde (' + d.tx.length + ' opérations) ?')) return;
      S.tx = d.tx; S.assets = d.assets || {}; S.prices = d.prices || {};
      S.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {}); S.profiles = d.profiles || {};
      persist(); store(LS.profiles, S.profiles); render(); toast('Sauvegarde restaurée');
    }).catch(function (e) { toast(e.message || 'Restauration impossible'); });
  }

  // ---------- modal ----------
  function openModal(title, body) { $('modalTitle').textContent = title; $('modalBody').innerHTML = body; $('modal').classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeModal() { $('modal').classList.remove('open'); document.body.style.overflow = ''; }

  // ---------- events ----------
  var actions = {
    goto: function (el, e) { e.preventDefault(); go(el.dataset.tab); },
    closeModal: closeModal,
    importTx: function () { $('fileTx').value = ''; $('fileTx').click(); },
    editTx: function (el) { openTxEditor(el.dataset.id || null); },
    deleteTx: function (el) {
      if (!confirm('Supprimer cette opération ?')) return;
      S.tx = S.tx.filter(function (t) { return t.id !== el.dataset.id; });
      delete S.settings.overrides[el.dataset.id];
      persist(['tx', 'settings']); closeModal(); render(); toast('Opération supprimée');
    },
    moreTx: function () { ui.txLimit += 300; render(); },
    impCommit: function (el) { commitImport(el.dataset.how); },
    fetchMissing: fetchMissing,
    refreshSpot: refreshSpot,
    searchId: function (el) { searchId(el.dataset.sym); },
    pickId: function (el) {
      var a = S.assets[el.dataset.sym] || (S.assets[el.dataset.sym] = { id: '', zero: false });
      a.id = el.dataset.id; persist(['assets']); closeModal(); render(); toast(el.dataset.sym + ' → ' + a.id);
    },
    importPrice: function (el) { ui.priceSym = el.dataset.sym; $('filePrice').value = ''; $('filePrice').click(); },
    exportReport: function () { var Y = R.years[ui.year]; if (Y) download('cryptopv-2086-' + Y.year + '.csv', '﻿' + C.reportCSV(Y), 'text/csv;charset=utf-8'); },
    print: function () { window.print(); },
    clearOverride: function (el) { delete S.settings.overrides[el.dataset.tx]; persist(['settings']); render(); },
    backup: doBackup,
    restore: function () { $('fileBackup').value = ''; $('fileBackup').click(); },
    wipe: function () {
      if (!confirm('Effacer toutes les opérations, cours et réglages de cet appareil ?')) return;
      if (!confirm('Confirmer la suppression définitive ?')) return;
      Object.keys(LS).forEach(function (k) { try { localStorage.removeItem(LS[k]); } catch (e) { } });
      S.tx = []; S.assets = {}; S.prices = {}; S.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); S.profiles = {};
      render(); toast('Données effacées');
    }
  };
  var changes = {
    txYear: function (el) { ui.txYear = el.value; ui.txLimit = 150; render(); },
    txAsset: function (el) { ui.txAsset = el.value; ui.txLimit = 150; render(); },
    txKind: syncTxForm,
    year: function (el) { ui.year = el.value; render(); },
    assetId: function (el) {
      var a = S.assets[el.dataset.sym] || (S.assets[el.dataset.sym] = { id: '', zero: false });
      a.id = el.value.trim().toLowerCase(); persist(['assets']); render();
    },
    assetZero: function (el) { var a = S.assets[el.dataset.sym]; a.zero = el.checked; persist(['assets']); render(); },
    override: function (el) {
      var v = C.parseNumber(el.value);
      if (v > 0) S.settings.overrides[el.dataset.tx] = v; else delete S.settings.overrides[el.dataset.tx];
      persist(['settings']); render();
    },
    apiKey: function (el) { S.settings.apiKey = el.value.trim(); persist(['settings']); toast('Clé enregistrée'); },
    keyType: function (el) { S.settings.keyType = el.value; persist(['settings']); },
    tolDays: function (el) { var v = parseInt(el.value, 10); S.settings.tolDays = isFinite(v) && v >= 0 ? v : 2; persist(['settings']); toast('Enregistré'); },
    incomeInPTA: function (el) { S.settings.incomeInPTA = el.checked; persist(['settings']); },
    rateBefore: function (el) { var v = C.parseNumber(el.value); if (v != null) { S.settings.rates.before2026 = v; persist(['settings']); } },
    rateFrom: function (el) { var v = C.parseNumber(el.value); if (v != null) { S.settings.rates.from2026 = v; persist(['settings']); } },
    impSheet: function (el) { imp.sheet = el.value; initImportConfig(); renderImport(); },
    impHeader: function (el) {
      var v = parseInt(el.value, 10) - 1; if (!(v >= 0 && v < imp.rows.length)) return;
      imp.headerRow = v; var header = imp.rows[v] || [];
      imp.map = C.guessMapping(header, imp.mode === 'B' ? C.FIELDS_B : C.FIELDS_A); imp.typeMap = {}; fillTypeMap(); renderImport();
    },
    impDec: function (el) { imp.decSep = el.value; renderImport(); },
    impDate: function (el) { imp.dateOrder = el.value; renderImport(); },
    impMode: function (el) {
      imp.mode = el.value; imp.map = C.guessMapping(imp.rows[imp.headerRow] || [], imp.mode === 'B' ? C.FIELDS_B : C.FIELDS_A);
      imp.typeMap = {}; fillTypeMap(); renderImport();
    },
    impMap: function (el) {
      imp.map[el.dataset.key] = parseInt(el.value, 10);
      if (el.dataset.key === 'type') fillTypeMap();
      renderImport();
    },
    impType: function (el) { imp.typeMap[el.dataset.key] = el.value; renderImport(); },
    impSign: function (el) { imp.signRule = el.checked; renderImport(); },
    impOneSided: function (el) { imp.oneSided = el.value; renderImport(); }
  };

  document.addEventListener('click', function (e) {
    var tab = e.target.closest('#tabs button');
    if (tab) { go(tab.dataset.tab); return; }
    var el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]');
    if (el && changes[el.dataset.change]) {
      var sy = window.scrollY, msy = $('modal').scrollTop;
      changes[el.dataset.change](el, e);
      window.scrollTo(0, sy); $('modal').scrollTop = msy;
    }
  });
  document.addEventListener('input', function (e) { if (e.target.dataset && e.target.dataset.input === 'sim') updateSim(); });
  $('fileTx').addEventListener('change', function (e) { if (e.target.files[0]) startImport(e.target.files[0]); });
  $('filePrice').addEventListener('change', function (e) { if (e.target.files[0]) importPriceFile(e.target.files[0]); });
  $('fileBackup').addEventListener('change', function (e) { if (e.target.files[0]) doRestore(e.target.files[0]); });

  function updateNet() {
    var n = $('net'); var on = online();
    n.textContent = on ? 'en ligne' : 'hors ligne'; n.classList.toggle('on', on);
    if (ui.tab === 'prices' && !ui.busy && !$('modal').classList.contains('open')) render();
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);

  // ---------- boot ----------
  ensureAssets();
  render();
  updateNet();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });
})();
