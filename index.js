const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode');
const nodemailer = require('nodemailer');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// ─── DATA & STATE ───
const waSessions = new Map();
let settings = { check_delay: 1000, active_mt_id: 0, email: '', email_pass: '' };
let mtTexts = [];

const WHATSAPP_EMAIL = "android@support.whatsapp.com";
const RANDOM_NAMES = ["Luai", "Ahmad", "Rizky", "Budi", "Sari", "Dewi", "Putra", "Indra", "Rina", "Fajar"];
const APPEAL_MESSAGES = [
  "Hello WhatsApp team, my name is (NAME). I'm having trouble registering my phone number (+NUMBER). I keep getting a 'login unavailable' error. Please help me resolve this issue.",
  "Hola equipo de WhatsApp, me llamo (NAME). Estoy teniendo problemas para registrar mi número de teléfono (+NUMBER). Aparece el mensaje 'inicio de sesión no disponible'. Por favor, ayúdenme a resolver este problema.",
  "Bonjour l'équipe WhatsApp, je m'appelle (NAME). J'ai des difficultés à enregistrer mon numéro de téléphone (+NUMBER). Le message 'connexion non disponible' apparaît. Aidez-moi à résoudre ce problème, s'il vous plaît.",
  "Hallo WhatsApp-Team, mein Name ist (NAME). Ich habe Probleme bei der Registrierung meiner Telefonnummer (+NUMBER). Die Meldung 'Anmeldung nicht verfügbar' erscheint. Bitte helfen Sie mir, dieses Problem zu lösen."
];

if (fs.existsSync('settings.json')) settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
if (fs.existsSync('mt_texts.json')) mtTexts = JSON.parse(fs.readFileSync('mt_texts.json', 'utf8'));

function saveSettings() { fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2)); }
function saveMt() { fs.writeFileSync('mt_texts.json', JSON.stringify(mtTexts, null, 2)); }

// ─── REAL HELPER FUNCTIONS (DARI BOT ASLI) ───
function formatNumber(raw) {
  let n = raw.replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.substring(1);
  else if (n.startsWith('8')) n = '62' + n;
  return n;
}
function isValidNumber(n) { return n.length >= 10 && n.length <= 15; }

function isRepeNumber(number) {
  const s = number.toString();
  if (/(\d)\1{2,}/.test(s)) return true;
  const d = s.split('').map(Number);
  let up = true, down = true;
  for (let i = 1; i < d.length; i++) {
    if (d[i] !== d[i-1]+1) up = false;
    if (d[i] !== d[i-1]-1) down = false;
  }
  if (up || down) return true;
  if (s === s.split('').reverse().join('')) return true;
  if (s.length % 2 === 0 && s.slice(0, s.length/2) === s.slice(s.length/2)) return true;
  return false;
}

function getVerificationPercentage(number) {
  const s = number.toString();
  if (isRepeNumber(number)) return 99;
  if (/(\d)\1{3,}/.test(s)) return 95;
  if (/(\d)\1{2,}/.test(s)) return 90;
  const d = s.split('').map(Number);
  let up = true, down = true;
  for (let i = 1; i < d.length; i++) {
    if (d[i] !== d[i-1]+1) up = false;
    if (d[i] !== d[i-1]-1) down = false;
  }
  if (up || down) return 85;
  if (s.length >= 6) {
    if (s.length % 2 === 0 && s.slice(0, s.length/2) === s.slice(s.length/2)) return 80;
    if (/(\d)\1(\d)\2(\d)\3/.test(s)) return 75;
  }
  if (s.length >= 12) return 70;
  if (s.length >= 10) return 60;
  if (s.length >= 8) return 50;
  return 40;
}

function getJamPercentage(bio, setAt, metaBusiness) {
  let base = 50;
  if (bio && bio.length > 0) {
    if (bio.length > 100) base -= 20;
    else if (bio.length > 50) base -= 15;
    else if (bio.length > 20) base -= 10;
    else base -= 5;
  } else { base += 15; }
  if (setAt) {
    const diff = Math.ceil(Math.abs(new Date() - new Date(setAt)) / 86400000);
    if (diff < 30) base -= 20;
    else if (diff < 90) base -= 10;
    else if (diff > 730) base += 25;
    else if (diff > 365) base += 15;
  } else { base += 10; }
  if (metaBusiness) base -= 25;
  return Math.round(Math.max(10, Math.min(90, base)) / 10) * 10;
}

