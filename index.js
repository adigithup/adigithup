const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const { promisify } = require('util');
const nodemailer = require('nodemailer');

// Configuration
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Logger setup
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' }),
    new transports.Console()
  ]
});

// Pastikan folder logs ada
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

// Rate limiting dengan express-rate-limit
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 100, // maksimal 100 request per IP
  message: { error: 'Too many requests, please try again later.' }
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use('/api', limiter); // hanya terapkan ke route API
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_dashboard',
    ttl: 24 * 60 * 60
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_dashboard')
  .then(() => logger.info('MongoDB connected successfully'))
  .catch(err => logger.error('MongoDB connection error:', err));

// Socket.IO connection
io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);
  socket.on('join-dashboard', (userId) => {
    socket.join(`dashboard-${userId}`);
  });
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);
  });
});

// File upload middleware
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Models
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['user', 'admin', 'owner'], default: 'user' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

const SessionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive', 'pending'], default: 'pending' },
  type: { type: String, enum: ['qr', 'pair'], default: 'qr' },
  phoneNumber: { type: String },
  qrCode: { type: String },
  pairingCode: { type: String },
  authState: { type: Object },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const HistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  details: { type: String },
  timestamp: { type: Date, default: Date.now }
});

const SettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);
const History = mongoose.model('History', HistorySchema);
const Setting = mongoose.model('Setting', SettingSchema);

// Authentication middleware (konsisten menggunakan req.session.user)
const isAuthenticated = (req, res, next) => {
  if (req.session.user && req.session.user.id) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
};

// Helper: parse file (CSV/Excel)
const parseFile = (filePath) => {
  return new Promise((resolve, reject) => {
    const ext = path.extname(filePath).toLowerCase();
    let numbers = [];
    if (ext === '.csv') {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          const num = row.number || row.phone || Object.values(row)[0];
          if (num) numbers.push(num.toString().trim());
        })
        .on('end', () => resolve(numbers))
        .on('error', reject);
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet);
      numbers = data.map(row => row.number || row.phone || Object.values(row)[0]).filter(v => v).map(v => v.toString().trim());
      resolve(numbers);
    } else {
      reject(new Error('Format file tidak didukung'));
    }
  });
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Registrasi user (untuk testing, sebaiknya dihapus di production)
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, email });
    await user.save();
    res.json({ success: true, message: 'User registered' });
  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.user = {
      id: user._id,
      username: user.username,
      role: user.role
    };
    res.json({ success: true, user: req.session.user });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Session routes
app.post('/api/whatsapp/session/create', isAuthenticated, async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name) return res.status(400).json({ error: 'Session name required' });
    const session = new Session({ name, type: type || 'qr', status: 'pending' });
    await session.save();
    res.json({ success: true, sessionId: session._id });
  } catch (error) {
    logger.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// WhatsApp session management
const sessions = new Map();

async function createWhatsAppSession(sessionId, io) {
  try {
    const sessionDoc = await Session.findById(sessionId);
    if (!sessionDoc) throw new Error('Session not found');

    const authFolder = path.join(__dirname, 'sessions', sessionId);
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveState } = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger
    });

    sessions.set(sessionId, { sock, saveState });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const qrCode = await qrcode.toDataURL(qr);
        await Session.findByIdAndUpdate(sessionId, { qrCode, status: 'pending' });
        io.emit('whatsapp-update', { type: 'qr', sessionId, message: 'QR code generated' });
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          logger.info(`Reconnecting session ${sessionId}...`);
          setTimeout(() => createWhatsAppSession(sessionId, io), 3000);
        } else {
          await Session.findByIdAndUpdate(sessionId, { status: 'inactive' });
          io.emit('whatsapp-update', { type: 'disconnected', sessionId, message: 'Session logged out' });
          sessions.delete(sessionId);
        }
      }
      if (connection === 'open') {
        await Session.findByIdAndUpdate(sessionId, { status: 'active', qrCode: null });
        io.emit('whatsapp-update', { type: 'connected', sessionId, message: 'Session connected' });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      // Bisa diisi jika perlu logging pesan
    });

    return sock;
  } catch (error) {
    logger.error('Error creating WhatsApp session:', error);
    throw error;
  }
}

