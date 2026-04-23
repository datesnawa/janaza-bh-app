require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Multer — store uploads in memory for Supabase upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('نوع الملف غير مدعوم'));
  }
});

// Simple token store (in-memory, fine for prototype)
const validTokens = new Set();

// ─────────────────────────────────────────────
// ROUTE: Home → redirect to register
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/register.html');
});

// ─────────────────────────────────────────────
// ROUTE: Subscriber Registration
// POST /api/register
// ─────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { name, mobile, governorate_preference, mosque_id, mosque_name, consent } = req.body;

    // Validate required fields
    if (!name || !mobile) {
      return res.status(400).json({ message: 'الاسم والجوال مطلوبان' });
    }

    if (!consent) {
      return res.status(400).json({ message: 'يجب الموافقة على الشروط' });
    }

    // Clean mobile number
    const cleanMobile = mobile.replace(/\s+/g, '').trim();

    // Check if already registered
    const { data: existing } = await supabase
      .from('subscribers')
      .select('id')
      .eq('mobile', cleanMobile)
      .single();

    if (existing) {
      return res.status(409).json({ message: 'هذا الرقم مسجّل مسبقاً' });
    }

    // Insert subscriber
    const { error } = await supabase
      .from('subscribers')
      .insert({
        name: name.trim(),
        mobile: cleanMobile,
        governorate_preference: governorate_preference || 'capital',
        mosque_id: mosque_id || null,
        mosque_name: mosque_name || null,
        consent: true,
        active: true
      });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    }

    return res.status(200).json({ success: true, message: 'تم التسجيل بنجاح' });

  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Janaza Notification Submission
// POST /api/notify
// ─────────────────────────────────────────────
app.post('/api/notify', upload.single('death_certificate'), async (req, res) => {
  try {
    const {
      deceased_name,
      gender,
      janaza_location,
      janaza_area,
      governorate,
      janaza_date,
      janaza_time,
      submitter_mobile
    } = req.body;

    // Validate required fields
    if (!deceased_name || !janaza_location || !governorate || !janaza_date || !janaza_time || !submitter_mobile) {
      return res.status(400).json({ message: 'جميع الحقول المطلوبة يجب تعبئتها' });
    }

    let death_certificate_url = null;

    // Upload death certificate to Supabase Storage if provided
    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop();
      const fileName = `cert_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${fileExt}`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('death-certificates')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        // Continue without certificate — don't block submission
      } else {
        const { data: urlData } = supabase.storage
          .from('death-certificates')
          .getPublicUrl(fileName);
        death_certificate_url = urlData.publicUrl;
      }
    }

    // Insert notification into pending queue
    const { data: notif, error } = await supabase
      .from('notifications')
      .insert({
        deceased_name: deceased_name.trim(),
        gender,
        janaza_location: janaza_location.trim(),
        janaza_area: janaza_area ? janaza_area.trim() : null,
        governorate,
        janaza_date,
        janaza_time,
        submitter_mobile: submitter_mobile.replace(/\s+/g, '').trim(),
        death_certificate_url,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error('Notification insert error:', error);
      return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    }

    return res.status(200).json({ success: true, message: 'تم استلام الإشعار وهو بانتظار المراجعة' });

  } catch (err) {
    console.error('Notify error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Admin Login
// POST /api/admin/login
// ─────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
});

// ─────────────────────────────────────────────
// MIDDLEWARE: Admin auth check
// ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: 'غير مصرح' });
  const token = authHeader.replace('Bearer ', '');
  if (!validTokens.has(token)) return res.status(401).json({ message: 'غير مصرح' });
  next();
}

