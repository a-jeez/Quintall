require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Telegraf } = require('telegraf');
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getTasks, saveTasks } = require('./tasks');
const multer = require('multer');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/json') {
            return cb(new Error('Hanya file JSON yang diizinkan'), false);
        }
        cb(null, true);
    }
});
const kalender = require('./kalender.json');

const JADWAL_FILE = path.join(__dirname, 'jadwal.json');
function getJadwal() {
    try {
        if (fs.existsSync(JADWAL_FILE)) {
            return JSON.parse(fs.readFileSync(JADWAL_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}
function saveJadwal(data) {
    fs.writeFileSync(JADWAL_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Security: Disable X-Powered-By header
app.disable('x-powered-by');

// Security: Helmet middleware with CSP for Google Fonts
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: []
        }
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' }
}));

// Security: Rate limiter for login endpoint
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
    standardHeaders: true,
    legacyHeaders: false
});

// Security: Restrict HTTP methods
app.use((req, res, next) => {
    const allowedMethods = ['GET', 'POST', 'HEAD'];
    if (!allowedMethods.includes(req.method)) {
        return res.status(405).send('Method Not Allowed');
    }
    next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

let adminSessions = {};
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
let lastAdminActivity = 'Belum ada sesi';
let recentMessages = [];
let isMaintenance = false;
const botRateLimit = new Map();
const RATE_LIMIT_MS = 5000;
const RATE_LIMIT_COUNT = 3;

function isValidSession(token) {
    if (!token || !adminSessions[token]) return false;
    if (Date.now() - adminSessions[token] > SESSION_TTL_MS) {
        delete adminSessions[token];
        return false;
    }
    return true;
}

function checkRateLimit(chatId) {
    const now = Date.now();
    let record = botRateLimit.get(chatId) || { count: 0, reset: now };
    if (now > record.reset) {
        record = { count: 0, reset: now + RATE_LIMIT_MS };
    }
    record.count++;
    botRateLimit.set(chatId, record);
    return record.count <= RATE_LIMIT_COUNT;
}

function formatUptime(seconds) {
    const totalMins = Math.floor(seconds / 60);
    const totalHours = Math.floor(totalMins / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const mins = totalMins % 60;
    
    if (days > 0) {
        return `${days}d ${hours}h ${mins}m`;
    }
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function updateActivity() {
    const d = new Date();
    const dateStr = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    lastAdminActivity = `${dateStr}, ${timeStr}`;
}

function checkAuth(req, res, next) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/quintall_auth=([^;]+)/);
    const token = match ? match[1] : null;
    if (isValidSession(token)) {
        return next();
    }
    res.redirect('/login');
}

// --- Express Routes ---

app.get('/', (req, res) => {
    const todayName = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][new Date().getDay()];
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/quintall_auth=([^;]+)/);
    const token = match ? match[1] : null;
    const isLoggedIn = isValidSession(token);

    const range = req.query.range || '1d';
    const tasks = getTasks();
    const jadwal = getJadwal();
    const now = new Date();
    now.setHours(0,0,0,0);

    const filteredTasks = tasks.filter(t => {
        if (t.selesai) return false;
        const d = new Date(t.deadline);
        const diffHours = (d - now) / (1000 * 60 * 60);
        if (range === '1d') return diffHours <= 24;
        if (range === '3d') return diffHours <= 72;
        if (range === '7d') return diffHours <= 168;
        return true;
    });

    res.render('index', {
        isLoggedIn,
        uptime: formatUptime(process.uptime()),
        lastAdminActivity,
        ram: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
        jadwal,
        todayName,
        range,
        filteredTasks,
        kalender,
        isMaintenance
    });
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', loginLimiter, (req, res) => {
    const { password } = req.body;
    
    // Input validation
    if (!password || typeof password !== 'string' || password.length > 100) {
        return res.send(`<script>alert('Input tidak valid!'); window.location.href='/login';</script>`);
    }
    
    if (password === process.env.ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        adminSessions[token] = Date.now();
        updateActivity();
        
        // Enhanced cookie security: HttpOnly, Secure (for HTTPS), SameSite=Strict
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        const cookieOptions = [
            `quintall_auth=${token}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            isSecure ? 'Secure' : '',
            `Max-Age=${SESSION_TTL_MS / 1000}` // Match session TTL
        ].filter(Boolean).join('; ');
        
        res.setHeader('Set-Cookie', cookieOptions);
        return res.redirect('/tugas');
    }
    
    res.send(`<script>alert('Password salah!'); window.location.href='/login';</script>`);
});

app.get('/logout', (req, res) => {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/quintall_auth=([^;]+)/);
    if (match && match[1]) {
        delete adminSessions[match[1]];
    }
    res.setHeader('Set-Cookie', `quintall_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    res.redirect('/');
});

app.get('/tugas', checkAuth, (req, res) => {
    const tasks = getTasks();
    const jadwal = getJadwal();
    const now = new Date();
    now.setHours(0,0,0,0);
    const matkulList = [...new Set(jadwal.map(j => j.matkul))];

    res.render('tugas', {
        tasks,
        now,
        matkulList,
        isMaintenance
    });
});

app.post('/toggle-maintenance', checkAuth, (req, res) => {
    isMaintenance = !isMaintenance;
    updateActivity();
    res.redirect(`/tugas?msg=${isMaintenance ? 'maint_on' : 'maint_off'}`);
});

app.post('/tambah-tugas', checkAuth, (req, res) => {
    const { matkul, deskripsi, deadlineDate, deadlineTime } = req.body;
    if (matkul && deskripsi && deadlineDate && deadlineTime) {
        const tasks = getTasks();
        const deadline = `${deadlineDate} ${deadlineTime}`;
        tasks.push({ matkul, deskripsi, deadline });
        saveTasks(tasks);
        updateActivity();
        return res.redirect('/tugas?msg=tambah_sukses');
    }
    res.redirect('/tugas');
});

app.post('/import-jadwal', checkAuth, upload.single('jadwal'), (req, res) => {
    if (!req.file) return res.redirect('/tugas?msg=import_gagal');
    if (req.file.mimetype !== 'application/json') return res.redirect('/tugas?msg=import_gagal');
    try {
        const fileData = req.file.buffer.toString('utf8');
        const newJadwal = JSON.parse(fileData);
        if (Array.isArray(newJadwal)) {
            saveJadwal(newJadwal);
            updateActivity();
            return res.redirect('/tugas?msg=import_sukses');
        }
    } catch (e) {}
    res.redirect('/tugas?msg=import_gagal');
});

app.post('/hapus-tugas', checkAuth, (req, res) => {
    const id = parseInt(req.body.id);
    if (!isNaN(id)) {
        const tasks = getTasks();
        tasks.splice(id, 1);
        saveTasks(tasks);
        updateActivity();
        return res.redirect('/tugas?msg=hapus_sukses');
    }
    res.redirect('/tugas');
});

app.post('/selesai-tugas', checkAuth, (req, res) => {
    const id = parseInt(req.body.id);
    const status = parseInt(req.body.status);
    if (!isNaN(id)) {
        const tasks = getTasks();
        if (tasks[id]) {
            tasks[id].selesai = status === 1;
            saveTasks(tasks);
            updateActivity();
            return res.redirect('/tugas?msg=status_sukses');
        }
    }
    res.redirect('/tugas');
});

// --- Telegram Bot Commands ---

bot.use((ctx, next) => {
    if (isMaintenance) {
        return ctx.reply('⚠️ *Quintall Bot sedang dalam Mode Maintenance/Pemeliharaan.*\nSilakan coba beberapa saat lagi.', { parse_mode: 'Markdown' });
    }
    return next();
});

bot.command('kalender', ctx => {
    let m = `🗓️ *Kalender Akademik Polsri*\n\n`;
    kalender.forEach((k, i) => m += `${i+1}. *${k.kegiatan}*\n   📅 ${k.tanggal}\n\n`);
    ctx.reply(m, { parse_mode: 'Markdown' });
});

bot.command('info', ctx => ctx.reply('🤖 *Quintall* • Creator: *Muhammad Abdul Aziz*', { parse_mode: 'Markdown' }));

bot.command('jadwal', ctx => {
    const day = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][new Date().getDay()];
    const jadwal = getJadwal();
    const list = jadwal.filter(j => j.hari.toLowerCase() === day.toLowerCase());
    if (!list.length) return ctx.reply(`📅 Hari ini (${day}) libur.`);
    let m = `📅 *Jadwal ${day}*\n\n`;
    list.forEach((i, idx) => m += `${idx+1}. *${i.matkul}* (${i.jam}) di ${i.ruang}\n`);
    ctx.reply(m, { parse_mode: 'Markdown' });
});

bot.command('tugas', ctx => {
    const tasks = getTasks();
    if (!tasks.length) return ctx.reply('📝 Belum ada tugas kuliah yang dicatat.');
    let m = `📝 *Daftar Tugas Kuliah*\n\n`;
    const now = new Date();
    tasks.forEach((t, i) => {
        if (t.selesai) return;
        const d = new Date(t.deadline);
        const isPassed = d < now;
        const status = isPassed ? '⚠️ *[LEWAT WAKTU]*' : '🟢 *[AKTIF]*';
        m += `${i+1}. *${t.matkul}* ${status}\n   💬 ${t.deskripsi}\n   ⏰ Deadline: ${t.deadline}\n\n`;
    });
    ctx.reply(m, { parse_mode: 'Markdown' });
});

bot.on('text', ctx => {
    const chatId = ctx.message.chat.id;
    if (!checkRateLimit(chatId)) {
        return ctx.reply(`⚠️ Terlalu banyak pesan! Tunggu ${RATE_LIMIT_MS / 1000} detik lagi.`);
    }

    const text = ctx.message.text;
    const sender = ctx.from.first_name || 'User';
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    recentMessages.unshift({ sender, text, time });
    if (recentMessages.length > 5) recentMessages.pop();

    if (text.startsWith('/')) return;

    ctx.reply(`🤖 *Pesan tidak dikenal.*\n\nGunakan perintah yang tersedia:\n• /jadwal - Cek jadwal kuliah hari ini\n• /tugas - Cek daftar tugas aktif\n• /kalender - Cek kalender akademik\n• /info - Info bot & creator`, { parse_mode: 'Markdown' });
});

bot.launch().then(() => console.log('Quintall bot running!'));
app.listen(3000, () => {
    console.log('Dashboard running on port 3000');
});
