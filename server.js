// ============================================================
// THE EMPTY BILLBOARD — BACKEND SERVER
// ============================================================
// npm install express cors stripe
// node server.js
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const app = express();

// ── MIDDLEWARE ──
app.use(cors());
app.use(express.json());

// ── CONFIGURATION ──
const CONFIG = {
    STRIPE_SECRET_KEY: 'pk_test_51Tbq162KI9vCuZ0aZiRRGsDR6CY2fB2h8EtRJgw6IBRXxELRll3ez09XiWLI3JrauCLTBM3XmQUGFzt1D9eCdqBW00gNOQwvJt',         // ← REPLACE
    STRIPE_WEBHOOK_SECRET: 'whsec_kAZMO3vYrmnquiWna4z9yBYYs89Gg53a
',   // ← REPLACE
    PORT: process.env.PORT || 3000,
    DOMAIN: 'https://empty-billboard.com',                      // ← REPLACE
    DATA_FILE: path.join(__dirname, 'data.json'),
    BASE_RATE: 1.00,           // $1/min
    MIN_MINUTES: 60,           // 1 hour minimum
    MAX_MINUTES: 1440,         // 24 hours maximum
    DOUBLING_FACTOR: 2,
    MAX_MESSAGE_LENGTH: 280,
    WEEKLY_RESET_DAY: 0,       // Sunday
    WEEKLY_RESET_HOUR: 0,      // Midnight UTC
    EXPIRY_CHECK_INTERVAL: 10000  // 10 seconds
};

const stripe = Stripe(CONFIG.STRIPE_SECRET_KEY);

// ============================================================
// DATA LAYER — Simple JSON file persistence
// ============================================================

function createFreshData() {
    return {
        purchase_count: 0,
        current_rate_per_minute: CONFIG.BASE_RATE,
        last_reset_date: '',
        active_slot: null,
        queue: [],
        archive: [],
        _pending_sessions: []  // Temporary: sessions awaiting message submission
    };
}