// ─────────────────────────────────────────────
// ROUTE: Admin Stats
// GET /api/admin/stats
// ─────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [pending, dispatched, subscribers, mosques] = await Promise.all([
      supabase.from('notifications').select('id', { count: 'exact' }).eq('status', 'pending'),
      supabase.from('notifications').select('id', { count: 'exact' }).eq('status', 'dispatched'),
      supabase.from('subscribers').select('id', { count: 'exact' }).eq('active', true),
      supabase.from('mosques').select('id', { count: 'exact' })
    ]);

    return res.json({
      pending: pending.count || 0,
      dispatched: dispatched.count || 0,
      subscribers: subscribers.count || 0,
      mosques: mosques.count || 0
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Admin — Get Notifications
// GET /api/admin/notifications?status=pending
// ─────────────────────────────────────────────
app.get('/api/admin/notifications', adminAuth, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    return res.json({ notifications: data || [] });
  } catch (err) {
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Admin — Get Subscribers
// GET /api/admin/subscribers
// ─────────────────────────────────────────────
app.get('/api/admin/subscribers', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscribers')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    return res.json({ subscribers: data || [] });
  } catch (err) {
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Admin — Get Mosques
// GET /api/admin/mosques
// ─────────────────────────────────────────────
app.get('/api/admin/mosques', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('mosques')
      .select('*')
      .order('governorate', { ascending: true });

    if (error) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
    return res.json({ mosques: data || [] });
  } catch (err) {
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: Admin — Approve and Dispatch
// POST /api/admin/approve/:id
// ─────────────────────────────────────────────
app.post('/api/admin/approve/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the notification
    const { data: notif, error: fetchError } = await supabase
      .from('notifications')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !notif) {
      return res.status(404).json({ message: 'الإشعار غير موجود' });
    }

    if (notif.status === 'dispatched') {
      return res.status(400).json({ message: 'تم إرسال هذا الإشعار مسبقاً' });
    }

    // Get matching subscribers
    let query = supabase
      .from('subscribers')
      .select('mobile, name')
      .eq('active', true);

    if (notif.governorate !== 'all') {
      query = query.or(`governorate_preference.eq.${notif.governorate},governorate_preference.eq.all`);
    }

    const { data: subscribers, error: subError } = await query;

    if (subError) {
      console.error('Subscriber fetch error:', subError);
      return res.status(500).json({ message: 'خطأ في جلب المشتركين' });
    }

    // Build the message
    const genderWord = notif.gender === 'male' ? 'المتوفى' : 'المتوفاة';
    const genderWordEn = notif.gender === 'male' ? 'Brother' : 'Sister';
    const loc = notif.janaza_location + (notif.janaza_area ? ' — ' + notif.janaza_area : '');

   const dateObj = new Date(notif.janaza_date + 'T00:00:00');
    const dateAr = dateObj.toLocaleDateString('ar-BH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const dateEn = dateObj.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const message = `🕌 إشعار صلاة الجنازة

نُعلمكم بوفاة ${genderWord}: ${notif.deceased_name}
📍 مكان الصلاة: ${loc}
🗓 الموعد: ${dateAr}
⏰ الوقت: ${notif.janaza_time}

---
🕌 Janaza Prayer Notification

${genderWordEn} ${notif.deceased_name} has passed away.
May Allah have mercy on their soul.
📍 Venue: ${loc}
🗓 ${dateEn} at ${notif.janaza_time}

للإلغاء / Unsubscribe: reply STOP`;

    // Send WhatsApp messages via UltraMsg (sandbox)
    let sentCount = 0;

    if (process.env.ULTRAMSG_TOKEN && process.env.ULTRAMSG_INSTANCE) {
      for (const sub of subscribers || []) {
        try {
          await axios.post(
            `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
            {
              token: process.env.ULTRAMSG_TOKEN,
              to: sub.mobile,
              body: message
            }
          );
          sentCount++;
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 200));
        } catch (msgErr) {
          console.error('Message send error for', sub.mobile, msgErr.message);
        }
      }
    } else {
      // Sandbox mode — log messages, count as sent
      console.log('─── SANDBOX MODE — Messages would be sent to:');
      (subscribers || []).forEach(s => {
        console.log(`  → ${s.name}: ${s.mobile}`);
      });
      console.log('─── Message content:\n', message);
      sentCount = subscribers ? subscribers.length : 0;
    }

    // Mark notification as dispatched
    const { error: updateError } = await supabase
      .from('notifications')
      .update({
        status: 'dispatched',
        dispatched_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateError) {
      console.error('Update error:', updateError);
    }

    return res.json({
      success: true,
      sent: sentCount,
      message: `تم الإرسال إلى ${sentCount} مشترك`
    });

  } catch (err) {
    console.error('Approve error:', err);
    return res.status(500).json({ message: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Janaza BH server running on port ${PORT}`);
  console.log(`✓ Supabase connected: ${process.env.SUPABASE_URL}`);
  console.log(`✓ WhatsApp: ${process.env.ULTRAMSG_TOKEN ? 'UltraMsg configured' : 'SANDBOX MODE'}`);
});