app.post('/api/whatsapp/session/:sessionId/start', isAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const existing = sessions.get(sessionId);
    if (existing) {
      return res.json({ success: true, message: 'Session already running' });
    }
    await createWhatsAppSession(sessionId, io);
    res.json({ success: true, message: 'Session started' });
  } catch (error) {
    logger.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

app.delete('/api/whatsapp/session/:sessionId', isAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
      sessionData.sock.end();
      sessions.delete(sessionId);
    }
    // Hapus folder auth jika perlu
    const authFolder = path.join(__dirname, 'sessions', sessionId);
    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
    await Session.findByIdAndDelete(sessionId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Check routes dengan dukungan file
app.post('/api/check/bio', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    let numbersArray = [];
    if (req.file) {
      const filePath = req.file.path;
      numbersArray = await parseFile(filePath);
      fs.unlinkSync(filePath); // hapus file setelah parsing
    } else if (req.body.numbers) {
      numbersArray = req.body.numbers.split(',').map(n => n.trim());
    } else {
      return res.status(400).json({ error: 'No numbers provided' });
    }

    const delay = parseInt(req.body.delay) || 0;
    const results = [];
    const sessionEntry = sessions.values().next().value;
    if (!sessionEntry) throw new Error('No active WhatsApp session');

    for (const number of numbersArray) {
      try {
        const jid = number + '@s.whatsapp.net';
        const info = await sessionEntry.sock.fetchStatus(jid);
        results.push({
          number,
          status: 'registered',
          bio: info.status || '',
          lastUpdate: info.lastUpdate
        });
      } catch (error) {
        results.push({ number, status: 'error', error: error.message });
      }
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }

    await History.create({
      userId: req.session.user.id,
      action: 'check_bio',
      details: `Checked ${numbersArray.length} numbers`
    });
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking bio:', error);
    res.status(500).json({ error: error.message || 'Failed to check bio' });
  }
});

app.post('/api/check/registered', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    let numbersArray = [];
    if (req.file) {
      const filePath = req.file.path;
      numbersArray = await parseFile(filePath);
      fs.unlinkSync(filePath);
    } else if (req.body.numbers) {
      numbersArray = req.body.numbers.split(',').map(n => n.trim());
    } else {
      return res.status(400).json({ error: 'No numbers provided' });
    }

    const delay = parseInt(req.body.delay) || 0;
    const results = [];
    const sessionEntry = sessions.values().next().value;
    if (!sessionEntry) throw new Error('No active WhatsApp session');

    for (const number of numbersArray) {
      try {
        const jid = number + '@s.whatsapp.net';
        const exists = await sessionEntry.sock.isOnWhatsApp(jid);
        results.push({ number, registered: exists });
      } catch (error) {
        results.push({ number, registered: false, error: error.message });
      }
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }

    await History.create({
      userId: req.session.user.id,
      action: 'check_registered',
      details: `Checked ${numbersArray.length} numbers`
    });
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking registered numbers:', error);
    res.status(500).json({ error: error.message || 'Failed to check registered numbers' });
  }
});

// Email route (perbaikan nodemailer)
app.post('/api/email/send', isAuthenticated, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: body
    });
    await History.create({
      userId: req.session.user.id,
      action: 'send_email',
      details: `Email sent to ${to}`
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Dashboard stats
app.get('/api/dashboard/stats', isAuthenticated, async (req, res) => {
  try {
    const stats = {
      totalUsers: await User.countDocuments(),
      activeSessions: await Session.countDocuments({ status: 'active' }),
      totalChecks: await History.countDocuments(),
      systemStatus: (await Setting.findOne({ key: 'system_status' }))?.value || 'active'
    };
    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Error getting dashboard stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Monitoring
app.get('/api/monitor/sessions', isAuthenticated, async (req, res) => {
  try {
    const sessionsList = await Session.find({});
    res.json({ success: true, sessions: sessionsList });
  } catch (error) {
    logger.error('Error getting session monitoring data:', error);
    res.status(500).json({ error: 'Failed to get session monitoring data' });
  }
});

app.get('/api/monitor/activity', isAuthenticated, async (req, res) => {
  try {
    const activity = await History.find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .populate('userId', 'username');
    res.json({ success: true, activity });
  } catch (error) {
    logger.error('Error getting activity monitoring data:', error);
    res.status(500).json({ error: 'Failed to get activity monitoring data' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  await Setting.findOneAndUpdate(
    { key: 'system_status' },
    { value: 'active' },
    { upsert: true }
  );
  logger.info('System status initialized');
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Graceful shutdown...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
process.on('SIGTERM', () => {
  logger.info('Graceful shutdown...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});