function readData() {
    try {
        if (!fs.existsSync(CONFIG.DATA_FILE)) {
            const fresh = createFreshData();
            writeData(fresh);
            return fresh;
        }
        const raw = fs.readFileSync(CONFIG.DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        // Ensure all keys exist (backward compatibility)
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

    // Check if active slot has expired
    if (data.active_slot && data.active_slot.status === 'active') {
        const expiresAt = new Date(data.active_slot.expires_at);
        if (now >= expiresAt) {
            console.log(`⏰ Slot expired: "${data.active_slot.message}"`);

            // Move to archive
            data.archive.push({
                ...data.active_slot,
                status: 'completed',
                completed_at: now.toISOString()
            });

            // Dequeue next if any
            if (data.queue.length > 0) {
                const nextSlot = data.queue.shift();
                nextSlot.started_at = now.toISOString();
                nextSlot.expires_at = new Date(
                    now.getTime() + nextSlot.minutes_purchased * 60000
                ).toISOString();
                nextSlot.status = 'active';
                data.active_slot = nextSlot;
                console.log(`▶️ Dequeued next slot: "${nextSlot.message}"`);
            } else {
                data.active_slot = null;
                console.log('📭 Billboard is now empty');
            }
            changed = true;
        }
    }

    // Safety: if no active slot but queue has items, activate first
    if (!data.active_slot && data.queue.length > 0) {
        const nextSlot = data.queue.shift();
        nextSlot.started_at = now.toISOString();
        nextSlot.expires_at = new Date(
            now.getTime() + nextSlot.minutes_purchased * 60000
        ).toISOString();
        nextSlot.status = 'active';
        data.active_slot = nextSlot;
        changed = true;
        console.log(`▶️ Activated queued slot: "${nextSlot.message}"`);
    }

    // Safety: if active slot exists but has no started_at/expires_at, set them    if (data.active_slot && data.active_slot.status === 'active') {
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

// Run expiry check periodically
setInterval(processExpiry, CONFIG.EXPIRY_CHECK_INTERVAL);

// ============================================================
// API ROUTES
// ============================================================

// ── GET /api/state — Current billboard state ──
app.get('/api/state', (req, res) => {
    const data = processExpiry(); // Check expiry on each request too
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
            started_at: data.active_slot.started_at,
            rate_per_minute: data.active_slot.total_paid / data.active_slot.minutes_purchased,
            session_id: data.active_slot.session_id
        };
    }

    const rate = getCurrentRate();

    res.json({
        active: activeInfo,
        queue_length: data.queue.length,
        queue_slots: data.queue.map(q => ({
            buyer_name: q.buyer_name || 'Anonymous',
            minutes: q.minutes_purchased,
            total_paid: q.total_paid,
            message: q.message  // Reveal queued messages for transparency
        })),
        next_rate_per_minute: rate,
        next_rate_display: `$${rate.toFixed(2)}/min`,
        purchase_count: data.purchase_count,
        archive: (data.archive || [])
            .slice(-50)
            .reverse()
            .map(a => ({
                message: a.message,
                buyer_name: a.buyer_name,
                total_minutes: a.minutes_purchased,
                total_paid: a.total_paid,
                started_at: a.started_at,
                completed_at: a.completed_at,
                rate_per_minute: a.total_paid / a.minutes_purchased
            }))
    });
});

// ── POST /api/create-checkout-session ──
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { desired_minutes } = req.body;
        const minutes = parseInt(desired_minutes);

        if (!minutes || minutes < CONFIG.MIN_MINUTES) {
            return res.status(400).json({
                error: `Minimum purchase is ${CONFIG.MIN_MINUTES} minutes.`
            });
        }
        if (minutes > CONFIG.MAX_MINUTES) {
            return res.status(400).json({
                error: `Maximum purchase is ${CONFIG.MAX_MINUTES} minutes (24 hours).`
            });
        }

        const rate = getCurrentRate();
        const total = parseFloat((rate * minutes).toFixed(2));

        // Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${minutes} Minutes — The Empty Billboard`,
                        description: `${minutes} min at $${rate.toFixed(2)}/min · Total: $${total.toFixed(2)}`,
                    },
                    unit_amount: Math.round(total * 100), // Stripe uses cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${CONFIG.DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}&minutes=${minutes}`,
            cancel_url: CONFIG.DOMAIN,
            metadata: {
                minutes_purchased: minutes.toString(),
                rate_per_minute: rate.toString(),
                total_paid: total.toString()
            }
        });

        // Store pending session
        const data = readData();
        data._pending_sessions.push({
            session_id: session.id,
            minutes_purchased: minutes,
            rate_per_minute: rate,
            total_paid: total,
            created_at: new Date().toISOString()
        });
        writeData(data);

        console.log(`💳 Checkout session created: ${session.id} — ${minutes}min for $${total}`);

        res.json({
            id: session.id,
            total: total,
            minutes: minutes,
            rate: rate
        });

    } catch (err) {
        console.error('❌ Checkout session error:', err);
        res.status(500).json({ error: 'Failed to create checkout session.' });
    }
});

// ── POST /api/submit-message — After payment, buyer submits message ──
app.post('/api/submit-message', async (req, res) => {
    try {
        const { session_id, message, buyer_name } = req.body;

        if (!session_id) {
            return res.status(400).json({ error: 'Missing session ID.' });
        }
        if (!message || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message is required.' });
        }
        if (message.length > CONFIG.MAX_MESSAGE_LENGTH) {
            return res.status(400).json({ 
                error: `Message too long. Maximum ${CONFIG.MAX_MESSAGE_LENGTH} characters.` 
            });
        }

        // Basic content moderation
        const lowerMsg = message.toLowerCase();
        const bannedPatterns = [
            // Add patterns to block — these are examples
            // 'hate speech pattern',
            // 'illegal content indicator'
        ];
        for (const pattern of bannedPatterns) {
            if (lowerMsg.includes(pattern)) {
                return res.status(400).json({ 
                    error: 'Message violates content policy. Please revise.' 
                });
            }
        }

        const data = readData();

        // Find the slot — check _next_active first, then queue, then _pending_sessions
        let slot = null;
        let source = null;

        // Check if it's the next-to-be-activated slot
        if (data._next_active && data._next_active.session_id === session_id) {
            slot = data._next_active;
            source = 'next_active';
        }

        // Check queue
        if (!slot) {
            const queueIndex = data.queue.findIndex(s => s.session_id === session_id);
            if (queueIndex !== -1) {
                slot = data.queue[queueIndex];
                source = 'queue';
            }
        }

        // Check pending (from webhook, not yet placed in queue)
        if (!slot) {
            const pendingIndex = data._pending_sessions.findIndex(s => s.session_id === session_id);
            if (pendingIndex !== -1) {
                // This shouldn't normally happen — webhook should have processed it
                return res.status(400).json({ 
                    error: 'Payment still processing. Please wait a moment and try again.' 
                });
            }
        }

        if (!slot) {
            return res.status(404).json({ error: 'Session not found. Has payment completed?' });
        }

        // Update the slot with the message
        slot.message = message.trim();
        slot.buyer_name = buyer_name?.trim() || 'Anonymous';

        if (source === 'next_active') {
            // Activate immediately
            const now = new Date();
            slot.started_at = now.toISOString();
            slot.expires_at = new Date(now.getTime() + slot.minutes_purchased * 60000).toISOString();
            slot.status = 'active';
            data.active_slot = slot;
            delete data._next_active;
        }
        // If source === 'queue', status is already 'queued', just update message

        writeData(data);

        console.log(`📝 Message submitted for session ${session_id}: "${message.trim()}" (${source})`);

        res.json({
            success: true,
            status: slot.status,
            message: slot.message,
            starts_at: slot.started_at || null,
            expires_at: slot.expires_at || null,
            position: source === 'queue' ? 
                data.queue.findIndex(s => s.session_id === session_id) + 1 : 0
        });

    } catch (err) {
        console.error('❌ Submit message error:', err);
        res.status(500).json({ error: 'Failed to submit message.' });
    }
});

