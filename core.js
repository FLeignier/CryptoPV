/* CryptoPV core: parsing, normalisation and French crypto capital gains engine
 * (article 150 VH bis CGI / form 2086). No DOM access here so it can be unit-tested in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CPV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FIAT = ['EUR', 'USD'];
  var DAY = 86400; // seconds
  var EPS = 1e-10;

  // Transaction kinds (internal)
  var KIND_LABELS = {
    BUY: 'Achat (EUR → crypto)',
    SELL: 'Vente (crypto → EUR)',
    PAY: 'Paiement d\'un bien/service en crypto',
    SWAP: 'Échange crypto ↔ crypto',
    INCOME: 'Revenu reçu (staking, airdrop…)',
    OUT: 'Sortie sans contrepartie (frais, perte, don)',
    TRANSFER: 'Transfert entre mes comptes',
    IGNORE: 'Ignorer la ligne'
  };
  // Kinds offered when mapping the "type" values of an imported file
  var MAP_KINDS_A = {
    BUY: 'Achat (EUR → crypto)',
    SELL: 'Vente (crypto → EUR) — imposable',
    PAY: 'Paiement en crypto — imposable',
    SWAP_OUT: 'Échange : crypto cédée (sortie)',
    SWAP_IN: 'Échange : crypto reçue (entrée)',
    INCOME: 'Revenu reçu (staking, airdrop…)',
    OUT: 'Sortie sans contrepartie (frais, perte, don)',
    TRANSFER: 'Transfert entre mes comptes',
    IGNORE: 'Ignorer'
  };
  var MAP_KINDS_B = {
    AUTO: 'Automatique (selon les colonnes)',
    BUY: 'Achat', SELL: 'Vente — imposable', PAY: 'Paiement — imposable',
    SWAP: 'Échange crypto ↔ crypto', INCOME: 'Revenu reçu',
    OUT: 'Sortie sans contrepartie', TRANSFER: 'Transfert entre mes comptes', IGNORE: 'Ignorer'
  };

  // Default symbol -> CoinGecko API id (user-editable in the app)
  var DEFAULT_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', USDC: 'usd-coin', BNB: 'binancecoin', SOL: 'solana',
    XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', DOT: 'polkadot', AVAX: 'avalanche-2', MATIC: 'matic-network',
    POL: 'polygon-ecosystem-token', LINK: 'chainlink', LTC: 'litecoin', BCH: 'bitcoin-cash', ATOM: 'cosmos',
    XLM: 'stellar', TRX: 'tron', UNI: 'uniswap', SHIB: 'shiba-inu', NEAR: 'near', ALGO: 'algorand',
    FTM: 'fantom', EGLD: 'elrond-erd-2', XTZ: 'tezos', AAVE: 'aave', DAI: 'dai', EURC: 'euro-coin',
    ETC: 'ethereum-classic', FIL: 'filecoin', ICP: 'internet-computer', APT: 'aptos', ARB: 'arbitrum',
    OP: 'optimism', SUI: 'sui', TON: 'the-open-network', HBAR: 'hedera-hashgraph', VET: 'vechain',
    SAND: 'the-sandbox', MANA: 'decentraland', AXS: 'axie-infinity', CRO: 'crypto-com-chain', PEPE: 'pepe',
    INJ: 'injective-protocol', RENDER: 'render-token', RNDR: 'render-token', GRT: 'the-graph', MKR: 'maker',
    CRV: 'curve-dao-token', SNX: 'havven', KSM: 'kusama', XMR: 'monero', ZEC: 'zcash', EOS: 'eos', NEO: 'neo',
    KAS: 'kaspa', SEI: 'sei-network', TIA: 'celestia', JUP: 'jupiter-exchange-solana', WIF: 'dogwifcoin',
    BONK: 'bonk', FET: 'fetch-ai', IMX: 'immutable-x', LDO: 'lido-dao', STX: 'blockstack', RUNE: 'thorchain',
    QNT: 'quant-network', THETA: 'theta-token', CHZ: 'chiliz', FLOW: 'flow', MINA: 'mina-protocol',
    BUSD: 'binance-usd', HNT: 'helium', ENS: 'ethereum-name-service', '1INCH': '1inch',
    COMP: 'compound-governance-token', SUSHI: 'sushi', YFI: 'yearn-finance', BAT: 'basic-attention-token',
    ZIL: 'zilliqa', WBTC: 'wrapped-bitcoin', STETH: 'staked-ether', TAO: 'bittensor', ONDO: 'ondo-finance',
    HYPE: 'hyperliquid', ENA: 'ethena', WLD: 'worldcoin-wld', PYTH: 'pyth-network', XDC: 'xdce-crowd-sale'
  };

  // ---------- small helpers ----------
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[_\-\/\\.()\[\]:]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function normSym(s) {
    return String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
  }
  function isFiat(sym) { return FIAT.indexOf(normSym(sym)) >= 0; }
  function isEmpty(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

  // ---------- numbers ----------
  // decSep: ',' | '.' | 'auto'
  function parseNumber(v, decSep) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[\s  ']/g, '').replace(/[^0-9,.\-+eE]/g, '');
    if (/^[+-]/.test(s)) { if (s[0] === '-') neg = !neg; s = s.slice(1); }
    if (!s || !/[0-9]/.test(s)) return null;
    var hasC = s.indexOf(',') >= 0, hasD = s.indexOf('.') >= 0;
    if (hasC && hasD) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasC) {
      var nc = s.split(',').length - 1;
      if (nc > 1) s = s.replace(/,/g, '');
      else if (decSep === '.' && /^\d{1,3},\d{3}$/.test(s)) s = s.replace(',', '');
      else s = s.replace(',', '.');
    } else if (hasD) {
      var nd = s.split('.').length - 1;
      if (nd > 1) s = s.replace(/\./g, '');
      else if (decSep === ',' && /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace('.', '');
    }
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  function detectDecimal(rows) {
    var c = 0, d = 0;
    for (var i = 0; i < rows.length && i < 500; i++) {
      var r = rows[i] || [];
      for (var j = 0; j < r.length; j++) {
        var s = typeof r[j] === 'string' ? r[j].trim() : '';
        if (/^-?\d+,\d+$/.test(s)) c++;
        else if (/^-?\d+\.\d+$/.test(s)) d++;
      }
    }
    return c >= d ? ',' : '.';
  }

  // ---------- dates ----------
  // Returns epoch seconds, or null. Wall-clock times are interpreted in the device time zone
  // unless the string carries an explicit offset/Z. order: 'DMY' | 'MDY'
  function parseDate(v, order) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : Math.floor(v.getTime() / 1000);
    if (typeof v === 'number') {
      if (v > 1e11) return Math.floor(v / 1000); // epoch ms
      if (v > 1e9) return Math.floor(v);          // epoch s
      if (v > 20000 && v < 80000) {               // Excel serial date (wall clock)
        var ms = Math.round((v - 25569) * 86400000);
        var u = new Date(ms);
        return Math.floor(new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
          u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()).getTime() / 1000);
      }
      return null;
    }
    var s = String(v).trim();
    if (!s) return null;
    if (/^\d{10}$/.test(s)) return parseInt(s, 10);
    if (/^\d{13}$/.test(s)) return Math.floor(parseInt(s, 10) / 1000);
    var m;
    // ISO-like: 2024-03-05, 2024-03-05 14:22(:10), 2024-03-05T14:22:10Z, with offset
    m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i);
    if (m) return mk(+m[1], +m[2], +m[3], m[4], m[5], m[6], m[7]);
    // D/M/Y or M/D/Y
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})(?:[ T,]+(\d{1,2})[:h](\d{2})(?::(\d{2}))?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i);
    if (m) {
      var a = +m[1], b = +m[2], y = +m[3];
      if (y < 100) y += 2000;
      var day, mon;
      if (a > 12) { day = a; mon = b; } else if (b > 12) { day = b; mon = a; }
      else if (order === 'MDY') { mon = a; day = b; } else { day = a; mon = b; }
      return mk(y, mon, day, m[4], m[5], m[6], m[7]);
    }
    // Last resort: let the engine try (e.g. "Mar 5, 2024 14:00")
    var t = Date.parse(s);
    return isNaN(t) ? null : Math.floor(t / 1000);
  }
  function mk(y, mo, d, hh, mi, ss, tz) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    hh = +(hh || 0); mi = +(mi || 0); ss = +(ss || 0);
    if (tz) {
      var off = 0;
      if (!/^(Z|UTC)$/i.test(tz)) {
        var sg = tz[0] === '-' ? -1 : 1, t = tz.replace(/[+-:]/g, '');
        off = sg * (parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2, 4), 10));
      }
      return Math.floor(Date.UTC(y, mo - 1, d, hh, mi, ss) / 1000) - off * 60;
    }
    var dt = new Date(y, mo - 1, d, hh, mi, ss);
    if (dt.getDate() !== d) return null;
    return Math.floor(dt.getTime() / 1000);
  }
  function parseTimeOfDay(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' && v >= 0 && v < 1) return Math.round(v * DAY);
    if (v instanceof Date) return v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
    var m = String(v).trim().match(/^(\d{1,2})[:h](\d{2})(?::(\d{2}))?/);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : 0;
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var sample = text.split(/\r?\n/).slice(0, 30);
    var best = ',', bestScore = -1;
    [';', ',', '\t', '|'].forEach(function (d) {
      var counts = sample.filter(function (l) { return l.trim(); }).map(function (l) { return countOutsideQuotes(l, d); });
      if (!counts.length) return;
      var nonzero = counts.filter(function (c) { return c > 0; }).length;
      var mode = modeOf(counts);
      var score = nonzero * 10 + mode;
      if (mode > 0 && score > bestScore) { bestScore = score; best = d; }
    });
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === best) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function countOutsideQuotes(l, d) {
    var n = 0, q = false;
    for (var i = 0; i < l.length; i++) { if (l[i] === '"') q = !q; else if (!q && l[i] === d) n++; }
    return n;
  }
  function modeOf(arr) {
    var f = {}, best = 0, bc = 0;
    arr.forEach(function (x) { f[x] = (f[x] || 0) + 1; if (f[x] > bc) { bc = f[x]; best = x; } });
    return best;
  }

  function guessHeaderRow(rows) {
    for (var i = 0; i < Math.min(rows.length, 25); i++) {
      var r = rows[i] || [];
      var filled = r.filter(function (c) { return !isEmpty(c); });
      if (filled.length < 3) continue;
      var texty = filled.filter(function (c) { return typeof c === 'string' && /[a-zA-Z€]/.test(c) && parseDate(c) == null; });
      if (texty.length >= Math.ceil(filled.length * 0.6)) return i;
    }
    return 0;
  }

  // ---------- column mapping ----------
  var FIELDS_A = [
    { key: 'date', label: 'Date (et heure)', req: true, syn: ['date', 'date heure', 'datetime', 'horodatage', 'timestamp', 'jour', 'date utc', 'utc time', 'time', 'created at', 'date de l operation'] },
    { key: 'time', label: 'Heure (si colonne séparée)', syn: ['heure', 'hour'] },
    { key: 'type', label: 'Type d\'opération', syn: ['type', 'operation', 'type d operation', 'sens', 'side', 'transaction type', 'action', 'nature', 'kind', 'ordre'] },
    { key: 'asset', label: 'Crypto', req: true, syn: ['crypto', 'asset', 'actif', 'coin', 'token', 'cryptomonnaie', 'crypto monnaie', 'symbole', 'symbol', 'ticker', 'devise', 'currency', 'monnaie', 'jeton'] },
    { key: 'qty', label: 'Quantité de crypto', req: true, syn: ['quantite', 'qty', 'quantity', 'qte', 'nombre', 'nb', 'volume', 'montant crypto', 'amount', 'quantite crypto', 'nombre de jetons'] },
    { key: 'eur', label: 'Montant total en EUR', syn: ['montant eur', 'total eur', 'montant', 'total', 'valeur', 'valeur eur', 'value', 'eur', '€', 'montant €', 'total €', 'prix total', 'cout', 'cout total', 'cost', 'montant total', 'investissement', 'somme'] },
    { key: 'unit', label: 'Prix unitaire en EUR', syn: ['prix unitaire', 'prix', 'price', 'cours', 'unit price', 'pu', 'prix eur', 'prix d achat', 'prix de vente', 'cours eur'] },
    { key: 'feeEur', label: 'Frais en EUR', syn: ['frais', 'frais eur', 'fee', 'fees', 'commission', 'frais €', 'frais en eur'] },
    { key: 'feeAsset', label: 'Frais payés en crypto : laquelle', syn: ['frais crypto', 'devise frais', 'fee currency', 'fee asset', 'fee coin'] },
    { key: 'feeQty', label: 'Frais payés en crypto : quantité', syn: ['quantite frais', 'fee amount', 'frais quantite'] },
    { key: 'asset2', label: 'Échange sur 1 ligne : crypto reçue', syn: ['crypto recue', 'recu', 'vers', 'to', 'contrepartie', 'received currency', 'actif recu'] },
    { key: 'qty2', label: 'Échange sur 1 ligne : quantité reçue', syn: ['quantite recue', 'received amount', 'montant recu'] },
    { key: 'note', label: 'Note / plateforme', syn: ['note', 'notes', 'commentaire', 'commentaires', 'comment', 'description', 'plateforme', 'exchange', 'wallet', 'portefeuille', 'label', 'memo', 'remarque'] }
  ];
  var FIELDS_B = [
    { key: 'date', label: 'Date (et heure)', req: true, syn: FIELDS_A[0].syn },
    { key: 'time', label: 'Heure (si colonne séparée)', syn: ['heure', 'hour'] },
    { key: 'type', label: 'Type d\'opération (optionnel)', syn: FIELDS_A[2].syn.concat(['label', 'tag']) },
    { key: 'sentQty', label: 'Envoyé : quantité', syn: ['sent amount', 'envoye', 'montant envoye', 'quantite envoyee', 'debit', 'sortie', 'out amount', 'sold amount'] },
    { key: 'sentAsset', label: 'Envoyé : devise/crypto', syn: ['sent currency', 'devise envoyee', 'actif envoye', 'crypto envoyee', 'out currency', 'sold currency'] },
    { key: 'recvQty', label: 'Reçu : quantité', syn: ['received amount', 'recu', 'montant recu', 'quantite recue', 'credit', 'entree', 'in amount', 'bought amount'] },
    { key: 'recvAsset', label: 'Reçu : devise/crypto', syn: ['received currency', 'devise recue', 'actif recu', 'crypto recue', 'in currency', 'bought currency'] },
    { key: 'feeQty', label: 'Frais : quantité', syn: ['fee amount', 'frais', 'montant frais', 'fees'] },
    { key: 'feeAsset', label: 'Frais : devise/crypto', syn: ['fee currency', 'devise frais', 'fee asset'] },
    { key: 'eur', label: 'Valeur en EUR (optionnel)', syn: ['net worth amount', 'valeur eur', 'value eur', 'eur value', 'valeur', 'montant eur', 'net value'] },
    { key: 'note', label: 'Note / plateforme', syn: FIELDS_A[12].syn.concat(['txhash']) }
  ];

  function guessMapping(header, fields) {
    var h = header.map(norm), used = {}, map = {};
    fields.forEach(function (f) { map[f.key] = -1; });
    // pass 1: exact match, pass 2: header contains synonym (longest synonyms first)
    [0, 1].forEach(function (pass) {
      fields.forEach(function (f) {
        if (map[f.key] >= 0) return;
        var syns = f.syn.map(norm).sort(function (a, b) { return b.length - a.length; });
        for (var s = 0; s < syns.length; s++) {
          for (var c = 0; c < h.length; c++) {
            if (used[c] || !h[c]) continue;
            var ok = pass === 0 ? h[c] === syns[s] : (syns[s].length >= 3 && (' ' + h[c] + ' ').indexOf(' ' + syns[s] + ' ') >= 0);
            if (ok) { map[f.key] = c; used[c] = true; return; }
          }
        }
      });
    });
    return map;
  }

  function guessKind(value, mode) {
    var v = norm(value);
    if (!v) return '';
    if (/ignor|annul|cancel|failed|echou/.test(v)) return 'IGNORE';
    if (/paiement|payment|spend|depense|achat (de |d )?bien|carte|card|purchase of goods/.test(v)) return 'PAY';
    if (/echange|swap|convert|conversion|trade|exchange|arbitrage/.test(v)) {
      if (mode === 'B') return 'AUTO';
      return /entree|recu|received|\bin\b|vers|achat|buy/.test(v) ? 'SWAP_IN' : 'SWAP_OUT';
    }
    if (/staking|stake|reward|recompense|airdrop|interet|interest|earn|mining|minage|bonus|cashback|parrainage|referral|distribution|revenu|income|lending|pret|savings|epargne|fork|hard fork/.test(v)) return 'INCOME';
    if (/achat|buy|bought|purchase|acquisition|recurring|dca|investissement/.test(v)) return mode === 'B' ? 'AUTO' : 'BUY';
    if (/vente|sell|sold|cession|realisation/.test(v)) return mode === 'B' ? 'AUTO' : 'SELL';
    if (/transfert|transfer|withdraw|retrait|deposit|depot|envoi|send|sent|receive|reception|virement|move/.test(v)) return 'TRANSFER';
    if (/frais|fee|perte|loss|vol |stolen|hack|burn|don|gift|scam|arnaque/.test(v)) return 'OUT';
    return mode === 'B' ? 'AUTO' : '';
  }

  // ---------- normalisation of imported rows ----------
  // opts: {mode:'A'|'B', headerRow, map, typeMap, decSep, dateOrder, signRule:boolean}
  function normalizeRows(rows, opts) {
    var txs = [], errors = [], ignored = 0, mode = opts.mode, map = opts.map;
    var dec = opts.decSep || 'auto';
    function cell(r, k) { var i = map[k]; return i == null || i < 0 ? null : r[i]; }
    function num(r, k) { return parseNumber(cell(r, k), dec); }
    for (var i = opts.headerRow + 1; i < rows.length; i++) {
      var r = rows[i] || [], line = i + 1;
      if (!r.some(function (c) { return !isEmpty(c); })) continue;
      var ts = parseDate(cell(r, 'date'), opts.dateOrder);
      if (ts == null) { errors.push({ line: line, msg: 'Date illisible : "' + String(cell(r, 'date') == null ? '' : cell(r, 'date')) + '"' }); continue; }
      if (map.time >= 0) {
        var d0 = new Date(ts * 1000);
        ts = Math.floor(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime() / 1000) + parseTimeOfDay(cell(r, 'time'));
      }
      var typeRaw = map.type >= 0 ? cell(r, 'type') : null;
      var tx = { id: uid(), ts: ts, kind: null, out: null, in: null, eur: null, cur: 'EUR', feeEur: 0, fee: null,
        note: map.note >= 0 && !isEmpty(cell(r, 'note')) ? String(cell(r, 'note')).trim() : '', src: 'import', line: line };
      var err = null;

      if (mode === 'A') {
        var sym = normSym(cell(r, 'asset')), qRaw = num(r, 'qty');
        var q = qRaw == null ? null : Math.abs(qRaw);
        var kind;
        if (map.type >= 0) kind = opts.typeMap[norm(typeRaw)];
        else if (opts.signRule) kind = qRaw != null && qRaw < 0 ? 'SELL' : 'BUY';
        if (kind === 'IGNORE') { ignored++; continue; }
        if (!kind) { errors.push({ line: line, msg: 'Type non reconnu : "' + (typeRaw == null ? '' : typeRaw) + '"' }); continue; }
        if (!sym) { errors.push({ line: line, msg: 'Crypto manquante' }); continue; }
        if (isFiat(sym)) { ignored++; continue; } // fiat deposits/withdrawals do not matter
        if (kind !== 'TRANSFER' && !(q > 0)) { errors.push({ line: line, msg: 'Quantité manquante ou nulle' }); continue; }
        var eur = num(r, 'eur'), unit = num(r, 'unit');
        if (eur != null) eur = Math.abs(eur);
        else if (unit != null && q != null) eur = Math.abs(unit) * q;
        var feeE = num(r, 'feeEur');
        if (feeE != null) tx.feeEur = Math.abs(feeE);
        var fq = num(r, 'feeQty');
        if (fq != null && fq !== 0) {
          var fa = normSym(cell(r, 'feeAsset')) || sym;
          if (isFiat(fa)) tx.feeEur += Math.abs(fq); else tx.fee = { a: fa, q: Math.abs(fq) };
        }
        switch (kind) {
          case 'BUY': tx.kind = 'BUY'; tx.in = { a: sym, q: q }; tx.eur = eur; if (eur == null) err = 'Montant EUR manquant pour un achat'; break;
          case 'SELL': case 'PAY': tx.kind = kind; tx.out = { a: sym, q: q }; tx.eur = eur; if (eur == null) err = 'Montant EUR manquant pour une vente'; break;
          case 'SWAP_OUT':
            tx.kind = 'SWAP'; tx.out = { a: sym, q: q };
            var s2 = normSym(cell(r, 'asset2')), q2 = num(r, 'qty2');
            if (s2 && q2) {
              if (isFiat(s2)) { tx.kind = 'SELL'; tx.eur = Math.abs(q2); tx.cur = s2; }
              else tx.in = { a: s2, q: Math.abs(q2) };
            }
            break;
          case 'SWAP_IN': tx.kind = 'SWAP'; tx.in = { a: sym, q: q }; break;
          case 'INCOME': tx.kind = 'INCOME'; tx.in = { a: sym, q: q }; tx.eur = eur; break;
          case 'OUT': tx.kind = 'OUT'; tx.out = { a: sym, q: q }; break;
          case 'TRANSFER': tx.kind = 'TRANSFER'; break;
          default: err = 'Type inconnu';
        }
      } else {
        var sA = normSym(cell(r, 'sentAsset')), sQ = num(r, 'sentQty');
        var rA = normSym(cell(r, 'recvAsset')), rQ = num(r, 'recvQty');
        var fA = normSym(cell(r, 'feeAsset')), fQ = num(r, 'feeQty');
        var ev = num(r, 'eur');
        sQ = sQ == null ? 0 : Math.abs(sQ); rQ = rQ == null ? 0 : Math.abs(rQ);
        if (!sA) sQ = 0; if (!rA) rQ = 0;
        var sentF = sQ > 0 && isFiat(sA), recvF = rQ > 0 && isFiat(rA);
        var sentC = sQ > 0 && !sentF, recvC = rQ > 0 && !recvF;
        var k = map.type >= 0 ? (opts.typeMap[norm(typeRaw)] || 'AUTO') : 'AUTO';
        if (k === 'IGNORE') { ignored++; continue; }
        if (k === 'AUTO') {
          if (sentF && recvC) k = 'BUY';
          else if (sentC && recvF) k = 'SELL';
          else if (sentC && recvC) k = 'SWAP';
          else if (recvC) k = opts.oneSided === 'REAL' ? 'INCOME' : 'TRANSFER';
          else if (sentC) k = opts.oneSided === 'REAL' ? 'OUT' : 'TRANSFER';
          else { ignored++; continue; } // fiat only
        }
        if (fQ) {
          var fa2 = fA || sA || rA;
          if (isFiat(fa2)) { tx.feeEur = Math.abs(fQ); if (!sentF && !recvF) tx.cur = fa2; }
          else tx.fee = { a: fa2, q: Math.abs(fQ) };
        }
        tx.kind = k;
        if (k === 'BUY') {
          if (!recvC) err = 'Achat sans crypto reçue';
          tx.in = recvC ? { a: rA, q: rQ } : null;
          if (sentF) { tx.eur = sQ; tx.cur = sA; } else tx.eur = ev != null ? Math.abs(ev) : null;
          if (tx.eur == null) err = err || 'Montant EUR manquant pour un achat';
        } else if (k === 'SELL' || k === 'PAY') {
          if (!sentC) err = 'Vente sans crypto envoyée';
          tx.out = sentC ? { a: sA, q: sQ } : null;
          if (recvF) { tx.eur = rQ; tx.cur = rA; } else tx.eur = ev != null ? Math.abs(ev) : null;
          if (tx.eur == null) err = err || 'Montant EUR manquant pour une vente';
        } else if (k === 'SWAP') {
          tx.out = sentC ? { a: sA, q: sQ } : null; tx.in = recvC ? { a: rA, q: rQ } : null;
          if (!tx.out && !tx.in) err = 'Échange sans crypto';
        } else if (k === 'INCOME') {
          tx.in = recvC ? { a: rA, q: rQ } : null; tx.eur = ev != null ? Math.abs(ev) : null;
          if (!tx.in) err = 'Revenu sans crypto reçue';
        } else if (k === 'OUT') {
          tx.out = sentC ? { a: sA, q: sQ } : null;
          if (!tx.out) err = 'Sortie sans crypto';
        }
        if (tx.feeEur && tx.cur !== 'EUR' && !sentF && !recvF) tx.cur = 'EUR';
      }
      if (err) { errors.push({ line: line, msg: err }); continue; }
      txs.push(tx);
    }
    return { txs: txs, errors: errors, ignored: ignored };
  }

  function txKey(t) {
    return [t.ts, t.kind, t.out ? t.out.a + ':' + round(t.out.q, 10) : '', t.in ? t.in.a + ':' + round(t.in.q, 10) : '', t.eur == null ? '' : round(t.eur, 2)].join('|');
  }
  function round(x, d) { var p = Math.pow(10, d); return Math.round(x * p) / p; }

  // ---------- prices ----------
  // series: array of [epochSec, price] sorted by time
  function mergeSeries(a, b) {
    var m = {};
    (a || []).forEach(function (p) { m[p[0]] = p[1]; });
    (b || []).forEach(function (p) { m[p[0]] = p[1]; });
    return Object.keys(m).map(function (k) { return [+k, m[k]]; }).sort(function (x, y) { return x[0] - y[0]; });
  }
  function nearest(series, ts, tolSec) {
    if (!series || !series.length) return null;
    var lo = 0, hi = series.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (series[mid][0] < ts) lo = mid + 1; else hi = mid; }
    var best = series[lo];
    if (lo > 0 && Math.abs(series[lo - 1][0] - ts) < Math.abs(best[0] - ts)) best = series[lo - 1];
    return Math.abs(best[0] - ts) <= tolSec ? { p: best[1], ts: best[0] } : null;
  }
  function latest(series) { return series && series.length ? { p: series[series.length - 1][1], ts: series[series.length - 1][0] } : null; }

  // ctx: {assets:{SYM:{id, zero:bool}}, prices:{id:series}, tolDays}
  function makePricer(ctx) {
    var tol = (ctx.tolDays == null ? 2 : ctx.tolDays) * DAY;
    function idOf(sym) {
      if (sym === 'USD') return 'usd-coin';
      var c = ctx.assets[sym];
      return c && c.id ? c.id : null;
    }
    return {
      price: function (sym, ts) {
        if (sym === 'EUR') return 1;
        var c = ctx.assets[sym];
        if (c && c.zero) return 0;
        var id = idOf(sym);
        if (!id) return null;
        var n = nearest(ctx.prices[id], ts, tol);
        return n ? n.p : null;
      },
      latest: function (sym) {
        var c = ctx.assets[sym];
        if (c && c.zero) return { p: 0, ts: null };
        var id = idOf(sym);
        return id ? latest(ctx.prices[id]) : null;
      },
      idOf: idOf
    };
  }

  // ---------- engine ----------
  // settings: {incomeInPTA:boolean, overrides:{txid:V}, rates:{before2026:30, from2026:31.4}}
  function compute(txs, ctx, settings) {
    settings = settings || {};
    var overrides = settings.overrides || {};
    var pr = makePricer(ctx);
    var list = txs.map(function (t, i) { return { t: t, i: i }; })
      .sort(function (a, b) { return a.t.ts - b.t.ts || a.i - b.i; }).map(function (x) { return x.t; });
    var hold = {}, PTA = 0, fractions = 0;
    var cessions = [], negatives = {}, warnings = [], needed = {};

    function add(a, q) { if (!a || isFiat(a)) return; hold[a] = (hold[a] || 0) + q; }
    function sub(a, q, t) {
      if (!a || isFiat(a)) return;
      var before = hold[a] || 0, after = before - q;
      if (after < -Math.max(EPS, q * 1e-9)) {
        var n = negatives[a] || (negatives[a] = { asset: a, count: 0, maxDeficit: 0, first: t.ts, firstTx: t.id });
        n.count++; n.maxDeficit = Math.max(n.maxDeficit, -after);
        after = 0;
      }
      hold[a] = Math.max(0, after);
    }
    function toEur(amount, cur, ts) {
      if (amount == null) return null;
      if (!cur || cur === 'EUR') return amount;
      var r = pr.price(cur, ts);
      if (r == null) { need(pr.idOf(cur), ts, cur); return null; }
      return amount * r;
    }
    function need(id, ts, sym) {
      if (!id) return;
      var n = needed[id] || (needed[id] = { id: id, sym: sym, min: ts, max: ts, count: 0 });
      n.min = Math.min(n.min, ts); n.max = Math.max(n.max, ts); n.count++;
    }

    list.forEach(function (t) {
      var eurE = toEur(t.eur, t.cur, t.ts);
      var feeE = t.feeEur ? toEur(t.feeEur, t.cur, t.ts) : 0;
      if (feeE == null) feeE = 0;
      switch (t.kind) {
        case 'BUY':
          if (t.in) add(t.in.a, t.in.q);
          if (eurE == null) warnings.push({ tx: t.id, ts: t.ts, msg: 'Achat sans montant en EUR exploitable : prix d\'acquisition sous-estimé' });
          else PTA += eurE + feeE;
          break;
        case 'INCOME':
          if (t.in) add(t.in.a, t.in.q);
          if (settings.incomeInPTA && eurE) PTA += eurE;
          break;
        case 'SWAP':
          if (t.out) sub(t.out.a, t.out.q, t);
          if (t.in) add(t.in.a, t.in.q);
          break;
        case 'OUT':
          if (t.out) sub(t.out.a, t.out.q, t);
          break;
        case 'TRANSFER':
          break;
        case 'SELL': case 'PAY': {
          var V = 0, missing = [], missingDetail = [], detail = [];
          Object.keys(hold).forEach(function (a) {
            var q = hold[a];
            if (q <= EPS) return;
            var p = pr.price(a, t.ts);
            if (p == null) { missing.push(a); missingDetail.push({ a: a, q: q }); need(pr.idOf(a), t.ts, a); if (!pr.idOf(a)) need('__nomap__' + a, t.ts, a); return; }
            V += q * p; detail.push({ a: a, q: q, p: p, v: q * p });
          });
          var Vauto = V;
          var ov = overrides[t.id];
          var manual = ov != null && ov !== '' && isFinite(+ov) && +ov > 0;
          if (manual) V = +ov;
          var C = eurE, issues = [];
          if (C == null) issues.push('Prix de cession en EUR manquant');
          if (!manual && missing.length) issues.push('Prix manquant pour : ' + missing.join(', ') + ' (valeur du portefeuille incomplète)');
          if (C != null && V > 0 && C > V * 1.0001) issues.push('Prix de cession supérieur à la valeur du portefeuille : données incohérentes');
          if (t.out && (hold[t.out.a] || 0) < t.out.q * (1 - 1e-9)) issues.push('Solde insuffisant de ' + t.out.a + ' au moment de la vente : transactions manquantes');
          var PTAnet = PTA - fractions;
          var pv = null, frac = null, blocking = false;
          if (C != null && V > 0) {
            frac = PTAnet * C / V;
            pv = (C - feeE) - frac;
            fractions += frac;
          } else blocking = true;
          var d = new Date(t.ts * 1000);
          cessions.push({
            tx: t.id, ts: t.ts, year: d.getFullYear(), kind: t.kind,
            asset: t.out ? t.out.a : '?', qty: t.out ? t.out.q : 0,
            V: V, Vauto: Vauto, manual: manual, detail: detail, missing: missing, missingDetail: missingDetail,
            C: C, fees: feeE, net: C == null ? null : C - feeE,
            PTA: PTA, fractionsBefore: PTA - PTAnet,
            PTAnet: PTAnet, frac: frac, pv: pv, issues: issues, blocking: blocking,
            ok: !blocking && issues.length === 0
          });
          if (t.out) sub(t.out.a, t.out.q, t);
          break;
        }
      }
      if (t.fee && t.fee.q) sub(t.fee.a, t.fee.q, t);
    });

    // yearly aggregation
    var years = {};
    cessions.forEach(function (c) {
      var y = years[c.year] || (years[c.year] = { year: c.year, cessions: [], totalC: 0, totalPV: 0, issues: 0 });
      y.cessions.push(c);
      y.totalC += c.C || 0;
      y.totalPV += c.pv || 0;
      if (!c.ok) y.issues++;
    });
    var rates = settings.rates || { before2026: 30, from2026: 31.4 };
    Object.keys(years).forEach(function (k) {
      var y = years[k];
      y.exempt = y.totalC <= 305;
      y.rate = y.year >= 2026 ? rates.from2026 : rates.before2026;
      y.tax = y.exempt || y.totalPV <= 0 ? 0 : y.totalPV * y.rate / 100;
    });

    return {
      cessions: cessions, years: years, holdings: hold, PTA: PTA, fractions: fractions, PTAnet: PTA - fractions,
      negatives: Object.keys(negatives).map(function (k) { return negatives[k]; }),
      warnings: warnings, needed: needed, sorted: list
    };
  }

  // Value of current holdings with the most recent cached prices
  function currentValue(holdings, ctx) {
    var pr = makePricer(ctx), total = 0, rows = [], missing = [], oldest = null;
    Object.keys(holdings).forEach(function (a) {
      var q = holdings[a];
      if (q <= EPS) return;
      var l = pr.latest(a);
      if (!l) { missing.push(a); rows.push({ a: a, q: q, p: null, v: null }); return; }
      total += q * l.p;
      if (l.ts && (oldest == null || l.ts < oldest)) oldest = l.ts;
      rows.push({ a: a, q: q, p: l.p, v: q * l.p, ts: l.ts });
    });
    rows.sort(function (x, y) { return (y.v || 0) - (x.v || 0); });
    return { total: total, rows: rows, missing: missing, oldest: oldest };
  }

  // Tax simulation of a sale of C euros today
  function simulate(C, fees, V, PTAnet) {
    if (!(V > 0) || !(C > 0)) return null;
    var frac = PTAnet * C / V;
    return { frac: frac, pv: (C - (fees || 0)) - frac, ratio: C / V };
  }

  // ---------- price CSV import ----------
  function parsePriceTable(rows) {
    var hr = 0, h = null;
    for (var i = 0; i < Math.min(rows.length, 10); i++) {
      var hn = (rows[i] || []).map(norm);
      if (hn.some(function (x) { return /date|snapped at|time|timestamp|jour/.test(x); })) { hr = i; h = hn; break; }
    }
    var dc = -1, pc = -1;
    if (h) {
      h.forEach(function (x, j) {
        if (dc < 0 && /^(date|snapped at|timestamp|time open|timeopen|jour|time|date utc)$/.test(x)) dc = j;
      });
      if (dc < 0) h.forEach(function (x, j) { if (dc < 0 && /date|snapped|time/.test(x)) dc = j; });
      var pref = ['close', 'cloture', 'dernier', 'price', 'prix', 'last', 'cours', 'adj close'];
      for (var p = 0; p < pref.length && pc < 0; p++) h.forEach(function (x, j) { if (pc < 0 && j !== dc && x.indexOf(pref[p]) >= 0) pc = j; });
    } else { hr = -1; dc = 0; pc = 1; }
    if (dc < 0 || pc < 0) return { error: 'Colonnes date / prix introuvables (attendu : date + price/close/clôture)' };
    var dec = detectDecimal(rows.slice(hr + 1));
    var pts = [];
    for (var r = hr + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var ts = parseDate(row[dc], 'DMY'), p2 = parseNumber(row[pc], dec);
      if (ts != null && p2 != null && p2 >= 0) pts.push([ts, p2]);
    }
    pts.sort(function (a, b) { return a[0] - b[0]; });
    return { points: pts, dateCol: h ? rows[hr][dc] : 'col 1', priceCol: h ? rows[hr][pc] : 'col 2' };
  }

  // ---------- CoinGecko ----------
  function cgUrl(path, params, settings) {
    var pro = settings && settings.keyType === 'pro' && settings.apiKey;
    var base = pro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    var q = [];
    Object.keys(params || {}).forEach(function (k) { q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); });
    if (settings && settings.apiKey) q.push((pro ? 'x_cg_pro_api_key=' : 'x_cg_demo_api_key=') + encodeURIComponent(settings.apiKey));
    return base + path + (q.length ? '?' + q.join('&') : '');
  }
  function cgSeries(json) {
    return ((json && json.prices) || []).map(function (p) { return [Math.floor(p[0] / 1000), p[1]]; });
  }

  // ---------- report CSV ----------
  function reportCSV(year) {
    var head = ['Cession', '211 Date', 'Crypto', 'Quantité', '212 Valeur globale portefeuille', '213 Prix de cession',
      '214 Frais de cession', '215 Prix net de frais', '217 Prix net des soultes', '218 Prix net frais et soultes',
      '220 Prix total d\'acquisition', '221 Fractions de capital initial', '222 Soultes reçues', '223 Prix total d\'acquisition net',
      '224 Plus ou moins-value', 'Statut'];
    var lines = [head];
    year.cessions.forEach(function (c, i) {
      lines.push([i + 1, fmtDate(c.ts), c.asset, fr(c.qty, 8), fr(c.V, 0), fr(c.C, 0), fr(c.fees, 0), fr(c.net, 0),
        fr(c.C, 0), fr(c.net, 0), fr(c.PTA, 0), fr(c.PTA - c.PTAnet, 0), '0', fr(c.PTAnet, 0), fr(c.pv, 0),
        c.ok ? 'OK' : ('À vérifier : ' + c.issues.join(' / '))]);
    });
    lines.push([]);
    lines.push(['Total des cessions', '', '', '', '', fr(year.totalC, 0)]);
    lines.push(['Plus ou moins-value globale (3AN si positive, 3BN si négative)', '', '', '', '', '', '', '', '', '', '', '', '', '', fr(year.totalPV, 0)]);
    return lines.map(function (l) { return l.map(csvCell).join(';'); }).join('\r\n');
  }
  function csvCell(v) { v = v == null ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function fr(x, d) { return x == null || !isFinite(x) ? '' : x.toFixed(d).replace('.', ','); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(ts) { var d = new Date(ts * 1000); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); }

  return {
    FIAT: FIAT, DAY: DAY, KIND_LABELS: KIND_LABELS, MAP_KINDS_A: MAP_KINDS_A, MAP_KINDS_B: MAP_KINDS_B,
    DEFAULT_IDS: DEFAULT_IDS, FIELDS_A: FIELDS_A, FIELDS_B: FIELDS_B,
    norm: norm, normSym: normSym, isFiat: isFiat, uid: uid, parseNumber: parseNumber, detectDecimal: detectDecimal,
    parseDate: parseDate, parseCSV: parseCSV, guessHeaderRow: guessHeaderRow, guessMapping: guessMapping,
    guessKind: guessKind, normalizeRows: normalizeRows, txKey: txKey, mergeSeries: mergeSeries, nearest: nearest,
    makePricer: makePricer, compute: compute, currentValue: currentValue, simulate: simulate,
    parsePriceTable: parsePriceTable, cgUrl: cgUrl, cgSeries: cgSeries, reportCSV: reportCSV, fmtDate: fmtDate
  };
});
