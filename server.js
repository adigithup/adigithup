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
const rateLimit = require('rate-limiter-flexible');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const PassThrough = require('stream');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

// Rate limiting
const limiter = rateLimit.createRateLimiter({
  keyGenerator: (req) => req.ip,
  points: 100,
  duration: 60,
  blockDuration: 60,
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(limiter);
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
    ttl: 24 * 60 * 60 // 1 day
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_dashboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => logger.info('MongoDB connected successfully'))
.catch(err => logger.error('MongoDB connection error:', err));

// Socket.IO connection
io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);
  
  // Join dashboard room for real-time updates
  socket.on('join-dashboard', (userId) => {
    socket.join(`dashboard-${userId}`);
  });
  
  // WhatsApp session events
  socket.on('whatsapp-event', (data) => {
    io.emit('whatsapp-update', data);
  });
  
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);
  });
});

// File upload middleware
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
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

// Authentication middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
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

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Authentication routes
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
    const session = new Session({ name, type, status: 'pending' });
    await session.save();
    res.json({ success: true, sessionId: session._id });
  } catch (error) {
    logger.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.post('/api/whatsapp/session/:sessionId/connect', isAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Generate QR code (simulated)
    const qrCode = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`;
    
    session.qrCode = qrCode;
    session.status = 'pending';
    await session.save();
    
    res.json({ success: true, qrCode });
  } catch (error) {
    logger.error('Error connecting session:', error);
    res.status(500).json({ error: 'Failed to connect session' });
  }
});

app.post('/api/whatsapp/session/:sessionId/pair', isAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { phoneNumber } = req.body;
    const session = await Session.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // Generate pairing code (simulated)
    const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    session.pairingCode = pairingCode;
    session.phoneNumber = phoneNumber;
    session.status = 'pending';
    await session.save();
    
    res.json({ success: true, pairingCode });
  } catch (error) {
    logger.error('Error pairing session:', error);
    res.status(500).json({ error: 'Failed to pair session' });
  }
});

app.get('/api/whatsapp/session/:sessionId/status', isAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({ success: true, status: session.status });
  } catch (error) {
    logger.error('Error getting session status:', error);
    res.status(500).json({ error: 'Failed to get session status' });
  }
});

app.delete('/api/whatsapp/session/:sessionId', isAuthenticated, async (req, res) => {
  try {
    const { sessionId } = req.params;
    await Session.findByIdAndDelete(sessionId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Check routes
app.post('/api/check/bio', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const { numbers, delay } = req.body;
    const numbersArray = numbers ? numbers.split(',').map(n => n.trim()) : [];
    
    // Simulate check process
    const results = numbersArray.map(num => ({
      number: num,
      status: Math.random() > 0.3 ? 'registered' : 'not_registered',
      bio: Math.random() > 0.5 ? 'Sample bio text' : '',
      metaBusiness: Math.random() > 0.7
    }));
    
    // Save to history
    const history = new History({
      userId: req.session.user.id,
      action: 'check_bio',
      details: `Checked ${numbersArray.length} numbers`
    });
    await history.save();
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking bio:', error);
    res.status(500).json({ error: 'Failed to check bio' });
  }
});

app.post('/api/check/registered', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const { numbers, delay } = req.body;
    const numbersArray = numbers ? numbers.split(',').map(n => n.trim()) : [];
    
    // Simulate check process
    const results = numbersArray.map(num => ({
      number: num,
      registered: Math.random() > 0.3
    }));
    
    // Save to history
    const history = new History({
      userId: req.session.user.id,
      action: 'check_registered',
      details: `Checked ${numbersArray.length} numbers`
    });
    await history.save();
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking registered numbers:', error);
    res.status(500).json({ error: 'Failed to check registered numbers' });
  }
});

app.post('/api/check/range', isAuthenticated, async (req, res) => {
  try {
    const { prefix, start, end, delay } = req.body;
    const numbers = [];
    
    for (let i = parseInt(start); i <= parseInt(end); i++) {
      numbers.push(`${prefix}${i}`);
    }
    
    // Simulate check process
    const results = numbers.map(num => ({
      number: num,
      registered: Math.random() > 0.3
    }));
    
    // Save to history
    const history = new History({
      userId: req.session.user.id,
      action: 'check_range',
      details: `Checked range ${start}-${end} with prefix ${prefix}`
    });
    await history.save();
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking range:', error);
    res.status(500).json({ error: 'Failed to check range' });
  }
});

app.post('/api/check/repe', isAuthenticated, upload.single('file'), async (req, res) => {
  try {
    const { numbers, delay } = req.body;
    const numbersArray = numbers ? numbers.split(',').map(n => n.trim()) : [];
    
    // Simulate check process
    const results = numbersArray.map(num => ({
      number: num,
      isRepe: Math.random() > 0.7,
      registered: Math.random() > 0.3
    }));
    
    // Save to history
    const history = new History({
      userId: req.session.user.id,
      action: 'check_repe',
      details: `Checked ${numbersArray.length} numbers for repe`
    });
    await history.save();
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking repe:', error);
    res.status(500).json({ error: 'Failed to check repe' });
  }
});

// Email routes
app.post('/api/email/send', isAuthenticated, async (req, res) => {
  try {
    const { to, subject, body, template } = req.body;
    
    // Simulate sending email
    logger.info(`Email sent to ${to}: ${subject}`);
    
    // Save to history
    const history = new History({
      userId: req.session.user.id,
      action: 'send_email',
      details: `Email sent to ${to}`
    });
    await history.save();
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Export routes
app.get('/api/export/users', isAuthenticated, async (req, res) => {
  try {
    const users = await User.find({});
    const filename = `users_${Date.now()}.json`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.json(users);
  } catch (error) {
    logger.error('Error exporting users:', error);
    res.status(500).json({ error: 'Failed to export users' });
  }
});

app.get('/api/export/sessions', isAuthenticated, async (req, res) => {
  try {
    const sessions = await Session.find({});
    const filename = `sessions_${Date.now()}.json`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.json(sessions);
  } catch (error) {
    logger.error('Error exporting sessions:', error);
    res.status(500).json({ error: 'Failed to export sessions' });
  }
});

// Settings routes
app.get('/api/settings', isAuthenticated, async (req, res) => {
  try {
    const settings = await Setting.find({});
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error getting settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.post('/api/settings', isAuthenticated, async (req, res) => {
  try {
    const { key, value } = req.body;
    const setting = await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
    res.json({ success: true, setting });
  } catch (error) {
    logger.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Monitoring routes
app.get('/api/monitor/sessions', isAuthenticated, async (req, res) => {
  try {
    const sessions = await Session.find({});
    res.json({ success: true, sessions });
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
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  
  // Initialize default settings
  Setting.findOneAndUpdate(
    { key: 'system_status' },
    { value: 'active' },
    { upsert: true }
  ).then(() => {
    logger.info('System status initialized');
  }).catch(err => {
    logger.error('Error initializing system status:', err);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT. Graceful shutdown...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM. Graceful shutdown...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});