// ── POST /api/stripe-webhook — Stripe events ──
// NOTE: This route needs raw body parsing
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, CONFIG.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const data = readData();

        // Find pending session
        const pendingIndex = data._pending_sessions.findIndex(
            ps => ps.session_id === session.id
        );

        if (pendingIndex === -1) {
            console.log(`⚠️ Webhook received for unknown session: ${session.id}`);
            return res.json({ received: true });
        }

        const pending = data._pending_sessions[pendingIndex];

        // Create the slot
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

        // Place in appropriate location
        if (!data.active_slot || data.active_slot.status !== 'active') {
            // No active slot — this one will go live when message is submitted
            data._next_active = newSlot;
        } else {
            // Active slot exists — queue this one
            newSlot.status = 'queued';
            data.queue.push(newSlot);
        }

        // Increment purchase count and update rate
        data.purchase_count += 1;
        data.current_rate_per_minute = parseFloat(
            (CONFIG.BASE_RATE * Math.pow(CONFIG.DOUBLING_FACTOR, data.purchase_count)).toFixed(2)
        );

        // Remove from pending
        data._pending_sessions.splice(pendingIndex, 1);

        writeData(data);

        console.log(`✅ Payment confirmed: ${session.id}`);
        console.log(`   Minutes: ${pending.minutes_purchased} | Paid: $${pending.total_paid}`);
        console.log(`   New rate: $${data.current_rate_per_minute.toFixed(2)}/min`);
        console.log(`   Status: ${newSlot.status} | Queue length: ${data.queue.length}`);
    }

    if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        const data = readData();
        data._pending_sessions = data._pending_sessions.filter(
            ps => ps.session_id !== session.id
        );
        writeData(data);
        console.log(`⏹️ Session expired: ${session.id}`);
    }

    res.json({ received: true });
});

