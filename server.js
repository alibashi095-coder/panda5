require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
// زيادة حجم الطلبات المسموح بها لاستيعاب الصور المرفوعة (Base64)
app.use(express.json({ limit: '50mb' }));

// إعداد مجلد رفع الصور ومكتبة multer
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// إعداد اتصال MySQL
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'panda_db',
    port: process.env.DB_PORT || 3306
};

const JWT_SECRET = process.env.JWT_SECRET || 'panda-secure-key-2026';

let dbPool;

async function initDB() {
    let connected = false;
    while (!connected) {
        try {
            // الاتصال المبدئي لإنشاء قاعدة البيانات إذا لم تكن موجودة
                const initialConnection = await mysql.createConnection({
                    host: dbConfig.host,
                    user: dbConfig.user,
                    password: dbConfig.password,
                    port: dbConfig.port
                });
            await initialConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
            await initialConnection.end();

            // الاتصال بقاعدة البيانات الخاصة بالتطبيق
            dbPool = mysql.createPool(dbConfig);
            
            // --- بناء الجداول العلاقية (Relational Tables) ---
            await dbPool.query(`CREATE TABLE IF NOT EXISTS settings (id INT PRIMARY KEY DEFAULT 1, instituteName VARCHAR(255), phone VARCHAR(255), currency VARCHAR(50), logo LONGTEXT, maxStudentsPerCourse INT)`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS roles (email VARCHAR(255) PRIMARY KEY, name VARCHAR(255), password VARCHAR(255), role VARCHAR(255), roleCode VARCHAR(255), statusCode VARCHAR(50), date VARCHAR(100))`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS students (id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), email VARCHAR(255), course TEXT, class_id VARCHAR(255), date VARCHAR(100), total VARCHAR(100), paid VARCHAR(100), balance VARCHAR(100), status VARCHAR(100), statusCode VARCHAR(50), extra_data JSON)`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS recentStudents (id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), course VARCHAR(255), date VARCHAR(100), status VARCHAR(100), statusCode VARCHAR(50))`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS instructors (id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), spec VARCHAR(255), phone VARCHAR(255), img LONGTEXT)`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS courses (id VARCHAR(255) PRIMARY KEY, title VARCHAR(255), subject VARCHAR(255), instructor VARCHAR(255), duration VARCHAR(255), students VARCHAR(50), capacity VARCHAR(50), img LONGTEXT)`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS subjects (id VARCHAR(255) PRIMARY KEY, name VARCHAR(255), desc_text TEXT)`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS accounting (id VARCHAR(255) PRIMARY KEY, receipt VARCHAR(255), student VARCHAR(255), amount VARCHAR(255), date VARCHAR(100), method VARCHAR(100), notes TEXT, status VARCHAR(100), statusCode VARCHAR(50), type VARCHAR(50))`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS notifications (id VARCHAR(255) PRIMARY KEY, title VARCHAR(255), target VARCHAR(255), message TEXT, date VARCHAR(100))`);
            await dbPool.query(`CREATE TABLE IF NOT EXISTS attendance (id VARCHAR(255) PRIMARY KEY, class_id VARCHAR(255), date VARCHAR(100), records JSON)`);

            // إنشاء مدير افتراضي في حال كانت القاعدة فارغة
            const [adminRows] = await dbPool.query("SELECT * FROM roles WHERE roleCode = 'admin'");
            if (adminRows.length === 0) {
                const hashedAdminPw = await bcrypt.hash('admin', 10);
                await dbPool.query("INSERT INTO roles (email, name, password, role, roleCode, statusCode, date) VALUES ('admin@panda.com', 'مدير النظام', ?, 'مدير النظام', 'admin', 'active', '')", [hashedAdminPw]);
                await dbPool.query("INSERT INTO settings (id, instituteName, currency, maxStudentsPerCourse) VALUES (1, 'مركز الباندا', 'IQD', 30)");
            }

            console.log("Connected to MySQL successfully ✅ (الجداول العلاقية جاهزة)");
            connected = true;
        } catch (error) {
            console.error("Database connection failed ❌ سيتم إعادة المحاولة بعد 5 ثوانٍ...", error.message);
            // انتظار 5 ثوانٍ قبل محاولة الاتصال مجدداً
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

initDB();

// جعل الخادم يعرض ملفات الواجهة الأمامية (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // جعل مجلد الصور متاحاً للوصول عبر الرابط

// --- دوال المساعدة لربط البيانات (ORM Helper) ---
const schemaMap = {
    students: ['id', 'name', 'email', 'course', 'class_id', 'date', 'total', 'paid', 'balance', 'status', 'statusCode', 'extra_data'],
    roles: ['email', 'name', 'password', 'role', 'roleCode', 'statusCode', 'date'],
    instructors: ['id', 'name', 'spec', 'phone', 'img'],
    courses: ['id', 'title', 'subject', 'instructor', 'duration', 'students', 'capacity', 'img'],
    subjects: ['id', 'name', 'desc_text'],
    accounting: ['id', 'receipt', 'student', 'amount', 'date', 'method', 'notes', 'status', 'statusCode', 'type'],
    notifications: ['id', 'title', 'target', 'message', 'date'],
    attendance: ['id', 'class_id', 'date', 'records'],
    recentStudents: ['id', 'name', 'course', 'date', 'status', 'statusCode'],
    settings: ['id', 'instituteName', 'phone', 'currency', 'logo', 'maxStudentsPerCourse']
};

async function dbUpsert(table, item) {
    let cols = schemaMap[table];
    if (!cols) return;
    let row = { ...item };

    // ضمان وجود معرف ID لتجنب الأخطاء
    if (!row.id && table !== 'roles' && table !== 'settings') {
        row.id = `${table.charAt(0).toUpperCase()}-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    }
    
    // توافقية المسميات
    if (table === 'subjects' && item.desc) row.desc_text = item.desc;
    if (table === 'attendance' && typeof row.records !== 'string') row.records = JSON.stringify(row.records);
    
    // استخراج الحقول الديناميكية للطالب (مثل serial_courseId) ووضعها في extra_data
    if (table === 'students') {
        const known = new Set(cols);
        const extra = {};
        for (let k in row) { if (!known.has(k)) { extra[k] = row[k]; delete row[k]; } }
        row.extra_data = JSON.stringify(extra);
    }

    const keys = cols.filter(k => row[k] !== undefined);
    if (keys.length === 0) return;
    
    const values = keys.map(k => row[k]);
    const placeholders = keys.map(() => '?').join(', ');
    const updates = keys.map(k => `${k} = VALUES(${k})`).join(', ');
    
    const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
    await dbPool.query(query, values);
}

// --- مسارات النظام (API Routes) ---

// جدار الحماية (Middleware) لجميع المسارات ما عدا تسجيل الدخول
app.use('/api', (req, res, next) => {
    if (req.path === '/login') return next();
    
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access Denied - يرجى تسجيل الدخول" });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid Token - الجلسة منتهية" });
        req.user = user;
        next();
    });
});

// مسار رفع الصور الجديد
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, url: imageUrl });
});

// 1. تسجيل الدخول
app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        const [rows] = await dbPool.query('SELECT * FROM roles WHERE email = ? OR name = ? OR roleCode = ?', [identifier, identifier, identifier]);
        const user = rows[0];
        
        if (user) {
            let isMatch = false;
            if (user.password.startsWith('$2b$')) {
                isMatch = await bcrypt.compare(password, user.password); // مقارنة مشفرة
            } else {
                isMatch = (password === user.password); // مقارنة عادية (للحسابات القديمة)
                if (isMatch) {
                    // تشفير الكلمة القديمة وحفظها تلقائياً
                    const hashed = await bcrypt.hash(password, 10);
                    await dbPool.query('UPDATE roles SET password = ? WHERE email = ?', [hashed, user.email]);
                }
            }
            
            if (isMatch) {
                const safeUser = { ...user };
                delete safeUser.password;
                const token = jwt.sign({ email: user.email, roleCode: user.roleCode }, JWT_SECRET, { expiresIn: '7d' });
                return res.json({ success: true, user: safeUser, token });
            }
        }
        res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
    } catch (error) {
        console.error("خطأ في الخادم أثناء تسجيل الدخول:", error);
        res.status(500).json({ error: "حدث خطأ داخلي في الخادم" });
    }
});

// 2. جلب كافة البيانات ككائن واحد (لتتوافق مع الواجهة الأمامية تماماً)
app.get('/api/data', async (req, res) => {
    try {
        const [settingsRows] = await dbPool.query('SELECT * FROM settings WHERE id = 1');
        const [roles] = await dbPool.query('SELECT * FROM roles');
        const [studentsRows] = await dbPool.query('SELECT * FROM students');
        const [recentStudents] = await dbPool.query('SELECT * FROM recentStudents');
        const [instructors] = await dbPool.query('SELECT * FROM instructors');
        const [courses] = await dbPool.query('SELECT * FROM courses');
        const [subjectsRows] = await dbPool.query('SELECT * FROM subjects');
        const [accounting] = await dbPool.query('SELECT * FROM accounting');
        const [notifications] = await dbPool.query('SELECT * FROM notifications');
        const [attendanceRows] = await dbPool.query('SELECT * FROM attendance');

        // تجميع الحقول الديناميكية للطالب
        const students = studentsRows.map(r => {
            const extra = (typeof r.extra_data === 'string') ? JSON.parse(r.extra_data) : (r.extra_data || {});
            delete r.extra_data;
            return { ...r, ...extra };
        });
        
        const subjects = subjectsRows.map(r => ({ id: r.id, name: r.name, desc: r.desc_text }));
        const attendance = attendanceRows.map(r => ({ ...r, records: typeof r.records === 'string' ? JSON.parse(r.records) : r.records }));

        res.json({
            settings: settingsRows[0] || { instituteName: 'مركز الباندا', phone: '', currency: 'IQD', logo: '', maxStudentsPerCourse: 30 },
            roles, students, recentStudents, instructors, courses, subjects, accounting, notifications, attendance
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

// 3. استيراد قاعدة بيانات (هجرة وتوزيع البيانات من ملف JSON إلى الجداول الجديدة)
app.post('/api/data/import', async (req, res) => {
    try {
        const db = req.body;
        if (!db || !db.students) return res.status(400).json({ error: 'ملف البيانات غير صالح' });

        // مسح الجداول الحالية لتهيئتها للاستيراد
        const tablesList = Object.keys(schemaMap);
        for (let t of tablesList) await dbPool.query(`TRUNCATE TABLE ${t}`);

        // زرع البيانات في الجداول العلاقية
        if (db.settings) await dbUpsert('settings', { id: 1, ...db.settings });
        for (let t of tablesList) {
            if (t === 'settings') continue;
            if (Array.isArray(db[t])) {
                for (let item of db[t]) await dbUpsert(t, item);
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. إضافة طالب (معالجة خاصة)
app.post('/api/students', async (req, res) => {
    try {
        const { student, recent } = req.body;
        if (!student.id) student.id = `Std-${Date.now()}`;
        await dbUpsert('students', student);
        if (recent) await dbUpsert('recentStudents', recent);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. معالجة سجلات الحضور
app.post('/api/attendance', async (req, res) => {
    try {
        await dbUpsert('attendance', req.body);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. معالجة تحديثات الإعدادات
app.post('/api/update/settings', async (req, res) => {
    try {
        await dbUpsert('settings', { id: 1, ...req.body });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. معالجة إضافة وتعديل الصلاحيات
app.post('/api/roles', async (req, res) => {
    try {
        const [existing] = await dbPool.query('SELECT email FROM roles WHERE email = ?', [req.body.email]);
        if (existing.length > 0) return res.status(409).json({ error: "هذا البريد الإلكتروني مستخدم مسبقاً" });
        
        if (req.body.password) {
            req.body.password = await bcrypt.hash(req.body.password, 10);
        }
        
        await dbUpsert('roles', req.body);
        const [roles] = await dbPool.query('SELECT * FROM roles');
        res.json({ success: true, roles });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 8. مسار ديناميكي (عام) لإنشاء البيانات (Instructors, Courses, etc..)
app.post('/api/update/:collection', async (req, res) => {
    try {
        const table = req.params.collection === 'recentStudents' ? 'recentStudents' : req.params.collection;
        if (Array.isArray(req.body)) {
            for (let item of req.body) await dbUpsert(table, item);
        } else {
            await dbUpsert(table, req.body);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9. مسار ديناميكي (عام) لتعديل عنصر محدد (PUT)
app.put('/api/:collection/:id', async (req, res) => {
    try {
        const col = req.params.collection;
        const updates = req.body.student ? req.body.student : req.body;
        
        updates.id = req.params.id;
        if (col === 'roles') {
            updates.email = req.params.id;
            if (updates.password && !updates.password.startsWith('$2b$')) {
                updates.password = await bcrypt.hash(updates.password, 10);
            }
        }
        
        await dbUpsert(col, updates);
        
        if (col === 'roles') {
            const [roles] = await dbPool.query('SELECT * FROM roles');
            return res.json({ success: true, roles });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 10. مسار ديناميكي (عام) لحذف عنصر (DELETE)
app.delete('/api/:collection/:id', async (req, res) => {
    try {
        const table = req.params.collection;
        const idField = table === 'roles' ? 'email' : 'id';
        await dbPool.query(`DELETE FROM ${table} WHERE ${idField} = ?`, [req.params.id]);
        
        if (table === 'roles') {
            const [roles] = await dbPool.query('SELECT * FROM roles');
            return res.json({ success: true, roles });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// توجيه أي طلب آخر (غير الـ API) إلى صفحة الموقع الرئيسية
app.use((req, res) => {
    if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(__dirname, 'index.html'));
    } else {
        res.status(404).json({ error: "المسار غير موجود" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Panda Backend Server is running on http://localhost:${PORT}`);
    console.log(`System is configured to use MySQL`);
});