function getRandomName() { return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)]; }
function getRandomAppealMessage(name, number) {
  const idx = Math.floor(Math.random() * APPEAL_MESSAGES.length);
  return APPEAL_MESSAGES[idx].replace('(NAME)', name).replace('+NUMBER', number);
}

// ─── WHATSAPP SESSION MANAGEMENT ───
async function startWhatsAppSession(sessionId, socket) {
  if (waSessions.has(sessionId) && waSessions.get(sessionId).isConnected) {
    return socket.emit('wa-status', { status: 'connected', number: waSessions.get(sessionId).number });
  }

  const authDir = `./auth_${sessionId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  waSessions.set(sessionId, { sock, isConnected: false, number: '' });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      try {
        // PERBAIKAN QR: Langsung kirim base64 image, tidak pakai frontend library
        const qrImage = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
        socket.emit('wa-qr', qrImage);
      } catch (err) {
        console.error("QR Generate Error:", err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if(waSessions.has(sessionId)) waSessions.get(sessionId).isConnected = false;
      socket.emit('wa-status', { status: 'disconnected' });
      
      if (shouldReconnect) {
        setTimeout(() => startWhatsAppSession(sessionId, socket), 5000);
      } else {
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true });
      }
    } else if (connection === 'open') {
      if(waSessions.has(sessionId)) {
        waSessions.get(sessionId).isConnected = true;
        waSessions.get(sessionId).number = sock.user.id.split(':')[0];
        socket.emit('wa-status', { status: 'connected', number: sock.user.id.split(':')[0] });
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── REAL CEK BIO LOGIC ───
async function checkSingleNumber(sock, num) {
  try {
    const jid = num + '@s.whatsapp.net';
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) return { number: num, registered: false, bio: null, setAt: null, metaBusiness: false, repe: isRepeNumber(num), verifPercent: getVerificationPercentage(num), jamPercentage: 0 };

    let bioData = '', setAt = null, metaBusiness = false;
    try {
      await new Promise(r => setTimeout(r, 300));
      const sr = await sock.fetchStatus(jid);
      if (sr?.[0]?.status) { bioData = sr[0].status.status || ''; setAt = sr[0].status.setAt ? new Date(sr[0].status.setAt) : null; }
    } catch {}
    try { const bp = await sock.getBusinessProfile(jid); metaBusiness = !!bp; } catch {}

    return { 
      number: num, 
      registered: true, 
      bio: bioData, 
      setAt, 
      metaBusiness, 
      repe: isRepeNumber(num), 
      verifPercent: getVerificationPercentage(num), 
      jamPercentage: getJamPercentage(bioData, setAt, metaBusiness) 
    };
  } catch { return { number: num, registered: false, bio: null, setAt: null, metaBusiness: false, repe: isRepeNumber(num), verifPercent: getVerificationPercentage(num), jamPercentage: 0, error: true }; }
}

// ─── SOCKET.IO EVENTS ───
io.on('connection', (socket) => {
  const sessionId = socket.id;

  socket.on('connect-wa', () => startWhatsAppSession(sessionId, socket));

  socket.on('get-pairing', async (phone) => {
    const session = waSessions.get(sessionId);
    if (session?.sock && !session.isConnected) {
      try {
        const code = await session.sock.requestPairingCode(phone);
        socket.emit('pairing-code', code.match(/.{1,4}/g)?.join('-') || code);
      } catch (e) { socket.emit('error-msg', 'Gagal minta pairing code. Coba lagi.'); }
    } else {
      socket.emit('error-msg', 'Sesi belum siap atau sudah terhubung.');
    }
  });

  socket.on('disconnect-wa', () => {
    const session = waSessions.get(sessionId);
    if (session?.sock) { session.sock.end(); session.isConnected = false; socket.emit('wa-status', { status: 'disconnected' }); }
  });

  socket.on('cek-bio', async (numbers) => {
    const session = waSessions.get(sessionId);
    if (!session?.isConnected) return socket.emit('error-msg', 'Hubungkan WhatsApp dulu!');
    
    const valid = numbers.map(formatNumber).filter(isValidNumber);
    if(valid.length === 0) return socket.emit('error-msg', 'Tidak ada nomor valid!');
    
    const delay = settings.check_delay || 1000;
    const results = [];

    for (let i = 0; i < valid.length; i += 5) {
      const batch = valid.slice(i, i+5);
      const batchRes = await Promise.all(batch.map(n => checkSingleNumber(session.sock, n)));
      results.push(...batchRes);
      socket.emit('bio-progress', { current: Math.min(i+5, valid.length), total: valid.length });
      if (i+5 < valid.length) await new Promise(r => setTimeout(r, delay));
    }
    socket.emit('bio-result', results);
  });

  socket.on('cek-nomor', async (numbers) => {
    const session = waSessions.get(sessionId);
    if (!session?.isConnected) return socket.emit('error-msg', 'Hubungkan WhatsApp dulu!');
    
    const valid = numbers.map(formatNumber).filter(isValidNumber);
    if(valid.length === 0) return socket.emit('error-msg', 'Tidak ada nomor valid!');

    const registered = [], notRegistered = [];

    for (let i = 0; i < valid.length; i += 10) {
      const batch = valid.slice(i, i+10);
      const res = await Promise.all(batch.map(async n => {
        try { const [chk] = await session.sock.onWhatsApp(n + '@s.whatsapp.net'); return { n, ok: !!(chk?.exists) }; }
        catch { return { n, ok: false }; }
      }));
      res.forEach(r => (r.ok ? registered : notRegistered).push(r.n));
      socket.emit('nomor-progress', { current: Math.min(i+10, valid.length), total: valid.length });
    }
    socket.emit('nomor-result', { registered, notRegistered });
  });

  socket.on('fix-nomor', async (number) => {
    const num = formatNumber(number);
    const activeMt = mtTexts.find(m => m.id === settings.active_mt_id);
    if (!activeMt) return socket.emit('error-msg', 'Tidak ada template email (MT) aktif! Atur di Admin.');

    try {
      const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, auth: { user: settings.email, pass: settings.email_pass } });
      await transporter.sendMail({ from: settings.email, to: activeMt.to_email, subject: activeMt.subject, text: activeMt.body.replace(/{nomor}/g, num) });
      socket.emit('fix-result', { success: true, message: `Nomor ${num} berhasil dikirim ke ${activeMt.to_email}` });
    } catch (e) { socket.emit('fix-result', { success: false, message: e.message }); }
  });

  socket.on('disconnect', () => {
    const session = waSessions.get(sessionId);
    if (session?.sock && !session.isConnected) { session.sock.end(); waSessions.delete(sessionId); }
  });
});

// ─── API ROUTES ───
app.post('/upload-file', upload.single('file'), (req, res) => {
  try {
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let numbers = [];
    if (ext === 'txt') {
      numbers = fs.readFileSync(req.file.path, 'utf8').split(/[\r\n]+/).filter(l => l.trim());
    } else if (ext === 'xlsx') {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      numbers = XLSX.utils.sheet_to_json(ws, { header: 1 }).flat().filter(Boolean).map(String);
    }
    fs.unlinkSync(req.file.path);
    res.json({ numbers: numbers.map(formatNumber).filter(isValidNumber) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/settings', (req, res) => res.json(settings));
app.post('/settings', (req, res) => { settings = req.body; saveSettings(); res.json({ success: true }); });
app.get('/mt', (req, res) => res.json(mtTexts));
app.post('/mt', (req, res) => { const newMt = { id: Date.now(), ...req.body }; mtTexts.push(newMt); saveMt(); res.json(newMt); });
app.post('/mt/active', (req, res) => { settings.active_mt_id = req.body.id; saveSettings(); res.json({ success: true }); });

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 ADI FIX MERAH V12 APP running on port ${PORT}`));