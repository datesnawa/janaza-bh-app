require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('نوع الملف غير مدعوم'));
  }
});

const validTokens = new Set();

// ── Explicit HTML routes ──────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/register.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/notify.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'notify.html'));
});
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/thankyou.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'thankyou.html'));
});

// ── API: Register ─────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { name, mobile, governorate_preference, mosque_id, mosque_name, consent } = req.body;
    if (!name || !mobile) return res.status(400).json({ message: 'الاسم والجوال مطلوبان' });
    if (!consent) return res.status(400).json({ message: 'يجب الموافقة على الشروط' });
    const cleanMobile = mobile.replace(/\s+/g, '').trim();
    const { data: existing } = await supabase.from('subscribers').select('id').eq('mobile', cleanMobile).single();
    if (existing) return res.status(409).json({ message: 'هذا الرقم مسجّل مسبقاً' });
    const { error } = await supabase.from('subscribers').insert({
      name: name.trim(), mobile: cleanMobile,
      governorate_preference: governorate_preference || 'capital',
      mosque_id: mosque_id || null, mosque_name: mosque_name || null,
      consent: true, active: true
    });
    if (error) { console.error('Register DB error:', error); return res.status(500).json({ message: 'خطأ في قاعدة البيانات' }); }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ── API: Notify ───────────────────────────────
app.post('/api/notify', upload.single('death_certificate'), async (req, res) => {
  try {
    const { deceased_name, gender, janaza_location, janaza_area, governorate, janaza_date, janaza_time, submitter_mobile } = req.body;
    if (!deceased_name || !janaza_location || !governorate || !janaza_date || !janaza_time || !submitter_mobile) {
      return res.status(400).json({ message: 'جميع الحقول المطلوبة يجب تعبئتها' });
    }
    let death_certificate_url = null;
    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `cert_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${fileExt}`;
      const { error: uploadError } = await supabase.storage.from('death-certificates').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (!uploadError) {
        const { data: urlData } = supabase.storage.from('death-certificates').getPublicUrl(fileName);
        death_certificate_url = urlData.publicUrl;
      }
    }
    const { error } = await supabase.from('notifications').insert({
      deceased_name: deceased_name.trim(), gender,
      janaza_location: janaza_location.trim(),
      janaza_area: janaza_area ? janaza_area.trim() : null,
      governorate, janaza_date, janaza_time,
      submitter_mobile: submitter_mobile.replace(/\s+/g, '').trim(),
      death_certificate_url, status: 'pending'
    });
    if (error) { console.error('Notify DB error:', error); return res.status(500).json({ message: 'خطأ في قاعدة البيانات' }); }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Notify error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ── API: Admin Login ──────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
});

function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: 'غير مصرح' });
  const token = authHeader.replace('Bearer ', '');
  if (!validTokens.has(token)) return res.status(401).json({ message: 'غير مصرح' });
  next();
}

// ── API: Admin Stats ──────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [pending, dispatched, subscribers, mosques] = await Promise.all([
      supabase.from('notifications').select('id', { count: 'exact' }).eq('status', 'pending'),
      supabase.from('notifications').select('id', { count: 'exact' }).eq('status', 'dispatched'),
      supabase.from('subscribers').select('id', { count: 'exact' }).eq('active', true),
      supabase.from('mosques').select('id', { count: 'exact' })
    ]);
    return res.json({ pending: pending.count || 0, dispatched: dispatched.count || 0, subscribers: subscribers.count || 0, mosques: mosques.count || 0 });
  } catch (err) { return res.status(500).json({ message: 'خطأ في الخادم' }); }
});

// ── API: Admin Notifications ──────────────────
app.get('/api/admin/notifications', adminAuth, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { data, error } = await supabase.from('notifications').select('*').eq('status', status).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    return res.json({ notifications: data || [] });
  } catch (err) { return res.status(500).json({ message: 'خطأ في الخادم' }); }
});

// ── API: Admin Subscribers ────────────────────
app.get('/api/admin/subscribers', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('subscribers').select('*').eq('active', true).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    return res.json({ subscribers: data || [] });
  } catch (err) { return res.status(500).json({ message: 'خطأ في الخادم' }); }
});

// ── API: Admin Mosques ────────────────────────
app.get('/api/admin/mosques', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('mosques').select('*').order('governorate', { ascending: true });
    if (error) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    return res.json({ mosques: data || [] });
  } catch (err) { return res.status(500).json({ message: 'خطأ في الخادم' }); }
});

// ── API: Admin Approve ────────────────────────
app.post('/api/admin/approve/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: notif, error: fetchError } = await supabase.from('notifications').select('*').eq('id', id).single();
    if (fetchError || !notif) return res.status(404).json({ message: 'الإشعار غير موجود' });
    if (notif.status === 'dispatched') return res.status(400).json({ message: 'تم إرسال هذا الإشعار مسبقاً' });

    let query = supabase.from('subscribers').select('mobile, name').eq('active', true);
    if (notif.governorate !== 'all') {
      query = query.or(`governorate_preference.eq.${notif.governorate},governorate_preference.eq.all`);
    }
    const { data: subscribers } = await query;

    const genderWord = notif.gender === 'male' ? 'المتوفى' : 'المتوفاة';
    const genderWordEn = notif.gender === 'male' ? 'Brother' : 'Sister';
    const loc = notif.janaza_location + (notif.janaza_area ? ' — ' + notif.janaza_area : '');
    const dateObj = new Date(notif.janaza_date + 'T00:00:00');
    const dateAr = dateObj.toLocaleDateString('ar-BH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const dateEn = dateObj.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const message = `🕌 إشعار صلاة الجنازة\n\nنُعلمكم بوفاة ${genderWord}: ${notif.deceased_name}\n📍 مكان الصلاة: ${loc}\n🗓 الموعد: ${dateAr}\n⏰ الوقت: ${notif.janaza_time}\n\n---\n🕌 Janaza Prayer Notification\n\n${genderWordEn} ${notif.deceased_name} has passed away.\nMay Allah have mercy on their soul.\n📍 Venue: ${loc}\n🗓 ${dateEn} at ${notif.janaza_time}\n\nللإلغاء / Unsubscribe: reply STOP`;

    let sentCount = 0;
    if (process.env.ULTRAMSG_TOKEN && process.env.ULTRAMSG_INSTANCE) {
      for (const sub of subscribers || []) {
        try {
          await axios.post(`https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`, { token: process.env.ULTRAMSG_TOKEN, to: sub.mobile, body: message });
          sentCount++;
          await new Promise(r => setTimeout(r, 200));
        } catch (msgErr) { console.error('Message error:', sub.mobile, msgErr.message); }
      }
    } else {
      console.log('SANDBOX — would send to:', (subscribers || []).map(s => s.mobile));
      sentCount = subscribers ? subscribers.length : 0;
    }

    await supabase.from('notifications').update({ status: 'dispatched', dispatched_at: new Date().toISOString() }).eq('id', id);
    return res.json({ success: true, sent: sentCount });
  } catch (err) {
    console.error('Approve error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Janaza BH running on port ${PORT}`);
  console.log(`✓ Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`✓ WhatsApp: ${process.env.ULTRAMSG_TOKEN ? 'UltraMsg ready' : 'SANDBOX'}`);
});
