// ============================================================
// THE EMPTY BILLBOARD — BACKEND SERVER (Render-Ready)
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Only load Stripe if the key is valid
let stripe = null;
try {
    const Stripe = require('stripe');
    const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_live_YOUR_KEY_HERE';
    if (stripeKey && stripeKey !== 'sk_live_YOUR_KEY_HERE' && stripeKey.startsWith('sk_')) {
        stripe = Stripe(stripeKey);
        console.log('✅ Stripe initialized');
    } else {
        console.log('⚠️ Stripe not configured — replace STRIPE_SECRET_KEY in Environment or server.js');
    }
} catch (err) {
    console.log('⚠️ Stripe module error:', err.message);
}

const app = express();

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());

// ── CONFIGURATION ──
const CONFIG = {
    PORT: process.env.PORT || 3000,
    DOMAIN: process.env.DOMAIN || 'https://www.emptybillboard.online',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_kAZMO3vYrmnquiWna4z9yBYYs89Gg53a',
    DATA_FILE: path.join(__dirname, 'data.json'),
    BASE_RATE: 1.00,
    MIN_MINUTES: 60,
    MAX_MINUTES: 1440,
    DOUBLING_FACTOR: 2,
    MAX_MESSAGE_LENGTH: 280,
    WEEKLY_RESET_DAY: 0,
    WEEKLY_RESET_HOUR: 0,
    EXPIRY_CHECK_INTERVAL: 10000
};

console.log('📋 Configuration loaded');
console.log('   Domain:', CONFIG.DOMAIN);
console.log('   Port:', CONFIG.PORT);
console.log('   Base rate: $' + CONFIG.BASE_RATE + '/min');
console.log('   Min minutes:', CONFIG.MIN_MINUTES);

// ============================================================
// DATA LAYER
// ============================================================

function createFreshData() {
    return {
        purchase_count: 0,
        current_rate_per_minute: CONFIG.BASE_RATE,
        last_reset_date: '',
        active_slot: null,
        queue: [],
        archive: [],
        _pending_sessions: [],
        _next_active: null
    };
}

function readData() {
    try {
        if (!fs.existsSync(CONFIG.DATA_FILE)) {
            const fresh = createFreshData();
            fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(fresh, null, 2));
            return fresh;
        }
        const raw = fs.readFileSync(CONFIG.DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        return { ...createFreshData(), ...data };
    } catch (err) {
        console.error('❌ Error reading data.json:', err.message);
        return createFreshData();
    }
}

function writeData(data) {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('❌ Error writing data.json:', err.message);
    }
}

// ============================================================
// CORE LOGIC
// ============================================================

function checkWeeklyReset(data) {
    const now = new Date();
    if (now.getUTCDay() === CONFIG.WEEKLY_RESET_DAY &&
        now.getUTCHours() < CONFIG.WEEKLY_RESET_HOUR + 1) {
        const todayStr = now.toISOString().split('T')[0];
        if (data.last_reset_date !== todayStr) {
            console.log('🔄 Weekly reset triggered');
            data.purchase_count = 0;
            data.current_rate_per_minute = CONFIG.BASE_RATE;
            data.last_reset_date = todayStr;
            writeData(data);
            return true;
        }
    }
    return false;
}

function getCurrentRate() {
    const data = readData();
    checkWeeklyReset(data);
    return data.current_rate_per_minute;
}