// ── GET /success — Message submission page ──
app.get('/success', (req, res) => {
    const sessionId = req.query.session_id || '';
    const minutes = req.query.minutes || '?';

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submit Your Message — The Empty Billboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Courier New', Courier, monospace;
            background: #fff;
            color: #111;
            max-width: 600px;
            margin: 60px auto;
            padding: 20px;
        }
        h1 { font-size: 1.5rem; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 2px; }
        .subtitle { color: #888; margin-bottom: 30px; font-size: 0.9rem; }
        textarea {
            width: 100%;
            height: 120px;
            font-family: inherit;
            font-size: 1.3rem;
            padding: 16px;
            border: 4px solid #111;
            resize: vertical;
            font-weight: 600;
        }
        textarea:focus { outline: none; border-color: #ffd700; }
        .char-count { text-align: right; font-size: 0.8rem; color: #888; margin-top: 4px; }
        .char-count.over { color: #cc0000; font-weight: 700; }
        input[type="text"] {
            width: 100%;
            padding: 14px;
            font-family: inherit;
            font-size: 1rem;
            border: 3px solid #111;
            margin: 14px 0;
        }
        button {
            background: #ffd700;
            color: #111;
            border: 3px solid #111;
            padding: 16px 36px;
            font-weight: 700;
            cursor: pointer;
            font-family: inherit;
            font-size: 1.1rem;
            text-transform: uppercase;
            letter-spacing: 2px;
            width: 100%;
        }
        button:hover { background: #111; color: #ffd700; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        .rules {
            background: #f9f9f9;
            padding: 14px;
            margin: 20px 0;
            font-size: 0.8rem;
            color: #666;
            line-height: 1.5;
        }
        .rules strong { color: #111; }
        #status { margin-top: 16px; font-weight: 700; text-align: center; min-height: 24px; }
        #status.success { color: #00aa44; }
        #status.error { color: #cc0000; }
    </style>
</head>
<body>
    <h1>✅ Payment Complete!</h1>
    <p class="subtitle">You bought <strong>${minutes} minutes</strong>. What message should appear on the billboard?</p>

    <textarea id="message" maxlength="280" placeholder="Your message here..."></textarea>
    <div class="char-count"><span id="charCount">0</span>/280</div>

    <input type="text" id="buyerName" placeholder="Your name (or leave blank for Anonymous)">

    <button id="submitBtn" onclick="submitMessage()">Publish to Billboard</button>

    <div class="rules">
        <strong>Rules:</strong> No hate speech, harassment, illegal content, or spam.<br>
        Messages are reviewed before appearing. No refunds on published time.<br>
        Your message stays up for exactly ${minutes} minutes, then the next slot begins.
    </div>

    <div id="status"></div>

    <script>
        const SESSION_ID = '${sessionId}';
        const MAX_LENGTH = 280;

        document.getElementById('message').addEventListener('input', function() {
            const len = this.value.length;
            const countEl = document.getElementById('charCount');
            countEl.textContent = len;
            countEl.className = len > MAX_LENGTH ? 'char-count over' : 'char-count';
        });

        async function submitMessage() {
            const msg = document.getElementById('message').value.trim();
            const name = document.getElementById('buyerName').value.trim();
            const btn = document.getElementById('submitBtn');
            const statusEl = document.getElementById('status');

            if (!msg) {
                statusEl.textContent = 'Please enter a message.';
                statusEl.className = 'error';
                return;
            }
            if (msg.length > MAX_LENGTH) {
                statusEl.textContent = 'Message too long. Shorten it.';
                statusEl.className = 'error';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Submitting...';
            statusEl.textContent = '';
            statusEl.className = '';

            try {
                const res = await fetch('/api/submit-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: SESSION_ID,
                        message: msg,
                        buyer_name: name
                    })
                });

                const data = await res.json();

                if (data.success) {
                    statusEl.textContent = data.status === 'active'
                        ? '✅ Your message is now LIVE on the billboard!'
                        : '✅ Message submitted! It will appear when the current slot finishes.';
                    statusEl.className = 'success';
                    setTimeout(() => { window.location.href = '/'; }, 4000);
                } else {
                    statusEl.textContent = '❌ ' + (data.error || 'Something went wrong.');
                    statusEl.className = 'error';
                    btn.disabled = false;
                    btn.textContent = 'Publish to Billboard';
                }
            } catch (err) {
                statusEl.textContent = '❌ Network error. Please try again.';
                statusEl.className = 'error';
                btn.disabled = false;
                btn.textContent = 'Publish to Billboard';
            }
        }
    </script>
</body>
</html>
    `);
});

// ── Serve static files (the HTML page) ──
app.use(express.static(path.join(__dirname, 'public')));

// ── Fallback to index.html ──
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// START SERVER
// ============================================================
app.listen(CONFIG.PORT, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   📋 THE EMPTY BILLBOARD SERVER     ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║   Port: ${CONFIG.PORT}                        ║`);
    console.log(`║   Rate: $${getCurrentRate().toFixed(2)}/min                    ║`);
    console.log(`║   Min:  ${CONFIG.MIN_MINUTES} min                       ║`);
    console.log('║   Reset: Sunday 00:00 UTC           ║');
    console.log('╚══════════════════════════════════════╝');

    // Initial expiry check
    processExpiry();
});