function processExpiry() {
    const data = readData();
    const now = new Date();
    let changed = false;

    if (data.active_slot && data.active_slot.status === 'active') {
        const expiresAt = new Date(data.active_slot.expires_at);
        if (now >= expiresAt) {
            console.log('⏰ Slot expired:', data.active_slot.message);

            data.archive.push({
                ...data.active_slot,
                status: 'completed',
                completed_at: now.toISOString()
            });

            if (data.queue.length > 0) {
                const nextSlot = data.queue.shift();
                nextSlot.started_at = now.toISOString();
                nextSlot.expires_at = new Date(
                    now.getTime() + nextSlot.minutes_purchased * 60000
                ).toISOString();
                nextSlot.status = 'active';
                data.active_slot = nextSlot;
                console.log('▶️ Dequeued next slot');
            } else {
                data.active_slot = null;
                console.log('📭 Billboard empty');
            }
            changed = true;
        }
    }

    if (!data.active_slot && data.queue.length > 0) {
        const nextSlot = data.queue.shift();
        nextSlot.started_at = now.toISOString();
        nextSlot.expires_at = new Date(
            now.getTime() + nextSlot.minutes_purchased * 60000
        ).toISOString();
        nextSlot.status = 'active';
        data.active_slot = nextSlot;
        changed = true;
        console.log('▶️ Activated queued slot');
    }

    if (data.active_slot && data.active_slot.status === 'active') {
        if (!data.active_slot.started_at) {
            data.active_slot.started_at = now.toISOString();
            changed = true;
        }
        if (!data.active_slot.expires_at) {
            data.active_slot.expires_at = new Date(
                now.getTime() + data.active_slot.minutes_purchased * 60000
            ).toISOString();
            changed = true;
        }
    }

    if (changed) writeData(data);
    return data;
}

setInterval(processExpiry, CONFIG.EXPIRY_CHECK_INTERVAL);

// ============================================================
// API ROUTES
// ============================================================

// ── GET /api/state ──
app.get('/api/state', (req, res) => {
    try {
        const data = processExpiry();
        const now = new Date();

        let activeInfo = null;

        if (data.active_slot && data.active_slot.status === 'active') {
            const expiresAt = new Date(data.active_slot.expires_at);
            const remainingMs = Math.max(0, expiresAt.getTime() - now.getTime());
            const minutesRemaining = Math.floor(remainingMs / 60000);

            activeInfo = {
                message: data.active_slot.message,
                buyer_name: data.active_slot.buyer_name || 'Anonymous',
                total_minutes: data.active_slot.minutes_purchased,
                total_paid: data.active_slot.total_paid,
                minutes_remaining: minutesRemaining,
                seconds_remaining: Math.floor(remainingMs / 1000),
                expires_at: data.active_slot.expires_at,
                rate_per_minute: data.active_slot.total_paid / data.active_slot.minutes_purchased
            };
        }

        const rate = getCurrentRate();

        res.json({
            active: activeInfo,
            queue_length: data.queue.length,
            queue_slots: data.queue.map(q => ({
                buyer_name: q.buyer_name || 'Anonymous',
                minutes: q.minutes_purchased,
                total_paid: q.total_paid
            })),
            next_rate_per_minute: rate,
            next_rate_display: '$' + rate.toFixed(2) + '/min',
            purchase_count: data.purchase_count,
            archive: (data.archive || []).slice(-50).reverse().map(a => ({
                message: a.message,
                buyer_name: a.buyer_name,
                total_minutes: a.minutes_purchased,
                total_paid: a.total_paid,
                started_at: a.started_at,
                completed_at: a.completed_at
            }))
        });
    } catch (err) {
        console.error('❌ /api/state error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── POST /api/create-checkout-session ──
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ error: 'Stripe not configured. Contact the site owner.' });
        }

        const { desired_minutes } = req.body;
        const minutes = parseInt(desired_minutes);

        if (!minutes || minutes < CONFIG.MIN_MINUTES) {
            return res.status(400).json({ error: 'Minimum ' + CONFIG.MIN_MINUTES + ' minutes.' });
        }
        if (minutes > CONFIG.MAX_MINUTES) {
            return res.status(400).json({ error: 'Maximum ' + CONFIG.MAX_MINUTES + ' minutes.' });
        }

        const rate = getCurrentRate();
        const total = parseFloat((rate * minutes).toFixed(2));

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: minutes + ' Minutes — The Empty Billboard',
                        description: minutes + ' min at $' + rate.toFixed(2) + '/min · Total: $' + total.toFixed(2),
                    },
                    unit_amount: Math.round(total * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: CONFIG.DOMAIN + '/success?session_id={CHECKOUT_SESSION_ID}&minutes=' + minutes,
            cancel_url: CONFIG.DOMAIN,
            metadata: {
                minutes_purchased: minutes.toString(),
                rate_per_minute: rate.toString(),
                total_paid: total.toString()
            }
        });

        const data = readData();
        data._pending_sessions.push({
            session_id: session.id,
            minutes_purchased: minutes,
            rate_per_minute: rate,
            total_paid: total,
            created_at: new Date().toISOString()
        });
        writeData(data);

        console.log('💳 Session created:', session.id, '- $' + total);

        res.json({ id: session.id, total: total, minutes: minutes, rate: rate });

    } catch (err) {
        console.error('❌ Checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout session.' });
    }
});

// ── POST /api/submit-message ──
app.post('/api/submit-message', async (req, res) => {
    try {
        const { session_id, message, buyer_name, media_url, media_type } = req.body;

        if (!session_id) return res.status(400).json({ error: 'Missing session ID.' });
        
        // Must have either message or media
        if ((!message || message.trim().length === 0) && !media_url) {
            return res.status(400).json({ error: 'Message or media required.' });
        }
        if (message && message.length > CONFIG.MAX_MESSAGE_LENGTH) {
            return res.status(400).json({ error: 'Max ' + CONFIG.MAX_MESSAGE_LENGTH + ' characters.' });
        }
        
        // Validate media type
        if (media_type && !['image', 'video'].includes(media_type)) {
            return res.status(400).json({ error: 'Invalid media type. Use "image" or "video".' });
        }
        
        // Basic URL validation for media
        if (media_url && !media_url.match(/^https?:\/\/.+/)) {
            return res.status(400).json({ error: 'Media URL must start with http:// or https://' });
        }

        const data = readData();
        let slot = null;
        let source = null;

        if (data._next_active && data._next_active.session_id === session_id) {
            slot = data._next_active;
            source = 'next_active';
        }

        if (!slot) {
            const queueIndex = data.queue.findIndex(s => s.session_id === session_id);
            if (queueIndex !== -1) {
                slot = data.queue[queueIndex];
                source = 'queue';
            }
        }

        if (!slot) {
            return res.status(404).json({ error: 'Session not found. Has payment completed?' });
        }

        slot.message = message ? message.trim() : '';
        slot.buyer_name = buyer_name?.trim() || 'Anonymous';
        slot.media_url = media_url || null;
        slot.media_type = media_type || null;

        if (source === 'next_active') {
            const now = new Date();
            slot.started_at = now.toISOString();
            slot.expires_at = new Date(now.getTime() + slot.minutes_purchased * 60000).toISOString();
            slot.status = 'active';
            data.active_slot = slot;
            delete data._next_active;
        }

        writeData(data);
        console.log('📝 Message submitted:', message || '[media]', media_type || '');

        res.json({
            success: true,
            status: slot.status,
            starts_at: slot.started_at || null,
            expires_at: slot.expires_at || null
        });

    } catch (err) {
        console.error('❌ Submit error:', err);
        res.status(500).json({ error: 'Failed to submit message.' });
    }
});

// ── POST /api/stripe-webhook ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured.' });
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, CONFIG.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('❌ Webhook signature failed:', err.message);
        return res.status(400).json({ error: 'Webhook Error: ' + err.message });
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const data = readData();

        const pendingIndex = data._pending_sessions.findIndex(ps => ps.session_id === session.id);

        if (pendingIndex === -1) {
            console.log('⚠️ Unknown session:', session.id);
            return res.json({ received: true });
        }

        const pending = data._pending_sessions[pendingIndex];

        const newSlot = {
            session_id: session.id,
            message: '',
            buyer_name: '',
            minutes_purchased: parseInt(pending.minutes_purchased),
            total_paid: parseFloat(pending.total_paid),
            rate_per_minute: parseFloat(pending.rate_per_minute),
            status: 'awaiting_message',
            created_at: new Date().toISOString()
        };

        if (!data.active_slot || data.active_slot.status !== 'active') {
            data._next_active = newSlot;
        } else {
            newSlot.status = 'queued';
            data.queue.push(newSlot);
        }

        data.purchase_count += 1;
        data.current_rate_per_minute = parseFloat(
            (CONFIG.BASE_RATE * Math.pow(CONFIG.DOUBLING_FACTOR, data.purchase_count)).toFixed(2)
        );

        data._pending_sessions.splice(pendingIndex, 1);
        writeData(data);

        console.log('✅ Payment confirmed:', session.id);
        console.log('   New rate: $' + data.current_rate_per_minute.toFixed(2) + '/min');
    }

    res.json({ received: true });
});

// ── GET /success ──
app.get('/success', (req, res) => {
    const sessionId = req.query.session_id || '';
    const minutes = req.query.minutes || '?';

    res.send('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Submit Your Message — The Empty Billboard</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Courier New",Courier,monospace;background:#fff;color:#111;max-width:600px;margin:60px auto;padding:20px}h1{font-size:1.5rem;margin-bottom:8px;text-transform:uppercase;letter-spacing:2px}.subtitle{color:#888;margin-bottom:30px;font-size:.9rem}textarea{width:100%;height:120px;font-family:inherit;font-size:1.3rem;padding:16px;border:4px solid #111;resize:vertical;font-weight:600}textarea:focus{outline:none;border-color:#ffd700}.char-count{text-align:right;font-size:.8rem;color:#888;margin-top:4px}input[type="text"]{width:100%;padding:14px;font-family:inherit;font-size:1rem;border:3px solid #111;margin:14px 0}button{background:#ffd700;color:#111;border:3px solid #111;padding:16px 36px;font-weight:700;cursor:pointer;font-family:inherit;font-size:1.1rem;text-transform:uppercase;letter-spacing:2px;width:100%}button:hover{background:#111;color:#ffd700}button:disabled{opacity:.4;cursor:not-allowed}.rules{background:#f9f9f9;padding:14px;margin:20px 0;font-size:.8rem;color:#666;line-height:1.5}#status{margin-top:16px;font-weight:700;text-align:center;min-height:24px}#status.success{color:#00aa44}#status.error{color:#cc0000}</style></head><body><h1>✅ Payment Complete!</h1><p class="subtitle">You bought <strong>' + minutes + ' minutes</strong>. What message?</p><textarea id="message" maxlength="280" placeholder="Your message here..."></textarea><div class="char-count"><span id="charCount">0</span>/280</div><input type="text" id="buyerName" placeholder="Your name (or leave blank for Anonymous)"><button id="submitBtn" onclick="submitMessage()">Publish to Billboard</button><div class="rules"><strong>Rules:</strong> No hate speech, harassment, illegal content, or spam.<br>Messages reviewed before appearing.</div><div id="status"></div><script>const SESSION_ID="' + sessionId + '";document.getElementById("message").addEventListener("input",function(){document.getElementById("charCount").textContent=this.value.length});async function submitMessage(){const m=document.getElementById("message").value.trim();const n=document.getElementById("buyerName").value.trim();const b=document.getElementById("submitBtn");const s=document.getElementById("status");if(!m){s.textContent="Enter a message.";s.className="error";return}if(m.length>280){s.textContent="Too long.";s.className="error";return}b.disabled=true;b.textContent="Submitting...";try{const r=await fetch("/api/submit-message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session_id:SESSION_ID,message:m,buyer_name:n})});const d=await r.json();if(d.success){s.textContent=d.status==="active"?"✅ Your message is LIVE!":"✅ Queued! It will appear soon.";s.className="success";setTimeout(function(){window.location.href="/"},4000)}else{s.textContent="❌ "+(d.error||"Error");s.className="error";b.disabled=false;b.textContent="Publish to Billboard"}}catch(e){s.textContent="❌ Network error.";s.className="error";b.disabled=false;b.textContent="Publish to Billboard"}}</script></body></html>');
});

// ── Serve static files ──
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 404 handler ──
app.use((req, res) => {
    res.status(404).send('Not found');
});

// ── Start server ──
app.listen(CONFIG.PORT, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   📋 THE EMPTY BILLBOARD SERVER     ║');
    console.log('╠══════════════════════════════════════╣');
    console.log('║   Port: ' + CONFIG.PORT + '                        ║');
    console.log('║   Rate: $' + getCurrentRate().toFixed(2) + '/min                   ║');
    console.log('║   Min:  ' + CONFIG.MIN_MINUTES + ' min                       ║');
    console.log('║   Domain: ' + CONFIG.DOMAIN + '  ║');
    console.log('╚══════════════════════════════════════╝');
    processExpiry();
});
